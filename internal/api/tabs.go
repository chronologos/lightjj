package api

import (
	"encoding/json"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/chronologos/lightjj/internal/runner"
)

// Tab is a slot in the UI. Only kind=="repo" exists today; the Kind field is
// reserved for future non-repo kinds (doc viewer, diff-compare) but the
// plumbing is NOT done — addLocked takes a *Server, so a new kind needs its
// own add variant. What IS generic: the handler field (any http.Handler) and
// the srv!=nil guards in Shutdown/handleClose.
// handler is the StripPrefix'd Mux, built once so dispatch doesn't allocate
// per-request (StripPrefix shallow-copies *http.Request, ~464B — building it
// fresh every time would double that).
type Tab struct {
	ID   string `json:"id"`
	Kind string `json:"kind"`
	Name string `json:"name"` // tab label (repo dir basename)
	Path string `json:"path"` // display/tooltip; canonical workspace root for repos

	srv     *Server
	handler http.Handler
}

// TabFactory constructs a Server for a new local repo tab. Nil in SSH mode —
// tab opening is local-only for now (can't validate remote paths cheaply).
// Path is the resolved workspace root; the factory need not re-resolve.
type TabFactory func(path string) *Server

// TabManager owns the top-level mux. Each repo tab is a full Server mounted
// at /tab/{id}/ via StripPrefix — Server struct stays untouched, zero handler
// changes. Host-scoped routes (config, static files) live on this mux directly.
type TabManager struct {
	Mux *http.ServeMux

	mu   sync.RWMutex
	tabs map[string]*Tab
	next int

	newTab TabFactory

	// Cross-tab idle-shutdown. Counts SSE subscribers across ALL tabs — a
	// per-Watcher count would fire when the user switches tabs (old tab's
	// EventSource closes) even though the browser is still connected. Timer
	// starts only when totalSubs DROPS to 0 (decSub), not at startup, so a
	// slow-to-connect browser doesn't race the process to exit. ShutdownCh
	// close is sync.Once-guarded: timer.Stop() returning false means fire
	// already dequeued → a late incSub can't prevent it, but a second timer
	// firing after that is structurally impossible (process is exiting).
	ShutdownCh   chan struct{}
	idleMu       sync.Mutex
	idleShutdown time.Duration
	idleTimer    *time.Timer
	totalSubs    int
	shutdownOnce sync.Once
}

func NewTabManager(newTab TabFactory) *TabManager {
	m := &TabManager{
		Mux:        http.NewServeMux(),
		tabs:       make(map[string]*Tab),
		newTab:     newTab,
		ShutdownCh: make(chan struct{}),
	}
	m.Mux.HandleFunc("GET /tabs", m.handleList)
	m.Mux.HandleFunc("POST /tabs", m.handleCreate)
	m.Mux.HandleFunc("DELETE /tabs/{id}", m.handleClose)
	m.Mux.HandleFunc("/tab/{id}/", m.handleDispatch)
	// Config is host-scoped — config.svelte.ts uses raw fetch('/api/config')
	// without a tab prefix. Also registered on each Server.Mux (harmlessly
	// redundant; same backing file).
	m.Mux.HandleFunc("GET /api/config", handleConfigGet)
	m.Mux.HandleFunc("POST /api/config", handleConfigSet)
	return m
}

// AddTab mounts a pre-constructed Server. Used by main.go for the startup
// repo (which has mode-specific wiring — SSH watcher, etc. — that the factory
// doesn't know about). Dynamic tab creation goes through handleCreate instead.
func (m *TabManager) AddTab(srv *Server, path string) *Tab {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.addLocked(srv, path)
}

func (m *TabManager) addLocked(srv *Server, path string) *Tab {
	id := strconv.Itoa(m.next)
	m.next++
	t := &Tab{
		ID:      id,
		Kind:    "repo",
		Name:    filepath.Base(path),
		Path:    path,
		srv:     srv,
		handler: http.StripPrefix("/tab/"+id, srv.Mux),
	}
	m.tabs[id] = t
	// Wire this tab's SSE subscriber count into the cross-tab total. Nil-safe:
	// --no-watch or NewWatcher failure means no SSE → this tab contributes
	// nothing to idle detection (can't detect "browser closed" without SSE).
	if srv.Watcher != nil {
		srv.Watcher.onSub = m.incSub
		srv.Watcher.onUnsub = m.decSub
	}
	return t
}

// SetIdleShutdown arms the idle timer. When the total SSE subscriber count
// across all tabs drops to 0, a timer starts; if no browser reconnects before
// it fires, ShutdownCh closes. Call before any tab can receive subscribers.
func (m *TabManager) SetIdleShutdown(d time.Duration) {
	m.idleMu.Lock()
	m.idleShutdown = d
	m.idleMu.Unlock()
}

func (m *TabManager) incSub() {
	m.idleMu.Lock()
	defer m.idleMu.Unlock()
	m.totalSubs++
	if m.idleTimer != nil {
		m.idleTimer.Stop()
		m.idleTimer = nil
	}
}

func (m *TabManager) decSub() {
	m.idleMu.Lock()
	defer m.idleMu.Unlock()
	m.totalSubs--
	if m.totalSubs == 0 && m.idleShutdown > 0 {
		d := m.idleShutdown
		m.idleTimer = time.AfterFunc(d, func() {
			m.shutdownOnce.Do(func() {
				log.Printf("no browser connected for %v, shutting down", d)
				close(m.ShutdownCh)
			})
		})
	}
}

// Shutdown closes watchers and kills child processes across all tabs.
func (m *TabManager) Shutdown() {
	m.mu.Lock()
	defer m.mu.Unlock()
	for _, t := range m.tabs {
		if t.srv != nil {
			t.srv.Shutdown()
		}
	}
}

func (m *TabManager) handleDispatch(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	m.mu.RLock()
	t := m.tabs[id]
	m.mu.RUnlock()
	if t == nil || t.handler == nil {
		http.NotFound(w, r)
		return
	}
	t.handler.ServeHTTP(w, r)
}

func (m *TabManager) handleList(w http.ResponseWriter, r *http.Request) {
	m.mu.RLock()
	out := make([]*Tab, 0, len(m.tabs))
	for _, t := range m.tabs {
		out = append(out, t)
	}
	m.mu.RUnlock()
	// Stable order by numeric ID (map iteration is random). Atoi ignores
	// errors: IDs are strconv.Itoa output, round-trip is exact.
	slices.SortFunc(out, func(a, b *Tab) int {
		ai, _ := strconv.Atoi(a.ID)
		bi, _ := strconv.Atoi(b.ID)
		return ai - bi
	})
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(out)
}

type createTabRequest struct {
	Path string `json:"path"`
}

func (m *TabManager) handleCreate(w http.ResponseWriter, r *http.Request) {
	if m.newTab == nil {
		writeJSONError(w, http.StatusNotImplemented, "tab opening not supported in this mode")
		return
	}
	var req createTabRequest
	if err := decodeBody(w, r, &req); err != nil {
		writeJSONError(w, http.StatusBadRequest, err.Error())
		return
	}
	path := req.Path
	if path == "" {
		writeJSONError(w, http.StatusBadRequest, "path is required")
		return
	}
	// ~ expansion — shell convenience, Go doesn't do it natively.
	if path == "~" || strings.HasPrefix(path, "~/") {
		if home, err := os.UserHomeDir(); err == nil {
			path = filepath.Join(home, path[1:]) // [1:] drops "~"; Join handles both "" and "/rest"
		}
	}
	if !filepath.IsAbs(path) {
		writeJSONError(w, http.StatusBadRequest, "path must be absolute")
		return
	}
	// Resolve to the workspace root. Fails fast if not a jj repo; also gives
	// us the canonical path for dedup (opening /repo/src then /repo → one tab).
	root, err := runner.ResolveWorkspaceRoot(path)
	if err != nil {
		writeJSONError(w, http.StatusBadRequest, err.Error())
		return
	}

	if existing := m.findByPath(root); existing != nil {
		m.writeTab(w, existing)
		return
	}
	// Construct OUTSIDE the lock — the factory spawns a subprocess (via the
	// jj binary check) and opens an fsnotify watcher, ~20-50ms during which
	// every tab's handleDispatch would otherwise block on RLock. Double-check
	// dedup under the lock; if a concurrent create won the race, shut down
	// the orphan (its watcher goroutines haven't done anything yet).
	srv := m.newTab(root)
	m.mu.Lock()
	if existing := m.findByPathLocked(root); existing != nil {
		m.mu.Unlock()
		srv.Shutdown()
		m.writeTab(w, existing)
		return
	}
	t := m.addLocked(srv, root)
	m.mu.Unlock()
	m.writeTab(w, t)
}

// findByPath checks for an existing tab with the given canonical path.
func (m *TabManager) findByPath(root string) *Tab {
	m.mu.RLock()
	defer m.mu.RUnlock()
	return m.findByPathLocked(root)
}

func (m *TabManager) findByPathLocked(root string) *Tab {
	for _, t := range m.tabs {
		if t.Path == root {
			return t
		}
	}
	return nil
}

func (m *TabManager) writeTab(w http.ResponseWriter, t *Tab) {
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(t)
}

func (m *TabManager) handleClose(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	m.mu.Lock()
	defer m.mu.Unlock()
	t := m.tabs[id]
	if t == nil {
		http.NotFound(w, r)
		return
	}
	if len(m.tabs) == 1 {
		writeJSONError(w, http.StatusBadRequest, "cannot close the last tab")
		return
	}
	if t.srv != nil {
		t.srv.Shutdown()
	}
	delete(m.tabs, id)
	w.WriteHeader(http.StatusOK)
}
