package api

import (
	"bytes"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/chronologos/lightjj/internal/jj"
	"github.com/chronologos/lightjj/internal/parser"
	"github.com/chronologos/lightjj/testutil"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestHandleLog(t *testing.T) {
	runner := testutil.NewMockRunner(t)
	graphOutput := "@  _PREFIX:abc_PREFIX:xyz_PREFIX:false\tabcdefgh\txyz12345\tmy commit\tmain\n"
	runner.Expect(jj.LogGraph("@", 0)).SetOutput([]byte(graphOutput))
	defer runner.Verify()

	srv := NewServer(runner)
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

	srv := NewServer(runner)
	req := httptest.NewRequest("GET", "/api/log", nil)
	w := httptest.NewRecorder()
	srv.Mux.ServeHTTP(w, req)

	assert.Equal(t, http.StatusOK, w.Code)
}

func TestHandleBookmarks(t *testing.T) {
	runner := testutil.NewMockRunner(t)
	runner.Expect(jj.BookmarkListAll()).SetOutput([]byte("main;.;false;false;false;abc"))
	defer runner.Verify()

	srv := NewServer(runner)
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

	srv := NewServer(runner)
	req := httptest.NewRequest("GET", "/api/diff?revision=abc", nil)
	w := httptest.NewRecorder()
	srv.Mux.ServeHTTP(w, req)

	assert.Equal(t, http.StatusOK, w.Code)
	var resp map[string]string
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &resp))
	assert.Contains(t, resp["diff"], "+added line")
}

func TestHandleDiff_MissingRevision(t *testing.T) {
	srv := NewServer(testutil.NewMockRunner(t))
	req := httptest.NewRequest("GET", "/api/diff", nil)
	w := httptest.NewRecorder()
	srv.Mux.ServeHTTP(w, req)

	assert.Equal(t, http.StatusBadRequest, w.Code)
}

func TestHandleNew(t *testing.T) {
	runner := testutil.NewMockRunner(t)
	runner.Expect(jj.New(jj.NewSelectedRevisions(&jj.Commit{ChangeId: "abc"}))).SetOutput([]byte(""))
	defer runner.Verify()

	srv := NewServer(runner)
	body, _ := json.Marshal(newRequest{Revisions: []string{"abc"}})
	req := httptest.NewRequest("POST", "/api/new", bytes.NewReader(body))
	w := httptest.NewRecorder()
	srv.Mux.ServeHTTP(w, req)

	assert.Equal(t, http.StatusOK, w.Code)
}

func TestHandleAbandon(t *testing.T) {
	runner := testutil.NewMockRunner(t)
	revs := jj.NewSelectedRevisions(&jj.Commit{ChangeId: "abc"})
	runner.Expect(jj.Abandon(revs, false)).SetOutput([]byte(""))
	defer runner.Verify()

	srv := NewServer(runner)
	body, _ := json.Marshal(abandonRequest{Revisions: []string{"abc"}})
	req := httptest.NewRequest("POST", "/api/abandon", bytes.NewReader(body))
	w := httptest.NewRecorder()
	srv.Mux.ServeHTTP(w, req)

	assert.Equal(t, http.StatusOK, w.Code)
}

func TestHandleDescribe(t *testing.T) {
	runner := testutil.NewMockRunner(t)
	args, _ := jj.SetDescription("abc", "new description")
	runner.Expect(args).SetOutput([]byte(""))
	defer runner.Verify()

	srv := NewServer(runner)
	body, _ := json.Marshal(describeRequest{Revision: "abc", Description: "new description"})
	req := httptest.NewRequest("POST", "/api/describe", bytes.NewReader(body))
	w := httptest.NewRecorder()
	srv.Mux.ServeHTTP(w, req)

	assert.Equal(t, http.StatusOK, w.Code)
}

func TestHandleRebase(t *testing.T) {
	runner := testutil.NewMockRunner(t)
	revs := jj.NewSelectedRevisions(&jj.Commit{ChangeId: "abc"})
	runner.Expect(jj.Rebase(revs, "def", "-r", "-d", false, false)).SetOutput([]byte(""))
	defer runner.Verify()

	srv := NewServer(runner)
	body, _ := json.Marshal(rebaseRequest{Revisions: []string{"abc"}, Destination: "def"})
	req := httptest.NewRequest("POST", "/api/rebase", bytes.NewReader(body))
	w := httptest.NewRecorder()
	srv.Mux.ServeHTTP(w, req)

	assert.Equal(t, http.StatusOK, w.Code)
}

func TestHandleSquash(t *testing.T) {
	runner := testutil.NewMockRunner(t)
	revs := jj.NewSelectedRevisions(&jj.Commit{ChangeId: "abc"})
	runner.Expect(jj.Squash(revs, "def", nil, false, false, false, false)).SetOutput([]byte(""))
	defer runner.Verify()

	srv := NewServer(runner)
	body, _ := json.Marshal(squashRequest{Revisions: []string{"abc"}, Destination: "def"})
	req := httptest.NewRequest("POST", "/api/squash", bytes.NewReader(body))
	w := httptest.NewRecorder()
	srv.Mux.ServeHTTP(w, req)

	assert.Equal(t, http.StatusOK, w.Code)
}

func TestHandleUndo(t *testing.T) {
	runner := testutil.NewMockRunner(t)
	runner.Expect(jj.Undo()).SetOutput([]byte(""))
	defer runner.Verify()

	srv := NewServer(runner)
	req := httptest.NewRequest("POST", "/api/undo", nil)
	w := httptest.NewRecorder()
	srv.Mux.ServeHTTP(w, req)

	assert.Equal(t, http.StatusOK, w.Code)
}

func TestHandleBookmarkSet(t *testing.T) {
	runner := testutil.NewMockRunner(t)
	runner.Expect(jj.BookmarkSet("abc", "feature")).SetOutput([]byte(""))
	defer runner.Verify()

	srv := NewServer(runner)
	body, _ := json.Marshal(bookmarkRevisionRequest{Revision: "abc", Name: "feature"})
	req := httptest.NewRequest("POST", "/api/bookmark/set", bytes.NewReader(body))
	w := httptest.NewRecorder()
	srv.Mux.ServeHTTP(w, req)

	assert.Equal(t, http.StatusOK, w.Code)
}

func TestHandleGitPush(t *testing.T) {
	runner := testutil.NewMockRunner(t)
	runner.Expect(jj.GitPush("--bookmark", "main")).SetOutput([]byte(""))
	defer runner.Verify()

	srv := NewServer(runner)
	body, _ := json.Marshal(gitFlagsRequest{Flags: []string{"--bookmark", "main"}})
	req := httptest.NewRequest("POST", "/api/git/push", bytes.NewReader(body))
	w := httptest.NewRecorder()
	srv.Mux.ServeHTTP(w, req)

	assert.Equal(t, http.StatusOK, w.Code)
}

func TestHandleFiles(t *testing.T) {
	runner := testutil.NewMockRunner(t)
	runner.Expect(jj.DiffSummary("abc")).SetOutput([]byte("M src/main.go\nA new.go\n"))
	defer runner.Verify()

	srv := NewServer(runner)
	req := httptest.NewRequest("GET", "/api/files?revision=abc", nil)
	w := httptest.NewRecorder()
	srv.Mux.ServeHTTP(w, req)

	assert.Equal(t, http.StatusOK, w.Code)
	var files []jj.FileChange
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &files))
	assert.Len(t, files, 2)
	assert.Equal(t, "M", files[0].Type)
	assert.Equal(t, "src/main.go", files[0].Path)
	assert.Equal(t, "A", files[1].Type)
	assert.Equal(t, "new.go", files[1].Path)
}

func TestHandleFiles_MissingRevision(t *testing.T) {
	srv := NewServer(testutil.NewMockRunner(t))
	req := httptest.NewRequest("GET", "/api/files", nil)
	w := httptest.NewRecorder()
	srv.Mux.ServeHTTP(w, req)

	assert.Equal(t, http.StatusBadRequest, w.Code)
}

func TestHandleFiles_Empty(t *testing.T) {
	runner := testutil.NewMockRunner(t)
	runner.Expect(jj.DiffSummary("abc")).SetOutput([]byte(""))
	defer runner.Verify()

	srv := NewServer(runner)
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
	runner.Expect(jj.BookmarkMove("abc", "feature")).SetOutput([]byte(""))
	defer runner.Verify()

	srv := NewServer(runner)
	body, _ := json.Marshal(bookmarkRevisionRequest{Revision: "abc", Name: "feature"})
	req := httptest.NewRequest("POST", "/api/bookmark/move", bytes.NewReader(body))
	w := httptest.NewRecorder()
	srv.Mux.ServeHTTP(w, req)

	assert.Equal(t, http.StatusOK, w.Code)
}

func TestHandleBookmarkForget(t *testing.T) {
	runner := testutil.NewMockRunner(t)
	runner.Expect(jj.BookmarkForget("feature")).SetOutput([]byte(""))
	defer runner.Verify()

	srv := NewServer(runner)
	body, _ := json.Marshal(bookmarkNameRequest{Name: "feature"})
	req := httptest.NewRequest("POST", "/api/bookmark/forget", bytes.NewReader(body))
	w := httptest.NewRecorder()
	srv.Mux.ServeHTTP(w, req)

	assert.Equal(t, http.StatusOK, w.Code)
}

// --- Error path tests ---

func TestHandleLog_RunnerError(t *testing.T) {
	runner := testutil.NewMockRunner(t)
	runner.Expect(jj.LogGraph("@", 0)).SetError(errors.New("jj failed"))
	defer runner.Verify()

	srv := NewServer(runner)
	req := httptest.NewRequest("GET", "/api/log?revset=@", nil)
	w := httptest.NewRecorder()
	srv.Mux.ServeHTTP(w, req)

	assert.Equal(t, http.StatusInternalServerError, w.Code)
	var resp map[string]string
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &resp))
	assert.Equal(t, "jj failed", resp["error"])
}

func TestHandleEdit_InvalidJSON(t *testing.T) {
	srv := NewServer(testutil.NewMockRunner(t))
	req := httptest.NewRequest("POST", "/api/edit", strings.NewReader("{bad json"))
	w := httptest.NewRecorder()
	srv.Mux.ServeHTTP(w, req)

	assert.Equal(t, http.StatusBadRequest, w.Code)
}

func TestHandleGitPush_DisallowedFlag(t *testing.T) {
	srv := NewServer(testutil.NewMockRunner(t))
	body, _ := json.Marshal(gitFlagsRequest{Flags: []string{"--force"}})
	req := httptest.NewRequest("POST", "/api/git/push", bytes.NewReader(body))
	w := httptest.NewRecorder()
	srv.Mux.ServeHTTP(w, req)

	assert.Equal(t, http.StatusBadRequest, w.Code)
	var resp map[string]string
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &resp))
	assert.Contains(t, resp["error"], "flag not allowed")
}

func TestHandleGitFetch_DisallowedFlag(t *testing.T) {
	srv := NewServer(testutil.NewMockRunner(t))
	body, _ := json.Marshal(gitFlagsRequest{Flags: []string{"--force"}})
	req := httptest.NewRequest("POST", "/api/git/fetch", bytes.NewReader(body))
	w := httptest.NewRecorder()
	srv.Mux.ServeHTTP(w, req)

	assert.Equal(t, http.StatusBadRequest, w.Code)
	var resp map[string]string
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &resp))
	assert.Contains(t, resp["error"], "flag not allowed")
}

func TestHandleLog_InvalidLimit(t *testing.T) {
	srv := NewServer(testutil.NewMockRunner(t))
	req := httptest.NewRequest("GET", "/api/log?limit=notanumber", nil)
	w := httptest.NewRecorder()
	srv.Mux.ServeHTTP(w, req)

	assert.Equal(t, http.StatusBadRequest, w.Code)
}

func TestHandleEdit_MissingRevision(t *testing.T) {
	srv := NewServer(testutil.NewMockRunner(t))
	body, _ := json.Marshal(editRequest{})
	req := httptest.NewRequest("POST", "/api/edit", bytes.NewReader(body))
	w := httptest.NewRecorder()
	srv.Mux.ServeHTTP(w, req)

	assert.Equal(t, http.StatusBadRequest, w.Code)
}

func TestHandleRebase_MissingFields(t *testing.T) {
	srv := NewServer(testutil.NewMockRunner(t))

	// Missing revisions
	body, _ := json.Marshal(rebaseRequest{Destination: "def"})
	req := httptest.NewRequest("POST", "/api/rebase", bytes.NewReader(body))
	w := httptest.NewRecorder()
	srv.Mux.ServeHTTP(w, req)
	assert.Equal(t, http.StatusBadRequest, w.Code)

	// Missing destination
	body, _ = json.Marshal(rebaseRequest{Revisions: []string{"abc"}})
	req = httptest.NewRequest("POST", "/api/rebase", bytes.NewReader(body))
	w = httptest.NewRecorder()
	srv.Mux.ServeHTTP(w, req)
	assert.Equal(t, http.StatusBadRequest, w.Code)
}

func TestHandleBookmarkSet_MissingFields(t *testing.T) {
	srv := NewServer(testutil.NewMockRunner(t))
	body, _ := json.Marshal(bookmarkRevisionRequest{Revision: "abc"})
	req := httptest.NewRequest("POST", "/api/bookmark/set", bytes.NewReader(body))
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

// parseLogOutput tests moved to internal/parser/graph_test.go
