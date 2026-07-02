// Package api: watcher.go provides filesystem-watch + SSE push so the frontend
// auto-refreshes when jj state changes outside the UI (CLI, agents, other workspaces).
package api

import (
	"context"
	"encoding/json"
	"log"
	"net/http"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/chronologos/lightjj/internal/jj"
	"github.com/fsnotify/fsnotify"
)

// Watcher observes .jj/repo/op_heads/heads/ and broadcasts op-id changes to
// connected SSE clients. jj atomically swaps the filename (hash-as-name) on
// every operation commit, so a single CREATE event = one complete operation.
// A periodic snapshot loop catches raw filesystem edits that jj hasn't seen yet.
type Watcher struct {
	srv       *Server
	headsDir  string
	fsWatcher *fsnotify.Watcher

	subsMu sync.Mutex
	subs   map[chan sseEvent]struct{} // each channel receives typed SSE events

	// Debounce: op_heads swap is atomic, but some operations (rebase across
	// many commits) can fire several in quick succession. Coalesce to one SSE.
	debounce time.Duration

	// Optional hooks fired on SSE subscribe/unsubscribe. Set by TabManager
	// for cross-tab idle-shutdown tracking — a per-Watcher count would start
	// the idle timer when the user switches tabs (old tab's ES closes) even
	// though the browser is still open. Called OUTSIDE subsMu so TabManager's
	// lock can be taken without nesting.
	onSub, onUnsub func()

	// Tracks whether a background loop last saw a stale-working-copy error.
	// Mutated ONLY via setStale() (staleMu-serialized edge+broadcast); read
	// atomically (handleEvents connect-time emit). staleMu makes the
	// Swap+broadcast atomic so a handler's setStale(false) can't race a loop's
	// setStale(true) and send sentinels out-of-order (client would be stuck on
	// stale=true with no self-heal — the Swap edge fires once).
	stale   atomic.Bool
	staleMu sync.Mutex

	// Tracks whether poll/snapshot loops are persistently failing (≥ threshold
	// consecutive errors that are not stale-WC — stale routes through setStale).
	// Same edge-triggered broadcast discipline as setStale; pollErr carries the
	// last error text for the UI. Single mutex (cold path — fires once per
	// transition; handleEvents reads on connect).
	pollMu     sync.Mutex
	pollFailed bool
	pollErr    string

	// snapshotPaused suppresses background snapshots while a foreground jj
	// mutation is running. The race: `jj git push` releases the WC lock between
	// network I/O and post-push checkout; a snapshot landing in that window
	// observes a mid-transition WC → "Concurrent checkout" / op divergence.
	// Counter (not bool) so concurrent mutations nest. Pointer because the
	// counter is shared across all watchers at the same canonical repo path
	// (see pauseCounterFor) — a push in one tab must pause snapshots in every
	// tab pointed at the same working copy. Assigned at construction, never
	// reassigned. Checked by trySnapshot() — an in-flight snapshot at
	// pause-start is not cancelled (~30ms snapshot vs ~21s push: finishes
	// before the checkout phase).
	snapshotPaused *atomic.Int32

	stop     chan struct{}
	stopOnce sync.Once
}

// sseEvent is one typed message on the watcher's broadcast channel. It maps
// 1:1 onto the SSE wire format the frontend's api.ts listens for:
//
//	event: <name>\ndata: <data>\n\n
//
// Only the internal representation is typed — the wire bytes (event names,
// payload shapes) are a contract with api.ts and must not change.
type sseEvent struct {
	name string // SSE event name: one of the evName* constants
	data string // payload: server-marshaled JSON; "{}" for sentinels

	// droppable marks events a slow subscriber can afford to lose: op-ids
	// (the client coalesces consecutive refreshes into one reload) and nav
	// hints (best-effort steering, not state). State sentinels (stale-wc /
	// fresh-wc, pollfail/pollok) are NOT droppable — they're edge-triggered
	// and never re-sent, so broadcast() evicts the oldest queued event to
	// make room for them rather than dropping them.
	droppable bool
}

// SSE event names — the `event:` field on the wire. Contract with api.ts's
// addEventListener calls; renaming any of these breaks the frontend.
const (
	evNameOp       = "op"
	evNameStaleWC  = "stale-wc"
	evNameFreshWC  = "fresh-wc"
	evNameNav      = "nav"
	evNamePollFail = "pollfail"
	evNamePollOk   = "pollok"
)

// Sentinel events — no payload, broadcast on state edges (setStale/setPollFail
// fire them exactly once per transition). Package vars (not constructors) so
// tests can compare received channel values directly.
var (
	evStaleWC = sseEvent{name: evNameStaleWC, data: "{}"}
	evFreshWC = sseEvent{name: evNameFreshWC, data: "{}"}
	evPollOk  = sseEvent{name: evNamePollOk, data: "{}"}
)

// opEvent builds an op-id change event. An empty op-id yields the zero event,
// which broadcast() ignores — preserves "never broadcast an empty op-id".
func opEvent(opId string) sseEvent {
	if opId == "" {
		return sseEvent{}
	}
	js, _ := json.Marshal(map[string]string{"op_id": opId})
	return sseEvent{name: evNameOp, data: string(js), droppable: true}
}

// pollFailEvent carries the last poll error text for the UI. Not droppable —
// it's the failing edge of an edge-triggered pair (recovery broadcasts evPollOk).
func pollFailEvent(errText string) sseEvent {
	js, _ := json.Marshal(map[string]string{"error": errText})
	return sseEvent{name: evNamePollFail, data: string(js)}
}

// navEvent wraps a navigation steering payload (server-marshaled JSON, no
// embedded newlines — see handleNavigate). Droppable: navigation is
// best-effort steering, not state, so there's no edge to lose (unlike evStaleWC).
func navEvent(payload []byte) sseEvent {
	return sseEvent{name: evNameNav, data: string(payload), droppable: true}
}

// Snapshot-pause counters, one per canonical repo path: a mutation running in
// one tab must pause the snapshot loop of every tab pointed at the same
// working copy (the "Concurrent checkout" race — see Watcher.snapshotPaused).
// Keyed by the same canonical workspace root TabManager dedups tabs on
// (Server.RepoDir locally, Server.RepoPath over SSH). Entries are never
// deleted: O(distinct paths ever opened), 8 bytes each.
//
// Package-level (not TabManager-owned) so the shared counter is in place at
// Watcher CONSTRUCTION: watchers are built by the tab factory before
// TabManager mounts the tab, and the previous design (TabManager swapping the
// snapshotPaused field after the fact) was post-construction mutation of
// another type's field.
var (
	pauseCountersMu sync.Mutex
	pauseCounters   = map[string]*atomic.Int32{}
)

// pauseCounterFor returns the shared snapshot-pause counter for a canonical
// repo path. An empty path (tests, no repo) gets a private counter.
func pauseCounterFor(path string) *atomic.Int32 {
	if path == "" {
		return new(atomic.Int32)
	}
	pauseCountersMu.Lock()
	defer pauseCountersMu.Unlock()
	pc, ok := pauseCounters[path]
	if !ok {
		pc = new(atomic.Int32)
		pauseCounters[path] = pc
	}
	return pc
}

// pauseKey is the canonical path identifying which working copy a server's
// snapshots act on — the sharing key for pauseCounterFor. RepoDir in local
// mode, RepoPath over SSH, "" in tests (private counter). Mode is checked
// via the documented accessor, not raw field comparison (CLAUDE.md rule).
func pauseKey(srv *Server) string {
	if srv.hasLocalFS() {
		return srv.RepoDir
	}
	return srv.RepoPath
}

// Consecutive poll/snapshot failures tolerated before surfacing to UI. Three
// was enough for the log-line ("degraded"); five buffers against transient
// repo-lock contention while still noticing a wedged .git/index.lock within
// ~25s at the default 5s interval.
const pollFailThreshold = 5

// isStaleWCError matches jj's stale-working-copy errors — both cases whose
// hint is `jj workspace update-stale`:
//   - WorkingCopyStale (cli_util.rs:2734): "The working copy is stale..."
//   - ObjectNotFound (cli_util.rs:2762): "Could not read working copy's operation."
//
// The third staleness case (SiblingOperation, :2744) has a DIFFERENT hint
// (`jj op integrate`) so is deliberately NOT matched — falls through to the
// generic transient-error path. Error strings are stable; jj doesn't i18n.
func isStaleWCError(err error) bool {
	if err == nil {
		return false
	}
	s := err.Error()
	return strings.Contains(s, "working copy is stale") ||
		strings.Contains(s, "Could not read working copy's operation")
}

// probeTracker classifies the result of one background probe (an SSH op-id
// poll or a local working-copy snapshot) and owns the failure-state discipline
// both loops must follow. Extracted because sshPollLoop and snapshotLoop
// previously each hand-rolled this state machine, and the same bug (a stale-WC
// interlude leaving pollFailed stuck) had to be fixed twice — once per copy.
//
// Classification invariants (these live HERE, not in the loops):
//
//   - A stale working copy is NOT a failure. It's a healthy round trip to jj
//     reporting a known, user-actionable condition (poll-fail covers transient
//     IO/lock errors — categorically different). It routes through
//     setStale(true), clears poll-fail, and resets the failure counter: a
//     frozen counter would inflate the next non-stale error's log threshold
//     (the 3rd-failure log would fire on the first post-stale error).
//
//   - Poll-fail clearing is UNCONDITIONAL on every healthy result (success or
//     stale-WC). setPollFail early-returns when state is unchanged, so gating
//     the clear on the failure counter is a non-optimization — and it caused
//     the stuck-forever bug: a stale-WC interlude zeroed the counter, so the
//     success branch's counter-gated clear never fired again.
//
//   - Failures surface to the UI only after pollFailThreshold consecutive
//     errors (transient repo-lock contention and SSH blips are expected).
//     They surface to the log on the 3rd failure, then every 12th (~1/min at
//     the 5s interval) — `== 3` alone would log once for a 10-minute lock.
type probeTracker struct {
	w     *Watcher
	label string // log noun: "op-id poll" / "snapshot"
	hint  string // log infix before "auto-refresh degraded", e.g. "repo may be locked, "

	failures int // consecutive non-stale errors
}

// ok records a healthy probe. clearStale=false when the probe variant cannot
// vouch for WC freshness — sshPollLoop while paused uses CurrentOpId, which
// has --ignore-working-copy, so its success says nothing about staleness and
// must not broadcast a false evFreshWC.
func (p *probeTracker) ok(clearStale bool) {
	if clearStale {
		p.w.setStale(false)
	}
	p.w.setPollFail("")
	p.failures = 0
}

// staleWC records a stale-working-copy result (see isStaleWCError). setStale
// broadcasts once on the edge; the caller's retry loop keeps running so a
// CLI-side `jj workspace update-stale` is noticed and clears it.
func (p *probeTracker) staleWC() {
	p.w.setStale(true)
	p.w.setPollFail("")
	p.failures = 0
}

// fail records a generic (non-stale) probe failure.
func (p *probeTracker) fail(err error) {
	p.failures++
	if p.failures == 3 || (p.failures > 3 && p.failures%12 == 0) {
		log.Printf("watcher: %s failed %dx (%v); %sauto-refresh degraded", p.label, p.failures, err, p.hint)
	}
	if p.failures >= pollFailThreshold {
		p.w.setPollFail(err.Error())
	}
}

func newWatcher(srv *Server) *Watcher {
	return &Watcher{
		srv:            srv,
		subs:           make(map[chan sseEvent]struct{}),
		debounce:       150 * time.Millisecond,
		snapshotPaused: pauseCounterFor(pauseKey(srv)),
		stop:           make(chan struct{}),
	}
}

// setStale updates the stale flag and broadcasts the sentinel IFF the value
// changed. staleMu serializes the Swap+broadcast pair so two callers can't
// interleave and emit sentinels out-of-order (handleWorkspaceUpdateStale
// clearing + snapshotLoop setting in between would leave the client stuck on
// stale=true; Swap edges don't re-fire so there's no self-heal).
func (w *Watcher) setStale(v bool) {
	w.staleMu.Lock()
	defer w.staleMu.Unlock()
	if w.stale.Swap(v) == v {
		return
	}
	if v {
		w.broadcast(evStaleWC)
	} else {
		w.broadcast(evFreshWC)
	}
}

// Stale is the lock-free read of the last-observed working-copy staleness.
// TabManager.handleList surfaces it on every tab so background-tab stale dots
// reflect that tab's snapshotLoop state without a per-tab SSE subscription.
func (w *Watcher) Stale() bool { return w.stale.Load() }

// setPollFail records persistent poll failure / recovery. Same edge-triggered
// broadcast discipline as setStale. err == "" means "healthy"; non-empty means
// "failing, here's the last error text for the UI". Updates pollErr on every
// call while failed (error detail can change between ticks) but only broadcasts
// on true↔false transitions — the client doesn't need to re-render on each tick.
// The broadcast event carries the error text as of the edge; later refinements
// while still failed update pollErr (served to new connections by handleEvents'
// connect-time emit) without re-broadcasting.
func (w *Watcher) setPollFail(err string) {
	w.pollMu.Lock()
	defer w.pollMu.Unlock()
	failed := err != ""
	if w.pollFailed == failed {
		if failed {
			w.pollErr = err
		}
		return
	}
	w.pollFailed = failed
	w.pollErr = err
	if failed {
		w.broadcast(pollFailEvent(err))
	} else {
		w.broadcast(evPollOk)
	}
}

// pollStatus returns the current failure state + last error text. Used by
// handleEvents on connect (new client needs current state).
func (w *Watcher) pollStatus() (failed bool, err string) {
	w.pollMu.Lock()
	defer w.pollMu.Unlock()
	return w.pollFailed, w.pollErr
}

// NewWatcher constructs a watcher for the given server. Returns nil if the
// server has no local RepoDir (SSH mode) — SSE auto-refresh requires a local
// filesystem to observe.
func NewWatcher(srv *Server, snapshotInterval time.Duration) *Watcher {
	if !srv.hasLocalFS() {
		return nil
	}
	w := newWatcher(srv)
	w.headsDir = filepath.Join(srv.repoStorePath(), "op_heads", "heads")
	if err := w.start(snapshotInterval); err != nil {
		log.Printf("watcher: disabled (%v)", err)
		return nil
	}
	return w
}

// NewSSHWatcher constructs a watcher that polls the remote op-id on a ticker.
// No external tool dependency (inotify-tools, watchman) — just `jj op log`.
// Works with any remote OS. Trade-off: worst-case interval latency vs
// fsnotify's ~instant notification. (Secondary-workspace .jj/repo pointer
// files are now resolved by repoStorePath() in both modes.)
//
// interval <= 0 disables the loop — parity with local mode's snapshotLoop
// gate (see start()) and avoids NewTicker(0) panic. No auto-refresh in
// that state; user hard-refreshes manually.
func NewSSHWatcher(srv *Server, interval time.Duration) *Watcher {
	w := newWatcher(srv)
	if interval > 0 {
		go w.sshPollLoop(interval)
	}
	return w
}

func (w *Watcher) start(snapshotInterval time.Duration) error {
	fw, err := fsnotify.NewWatcher()
	if err != nil {
		return err
	}
	if err := fw.Add(w.headsDir); err != nil {
		fw.Close()
		return err
	}
	w.fsWatcher = fw

	go w.watchLoop()
	if snapshotInterval > 0 {
		go w.snapshotLoop(snapshotInterval)
	}
	return nil
}

// Close stops all background goroutines and closes the fsnotify watcher.
// Idempotent — signal handler racing handleClose, or double-signal, won't panic.
func (w *Watcher) Close() {
	w.stopOnce.Do(func() {
		close(w.stop)
		if w.fsWatcher != nil {
			w.fsWatcher.Close()
		}
	})
}

// watchLoop consumes fsnotify events and broadcasts debounced op-id changes.
func (w *Watcher) watchLoop() {
	var timer *time.Timer
	fire := func() {
		// refreshOpId returns the fresh value — using it directly eliminates
		// a TOCTOU window where a concurrent refreshOpId (from runMutation or
		// snapshotLoop) could interleave between our write and a separate read.
		w.broadcast(opEvent(w.srv.refreshOpId()))
	}

	for {
		select {
		case <-w.stop:
			if timer != nil {
				timer.Stop()
			}
			return
		case ev, ok := <-w.fsWatcher.Events:
			if !ok {
				return
			}
			// Only CREATE matters — jj writes the new head file then removes the
			// old one. REMOVE fires on the old hash, which we don't care about.
			if ev.Op&fsnotify.Create == 0 {
				continue
			}
			if timer != nil {
				timer.Stop()
			}
			timer = time.AfterFunc(w.debounce, fire)
		case err, ok := <-w.fsWatcher.Errors:
			if !ok {
				return
			}
			log.Printf("watcher: fsnotify error: %v", err)
		}
	}
}

// sshPollLoop polls the remote op-id on a ticker and broadcasts on change.
// Gated on hasSubscribers() — no browser tabs = no SSH traffic. Error
// tolerance mirrors snapshotLoop via the shared probeTracker: transient
// failures (repo lock, SSH blip) are expected; persistent failure surfaces
// once so the user knows.
//
// Uses PollOpId (no --ignore-working-copy) — SSH mode has no snapshotLoop,
// so the implicit snapshot here is the ONLY thing that picks up remote editor
// saves. Snapshot + op-id in one round trip. As safe as the user running
// `jj st` — standard jj, honors snapshot.auto-update-stale. The poll result
// is authoritative; we write the op-id cache directly (casOpId) rather than
// calling refreshOpId() (saves a second ~440ms round trip).
func (w *Watcher) sshPollLoop(interval time.Duration) {
	t := time.NewTicker(interval)
	defer t.Stop()
	// lastBroadcast: what WE last sent to subscribers. Independent of the
	// op-id cache — a runMutation advancing the cache between ticks doesn't
	// change what WE broadcast last. Comparing against this (not the cache)
	// is what lets the next poll detect the between-tick mutation and
	// broadcast it to OTHER tabs (the mutating tab got the X-JJ-Op-Id
	// header; non-mutating tabs rely on SSE).
	lastBroadcast := ""
	probe := &probeTracker{w: w, label: "op-id poll"}
	for {
		select {
		case <-w.stop:
			return
		case <-t.C:
			if !w.hasSubscribers() {
				continue
			}
			// PollOpId implicitly snapshots; when paused, fall back to the
			// --ignore-working-copy variant so SSE keeps flowing during
			// long pushes (parity with local mode's ungated watchLoop).
			// CurrentOpId success says nothing about WC freshness, so the
			// stale-clear on success (probe.ok's clearStale arg) is gated on
			// !paused — otherwise a 21s push with a stale WC would falsely
			// broadcast evFreshWC.
			paused := w.snapshotPaused.Load() > 0
			pollCmd := jj.PollOpId()
			if paused {
				pollCmd = jj.CurrentOpId()
			}
			// preCached: the SHARED op-id cache value, for the DURING-call CAS
			// below. If a concurrent runMutation advances the cache while our
			// SSH call is in flight, the poll result is stale and the CAS
			// prevents regression. DISTINCT from lastBroadcast (the
			// between-tick case) — collapsing these was the bug_017 regression.
			preCached := w.srv.getOpId()
			ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
			out, err := w.srv.Runner.Run(ctx, pollCmd)
			cancel()
			if err != nil {
				// Snapshotting can hit stale-WC (same as snapshotLoop); the
				// classification discipline is shared (probeTracker).
				if isStaleWCError(err) {
					probe.staleWC()
				} else {
					probe.fail(err)
				}
				continue
			}
			probe.ok(!paused)
			opId := strings.TrimSpace(string(out))
			if opId == "" || opId == lastBroadcast {
				continue
			}
			// CAS: advance the cache only if nobody else did mid-poll. If a
			// concurrent runMutation won (swap refused), broadcast THEIR value
			// so non-mutating clients still refresh — it's fresher than our
			// poll's pre-mutation snapshot.
			cur, _ := w.srv.casOpId(preCached, opId)
			w.broadcast(opEvent(cur))
			lastBroadcast = cur
		}
	}
}

// snapshotLoop periodically asks jj to snapshot the working copy. This catches
// raw file edits (editor saves, agent writes) that haven't been observed by jj
// yet. The snapshot itself mutates op_heads, which triggers watchLoop → SSE.
// Result classification (stale-WC routing, failure counting) is shared with
// sshPollLoop via probeTracker.
func (w *Watcher) snapshotLoop(interval time.Duration) {
	t := time.NewTicker(interval)
	defer t.Stop()
	probe := &probeTracker{w: w, label: "snapshot", hint: "repo may be locked, "}
	for {
		select {
		case <-w.stop:
			return
		case <-t.C:
			// If no clients are connected, skip — snapshotting is only useful
			// if someone's watching.
			if !w.hasSubscribers() {
				continue
			}
			// `jj util snapshot` is cheap when nothing changed (~15ms) and
			// advances op_heads only if the WC actually differs. Transient
			// errors (repo lock) are expected; persistent failure is worth
			// surfacing once so the user knows auto-refresh is degraded.
			ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
			ran, err := w.srv.trySnapshot(ctx)
			cancel()
			if !ran {
				continue
			}
			switch {
			case err == nil:
				probe.ok(true)
			case isStaleWCError(err):
				probe.staleWC()
			default:
				probe.fail(err)
			}
		}
	}
}

func (w *Watcher) hasSubscribers() bool {
	w.subsMu.Lock()
	defer w.subsMu.Unlock()
	return len(w.subs) > 0
}

// subscribe registers a channel to receive event broadcasts. Call the returned
// unsubscribe func when the client disconnects.
func (w *Watcher) subscribe() (ch chan sseEvent, unsubscribe func()) {
	// Buffer 6 absorbs a burst of droppable op-id events between client reads.
	// The size is headroom, not a correctness invariant: non-droppable
	// sentinel events evict the oldest queued event when the buffer is full
	// (see broadcast), so they can never be lost to sizing arithmetic.
	ch = make(chan sseEvent, 6)
	w.subsMu.Lock()
	w.subs[ch] = struct{}{}
	w.subsMu.Unlock()
	if w.onSub != nil {
		w.onSub()
	}
	return ch, func() {
		w.subsMu.Lock()
		delete(w.subs, ch)
		w.subsMu.Unlock()
		if w.onUnsub != nil {
			w.onUnsub()
		}
	}
}

// Navigate broadcasts a one-shot navigation payload to connected SSE clients.
// payload is a server-marshaled JSON blob (handleNavigate validates and
// re-marshals so untrusted input can't smuggle SSE framing). Dropped if no
// subscribers or all buffers full — navigation is best-effort steering, not
// state, so there's no edge to lose (unlike evStaleWC).
func (w *Watcher) Navigate(payload []byte) {
	w.broadcast(navEvent(payload))
}

// broadcast fans an event out to all subscribers without blocking. A slow
// subscriber's full buffer drops droppable events (it catches up on the next
// one). Non-droppable sentinel edges instead evict the oldest queued event to
// make room: sentinels carry absolute state (stale/fresh, failed/ok) and are
// never re-sent, so the newest one must arrive — and whatever gets evicted is
// either a droppable event or an older (superseded) sentinel.
func (w *Watcher) broadcast(ev sseEvent) {
	if ev.name == "" {
		return
	}
	w.subsMu.Lock()
	defer w.subsMu.Unlock()
	for ch := range w.subs {
		select {
		case ch <- ev:
			continue
		default:
		}
		if ev.droppable {
			continue
		}
		// Evict one queued event, then send. broadcast holds subsMu so no
		// other sender can refill the freed slot; the subscriber draining
		// concurrently only makes more room. Both selects keep defaults so
		// this can never block while holding subsMu.
		select {
		case <-ch:
		default:
		}
		select {
		case ch <- ev:
		default:
		}
	}
}

// handleEvents is the SSE endpoint. It holds the connection open and streams
// `event: <name>\ndata: <payload>\n\n` frames — op-id changes, stale-WC and
// poll-failure sentinels, navigation hints. A keepalive comment is sent every
// 25s to prevent proxy idle timeouts.
func (w *Watcher) handleEvents(rw http.ResponseWriter, r *http.Request) {
	flusher, ok := rw.(http.Flusher)
	if !ok {
		http.Error(rw, "streaming unsupported", http.StatusInternalServerError)
		return
	}

	// Per-write deadline extension — replaces the blanket disable. main.go's
	// 120s WriteTimeout would kill SSE after 2 minutes; disabling entirely
	// (time.Time{}) meant dead TCP connections (browser crash, no FIN/RST)
	// blocked writes until OS keepalive detection (~2-10 min) — idle-shutdown
	// timer couldn't arm. With extension, a dead connection surfaces on the
	// next keepalive write (25s tick + 60s deadline ≈ 85s worst case).
	rc := http.NewResponseController(rw)
	extendDeadline := func() {
		_ = rc.SetWriteDeadline(time.Now().Add(60 * time.Second))
	}
	extendDeadline()

	rw.Header().Set("Content-Type", "text/event-stream")
	rw.Header().Set("Cache-Control", "no-cache")
	rw.Header().Set("Connection", "keep-alive")
	rw.WriteHeader(http.StatusOK)
	flusher.Flush()

	ch, unsubscribe := w.subscribe()
	defer unsubscribe()

	write := func(payload string) error {
		extendDeadline()
		if _, err := rw.Write([]byte(payload)); err != nil {
			return err
		}
		flusher.Flush()
		return nil
	}
	// writeEvent is the single chokepoint that turns a typed sseEvent into
	// wire bytes — connect-time emits and channel dispatch both go through it,
	// so the format can't drift between the two paths.
	writeEvent := func(ev sseEvent) error {
		return write("event: " + ev.name + "\ndata: " + ev.data + "\n\n")
	}

	// Send current op-id immediately on connect. Handles reconnect gaps: if
	// the client's SSE dropped during a repo change, the reconnect syncs state
	// without waiting for the next fsnotify event. Client's notifyOpId dedup
	// makes this a no-op on the common case (op-id unchanged since last call).
	//
	// Refresh if the cached op-id is empty — otherwise a read-only session (no
	// mutations, nothing to advance the cache) never gets event:op → frontend's
	// everSawEvent stays false → first SSE drop permanently kills auto-refresh.
	// Local refresh is <1ms (filesystem read); SSH is ~440ms once per connect.
	cur := w.srv.getOpId()
	if cur == "" {
		cur = w.srv.refreshOpId()
	}
	if cur != "" {
		if err := writeEvent(opEvent(cur)); err != nil {
			return
		}
	}
	// Emit current stale state unconditionally on connect. Both branches matter:
	//   - stale=true: browser reload during staleness would otherwise lose the
	//     warning until the next snapshot tick (up to 5s)
	//   - stale=false: client whose SSE dropped during staleness and reconnected
	//     after CLI recovery never saw the fresh-wc broadcast (sent while
	//     disconnected) → workspaceStale stuck true forever. Swap edges don't
	//     re-fire, and visibilitychange only fires on tab switch, not WiFi blips.
	{
		ev := evFreshWC
		if w.stale.Load() {
			ev = evStaleWC
		}
		if err := writeEvent(ev); err != nil {
			return
		}
	}
	// Poll-failure state — same reconnect-resync reasoning as stale-wc: BOTH
	// branches are load-bearing. If polling recovered while the client was
	// disconnected, the pollok broadcast was sent to zero subscribers; the
	// reconnect must re-emit pollok so the client's pollFailError clears.
	// Without the else branch, pollFailError stays stuck until browser reload
	// or a new server-side failure→recovery cycle.
	if failed, pollErr := w.pollStatus(); failed {
		if err := writeEvent(pollFailEvent(pollErr)); err != nil {
			return
		}
	} else {
		if err := writeEvent(evPollOk); err != nil {
			return
		}
	}

	keepalive := time.NewTicker(25 * time.Second)
	defer keepalive.Stop()

	for {
		select {
		case <-r.Context().Done():
			return
		case <-w.stop:
			// Watcher.Close() fired (tab close). Without this arm the handler
			// lives until the client disconnects or a keepalive write fails.
			// Pre-tabs this was process-exit-only; now it's a runtime path.
			return
		case ev := <-ch:
			if err := writeEvent(ev); err != nil {
				return
			}
		case <-keepalive.C:
			// SSE comment line — keeps proxies/browsers from timing out.
			if err := write(": keepalive\n\n"); err != nil {
				return
			}
		}
	}
}

// handleEventsDisabled is used when Watcher is nil (--no-watch, or NewWatcher
// failed). Returns 204 so the frontend's EventSource sees a clean close and
// stops retrying instead of hammering with reconnects.
func handleEventsDisabled(rw http.ResponseWriter, _ *http.Request) {
	rw.WriteHeader(http.StatusNoContent)
}
