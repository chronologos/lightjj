package api

import (
	"encoding/json"
	"log"
	"net/http"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"
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

// TabFactory constructs a Server for a new repo tab. Path is the resolved
// workspace root (output of TabResolve); the factory need not re-resolve.
type TabFactory func(path string) *Server

// TabResolve validates a user-supplied repo path and returns the canonical
// workspace root (for dedup). Local mode: ~ expansion + filepath.IsAbs +
// jj workspace root. SSH mode: one round trip to the remote. Nil when tab
// creation is disabled.
type TabResolve func(path string) (string, error)

// TabManager owns the top-level mux. Each repo tab is a full Server mounted
// at /tab/{id}/ via StripPrefix — Server struct stays untouched, zero handler
// changes. Host-scoped routes (config, static files) live on this mux directly.
type TabManager struct {
	Mux *http.ServeMux

	mu   sync.RWMutex
	tabs map[string]*Tab
	next int
	// pauseCounters: one snapshotPaused counter per canonical repo path, so a
	// push in tab A suppresses tab B's snapshotLoop when both point at the
	// same WC. Never deleted — O(distinct-paths-ever-opened), each 8 bytes.
	pauseCounters map[string]*atomic.Int32

	newTab  TabFactory
	resolve TabResolve

	// Mode+Host tag tabs persisted to config.json. All tabs in one session
	// share one mode+host so these live on the manager, not per-Tab. Set by
	// main.go; Mode="" means tabs won't round-trip (tests, or future modes
	// that don't want persistence). Host is the full user@host spec for ssh
	// mode, empty for local — two `lightjj --remote` sessions on different
	// hosts share one config.json, so the restore loop must filter by host.
	Mode string
	Host string

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

func NewTabManager(newTab TabFactory, resolve TabResolve) *TabManager {
	m := &TabManager{
		Mux:           http.NewServeMux(),
		tabs:          make(map[string]*Tab),
		pauseCounters: make(map[string]*atomic.Int32),
		newTab:        newTab,
		resolve:       resolve,
		ShutdownCh:    make(chan struct{}),
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
	m.Mux.HandleFunc("GET /api/config/raw", handleConfigGetRaw)
	m.Mux.HandleFunc("POST /api/config/raw", handleConfigSetRaw)
	return m
}

// AddTab mounts a pre-constructed Server. Used by main.go for the startup
// tab (constructed from CLI flags before the factory exists). Dynamic tab
// creation goes through handleCreate instead.
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
		pc, ok := m.pauseCounters[path]
		if !ok {
			pc = new(atomic.Int32)
			m.pauseCounters[path] = pc
		}
		srv.Watcher.snapshotPaused = pc
	}
	return t
}

// armIdleTimerLocked starts the shutdown countdown. Caller holds idleMu.
// Shared by SetIdleShutdown (arm-at-start) and decSub (arm-on-last-disconnect);
// any future change to the shutdown sequence would otherwise need 2 edits.
func (m *TabManager) armIdleTimerLocked() {
	d := m.idleShutdown
	m.idleTimer = time.AfterFunc(d, func() {
		m.shutdownOnce.Do(func() {
			log.Printf("no browser connected for %v, shutting down", d)
			close(m.ShutdownCh)
		})
	})
}

// SetIdleShutdown arms the idle timer. When the total SSE subscriber count
// across all tabs drops to 0, a timer starts; if no browser reconnects before
// it fires, ShutdownCh closes. Call before any tab can receive subscribers.
// Arms immediately (totalSubs starts at 0) — otherwise the timer only ever
// arms in decSub(), and a browser that never connects means no shutdown.
func (m *TabManager) SetIdleShutdown(d time.Duration) {
	m.idleMu.Lock()
	defer m.idleMu.Unlock()
	m.idleShutdown = d
	if m.totalSubs == 0 {
		m.armIdleTimerLocked()
	}
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
		m.armIdleTimerLocked()
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

// sortedTabs returns all tabs in numeric ID order (= open order — IDs are
// monotonic via m.next++). Map iteration is random. Called under m.mu RLock.
func (m *TabManager) sortedTabs() []*Tab {
	out := make([]*Tab, 0, len(m.tabs))
	for _, t := range m.tabs {
		out = append(out, t)
	}
	// Atoi ignores errors: IDs are strconv.Itoa output, round-trip is exact.
	slices.SortFunc(out, func(a, b *Tab) int {
		ai, _ := strconv.Atoi(a.ID)
		bi, _ := strconv.Atoi(b.ID)
		return ai - bi
	})
	return out
}

func (m *TabManager) handleList(w http.ResponseWriter, r *http.Request) {
	m.mu.RLock()
	out := m.sortedTabs()
	m.mu.RUnlock()
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(out)
}

type createTabRequest struct {
	Path string `json:"path"`
}

func (m *TabManager) handleCreate(w http.ResponseWriter, r *http.Request) {
	if m.newTab == nil || m.resolve == nil {
		writeJSONError(w, http.StatusNotImplemented,
			"tab opening unavailable in this mode; use port-forward (see README) or a second 'lightjj --remote host:/other/path' instance")
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
	// Defense-in-depth: shellQuote handles single-quotes correctly but a
	// newline would split the remote command. No legitimate path contains one.
	if strings.ContainsAny(path, "\n\x00") {
		writeJSONError(w, http.StatusBadRequest, "path contains invalid characters")
		return
	}
	// Resolve to the canonical workspace root — validation + dedup key in
	// one call. Mode-specific (local ~ expansion vs SSH round trip) lives
	// in the injected closure.
	root, err := m.resolve(path)
	if err != nil {
		writeJSONError(w, http.StatusBadRequest, err.Error())
		return
	}

	if existing := m.FindByPath(root); existing != nil {
		m.writeTab(w, existing)
		return
	}
	// Construct OUTSIDE the lock — the factory opens a watcher (fsnotify or
	// an SSH goroutine). Cheap (~1ms) but lock-free means future factory
	// additions can't stall dispatch. Double-check dedup under the lock;
	// if a concurrent create won, shut down the orphan (its watcher
	// goroutine hasn't done anything yet).
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
	m.persistTabs()
}

// persistTabs snapshots the current non-startup tabs to config.json. Tab 0
// (the -R flag tab) is excluded: it's implicit from CLI flags, persisting it
// would conflict when the user launches with a different -R path. Best-effort:
// logs on failure, never blocks the HTTP response (callers invoke this AFTER
// writing their response). Mode=="" (tests) → skip entirely.
func (m *TabManager) persistTabs() {
	if m.Mode == "" {
		return
	}
	m.mu.RLock()
	tabs := m.sortedTabs()
	m.mu.RUnlock()
	// Skip tab 0 (the -R CLI flag, implicit on every launch). sortedTabs
	// returns in ID order so tab 0 is always first if present.
	if len(tabs) > 0 && tabs[0].ID == "0" {
		tabs = tabs[1:]
	}
	out := make([]PersistedTab, len(tabs))
	for i, t := range tabs {
		out[i] = PersistedTab{Path: t.Path, Mode: m.Mode, Host: m.Host}
	}
	if err := writePersistedTabs(m.Mode, m.Host, out); err != nil {
		log.Printf("failed to persist tabs: %v", err)
	}
}

// FindByPath checks for an existing tab with the given canonical path.
// Exported for main.go's startup-restore loop (dedup against the -R tab).
func (m *TabManager) FindByPath(root string) *Tab {
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
	// Tab 0 is the -R startup tab — always present, never closeable.
	// persistTabs() excludes it from config; closing it would break the
	// "startup anchor" invariant and leave restored tabs with no primary.
	if id == "0" {
		writeJSONError(w, http.StatusBadRequest, "cannot close the startup tab")
		return
	}
	m.mu.Lock()
	t := m.tabs[id]
	if t == nil {
		m.mu.Unlock()
		http.NotFound(w, r)
		return
	}
	if len(m.tabs) == 1 {
		m.mu.Unlock()
		writeJSONError(w, http.StatusBadRequest, "cannot close the last tab")
		return
	}
	if t.srv != nil {
		t.srv.Shutdown()
	}
	delete(m.tabs, id)
	m.mu.Unlock()
	w.WriteHeader(http.StatusOK)
	// Persist after response written — config I/O shouldn't delay the UI,
	// and holding m.mu across mergeAndWriteConfig would nest it with configMu
	// (harmless today but a lock-ordering smell).
	m.persistTabs()
}
