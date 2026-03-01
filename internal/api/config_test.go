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

	// File exists and is valid JSON
	data, err := os.ReadFile(path)
	require.NoError(t, err)
	var got map[string]any
	require.NoError(t, json.Unmarshal(data, &got))
	assert.Equal(t, "light", got["theme"])
	assert.Equal(t, true, got["splitView"])

	// GET returns what was written
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
	require.NoError(t, os.MkdirAll(filepath.Dir(path), 0o755))
	require.NoError(t, os.WriteFile(path, []byte(`{"theme":"dark","futureKey":42}`), 0o644))

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
	// Corrupt existing file → merge treats it as empty, but write still
	// succeeds (atomic rename replaces the corrupt file).
	path := withConfigDir(t)
	require.NoError(t, os.MkdirAll(filepath.Dir(path), 0o755))
	require.NoError(t, os.WriteFile(path, []byte(`{not valid json`), 0o644))

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
	assert.Equal(t, "light", got["theme"])

	// No temp files left behind
	entries, err := os.ReadDir(filepath.Dir(path))
	require.NoError(t, err)
	assert.Len(t, entries, 1)
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
