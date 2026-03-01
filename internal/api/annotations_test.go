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

func newAnnotationsServer(t *testing.T) *Server {
	t.Helper()
	withConfigDir(t)
	runner := testutil.NewMockRunner(t)
	t.Cleanup(func() { runner.Verify() })
	return NewServer(runner, "")
}

func TestAnnotations_GetEmpty(t *testing.T) {
	srv := newAnnotationsServer(t)
	w := httptest.NewRecorder()
	srv.Mux.ServeHTTP(w, httptest.NewRequest("GET", "/api/annotations?changeId=abc", nil))
	assert.Equal(t, http.StatusOK, w.Code)
	var anns []Annotation
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &anns))
	assert.Empty(t, anns)
	assert.NotNil(t, anns) // [] not null
}

func TestAnnotations_CRUD(t *testing.T) {
	srv := newAnnotationsServer(t)

	// Create
	ann := Annotation{ID: "a1", ChangeId: "abc", FilePath: "foo.go", LineNum: 42, Comment: "fix this"}
	body, _ := json.Marshal(ann)
	w := httptest.NewRecorder()
	srv.Mux.ServeHTTP(w, jsonPost("/api/annotations", body))
	require.Equal(t, http.StatusOK, w.Code)

	// Read
	w = httptest.NewRecorder()
	srv.Mux.ServeHTTP(w, httptest.NewRequest("GET", "/api/annotations?changeId=abc", nil))
	var anns []Annotation
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &anns))
	require.Len(t, anns, 1)
	assert.Equal(t, "fix this", anns[0].Comment)

	// Update (upsert — same ID)
	ann.Comment = "fixed it"
	body, _ = json.Marshal(ann)
	w = httptest.NewRecorder()
	srv.Mux.ServeHTTP(w, jsonPost("/api/annotations", body))
	require.Equal(t, http.StatusOK, w.Code)

	w = httptest.NewRecorder()
	srv.Mux.ServeHTTP(w, httptest.NewRequest("GET", "/api/annotations?changeId=abc", nil))
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &anns))
	require.Len(t, anns, 1) // still one
	assert.Equal(t, "fixed it", anns[0].Comment)

	// Delete
	w = httptest.NewRecorder()
	srv.Mux.ServeHTTP(w, httptest.NewRequest("DELETE", "/api/annotations?changeId=abc&id=a1", nil))
	require.Equal(t, http.StatusOK, w.Code)

	w = httptest.NewRecorder()
	srv.Mux.ServeHTTP(w, httptest.NewRequest("GET", "/api/annotations?changeId=abc", nil))
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &anns))
	assert.Empty(t, anns)
}

func TestAnnotations_MultipleIndependentChangeIds(t *testing.T) {
	srv := newAnnotationsServer(t)

	for _, cid := range []string{"abc", "xyz"} {
		ann := Annotation{ID: "a1", ChangeId: cid, FilePath: "foo.go", LineNum: 1, Comment: cid + "-comment"}
		body, _ := json.Marshal(ann)
		w := httptest.NewRecorder()
		srv.Mux.ServeHTTP(w, jsonPost("/api/annotations", body))
		require.Equal(t, http.StatusOK, w.Code)
	}

	w := httptest.NewRecorder()
	srv.Mux.ServeHTTP(w, httptest.NewRequest("GET", "/api/annotations?changeId=abc", nil))
	var anns []Annotation
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &anns))
	require.Len(t, anns, 1)
	assert.Equal(t, "abc-comment", anns[0].Comment)
}

func TestAnnotations_DeleteClearAll(t *testing.T) {
	srv := newAnnotationsServer(t)

	for i, id := range []string{"a1", "a2", "a3"} {
		ann := Annotation{ID: id, ChangeId: "abc", FilePath: "foo.go", LineNum: i, Comment: "x"}
		body, _ := json.Marshal(ann)
		w := httptest.NewRecorder()
		srv.Mux.ServeHTTP(w, jsonPost("/api/annotations", body))
		require.Equal(t, http.StatusOK, w.Code)
	}

	// Delete without id → clear all
	w := httptest.NewRecorder()
	srv.Mux.ServeHTTP(w, httptest.NewRequest("DELETE", "/api/annotations?changeId=abc", nil))
	require.Equal(t, http.StatusOK, w.Code)

	// File removed (not an empty-array file)
	path, _ := annotationsPath("abc")
	_, err := os.Stat(path)
	assert.True(t, os.IsNotExist(err))

	w = httptest.NewRecorder()
	srv.Mux.ServeHTTP(w, httptest.NewRequest("GET", "/api/annotations?changeId=abc", nil))
	var anns []Annotation
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &anns))
	assert.Empty(t, anns)
}

func TestAnnotations_DeleteLastRemovesFile(t *testing.T) {
	srv := newAnnotationsServer(t)

	ann := Annotation{ID: "a1", ChangeId: "abc", FilePath: "foo.go", LineNum: 1, Comment: "x"}
	body, _ := json.Marshal(ann)
	w := httptest.NewRecorder()
	srv.Mux.ServeHTTP(w, jsonPost("/api/annotations", body))
	require.Equal(t, http.StatusOK, w.Code)

	w = httptest.NewRecorder()
	srv.Mux.ServeHTTP(w, httptest.NewRequest("DELETE", "/api/annotations?changeId=abc&id=a1", nil))
	require.Equal(t, http.StatusOK, w.Code)

	path, _ := annotationsPath("abc")
	_, err := os.Stat(path)
	assert.True(t, os.IsNotExist(err), "file should be removed when last annotation deleted")
}

func TestAnnotations_Validation(t *testing.T) {
	srv := newAnnotationsServer(t)

	tests := []struct {
		name string
		req  *http.Request
	}{
		{"get missing changeId", httptest.NewRequest("GET", "/api/annotations", nil)},
		{"get invalid changeId", httptest.NewRequest("GET", "/api/annotations?changeId=../etc/passwd", nil)},
		{"delete missing changeId", httptest.NewRequest("DELETE", "/api/annotations", nil)},
		{"delete traversal", httptest.NewRequest("DELETE", "/api/annotations?changeId=..%2F..%2Fetc", nil)},
		{"post missing id", jsonPost("/api/annotations", []byte(`{"changeId":"abc","comment":"x"}`))},
		{"post missing changeId", jsonPost("/api/annotations", []byte(`{"id":"a1","comment":"x"}`))},
		{"post traversal changeId", jsonPost("/api/annotations", []byte(`{"id":"a1","changeId":"../x","comment":"x"}`))},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			w := httptest.NewRecorder()
			srv.Mux.ServeHTTP(w, tc.req)
			assert.Equal(t, http.StatusBadRequest, w.Code)
		})
	}
}

func TestAnnotationsPath_CharsetBoundary(t *testing.T) {
	// jj change_ids are lowercase alphanumeric (z-base32 without padding).
	// commit_ids (hex) should also work — they're [0-9a-f].
	// Regex should accept both, reject everything else.
	valid := []string{
		"abc", "xyz123", "zzzzzzzzzzzz",     // change_id style
		"deadbeef", "0123456789abcdef",      // commit_id style
		"a",                                  // min length
		"a123456789012345678901234567890123456789012345678901234567890123", // 64 chars (max)
	}
	for _, id := range valid {
		t.Run("valid/"+id, func(t *testing.T) {
			p, err := annotationsPath(id)
			require.NoError(t, err)
			assert.Contains(t, p, id+".json")
			// No directory separators in the filename component
			assert.NotContains(t, filepath.Base(p), "/")
			assert.NotContains(t, filepath.Base(p), "\\")
		})
	}

	invalid := []string{
		"",                       // empty
		"ABC",                    // uppercase
		"abc-def",                // hyphen
		"abc.json",               // extension embedded
		"../etc/passwd",          // traversal
		"abc/def",                // separator
		"abc\x00def",             // null byte
		"abc def",                // space
		"a123456789012345678901234567890123456789012345678901234567890123x", // 65 chars
	}
	for _, id := range invalid {
		t.Run("invalid/"+id, func(t *testing.T) {
			_, err := annotationsPath(id)
			assert.Error(t, err)
		})
	}
}

func TestAnnotations_CorruptFileRecovers(t *testing.T) {
	srv := newAnnotationsServer(t)
	path, _ := annotationsPath("abc")
	require.NoError(t, os.MkdirAll(filepath.Dir(path), 0o755))
	require.NoError(t, os.WriteFile(path, []byte(`{not json`), 0o644))

	// GET returns empty (not an error)
	w := httptest.NewRecorder()
	srv.Mux.ServeHTTP(w, httptest.NewRequest("GET", "/api/annotations?changeId=abc", nil))
	assert.Equal(t, http.StatusOK, w.Code)
	var anns []Annotation
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &anns))
	assert.Empty(t, anns)

	// POST replaces the corrupt file
	ann := Annotation{ID: "a1", ChangeId: "abc", FilePath: "foo.go", LineNum: 1, Comment: "x"}
	body, _ := json.Marshal(ann)
	w = httptest.NewRecorder()
	srv.Mux.ServeHTTP(w, jsonPost("/api/annotations", body))
	require.Equal(t, http.StatusOK, w.Code)

	data, err := os.ReadFile(path)
	require.NoError(t, err)
	require.NoError(t, json.Unmarshal(data, &anns))
	assert.Len(t, anns, 1)
}
