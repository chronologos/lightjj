package api

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync"
	"testing"

	"github.com/chronologos/lightjj/internal/jj"
	"github.com/chronologos/lightjj/testutil"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// countingRunner counts `jj file list` invocations (MockRunner expectations
// match any number of times, so "the cache served it" needs a counter) and
// can hold them on a gate to force concurrent requests to overlap.
type countingRunner struct {
	*testutil.MockRunner
	mu    sync.Mutex
	lists int
	gate  chan struct{}
}

func (c *countingRunner) ReadBytes(ctx context.Context, args []string) ([]byte, error) {
	if args[0] == "file" && args[1] == "list" {
		c.mu.Lock()
		c.lists++
		c.mu.Unlock()
		if c.gate != nil {
			<-c.gate
		}
	}
	return c.MockRunner.ReadBytes(ctx, args)
}

func (c *countingRunner) count() int {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.lists
}

const treeCommit = "abc123def456"

var treeListing = strings.Join([]string{
	`{"path":"README.md","type":"file","executable":false}`,
	`{"path":"cmd/main.go","type":"file","executable":false}`,
	`{"path":"internal/api/server.go","type":"file","executable":false}`,
	`{"path":"internal/jj/commands.go","type":"file","executable":false}`,
	`{"path":"link","type":"symlink","executable":false}`,
	`{"path":"scripts/build.sh","type":"file","executable":true}`,
	`{"path":"zeta.txt","type":"file","executable":false}`,
}, "\n") + "\n"

func newTreeServer(t *testing.T) (*Server, *countingRunner) {
	m := testutil.NewMockRunner(t)
	srv := newTestServer(m) // jj 0.39 → JSON + commit_id() paths
	cr := &countingRunner{MockRunner: m}
	srv.Runner = cr
	return srv, cr
}

func getTree(srv *Server, path string, params url.Values) *httptest.ResponseRecorder {
	req := httptest.NewRequest("GET", path+"?"+params.Encode(), nil)
	w := httptest.NewRecorder()
	srv.Mux.ServeHTTP(w, req)
	return w
}

func decodeTree(t *testing.T, w *httptest.ResponseRecorder) fileTreeResponse {
	t.Helper()
	require.Equal(t, http.StatusOK, w.Code, w.Body.String())
	var resp fileTreeResponse
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &resp))
	return resp
}

func TestFileTree_Validation(t *testing.T) {
	srv, _ := newTreeServer(t)
	for _, tc := range []struct {
		path   string
		params url.Values
	}{
		{"/api/file-tree", url.Values{}},
		{"/api/file-tree", url.Values{"revision": {treeCommit}, "dir": {"../etc"}}},
		{"/api/file-tree", url.Values{"revision": {treeCommit}, "dir": {"a/../../x"}}},
		{"/api/file-tree", url.Values{"revision": {treeCommit}, "dir": {"a\x00b"}}},
		{"/api/file-tree/search", url.Values{"revision": {treeCommit}}},
		{"/api/file-tree/search", url.Values{"revision": {treeCommit}, "q": {"   "}}},
		{"/api/file-tree/search", url.Values{"q": {"x"}}},
		{"/api/file-tree/search", url.Values{"revision": {treeCommit}, "q": {"x"}, "limit": {"0"}}},
		{"/api/file-tree/search", url.Values{"revision": {treeCommit}, "q": {"x"}, "limit": {"abc"}}},
	} {
		w := getTree(srv, tc.path, tc.params)
		assert.Equal(t, http.StatusBadRequest, w.Code, "%s %v", tc.path, tc.params)
	}
}

func TestFileTree_RootJSONPath(t *testing.T) {
	srv, cr := newTreeServer(t)
	cr.Expect(jj.FileListJSON(jj.CommitIdRevset(treeCommit))).SetOutput([]byte(treeListing))
	defer cr.Verify()

	resp := decodeTree(t, getTree(srv, "/api/file-tree", url.Values{"revision": {treeCommit}}))
	assert.Equal(t, treeCommit, resp.CommitId)
	assert.Equal(t, "", resp.Dir)
	assert.Equal(t, 7, resp.TotalFiles)
	assert.False(t, resp.Truncated)
	// Directories first (with recursive file counts), then files; both by name.
	assert.Equal(t, []treeChild{
		{Name: "cmd", Path: "cmd", Type: "dir", Files: 1},
		{Name: "internal", Path: "internal", Type: "dir", Files: 2},
		{Name: "scripts", Path: "scripts", Type: "dir", Files: 1},
		{Name: "link", Path: "link", Type: "symlink"},
		{Name: "README.md", Path: "README.md", Type: "file"},
		{Name: "zeta.txt", Path: "zeta.txt", Type: "file"},
	}, resp.Entries)
}

func TestFileTree_SubdirAnd404(t *testing.T) {
	srv, cr := newTreeServer(t)
	cr.Expect(jj.FileListJSON(jj.CommitIdRevset(treeCommit))).SetOutput([]byte(treeListing))

	resp := decodeTree(t, getTree(srv, "/api/file-tree", url.Values{"revision": {treeCommit}, "dir": {"internal/"}}))
	assert.Equal(t, "internal", resp.Dir)
	assert.Equal(t, []treeChild{
		{Name: "api", Path: "internal/api", Type: "dir", Files: 1},
		{Name: "jj", Path: "internal/jj", Type: "dir", Files: 1},
	}, resp.Entries)

	resp = decodeTree(t, getTree(srv, "/api/file-tree", url.Values{"revision": {treeCommit}, "dir": {"scripts"}}))
	assert.Equal(t, []treeChild{{Name: "build.sh", Path: "scripts/build.sh", Type: "file", Executable: true}}, resp.Entries)

	// Not a directory: missing, or a FILE path.
	assert.Equal(t, http.StatusNotFound, getTree(srv, "/api/file-tree", url.Values{"revision": {treeCommit}, "dir": {"nope"}}).Code)
	assert.Equal(t, http.StatusNotFound, getTree(srv, "/api/file-tree", url.Values{"revision": {treeCommit}, "dir": {"README.md"}}).Code)
	// All of the above served from ONE listing.
	assert.Equal(t, 1, cr.count())
}

func TestFileTree_FallbackPreJSON(t *testing.T) {
	srv, cr := newTreeServer(t)
	withJJ(srv, jj.Semver{0, 30}) // below JSONTemplates AND CommitIdRevsetFn
	cr.Expect(jj.FileList(treeCommit)).SetOutput([]byte("a/b.go\nlink\n"))
	defer cr.Verify()

	resp := decodeTree(t, getTree(srv, "/api/file-tree", url.Values{"revision": {treeCommit}}))
	assert.Equal(t, []treeChild{
		{Name: "a", Path: "a", Type: "dir", Files: 1},
		{Name: "link", Path: "link", Type: "file"}, // type unknowable on the fallback
	}, resp.Entries)
}

func TestFileTree_CacheHitDoesNotRerun(t *testing.T) {
	srv, cr := newTreeServer(t)
	cr.Expect(jj.FileListJSON(jj.CommitIdRevset(treeCommit))).SetOutput([]byte(treeListing))
	for range 3 {
		decodeTree(t, getTree(srv, "/api/file-tree", url.Values{"revision": {treeCommit}}))
	}
	w := getTree(srv, "/api/file-tree/search", url.Values{"revision": {treeCommit}, "q": {"main"}})
	require.Equal(t, http.StatusOK, w.Code)
	assert.Equal(t, 1, cr.count())
}

func TestFileTree_ConcurrentRequestsShareOneRun(t *testing.T) {
	srv, cr := newTreeServer(t)
	cr.gate = make(chan struct{})
	cr.Expect(jj.FileListJSON(jj.CommitIdRevset(treeCommit))).SetOutput([]byte(treeListing))

	var wg sync.WaitGroup
	codes := make([]int, 4)
	for i := range codes {
		wg.Add(1)
		go func() {
			defer wg.Done()
			codes[i] = getTree(srv, "/api/file-tree", url.Values{"revision": {treeCommit}}).Code
		}()
	}
	// Wait until the leader is inside jj, then release it.
	for cr.count() == 0 {
		// spin: the leader goroutine increments before blocking on the gate
	}
	close(cr.gate)
	wg.Wait()
	assert.Equal(t, []int{200, 200, 200, 200}, codes)
	assert.Equal(t, 1, cr.count())
}

func TestFileTree_ErrorNotCached(t *testing.T) {
	srv, cr := newTreeServer(t)
	e := cr.Expect(jj.FileListJSON(jj.CommitIdRevset(treeCommit))).SetError(errors.New("boom"))
	assert.Equal(t, http.StatusInternalServerError, getTree(srv, "/api/file-tree", url.Values{"revision": {treeCommit}}).Code)
	e.SetError(nil).SetOutput([]byte(treeListing))
	decodeTree(t, getTree(srv, "/api/file-tree", url.Values{"revision": {treeCommit}}))
	assert.Equal(t, 2, cr.count())
}

func TestFileTree_SymbolicRevisionResolvesFirst(t *testing.T) {
	srv, cr := newTreeServer(t)
	full := "abc123def4567890abc123def4567890abc123de"
	cr.Expect(jj.ResolveCommitId("@")).SetOutput([]byte(full))
	cr.Expect(jj.FileListJSON(jj.CommitIdRevset(full))).SetOutput([]byte(treeListing))
	defer cr.Verify()
	resp := decodeTree(t, getTree(srv, "/api/file-tree", url.Values{"revision": {"@"}}))
	assert.Equal(t, full, resp.CommitId)

	// Multi-commit revset → 400, not 500.
	cr.Expect(jj.ResolveCommitId("main|@")).SetOutput([]byte("aaaaaaaaaaaa\nbbbbbbbbbbbb"))
	assert.Equal(t, http.StatusBadRequest, getTree(srv, "/api/file-tree", url.Values{"revision": {"main|@"}}).Code)
}

func TestFileTree_EmptyRevision(t *testing.T) {
	srv, cr := newTreeServer(t)
	cr.Expect(jj.FileListJSON(jj.CommitIdRevset(treeCommit))).SetOutput([]byte(""))
	w := getTree(srv, "/api/file-tree", url.Values{"revision": {treeCommit}})
	require.Equal(t, http.StatusOK, w.Code)
	assert.Contains(t, w.Body.String(), `"entries":[]`) // [] not null
}

func TestFileTree_TruncationCap(t *testing.T) {
	old := fileTreeMaxFiles
	fileTreeMaxFiles = 3
	t.Cleanup(func() { fileTreeMaxFiles = old })

	srv, cr := newTreeServer(t)
	cr.Expect(jj.FileListJSON(jj.CommitIdRevset(treeCommit))).SetOutput([]byte(treeListing))
	resp := decodeTree(t, getTree(srv, "/api/file-tree", url.Values{"revision": {treeCommit}}))
	assert.True(t, resp.Truncated)
	assert.Equal(t, 3, resp.TotalFiles) // first 3 in jj's (sorted) order
	names := []string{}
	for _, e := range resp.Entries {
		names = append(names, e.Name)
	}
	assert.Equal(t, []string{"cmd", "internal", "README.md"}, names)
}

func TestFileTree_DirEntryCap(t *testing.T) {
	old := fileTreeMaxDirEntries
	fileTreeMaxDirEntries = 2
	t.Cleanup(func() { fileTreeMaxDirEntries = old })

	srv, cr := newTreeServer(t)
	cr.Expect(jj.FileListJSON(jj.CommitIdRevset(treeCommit))).SetOutput([]byte(treeListing))
	resp := decodeTree(t, getTree(srv, "/api/file-tree", url.Values{"revision": {treeCommit}}))
	assert.Len(t, resp.Entries, 2)
	assert.Equal(t, 4, resp.Omitted)
}

func TestFileTreeSearch(t *testing.T) {
	srv, cr := newTreeServer(t)
	cr.Expect(jj.FileListJSON(jj.CommitIdRevset(treeCommit))).SetOutput([]byte(treeListing))
	w := getTree(srv, "/api/file-tree/search", url.Values{"revision": {treeCommit}, "q": {"s"}, "limit": {"2"}})
	require.Equal(t, http.StatusOK, w.Code, w.Body.String())
	var resp fileTreeSearchResponse
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &resp))
	assert.Equal(t, 2, len(resp.Matches))
	assert.Greater(t, resp.Total, 2) // total counts beyond the limit
}

func TestFileTreeIndexSearchRanking(t *testing.T) {
	tree := buildFileTree([]jj.TreeFile{
		{Path: "docs/server-notes.md", Type: "file"},
		{Path: "internal/api/server.go", Type: "file"},
		{Path: "internal/api/server_test.go", Type: "file"},
		{Path: "server/main.go", Type: "file"},
		{Path: "src/ServerBadge.svelte", Type: "file"},
		{Path: "s/e/r/v/e/r.txt", Type: "file"},
		{Path: "unrelated.go", Type: "file"},
		{Path: "lib/myserver.ts", Type: "file"},
	}, false)

	paths := func(ms []fileTreeMatch) []string {
		out := []string{}
		for _, m := range ms {
			out = append(out, m.Path)
		}
		return out
	}
	ms, total := tree.search("server", 10)
	assert.Equal(t, 7, total)
	assert.Equal(t, []string{
		// tier 4 — basename prefix (case-insensitive); shorter path first, then bytes
		"docs/server-notes.md",
		"internal/api/server.go",
		"src/ServerBadge.svelte",
		"internal/api/server_test.go",
		// tier 3 — basename substring
		"lib/myserver.ts",
		// tier 2 — path substring only
		"server/main.go",
		// tier 1 — subsequence only
		"s/e/r/v/e/r.txt",
	}, paths(ms))

	ms, total = tree.search("server", 2)
	assert.Equal(t, 7, total) // total is pre-limit
	assert.Len(t, ms, 2)

	// Multi-term: all must match.
	ms, total = tree.search("api test", 10)
	assert.Equal(t, 1, total)
	assert.Equal(t, []string{"internal/api/server_test.go"}, paths(ms))

	ms, total = tree.search("zzz", 10)
	assert.Equal(t, 0, total)
	assert.NotNil(t, ms)
}

func TestFileTreeCacheLRU(t *testing.T) {
	c := newFileTreeCache()
	c.maxEntries = 2
	c.maxFiles = 5
	mk := func(n int) *fileTree {
		files := make([]jj.TreeFile, n)
		for i := range files {
			files[i] = jj.TreeFile{Path: fmt.Sprintf("f%d", i), Type: "file"}
		}
		return buildFileTree(files, false)
	}
	loads := 0
	get := func(key string, n int) {
		_, err := c.get(t.Context(), key, func(context.Context) (*fileTree, error) { loads++; return mk(n), nil })
		require.NoError(t, err)
	}
	keys := func() []string {
		out := []string{}
		for _, e := range c.entries {
			out = append(out, e.key)
		}
		return out
	}

	get("a", 1)
	get("b", 1)
	get("a", 1) // hit → bumps a to newest
	assert.Equal(t, 2, loads)
	assert.Equal(t, []string{"b", "a"}, keys())
	get("c", 1) // entry-count eviction drops the LRU (b), not a
	assert.Equal(t, []string{"a", "c"}, keys())
	get("d", 4) // file-budget eviction: 1+1+4 > 5 → drop a; c+d = 5 fits
	assert.Equal(t, []string{"c", "d"}, keys())
	get("e", 50) // alone over budget → still kept (newest always survives)
	assert.Equal(t, []string{"e"}, keys())
	assert.Equal(t, 5, loads)
}

func TestCleanTreeDir(t *testing.T) {
	for in, want := range map[string]string{"": "", ".": "", "/": "", "a/": "a", "/a/b/": "a/b", "a//b": "a/b", "a/./b": "a/b"} {
		got, err := cleanTreeDir(in)
		require.NoError(t, err, in)
		assert.Equal(t, want, got, in)
	}
	for _, bad := range []string{"..", "../x", "a/../../x", "a\x00"} {
		_, err := cleanTreeDir(bad)
		assert.Error(t, err, bad)
	}
}
