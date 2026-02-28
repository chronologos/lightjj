// Package api: watcher.go provides filesystem-watch + SSE push so the frontend
// auto-refreshes when jj state changes outside the UI (CLI, agents, other workspaces).
package api

import (
	"context"
	"encoding/json"
	"log"
	"net/http"
	"path/filepath"
	"sync"
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

	stop chan struct{}
}

// NewWatcher constructs a watcher for the given server. Returns nil if the
// server has no local RepoDir (SSH mode) — SSE auto-refresh requires a local
// filesystem to observe.
func NewWatcher(srv *Server, snapshotInterval time.Duration) *Watcher {
	if srv.RepoDir == "" {
		return nil
	}
	w := &Watcher{
		srv:      srv,
		headsDir: filepath.Join(srv.RepoDir, ".jj", "repo", "op_heads", "heads"),
		subs:     make(map[chan string]struct{}),
		debounce: 150 * time.Millisecond,
		stop:     make(chan struct{}),
	}
	if err := w.start(snapshotInterval); err != nil {
		log.Printf("watcher: disabled (%v)", err)
		return nil
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
func (w *Watcher) Close() {
	close(w.stop)
	if w.fsWatcher != nil {
		w.fsWatcher.Close()
	}
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
			// `jj debug snapshot` is cheap when nothing changed (~15ms) and
			// advances op_heads only if the WC actually differs. Transient
			// errors (repo lock) are expected; persistent failure is worth
			// surfacing once so the user knows auto-refresh is degraded.
			ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
			_, err := w.srv.Runner.Run(ctx, jj.DebugSnapshot())
			cancel()
			if err != nil {
				consecutiveErrors++
				// Log on 3rd failure, then every 12 after (~1 min at 5s interval).
				// `== 3` only would log once for a 10-minute lock; this surfaces
				// persistent failure without spamming transient blips.
				if consecutiveErrors == 3 || (consecutiveErrors > 3 && consecutiveErrors%12 == 0) {
					log.Printf("watcher: snapshot failed %dx (%v); repo may be locked, auto-refresh degraded", consecutiveErrors, err)
				}
			} else {
				consecutiveErrors = 0
			}
		}
	}
}

// subscribe registers a channel to receive op-id broadcasts. Call the returned
// unsubscribe func when the client disconnects.
func (w *Watcher) subscribe() (ch chan string, unsubscribe func()) {
	ch = make(chan string, 1) // buffered: writer drops if client is slow
	w.subsMu.Lock()
	w.subs[ch] = struct{}{}
	w.subsMu.Unlock()
	return ch, func() {
		w.subsMu.Lock()
		delete(w.subs, ch)
		w.subsMu.Unlock()
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

	keepalive := time.NewTicker(25 * time.Second)
	defer keepalive.Stop()

	for {
		select {
		case <-r.Context().Done():
			return
		case opId := <-ch:
			if err := writeOp(opId); err != nil {
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

// handleEventsDisabled is used when Watcher is nil (SSH mode). It returns a
// 204 immediately so the frontend's EventSource sees a clean close and stops
// retrying instead of hammering with reconnects.
func handleEventsDisabled(rw http.ResponseWriter, _ *http.Request) {
	rw.WriteHeader(http.StatusNoContent)
}

