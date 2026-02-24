package api

import (
	"bytes"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/iant/lightjj/internal/jj"
	"github.com/iant/lightjj/internal/parser"
	"github.com/iant/lightjj/testutil"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// newTestServer creates a Server with the op-id command pre-allowed on the mock.
func newTestServer(runner *testutil.MockRunner) *Server {
	runner.Allow(jj.CurrentOpId()).SetOutput([]byte("abc123"))
	return NewServer(runner)
}

// jsonPost creates a POST request with Content-Type: application/json.
func jsonPost(url string, body []byte) *http.Request {
	req := httptest.NewRequest("POST", url, bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	return req
}

func TestOpIdHeader(t *testing.T) {
	runner := testutil.NewMockRunner(t)
	runner.Expect(jj.LogGraph("", 0)).SetOutput([]byte(""))
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
	graphOutput := "@  _PREFIX:abc_PREFIX:xyz_PREFIX:false\x1fabcdefgh\x1fxyz12345\x1fmy commit\x1f\x1fmain\n"
	runner.Expect(jj.LogGraph("@", 0)).SetOutput([]byte(graphOutput))
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
	runner.Expect(jj.LogGraph("", 0)).SetOutput([]byte(""))
	defer runner.Verify()

	srv := newTestServer(runner)
	req := httptest.NewRequest("GET", "/api/log", nil)
	w := httptest.NewRecorder()
	srv.Mux.ServeHTTP(w, req)

	assert.Equal(t, http.StatusOK, w.Code)
}

func TestHandleBookmarks(t *testing.T) {
	runner := testutil.NewMockRunner(t)
	runner.Expect(jj.BookmarkListAll()).SetOutput([]byte("main\x1f.\x1ffalse\x1ffalse\x1ffalse\x1fabc"))
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
	runner.Expect(jj.GitPush("--bookmark", "main")).SetOutput([]byte(""))
	defer runner.Verify()

	srv := newTestServer(runner)
	body, _ := json.Marshal(gitFlagsRequest{Flags: []string{"--bookmark", "main"}})
	req := jsonPost("/api/git/push", body)
	w := httptest.NewRecorder()
	srv.Mux.ServeHTTP(w, req)

	assert.Equal(t, http.StatusOK, w.Code)
}

func TestHandleFiles(t *testing.T) {
	runner := testutil.NewMockRunner(t)
	runner.Expect(jj.DiffSummary("abc")).SetOutput([]byte("M src/main.go\nA new.go\n"))
	runner.Expect(jj.DiffStat("abc")).SetOutput([]byte(" src/main.go | 10 +++++++---\n new.go      |  5 +++++\n 2 files changed, 12 insertions(+), 3 deletions(-)\n"))
	runner.Allow(jj.ResolveList("abc")).SetOutput([]byte(""))
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
	runner.Expect(jj.DiffSummary("abc")).SetOutput([]byte(""))
	runner.Expect(jj.DiffStat("abc")).SetOutput([]byte(""))
	runner.Allow(jj.ResolveList("abc")).SetOutput([]byte(""))
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
	runner.Expect(jj.LogGraph("@", 0)).SetError(errors.New("jj failed"))
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
	body, _ := json.Marshal(map[string]any{"revisions": []string{"abc"}})
	req := httptest.NewRequest("POST", "/api/new", bytes.NewReader(body))
	// No Content-Type header
	w := httptest.NewRecorder()
	srv.Mux.ServeHTTP(w, req)

	assert.Equal(t, http.StatusBadRequest, w.Code)
	assert.Contains(t, w.Body.String(), "Content-Type must be application/json")
}

func TestContentTypeRequired_Undo(t *testing.T) {
	srv := newTestServer(testutil.NewMockRunner(t))
	req := httptest.NewRequest("POST", "/api/undo", bytes.NewReader([]byte("{}")))
	// No Content-Type header — undo must also enforce the check
	w := httptest.NewRecorder()
	srv.Mux.ServeHTTP(w, req)

	assert.Equal(t, http.StatusBadRequest, w.Code)
	assert.Contains(t, w.Body.String(), "Content-Type must be application/json")
}

func TestHandleGitPush_DisallowedFlag(t *testing.T) {
	srv := newTestServer(testutil.NewMockRunner(t))
	body, _ := json.Marshal(gitFlagsRequest{Flags: []string{"--force"}})
	req := jsonPost("/api/git/push", body)
	w := httptest.NewRecorder()
	srv.Mux.ServeHTTP(w, req)

	assert.Equal(t, http.StatusBadRequest, w.Code)
	var resp map[string]string
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &resp))
	assert.Contains(t, resp["error"], "flag not allowed")
}

func TestHandleGitFetch_DisallowedFlag(t *testing.T) {
	srv := newTestServer(testutil.NewMockRunner(t))
	body, _ := json.Marshal(gitFlagsRequest{Flags: []string{"--force"}})
	req := jsonPost("/api/git/fetch", body)
	w := httptest.NewRecorder()
	srv.Mux.ServeHTTP(w, req)

	assert.Equal(t, http.StatusBadRequest, w.Code)
	var resp map[string]string
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &resp))
	assert.Contains(t, resp["error"], "flag not allowed")
}

func TestHandleLog_InvalidLimit(t *testing.T) {
	srv := newTestServer(testutil.NewMockRunner(t))
	req := httptest.NewRequest("GET", "/api/log?limit=notanumber", nil)
	w := httptest.NewRecorder()
	srv.Mux.ServeHTTP(w, req)

	assert.Equal(t, http.StatusBadRequest, w.Code)
}

func TestHandleEdit_MissingRevision(t *testing.T) {
	srv := newTestServer(testutil.NewMockRunner(t))
	body, _ := json.Marshal(editRequest{})
	req := jsonPost("/api/edit", body)
	w := httptest.NewRecorder()
	srv.Mux.ServeHTTP(w, req)

	assert.Equal(t, http.StatusBadRequest, w.Code)
}

func TestHandleRebase_MissingFields(t *testing.T) {
	srv := newTestServer(testutil.NewMockRunner(t))

	// Missing revisions
	body, _ := json.Marshal(rebaseRequest{Destination: "def"})
	req := jsonPost("/api/rebase", body)
	w := httptest.NewRecorder()
	srv.Mux.ServeHTTP(w, req)
	assert.Equal(t, http.StatusBadRequest, w.Code)

	// Missing destination
	body, _ = json.Marshal(rebaseRequest{Revisions: []string{"abc"}})
	req = jsonPost("/api/rebase", body)
	w = httptest.NewRecorder()
	srv.Mux.ServeHTTP(w, req)
	assert.Equal(t, http.StatusBadRequest, w.Code)
}

func TestHandleBookmarkSet_MissingFields(t *testing.T) {
	srv := newTestServer(testutil.NewMockRunner(t))
	body, _ := json.Marshal(bookmarkRevisionRequest{Revision: "abc"})
	req := jsonPost("/api/bookmark/set", body)
	w := httptest.NewRecorder()
	srv.Mux.ServeHTTP(w, req)
	assert.Equal(t, http.StatusBadRequest, w.Code)
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

func TestHandleStatus(t *testing.T) {
	runner := testutil.NewMockRunner(t)
	runner.Expect(jj.Status("abc")).SetOutput([]byte("M src/main.go\n"))
	defer runner.Verify()

	srv := newTestServer(runner)
	req := httptest.NewRequest("GET", "/api/status?revision=abc", nil)
	w := httptest.NewRecorder()
	srv.Mux.ServeHTTP(w, req)

	assert.Equal(t, http.StatusOK, w.Code)
	var resp map[string]string
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &resp))
	assert.Contains(t, resp["status"], "M src/main.go")
}

func TestHandleStatus_MissingRevision(t *testing.T) {
	srv := newTestServer(testutil.NewMockRunner(t))
	req := httptest.NewRequest("GET", "/api/status", nil)
	w := httptest.NewRecorder()
	srv.Mux.ServeHTTP(w, req)

	assert.Equal(t, http.StatusBadRequest, w.Code)
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
	runner.Expect(jj.LogGraph("", 0)).SetOutput([]byte(""))
	defer runner.Verify()

	srv := NewServer(runner)
	req := httptest.NewRequest("GET", "/api/log", nil)
	w := httptest.NewRecorder()
	srv.Mux.ServeHTTP(w, req)

	assert.Equal(t, http.StatusOK, w.Code)
	// When op-id fetch fails, header should be absent
	assert.Empty(t, w.Header().Get("X-JJ-Op-Id"))
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
	runner.Expect(jj.Evolog("abc")).SetOutput([]byte("evolution log output"))
	defer runner.Verify()

	srv := newTestServer(runner)
	req := httptest.NewRequest("GET", "/api/evolog?revision=abc", nil)
	w := httptest.NewRecorder()
	srv.Mux.ServeHTTP(w, req)

	assert.Equal(t, http.StatusOK, w.Code)
	var resp map[string]string
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &resp))
	assert.Equal(t, "evolution log output", resp["output"])
}

func TestHandleEvolog_MissingRevision(t *testing.T) {
	srv := newTestServer(testutil.NewMockRunner(t))
	req := httptest.NewRequest("GET", "/api/evolog", nil)
	w := httptest.NewRecorder()
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

func TestHandleBookmarkDelete_MissingName(t *testing.T) {
	srv := newTestServer(testutil.NewMockRunner(t))
	body, _ := json.Marshal(bookmarkNameRequest{})
	req := jsonPost("/api/bookmark/delete", body)
	w := httptest.NewRecorder()
	srv.Mux.ServeHTTP(w, req)

	assert.Equal(t, http.StatusBadRequest, w.Code)
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

func TestHandleRebase_SourceModeS(t *testing.T) {
	runner := testutil.NewMockRunner(t)
	revs := jj.NewSelectedRevisions(&jj.Commit{ChangeId: "abc"})
	runner.Expect(jj.Rebase(revs, "def", "-s", "-d", false, false)).SetOutput([]byte(""))
	defer runner.Verify()

	srv := newTestServer(runner)
	body, _ := json.Marshal(rebaseRequest{Revisions: []string{"abc"}, Destination: "def", SourceMode: "-s"})
	req := jsonPost("/api/rebase", body)
	w := httptest.NewRecorder()
	srv.Mux.ServeHTTP(w, req)

	assert.Equal(t, http.StatusOK, w.Code)
}

func TestHandleRebase_SourceModeB(t *testing.T) {
	runner := testutil.NewMockRunner(t)
	revs := jj.NewSelectedRevisions(&jj.Commit{ChangeId: "abc"})
	runner.Expect(jj.Rebase(revs, "def", "-b", "-d", false, false)).SetOutput([]byte(""))
	defer runner.Verify()

	srv := newTestServer(runner)
	body, _ := json.Marshal(rebaseRequest{Revisions: []string{"abc"}, Destination: "def", SourceMode: "-b"})
	req := jsonPost("/api/rebase", body)
	w := httptest.NewRecorder()
	srv.Mux.ServeHTTP(w, req)

	assert.Equal(t, http.StatusOK, w.Code)
}

func TestHandleRebase_TargetModeInsertAfter(t *testing.T) {
	runner := testutil.NewMockRunner(t)
	revs := jj.NewSelectedRevisions(&jj.Commit{ChangeId: "abc"})
	runner.Expect(jj.Rebase(revs, "def", "-r", "--insert-after", false, false)).SetOutput([]byte(""))
	defer runner.Verify()

	srv := newTestServer(runner)
	body, _ := json.Marshal(rebaseRequest{Revisions: []string{"abc"}, Destination: "def", TargetMode: "--insert-after"})
	req := jsonPost("/api/rebase", body)
	w := httptest.NewRecorder()
	srv.Mux.ServeHTTP(w, req)

	assert.Equal(t, http.StatusOK, w.Code)
}

func TestHandleRebase_TargetModeInsertBefore(t *testing.T) {
	runner := testutil.NewMockRunner(t)
	revs := jj.NewSelectedRevisions(&jj.Commit{ChangeId: "abc"})
	runner.Expect(jj.Rebase(revs, "def", "-r", "--insert-before", false, false)).SetOutput([]byte(""))
	defer runner.Verify()

	srv := newTestServer(runner)
	body, _ := json.Marshal(rebaseRequest{Revisions: []string{"abc"}, Destination: "def", TargetMode: "--insert-before"})
	req := jsonPost("/api/rebase", body)
	w := httptest.NewRecorder()
	srv.Mux.ServeHTTP(w, req)

	assert.Equal(t, http.StatusOK, w.Code)
}

func TestHandleRebase_InvalidSourceMode(t *testing.T) {
	srv := newTestServer(testutil.NewMockRunner(t))
	body, _ := json.Marshal(rebaseRequest{Revisions: []string{"abc"}, Destination: "def", SourceMode: "--bad"})
	req := jsonPost("/api/rebase", body)
	w := httptest.NewRecorder()
	srv.Mux.ServeHTTP(w, req)

	assert.Equal(t, http.StatusBadRequest, w.Code)
	var resp map[string]string
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &resp))
	assert.Contains(t, resp["error"], "invalid source_mode")
}

func TestHandleRebase_InvalidTargetMode(t *testing.T) {
	srv := newTestServer(testutil.NewMockRunner(t))
	body, _ := json.Marshal(rebaseRequest{Revisions: []string{"abc"}, Destination: "def", TargetMode: "--bad"})
	req := jsonPost("/api/rebase", body)
	w := httptest.NewRecorder()
	srv.Mux.ServeHTTP(w, req)

	assert.Equal(t, http.StatusBadRequest, w.Code)
	var resp map[string]string
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &resp))
	assert.Contains(t, resp["error"], "invalid target_mode")
}

func TestHandleRebase_EmptySourceModeDefaultsToR(t *testing.T) {
	runner := testutil.NewMockRunner(t)
	revs := jj.NewSelectedRevisions(&jj.Commit{ChangeId: "abc"})
	// Omitting SourceMode — should default to "-r"
	runner.Expect(jj.Rebase(revs, "def", "-r", "-d", false, false)).SetOutput([]byte(""))
	defer runner.Verify()

	srv := newTestServer(runner)
	body, _ := json.Marshal(rebaseRequest{Revisions: []string{"abc"}, Destination: "def"})
	req := jsonPost("/api/rebase", body)
	w := httptest.NewRecorder()
	srv.Mux.ServeHTTP(w, req)

	assert.Equal(t, http.StatusOK, w.Code)
}

func TestHandleRebase_EmptyTargetModeDefaultsToD(t *testing.T) {
	runner := testutil.NewMockRunner(t)
	revs := jj.NewSelectedRevisions(&jj.Commit{ChangeId: "abc"})
	// Omitting TargetMode — should default to "-d"
	runner.Expect(jj.Rebase(revs, "def", "-r", "-d", false, false)).SetOutput([]byte(""))
	defer runner.Verify()

	srv := newTestServer(runner)
	body, _ := json.Marshal(rebaseRequest{Revisions: []string{"abc"}, Destination: "def"})
	req := jsonPost("/api/rebase", body)
	w := httptest.NewRecorder()
	srv.Mux.ServeHTTP(w, req)

	assert.Equal(t, http.StatusOK, w.Code)
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
	runner := testutil.NewMockRunner(t)
	runner.Expect(jj.BookmarkTrack("feature", "")).SetOutput([]byte(""))
	defer runner.Verify()

	srv := newTestServer(runner)
	body, _ := json.Marshal(bookmarkRemoteRequest{Name: "feature"})
	req := jsonPost("/api/bookmark/track", body)
	w := httptest.NewRecorder()
	srv.Mux.ServeHTTP(w, req)

	assert.Equal(t, http.StatusOK, w.Code)
}

func TestHandleBookmarkTrack_MissingName(t *testing.T) {
	srv := newTestServer(testutil.NewMockRunner(t))
	body, _ := json.Marshal(bookmarkRemoteRequest{Remote: "origin"})
	req := jsonPost("/api/bookmark/track", body)
	w := httptest.NewRecorder()
	srv.Mux.ServeHTTP(w, req)

	assert.Equal(t, http.StatusBadRequest, w.Code)
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

func TestHandleBookmarkUntrack_MissingName(t *testing.T) {
	srv := newTestServer(testutil.NewMockRunner(t))
	body, _ := json.Marshal(bookmarkRemoteRequest{Remote: "origin"})
	req := jsonPost("/api/bookmark/untrack", body)
	w := httptest.NewRecorder()
	srv.Mux.ServeHTTP(w, req)

	assert.Equal(t, http.StatusBadRequest, w.Code)
}

// --- Empty revision tests ---

func TestHandleNew_EmptyRevisions(t *testing.T) {
	srv := newTestServer(testutil.NewMockRunner(t))
	body, _ := json.Marshal(newRequest{Revisions: []string{}})
	req := jsonPost("/api/new", body)
	w := httptest.NewRecorder()
	srv.Mux.ServeHTTP(w, req)

	assert.Equal(t, http.StatusBadRequest, w.Code)
}

func TestHandleAbandon_EmptyRevisions(t *testing.T) {
	srv := newTestServer(testutil.NewMockRunner(t))
	body, _ := json.Marshal(abandonRequest{Revisions: []string{}})
	req := jsonPost("/api/abandon", body)
	w := httptest.NewRecorder()
	srv.Mux.ServeHTTP(w, req)

	assert.Equal(t, http.StatusBadRequest, w.Code)
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
	runner := testutil.NewMockRunner(t)
	runner.Expect(jj.GitPush("--all")).SetError(errors.New("push failed"))
	defer runner.Verify()

	srv := newTestServer(runner)
	body, _ := json.Marshal(gitFlagsRequest{Flags: []string{"--all"}})
	req := jsonPost("/api/git/push", body)
	w := httptest.NewRecorder()
	srv.Mux.ServeHTTP(w, req)

	assert.Equal(t, http.StatusInternalServerError, w.Code)
}

// --- Bookmarks with revset test ---

func TestHandleBookmarks_WithRevset(t *testing.T) {
	runner := testutil.NewMockRunner(t)
	runner.Expect(jj.BookmarkList("main")).SetOutput([]byte("main\x1f.\x1ffalse\x1ffalse\x1ffalse\x1fabc"))
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

// --- Missing validation tests ---

func TestHandleBookmarkMove_MissingFields(t *testing.T) {
	srv := newTestServer(testutil.NewMockRunner(t))
	body, _ := json.Marshal(bookmarkRevisionRequest{Revision: "abc"})
	req := jsonPost("/api/bookmark/move", body)
	w := httptest.NewRecorder()
	srv.Mux.ServeHTTP(w, req)
	assert.Equal(t, http.StatusBadRequest, w.Code)
}

func TestHandleBookmarkForget_MissingName(t *testing.T) {
	srv := newTestServer(testutil.NewMockRunner(t))
	body, _ := json.Marshal(bookmarkNameRequest{})
	req := jsonPost("/api/bookmark/forget", body)
	w := httptest.NewRecorder()
	srv.Mux.ServeHTTP(w, req)
	assert.Equal(t, http.StatusBadRequest, w.Code)
}

func TestHandleDescribe_MissingRevision(t *testing.T) {
	srv := newTestServer(testutil.NewMockRunner(t))
	body, _ := json.Marshal(describeRequest{Description: "test"})
	req := jsonPost("/api/describe", body)
	w := httptest.NewRecorder()
	srv.Mux.ServeHTTP(w, req)
	assert.Equal(t, http.StatusBadRequest, w.Code)
}

func TestHandleFiles_SummaryError(t *testing.T) {
	runner := testutil.NewMockRunner(t)
	runner.Expect(jj.DiffSummary("abc")).SetError(errors.New("summary failed"))
	runner.Expect(jj.DiffStat("abc")).SetOutput([]byte(""))
	runner.Allow(jj.ResolveList("abc")).SetOutput([]byte(""))
	defer runner.Verify()

	srv := newTestServer(runner)
	req := httptest.NewRequest("GET", "/api/files?revision=abc", nil)
	w := httptest.NewRecorder()
	srv.Mux.ServeHTTP(w, req)
	assert.Equal(t, http.StatusInternalServerError, w.Code)
}

func TestHandleFiles_StatError(t *testing.T) {
	runner := testutil.NewMockRunner(t)
	runner.Expect(jj.DiffSummary("abc")).SetOutput([]byte("M src/main.go\n"))
	runner.Expect(jj.DiffStat("abc")).SetError(errors.New("stat failed"))
	runner.Allow(jj.ResolveList("abc")).SetOutput([]byte(""))
	defer runner.Verify()

	srv := newTestServer(runner)
	req := httptest.NewRequest("GET", "/api/files?revision=abc", nil)
	w := httptest.NewRecorder()
	srv.Mux.ServeHTTP(w, req)

	assert.Equal(t, http.StatusOK, w.Code)
	var files []jj.FileChange
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &files))
	assert.Len(t, files, 1)
	assert.Equal(t, 0, files[0].Additions) // stats not merged due to error
	assert.Equal(t, 0, files[0].Deletions)
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
	runner.Expect(jj.WorkspaceList()).SetOutput([]byte("base2: skpssuxl a14ce848 Architecture review\ndefault: qqqqpqpq bbbbbbbb Other\n"))
	defer runner.Verify()

	srv := newTestServer(runner)
	req := httptest.NewRequest("GET", "/api/workspaces", nil)
	w := httptest.NewRecorder()
	srv.Mux.ServeHTTP(w, req)

	assert.Equal(t, http.StatusOK, w.Code)
	var workspaces []jj.Workspace
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &workspaces))
	require.Len(t, workspaces, 2)
	assert.Equal(t, "base2", workspaces[0].Name)
	assert.Equal(t, "skpssuxl", workspaces[0].ChangeId)
	assert.Equal(t, "default", workspaces[1].Name)
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

func TestHandleSplit_MissingRevision(t *testing.T) {
	srv := newTestServer(testutil.NewMockRunner(t))
	body, _ := json.Marshal(splitRequest{Files: []string{"file.go"}})
	req := jsonPost("/api/split", body)
	w := httptest.NewRecorder()
	srv.Mux.ServeHTTP(w, req)

	assert.Equal(t, http.StatusBadRequest, w.Code)
}

func TestHandleSplit_MissingFiles(t *testing.T) {
	srv := newTestServer(testutil.NewMockRunner(t))
	body, _ := json.Marshal(splitRequest{Revision: "abc"})
	req := jsonPost("/api/split", body)
	w := httptest.NewRecorder()
	srv.Mux.ServeHTTP(w, req)

	assert.Equal(t, http.StatusBadRequest, w.Code)
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
	runner := testutil.NewMockRunner(t)
	runner.Expect(jj.Resolve("abc", "src/main.go", ":ours")).SetOutput([]byte(""))
	defer runner.Verify()

	srv := newTestServer(runner)
	body, _ := json.Marshal(resolveRequest{Revision: "abc", File: "src/main.go", Tool: ":ours"})
	req := jsonPost("/api/resolve", body)
	w := httptest.NewRecorder()
	srv.Mux.ServeHTTP(w, req)

	assert.Equal(t, http.StatusOK, w.Code)
}

func TestHandleResolve_Theirs(t *testing.T) {
	runner := testutil.NewMockRunner(t)
	runner.Expect(jj.Resolve("abc", "README.md", ":theirs")).SetOutput([]byte(""))
	defer runner.Verify()

	srv := newTestServer(runner)
	body, _ := json.Marshal(resolveRequest{Revision: "abc", File: "README.md", Tool: ":theirs"})
	req := jsonPost("/api/resolve", body)
	w := httptest.NewRecorder()
	srv.Mux.ServeHTTP(w, req)

	assert.Equal(t, http.StatusOK, w.Code)
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

	// Missing revision
	body, _ := json.Marshal(resolveRequest{File: "file.go", Tool: ":ours"})
	req := jsonPost("/api/resolve", body)
	w := httptest.NewRecorder()
	srv.Mux.ServeHTTP(w, req)
	assert.Equal(t, http.StatusBadRequest, w.Code)

	// Missing file
	body, _ = json.Marshal(resolveRequest{Revision: "abc", Tool: ":ours"})
	req = jsonPost("/api/resolve", body)
	w = httptest.NewRecorder()
	srv.Mux.ServeHTTP(w, req)
	assert.Equal(t, http.StatusBadRequest, w.Code)
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
	runner.Expect(jj.DiffSummary("abc")).SetOutput([]byte("M src/main.go\nM conflict.go\n"))
	runner.Expect(jj.DiffStat("abc")).SetOutput([]byte(" src/main.go | 10 +++++++---\n conflict.go |  5 +++++\n 2 files changed, 12 insertions(+), 3 deletions(-)\n"))
	runner.Expect(jj.ResolveList("abc")).SetOutput([]byte("conflict.go    2-sided conflict\n"))
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
	assert.True(t, files[1].Conflict)
}

func TestHandleFiles_WithConflictOnlyFile(t *testing.T) {
	runner := testutil.NewMockRunner(t)
	runner.Expect(jj.DiffSummary("abc")).SetOutput([]byte("M src/main.go\n"))
	runner.Expect(jj.DiffStat("abc")).SetOutput([]byte(" src/main.go | 5 +++++\n 1 file changed\n"))
	runner.Expect(jj.ResolveList("abc")).SetOutput([]byte("phantom.go    2-sided conflict\n"))
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

func TestHandleFiles_ConflictError(t *testing.T) {
	runner := testutil.NewMockRunner(t)
	runner.Expect(jj.DiffSummary("abc")).SetOutput([]byte("M src/main.go\n"))
	runner.Expect(jj.DiffStat("abc")).SetOutput([]byte(""))
	runner.Expect(jj.ResolveList("abc")).SetError(errors.New("resolve list failed"))
	defer runner.Verify()

	srv := newTestServer(runner)
	req := httptest.NewRequest("GET", "/api/files?revision=abc", nil)
	w := httptest.NewRecorder()
	srv.Mux.ServeHTTP(w, req)

	assert.Equal(t, http.StatusOK, w.Code)
	var files []jj.FileChange
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &files))
	assert.Len(t, files, 1)
	assert.False(t, files[0].Conflict) // graceful: no conflict data on error
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

	req := httptest.NewRequest("GET", "/api/file-show?path=foo", nil)
	w := httptest.NewRecorder()
	srv.Mux.ServeHTTP(w, req)
	assert.Equal(t, http.StatusBadRequest, w.Code)

	req = httptest.NewRequest("GET", "/api/file-show?revision=abc", nil)
	w = httptest.NewRecorder()
	srv.Mux.ServeHTTP(w, req)
	assert.Equal(t, http.StatusBadRequest, w.Code)
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
