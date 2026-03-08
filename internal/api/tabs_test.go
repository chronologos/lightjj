package api

import (
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/chronologos/lightjj/internal/jj"
	"github.com/chronologos/lightjj/testutil"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// newTestTab returns a TabManager with one tab mounting a mock-backed Server.
// Factory is nil → handleCreate returns 501 (like SSH mode), so tests that
// cover create use a custom factory inline.
func newTestTab(t *testing.T) (*TabManager, *testutil.MockRunner) {
	runner := testutil.NewMockRunner(t)
	runner.Allow(jj.CurrentOpId()).SetOutput([]byte("abc123"))
	srv := NewServer(runner, "")
	tm := NewTabManager(nil, nil)
	tm.AddTab(srv, "/test/repo")
	return tm, runner
}

func TestTabDispatch(t *testing.T) {
	tm, runner := newTestTab(t)
	runner.Expect(jj.LogGraph("", 500)).SetOutput([]byte(""))
	defer runner.Verify()

	// /tab/0/api/log → strips prefix → Server sees /api/log
	req := httptest.NewRequest("GET", "/tab/0/api/log", nil)
	w := httptest.NewRecorder()
	tm.Mux.ServeHTTP(w, req)
	assert.Equal(t, http.StatusOK, w.Code)
}

func TestTabDispatch_UnknownID(t *testing.T) {
	tm, _ := newTestTab(t)
	req := httptest.NewRequest("GET", "/tab/99/api/log", nil)
	w := httptest.NewRecorder()
	tm.Mux.ServeHTTP(w, req)
	assert.Equal(t, http.StatusNotFound, w.Code)
}

func TestTabList(t *testing.T) {
	tm, _ := newTestTab(t)
	req := httptest.NewRequest("GET", "/tabs", nil)
	w := httptest.NewRecorder()
	tm.Mux.ServeHTTP(w, req)
	require.Equal(t, http.StatusOK, w.Code)

	var tabs []Tab
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &tabs))
	require.Len(t, tabs, 1)
	assert.Equal(t, "0", tabs[0].ID)
	assert.Equal(t, "repo", tabs[0].Kind)
	assert.Equal(t, "repo", tabs[0].Name) // filepath.Base("/test/repo")
	assert.Equal(t, "/test/repo", tabs[0].Path)
}

func TestTabList_StableOrder(t *testing.T) {
	tm := NewTabManager(nil, nil)
	// AddTab three times, then verify list order is 0,1,2 not map-random.
	for i := 0; i < 3; i++ {
		runner := testutil.NewMockRunner(t)
		runner.Allow(jj.CurrentOpId()).SetOutput([]byte("op"))
		tm.AddTab(NewServer(runner, ""), "/r")
	}
	w := httptest.NewRecorder()
	tm.Mux.ServeHTTP(w, httptest.NewRequest("GET", "/tabs", nil))
	var tabs []Tab
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &tabs))
	require.Len(t, tabs, 3)
	assert.Equal(t, "0", tabs[0].ID)
	assert.Equal(t, "1", tabs[1].ID)
	assert.Equal(t, "2", tabs[2].ID)
}

func TestTabCreate_NoFactory(t *testing.T) {
	tm, _ := newTestTab(t)
	w := httptest.NewRecorder()
	tm.Mux.ServeHTTP(w, jsonPost("/tabs", []byte(`{"path":"/some/repo"}`)))
	assert.Equal(t, http.StatusNotImplemented, w.Code)
}

func TestTabCreate_Validation(t *testing.T) {
	nopeFactory := func(path string) *Server {
		t.Fatalf("factory should not be called for invalid input")
		return nil
	}
	rejectRel := func(path string) (string, error) {
		if !strings.HasPrefix(path, "/") {
			return "", errors.New("path must be absolute")
		}
		return path, nil
	}
	tm := NewTabManager(nopeFactory, rejectRel)
	runner := testutil.NewMockRunner(t)
	runner.Allow(jj.CurrentOpId()).SetOutput([]byte("op"))
	tm.AddTab(NewServer(runner, ""), "/start")

	cases := []struct {
		body string
		want int
	}{
		{`{}`, http.StatusBadRequest},                       // empty path
		{`{"path":"relative/path"}`, http.StatusBadRequest}, // resolver rejects
		{`{"path":"/ok\npath"}`, http.StatusBadRequest},     // newline injection guard
		{`{not json`, http.StatusBadRequest},                // malformed
	}
	for _, tc := range cases {
		w := httptest.NewRecorder()
		tm.Mux.ServeHTTP(w, jsonPost("/tabs", []byte(tc.body)))
		assert.Equal(t, tc.want, w.Code, "body=%s", tc.body)
	}
}

func TestTabCreate_DedupAndFactory(t *testing.T) {
	// Now testable end-to-end: injected resolve means no real jj subprocess.
	factoryCalls := 0
	newTab := func(root string) *Server {
		factoryCalls++
		r := testutil.NewMockRunner(t)
		r.Allow(jj.CurrentOpId()).SetOutput([]byte("op"))
		return NewServer(r, "")
	}
	// Resolve canonicalizes to the same root for both inputs.
	resolve := func(path string) (string, error) { return "/canon", nil }
	tm := NewTabManager(newTab, resolve)
	r := testutil.NewMockRunner(t)
	r.Allow(jj.CurrentOpId()).SetOutput([]byte("op"))
	tm.AddTab(NewServer(r, ""), "/start")

	// First open: factory runs, tab created.
	w := httptest.NewRecorder()
	tm.Mux.ServeHTTP(w, jsonPost("/tabs", []byte(`{"path":"/canon/sub"}`)))
	require.Equal(t, http.StatusOK, w.Code)
	var t1 Tab
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &t1))
	assert.Equal(t, "/canon", t1.Path)
	assert.Equal(t, 1, factoryCalls)

	// Second open with different input, same canonical root: dedup returns
	// existing tab, factory NOT called again.
	w = httptest.NewRecorder()
	tm.Mux.ServeHTTP(w, jsonPost("/tabs", []byte(`{"path":"/canon"}`)))
	require.Equal(t, http.StatusOK, w.Code)
	var t2 Tab
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &t2))
	assert.Equal(t, t1.ID, t2.ID)
	assert.Equal(t, 1, factoryCalls, "dedup should prevent second factory call")
}

func TestTabFindByPath(t *testing.T) {
	tm := NewTabManager(nil, nil)
	runner := testutil.NewMockRunner(t)
	runner.Allow(jj.CurrentOpId()).SetOutput([]byte("op"))
	t0 := tm.AddTab(NewServer(runner, ""), "/canonical/root")

	assert.Same(t, t0, tm.FindByPath("/canonical/root"))
	assert.Nil(t, tm.FindByPath("/other"))
}

func TestTabClose(t *testing.T) {
	tm := NewTabManager(nil, nil)
	for i := 0; i < 2; i++ {
		runner := testutil.NewMockRunner(t)
		runner.Allow(jj.CurrentOpId()).SetOutput([]byte("op"))
		tm.AddTab(NewServer(runner, ""), "/r")
	}

	w := httptest.NewRecorder()
	tm.Mux.ServeHTTP(w, httptest.NewRequest("DELETE", "/tabs/1", nil))
	assert.Equal(t, http.StatusOK, w.Code)

	tm.mu.RLock()
	_, exists := tm.tabs["1"]
	tm.mu.RUnlock()
	assert.False(t, exists)

	// Dispatch to closed tab now 404s
	w = httptest.NewRecorder()
	tm.Mux.ServeHTTP(w, httptest.NewRequest("GET", "/tab/1/api/log", nil))
	assert.Equal(t, http.StatusNotFound, w.Code)
}

func TestTabClose_StartupTab(t *testing.T) {
	// Tab 0 (the -R startup tab) is never closeable — it's the anchor.
	// This is checked BEFORE the last-tab guard, so even with 2+ tabs
	// open, closing tab 0 is rejected.
	tm := NewTabManager(nil, nil)
	for i := 0; i < 2; i++ {
		r := testutil.NewMockRunner(t)
		r.Allow(jj.CurrentOpId()).SetOutput([]byte("op"))
		tm.AddTab(NewServer(r, ""), "/r")
	}
	w := httptest.NewRecorder()
	tm.Mux.ServeHTTP(w, httptest.NewRequest("DELETE", "/tabs/0", nil))
	assert.Equal(t, http.StatusBadRequest, w.Code)
	assert.Contains(t, w.Body.String(), "startup tab")
	// Tab 0 still present.
	tm.mu.RLock()
	_, exists := tm.tabs["0"]
	tm.mu.RUnlock()
	assert.True(t, exists)
}

// The len==1 guard in handleClose is technically unreachable now: tab 0 is
// always present (AddTab'd at startup, never closeable), so len>=1 always,
// and DELETE /tabs/0 hits the id=="0" guard first. Kept for defense-in-depth
// — if a future bug lets tab 0 slip out of the map, the len==1 check is the
// last line. No test for unreachable code.

func TestTabClose_Unknown(t *testing.T) {
	tm, _ := newTestTab(t)
	w := httptest.NewRecorder()
	tm.Mux.ServeHTTP(w, httptest.NewRequest("DELETE", "/tabs/99", nil))
	assert.Equal(t, http.StatusNotFound, w.Code)
}

func TestTabManager_IdleShutdown_CrossTab(t *testing.T) {
	// The core fix: switching from tab 0 to tab 1 should NOT start the idle
	// timer. totalSubs goes 1→2 (tab 1 connects) → 1 (tab 0 disconnects).
	// Never hits 0 until the BROWSER closes (both tabs disconnect).
	tm := NewTabManager(nil, nil)
	tm.SetIdleShutdown(10 * time.Millisecond)

	// Two tabs, each with a Watcher (no fsnotify — just the subscribe hooks).
	for i := 0; i < 2; i++ {
		r := testutil.NewMockRunner(t)
		r.Allow(jj.CurrentOpId()).SetOutput([]byte("op"))
		s := NewServer(r, "")
		s.Watcher = newWatcher(s) // bare watcher, no fsnotify/goroutines
		tm.AddTab(s, "/r")
	}

	w0 := tm.tabs["0"].srv.Watcher
	w1 := tm.tabs["1"].srv.Watcher

	// Browser opens, connects to tab 0.
	_, unsub0 := w0.subscribe()
	assert.Equal(t, 1, tm.totalSubs)

	// User switches to tab 1: new ES connects, then old ES closes ({#key}
	// destroy-before-create runs old cleanup before new effect, but the
	// new App's $effect fires in the same flush — net order depends on
	// Svelte internals. Either order is safe: 1→2→1 or 1→0→1. Test both).
	_, unsub1 := w1.subscribe()
	unsub0()
	assert.Equal(t, 1, tm.totalSubs)
	assert.Nil(t, tm.idleTimer, "switching tabs must not start idle timer")

	// Browser closes → tab 1's ES disconnects → totalSubs hits 0 → timer fires.
	unsub1()
	assert.Equal(t, 0, tm.totalSubs)
	select {
	case <-tm.ShutdownCh:
	case <-time.After(100 * time.Millisecond):
		t.Fatal("ShutdownCh not closed after idle timeout")
	}
}

func TestTabManager_IdleShutdown_ReconnectCancels(t *testing.T) {
	tm := NewTabManager(nil, nil)
	tm.SetIdleShutdown(50 * time.Millisecond)
	r := testutil.NewMockRunner(t)
	r.Allow(jj.CurrentOpId()).SetOutput([]byte("op"))
	s := NewServer(r, "")
	s.Watcher = newWatcher(s)
	tm.AddTab(s, "/r")

	_, unsub := s.Watcher.subscribe()
	unsub() // timer starts
	require.NotNil(t, tm.idleTimer)

	// Reconnect before timer fires → cancelled.
	_, unsub2 := s.Watcher.subscribe()
	assert.Nil(t, tm.idleTimer)

	select {
	case <-tm.ShutdownCh:
		t.Fatal("ShutdownCh closed despite reconnect")
	case <-time.After(100 * time.Millisecond):
	}
	unsub2()
}

func TestTabManager_IdleShutdown_CloseOrder(t *testing.T) {
	// The other order: old tab disconnects BEFORE new tab connects (possible
	// if {#key} cleanup runs before the new mount's effect). totalSubs dips
	// to 0 momentarily → timer starts → incSub cancels it.
	tm := NewTabManager(nil, nil)
	tm.SetIdleShutdown(50 * time.Millisecond)
	for i := 0; i < 2; i++ {
		r := testutil.NewMockRunner(t)
		r.Allow(jj.CurrentOpId()).SetOutput([]byte("op"))
		s := NewServer(r, "")
		s.Watcher = newWatcher(s)
		tm.AddTab(s, "/r")
	}

	_, unsub0 := tm.tabs["0"].srv.Watcher.subscribe()
	unsub0() // totalSubs: 1→0, timer starts
	require.NotNil(t, tm.idleTimer)

	_, unsub1 := tm.tabs["1"].srv.Watcher.subscribe() // totalSubs: 0→1, timer cancelled
	assert.Nil(t, tm.idleTimer)

	select {
	case <-tm.ShutdownCh:
		t.Fatal("ShutdownCh closed — timer should have been cancelled")
	case <-time.After(100 * time.Millisecond):
	}
	unsub1()
}

func TestTabManager_ConfigAtTopLevel(t *testing.T) {
	// config.svelte.ts fetches /api/config without a tab prefix — must route.
	withConfigDir(t)
	tm, _ := newTestTab(t)
	w := httptest.NewRecorder()
	tm.Mux.ServeHTTP(w, httptest.NewRequest("GET", "/api/config", nil))
	assert.Equal(t, http.StatusOK, w.Code)
	assert.Equal(t, "{}", w.Body.String())
}

// TestTabPersistence exercises the create → config.json → close cycle.
// persistTabs() skips tab 0 (it's the CLI -R flag, implicit on every launch)
// and preserves unrelated config keys via mergeAndWriteConfig.
func TestTabPersistence(t *testing.T) {
	withConfigDir(t)

	newTab := func(root string) *Server {
		r := testutil.NewMockRunner(t)
		r.Allow(jj.CurrentOpId()).SetOutput([]byte("op"))
		return NewServer(r, "")
	}
	resolve := func(p string) (string, error) { return p, nil }
	tm := NewTabManager(newTab, resolve)
	tm.Mode = "local" // empty → persistTabs no-ops
	r := testutil.NewMockRunner(t)
	r.Allow(jj.CurrentOpId()).SetOutput([]byte("op"))
	tm.AddTab(NewServer(r, ""), "/startup-repo") // tab 0

	// Open two more tabs.
	for _, p := range []string{"/repo-a", "/repo-b"} {
		w := httptest.NewRecorder()
		tm.Mux.ServeHTTP(w, jsonPost("/tabs", []byte(`{"path":"`+p+`"}`)))
		require.Equal(t, http.StatusOK, w.Code, w.Body.String())
	}

	got := ReadPersistedTabs()
	require.Len(t, got, 2)
	assert.Equal(t, "/repo-a", got[0].Path)
	assert.Equal(t, "/repo-b", got[1].Path)
	assert.Equal(t, "local", got[0].Mode)
	// Tab 0 excluded — it's the -R flag, persisting it would fight with
	// a different -R on next launch.
	for _, pt := range got {
		assert.NotEqual(t, "/startup-repo", pt.Path)
	}

	// Close /repo-a (tab 1) → only /repo-b left in config.
	w := httptest.NewRecorder()
	tm.Mux.ServeHTTP(w, httptest.NewRequest("DELETE", "/tabs/1", nil))
	require.Equal(t, http.StatusOK, w.Code)

	got = ReadPersistedTabs()
	require.Len(t, got, 1)
	assert.Equal(t, "/repo-b", got[0].Path)
}

func TestTabPersistence_ModeEmptySkips(t *testing.T) {
	// Tests leave Mode="" — persistTabs should no-op. Otherwise every existing
	// tabs_test.go case would suddenly require a withConfigDir(t) call.
	path := withConfigDir(t)

	newTab := func(root string) *Server {
		r := testutil.NewMockRunner(t)
		r.Allow(jj.CurrentOpId()).SetOutput([]byte("op"))
		return NewServer(r, "")
	}
	tm := NewTabManager(newTab, func(p string) (string, error) { return p, nil })
	// Mode deliberately left empty.
	r := testutil.NewMockRunner(t)
	r.Allow(jj.CurrentOpId()).SetOutput([]byte("op"))
	tm.AddTab(NewServer(r, ""), "/start")

	w := httptest.NewRecorder()
	tm.Mux.ServeHTTP(w, jsonPost("/tabs", []byte(`{"path":"/x"}`)))
	require.Equal(t, http.StatusOK, w.Code)

	// Config file should not exist — persistTabs() returned early.
	_, err := os.Stat(path)
	assert.True(t, os.IsNotExist(err), "Mode=\"\" should skip config write, got file at %s", path)
}
