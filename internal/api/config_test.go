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

// withConfigDir swaps the userConfigDir seam for a temp dir. Cleanup restores
// the real os.UserConfigDir so parallel tests in other files are unaffected
// (though these tests can't use t.Parallel() — shared package var).
func withConfigDir(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	orig := userConfigDir
	userConfigDir = func() (string, error) { return dir, nil }
	t.Cleanup(func() { userConfigDir = orig })
	return filepath.Join(dir, "lightjj", "config.json")
}

// seedConfig writes raw content to the config path. Saves the MkdirAll +
// WriteFile pair that 6+ tests repeat when pre-seeding config state.
func seedConfig(t *testing.T, path, content string) {
	t.Helper()
	require.NoError(t, os.MkdirAll(filepath.Dir(path), 0o755))
	require.NoError(t, os.WriteFile(path, []byte(content), 0o644))
}

func TestHandleConfig_SSHMode(t *testing.T) {
	// Config uses os.UserConfigDir (local), not RepoDir, so SSH mode
	// (RepoDir="") should still read/write config normally.
	withConfigDir(t)
	runner := testutil.NewMockRunner(t)
	defer runner.Verify()
	srv := NewServer(runner, "") // RepoDir="" → SSH mode

	w := httptest.NewRecorder()
	srv.Mux.ServeHTTP(w, httptest.NewRequest("GET", "/api/config", nil))
	assert.Equal(t, http.StatusOK, w.Code)
	assert.Equal(t, "{}", w.Body.String())

	w = httptest.NewRecorder()
	srv.Mux.ServeHTTP(w, jsonPost("/api/config", []byte(`{"theme":"dark"}`)))
	assert.Equal(t, http.StatusOK, w.Code)

	// Verify it persisted
	w = httptest.NewRecorder()
	srv.Mux.ServeHTTP(w, httptest.NewRequest("GET", "/api/config", nil))
	assert.Equal(t, http.StatusOK, w.Code)
	var got map[string]any
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &got))
	assert.Equal(t, "dark", got["theme"])
}

func TestHandleConfigGet_Missing(t *testing.T) {
	withConfigDir(t)
	runner := testutil.NewMockRunner(t)
	defer runner.Verify()
	srv := NewServer(runner, t.TempDir())

	w := httptest.NewRecorder()
	srv.Mux.ServeHTTP(w, httptest.NewRequest("GET", "/api/config", nil))

	assert.Equal(t, http.StatusOK, w.Code)
	assert.Equal(t, "{}", w.Body.String())
}

func TestHandleConfigSet_RoundTrip(t *testing.T) {
	path := withConfigDir(t)
	runner := testutil.NewMockRunner(t)
	defer runner.Verify()
	srv := NewServer(runner, t.TempDir())

	w := httptest.NewRecorder()
	srv.Mux.ServeHTTP(w, jsonPost("/api/config", []byte(`{"theme":"light","splitView":true}`)))
	require.Equal(t, http.StatusOK, w.Code)

	// File exists and parses as JSONC (fresh-install path seeds the template
	// with comments; standardize to plain JSON for the value checks).
	data, err := os.ReadFile(path)
	require.NoError(t, err)
	var got map[string]any
	require.NoError(t, unmarshalJSONC(data, &got))
	assert.Equal(t, "light", got["theme"])
	assert.Equal(t, true, got["splitView"])

	// GET returns the standardized (plain-JSON) payload.
	w = httptest.NewRecorder()
	srv.Mux.ServeHTTP(w, httptest.NewRequest("GET", "/api/config", nil))
	assert.Equal(t, http.StatusOK, w.Code)
	var roundTrip map[string]any
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &roundTrip))
	assert.Equal(t, got, roundTrip)
}

func TestHandleConfigSet_MergePreservesUnknownKeys(t *testing.T) {
	// Forward-compat: a newer lightjj writes {"futureKey": 42}. An older
	// instance (which only knows about "theme") saves its config — the
	// merge must preserve futureKey.
	path := withConfigDir(t)
	seedConfig(t, path, `{"theme":"dark","futureKey":42}`)

	runner := testutil.NewMockRunner(t)
	defer runner.Verify()
	srv := NewServer(runner, t.TempDir())

	w := httptest.NewRecorder()
	srv.Mux.ServeHTTP(w, jsonPost("/api/config", []byte(`{"theme":"light"}`)))
	require.Equal(t, http.StatusOK, w.Code)

	data, err := os.ReadFile(path)
	require.NoError(t, err)
	var got map[string]any
	require.NoError(t, json.Unmarshal(data, &got))
	assert.Equal(t, "light", got["theme"])       // incoming wins
	assert.Equal(t, float64(42), got["futureKey"]) // preserved
}

func TestHandleConfigSet_AtomicWrite(t *testing.T) {
	// Corrupt existing file → write REJECTED with 422. User's bad file is
	// left untouched so they can fix it in the editor. Silently reseeding
	// would destroy the user's hand-edits on the next panel-drag write —
	// one stray typo and a carefully commented config becomes the default
	// template. The frontend surfaces a warning + "Edit config" action.
	path := withConfigDir(t)
	seedConfig(t, path, `{not valid json`)

	runner := testutil.NewMockRunner(t)
	defer runner.Verify()
	srv := NewServer(runner, t.TempDir())

	w := httptest.NewRecorder()
	srv.Mux.ServeHTTP(w, jsonPost("/api/config", []byte(`{"theme":"light"}`)))
	assert.Equal(t, http.StatusUnprocessableEntity, w.Code)
	assert.Contains(t, w.Body.String(), "syntax error")

	// File must be unchanged — byte-identical to what the user wrote.
	data, err := os.ReadFile(path)
	require.NoError(t, err)
	assert.Equal(t, `{not valid json`, string(data))

	// No temp files left behind (atomic-rename never happened, but check
	// we also didn't leak a .config-*.json).
	entries, err := os.ReadDir(filepath.Dir(path))
	require.NoError(t, err)
	assert.Len(t, entries, 1)
}

func TestHandleConfigGet_CorruptFileReturns422(t *testing.T) {
	// Corrupt file → 422. Previously returned {} which tricked the frontend
	// into overwriting its in-memory state with defaults (theme flip to dark,
	// panel widths reset, etc.). The raw endpoint still serves the bad bytes
	// so ConfigModal can show + fix the typo.
	path := withConfigDir(t)
	seedConfig(t, path, `{not valid json`)

	runner := testutil.NewMockRunner(t)
	defer runner.Verify()
	srv := NewServer(runner, t.TempDir())

	w := httptest.NewRecorder()
	srv.Mux.ServeHTTP(w, httptest.NewRequest("GET", "/api/config", nil))
	assert.Equal(t, http.StatusUnprocessableEntity, w.Code)
	assert.Contains(t, w.Body.String(), "syntax error")
}

func TestHandleConfigSet_FreshInstallSeedsTemplate(t *testing.T) {
	// No file exists → first write should produce a JSONC file with the
	// teaching comments from configTemplate, then overlay user's keys.
	path := withConfigDir(t)
	runner := testutil.NewMockRunner(t)
	defer runner.Verify()
	srv := NewServer(runner, t.TempDir())

	w := httptest.NewRecorder()
	srv.Mux.ServeHTTP(w, jsonPost("/api/config", []byte(`{"theme":"gruvbox-dark"}`)))
	require.Equal(t, http.StatusOK, w.Code)

	data, err := os.ReadFile(path)
	require.NoError(t, err)
	content := string(data)
	assert.Contains(t, content, "// Theme id.",
		"fresh install should carry the template's theme comment")
	assert.Contains(t, content, "// Open-in-editor argv",
		"fresh install should carry the editorArgs comment")
	assert.Contains(t, content, `"theme": "gruvbox-dark"`,
		"user's override should be applied over template")
}

func TestHandleConfigSet_PreservesUserComments(t *testing.T) {
	// User has hand-added a comment. Next programmatic write (e.g. theme
	// toggle, panel resize) must NOT nuke it. This is the core value-prop
	// of the JSONC refactor.
	path := withConfigDir(t)
	seedConfig(t, path, `{
  // my personal note
  "theme": "dark",
  "revisionPanelWidth": 420
}`)

	runner := testutil.NewMockRunner(t)
	defer runner.Verify()
	srv := NewServer(runner, t.TempDir())

	w := httptest.NewRecorder()
	srv.Mux.ServeHTTP(w, jsonPost("/api/config", []byte(`{"theme":"light"}`)))
	require.Equal(t, http.StatusOK, w.Code)

	data, err := os.ReadFile(path)
	require.NoError(t, err)
	content := string(data)
	assert.Contains(t, content, "// my personal note")
	assert.Contains(t, content, `"theme": "light"`)
	assert.Contains(t, content, `"revisionPanelWidth": 420`)
}

func TestHandleConfigSet_AcceptsJSONCInput(t *testing.T) {
	// User has already hand-edited their file to include comments. The next
	// panel-drag POSTs a typed-JSON delta; the existing JSONC file must be
	// readable (hujson.Parse tolerates comments), not treated as corrupt.
	path := withConfigDir(t)
	seedConfig(t, path, `{
  // note
  "theme": "dark", // trailing comma ok
}`)

	runner := testutil.NewMockRunner(t)
	defer runner.Verify()
	srv := NewServer(runner, t.TempDir())

	w := httptest.NewRecorder()
	srv.Mux.ServeHTTP(w, jsonPost("/api/config", []byte(`{"splitView":true}`)))
	require.Equal(t, http.StatusOK, w.Code)

	data, err := os.ReadFile(path)
	require.NoError(t, err)
	var m map[string]any
	require.NoError(t, unmarshalJSONC(data, &m))
	assert.Equal(t, "dark", m["theme"])
	assert.Equal(t, true, m["splitView"])
}

func TestHandleConfigSet_BadJSON(t *testing.T) {
	withConfigDir(t)
	runner := testutil.NewMockRunner(t)
	defer runner.Verify()
	srv := NewServer(runner, t.TempDir())

	w := httptest.NewRecorder()
	srv.Mux.ServeHTTP(w, jsonPost("/api/config", []byte(`{not json`)))
	assert.Equal(t, http.StatusBadRequest, w.Code)
}

func TestHandleConfigSet_CrossOriginRejected(t *testing.T) {
	withConfigDir(t)
	runner := testutil.NewMockRunner(t)
	defer runner.Verify()
	srv := NewServer(runner, t.TempDir())

	// Cross-origin rejected
	req := jsonPost("/api/config", []byte(`{"theme":"light"}`))
	req.Header.Set("Origin", "https://evil.example.com")
	w := httptest.NewRecorder()
	srv.Mux.ServeHTTP(w, req)
	assert.Equal(t, http.StatusForbidden, w.Code)

	// Same-origin accepted
	req = jsonPost("/api/config", []byte(`{"theme":"light"}`))
	req.Header.Set("Origin", "http://localhost:3000")
	w = httptest.NewRecorder()
	srv.Mux.ServeHTTP(w, req)
	assert.Equal(t, http.StatusOK, w.Code)

	// Missing Origin (curl, tests) accepted
	req = jsonPost("/api/config", []byte(`{"theme":"dark"}`))
	w = httptest.NewRecorder()
	srv.Mux.ServeHTTP(w, req)
	assert.Equal(t, http.StatusOK, w.Code)
}

func TestIsLocalOrigin(t *testing.T) {
	assert.True(t, isLocalOrigin("http://localhost:3000"))
	assert.True(t, isLocalOrigin("http://127.0.0.1:8080"))
	assert.True(t, isLocalOrigin("http://[::1]:3000"))
	assert.False(t, isLocalOrigin("https://evil.example.com"))
	assert.False(t, isLocalOrigin("http://10.0.0.1"))
	assert.False(t, isLocalOrigin("not a url"))
	// Origin-spoof shapes — url.Parse.Hostname() extracts the real host.
	assert.False(t, isLocalOrigin("http://localhost.evil.com"))
	assert.False(t, isLocalOrigin("http://localhost@evil.com"))
	assert.False(t, isLocalOrigin("null")) // iframe sandbox, file://
}

func TestReadPersistedTabs(t *testing.T) {
	t.Run("missing file → empty", func(t *testing.T) {
		withConfigDir(t)
		assert.Empty(t, ReadPersistedTabs())
	})

	t.Run("field absent → empty", func(t *testing.T) {
		path := withConfigDir(t)
		seedConfig(t, path, `{"theme":"dark"}`)
		assert.Empty(t, ReadPersistedTabs())
	})

	t.Run("corrupt json → empty", func(t *testing.T) {
		path := withConfigDir(t)
		seedConfig(t, path, `{not json`)
		assert.Empty(t, ReadPersistedTabs())
	})

	t.Run("wrong type → empty", func(t *testing.T) {
		path := withConfigDir(t)
		// openTabs is a string, not an array — Unmarshal fails, return nil
		seedConfig(t, path, `{"openTabs":"oops"}`)
		assert.Empty(t, ReadPersistedTabs())
	})

	t.Run("round trip", func(t *testing.T) {
		withConfigDir(t)
		want := []PersistedTab{
			{Path: "/repo/a", Mode: "local"},
			{Path: "/repo/b", Mode: "local"},
		}
		require.NoError(t, writePersistedTabs("local", "", want))
		assert.Equal(t, want, ReadPersistedTabs())
	})

	t.Run("write preserves other keys", func(t *testing.T) {
		// Persisting tabs must NOT stomp theme/editorArgs/etc — whole-config
		// RawMessage read → overlay → write.
		path := withConfigDir(t)
		seedConfig(t, path, `{"theme":"light","editorArgs":["zed"]}`)

		require.NoError(t, writePersistedTabs("ssh", "u@h", []PersistedTab{{Path: "/x", Mode: "ssh", Host: "u@h"}}))

		data, err := os.ReadFile(path)
		require.NoError(t, err)
		var got map[string]any
		require.NoError(t, json.Unmarshal(data, &got))
		assert.Equal(t, "light", got["theme"])
		assert.Equal(t, []any{"zed"}, got["editorArgs"])
		assert.Len(t, got["openTabs"], 1)
	})

	t.Run("filter-merge preserves other sessions", func(t *testing.T) {
		// The multi-host scenario: session A (hostA) has a tab, session B
		// (hostB) opens/closes a tab. A whole-array overwrite would erase
		// A's entry. The filter-merge only touches (mode,host)-matching
		// entries — A's entry must survive B's write.
		withConfigDir(t)

		// Session A writes.
		a := []PersistedTab{{Path: "/work", Mode: "ssh", Host: "u@hostA"}}
		require.NoError(t, writePersistedTabs("ssh", "u@hostA", a))

		// Session B writes (different host).
		b := []PersistedTab{{Path: "/proj", Mode: "ssh", Host: "u@hostB"}}
		require.NoError(t, writePersistedTabs("ssh", "u@hostB", b))

		got := ReadPersistedTabs()
		require.Len(t, got, 2)
		// Order: A's kept entry first (filter preserves order), B's appended.
		assert.Equal(t, "u@hostA", got[0].Host)
		assert.Equal(t, "u@hostB", got[1].Host)

		// Session A closes its last tab → writes empty slice for its session.
		require.NoError(t, writePersistedTabs("ssh", "u@hostA", nil))

		got = ReadPersistedTabs()
		require.Len(t, got, 1)
		assert.Equal(t, "u@hostB", got[0].Host) // B untouched
	})

	t.Run("accepts JSONC with comments", func(t *testing.T) {
		path := withConfigDir(t)
		seedConfig(t, path, `{
  // user note
  "openTabs": [{"path":"/x","mode":"local"}]
}`)
		got := ReadPersistedTabs()
		require.Len(t, got, 1)
		assert.Equal(t, "/x", got[0].Path)
	})
}
