package api

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/chronologos/lightjj/internal/jj"
	"github.com/chronologos/lightjj/testutil"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestHandleLog(t *testing.T) {
	runner := testutil.NewMockRunner(t)
	runner.Expect(jj.LogJSON("@", 0)).SetOutput([]byte("abc\txyz\ttrue\tfalse\tmy commit\tmain\n"))
	defer runner.Verify()

	srv := NewServer(runner)
	req := httptest.NewRequest("GET", "/api/log?revset=@", nil)
	w := httptest.NewRecorder()
	srv.Mux.ServeHTTP(w, req)

	assert.Equal(t, http.StatusOK, w.Code)
	var entries []LogEntry
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &entries))
	assert.Len(t, entries, 1)
	assert.Equal(t, "abc", entries[0].ChangeId)
	assert.Equal(t, "xyz", entries[0].CommitId)
	assert.True(t, entries[0].IsWorkingCopy)
	assert.Equal(t, "my commit", entries[0].Description)
	assert.Equal(t, []string{"main"}, entries[0].Bookmarks)
}

func TestHandleLog_Empty(t *testing.T) {
	runner := testutil.NewMockRunner(t)
	runner.Expect(jj.LogJSON("", 0)).SetOutput([]byte(""))
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
	// Diff overrides --color from the command builder, so the final args have both
	runner.Expect(jj.Diff("abc", "", "--color", "never")).SetOutput([]byte("+added line"))
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
	body, _ := json.Marshal(bookmarkSetRequest{Revision: "abc", Name: "feature"})
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
	body, _ := json.Marshal(gitPushRequest{Flags: []string{"--bookmark", "main"}})
	req := httptest.NewRequest("POST", "/api/git/push", bytes.NewReader(body))
	w := httptest.NewRecorder()
	srv.Mux.ServeHTTP(w, req)

	assert.Equal(t, http.StatusOK, w.Code)
}

func TestParseLogOutput(t *testing.T) {
	tests := []struct {
		name  string
		input string
		want  int
	}{
		{"empty", "", 0},
		{"single", "abc\txyz\ttrue\tfalse\tmy commit\tmain\n", 1},
		{"multiple", "abc\txyz\ttrue\tfalse\tcommit 1\tmain\ndef\tuvw\tfalse\tfalse\tcommit 2\t\n", 2},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			entries, err := parseLogOutput(tt.input)
			require.NoError(t, err)
			assert.Len(t, entries, tt.want)
		})
	}
}

func TestParseLogOutput_Fields(t *testing.T) {
	entries, err := parseLogOutput("abc\txyz\ttrue\ttrue\thello world\tmain develop\n")
	require.NoError(t, err)
	require.Len(t, entries, 1)

	e := entries[0]
	assert.Equal(t, "abc", e.ChangeId)
	assert.Equal(t, "xyz", e.CommitId)
	assert.True(t, e.IsWorkingCopy)
	assert.True(t, e.Hidden)
	assert.Equal(t, "hello world", e.Description)
	assert.Equal(t, []string{"main", "develop"}, e.Bookmarks)
}
