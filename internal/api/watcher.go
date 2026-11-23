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

// Watcher observes .jj/repo/op_heads/heads/ and reports op-id changes to
// connected SSE clients. jj atomically swaps the filename (hash-as-name) on
// every operation commit, so a single CREATE event = one complete operation.
// A periodic snapshot loop catches raw filesystem edits that jj hasn't seen yet.
type Watcher struct {
	srv       *Server
	headsDir  string
	fsWatcher *fsnotify.Watcher

	subsMu sync.Mutex
	subs   map[*subscriber]struct{}

	// Debounce: op_heads swap is atomic, but some operations (rebase across
	// many commits) can fire several in quick succession. Coalesce to one SSE.
	debounce time.Duration

	// Optional hooks fired on SSE subscribe/unsubscribe. Set by TabManager
	// for cross-tab idle-shutdown tracking — a per-Watcher count would start
	// the idle timer when the user switches tabs (old tab's ES closes) even
	// though the browser is still open. Called OUTSIDE subsMu so TabManager's
	// lock can be taken without nesting.
	onSub, onUnsub func()

	// tabs is the manager this watcher's tab belongs to (nil: standalone server).
	// Atomic because the loops run before TabManager mounts the tab.
	tabs atomic.Pointer[TabManager]

	// opSeen: an operation landed since the last probe. What lets snapshotLoop check
	// a background tab exactly when another workspace may have made it stale.
	opSeen atomic.Bool

	// Last-observed health, written by the probe loops and by handlers that have
	// proof (setStale / setPollFail). pollErr "" = healthy; stale working copies are
	// not a poll failure.
	stale   atomic.Bool
	pollMu  sync.Mutex
	pollErr string

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

// watchState is everything a client needs to know, as a LEVEL: the stream's
// `state` event always carries all of it, read at the moment of writing. There are
// no edges to lose, reorder or replay — a slow or reconnecting client just gets the
// current state. Contract with api.ts.
type watchState struct {
	OpId      string `json:"op_id"`
	Stale     bool   `json:"stale"`
	PollError string `json:"poll_error"`
	// TabsRev changes when anything in GET /tabs may have (see TabManager.bumpTabs).
	TabsRev int64 `json:"tabs_rev,omitempty"`
}

type subscriber struct {
	dirty chan struct{} // cap 1: state changed since it was last written
	nav   chan []byte   // agent steering; best-effort, dropped when full
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
// must not report a false recovery.
func (p *probeTracker) ok(clearStale bool) {
	if clearStale {
		p.w.setStale(false)
	}
	p.w.setPollFail("")
	p.failures = 0
}

// staleWC records a stale-working-copy result (see isStaleWCError). The caller's
// retry loop keeps running so a
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
		subs:           make(map[*subscriber]struct{}),
		debounce:       150 * time.Millisecond,
		snapshotPaused: pauseCounterFor(pauseKey(srv)),
		stop:           make(chan struct{}),
	}
}

// setStale updates the stale flag and tells subscribers when it changed.
func (w *Watcher) setStale(v bool) {
	if w.stale.Swap(v) != v {
		w.notify()
		w.tabs.Load().bumpTabs() // the dot is on every client's tab bar, whichever tab it shows
	}
}

// Stale is the lock-free read of the last-observed working-copy staleness.
// TabManager.handleList surfaces it on every tab; background tabs are kept current
// by snapshotLoop's background probe (local) and by the handlers that fix a sibling.
func (w *Watcher) Stale() bool { return w.stale.Load() }

// setPollFail records persistent poll failure (err = last error text for the UI) or
// recovery (""). Subscribers are told on the transition; a later change of text while
// still failing goes out with whatever is written next.
func (w *Watcher) setPollFail(err string) {
	w.pollMu.Lock()
	changed := (w.pollErr == "") != (err == "")
	w.pollErr = err
	w.pollMu.Unlock()
	if changed {
		w.notify()
	}
}

func (w *Watcher) pollError() string {
	w.pollMu.Lock()
	defer w.pollMu.Unlock()
	return w.pollErr
}

func (w *Watcher) state() watchState {
	return watchState{OpId: w.srv.getOpId(), Stale: w.stale.Load(), PollError: w.pollError(), TabsRev: w.tabs.Load().tabsRevision()}
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

// watchLoop consumes fsnotify events and reports debounced op-id changes.
func (w *Watcher) watchLoop() {
	var timer *time.Timer
	fire := func() {
		w.srv.refreshOpId()
		w.opSeen.Store(true)
		w.notify()
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

// sshPollLoop polls the remote op-id on a ticker and reports changes.
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
	// lastReported: what WE last reported to subscribers. Independent of the
	// op-id cache — a runMutation advancing the cache between ticks doesn't
	// change what WE reported last. Comparing against this (not the cache)
	// is what lets the next poll detect the between-tick mutation and
	// report it to OTHER tabs (the mutating tab got the X-JJ-Op-Id
	// header; non-mutating tabs rely on SSE).
	lastReported := ""
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
			// report recovery.
			paused := w.snapshotPaused.Load() > 0
			pollCmd := jj.PollOpId()
			if paused {
				pollCmd = jj.CurrentOpId()
			}
			// preCached: the SHARED op-id cache value, for the DURING-call CAS
			// below. If a concurrent runMutation advances the cache while our
			// SSH call is in flight, the poll result is stale and the CAS
			// prevents regression. DISTINCT from lastReported (the
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
			if opId == "" || opId == lastReported {
				continue
			}
			// CAS: advance the cache only if nobody else did mid-poll. If a
			// concurrent runMutation won (swap refused), THEIR value stands
			// so non-mutating clients still refresh — it's fresher than our
			// poll's pre-mutation snapshot.
			cur, _ := w.srv.casOpId(preCached, opId)
			w.notify()
			lastReported = cur
		}
	}
}

// backgroundProbeTicks spaces a background tab's probes (30s at the default interval).
const backgroundProbeTicks = 6

// snapshotLoop periodically asks jj to snapshot the working copy. This catches
// raw file edits (editor saves, agent writes) that haven't been observed by jj
// yet. The snapshot itself mutates op_heads, which triggers watchLoop → SSE.
// Result classification (stale-WC routing, failure counting) is shared with
// sshPollLoop via probeTracker.
//
// A background tab (a browser is connected, but showing another tab) is probed only
// when its stale dot may be wrong: after an operation, and while it is stale
// (`update-stale` need not create an operation). An idle background tab costs nothing,
// and a busy repo with many workspace tabs costs each at most one probe per
// backgroundProbeTicks.
func (w *Watcher) snapshotLoop(interval time.Duration) {
	t := time.NewTicker(interval)
	defer t.Stop()
	sinceBackground := backgroundProbeTicks // the first one needn't wait
	probe := &probeTracker{w: w, label: "snapshot", hint: "repo may be locked, "}
	for {
		select {
		case <-w.stop:
			return
		case <-t.C:
			// If no clients are connected, skip — snapshotting is only useful
			// if someone's watching.
			if !w.hasSubscribers() {
				sinceBackground++
				if sinceBackground < backgroundProbeTicks || !(w.opSeen.Load() || w.Stale()) || !w.tabs.Load().hasClients() {
					continue
				}
				sinceBackground = 0
			}
			w.opSeen.Store(false) // before the probe: an op landing during it counts again
			// `jj util snapshot` is cheap when nothing changed (~15ms) and
			// advances op_heads only if the WC actually differs. Transient
			// errors (repo lock) are expected; persistent failure is worth
			// surfacing once so the user knows auto-refresh is degraded.
			ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
			ran, err := w.srv.trySnapshot(ctx)
			cancel()
			if !ran {
				w.opSeen.Store(true)
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

// subscribe registers for state changes and navigation. Call the returned
// unsubscribe func when the client disconnects.
func (w *Watcher) subscribe() (sub *subscriber, unsubscribe func()) {
	sub = &subscriber{dirty: make(chan struct{}, 1), nav: make(chan []byte, 4)}
	w.subsMu.Lock()
	w.subs[sub] = struct{}{}
	w.subsMu.Unlock()
	if w.onSub != nil {
		w.onSub()
	}
	return sub, func() {
		w.subsMu.Lock()
		delete(w.subs, sub)
		w.subsMu.Unlock()
		if w.onUnsub != nil {
			w.onUnsub()
		}
	}
}

// Navigate sends a one-shot navigation payload to connected SSE clients.
// payload is a server-marshaled JSON blob (handleNavigate validates and
// re-marshals so untrusted input can't smuggle SSE framing). Best-effort steering,
// not state: dropped if a client's buffer is full. Returns false when
// no browser is subscribed to THIS tab's stream: the browser holds an
// EventSource only for the active tab, so a navigate aimed at a background
// tab would otherwise 200 and silently vanish — handleNavigate turns false
// into a 409 the agent can act on.
func (w *Watcher) Navigate(payload []byte) bool {
	w.subsMu.Lock()
	defer w.subsMu.Unlock()
	for sub := range w.subs {
		select {
		case sub.nav <- payload:
		default:
		}
	}
	return len(w.subs) > 0
}

// notify marks every subscriber's state out of date. Never blocks: a subscriber
// already marked reads the latest state when it gets there.
func (w *Watcher) notify() {
	w.subsMu.Lock()
	defer w.subsMu.Unlock()
	for sub := range w.subs {
		select {
		case sub.dirty <- struct{}{}:
		default:
		}
	}
}

// handleEvents is the SSE endpoint. It holds the connection open and streams
// `event: <name>\ndata: <payload>\n\n` frames: `state` (watchState) and `nav`
// (navigation hints). A keepalive comment is sent every
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

	sub, unsubscribe := w.subscribe() // before the first read: no change can fall between
	defer unsubscribe()

	write := func(payload string) error {
		extendDeadline()
		if _, err := rw.Write([]byte(payload)); err != nil {
			return err
		}
		flusher.Flush()
		return nil
	}
	writeEvent := func(name string, data []byte) error {
		return write("event: " + name + "\ndata: " + string(data) + "\n\n")
	}
	writeState := func() error {
		js, _ := json.Marshal(w.state())
		return writeEvent("state", js)
	}

	// On connect, so a client that missed anything while away is immediately right.
	// Refresh an empty op-id first: a read-only session has nothing else to fill it.
	// Local refresh is <1ms (filesystem read); SSH is ~440ms once per connect.
	if w.srv.getOpId() == "" {
		w.srv.refreshOpId()
	}
	if err := writeState(); err != nil {
		return
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
		case <-sub.dirty:
			if err := writeState(); err != nil {
				return
			}
		case payload := <-sub.nav:
			if err := writeEvent("nav", payload); err != nil {
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
