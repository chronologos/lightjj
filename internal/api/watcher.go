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
	subs   map[chan string]struct{} // each channel receives the new op-id

	// Debounce: op_heads swap is atomic, but some operations (rebase across
	// many commits) can fire several in quick succession. Coalesce to one SSE.
	debounce time.Duration

	// Optional hooks fired on SSE subscribe/unsubscribe. Set by TabManager
	// for cross-tab idle-shutdown tracking — a per-Watcher count would start
	// the idle timer when the user switches tabs (old tab's ES closes) even
	// though the browser is still open. Called OUTSIDE subsMu so TabManager's
	// lock can be taken without nesting.
	onSub, onUnsub func()

	// Tracks whether snapshotLoop last saw a stale-working-copy error.
	// Broadcast fires only on transition edges (atomic.Bool.Swap returns the
	// old value, so `if !stale.Swap(true)` = "was false, now true").
	stale atomic.Bool

	stop     chan struct{}
	stopOnce sync.Once
}

// Meta-event sentinels broadcast on the same chan as op-ids. Op-ids are hex
// hashes; the "!" prefix is unambiguous. Using the existing channel avoids a
// second broadcast map + select arm for rare events.
const (
	evStaleWC = "!stale-wc"
	evFreshWC = "!fresh-wc"
)

// isStaleWCError matches jj's stale-working-copy errors — both cases whose
// hint is `jj workspace update-stale`:
//   - WorkingCopyStale (cli_util.rs:2734): "The working copy is stale..."
//   - ObjectNotFound (cli_util.rs:2762): "Could not read working copy's operation."
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

func newWatcher(srv *Server) *Watcher {
	return &Watcher{
		srv:      srv,
		subs:     make(map[chan string]struct{}),
		debounce: 150 * time.Millisecond,
		stop:     make(chan struct{}),
	}
}

// NewWatcher constructs a watcher for the given server. Returns nil if the
// server has no local RepoDir (SSH mode) — SSE auto-refresh requires a local
// filesystem to observe.
func NewWatcher(srv *Server, snapshotInterval time.Duration) *Watcher {
	if srv.RepoDir == "" {
		return nil
	}
	w := newWatcher(srv)
	w.headsDir = filepath.Join(srv.RepoDir, ".jj", "repo", "op_heads", "heads")
	if err := w.start(snapshotInterval); err != nil {
		log.Printf("watcher: disabled (%v)", err)
		return nil
	}
	return w
}

// NewSSHWatcher constructs a watcher that polls the remote op-id on a ticker.
// No external tool dependency (inotify-tools, watchman) — just `jj op log`.
// Works with any remote OS and from secondary workspaces (.jj/repo pointer
// file — inotifywait on .jj/repo/op_heads/heads/ failed there). Trade-off:
// worst-case interval latency vs fsnotify's ~instant notification.
//
// interval <= 0 disables the loop — parity with local mode's snapshotLoop
// gate (watcher.go:~132) and avoids NewTicker(0) panic. No auto-refresh in
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
		w.broadcast(w.srv.refreshOpId())
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
// tolerance mirrors snapshotLoop: transient failures (repo lock, SSH blip)
// are expected; persistent failure surfaces once so the user knows.
//
// Uses PollOpId (no --ignore-working-copy) — SSH mode has no snapshotLoop,
// so the implicit snapshot here is the ONLY thing that picks up remote editor
// saves. Snapshot + op-id in one round trip. As safe as the user running
// `jj st` — standard jj, honors snapshot.auto-update-stale. The poll result
// is authoritative; we write cachedOp directly rather than calling
// refreshOpId() (saves a second ~440ms round trip).
func (w *Watcher) sshPollLoop(interval time.Duration) {
	t := time.NewTicker(interval)
	defer t.Stop()
	last := ""
	var consecutiveErrors int
	for {
		select {
		case <-w.stop:
			return
		case <-t.C:
			if !w.hasSubscribers() {
				continue
			}
			ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
			out, err := w.srv.Runner.Run(ctx, jj.PollOpId())
			cancel()
			if err != nil {
				// Snapshotting can hit stale-WC (same as snapshotLoop); the
				// sentinel routing is shared.
				if isStaleWCError(err) {
					if !w.stale.Swap(true) {
						w.broadcast(evStaleWC)
					}
					consecutiveErrors = 0
					continue
				}
				consecutiveErrors++
				if consecutiveErrors == 3 || (consecutiveErrors > 3 && consecutiveErrors%12 == 0) {
					log.Printf("watcher: op-id poll failed %dx (%v); auto-refresh degraded", consecutiveErrors, err)
				}
				continue
			}
			if w.stale.Swap(false) {
				w.broadcast(evFreshWC)
			}
			consecutiveErrors = 0
			opId := strings.TrimSpace(string(out))
			if opId != "" && opId != last {
				w.srv.cachedMu.Lock()
				w.srv.cachedOp = opId
				w.srv.cachedMu.Unlock()
				w.broadcast(opId)
				last = opId
			}
		}
	}
}

// snapshotLoop periodically asks jj to snapshot the working copy. This catches
// raw file edits (editor saves, agent writes) that haven't been observed by jj
// yet. The snapshot itself mutates op_heads, which triggers watchLoop → SSE.
func (w *Watcher) snapshotLoop(interval time.Duration) {
	t := time.NewTicker(interval)
	defer t.Stop()
	var consecutiveErrors int
	for {
		select {
		case <-w.stop:
			return
		case <-t.C:
			// If no clients are connected, skip — snapshotting is only useful
			// if someone's watching.
			w.subsMu.Lock()
			n := len(w.subs)
			w.subsMu.Unlock()
			if n == 0 {
				continue
			}
			// `jj util snapshot` is cheap when nothing changed (~15ms) and
			// advances op_heads only if the WC actually differs. Transient
			// errors (repo lock) are expected; persistent failure is worth
			// surfacing once so the user knows auto-refresh is degraded.
			ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
			_, err := w.srv.Runner.Run(ctx, jj.DebugSnapshot())
			cancel()
			if err != nil {
				// Stale WC is a known, user-actionable condition — don't count
				// as a transient error (it won't self-heal, and the log message
				// would be misleading). Broadcast once on transition; the 5s
				// retry continues so a CLI-side `update-stale` is noticed.
				if isStaleWCError(err) {
					if !w.stale.Swap(true) {
						w.broadcast(evStaleWC)
					}
					// Reset — stale is categorically different from transient
					// errors. Leaving the counter frozen would inflate the
					// next non-stale error's log threshold (3rd-failure log
					// fires on first post-stale error if pre-stale count was 2).
					consecutiveErrors = 0
					continue
				}
				consecutiveErrors++
				// Log on 3rd failure, then every 12 after (~1 min at 5s interval).
				// `== 3` only would log once for a 10-minute lock; this surfaces
				// persistent failure without spamming transient blips.
				if consecutiveErrors == 3 || (consecutiveErrors > 3 && consecutiveErrors%12 == 0) {
					log.Printf("watcher: snapshot failed %dx (%v); repo may be locked, auto-refresh degraded", consecutiveErrors, err)
				}
			} else {
				if w.stale.Swap(false) {
					w.broadcast(evFreshWC)
				}
				consecutiveErrors = 0
			}
		}
	}
}

func (w *Watcher) hasSubscribers() bool {
	w.subsMu.Lock()
	defer w.subsMu.Unlock()
	return len(w.subs) > 0
}

// subscribe registers a channel to receive op-id broadcasts. Call the returned
// unsubscribe func when the client disconnects.
func (w *Watcher) subscribe() (ch chan string, unsubscribe func()) {
	// Buffer 4: op-id + stale-wc + fresh-wc + headroom. With buffer 1, a
	// buffered op-id would cause broadcast(evStaleWC) to hit select-default
	// and drop the sentinel. Since the stale.Swap edge fires exactly once,
	// a dropped sentinel is never re-sent — the warning would be silently
	// lost until SSE reconnect. Op-ids remain droppable (client coalesces
	// to one loadLog anyway); losing a sentinel is not.
	ch = make(chan string, 4)
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

// broadcast sends the op-id to all subscribers. Non-blocking: if a subscriber's
// buffer is full, the event is dropped (they'll catch up on their next poll).
func (w *Watcher) broadcast(opId string) {
	if opId == "" {
		return
	}
	w.subsMu.Lock()
	defer w.subsMu.Unlock()
	for ch := range w.subs {
		select {
		case ch <- opId:
		default:
		}
	}
}

// handleEvents is the SSE endpoint. It holds the connection open and streams
// `event: op\ndata: {"op_id":"..."}\n\n` on every observed op-head change.
// A keepalive comment is sent every 25s to prevent proxy idle timeouts.
func (w *Watcher) handleEvents(rw http.ResponseWriter, r *http.Request) {
	flusher, ok := rw.(http.Flusher)
	if !ok {
		http.Error(rw, "streaming unsupported", http.StatusInternalServerError)
		return
	}

	// Disable the server's WriteTimeout for this long-lived connection.
	// Without this, main.go's 120s WriteTimeout kills SSE after 2 minutes.
	rc := http.NewResponseController(rw)
	_ = rc.SetWriteDeadline(time.Time{})

	rw.Header().Set("Content-Type", "text/event-stream")
	rw.Header().Set("Cache-Control", "no-cache")
	rw.Header().Set("Connection", "keep-alive")
	rw.WriteHeader(http.StatusOK)
	flusher.Flush()

	ch, unsubscribe := w.subscribe()
	defer unsubscribe()

	// Send current op-id immediately on connect. Handles reconnect gaps: if
	// the client's SSE dropped during a repo change, the reconnect syncs state
	// without waiting for the next fsnotify event. Client's notifyOpId dedup
	// makes this a no-op on the common case (op-id unchanged since last call).
	writeOp := func(opId string) error {
		payload, _ := json.Marshal(map[string]string{"op_id": opId})
		if _, err := rw.Write([]byte("event: op\ndata: " + string(payload) + "\n\n")); err != nil {
			return err
		}
		flusher.Flush()
		return nil
	}
	if cur := w.srv.getOpId(); cur != "" {
		if err := writeOp(cur); err != nil {
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
		if _, err := rw.Write([]byte("event: " + ev[1:] + "\ndata: {}\n\n")); err != nil {
			return
		}
		flusher.Flush()
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
		case msg := <-ch:
			// Meta-event sentinel ("!"-prefixed, vs. hex op-id). Emitted as
			// `event: <name>\ndata: {}\n\n` — the frontend adds a dedicated
			// listener per event type, so no payload parsing needed.
			if strings.HasPrefix(msg, "!") {
				if _, err := rw.Write([]byte("event: " + msg[1:] + "\ndata: {}\n\n")); err != nil {
					return
				}
				flusher.Flush()
				continue
			}
			if err := writeOp(msg); err != nil {
				return
			}
		case <-keepalive.C:
			// SSE comment line — keeps proxies/browsers from timing out.
			if _, err := rw.Write([]byte(": keepalive\n\n")); err != nil {
				return
			}
			flusher.Flush()
		}
	}
}

// handleEventsDisabled is used when Watcher is nil (--no-watch, or NewWatcher
// failed). Returns 204 so the frontend's EventSource sees a clean close and
// stops retrying instead of hammering with reconnects.
func handleEventsDisabled(rw http.ResponseWriter, _ *http.Request) {
	rw.WriteHeader(http.StatusNoContent)
}

