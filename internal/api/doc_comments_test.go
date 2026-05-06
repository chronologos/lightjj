package api

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"testing"

	"github.com/chronologos/lightjj/testutil"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func newDocCommentServer(t *testing.T) *Server {
	t.Helper()
	withConfigDir(t)
	runner := testutil.NewMockRunner(t)
	t.Cleanup(func() { runner.Verify() })
	srv := NewServer(runner, "")
	srv.RepoPath = "/repo"
	return srv
}

func getDocComments(t *testing.T, srv *Server, fp string) []DocComment {
	t.Helper()
	w := httptest.NewRecorder()
	srv.Mux.ServeHTTP(w, httptest.NewRequest("GET", "/api/doc-comments?path="+url.QueryEscape(fp), nil))
	require.Equal(t, http.StatusOK, w.Code)
	var got []DocComment
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &got))
	return got
}

func TestDocComments_CRUD(t *testing.T) {
	srv := newDocCommentServer(t)
	const fp = "docs/design.md"

	// Empty initially → [] not null
	got := getDocComments(t, srv, fp)
	assert.NotNil(t, got)
	assert.Len(t, got, 0)

	// POST upsert
	c := DocComment{
		ID: "c1", FilePath: fp, Kind: "comment", Body: "hello",
		Anchor: DocAnchor{Selection: "foo", ContextBefore: "a", ContextAfter: "b"},
		Author: "user", CreatedAt: 1,
	}
	body, _ := json.Marshal(c)
	w := httptest.NewRecorder()
	srv.Mux.ServeHTTP(w, jsonPost("/api/doc-comments", body))
	require.Equal(t, http.StatusOK, w.Code)

	got = getDocComments(t, srv, fp)
	require.Len(t, got, 1)
	assert.Equal(t, c, got[0])

	// Upsert (same id, new body)
	c.Body = "edited"
	body, _ = json.Marshal(c)
	w = httptest.NewRecorder()
	srv.Mux.ServeHTTP(w, jsonPost("/api/doc-comments", body))
	require.Equal(t, http.StatusOK, w.Code)
	got = getDocComments(t, srv, fp)
	require.Len(t, got, 1)
	assert.Equal(t, "edited", got[0].Body)

	// Second comment
	c2 := DocComment{ID: "c2", FilePath: fp, Kind: "comment", Body: "second", Author: "user"}
	body, _ = json.Marshal(c2)
	w = httptest.NewRecorder()
	srv.Mux.ServeHTTP(w, jsonPost("/api/doc-comments", body))
	require.Equal(t, http.StatusOK, w.Code)
	assert.Len(t, getDocComments(t, srv, fp), 2)

	// DELETE one
	w = httptest.NewRecorder()
	srv.Mux.ServeHTTP(w, httptest.NewRequest("DELETE", "/api/doc-comments?path="+url.QueryEscape(fp)+"&id=c1", nil))
	require.Equal(t, http.StatusOK, w.Code)
	got = getDocComments(t, srv, fp)
	require.Len(t, got, 1)
	assert.Equal(t, "c2", got[0].ID)

	// DELETE all (omit id)
	w = httptest.NewRecorder()
	srv.Mux.ServeHTTP(w, httptest.NewRequest("DELETE", "/api/doc-comments?path="+url.QueryEscape(fp), nil))
	require.Equal(t, http.StatusOK, w.Code)
	assert.Len(t, getDocComments(t, srv, fp), 0)
}

func TestDocComments_PathIsolation(t *testing.T) {
	srv := newDocCommentServer(t)
	for _, c := range []DocComment{
		{ID: "a", FilePath: "one.md", Kind: "comment", Author: "u"},
		{ID: "b", FilePath: "two.md", Kind: "comment", Author: "u"},
	} {
		body, _ := json.Marshal(c)
		w := httptest.NewRecorder()
		srv.Mux.ServeHTTP(w, jsonPost("/api/doc-comments", body))
		require.Equal(t, http.StatusOK, w.Code)
	}
	assert.Len(t, getDocComments(t, srv, "one.md"), 1)
	assert.Len(t, getDocComments(t, srv, "two.md"), 1)
}

func TestDocComments_Validation(t *testing.T) {
	srv := newDocCommentServer(t)
	for _, tc := range []struct {
		name string
		req  *http.Request
	}{
		{"get missing path", httptest.NewRequest("GET", "/api/doc-comments", nil)},
		{"delete missing path", httptest.NewRequest("DELETE", "/api/doc-comments", nil)},
		{"post missing filePath", jsonPost("/api/doc-comments", []byte(`{"id":"x"}`))},
		{"post missing id", jsonPost("/api/doc-comments", []byte(`{"filePath":"a.md"}`))},
	} {
		t.Run(tc.name, func(t *testing.T) {
			w := httptest.NewRecorder()
			srv.Mux.ServeHTTP(w, tc.req)
			assert.Equal(t, http.StatusBadRequest, w.Code)
		})
	}
}
