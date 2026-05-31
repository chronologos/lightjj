package api

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"

	"github.com/chronologos/lightjj/testutil"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// withStateDir reuses the userConfigDir test seam (config_test.go) and
// returns the state.json path inside it.
func withStateDir(t *testing.T) string {
	t.Helper()
	configFile := withConfigDir(t)
	return filepath.Join(filepath.Dir(configFile), "state.json")
}

// seedState writes raw content to the state path.
func seedState(t *testing.T, path, content string) {
	t.Helper()
	require.NoError(t, os.MkdirAll(filepath.Dir(path), 0o755))
	require.NoError(t, os.WriteFile(path, []byte(content), 0o644))
}

func TestPersistedTabs_State(t *testing.T) {
	t.Run("missing file → empty", func(t *testing.T) {
		withStateDir(t)
		assert.Empty(t, ReadPersistedTabs())
	})

	t.Run("field absent → empty", func(t *testing.T) {
		path := withStateDir(t)
		seedState(t, path, `{"recentActions":{}}`)
		assert.Empty(t, ReadPersistedTabs())
	})

	t.Run("zero-byte file → empty (fresh, not corrupt)", func(t *testing.T) {
		path := withStateDir(t)
		seedState(t, path, "")
		assert.Empty(t, ReadPersistedTabs())
	})

	t.Run("corrupt json → empty", func(t *testing.T) {
		path := withStateDir(t)
		seedState(t, path, `{not json`)
		assert.Empty(t, ReadPersistedTabs())
	})

	t.Run("wrong type → empty", func(t *testing.T) {
		path := withStateDir(t)
		seedState(t, path, `{"openTabs":"oops"}`)
		assert.Empty(t, ReadPersistedTabs())
	})

	t.Run("round trip", func(t *testing.T) {
		withStateDir(t)
		want := []PersistedTab{
			{Path: "/repo/a", Mode: "local"},
			{Path: "/repo/b", Mode: "local"},
		}
		require.NoError(t, SetOpenTabs("local", "", want))
		assert.Equal(t, want, ReadPersistedTabs())
	})

	t.Run("write preserves recentActions section", func(t *testing.T) {
		// The two sections are independent: writing tabs must not clobber
		// recency data and vice versa (both go through read-modify-write
		// under stateMu).
		withStateDir(t)
		require.NoError(t, SetRecentActions(map[string]map[string]int64{
			"bookmark-modal": {"main": 123},
		}))
		require.NoError(t, SetOpenTabs("local", "", []PersistedTab{{Path: "/x", Mode: "local"}}))

		assert.Equal(t, []PersistedTab{{Path: "/x", Mode: "local"}}, ReadPersistedTabs())
		assert.Equal(t, int64(123), readRecentActions()["bookmark-modal"]["main"])
	})

	t.Run("filter-merge preserves other sessions", func(t *testing.T) {
		// The multi-host scenario: session A (hostA) has a tab, session B
		// (hostB) opens/closes a tab. A whole-array overwrite would erase
		// A's entry. The filter-merge only touches (mode,host)-matching
		// entries — A's entry must survive B's write.
		withStateDir(t)

		a := []PersistedTab{{Path: "/work", Mode: "ssh", Host: "u@hostA"}}
		require.NoError(t, SetOpenTabs("ssh", "u@hostA", a))

		b := []PersistedTab{{Path: "/proj", Mode: "ssh", Host: "u@hostB"}}
		require.NoError(t, SetOpenTabs("ssh", "u@hostB", b))

		got := ReadPersistedTabs()
		require.Len(t, got, 2)
		// Order: A's kept entry first (filter preserves order), B's appended.
		assert.Equal(t, "u@hostA", got[0].Host)
		assert.Equal(t, "u@hostB", got[1].Host)

		// Session A closes its last tab → writes empty slice for its session.
		require.NoError(t, SetOpenTabs("ssh", "u@hostA", nil))

		got = ReadPersistedTabs()
		require.Len(t, got, 1)
		assert.Equal(t, "u@hostB", got[0].Host) // B untouched
	})
}

func TestRecentActions_State(t *testing.T) {
	t.Run("missing file → empty map not nil", func(t *testing.T) {
		withStateDir(t)
		got := readRecentActions()
		require.NotNil(t, got)
		assert.Empty(t, got)
	})

	t.Run("round trip", func(t *testing.T) {
		withStateDir(t)
		want := map[string]map[string]int64{
			"bookmark-modal": {"main": 1748600000000, "feat": 1748600001000},
		}
		require.NoError(t, SetRecentActions(want))
		assert.Equal(t, recentActionsState(want), readRecentActions())
	})

	t.Run("set replaces whole section", func(t *testing.T) {
		withStateDir(t)
		require.NoError(t, SetRecentActions(map[string]map[string]int64{"a": {"x": 1}}))
		require.NoError(t, SetRecentActions(map[string]map[string]int64{"b": {"y": 2}}))
		got := readRecentActions()
		assert.NotContains(t, got, "a")
		assert.Equal(t, int64(2), got["b"]["y"])
	})
}

func TestStateHandlers(t *testing.T) {
	newSrv := func(t *testing.T) *Server {
		t.Helper()
		runner := testutil.NewMockRunner(t)
		t.Cleanup(runner.Verify)
		return NewServer(runner, "")
	}

	t.Run("GET empty → {}", func(t *testing.T) {
		withStateDir(t)
		srv := newSrv(t)
		w := httptest.NewRecorder()
		srv.Mux.ServeHTTP(w, httptest.NewRequest("GET", "/api/state/recent-actions", nil))
		assert.Equal(t, http.StatusOK, w.Code)
		assert.JSONEq(t, "{}", w.Body.String())
	})

	t.Run("POST then GET round trip", func(t *testing.T) {
		withStateDir(t)
		srv := newSrv(t)

		body := `{"bookmark-modal":{"main":1748600000000}}`
		w := httptest.NewRecorder()
		srv.Mux.ServeHTTP(w, jsonPost("/api/state/recent-actions", []byte(body)))
		require.Equal(t, http.StatusOK, w.Code)

		w = httptest.NewRecorder()
		srv.Mux.ServeHTTP(w, httptest.NewRequest("GET", "/api/state/recent-actions", nil))
		assert.Equal(t, http.StatusOK, w.Code)
		assert.JSONEq(t, body, w.Body.String())
	})

	t.Run("POST malformed body → 400", func(t *testing.T) {
		withStateDir(t)
		srv := newSrv(t)
		w := httptest.NewRecorder()
		srv.Mux.ServeHTTP(w, jsonPost("/api/state/recent-actions", []byte(`{not json`)))
		assert.Equal(t, http.StatusBadRequest, w.Code)
	})

	t.Run("POST wrong shape → 400", func(t *testing.T) {
		withStateDir(t)
		srv := newSrv(t)
		w := httptest.NewRecorder()
		srv.Mux.ServeHTTP(w, jsonPost("/api/state/recent-actions", []byte(`{"ns":"not-a-map"}`)))
		assert.Equal(t, http.StatusBadRequest, w.Code)
	})

	t.Run("POST cross-origin → 403", func(t *testing.T) {
		withStateDir(t)
		srv := newSrv(t)
		req := jsonPost("/api/state/recent-actions", []byte(`{}`))
		req.Header.Set("Origin", "https://evil.example.com")
		w := httptest.NewRecorder()
		srv.Mux.ServeHTTP(w, req)
		assert.Equal(t, http.StatusForbidden, w.Code)
	})

	t.Run("registered on TabManager mux without tab prefix", func(t *testing.T) {
		// Raw fetch / `lightjj api` access goes through the host-level mux.
		withStateDir(t)
		tm := NewTabManager(nil, nil)
		w := httptest.NewRecorder()
		tm.Mux.ServeHTTP(w, httptest.NewRequest("GET", "/api/state/recent-actions", nil))
		assert.Equal(t, http.StatusOK, w.Code)
		assert.JSONEq(t, "{}", w.Body.String())
	})

	t.Run("config endpoints never serve state keys", func(t *testing.T) {
		// The split is observable over HTTP: state writes don't leak into
		// GET /api/config.
		withStateDir(t)
		srv := newSrv(t)

		w := httptest.NewRecorder()
		srv.Mux.ServeHTTP(w, jsonPost("/api/state/recent-actions", []byte(`{"ns":{"k":1}}`)))
		require.Equal(t, http.StatusOK, w.Code)

		w = httptest.NewRecorder()
		srv.Mux.ServeHTTP(w, httptest.NewRequest("GET", "/api/config", nil))
		require.Equal(t, http.StatusOK, w.Code)
		assert.NotContains(t, w.Body.String(), "recentActions")
	})
}

func TestMigrateStateIfNeeded(t *testing.T) {
	t.Run("legacy keys move from config to state", func(t *testing.T) {
		statePath := withStateDir(t)
		configFile := filepath.Join(filepath.Dir(statePath), "config.json")
		seedConfig(t, configFile, `{
  // user's note
  "theme": "dark",
  "openTabs": [{"path":"/repo/a","mode":"local"}],
  "recentActions": {"bookmark-modal":{"main":1748600000000}}
}`)

		MigrateStateIfNeeded()

		// Values landed in state.json.
		tabs := ReadPersistedTabs()
		require.Len(t, tabs, 1)
		assert.Equal(t, "/repo/a", tabs[0].Path)
		assert.Equal(t, int64(1748600000000), readRecentActions()["bookmark-modal"]["main"])

		// Keys removed from config.json; comments and other keys survive.
		data, err := os.ReadFile(configFile)
		require.NoError(t, err)
		content := string(data)
		assert.NotContains(t, content, "openTabs")
		assert.NotContains(t, content, "recentActions")
		assert.Contains(t, content, "// user's note")
		assert.Contains(t, content, `"theme"`)

		// Config still parses as JSONC.
		var cfg map[string]any
		require.NoError(t, unmarshalJSONC(data, &cfg))
		assert.Equal(t, "dark", cfg["theme"])
	})

	t.Run("no legacy keys → no-op, no state file created", func(t *testing.T) {
		statePath := withStateDir(t)
		configFile := filepath.Join(filepath.Dir(statePath), "config.json")
		original := `{"theme":"dark"}`
		seedConfig(t, configFile, original)

		MigrateStateIfNeeded()

		_, err := os.Stat(statePath)
		assert.True(t, os.IsNotExist(err), "state.json should not be created when there is nothing to migrate")
		data, err := os.ReadFile(configFile)
		require.NoError(t, err)
		assert.Equal(t, original, string(data), "config must be untouched")
	})

	t.Run("missing config → no-op", func(t *testing.T) {
		statePath := withStateDir(t)
		MigrateStateIfNeeded()
		_, err := os.Stat(statePath)
		assert.True(t, os.IsNotExist(err))
	})

	t.Run("corrupt config → no-op", func(t *testing.T) {
		statePath := withStateDir(t)
		configFile := filepath.Join(filepath.Dir(statePath), "config.json")
		original := `{not valid`
		seedConfig(t, configFile, original)

		MigrateStateIfNeeded()

		data, err := os.ReadFile(configFile)
		require.NoError(t, err)
		assert.Equal(t, original, string(data), "corrupt config must be left alone")
	})

	t.Run("idempotent — second run is a no-op", func(t *testing.T) {
		statePath := withStateDir(t)
		configFile := filepath.Join(filepath.Dir(statePath), "config.json")
		seedConfig(t, configFile, `{"theme":"dark","openTabs":[{"path":"/a","mode":"local"}]}`)

		MigrateStateIfNeeded()
		afterFirst, err := os.ReadFile(configFile)
		require.NoError(t, err)
		stateAfterFirst, err := os.ReadFile(statePath)
		require.NoError(t, err)

		MigrateStateIfNeeded()
		afterSecond, err := os.ReadFile(configFile)
		require.NoError(t, err)
		stateAfterSecond, err := os.ReadFile(statePath)
		require.NoError(t, err)

		assert.Equal(t, string(afterFirst), string(afterSecond))
		assert.Equal(t, string(stateAfterFirst), string(stateAfterSecond))
	})

	t.Run("existing state sections win over legacy config values", func(t *testing.T) {
		// Downgrade-then-upgrade: state.json already has fresher data than
		// the stale legacy keys an old binary re-added to config.json.
		statePath := withStateDir(t)
		configFile := filepath.Join(filepath.Dir(statePath), "config.json")
		require.NoError(t, SetOpenTabs("local", "", []PersistedTab{{Path: "/fresh", Mode: "local"}}))
		seedConfig(t, configFile, `{"openTabs":[{"path":"/stale","mode":"local"}]}`)

		MigrateStateIfNeeded()

		tabs := ReadPersistedTabs()
		require.Len(t, tabs, 1)
		assert.Equal(t, "/fresh", tabs[0].Path, "existing state must not be overwritten by stale config values")
		// Legacy key still removed from config.
		data, err := os.ReadFile(configFile)
		require.NoError(t, err)
		assert.NotContains(t, string(data), "openTabs")
	})

	t.Run("undecodable legacy key left in config", func(t *testing.T) {
		// A malformed openTabs (wrong type) can't be imported — removing it
		// would discard data we couldn't read. It stays; decodable keys still
		// migrate.
		statePath := withStateDir(t)
		configFile := filepath.Join(filepath.Dir(statePath), "config.json")
		seedConfig(t, configFile, `{"openTabs":"oops","recentActions":{"ns":{"k":5}}}`)

		MigrateStateIfNeeded()

		assert.Equal(t, int64(5), readRecentActions()["ns"]["k"])
		data, err := os.ReadFile(configFile)
		require.NoError(t, err)
		assert.Contains(t, string(data), "openTabs", "undecodable key must not be removed")
		assert.NotContains(t, string(data), "recentActions")
	})
}

// TestStateStore_PlainJSONNotJSONC pins the format contract: state.json is
// plain JSON written by json.MarshalIndent — comments are not supported and
// not expected (machines write it, humans read config.json).
func TestStateStore_PlainJSONNotJSONC(t *testing.T) {
	path := withStateDir(t)
	require.NoError(t, SetOpenTabs("local", "", []PersistedTab{{Path: "/x", Mode: "local"}}))
	data, err := os.ReadFile(path)
	require.NoError(t, err)
	var st map[string]any
	require.NoError(t, json.Unmarshal(data, &st), "state.json must be plain machine-readable JSON")
}
