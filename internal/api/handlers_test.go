package api

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/chronologos/lightjj/internal/jj"
	"github.com/chronologos/lightjj/internal/parser"
	"github.com/chronologos/lightjj/testutil"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// newTestServer creates a Server with the op-id command pre-allowed on the mock.
func newTestServer(runner *testutil.MockRunner) *Server {
	runner.Allow(jj.CurrentOpId()).SetOutput([]byte("abc123"))
	return NewServer(runner, "")
}

// jsonPost creates a POST request with Content-Type: application/json.
func jsonPost(url string, body []byte) *http.Request {
	req := httptest.NewRequest("POST", url, bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	return req
}

func TestOpIdHeader(t *testing.T) {
	runner := testutil.NewMockRunner(t)
	runner.Expect(jj.LogGraph("", 500)).SetOutput([]byte(""))
	defer runner.Verify()

	srv := newTestServer(runner)
	req := httptest.NewRequest("GET", "/api/log", nil)
	w := httptest.NewRecorder()
	srv.Mux.ServeHTTP(w, req)

	assert.Equal(t, http.StatusOK, w.Code)
	assert.Equal(t, "abc123", w.Header().Get("X-JJ-Op-Id"))
}

func TestHandleLog(t *testing.T) {
	runner := testutil.NewMockRunner(t)
	graphOutput := "@  _PREFIX:abc_PREFIX:xyz_PREFIX:false\x1fabcdefgh\x1fxyz12345\x1fmy commit\x1f\x1f\x1fmain\n"
	runner.Expect(jj.LogGraph("@", 500)).SetOutput([]byte(graphOutput))
	defer runner.Verify()

	srv := newTestServer(runner)
	req := httptest.NewRequest("GET", "/api/log?revset=@", nil)
	w := httptest.NewRecorder()
	srv.Mux.ServeHTTP(w, req)

	assert.Equal(t, http.StatusOK, w.Code)
	var rows []parser.GraphRow
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &rows))
	assert.Len(t, rows, 1)
	assert.Equal(t, "abcdefgh", rows[0].Commit.ChangeId)
	assert.Equal(t, "xyz12345", rows[0].Commit.CommitId)
	assert.Equal(t, 3, rows[0].Commit.ChangePrefix)
	assert.Equal(t, 3, rows[0].Commit.CommitPrefix)
	assert.True(t, rows[0].Commit.IsWorkingCopy)
	assert.Equal(t, "my commit", rows[0].Description)
	assert.Equal(t, []string{"main"}, rows[0].Bookmarks)
}

func TestHandleLog_Empty(t *testing.T) {
	runner := testutil.NewMockRunner(t)
	runner.Expect(jj.LogGraph("", 500)).SetOutput([]byte(""))
	defer runner.Verify()

	srv := newTestServer(runner)
	req := httptest.NewRequest("GET", "/api/log", nil)
	w := httptest.NewRecorder()
	srv.Mux.ServeHTTP(w, req)

	assert.Equal(t, http.StatusOK, w.Code)
}

func TestHandleBookmarks(t *testing.T) {
	runner := testutil.NewMockRunner(t)
	runner.Expect(jj.BookmarkListAll()).SetOutput([]byte("main\x1f.\x1ffalse\x1ffalse\x1fabc\x1fabc\x1f0\x1f0\x1ftrue\x1fdesc\x1f2 days ago"))
	defer runner.Verify()

	srv := newTestServer(runner)
	req := httptest.NewRequest("GET", "/api/bookmarks", nil)
	w := httptest.NewRecorder()
	srv.Mux.ServeHTTP(w, req)

	assert.Equal(t, http.StatusOK, w.Code)
	var bookmarks []jj.Bookmark
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &bookmarks))
	assert.Len(t, bookmarks, 1)
	assert.Equal(t, "main", bookmarks[0].Name)
}

func TestHandleDiff(t *testing.T) {
	runner := testutil.NewMockRunner(t)
	runner.Expect(jj.Diff("abc", "", "never", "--tool", ":git")).SetOutput([]byte("+added line"))
	defer runner.Verify()

	srv := newTestServer(runner)
	req := httptest.NewRequest("GET", "/api/diff?revision=abc", nil)
	w := httptest.NewRecorder()
	srv.Mux.ServeHTTP(w, req)

	assert.Equal(t, http.StatusOK, w.Code)
	var resp map[string]string
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &resp))
	assert.Contains(t, resp["diff"], "+added line")
}

func TestHandleRevision_CacheControl(t *testing.T) {
	runner := testutil.NewMockRunner(t)
	runner.Allow(jj.FilesTemplate("abc")).SetOutput([]byte(""))
	runner.Allow(jj.Diff("abc", "", "never", "--tool", ":git")).SetOutput([]byte("+x"))
	runner.Allow(jj.GetDescription("abc")).SetOutput([]byte("msg"))
	srv := newTestServer(runner)
	srv.cachedOp = "op123" // seed so we can assert suppression

	// Without ?immutable=1 → no-store (dynamic response), op-id header present
	w := httptest.NewRecorder()
	srv.Mux.ServeHTTP(w, httptest.NewRequest("GET", "/api/revision?revision=abc", nil))
	assert.Equal(t, "no-store", w.Header().Get("Cache-Control"))
	assert.Equal(t, "op123", w.Header().Get("X-JJ-Op-Id"))

	// With ?immutable=1 → forever-cacheable AND op-id suppressed (would be
	// baked into disk cache as a stale value, triggering spurious loadLog on reload)
	w = httptest.NewRecorder()
	srv.Mux.ServeHTTP(w, httptest.NewRequest("GET", "/api/revision?revision=abc&immutable=1", nil))
	assert.Equal(t, "max-age=31536000, immutable", w.Header().Get("Cache-Control"))
	assert.Empty(t, w.Header().Get("X-JJ-Op-Id"))
}

func TestHandleRevision_DegradedNotCached(t *testing.T) {
	// Transient GetDescription failure → degraded 200 response must NOT be
	// cached forever (would bake description:"" into browser disk cache).
	runner := testutil.NewMockRunner(t)
	runner.Allow(jj.FilesTemplate("abc")).SetOutput([]byte(""))
	runner.Allow(jj.Diff("abc", "", "never", "--tool", ":git")).SetOutput([]byte("+x"))
	runner.Allow(jj.GetDescription("abc")).SetError(fmt.Errorf("ssh blip"))
	srv := newTestServer(runner)

	w := httptest.NewRecorder()
	srv.Mux.ServeHTTP(w, httptest.NewRequest("GET", "/api/revision?revision=abc&immutable=1", nil))
	assert.Equal(t, http.StatusOK, w.Code)
	// Degraded response gets no-store (not forever-cacheable) — a transient
	// description failure must not be baked into browser disk cache.
	assert.Equal(t, "no-store", w.Header().Get("Cache-Control"))
}

func TestHandleDiff_MissingRevision(t *testing.T) {
	srv := newTestServer(testutil.NewMockRunner(t))
	req := httptest.NewRequest("GET", "/api/diff", nil)
	w := httptest.NewRecorder()
	srv.Mux.ServeHTTP(w, req)

	assert.Equal(t, http.StatusBadRequest, w.Code)
}

func TestHandleNew(t *testing.T) {
	runner := testutil.NewMockRunner(t)
	runner.Expect(jj.New(jj.NewSelectedRevisions(&jj.Commit{ChangeId: "abc"}))).SetOutput([]byte(""))
	defer runner.Verify()

	srv := newTestServer(runner)
	body, _ := json.Marshal(newRequest{Revisions: []string{"abc"}})
	req := jsonPost("/api/new", body)
	w := httptest.NewRecorder()
	srv.Mux.ServeHTTP(w, req)

	assert.Equal(t, http.StatusOK, w.Code)
}

func TestHandleAbandon(t *testing.T) {
	runner := testutil.NewMockRunner(t)
	revs := jj.NewSelectedRevisions(&jj.Commit{ChangeId: "abc"})
	runner.Expect(jj.Abandon(revs, false)).SetOutput([]byte(""))
	defer runner.Verify()

	srv := newTestServer(runner)
	body, _ := json.Marshal(abandonRequest{Revisions: []string{"abc"}})
	req := jsonPost("/api/abandon", body)
	w := httptest.NewRecorder()
	srv.Mux.ServeHTTP(w, req)

	assert.Equal(t, http.StatusOK, w.Code)
}

func TestHandleRestore(t *testing.T) {
	runner := testutil.NewMockRunner(t)
	runner.Expect(jj.Restore("abc", []string{"main.go"})).SetOutput([]byte(""))
	defer runner.Verify()

	srv := newTestServer(runner)
	body, _ := json.Marshal(restoreRequest{Revision: "abc", Files: []string{"main.go"}})
	req := jsonPost("/api/restore", body)
	w := httptest.NewRecorder()
	srv.Mux.ServeHTTP(w, req)

	assert.Equal(t, http.StatusOK, w.Code)
}

func TestHandleRestore_NoRevision(t *testing.T) {
	srv := newTestServer(testutil.NewMockRunner(t))
	body, _ := json.Marshal(restoreRequest{Files: []string{"main.go"}})
	req := jsonPost("/api/restore", body)
	w := httptest.NewRecorder()
	srv.Mux.ServeHTTP(w, req)

	assert.Equal(t, http.StatusBadRequest, w.Code)
}

func TestHandleRestore_NoFiles(t *testing.T) {
	// Empty files would run `jj restore -c X` → empties whole revision.
	// Handler must reject. [""] rejected too — `root-file:""` is a fileset
	// expression, not "no file".
	for _, files := range [][]string{nil, {""}, {"a.go", ""}} {
		srv := newTestServer(testutil.NewMockRunner(t))
		body, _ := json.Marshal(restoreRequest{Revision: "abc", Files: files})
		req := jsonPost("/api/restore", body)
		w := httptest.NewRecorder()
		srv.Mux.ServeHTTP(w, req)

		assert.Equal(t, http.StatusBadRequest, w.Code, "files=%v", files)
	}
}

func TestHandleDescribe(t *testing.T) {
	runner := testutil.NewMockRunner(t)
	args, _ := jj.SetDescription("abc", "new description")
	runner.Expect(args).SetOutput([]byte(""))
	defer runner.Verify()

	srv := newTestServer(runner)
	body, _ := json.Marshal(describeRequest{Revision: "abc", Description: "new description"})
	req := jsonPost("/api/describe", body)
	w := httptest.NewRecorder()
	srv.Mux.ServeHTTP(w, req)

	assert.Equal(t, http.StatusOK, w.Code)
}

func TestHandleRebase(t *testing.T) {
	runner := testutil.NewMockRunner(t)
	revs := jj.NewSelectedRevisions(&jj.Commit{ChangeId: "abc"})
	runner.Expect(jj.Rebase(revs, "def", "-r", "-d", false, false)).SetOutput([]byte(""))
	defer runner.Verify()

	srv := newTestServer(runner)
	body, _ := json.Marshal(rebaseRequest{Revisions: []string{"abc"}, Destination: "def"})
	req := jsonPost("/api/rebase", body)
	w := httptest.NewRecorder()
	srv.Mux.ServeHTTP(w, req)

	assert.Equal(t, http.StatusOK, w.Code)
}

func TestHandleSquash(t *testing.T) {
	runner := testutil.NewMockRunner(t)
	revs := jj.NewSelectedRevisions(&jj.Commit{ChangeId: "abc"})
	runner.Expect(jj.Squash(revs, "def", nil, false, false, false, false)).SetOutput([]byte(""))
	defer runner.Verify()

	srv := newTestServer(runner)
	body, _ := json.Marshal(squashRequest{Revisions: []string{"abc"}, Destination: "def"})
	req := jsonPost("/api/squash", body)
	w := httptest.NewRecorder()
	srv.Mux.ServeHTTP(w, req)

	assert.Equal(t, http.StatusOK, w.Code)
}

func TestHandleUndo(t *testing.T) {
	runner := testutil.NewMockRunner(t)
	runner.Expect(jj.Undo()).SetOutput([]byte(""))
	defer runner.Verify()

	srv := newTestServer(runner)
	req := jsonPost("/api/undo", []byte("{}"))
	w := httptest.NewRecorder()
	srv.Mux.ServeHTTP(w, req)

	assert.Equal(t, http.StatusOK, w.Code)
}

func TestHandleSnapshot(t *testing.T) {
	runner := testutil.NewMockRunner(t)
	runner.Expect(jj.DebugSnapshot()).SetOutput([]byte(""))
	defer runner.Verify()

	srv := newTestServer(runner)
	req := jsonPost("/api/snapshot", []byte("{}"))
	w := httptest.NewRecorder()
	srv.Mux.ServeHTTP(w, req)

	assert.Equal(t, http.StatusOK, w.Code)
}

func TestHandleBookmarkSet(t *testing.T) {
	runner := testutil.NewMockRunner(t)
	runner.Expect(jj.BookmarkSet("abc", "feature")).SetOutput([]byte(""))
	defer runner.Verify()

	srv := newTestServer(runner)
	body, _ := json.Marshal(bookmarkRevisionRequest{Revision: "abc", Name: "feature"})
	req := jsonPost("/api/bookmark/set", body)
	w := httptest.NewRecorder()
	srv.Mux.ServeHTTP(w, req)

	assert.Equal(t, http.StatusOK, w.Code)
}

func TestHandleGitPush(t *testing.T) {
	runner := testutil.NewMockRunner(t)
	runner.Expect(jj.GitPush("--bookmark", "main")).SetOutput([]byte(
		"Changes to push to origin:\n  Move forward bookmark main from aaa to bbb\n"))
	defer runner.Verify()

	srv := newTestServer(runner)
	body, _ := json.Marshal(gitFlagsRequest{Flags: []string{"--bookmark", "main"}})
	req := jsonPost("/api/git/push", body)
	w := httptest.NewRecorder()
	srv.Mux.ServeHTTP(w, req)

	assert.Equal(t, http.StatusOK, w.Code)
	assert.Equal(t, "application/x-ndjson", w.Header().Get("Content-Type"))

	// NDJSON: one {"line":...} per progress line, then {"done":true,"output":...}
	lines := strings.Split(strings.TrimRight(w.Body.String(), "\n"), "\n")
	require.Len(t, lines, 3)

	var l0, l1 map[string]string
	require.NoError(t, json.Unmarshal([]byte(lines[0]), &l0))
	require.NoError(t, json.Unmarshal([]byte(lines[1]), &l1))
	assert.Equal(t, "Changes to push to origin:", l0["line"])
	assert.Equal(t, "  Move forward bookmark main from aaa to bbb", l1["line"])

	var done map[string]any
	require.NoError(t, json.Unmarshal([]byte(lines[2]), &done))
	assert.Equal(t, true, done["done"])
	assert.Nil(t, done["error"])
	assert.Contains(t, done["output"], "Move forward bookmark main")
	assert.Equal(t, "abc123", done["op_id"]) // newTestServer's allowed CurrentOpId
}

func TestHandleDivergence(t *testing.T) {
	runner := testutil.NewMockRunner(t)
	// Two divergent versions of X: /0 wc-reachable, /1 stale. Parser-level
	// behavior is covered in jj/divergence_test.go; this just checks the
	// handler wires Run→Parse→JSON without mangling.
	runner.Expect(jj.Divergence()).SetOutput([]byte(
		"X\x1Fabc\x1F1\x1Fp1\x1Fpc1\x1F1\x1F\x1Fv0\x1F\x1F\n" +
			"X\x1Fdef\x1F1\x1Fp2\x1Fpc1\x1F\x1F\x1Fv1\x1F\x1F\n"))
	defer runner.Verify()

	srv := newTestServer(runner)
	req := httptest.NewRequest("GET", "/api/divergence", nil)
	w := httptest.NewRecorder()
	srv.Mux.ServeHTTP(w, req)

	assert.Equal(t, http.StatusOK, w.Code)
	var entries []jj.DivergenceEntry
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &entries))
	assert.Len(t, entries, 2)
	assert.Equal(t, "abc", entries[0].CommitId) // emission order preserved — /0 first
	assert.True(t, entries[0].WCReachable)
	assert.False(t, entries[1].WCReachable)
	// Same parent_change_id (pc1) but different parent_commit_id (p1≠p2) →
	// stack-inherited. Classifier checks this client-side.
	assert.Equal(t, entries[0].ParentChangeIds, entries[1].ParentChangeIds)
	assert.NotEqual(t, entries[0].ParentCommitIds, entries[1].ParentCommitIds)
}

func TestHandleDivergence_Empty(t *testing.T) {
	// No divergence → [] not null (frontend expects .length).
	runner := testutil.NewMockRunner(t)
	runner.Expect(jj.Divergence()).SetOutput([]byte(""))
	defer runner.Verify()

	srv := newTestServer(runner)
	req := httptest.NewRequest("GET", "/api/divergence", nil)
	w := httptest.NewRecorder()
	srv.Mux.ServeHTTP(w, req)

	assert.Equal(t, http.StatusOK, w.Code)
	assert.Equal(t, "[]\n", w.Body.String())
}

func TestHandleFiles(t *testing.T) {
	runner := testutil.NewMockRunner(t)
	runner.Expect(jj.FilesTemplate("abc")).SetOutput(
		[]byte("M\x1Fsrc/main.go\x1F7\x1F3\nA\x1Fnew.go\x1F5\x1F0\x1E\x1D"))
	defer runner.Verify()

	srv := newTestServer(runner)
	req := httptest.NewRequest("GET", "/api/files?revision=abc", nil)
	w := httptest.NewRecorder()
	srv.Mux.ServeHTTP(w, req)

	assert.Equal(t, http.StatusOK, w.Code)
	var files []jj.FileChange
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &files))
	assert.Len(t, files, 2)
	assert.Equal(t, "M", files[0].Type)
	assert.Equal(t, "src/main.go", files[0].Path)
	assert.Equal(t, 7, files[0].Additions)
	assert.Equal(t, 3, files[0].Deletions)
	assert.Equal(t, "A", files[1].Type)
	assert.Equal(t, "new.go", files[1].Path)
	assert.Equal(t, 5, files[1].Additions)
	assert.Equal(t, 0, files[1].Deletions)
}

func TestHandleFiles_MissingRevision(t *testing.T) {
	srv := newTestServer(testutil.NewMockRunner(t))
	req := httptest.NewRequest("GET", "/api/files", nil)
	w := httptest.NewRecorder()
	srv.Mux.ServeHTTP(w, req)

	assert.Equal(t, http.StatusBadRequest, w.Code)
}

func TestHandleFiles_Empty(t *testing.T) {
	runner := testutil.NewMockRunner(t)
	runner.Expect(jj.FilesTemplate("abc")).SetOutput([]byte("\x1E\x1D"))
	defer runner.Verify()

	srv := newTestServer(runner)
	req := httptest.NewRequest("GET", "/api/files?revision=abc", nil)
	w := httptest.NewRecorder()
	srv.Mux.ServeHTTP(w, req)

	assert.Equal(t, http.StatusOK, w.Code)
	var files []jj.FileChange
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &files))
	assert.Empty(t, files)
}

func TestHandleFilesBatch(t *testing.T) {
	runner := testutil.NewMockRunner(t)
	runner.Expect(jj.FilesBatch([]string{"abc", "def"})).SetOutput([]byte(
		"abc\x1E0\x1EM\x1Fmain.go\x1F3\x1F1\x1D" +
			"def\x1E1\x1E\x1D"))
	defer runner.Verify()

	srv := newTestServer(runner)
	req := httptest.NewRequest("GET", "/api/files-batch?revisions=abc,def", nil)
	w := httptest.NewRecorder()
	srv.Mux.ServeHTTP(w, req)

	assert.Equal(t, http.StatusOK, w.Code)
	var resp map[string]jj.FilesBatchEntry
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &resp))
	assert.Len(t, resp, 2)
	assert.False(t, resp["abc"].Conflict)
	assert.Len(t, resp["abc"].Files, 1)
	assert.Equal(t, "main.go", resp["abc"].Files[0].Path)
	assert.Equal(t, 3, resp["abc"].Files[0].Additions)
	assert.True(t, resp["def"].Conflict)
	assert.Empty(t, resp["def"].Files)
}

func TestHandleFilesBatch_MissingRevisions(t *testing.T) {
	srv := newTestServer(testutil.NewMockRunner(t))
	req := httptest.NewRequest("GET", "/api/files-batch", nil)
	w := httptest.NewRecorder()
	srv.Mux.ServeHTTP(w, req)
	assert.Equal(t, http.StatusBadRequest, w.Code)
}

func TestHandleFilesBatch_TrailingComma(t *testing.T) {
	// Trailing/double commas should be filtered, not passed to jj as "|" revset.
	runner := testutil.NewMockRunner(t)
	runner.Expect(jj.FilesBatch([]string{"abc", "def"})).SetOutput([]byte(
		"abc\x1E0\x1E\x1Ddef\x1E0\x1E\x1D"))
	defer runner.Verify()

	srv := newTestServer(runner)
	req := httptest.NewRequest("GET", "/api/files-batch?revisions=abc,,def,", nil)
	w := httptest.NewRecorder()
	srv.Mux.ServeHTTP(w, req)
	assert.Equal(t, http.StatusOK, w.Code)
}

func TestHandleFilesBatch_OnlyCommas(t *testing.T) {
	srv := newTestServer(testutil.NewMockRunner(t))
	req := httptest.NewRequest("GET", "/api/files-batch?revisions=,,,", nil)
	w := httptest.NewRecorder()
	srv.Mux.ServeHTTP(w, req)
	assert.Equal(t, http.StatusBadRequest, w.Code)
}

func TestHandleFilesBatch_TooMany(t *testing.T) {
	srv := newTestServer(testutil.NewMockRunner(t))
	ids := make([]string, 51)
	for i := range ids {
		ids[i] = fmt.Sprintf("id%d", i)
	}
	req := httptest.NewRequest("GET", "/api/files-batch?revisions="+strings.Join(ids, ","), nil)
	w := httptest.NewRecorder()
	srv.Mux.ServeHTTP(w, req)
	assert.Equal(t, http.StatusBadRequest, w.Code)
}

func TestHandleRevision(t *testing.T) {
	runner := testutil.NewMockRunner(t)
	runner.Expect(jj.FilesTemplate("abc")).SetOutput([]byte("M\x1Fsrc/main.go\x1F2\x1F1\x1E\x1D"))
	runner.Expect(jj.Diff("abc", "", "never", "--tool", ":git")).SetOutput([]byte("diff --git a/src/main.go b/src/main.go\n"))
	runner.Expect(jj.GetDescription("abc")).SetOutput([]byte("Fix the thing\n"))
	defer runner.Verify()

	srv := newTestServer(runner)
	req := httptest.NewRequest("GET", "/api/revision?revision=abc", nil)
	w := httptest.NewRecorder()
	srv.Mux.ServeHTTP(w, req)

	assert.Equal(t, http.StatusOK, w.Code)
	var resp revisionResponse
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &resp))
	assert.Equal(t, "diff --git a/src/main.go b/src/main.go\n", resp.Diff)
	assert.Equal(t, "Fix the thing\n", resp.Description)
	require.Len(t, resp.Files, 1)
	assert.Equal(t, "M", resp.Files[0].Type)
	assert.Equal(t, "src/main.go", resp.Files[0].Path)
	assert.Equal(t, 2, resp.Files[0].Additions)
	assert.Equal(t, 1, resp.Files[0].Deletions)
}

func TestHandleRevision_MissingRevision(t *testing.T) {
	srv := newTestServer(testutil.NewMockRunner(t))
	req := httptest.NewRequest("GET", "/api/revision", nil)
	w := httptest.NewRecorder()
	srv.Mux.ServeHTTP(w, req)
	assert.Equal(t, http.StatusBadRequest, w.Code)
}

func TestHandleRevision_FilesError(t *testing.T) {
	runner := testutil.NewMockRunner(t)
	runner.Expect(jj.FilesTemplate("bad")).SetError(fmt.Errorf("no such revision"))
	// Parallel goroutines still fire; Allow() so Verify() doesn't fail on them.
	runner.Allow(jj.Diff("bad", "", "never", "--tool", ":git")).SetOutput([]byte(""))
	runner.Allow(jj.GetDescription("bad")).SetOutput([]byte(""))
	defer runner.Verify()

	srv := newTestServer(runner)
	req := httptest.NewRequest("GET", "/api/revision?revision=bad", nil)
	w := httptest.NewRecorder()
	srv.Mux.ServeHTTP(w, req)
	assert.Equal(t, http.StatusInternalServerError, w.Code)
}

func TestHandleRevision_DescriptionErrorIsSoft(t *testing.T) {
	runner := testutil.NewMockRunner(t)
	runner.Expect(jj.FilesTemplate("abc")).SetOutput([]byte("\x1E\x1D"))
	runner.Expect(jj.Diff("abc", "", "never", "--tool", ":git")).SetOutput([]byte(""))
	runner.Expect(jj.GetDescription("abc")).SetError(fmt.Errorf("template error"))
	defer runner.Verify()

	srv := newTestServer(runner)
	req := httptest.NewRequest("GET", "/api/revision?revision=abc", nil)
	w := httptest.NewRecorder()
	srv.Mux.ServeHTTP(w, req)

	assert.Equal(t, http.StatusOK, w.Code)
	var resp revisionResponse
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &resp))
	assert.Equal(t, "", resp.Description) // soft-failed, not a 500
}

func TestHandleBookmarkMove(t *testing.T) {
	runner := testutil.NewMockRunner(t)
	runner.Expect(jj.BookmarkMove("abc", "feature", "--allow-backwards")).SetOutput([]byte(""))
	defer runner.Verify()

	srv := newTestServer(runner)
	body, _ := json.Marshal(bookmarkRevisionRequest{Revision: "abc", Name: "feature"})
	req := jsonPost("/api/bookmark/move", body)
	w := httptest.NewRecorder()
	srv.Mux.ServeHTTP(w, req)

	assert.Equal(t, http.StatusOK, w.Code)
}

func TestHandleBookmarkAdvance(t *testing.T) {
	runner := testutil.NewMockRunner(t)
	runner.Expect(jj.BookmarkAdvance("abc", "feature")).SetOutput([]byte(""))
	defer runner.Verify()

	srv := newTestServer(runner)
	body, _ := json.Marshal(bookmarkRevisionRequest{Revision: "abc", Name: "feature"})
	req := jsonPost("/api/bookmark/advance", body)
	w := httptest.NewRecorder()
	srv.Mux.ServeHTTP(w, req)

	assert.Equal(t, http.StatusOK, w.Code)
}

func TestHandleBookmarkAdvance_Validation(t *testing.T) {
	srv := newTestServer(testutil.NewMockRunner(t))
	body, _ := json.Marshal(bookmarkRevisionRequest{Revision: "abc"}) // no name
	req := jsonPost("/api/bookmark/advance", body)
	w := httptest.NewRecorder()
	srv.Mux.ServeHTTP(w, req)
	assert.Equal(t, http.StatusBadRequest, w.Code)
}

func TestHandleBookmarkForget(t *testing.T) {
	runner := testutil.NewMockRunner(t)
	runner.Expect(jj.BookmarkForget("feature")).SetOutput([]byte(""))
	defer runner.Verify()

	srv := newTestServer(runner)
	body, _ := json.Marshal(bookmarkNameRequest{Name: "feature"})
	req := jsonPost("/api/bookmark/forget", body)
	w := httptest.NewRecorder()
	srv.Mux.ServeHTTP(w, req)

	assert.Equal(t, http.StatusOK, w.Code)
}

// --- Error path tests ---

func TestHandleLog_RunnerError(t *testing.T) {
	runner := testutil.NewMockRunner(t)
	runner.Expect(jj.LogGraph("@", 500)).SetError(errors.New("jj failed"))
	defer runner.Verify()

	srv := newTestServer(runner)
	req := httptest.NewRequest("GET", "/api/log?revset=@", nil)
	w := httptest.NewRecorder()
	srv.Mux.ServeHTTP(w, req)

	assert.Equal(t, http.StatusInternalServerError, w.Code)
	var resp map[string]string
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &resp))
	assert.Equal(t, "jj failed", resp["error"])
}

func TestHandleEdit_InvalidJSON(t *testing.T) {
	srv := newTestServer(testutil.NewMockRunner(t))
	req := jsonPost("/api/edit", []byte("{bad json"))
	w := httptest.NewRecorder()
	srv.Mux.ServeHTTP(w, req)

	assert.Equal(t, http.StatusBadRequest, w.Code)
}

func TestContentTypeRequired(t *testing.T) {
	srv := newTestServer(testutil.NewMockRunner(t))
	for _, endpoint := range []string{"/api/new", "/api/undo", "/api/commit"} {
		t.Run(endpoint, func(t *testing.T) {
			req := httptest.NewRequest("POST", endpoint, bytes.NewReader([]byte("{}")))
			w := httptest.NewRecorder()
			srv.Mux.ServeHTTP(w, req)

			assert.Equal(t, http.StatusBadRequest, w.Code)
			assert.Contains(t, w.Body.String(), "Content-Type must be application/json")
		})
	}
}

func TestHandleGit_DisallowedFlag(t *testing.T) {
	srv := newTestServer(testutil.NewMockRunner(t))
	for _, endpoint := range []string{"/api/git/push", "/api/git/fetch"} {
		t.Run(endpoint, func(t *testing.T) {
			body, _ := json.Marshal(gitFlagsRequest{Flags: []string{"--force"}})
			req := jsonPost(endpoint, body)
			w := httptest.NewRecorder()
			srv.Mux.ServeHTTP(w, req)

			assert.Equal(t, http.StatusBadRequest, w.Code)
			var resp map[string]string
			require.NoError(t, json.Unmarshal(w.Body.Bytes(), &resp))
			assert.Contains(t, resp["error"], "flag not allowed")
		})
	}
}

func TestHandleLog_InvalidLimit(t *testing.T) {
	srv := newTestServer(testutil.NewMockRunner(t))
	req := httptest.NewRequest("GET", "/api/log?limit=notanumber", nil)
	w := httptest.NewRecorder()
	srv.Mux.ServeHTTP(w, req)

	assert.Equal(t, http.StatusBadRequest, w.Code)
}

func TestHandleMutation_MissingFields(t *testing.T) {
	srv := newTestServer(testutil.NewMockRunner(t))

	for _, tt := range []struct {
		name     string
		endpoint string
		body     any
	}{
		{"rebase missing revisions", "/api/rebase", rebaseRequest{Destination: "def"}},
		{"rebase missing destination", "/api/rebase", rebaseRequest{Revisions: []string{"abc"}}},
		{"bookmark/set missing name", "/api/bookmark/set", bookmarkRevisionRequest{Revision: "abc"}},
		{"bookmark/move missing name", "/api/bookmark/move", bookmarkRevisionRequest{Revision: "abc"}},
		{"bookmark/forget missing name", "/api/bookmark/forget", bookmarkNameRequest{}},
		{"bookmark/delete missing name", "/api/bookmark/delete", bookmarkNameRequest{}},
		{"describe missing revision", "/api/describe", describeRequest{Description: "test"}},
		{"new empty revisions", "/api/new", newRequest{Revisions: []string{}}},
		{"abandon empty revisions", "/api/abandon", abandonRequest{Revisions: []string{}}},
		{"squash empty revisions", "/api/squash", squashRequest{Destination: "def"}},
		{"squash empty destination", "/api/squash", squashRequest{Revisions: []string{"abc"}}},
		{"edit missing revision", "/api/edit", editRequest{}},
		{"split missing revision", "/api/split", splitRequest{Files: []string{"file.go"}}},
		{"split missing files", "/api/split", splitRequest{Revision: "abc"}},
	} {
		t.Run(tt.name, func(t *testing.T) {
			body, _ := json.Marshal(tt.body)
			req := jsonPost(tt.endpoint, body)
			w := httptest.NewRecorder()
			srv.Mux.ServeHTTP(w, req)
			assert.Equal(t, http.StatusBadRequest, w.Code)
		})
	}
}

func TestValidateFlags(t *testing.T) {
	allowed := map[string]bool{"--bookmark": true, "--remote": true}

	assert.NoError(t, validateFlags([]string{"--bookmark", "main"}, allowed))
	assert.NoError(t, validateFlags([]string{"--remote=origin"}, allowed))
	assert.NoError(t, validateFlags(nil, allowed))

	err := validateFlags([]string{"--force"}, allowed)
	assert.Error(t, err)
	assert.Contains(t, err.Error(), "flag not allowed: --force")
}

func TestHandleGetDescription(t *testing.T) {
	runner := testutil.NewMockRunner(t)
	runner.Expect(jj.GetDescription("abc")).SetOutput([]byte("my commit message"))
	defer runner.Verify()

	srv := newTestServer(runner)
	req := httptest.NewRequest("GET", "/api/description?revision=abc", nil)
	w := httptest.NewRecorder()
	srv.Mux.ServeHTTP(w, req)

	assert.Equal(t, http.StatusOK, w.Code)
	var resp map[string]string
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &resp))
	assert.Equal(t, "my commit message", resp["description"])
}

func TestHandleGetDescription_MissingRevision(t *testing.T) {
	srv := newTestServer(testutil.NewMockRunner(t))
	req := httptest.NewRequest("GET", "/api/description", nil)
	w := httptest.NewRecorder()
	srv.Mux.ServeHTTP(w, req)

	assert.Equal(t, http.StatusBadRequest, w.Code)
}

func TestHandleInfo(t *testing.T) {
	srv := newTestServer(testutil.NewMockRunner(t))
	srv.Hostname = "myhost"
	srv.RepoPath = "/home/user/repo"

	req := httptest.NewRequest("GET", "/api/info", nil)
	w := httptest.NewRecorder()
	srv.Mux.ServeHTTP(w, req)

	assert.Equal(t, http.StatusOK, w.Code)
	var got map[string]string
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &got))
	assert.Equal(t, "myhost", got["hostname"])
	assert.Equal(t, "/home/user/repo", got["repo_path"])
}

func TestHandleRemotes(t *testing.T) {
	runner := testutil.NewMockRunner(t)
	runner.Expect(jj.GitRemoteList()).SetOutput([]byte("origin https://github.com/test/repo.git\n"))
	defer runner.Verify()

	srv := newTestServer(runner)
	req := httptest.NewRequest("GET", "/api/remotes", nil)
	w := httptest.NewRecorder()
	srv.Mux.ServeHTTP(w, req)

	assert.Equal(t, http.StatusOK, w.Code)
}

func TestHandleGitFetch_ValidFlags(t *testing.T) {
	runner := testutil.NewMockRunner(t)
	runner.Expect(jj.GitFetch("--remote", "origin")).SetOutput([]byte(""))
	defer runner.Verify()

	srv := newTestServer(runner)
	body, _ := json.Marshal(gitFlagsRequest{Flags: []string{"--remote", "origin"}})
	req := jsonPost("/api/git/fetch", body)
	w := httptest.NewRecorder()
	srv.Mux.ServeHTTP(w, req)

	assert.Equal(t, http.StatusOK, w.Code)
}

func TestValidateFlags_SingleDashRejected(t *testing.T) {
	allowed := map[string]bool{"--bookmark": true}
	err := validateFlags([]string{"-f"}, allowed)
	assert.Error(t, err)
	assert.Contains(t, err.Error(), "flag not allowed: -f")
}

func TestOpIdHeader_Failure(t *testing.T) {
	runner := testutil.NewMockRunner(t)
	runner.Allow(jj.CurrentOpId()).SetError(errors.New("op-id fetch failed"))
	runner.Expect(jj.LogGraph("", 500)).SetOutput([]byte(""))
	defer runner.Verify()

	srv := NewServer(runner, "")
	req := httptest.NewRequest("GET", "/api/log", nil)
	w := httptest.NewRecorder()
	srv.Mux.ServeHTTP(w, req)

	assert.Equal(t, http.StatusOK, w.Code)
	// When op-id fetch fails, header should be absent
	assert.Empty(t, w.Header().Get("X-JJ-Op-Id"))
}

func TestRefreshOpId_ReaddirFastPath(t *testing.T) {
	// Fast path: op-id is the filename in op_heads/heads/ (first 12 hex chars).
	// No subprocess needed — readdir is <1ms vs ~15-20ms for `jj op log`.
	repoDir := t.TempDir()
	headsDir := filepath.Join(repoDir, ".jj", "repo", "op_heads", "heads")
	require.NoError(t, os.MkdirAll(headsDir, 0o755))
	// Real op-ids are 128 hex chars (64-byte blake2). short() truncates to 12.
	fullId := "d4851555d6a7" + strings.Repeat("f", 116)
	require.NoError(t, os.WriteFile(filepath.Join(headsDir, fullId), nil, 0o644))

	// MockRunner with NO CurrentOpId expectation — proves subprocess is NOT called.
	runner := testutil.NewMockRunner(t)
	defer runner.Verify()

	srv := NewServer(runner, repoDir)
	assert.Equal(t, "d4851555d6a7", srv.refreshOpId())
	assert.Equal(t, "d4851555d6a7", srv.getOpId()) // cached
}

func TestRefreshOpId_DivergentHeadsFallback(t *testing.T) {
	// Divergent ops produce >1 file in op_heads/heads/. Rare, self-healing
	// on next jj command. Fast path declines; subprocess resolves.
	repoDir := t.TempDir()
	headsDir := filepath.Join(repoDir, ".jj", "repo", "op_heads", "heads")
	require.NoError(t, os.MkdirAll(headsDir, 0o755))
	require.NoError(t, os.WriteFile(filepath.Join(headsDir, "aaa111"+strings.Repeat("0", 58)), nil, 0o644))
	require.NoError(t, os.WriteFile(filepath.Join(headsDir, "bbb222"+strings.Repeat("0", 58)), nil, 0o644))

	runner := testutil.NewMockRunner(t)
	runner.Expect(jj.CurrentOpId()).SetOutput([]byte("merged123456"))
	defer runner.Verify()

	srv := NewServer(runner, repoDir)
	assert.Equal(t, "merged123456", srv.refreshOpId())
}

func TestHandleOpLog(t *testing.T) {
	runner := testutil.NewMockRunner(t)
	opLogOutput := "abc123\x1Fdescription one\x1F2026-01-01 00:00\x1Ftrue\ndef456\x1Fdescription two\x1F2026-01-01 00:01\x1Ffalse\n"
	runner.Expect(jj.OpLog(50)).SetOutput([]byte(opLogOutput))
	defer runner.Verify()

	srv := newTestServer(runner)
	req := httptest.NewRequest("GET", "/api/oplog", nil)
	w := httptest.NewRecorder()
	srv.Mux.ServeHTTP(w, req)

	assert.Equal(t, http.StatusOK, w.Code)
	var entries []jj.OpEntry
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &entries))
	assert.Len(t, entries, 2)
	assert.Equal(t, "abc123", entries[0].ID)
	assert.Equal(t, "description one", entries[0].Description)
	assert.True(t, entries[0].IsCurrent)
	assert.Equal(t, "def456", entries[1].ID)
	assert.False(t, entries[1].IsCurrent)
}

func TestHandleEvolog(t *testing.T) {
	runner := testutil.NewMockRunner(t)
	runner.Expect(jj.Evolog("abc")).SetOutput([]byte(
		"d00e01ea\x1f2026-02-27 15:03\x1fsnapshot working copy\x1f3e061968\x1fdiff --git a/x b/x\n\x1e" +
			"3e061968\x1f2026-02-27 15:01\x1fnew empty commit\x1f\x1f\x1e"))
	defer runner.Verify()

	srv := newTestServer(runner)
	req := httptest.NewRequest("GET", "/api/evolog?revision=abc", nil)
	w := httptest.NewRecorder()
	srv.Mux.ServeHTTP(w, req)

	assert.Equal(t, http.StatusOK, w.Code)
	var resp []jj.EvologEntry
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &resp))
	assert.Len(t, resp, 2)
	assert.Equal(t, "d00e01ea", resp[0].CommitId)
	assert.Equal(t, "snapshot working copy", resp[0].Operation)
	assert.Equal(t, []string{"3e061968"}, resp[0].PredecessorIds)
	assert.Equal(t, "diff --git a/x b/x\n", resp[0].Diff)
	assert.Empty(t, resp[1].PredecessorIds)
	assert.Empty(t, resp[1].Diff)
}

func TestHandleEvolog_MissingRevision(t *testing.T) {
	srv := newTestServer(testutil.NewMockRunner(t))
	req := httptest.NewRequest("GET", "/api/evolog", nil)
	w := httptest.NewRecorder()
	srv.Mux.ServeHTTP(w, req)

	assert.Equal(t, http.StatusBadRequest, w.Code)
}

func TestHandleDiffRange(t *testing.T) {
	runner := testutil.NewMockRunner(t)
	runner.Expect(jj.DiffRange("abc", "def", nil)).SetOutput([]byte("diff output"))
	defer runner.Verify()

	srv := newTestServer(runner)
	req := httptest.NewRequest("GET", "/api/diff-range?from=abc&to=def", nil)
	w := httptest.NewRecorder()
	srv.Mux.ServeHTTP(w, req)

	assert.Equal(t, http.StatusOK, w.Code)
	var result map[string]string
	json.NewDecoder(w.Body).Decode(&result)
	assert.Equal(t, "diff output", result["diff"])
}

func TestHandleDiffRange_WithFiles(t *testing.T) {
	runner := testutil.NewMockRunner(t)
	runner.Expect(jj.DiffRange("abc", "def", []string{"src/main.go", "README.md"})).SetOutput([]byte("filtered diff"))
	defer runner.Verify()

	srv := newTestServer(runner)
	req := httptest.NewRequest("GET", "/api/diff-range?from=abc&to=def&files=src/main.go&files=README.md", nil)
	w := httptest.NewRecorder()
	srv.Mux.ServeHTTP(w, req)

	assert.Equal(t, http.StatusOK, w.Code)
}

func TestHandleDiffRange_MissingParams(t *testing.T) {
	srv := newTestServer(testutil.NewMockRunner(t))

	// Missing both
	req := httptest.NewRequest("GET", "/api/diff-range", nil)
	w := httptest.NewRecorder()
	srv.Mux.ServeHTTP(w, req)
	assert.Equal(t, http.StatusBadRequest, w.Code)

	// Missing to
	req = httptest.NewRequest("GET", "/api/diff-range?from=abc", nil)
	w = httptest.NewRecorder()
	srv.Mux.ServeHTTP(w, req)
	assert.Equal(t, http.StatusBadRequest, w.Code)
}

func TestHandleBookmarkDelete(t *testing.T) {
	runner := testutil.NewMockRunner(t)
	runner.Expect(jj.BookmarkDelete("feature")).SetOutput([]byte(""))
	defer runner.Verify()

	srv := newTestServer(runner)
	body, _ := json.Marshal(bookmarkNameRequest{Name: "feature"})
	req := jsonPost("/api/bookmark/delete", body)
	w := httptest.NewRecorder()
	srv.Mux.ServeHTTP(w, req)

	assert.Equal(t, http.StatusOK, w.Code)
}

// --- Context expansion tests ---

func TestHandleDiff_WithContext(t *testing.T) {
	runner := testutil.NewMockRunner(t)
	runner.Expect(jj.Diff("abc", "", "never", "--tool", ":git", "--context", "10")).SetOutput([]byte("+expanded"))
	defer runner.Verify()

	srv := newTestServer(runner)
	req := httptest.NewRequest("GET", "/api/diff?revision=abc&context=10", nil)
	w := httptest.NewRecorder()
	srv.Mux.ServeHTTP(w, req)

	assert.Equal(t, http.StatusOK, w.Code)
	var resp map[string]string
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &resp))
	assert.Contains(t, resp["diff"], "+expanded")
}

func TestHandleDiff_InvalidContext(t *testing.T) {
	runner := testutil.NewMockRunner(t)
	// Invalid context "abc" should be silently ignored — no --context flag passed
	runner.Expect(jj.Diff("abc", "", "never", "--tool", ":git")).SetOutput([]byte("+normal"))
	defer runner.Verify()

	srv := newTestServer(runner)
	req := httptest.NewRequest("GET", "/api/diff?revision=abc&context=abc", nil)
	w := httptest.NewRecorder()
	srv.Mux.ServeHTTP(w, req)

	assert.Equal(t, http.StatusOK, w.Code)
	var resp map[string]string
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &resp))
	assert.Contains(t, resp["diff"], "+normal")
}

func TestHandleDiff_LargeContext(t *testing.T) {
	runner := testutil.NewMockRunner(t)
	// Large context value (10000) for full-file expansion — passed through as-is
	runner.Expect(jj.Diff("abc", "", "never", "--tool", ":git", "--context", "10000")).SetOutput([]byte("+full file"))
	defer runner.Verify()

	srv := newTestServer(runner)
	req := httptest.NewRequest("GET", "/api/diff?revision=abc&context=10000", nil)
	w := httptest.NewRecorder()
	srv.Mux.ServeHTTP(w, req)

	assert.Equal(t, http.StatusOK, w.Code)
	var resp map[string]string
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &resp))
	assert.Contains(t, resp["diff"], "+full file")
}

// --- Rebase source_mode / target_mode tests ---

func TestHandleRebase_Modes(t *testing.T) {
	tests := []struct {
		name       string
		sourceMode string
		targetMode string
		wantSource string
		wantTarget string
	}{
		{"source -s", "-s", "", "-s", "-d"},
		{"source -b", "-b", "", "-b", "-d"},
		{"target --insert-after", "", "--insert-after", "-r", "--insert-after"},
		{"target --insert-before", "", "--insert-before", "-r", "--insert-before"},
		{"empty defaults to -r/-d", "", "", "-r", "-d"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			runner := testutil.NewMockRunner(t)
			revs := jj.NewSelectedRevisions(&jj.Commit{ChangeId: "abc"})
			runner.Expect(jj.Rebase(revs, "def", tt.wantSource, tt.wantTarget, false, false)).SetOutput([]byte(""))
			defer runner.Verify()

			srv := newTestServer(runner)
			body, _ := json.Marshal(rebaseRequest{
				Revisions: []string{"abc"}, Destination: "def",
				SourceMode: tt.sourceMode, TargetMode: tt.targetMode,
			})
			req := jsonPost("/api/rebase", body)
			w := httptest.NewRecorder()
			srv.Mux.ServeHTTP(w, req)

			assert.Equal(t, http.StatusOK, w.Code)
		})
	}
}

func TestHandleRebase_Flags(t *testing.T) {
	runner := testutil.NewMockRunner(t)
	revs := jj.NewSelectedRevisions(&jj.Commit{ChangeId: "abc"})
	runner.Expect(jj.Rebase(revs, "def", "-r", "-d", true, true)).SetOutput([]byte(""))
	defer runner.Verify()

	srv := newTestServer(runner)
	body, _ := json.Marshal(rebaseRequest{
		Revisions: []string{"abc"}, Destination: "def",
		SkipEmptied: true, IgnoreImmutable: true,
	})
	req := jsonPost("/api/rebase", body)
	w := httptest.NewRecorder()
	srv.Mux.ServeHTTP(w, req)
	assert.Equal(t, http.StatusOK, w.Code)
}

func TestHandleRebase_InvalidModes(t *testing.T) {
	tests := []struct {
		name       string
		sourceMode string
		targetMode string
		wantError  string
	}{
		{"invalid source_mode", "--bad", "", "invalid source_mode"},
		{"invalid target_mode", "", "--bad", "invalid target_mode"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			srv := newTestServer(testutil.NewMockRunner(t))
			body, _ := json.Marshal(rebaseRequest{
				Revisions: []string{"abc"}, Destination: "def",
				SourceMode: tt.sourceMode, TargetMode: tt.targetMode,
			})
			req := jsonPost("/api/rebase", body)
			w := httptest.NewRecorder()
			srv.Mux.ServeHTTP(w, req)

			assert.Equal(t, http.StatusBadRequest, w.Code)
			var resp map[string]string
			require.NoError(t, json.Unmarshal(w.Body.Bytes(), &resp))
			assert.Contains(t, resp["error"], tt.wantError)
		})
	}
}

// --- Bookmark track/untrack tests ---

func TestHandleBookmarkTrack(t *testing.T) {
	runner := testutil.NewMockRunner(t)
	runner.Expect(jj.BookmarkTrack("feature", "origin")).SetOutput([]byte(""))
	defer runner.Verify()

	srv := newTestServer(runner)
	body, _ := json.Marshal(bookmarkRemoteRequest{Name: "feature", Remote: "origin"})
	req := jsonPost("/api/bookmark/track", body)
	w := httptest.NewRecorder()
	srv.Mux.ServeHTTP(w, req)

	assert.Equal(t, http.StatusOK, w.Code)
}

func TestHandleBookmarkTrack_NoRemote(t *testing.T) {
	srv := newTestServer(testutil.NewMockRunner(t))
	body, _ := json.Marshal(bookmarkRemoteRequest{Name: "feature"})
	req := jsonPost("/api/bookmark/track", body)
	w := httptest.NewRecorder()
	srv.Mux.ServeHTTP(w, req)

	assert.Equal(t, http.StatusBadRequest, w.Code)
	assert.Contains(t, w.Body.String(), "name and remote are required")
}

func TestHandleBookmarkTrack_MissingName(t *testing.T) {
	srv := newTestServer(testutil.NewMockRunner(t))
	body, _ := json.Marshal(bookmarkRemoteRequest{Remote: "origin"})
	req := jsonPost("/api/bookmark/track", body)
	w := httptest.NewRecorder()
	srv.Mux.ServeHTTP(w, req)

	assert.Equal(t, http.StatusBadRequest, w.Code)
	assert.Contains(t, w.Body.String(), "name and remote are required")
}

func TestHandleBookmarkUntrack(t *testing.T) {
	runner := testutil.NewMockRunner(t)
	runner.Expect(jj.BookmarkUntrack("feature", "origin")).SetOutput([]byte(""))
	defer runner.Verify()

	srv := newTestServer(runner)
	body, _ := json.Marshal(bookmarkRemoteRequest{Name: "feature", Remote: "origin"})
	req := jsonPost("/api/bookmark/untrack", body)
	w := httptest.NewRecorder()
	srv.Mux.ServeHTTP(w, req)

	assert.Equal(t, http.StatusOK, w.Code)
}

// --- Mutation runner-error tests ---

func TestHandleNew_RunnerError(t *testing.T) {
	runner := testutil.NewMockRunner(t)
	runner.Expect(jj.New(jj.NewSelectedRevisions(&jj.Commit{ChangeId: "abc"}))).SetError(errors.New("jj new failed"))
	defer runner.Verify()

	srv := newTestServer(runner)
	body, _ := json.Marshal(newRequest{Revisions: []string{"abc"}})
	req := jsonPost("/api/new", body)
	w := httptest.NewRecorder()
	srv.Mux.ServeHTTP(w, req)

	assert.Equal(t, http.StatusInternalServerError, w.Code)
	var resp map[string]string
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &resp))
	assert.Equal(t, "jj new failed", resp["error"])
}

func TestHandleAbandon_RunnerError(t *testing.T) {
	runner := testutil.NewMockRunner(t)
	revs := jj.NewSelectedRevisions(&jj.Commit{ChangeId: "abc"})
	runner.Expect(jj.Abandon(revs, false)).SetError(errors.New("jj abandon failed"))
	defer runner.Verify()

	srv := newTestServer(runner)
	body, _ := json.Marshal(abandonRequest{Revisions: []string{"abc"}})
	req := jsonPost("/api/abandon", body)
	w := httptest.NewRecorder()
	srv.Mux.ServeHTTP(w, req)

	assert.Equal(t, http.StatusInternalServerError, w.Code)
}

func TestHandleDescribe_RunnerError(t *testing.T) {
	runner := testutil.NewMockRunner(t)
	args, _ := jj.SetDescription("abc", "desc")
	runner.Expect(args).SetError(errors.New("describe failed"))
	defer runner.Verify()

	srv := newTestServer(runner)
	body, _ := json.Marshal(describeRequest{Revision: "abc", Description: "desc"})
	req := jsonPost("/api/describe", body)
	w := httptest.NewRecorder()
	srv.Mux.ServeHTTP(w, req)

	assert.Equal(t, http.StatusInternalServerError, w.Code)
}

func TestHandleRebase_RunnerError(t *testing.T) {
	runner := testutil.NewMockRunner(t)
	revs := jj.NewSelectedRevisions(&jj.Commit{ChangeId: "abc"})
	runner.Expect(jj.Rebase(revs, "def", "-r", "-d", false, false)).SetError(errors.New("rebase failed"))
	defer runner.Verify()

	srv := newTestServer(runner)
	body, _ := json.Marshal(rebaseRequest{Revisions: []string{"abc"}, Destination: "def"})
	req := jsonPost("/api/rebase", body)
	w := httptest.NewRecorder()
	srv.Mux.ServeHTTP(w, req)

	assert.Equal(t, http.StatusInternalServerError, w.Code)
}

func TestHandleGitPush_RunnerError(t *testing.T) {
	// Real-world failure: jj writes "Error: ..." to stderr (streamed as a line),
	// then exits non-zero (surfaces on Close). streamMutation echoes the streamed
	// content as the error message — closeErr.Error() is just "exit status 1".
	runner := testutil.NewMockRunner(t)
	runner.Expect(jj.GitPush("--all")).
		SetOutput([]byte("Error: bookmark main is conflicted\n")).
		SetError(errors.New("exit status 1"))
	defer runner.Verify()

	srv := newTestServer(runner)
	body, _ := json.Marshal(gitFlagsRequest{Flags: []string{"--all"}})
	req := jsonPost("/api/git/push", body)
	w := httptest.NewRecorder()
	srv.Mux.ServeHTTP(w, req)

	// Headers already flushed before error detected — status is 200.
	assert.Equal(t, http.StatusOK, w.Code)

	lines := strings.Split(strings.TrimRight(w.Body.String(), "\n"), "\n")
	var done map[string]any
	require.NoError(t, json.Unmarshal([]byte(lines[len(lines)-1]), &done))
	assert.Equal(t, true, done["done"])
	assert.Equal(t, "Error: bookmark main is conflicted", done["error"])
}

func TestHandleGitPush_RunnerErrorNoOutput(t *testing.T) {
	// Pathological: exit-nonzero with nothing written. Fall back to closeErr text.
	runner := testutil.NewMockRunner(t)
	runner.Expect(jj.GitPush("--all")).SetError(errors.New("exit status 128"))
	defer runner.Verify()

	srv := newTestServer(runner)
	body, _ := json.Marshal(gitFlagsRequest{Flags: []string{"--all"}})
	req := jsonPost("/api/git/push", body)
	w := httptest.NewRecorder()
	srv.Mux.ServeHTTP(w, req)

	var done map[string]any
	require.NoError(t, json.Unmarshal([]byte(strings.TrimRight(w.Body.String(), "\n")), &done))
	assert.Equal(t, "exit status 128", done["error"])
}

// --- Commit tests ---

func TestHandleCommit(t *testing.T) {
	runner := testutil.NewMockRunner(t)
	runner.Expect(jj.CommitWorkingCopy("")).SetOutput([]byte("Working copy now at: abc12345"))
	defer runner.Verify()

	srv := newTestServer(runner)
	req := jsonPost("/api/commit", []byte("{}"))
	w := httptest.NewRecorder()
	srv.Mux.ServeHTTP(w, req)

	assert.Equal(t, http.StatusOK, w.Code)
	var resp map[string]string
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &resp))
	assert.Contains(t, resp["output"], "Working copy now at")
}

func TestHandleCommit_RunnerError(t *testing.T) {
	runner := testutil.NewMockRunner(t)
	runner.Expect(jj.CommitWorkingCopy("")).SetError(errors.New("nothing to commit"))
	defer runner.Verify()

	srv := newTestServer(runner)
	req := jsonPost("/api/commit", []byte("{}"))
	w := httptest.NewRecorder()
	srv.Mux.ServeHTTP(w, req)

	assert.Equal(t, http.StatusInternalServerError, w.Code)
}

// --- Bookmarks with revset test ---

func TestHandleBookmarks_WithRevset(t *testing.T) {
	runner := testutil.NewMockRunner(t)
	runner.Expect(jj.BookmarkList("main")).SetOutput([]byte("main\x1f.\x1ffalse\x1ffalse\x1fabc\x1fabc\x1f0\x1f0\x1ftrue\x1fdesc\x1f2 days ago"))
	defer runner.Verify()

	srv := newTestServer(runner)
	req := httptest.NewRequest("GET", "/api/bookmarks?revset=main", nil)
	w := httptest.NewRecorder()
	srv.Mux.ServeHTTP(w, req)

	assert.Equal(t, http.StatusOK, w.Code)
}

// --- Describe stdin verification ---

func TestHandleDescribe_StdinContent(t *testing.T) {
	runner := testutil.NewMockRunner(t)
	args, _ := jj.SetDescription("abc", "new description")
	runner.Expect(args).SetOutput([]byte("")).SetExpectedStdin("new description")
	defer runner.Verify()

	srv := newTestServer(runner)
	body, _ := json.Marshal(describeRequest{Revision: "abc", Description: "new description"})
	req := jsonPost("/api/describe", body)
	w := httptest.NewRecorder()
	srv.Mux.ServeHTTP(w, req)

	assert.Equal(t, http.StatusOK, w.Code)
}

func TestHandleFiles_RunnerError(t *testing.T) {
	runner := testutil.NewMockRunner(t)
	runner.Expect(jj.FilesTemplate("abc")).SetError(errors.New("template failed"))
	defer runner.Verify()

	srv := newTestServer(runner)
	req := httptest.NewRequest("GET", "/api/files?revision=abc", nil)
	w := httptest.NewRecorder()
	srv.Mux.ServeHTTP(w, req)
	assert.Equal(t, http.StatusInternalServerError, w.Code)
}

func TestHandleOpLog_CustomLimit(t *testing.T) {
	runner := testutil.NewMockRunner(t)
	runner.Expect(jj.OpLog(10)).SetOutput([]byte(""))
	defer runner.Verify()

	srv := newTestServer(runner)
	req := httptest.NewRequest("GET", "/api/oplog?limit=10", nil)
	w := httptest.NewRecorder()
	srv.Mux.ServeHTTP(w, req)
	assert.Equal(t, http.StatusOK, w.Code)
}

func TestHandleOpLog_InvalidLimit(t *testing.T) {
	srv := newTestServer(testutil.NewMockRunner(t))
	req := httptest.NewRequest("GET", "/api/oplog?limit=abc", nil)
	w := httptest.NewRecorder()
	srv.Mux.ServeHTTP(w, req)
	assert.Equal(t, http.StatusBadRequest, w.Code)
}

func TestHandleOpLog_LimitClamped(t *testing.T) {
	runner := testutil.NewMockRunner(t)
	// limit=9999 exceeds cap of 1000, falls back to default 50
	runner.Expect(jj.OpLog(50)).SetOutput([]byte(""))
	defer runner.Verify()

	srv := newTestServer(runner)
	req := httptest.NewRequest("GET", "/api/oplog?limit=9999", nil)
	w := httptest.NewRecorder()
	srv.Mux.ServeHTTP(w, req)
	assert.Equal(t, http.StatusOK, w.Code)
}

func TestHandleWorkspaces(t *testing.T) {
	runner := testutil.NewMockRunner(t)
	runner.Expect(jj.WorkspaceList()).SetOutput([]byte("base2\x1Fskpssuxl\x1Fa14ce848\ndefault\x1Fqqqqpqpq\x1Fbbbbbbbb\n"))
	defer runner.Verify()

	srv := newTestServer(runner)
	req := httptest.NewRequest("GET", "/api/workspaces", nil)
	w := httptest.NewRecorder()
	srv.Mux.ServeHTTP(w, req)

	assert.Equal(t, http.StatusOK, w.Code)
	var resp workspacesResponse
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &resp))
	require.Len(t, resp.Workspaces, 2)
	assert.Equal(t, "base2", resp.Workspaces[0].Name)
	assert.Equal(t, "skpssuxl", resp.Workspaces[0].ChangeId)
	assert.Equal(t, "default", resp.Workspaces[1].Name)
	assert.Equal(t, "", resp.Current) // no RepoDir set in test
}

// wsStoreEntry builds a protobuf workspace_store record (jj's on-disk format).
// Strings <128 bytes → single-byte varints → trivial hand-encoding. See
// jj/workspace_store.go for the schema.
func wsStoreEntry(name, path string) []byte {
	inner := append(
		append([]byte{0x0a, byte(len(name))}, name...),  // field 1: name
		append([]byte{0x12, byte(len(path))}, path...)..., // field 2: path
	)
	return append([]byte{0x0a, byte(len(inner))}, inner...) // outer field 1: entry
}

func TestReadWorkspaceStore_RelativePaths(t *testing.T) {
	// jj 0.39 writes paths relative to .jj/repo/. The default workspace at
	// the repo root is "../../" (two levels up from .jj/repo/). A secondary
	// workspace at ../sibling is "../../../sibling". Pre-0.39 wrote absolute.
	// readWorkspaceStore must resolve both so spawnWorkspaceInstance's IsAbs
	// check passes and the wsPath==RepoDir current-workspace match works.
	repoDir := t.TempDir()
	storeDir := filepath.Join(repoDir, ".jj", "repo", "workspace_store")
	require.NoError(t, os.MkdirAll(storeDir, 0o755))

	var store []byte
	store = append(store, wsStoreEntry("default", "../../")...)         // jj 0.39 relative
	store = append(store, wsStoreEntry("legacy", "/abs/legacy/path")...) // pre-0.39 absolute
	require.NoError(t, os.WriteFile(filepath.Join(storeDir, "index"), store, 0o644))

	srv := &Server{RepoDir: repoDir}
	got, err := srv.readWorkspaceStore()
	require.NoError(t, err)

	// ../../ from {repoDir}/.jj/repo/ → {repoDir}. filepath.Join cleans the dots.
	assert.Equal(t, repoDir, got["default"])
	// Absolute passes through (Clean'd — idempotent here).
	assert.Equal(t, "/abs/legacy/path", got["legacy"])
	// Both are now IsAbs — spawnWorkspaceInstance won't reject.
	assert.True(t, filepath.IsAbs(got["default"]))
	assert.True(t, filepath.IsAbs(got["legacy"]))
}

func TestReadWorkspaceStore_CurrentWorkspaceMatch(t *testing.T) {
	// The second break: handlers.go:396 does wsPath == s.RepoDir to identify
	// "current". With ../../ → repoDir resolution, the match works.
	repoDir := t.TempDir()
	storeDir := filepath.Join(repoDir, ".jj", "repo", "workspace_store")
	require.NoError(t, os.MkdirAll(storeDir, 0o755))
	store := wsStoreEntry("default", "../../")
	require.NoError(t, os.WriteFile(filepath.Join(storeDir, "index"), store, 0o644))

	srv := &Server{RepoDir: repoDir}
	got, _ := srv.readWorkspaceStore()

	assert.Equal(t, srv.RepoDir, got["default"]) // the exact == check handlers.go does
}

func TestHandleWorkspaces_RunnerError(t *testing.T) {
	runner := testutil.NewMockRunner(t)
	runner.Expect(jj.WorkspaceList()).SetError(errors.New("workspace list failed"))
	defer runner.Verify()

	srv := newTestServer(runner)
	req := httptest.NewRequest("GET", "/api/workspaces", nil)
	w := httptest.NewRecorder()
	srv.Mux.ServeHTTP(w, req)

	assert.Equal(t, http.StatusInternalServerError, w.Code)
	assert.Contains(t, w.Body.String(), "workspace list failed")
}

// --- Split handler tests ---

func TestHandleSplit(t *testing.T) {
	runner := testutil.NewMockRunner(t)
	runner.Expect(jj.Split("abc", []string{"src/main.go", "README.md"}, false, false)).SetOutput([]byte(""))
	defer runner.Verify()

	srv := newTestServer(runner)
	body, _ := json.Marshal(splitRequest{Revision: "abc", Files: []string{"src/main.go", "README.md"}})
	req := jsonPost("/api/split", body)
	w := httptest.NewRecorder()
	srv.Mux.ServeHTTP(w, req)

	assert.Equal(t, http.StatusOK, w.Code)
}

func TestHandleSplit_Parallel(t *testing.T) {
	runner := testutil.NewMockRunner(t)
	runner.Expect(jj.Split("abc", []string{"src/main.go"}, true, false)).SetOutput([]byte(""))
	defer runner.Verify()

	srv := newTestServer(runner)
	body, _ := json.Marshal(splitRequest{Revision: "abc", Files: []string{"src/main.go"}, Parallel: true})
	req := jsonPost("/api/split", body)
	w := httptest.NewRecorder()
	srv.Mux.ServeHTTP(w, req)

	assert.Equal(t, http.StatusOK, w.Code)
}

func TestHandleSplit_RunnerError(t *testing.T) {
	runner := testutil.NewMockRunner(t)
	runner.Expect(jj.Split("abc", []string{"file.go"}, false, false)).SetError(errors.New("split failed"))
	defer runner.Verify()

	srv := newTestServer(runner)
	body, _ := json.Marshal(splitRequest{Revision: "abc", Files: []string{"file.go"}})
	req := jsonPost("/api/split", body)
	w := httptest.NewRecorder()
	srv.Mux.ServeHTTP(w, req)

	assert.Equal(t, http.StatusInternalServerError, w.Code)
	var resp map[string]string
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &resp))
	assert.Equal(t, "split failed", resp["error"])
}

// --- Resolve handler tests ---

func TestHandleResolve(t *testing.T) {
	tests := []struct {
		name string
		file string
		tool string
	}{
		{"ours", "src/main.go", ":ours"},
		{"theirs", "README.md", ":theirs"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			runner := testutil.NewMockRunner(t)
			runner.Expect(jj.Resolve("abc", tt.file, tt.tool)).SetOutput([]byte(""))
			defer runner.Verify()

			srv := newTestServer(runner)
			body, _ := json.Marshal(resolveRequest{Revision: "abc", File: tt.file, Tool: tt.tool})
			req := jsonPost("/api/resolve", body)
			w := httptest.NewRecorder()
			srv.Mux.ServeHTTP(w, req)

			assert.Equal(t, http.StatusOK, w.Code)
		})
	}
}

func TestHandleResolve_InvalidTool(t *testing.T) {
	srv := newTestServer(testutil.NewMockRunner(t))
	body, _ := json.Marshal(resolveRequest{Revision: "abc", File: "file.go", Tool: ":bad"})
	req := jsonPost("/api/resolve", body)
	w := httptest.NewRecorder()
	srv.Mux.ServeHTTP(w, req)

	assert.Equal(t, http.StatusBadRequest, w.Code)
	var resp map[string]string
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &resp))
	assert.Contains(t, resp["error"], "tool must be :ours or :theirs")
}

func TestHandleResolve_MissingFields(t *testing.T) {
	srv := newTestServer(testutil.NewMockRunner(t))

	for _, tt := range []struct {
		name string
		body resolveRequest
	}{
		{"missing revision", resolveRequest{File: "file.go", Tool: ":ours"}},
		{"missing file", resolveRequest{Revision: "abc", Tool: ":ours"}},
	} {
		t.Run(tt.name, func(t *testing.T) {
			body, _ := json.Marshal(tt.body)
			req := jsonPost("/api/resolve", body)
			w := httptest.NewRecorder()
			srv.Mux.ServeHTTP(w, req)
			assert.Equal(t, http.StatusBadRequest, w.Code)
		})
	}
}

func TestHandleResolve_RunnerError(t *testing.T) {
	runner := testutil.NewMockRunner(t)
	runner.Expect(jj.Resolve("abc", "file.go", ":ours")).SetError(errors.New("resolve failed"))
	defer runner.Verify()

	srv := newTestServer(runner)
	body, _ := json.Marshal(resolveRequest{Revision: "abc", File: "file.go", Tool: ":ours"})
	req := jsonPost("/api/resolve", body)
	w := httptest.NewRecorder()
	srv.Mux.ServeHTTP(w, req)

	assert.Equal(t, http.StatusInternalServerError, w.Code)
	var resp map[string]string
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &resp))
	assert.Equal(t, "resolve failed", resp["error"])
}

func TestHandleFiles_WithConflicts(t *testing.T) {
	runner := testutil.NewMockRunner(t)
	runner.Expect(jj.FilesTemplate("abc")).SetOutput(
		[]byte("M\x1Fsrc/main.go\x1F7\x1F3\nM\x1Fconflict.go\x1F5\x1F0\x1Econflict.go\x1F2\x1D"))
	defer runner.Verify()

	srv := newTestServer(runner)
	req := httptest.NewRequest("GET", "/api/files?revision=abc", nil)
	w := httptest.NewRecorder()
	srv.Mux.ServeHTTP(w, req)

	assert.Equal(t, http.StatusOK, w.Code)
	var files []jj.FileChange
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &files))
	assert.Len(t, files, 2)
	assert.False(t, files[0].Conflict)
	assert.Equal(t, 0, files[0].ConflictSides)
	assert.True(t, files[1].Conflict)
	assert.Equal(t, 2, files[1].ConflictSides)
}

func TestHandleFiles_WithConflictOnlyFile(t *testing.T) {
	runner := testutil.NewMockRunner(t)
	runner.Expect(jj.FilesTemplate("abc")).SetOutput(
		[]byte("M\x1Fsrc/main.go\x1F5\x1F0\x1Ephantom.go\x1F2\x1D"))
	defer runner.Verify()

	srv := newTestServer(runner)
	req := httptest.NewRequest("GET", "/api/files?revision=abc", nil)
	w := httptest.NewRecorder()
	srv.Mux.ServeHTTP(w, req)

	assert.Equal(t, http.StatusOK, w.Code)
	var files []jj.FileChange
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &files))
	assert.Len(t, files, 2)
	assert.False(t, files[0].Conflict)
	assert.Equal(t, "phantom.go", files[1].Path)
	assert.True(t, files[1].Conflict)
}

func TestHandleFileShow(t *testing.T) {
	runner := testutil.NewMockRunner(t)
	runner.Expect(jj.FileShow("abc", "src/main.go")).SetOutput([]byte("file content here"))
	defer runner.Verify()

	srv := newTestServer(runner)
	req := httptest.NewRequest("GET", "/api/file-show?revision=abc&path=src/main.go", nil)
	w := httptest.NewRecorder()
	srv.Mux.ServeHTTP(w, req)

	assert.Equal(t, http.StatusOK, w.Code)
	var resp map[string]string
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &resp))
	assert.Equal(t, "file content here", resp["content"])
}

func TestHandleFileShow_MissingParams(t *testing.T) {
	srv := newTestServer(testutil.NewMockRunner(t))

	for _, tt := range []struct {
		name  string
		query string
	}{
		{"missing revision", "path=foo"},
		{"missing path", "revision=abc"},
	} {
		t.Run(tt.name, func(t *testing.T) {
			req := httptest.NewRequest("GET", "/api/file-show?"+tt.query, nil)
			w := httptest.NewRecorder()
			srv.Mux.ServeHTTP(w, req)
			assert.Equal(t, http.StatusBadRequest, w.Code)
		})
	}
}

func TestHandleFileShow_RunnerError(t *testing.T) {
	runner := testutil.NewMockRunner(t)
	runner.Expect(jj.FileShow("abc", "bad.go")).SetError(errors.New("file not found"))
	defer runner.Verify()

	srv := newTestServer(runner)
	req := httptest.NewRequest("GET", "/api/file-show?revision=abc&path=bad.go", nil)
	w := httptest.NewRecorder()
	srv.Mux.ServeHTTP(w, req)

	assert.Equal(t, http.StatusInternalServerError, w.Code)
	var resp map[string]string
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &resp))
	assert.Equal(t, "file not found", resp["error"])
}

// parseLogOutput tests moved to internal/parser/graph_test.go

// --- Edit handler tests ---

func TestHandleEdit(t *testing.T) {
	runner := testutil.NewMockRunner(t)
	runner.Expect(jj.Edit("abc", false)).SetOutput([]byte(""))
	defer runner.Verify()

	srv := newTestServer(runner)
	body, _ := json.Marshal(editRequest{Revision: "abc"})
	req := jsonPost("/api/edit", body)
	w := httptest.NewRecorder()
	srv.Mux.ServeHTTP(w, req)

	assert.Equal(t, http.StatusOK, w.Code)
}

func TestHandleEdit_IgnoreImmutable(t *testing.T) {
	runner := testutil.NewMockRunner(t)
	runner.Expect(jj.Edit("abc", true)).SetOutput([]byte(""))
	defer runner.Verify()

	srv := newTestServer(runner)
	body, _ := json.Marshal(editRequest{Revision: "abc", IgnoreImmutable: true})
	req := jsonPost("/api/edit", body)
	w := httptest.NewRecorder()
	srv.Mux.ServeHTTP(w, req)

	assert.Equal(t, http.StatusOK, w.Code)
}

func TestHandleSquash_RunnerError(t *testing.T) {
	runner := testutil.NewMockRunner(t)
	revs := jj.NewSelectedRevisions(&jj.Commit{ChangeId: "abc"})
	runner.Expect(jj.Squash(revs, "def", nil, false, false, false, false)).SetError(errors.New("squash failed"))
	defer runner.Verify()

	srv := newTestServer(runner)
	body, _ := json.Marshal(squashRequest{Revisions: []string{"abc"}, Destination: "def"})
	req := jsonPost("/api/squash", body)
	w := httptest.NewRecorder()
	srv.Mux.ServeHTTP(w, req)

	assert.Equal(t, http.StatusInternalServerError, w.Code)
	var resp map[string]string
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &resp))
	assert.Equal(t, "squash failed", resp["error"])
}

func TestHandleSquash_WithFiles(t *testing.T) {
	runner := testutil.NewMockRunner(t)
	revs := jj.NewSelectedRevisions(&jj.Commit{ChangeId: "abc"})
	runner.Expect(jj.Squash(revs, "def", []string{"a.go", "b.go"}, false, false, false, false)).SetOutput([]byte(""))
	defer runner.Verify()

	srv := newTestServer(runner)
	body, _ := json.Marshal(squashRequest{Revisions: []string{"abc"}, Destination: "def", Files: []string{"a.go", "b.go"}})
	req := jsonPost("/api/squash", body)
	w := httptest.NewRecorder()
	srv.Mux.ServeHTTP(w, req)

	assert.Equal(t, http.StatusOK, w.Code)
}

func TestHandleSquash_Flags(t *testing.T) {
	runner := testutil.NewMockRunner(t)
	revs := jj.NewSelectedRevisions(&jj.Commit{ChangeId: "abc"})
	runner.Expect(jj.Squash(revs, "def", nil, true, true, false, true)).SetOutput([]byte(""))
	defer runner.Verify()

	srv := newTestServer(runner)
	body, _ := json.Marshal(squashRequest{
		Revisions: []string{"abc"}, Destination: "def",
		KeepEmptied: true, UseDestinationMessage: true, IgnoreImmutable: true,
	})
	req := jsonPost("/api/squash", body)
	w := httptest.NewRecorder()
	srv.Mux.ServeHTTP(w, req)

	assert.Equal(t, http.StatusOK, w.Code)
}

func TestHandleEdit_RunnerError(t *testing.T) {
	runner := testutil.NewMockRunner(t)
	runner.Expect(jj.Edit("abc", false)).SetError(errors.New("edit failed"))
	defer runner.Verify()

	srv := newTestServer(runner)
	body, _ := json.Marshal(editRequest{Revision: "abc"})
	req := jsonPost("/api/edit", body)
	w := httptest.NewRecorder()
	srv.Mux.ServeHTTP(w, req)

	assert.Equal(t, http.StatusInternalServerError, w.Code)
	var resp map[string]string
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &resp))
	assert.Equal(t, "edit failed", resp["error"])
}

// --- Alias handler tests ---

func TestHandleAliases(t *testing.T) {
	runner := testutil.NewMockRunner(t)
	aliasOutput := "aliases.sync = ['git', 'fetch', '-b', 'glob:alice/*']\naliases.evolve = ['rebase', '--skip-emptied']\n"
	runner.Expect(jj.ConfigListAliases()).SetOutput([]byte(aliasOutput))
	defer runner.Verify()

	srv := newTestServer(runner)
	req := httptest.NewRequest("GET", "/api/aliases", nil)
	w := httptest.NewRecorder()
	srv.Mux.ServeHTTP(w, req)

	assert.Equal(t, http.StatusOK, w.Code)
	var aliases []jj.Alias
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &aliases))
	assert.Len(t, aliases, 2)
	assert.Equal(t, "sync", aliases[0].Name)
	assert.Equal(t, []string{"git", "fetch", "-b", "glob:alice/*"}, aliases[0].Command)
}

func TestHandleAliases_NoAliases(t *testing.T) {
	runner := testutil.NewMockRunner(t)
	runner.Expect(jj.ConfigListAliases()).SetError(errors.New("no aliases"))
	defer runner.Verify()

	srv := newTestServer(runner)
	req := httptest.NewRequest("GET", "/api/aliases", nil)
	w := httptest.NewRecorder()
	srv.Mux.ServeHTTP(w, req)

	assert.Equal(t, http.StatusOK, w.Code)
	var aliases []jj.Alias
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &aliases))
	assert.Len(t, aliases, 0)
}

func TestHandleRunAlias(t *testing.T) {
	runner := testutil.NewMockRunner(t)
	aliasOutput := "aliases.sync = ['git', 'fetch']\n"
	runner.Expect(jj.ConfigListAliases()).SetOutput([]byte(aliasOutput))
	runner.Expect([]string{"sync"}).SetOutput([]byte("fetched from origin"))
	defer runner.Verify()

	srv := newTestServer(runner)
	body, _ := json.Marshal(runAliasRequest{Name: "sync"})
	req := jsonPost("/api/alias", body)
	w := httptest.NewRecorder()
	srv.Mux.ServeHTTP(w, req)

	assert.Equal(t, http.StatusOK, w.Code)
	var resp map[string]string
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &resp))
	assert.Equal(t, "fetched from origin", resp["output"])
}

func TestHandleRunAlias_InvalidName(t *testing.T) {
	runner := testutil.NewMockRunner(t)
	aliasOutput := "aliases.sync = ['git', 'fetch']\n"
	runner.Expect(jj.ConfigListAliases()).SetOutput([]byte(aliasOutput))
	defer runner.Verify()

	srv := newTestServer(runner)
	body, _ := json.Marshal(runAliasRequest{Name: "evil-command"})
	req := jsonPost("/api/alias", body)
	w := httptest.NewRecorder()
	srv.Mux.ServeHTTP(w, req)

	assert.Equal(t, http.StatusBadRequest, w.Code)
	var resp map[string]string
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &resp))
	assert.Contains(t, resp["error"], "unknown alias")
}

func TestHandleRunAlias_EmptyName(t *testing.T) {
	runner := testutil.NewMockRunner(t)
	defer runner.Verify()

	srv := newTestServer(runner)
	body, _ := json.Marshal(runAliasRequest{Name: ""})
	req := jsonPost("/api/alias", body)
	w := httptest.NewRecorder()
	srv.Mux.ServeHTTP(w, req)

	assert.Equal(t, http.StatusBadRequest, w.Code)
}

// --- validateFlags equals format tests ---

func TestValidateFlags_EqualsFormat(t *testing.T) {
	assert.NoError(t, validateFlags([]string{"--bookmark=main"}, allowedGitPushFlags))

	err := validateFlags([]string{"--force=true"}, allowedGitPushFlags)
	assert.Error(t, err)
	assert.Contains(t, err.Error(), "flag not allowed: --force=true")
}

func TestHandlePullRequests(t *testing.T) {
	ghJSON := `[{"headRefName":"alice/feature-x","url":"https://github.com/org/repo/pull/123","number":123,"isDraft":false},{"headRefName":"alice/wip","url":"https://github.com/org/repo/pull/42","number":42,"isDraft":true}]`

	runner := testutil.NewMockRunner(t)
	runner.Expect(ghPRListArgv).SetOutput([]byte(ghJSON))
	defer runner.Verify()
	srv := newTestServer(runner)

	req := httptest.NewRequest("GET", "/api/pull-requests", nil)
	w := httptest.NewRecorder()
	srv.Mux.ServeHTTP(w, req)

	assert.Equal(t, http.StatusOK, w.Code)
	var prs []PullRequest
	require.NoError(t, json.NewDecoder(w.Body).Decode(&prs))
	assert.Len(t, prs, 2)
	assert.Equal(t, "alice/feature-x", prs[0].Bookmark)
	assert.Equal(t, 123, prs[0].Number)
	assert.False(t, prs[0].IsDraft)
	assert.Equal(t, "alice/wip", prs[1].Bookmark)
	assert.Equal(t, 42, prs[1].Number)
	assert.True(t, prs[1].IsDraft)
}

func TestHandlePullRequests_GhError(t *testing.T) {
	// gh not installed / not authed / wrong repo → empty list, no 500.
	runner := testutil.NewMockRunner(t)
	runner.Expect(ghPRListArgv).SetError(fmt.Errorf("gh: not authenticated"))
	defer runner.Verify()
	srv := newTestServer(runner)

	req := httptest.NewRequest("GET", "/api/pull-requests", nil)
	w := httptest.NewRecorder()
	srv.Mux.ServeHTTP(w, req)

	assert.Equal(t, http.StatusOK, w.Code)
	var prs []PullRequest
	require.NoError(t, json.NewDecoder(w.Body).Decode(&prs))
	assert.Empty(t, prs)
}

func TestHandlePullRequests_InvalidJSON(t *testing.T) {
	runner := testutil.NewMockRunner(t)
	runner.Expect(ghPRListArgv).SetOutput([]byte("not json"))
	defer runner.Verify()
	srv := newTestServer(runner)

	req := httptest.NewRequest("GET", "/api/pull-requests", nil)
	w := httptest.NewRecorder()
	srv.Mux.ServeHTTP(w, req)

	assert.Equal(t, http.StatusOK, w.Code)
	var prs []PullRequest
	require.NoError(t, json.NewDecoder(w.Body).Decode(&prs))
	assert.Empty(t, prs)
}

// --- Runner error tests for read handlers ---

// runnerErrorTest is a helper that creates a server, expects a command to fail,
// and asserts a 500 response with the error message.
func runnerErrorTest(t *testing.T, method, url string, expectArgs []string, errMsg string, body []byte) {
	t.Helper()
	runner := testutil.NewMockRunner(t)
	runner.Expect(expectArgs).SetError(errors.New(errMsg))
	defer runner.Verify()

	srv := newTestServer(runner)
	var req *http.Request
	if method == "POST" {
		req = jsonPost(url, body)
	} else {
		req = httptest.NewRequest(method, url, nil)
	}
	w := httptest.NewRecorder()
	srv.Mux.ServeHTTP(w, req)

	assert.Equal(t, http.StatusInternalServerError, w.Code)
	var resp map[string]string
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &resp))
	assert.Equal(t, errMsg, resp["error"])
}

func TestHandleBookmarks_RunnerError(t *testing.T) {
	runnerErrorTest(t, "GET", "/api/bookmarks", jj.BookmarkListAll(), "bookmark list failed", nil)
}

func TestHandleDiff_RunnerError(t *testing.T) {
	args := jj.Diff("abc", "", "never", "--tool", ":git")
	runnerErrorTest(t, "GET", "/api/diff?revision=abc", args, "diff failed", nil)
}

func TestHandleGetDescription_RunnerError(t *testing.T) {
	runnerErrorTest(t, "GET", "/api/description?revision=abc", jj.GetDescription("abc"), "description failed", nil)
}

func TestHandleRemotes_RunnerError(t *testing.T) {
	runnerErrorTest(t, "GET", "/api/remotes", jj.GitRemoteList(), "remote list failed", nil)
}

func TestHandleUndo_RunnerError(t *testing.T) {
	body, _ := json.Marshal(struct{}{})
	runnerErrorTest(t, "POST", "/api/undo", jj.Undo(), "undo failed", body)
}

func TestHandleOpLog_RunnerError(t *testing.T) {
	runnerErrorTest(t, "GET", "/api/oplog", jj.OpLog(50), "oplog failed", nil)
}

func TestHandleEvolog_RunnerError(t *testing.T) {
	runnerErrorTest(t, "GET", "/api/evolog?revision=abc", jj.Evolog("abc"), "evolog failed", nil)
}

func TestHandleBookmarkSet_RunnerError(t *testing.T) {
	body, _ := json.Marshal(bookmarkRevisionRequest{Revision: "abc", Name: "main"})
	runnerErrorTest(t, "POST", "/api/bookmark/set", jj.BookmarkSet("abc", "main"), "set failed", body)
}

func TestHandleBookmarkDelete_RunnerError(t *testing.T) {
	body, _ := json.Marshal(bookmarkNameRequest{Name: "main"})
	runnerErrorTest(t, "POST", "/api/bookmark/delete", jj.BookmarkDelete("main"), "delete failed", body)
}

func TestHandleBookmarkMove_RunnerError(t *testing.T) {
	body, _ := json.Marshal(bookmarkRevisionRequest{Revision: "abc", Name: "main"})
	runnerErrorTest(t, "POST", "/api/bookmark/move", jj.BookmarkMove("abc", "main", "--allow-backwards"), "move failed", body)
}

func TestHandleBookmarkAdvance_RunnerError(t *testing.T) {
	body, _ := json.Marshal(bookmarkRevisionRequest{Revision: "abc", Name: "main"})
	runnerErrorTest(t, "POST", "/api/bookmark/advance", jj.BookmarkAdvance("abc", "main"), "advance failed", body)
}

func TestHandleBookmarkForget_RunnerError(t *testing.T) {
	body, _ := json.Marshal(bookmarkNameRequest{Name: "main"})
	runnerErrorTest(t, "POST", "/api/bookmark/forget", jj.BookmarkForget("main"), "forget failed", body)
}

func TestHandleBookmarkTrack_RunnerError(t *testing.T) {
	body, _ := json.Marshal(bookmarkRemoteRequest{Name: "main", Remote: "origin"})
	runnerErrorTest(t, "POST", "/api/bookmark/track", jj.BookmarkTrack("main", "origin"), "track failed", body)
}

func TestHandleBookmarkUntrack_RunnerError(t *testing.T) {
	body, _ := json.Marshal(bookmarkRemoteRequest{Name: "main", Remote: "origin"})
	runnerErrorTest(t, "POST", "/api/bookmark/untrack", jj.BookmarkUntrack("main", "origin"), "untrack failed", body)
}

// --- Bookmark track/untrack validation edge cases ---

func TestHandleBookmarkUntrack_NoRemote(t *testing.T) {
	srv := newTestServer(testutil.NewMockRunner(t))
	body, _ := json.Marshal(bookmarkRemoteRequest{Name: "feature"})
	req := jsonPost("/api/bookmark/untrack", body)
	w := httptest.NewRecorder()
	srv.Mux.ServeHTTP(w, req)

	assert.Equal(t, http.StatusBadRequest, w.Code)
	assert.Contains(t, w.Body.String(), "name and remote are required")
}

func TestHandleBookmarkUntrack_NoName(t *testing.T) {
	srv := newTestServer(testutil.NewMockRunner(t))
	body, _ := json.Marshal(bookmarkRemoteRequest{Remote: "origin"})
	req := jsonPost("/api/bookmark/untrack", body)
	w := httptest.NewRecorder()
	srv.Mux.ServeHTTP(w, req)

	assert.Equal(t, http.StatusBadRequest, w.Code)
	assert.Contains(t, w.Body.String(), "name and remote are required")
}

// --- decodeBody edge case: body exceeding 1MB limit ---

func TestDecodeBody_ExceedsMaxSize(t *testing.T) {
	srv := newTestServer(testutil.NewMockRunner(t))
	// Create a JSON body larger than 1MB
	bigString := strings.Repeat("x", 1<<20+100)
	body := fmt.Appendf(nil, `{"revision":"%s"}`, bigString)
	req := jsonPost("/api/new", body)
	w := httptest.NewRecorder()
	srv.Mux.ServeHTTP(w, req)

	assert.Equal(t, http.StatusBadRequest, w.Code)
}

// --- Content-Type validation ---

func TestDecodeBody_MissingContentType(t *testing.T) {
	srv := newTestServer(testutil.NewMockRunner(t))
	body := []byte(`{"revisions":["abc"]}`)
	req := httptest.NewRequest("POST", "/api/new", bytes.NewReader(body))
	// Intentionally no Content-Type header
	w := httptest.NewRecorder()
	srv.Mux.ServeHTTP(w, req)

	assert.Equal(t, http.StatusBadRequest, w.Code)
	assert.Contains(t, w.Body.String(), "Content-Type must be application/json")
}

func TestDecodeBody_WrongContentType(t *testing.T) {
	srv := newTestServer(testutil.NewMockRunner(t))
	body := []byte(`{"revisions":["abc"]}`)
	req := httptest.NewRequest("POST", "/api/new", bytes.NewReader(body))
	req.Header.Set("Content-Type", "text/plain")
	w := httptest.NewRecorder()
	srv.Mux.ServeHTTP(w, req)

	assert.Equal(t, http.StatusBadRequest, w.Code)
	assert.Contains(t, w.Body.String(), "Content-Type must be application/json")
}

// --- DiffRange runner error test ---

func TestHandleDiffRange_RunnerError(t *testing.T) {
	runnerErrorTest(t, "GET", "/api/diff-range?from=abc&to=def", jj.DiffRange("abc", "def", nil), "diff-range failed", nil)
}

// --- HTTP method enforcement ---

func TestMethodNotAllowed(t *testing.T) {
	// Go 1.22 method-prefixed route patterns ("GET /api/log", "POST /api/new")
	// automatically return 405 for mismatched methods. This test locks in that
	// behaviour — removing the method prefix from a route would silently let
	// POST hit a read handler (or GET hit a mutation), which we want caught.
	srv := newTestServer(testutil.NewMockRunner(t))
	cases := []struct {
		method, path string
	}{
		{"POST", "/api/log"},       // read endpoint
		{"GET", "/api/new"},        // mutation endpoint
		{"DELETE", "/api/abandon"}, // wrong method entirely
		{"GET", "/api/bookmark/set"},
	}
	for _, tc := range cases {
		req := httptest.NewRequest(tc.method, tc.path, nil)
		w := httptest.NewRecorder()
		srv.Mux.ServeHTTP(w, req)
		assert.Equal(t, http.StatusMethodNotAllowed, w.Code, "%s %s", tc.method, tc.path)
		assert.NotEmpty(t, w.Header().Get("Allow"), "%s %s should set Allow header", tc.method, tc.path)
	}
}

func TestHandleFileWrite(t *testing.T) {
	t.Run("success", func(t *testing.T) {
		dir := t.TempDir()
		runner := testutil.NewMockRunner(t)
		runner.Allow(jj.CurrentOpId()).SetOutput([]byte("abc123"))
		srv := NewServer(runner, dir)

		body, _ := json.Marshal(fileWriteRequest{Path: "hello.txt", Content: "hello world"})
		req := jsonPost("/api/file-write", body)
		w := httptest.NewRecorder()
		srv.Mux.ServeHTTP(w, req)

		assert.Equal(t, http.StatusOK, w.Code)
		data, err := os.ReadFile(filepath.Join(dir, "hello.txt"))
		require.NoError(t, err)
		assert.Equal(t, "hello world", string(data))
	})

	t.Run("subdirectory", func(t *testing.T) {
		dir := t.TempDir()
		require.NoError(t, os.MkdirAll(filepath.Join(dir, "src"), 0755))
		runner := testutil.NewMockRunner(t)
		runner.Allow(jj.CurrentOpId()).SetOutput([]byte("abc123"))
		srv := NewServer(runner, dir)

		body, _ := json.Marshal(fileWriteRequest{Path: "src/main.go", Content: "package main"})
		req := jsonPost("/api/file-write", body)
		w := httptest.NewRecorder()
		srv.Mux.ServeHTTP(w, req)

		assert.Equal(t, http.StatusOK, w.Code)
		data, err := os.ReadFile(filepath.Join(dir, "src", "main.go"))
		require.NoError(t, err)
		assert.Equal(t, "package main", string(data))
	})

	t.Run("missing path", func(t *testing.T) {
		runner := testutil.NewMockRunner(t)
		runner.Allow(jj.CurrentOpId()).SetOutput([]byte("abc123"))
		srv := NewServer(runner, "/tmp")

		body, _ := json.Marshal(fileWriteRequest{Content: "data"})
		req := jsonPost("/api/file-write", body)
		w := httptest.NewRecorder()
		srv.Mux.ServeHTTP(w, req)

		assert.Equal(t, http.StatusBadRequest, w.Code)
	})

	t.Run("path traversal", func(t *testing.T) {
		dir := t.TempDir()
		runner := testutil.NewMockRunner(t)
		runner.Allow(jj.CurrentOpId()).SetOutput([]byte("abc123"))
		srv := NewServer(runner, dir)

		for _, p := range []string{"../etc/passwd", "foo/../../etc/passwd", "/etc/passwd"} {
			body, _ := json.Marshal(fileWriteRequest{Path: p, Content: "pwned"})
			req := jsonPost("/api/file-write", body)
			w := httptest.NewRecorder()
			srv.Mux.ServeHTTP(w, req)
			assert.Equal(t, http.StatusBadRequest, w.Code, "path %q should be rejected", p)
		}
	})

	t.Run("internal paths", func(t *testing.T) {
		dir := t.TempDir()
		runner := testutil.NewMockRunner(t)
		runner.Allow(jj.CurrentOpId()).SetOutput([]byte("abc123"))
		srv := NewServer(runner, dir)

		for _, p := range []string{".jj/repo/store", ".git/config", ".git/hooks/pre-commit"} {
			body, _ := json.Marshal(fileWriteRequest{Path: p, Content: "bad"})
			req := jsonPost("/api/file-write", body)
			w := httptest.NewRecorder()
			srv.Mux.ServeHTTP(w, req)
			assert.Equal(t, http.StatusBadRequest, w.Code, "path %q should be rejected", p)
		}
	})

	t.Run("allows jj-prefixed non-internal files", func(t *testing.T) {
		dir := t.TempDir()
		runner := testutil.NewMockRunner(t)
		runner.Allow(jj.CurrentOpId()).SetOutput([]byte("abc123"))
		srv := NewServer(runner, dir)

		body, _ := json.Marshal(fileWriteRequest{Path: ".jjignore", Content: "*.tmp"})
		req := jsonPost("/api/file-write", body)
		w := httptest.NewRecorder()
		srv.Mux.ServeHTTP(w, req)
		assert.Equal(t, http.StatusOK, w.Code)
	})

	t.Run("symlink escape", func(t *testing.T) {
		dir := t.TempDir()
		target := t.TempDir() // separate dir to simulate outside-repo target
		require.NoError(t, os.Symlink(target, filepath.Join(dir, "escape")))

		runner := testutil.NewMockRunner(t)
		runner.Allow(jj.CurrentOpId()).SetOutput([]byte("abc123"))
		srv := NewServer(runner, dir)

		body, _ := json.Marshal(fileWriteRequest{Path: "escape/evil.txt", Content: "pwned"})
		req := jsonPost("/api/file-write", body)
		w := httptest.NewRecorder()
		srv.Mux.ServeHTTP(w, req)
		assert.Equal(t, http.StatusBadRequest, w.Code)
		// Verify no file was written
		_, err := os.Stat(filepath.Join(target, "evil.txt"))
		assert.True(t, os.IsNotExist(err), "file should not have been written outside repo")
	})

	t.Run("leaf symlink escape", func(t *testing.T) {
		dir := t.TempDir()
		target := filepath.Join(t.TempDir(), "stolen.txt")
		// Create a symlink at the file level: repo/link.txt -> /tmp/.../stolen.txt
		require.NoError(t, os.Symlink(target, filepath.Join(dir, "link.txt")))

		runner := testutil.NewMockRunner(t)
		runner.Allow(jj.CurrentOpId()).SetOutput([]byte("abc123"))
		srv := NewServer(runner, dir)

		body, _ := json.Marshal(fileWriteRequest{Path: "link.txt", Content: "pwned"})
		req := jsonPost("/api/file-write", body)
		w := httptest.NewRecorder()
		srv.Mux.ServeHTTP(w, req)
		assert.Equal(t, http.StatusBadRequest, w.Code)
		assert.Contains(t, w.Body.String(), "symlink")
		// Verify no file was written at the symlink target
		_, err := os.Stat(target)
		assert.True(t, os.IsNotExist(err), "file should not have been written via symlink")
	})

	t.Run("null byte in path", func(t *testing.T) {
		dir := t.TempDir()
		runner := testutil.NewMockRunner(t)
		runner.Allow(jj.CurrentOpId()).SetOutput([]byte("abc123"))
		srv := NewServer(runner, dir)

		body, _ := json.Marshal(fileWriteRequest{Path: "foo\x00bar", Content: "bad"})
		req := jsonPost("/api/file-write", body)
		w := httptest.NewRecorder()
		srv.Mux.ServeHTTP(w, req)
		assert.Equal(t, http.StatusBadRequest, w.Code)
	})

	t.Run("ssh mode", func(t *testing.T) {
		runner := testutil.NewMockRunner(t)
		runner.Allow(jj.CurrentOpId()).SetOutput([]byte("abc123"))
		srv := NewServer(runner, "") // empty RepoDir = SSH mode

		body, _ := json.Marshal(fileWriteRequest{Path: "file.txt", Content: "data"})
		req := jsonPost("/api/file-write", body)
		w := httptest.NewRecorder()
		srv.Mux.ServeHTTP(w, req)

		assert.Equal(t, http.StatusNotImplemented, w.Code)
	})
}
