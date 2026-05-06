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
	c2 := DocComment{ID: "c2", FilePath: fp, Kind: "comment", Body: "second", Author: "user", Anchor: DocAnchor{Selection: "x"}}
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

	// DELETE without id is rejected (no clear-all footgun)
	w = httptest.NewRecorder()
	srv.Mux.ServeHTTP(w, httptest.NewRequest("DELETE", "/api/doc-comments?path="+url.QueryEscape(fp), nil))
	require.Equal(t, http.StatusBadRequest, w.Code)
	assert.Len(t, getDocComments(t, srv, fp), 1)
}

func TestDocComments_PathIsolation(t *testing.T) {
	srv := newDocCommentServer(t)
	for _, c := range []DocComment{
		{ID: "a", FilePath: "one.md", Kind: "comment", Author: "u", Anchor: DocAnchor{Selection: "x"}},
		{ID: "b", FilePath: "two.md", Kind: "comment", Author: "u", Anchor: DocAnchor{Selection: "x"}},
	} {
		body, _ := json.Marshal(c)
		w := httptest.NewRecorder()
		srv.Mux.ServeHTTP(w, jsonPost("/api/doc-comments", body))
		require.Equal(t, http.StatusOK, w.Code)
	}
	assert.Len(t, getDocComments(t, srv, "one.md"), 1)
	assert.Len(t, getDocComments(t, srv, "two.md"), 1)
}

func TestDocComments_PathNormalization(t *testing.T) {
	srv := newDocCommentServer(t)
	c := DocComment{ID: "n1", FilePath: "./docs/X.md", Kind: "comment", Author: "agent", Anchor: DocAnchor{Selection: "x"}}
	body, _ := json.Marshal(c)
	w := httptest.NewRecorder()
	srv.Mux.ServeHTTP(w, jsonPost("/api/doc-comments", body))
	require.Equal(t, http.StatusOK, w.Code)

	// All variants resolve to the same store and the stored record carries the
	// canonical path.
	for _, variant := range []string{"docs/X.md", "./docs/X.md", "docs/./X.md"} {
		got := getDocComments(t, srv, variant)
		require.Len(t, got, 1, "variant %q", variant)
		assert.Equal(t, "docs/X.md", got[0].FilePath)
	}
}

func TestDocComments_PreserveResolution(t *testing.T) {
	srv := newDocCommentServer(t)
	const fp = "doc.md"

	a := DocAnchor{Selection: "x"}
	first := DocComment{ID: "r1", FilePath: fp, Kind: "comment", Body: "v1", Resolution: "addressed", ResolvedAt: 99, Anchor: a}
	body, _ := json.Marshal(first)
	w := httptest.NewRecorder()
	srv.Mux.ServeHTTP(w, jsonPost("/api/doc-comments", body))
	require.Equal(t, http.StatusOK, w.Code)

	// Agent re-POSTs same id with new body, omits resolution.
	second := DocComment{ID: "r1", FilePath: fp, Kind: "comment", Body: "v2", Anchor: a}
	body, _ = json.Marshal(second)
	w = httptest.NewRecorder()
	srv.Mux.ServeHTTP(w, jsonPost("/api/doc-comments", body))
	require.Equal(t, http.StatusOK, w.Code)

	got := getDocComments(t, srv, fp)
	require.Len(t, got, 1)
	assert.Equal(t, "v2", got[0].Body)
	assert.Equal(t, "addressed", got[0].Resolution)
	assert.Equal(t, int64(99), got[0].ResolvedAt)
}

func TestDocComments_ServerStamps(t *testing.T) {
	srv := newDocCommentServer(t)
	c := DocComment{FilePath: "doc.md", Kind: "comment", Body: "no id", Anchor: DocAnchor{Selection: "x"}}
	body, _ := json.Marshal(c)
	w := httptest.NewRecorder()
	srv.Mux.ServeHTTP(w, jsonPost("/api/doc-comments", body))
	require.Equal(t, http.StatusOK, w.Code)

	var echoed DocComment
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &echoed))
	assert.Len(t, echoed.ID, 16)
	assert.Greater(t, echoed.CreatedAt, int64(0))

	got := getDocComments(t, srv, "doc.md")
	require.Len(t, got, 1)
	assert.Equal(t, echoed.ID, got[0].ID)
}

func TestDocComments_Validation(t *testing.T) {
	srv := newDocCommentServer(t)
	for _, tc := range []struct {
		name string
		req  *http.Request
	}{
		{"get missing path", httptest.NewRequest("GET", "/api/doc-comments", nil)},
		{"delete missing path", httptest.NewRequest("DELETE", "/api/doc-comments", nil)},
		{"delete missing id", httptest.NewRequest("DELETE", "/api/doc-comments?path=a.md", nil)},
		{"post missing filePath", jsonPost("/api/doc-comments", []byte(`{"id":"x"}`))},
		{"post path escapes", jsonPost("/api/doc-comments", []byte(`{"id":"x","filePath":"../etc/passwd"}`))},
		{"post absolute path", jsonPost("/api/doc-comments", []byte(`{"id":"x","filePath":"/etc/passwd"}`))},
	} {
		t.Run(tc.name, func(t *testing.T) {
			w := httptest.NewRecorder()
			srv.Mux.ServeHTTP(w, tc.req)
			assert.Equal(t, http.StatusBadRequest, w.Code)
		})
	}
}
