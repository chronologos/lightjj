package api

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

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
	tm := NewTabManager(nil)
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
	tm := NewTabManager(nil)
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
	tm := NewTabManager(func(path string) *Server {
		t.Fatalf("factory should not be called for invalid input")
		return nil
	})
	runner := testutil.NewMockRunner(t)
	runner.Allow(jj.CurrentOpId()).SetOutput([]byte("op"))
	tm.AddTab(NewServer(runner, ""), "/start")

	cases := []struct {
		body string
		want int
	}{
		{`{}`, http.StatusBadRequest},                      // empty path
		{`{"path":"relative/path"}`, http.StatusBadRequest}, // not absolute
		{`{not json`, http.StatusBadRequest},                // malformed
	}
	for _, tc := range cases {
		w := httptest.NewRecorder()
		tm.Mux.ServeHTTP(w, jsonPost("/tabs", []byte(tc.body)))
		assert.Equal(t, tc.want, w.Code, "body=%s", tc.body)
	}
}

func TestTabFindByPath(t *testing.T) {
	// handleCreate's dedup goes through findByPath. We can't call
	// handleCreate itself (ResolveWorkspaceRoot needs a real jj repo),
	// but the dedup lookup is testable directly.
	tm := NewTabManager(nil)
	runner := testutil.NewMockRunner(t)
	runner.Allow(jj.CurrentOpId()).SetOutput([]byte("op"))
	t0 := tm.AddTab(NewServer(runner, ""), "/canonical/root")

	assert.Same(t, t0, tm.findByPath("/canonical/root"))
	assert.Nil(t, tm.findByPath("/other"))
}

func TestTabClose(t *testing.T) {
	tm := NewTabManager(nil)
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

func TestTabClose_Last(t *testing.T) {
	tm, _ := newTestTab(t)
	w := httptest.NewRecorder()
	tm.Mux.ServeHTTP(w, httptest.NewRequest("DELETE", "/tabs/0", nil))
	assert.Equal(t, http.StatusBadRequest, w.Code)
	tm.mu.RLock()
	assert.Len(t, tm.tabs, 1)
	tm.mu.RUnlock()
}

func TestTabClose_Unknown(t *testing.T) {
	tm, _ := newTestTab(t)
	w := httptest.NewRecorder()
	tm.Mux.ServeHTTP(w, httptest.NewRequest("DELETE", "/tabs/99", nil))
	assert.Equal(t, http.StatusNotFound, w.Code)
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
