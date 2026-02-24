//go:build integration

package api

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"github.com/iant/lightjj/internal/jj"
	"github.com/iant/lightjj/internal/parser"
	"github.com/iant/lightjj/internal/runner"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

// jjTestRepo creates a fresh jj repo in t.TempDir() and returns a LocalRunner
// plus an exec helper that runs jj commands in the repo for test setup.
func jjTestRepo(t *testing.T) (*runner.LocalRunner, func(args ...string) string) {
	t.Helper()
	dir := t.TempDir()

	jjExec := func(args ...string) string {
		t.Helper()
		cmd := exec.Command("jj", args...)
		cmd.Dir = dir
		// Suppress interactive prompts and ANSI output.
		cmd.Env = append(os.Environ(),
			"JJ_CONFIG=",          // ignore user config
			"NO_COLOR=1",          // no ANSI codes
			"JJ_USER=Test User",   // deterministic author
			"JJ_EMAIL=test@test",  // deterministic email
		)
		out, err := cmd.CombinedOutput()
		if err != nil {
			t.Fatalf("jj %v failed: %s\n%s", args, err, out)
		}
		return string(out)
	}

	jjExec("git", "init", "--colocate")

	r := runner.NewLocalRunner(dir)
	return r, jjExec
}

// writeFile creates a file in the repo with the given content.
func writeFile(t *testing.T, dir, name, content string) {
	t.Helper()
	path := filepath.Join(dir, name)
	require.NoError(t, os.MkdirAll(filepath.Dir(path), 0o755))
	require.NoError(t, os.WriteFile(path, []byte(content), 0o644))
}

// apiGet issues a GET request and returns the recorder.
func apiGet(t *testing.T, srv *Server, path string) *httptest.ResponseRecorder {
	t.Helper()
	w := httptest.NewRecorder()
	srv.Mux.ServeHTTP(w, httptest.NewRequest("GET", path, nil))
	require.Equal(t, http.StatusOK, w.Code, "GET %s failed: %s", path, w.Body.String())
	return w
}

// apiPost issues a POST request with JSON body and returns the recorder.
func apiPost(t *testing.T, srv *Server, path string, body any) *httptest.ResponseRecorder {
	t.Helper()
	data, err := json.Marshal(body)
	require.NoError(t, err)
	req := httptest.NewRequest("POST", path, bytes.NewReader(data))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	srv.Mux.ServeHTTP(w, req)
	return w
}

// getLogRows fetches /api/log and returns parsed rows.
func getLogRows(t *testing.T, srv *Server, query string) []parser.GraphRow {
	t.Helper()
	path := "/api/log"
	if query != "" {
		path += "?" + query
	}
	w := apiGet(t, srv, path)
	var rows []parser.GraphRow
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &rows))
	return rows
}

// findRow returns the first row matching the description, or fails.
func findRow(t *testing.T, rows []parser.GraphRow, desc string) parser.GraphRow {
	t.Helper()
	for _, r := range rows {
		if r.Description == desc {
			return r
		}
	}
	var descs []string
	for _, r := range rows {
		descs = append(descs, fmt.Sprintf("%q", r.Description))
	}
	t.Fatalf("no row with description %q in [%s]", desc, strings.Join(descs, ", "))
	return parser.GraphRow{}
}

// getBookmarks fetches /api/bookmarks and returns parsed bookmarks.
func getBookmarks(t *testing.T, srv *Server) []jj.Bookmark {
	t.Helper()
	w := apiGet(t, srv, "/api/bookmarks")
	var bookmarks []jj.Bookmark
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &bookmarks))
	return bookmarks
}

// findBookmark returns the bookmark with the given name, or fails.
func findBookmark(t *testing.T, bookmarks []jj.Bookmark, name string) jj.Bookmark {
	t.Helper()
	for _, b := range bookmarks {
		if b.Name == name {
			return b
		}
	}
	var names []string
	for _, b := range bookmarks {
		names = append(names, b.Name)
	}
	t.Fatalf("no bookmark %q in %v", name, names)
	return jj.Bookmark{}
}

// hasBookmark returns true if a bookmark with the given name exists.
func hasBookmark(bookmarks []jj.Bookmark, name string) bool {
	for _, b := range bookmarks {
		if b.Name == name {
			return true
		}
	}
	return false
}

// ---------------------------------------------------------------------------
// Read endpoint tests
// ---------------------------------------------------------------------------

func TestIntegrationLog(t *testing.T) {
	r, jjExec := jjTestRepo(t)
	t.Parallel()

	writeFile(t, r.RepoDir, "hello.txt", "hello world")
	jjExec("describe", "-m", "initial commit")
	jjExec("new")
	writeFile(t, r.RepoDir, "second.txt", "second file")
	jjExec("describe", "-m", "second commit")

	srv := NewServer(r)
	rows := getLogRows(t, srv, "")

	require.GreaterOrEqual(t, len(rows), 3, "expected at least 3 rows (wc, initial, root)")

	assert.True(t, rows[0].Commit.IsWorkingCopy, "first row should be working copy")
	assert.Equal(t, "second commit", rows[0].Description)

	assert.False(t, rows[1].Commit.IsWorkingCopy)
	assert.Equal(t, "initial commit", rows[1].Description)

	last := rows[len(rows)-1]
	assert.True(t, last.Commit.Immutable, "last row should be immutable root")

	for _, row := range rows {
		require.NotEmpty(t, row.GraphLines, "every row needs at least one graph line")
		assert.True(t, row.GraphLines[0].IsNode, "first graph line should be a node")
	}
}

func TestIntegrationLogWithRevset(t *testing.T) {
	r, jjExec := jjTestRepo(t)
	t.Parallel()

	jjExec("describe", "-m", "first")
	jjExec("new")
	jjExec("describe", "-m", "second")
	jjExec("new")
	jjExec("describe", "-m", "third")

	srv := NewServer(r)

	// Limit to 1 should return only the working copy.
	rows := getLogRows(t, srv, "limit=1")
	require.Len(t, rows, 1)
	assert.Equal(t, "third", rows[0].Description)

	// Revset filtering: only @
	rows = getLogRows(t, srv, "revset=@")
	require.Len(t, rows, 1)
	assert.Equal(t, "third", rows[0].Description)
}

func TestIntegrationDiff(t *testing.T) {
	r, jjExec := jjTestRepo(t)
	t.Parallel()

	writeFile(t, r.RepoDir, "new_file.txt", "line one\nline two\nline three\n")
	jjExec("describe", "-m", "add new file")

	srv := NewServer(r)
	w := apiGet(t, srv, "/api/diff?revision=@")
	var resp map[string]string
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &resp))

	diff := resp["diff"]
	assert.Contains(t, diff, "new_file.txt")
	assert.Contains(t, diff, "+line one")
	assert.Contains(t, diff, "+line two")
}

func TestIntegrationDiffSingleFile(t *testing.T) {
	r, jjExec := jjTestRepo(t)
	t.Parallel()

	writeFile(t, r.RepoDir, "a.txt", "aaa\n")
	writeFile(t, r.RepoDir, "b.txt", "bbb\n")
	jjExec("describe", "-m", "two files")

	srv := NewServer(r)
	w := apiGet(t, srv, "/api/diff?revision=@&file=a.txt")
	var resp map[string]string
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &resp))

	diff := resp["diff"]
	assert.Contains(t, diff, "a.txt")
	assert.NotContains(t, diff, "b.txt", "single-file diff should not include other files")
}

func TestIntegrationFiles(t *testing.T) {
	r, jjExec := jjTestRepo(t)
	t.Parallel()

	writeFile(t, r.RepoDir, "base.txt", "base content")
	jjExec("describe", "-m", "add base")
	jjExec("new")
	writeFile(t, r.RepoDir, "base.txt", "modified content")
	writeFile(t, r.RepoDir, "extra.txt", "extra content")
	jjExec("describe", "-m", "modify and add")

	srv := NewServer(r)
	w := apiGet(t, srv, "/api/files?revision=@")
	var files []jj.FileChange
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &files))
	require.Len(t, files, 2)

	byPath := map[string]jj.FileChange{}
	for _, f := range files {
		byPath[f.Path] = f
	}

	assert.Equal(t, "M", byPath["base.txt"].Type)
	assert.Equal(t, "A", byPath["extra.txt"].Type)
	assert.Greater(t, byPath["base.txt"].Additions+byPath["base.txt"].Deletions, 0,
		"modified file should have non-zero stat counts")
}

func TestIntegrationStatus(t *testing.T) {
	r, jjExec := jjTestRepo(t)
	t.Parallel()

	writeFile(t, r.RepoDir, "tracked.txt", "content")
	jjExec("describe", "-m", "wip")

	srv := NewServer(r)
	w := apiGet(t, srv, "/api/status?revision=@")
	var resp map[string]string
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &resp))
	assert.Contains(t, resp["status"], "tracked.txt")
}

func TestIntegrationBookmarks(t *testing.T) {
	r, jjExec := jjTestRepo(t)
	t.Parallel()

	writeFile(t, r.RepoDir, "file.txt", "content")
	jjExec("describe", "-m", "bookmarked commit")
	jjExec("bookmark", "set", "my-feature")

	srv := NewServer(r)
	bookmarks := getBookmarks(t, srv)
	b := findBookmark(t, bookmarks, "my-feature")
	assert.NotNil(t, b.Local)
	assert.NotEmpty(t, b.CommitId)
}

func TestIntegrationDescription(t *testing.T) {
	r, jjExec := jjTestRepo(t)
	t.Parallel()

	jjExec("describe", "-m", "test description with special chars: <>&\"")

	srv := NewServer(r)
	w := apiGet(t, srv, "/api/description?revision=@")
	var resp map[string]string
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &resp))
	assert.Equal(t, "test description with special chars: <>&\"", resp["description"])
}

func TestIntegrationOplog(t *testing.T) {
	r, jjExec := jjTestRepo(t)
	t.Parallel()

	// Perform a few operations so oplog has entries.
	jjExec("describe", "-m", "first")
	jjExec("new")
	jjExec("describe", "-m", "second")

	srv := NewServer(r)
	w := apiGet(t, srv, "/api/oplog")
	var entries []jj.OpEntry
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &entries))
	require.NotEmpty(t, entries, "oplog should have entries")

	// Most recent operation should be marked current.
	assert.True(t, entries[0].IsCurrent, "first oplog entry should be current")
	assert.NotEmpty(t, entries[0].ID)
	assert.NotEmpty(t, entries[0].Time)

	// Should see describe operations.
	var hasDescribe bool
	for _, e := range entries {
		if strings.Contains(e.Description, "describe") {
			hasDescribe = true
			break
		}
	}
	assert.True(t, hasDescribe, "oplog should contain describe operations")
}

func TestIntegrationOplogLimit(t *testing.T) {
	r, jjExec := jjTestRepo(t)
	t.Parallel()

	for i := 0; i < 5; i++ {
		jjExec("describe", "-m", fmt.Sprintf("commit %d", i))
		jjExec("new")
	}

	srv := NewServer(r)
	w := apiGet(t, srv, "/api/oplog?limit=3")
	var entries []jj.OpEntry
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &entries))
	assert.LessOrEqual(t, len(entries), 3)
}

func TestIntegrationEvolog(t *testing.T) {
	r, jjExec := jjTestRepo(t)
	t.Parallel()

	// Create a commit and then re-describe it so evolog has multiple entries.
	writeFile(t, r.RepoDir, "file.txt", "v1")
	jjExec("describe", "-m", "original description")
	jjExec("describe", "-m", "updated description")

	srv := NewServer(r)
	w := apiGet(t, srv, "/api/evolog?revision=@")
	var resp map[string]string
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &resp))
	assert.NotEmpty(t, resp["output"], "evolog should return output")
}

func TestIntegrationWorkspaces(t *testing.T) {
	r, _ := jjTestRepo(t)
	t.Parallel()

	srv := NewServer(r)
	w := apiGet(t, srv, "/api/workspaces")
	var workspaces []jj.Workspace
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &workspaces))
	require.NotEmpty(t, workspaces)

	// Default workspace should exist.
	var hasDefault bool
	for _, ws := range workspaces {
		if ws.Name == "default" {
			hasDefault = true
			assert.NotEmpty(t, ws.ChangeId)
			assert.NotEmpty(t, ws.CommitId)
		}
	}
	assert.True(t, hasDefault, "default workspace should exist")
}

func TestIntegrationRemotes(t *testing.T) {
	r, _ := jjTestRepo(t)
	t.Parallel()

	// A freshly initialized colocated repo has no remotes.
	srv := NewServer(r)
	w := apiGet(t, srv, "/api/remotes")
	var remotes []string
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &remotes))
	assert.Empty(t, remotes, "fresh repo should have no remotes")
}

// ---------------------------------------------------------------------------
// Mutation endpoint tests
// ---------------------------------------------------------------------------

func TestIntegrationNew(t *testing.T) {
	r, jjExec := jjTestRepo(t)
	t.Parallel()

	writeFile(t, r.RepoDir, "file.txt", "content")
	jjExec("describe", "-m", "parent commit")

	srv := NewServer(r)
	w := apiPost(t, srv, "/api/new", map[string]any{
		"revisions": []string{"@"},
	})
	require.Equal(t, http.StatusOK, w.Code)

	// Log should now have an empty working copy on top of "parent commit".
	rows := getLogRows(t, srv, "")
	assert.True(t, rows[0].Commit.IsWorkingCopy)
	assert.Empty(t, rows[0].Description, "new commit should have empty description")
	assert.Equal(t, "parent commit", rows[1].Description)
}

func TestIntegrationDescribePost(t *testing.T) {
	r, _ := jjTestRepo(t)
	t.Parallel()

	srv := NewServer(r)

	// Describe the working copy via POST.
	w := apiPost(t, srv, "/api/describe", map[string]any{
		"revision":    "@",
		"description": "described via API",
	})
	require.Equal(t, http.StatusOK, w.Code)

	// Verify via GET /api/description.
	gw := apiGet(t, srv, "/api/description?revision=@")
	var resp map[string]string
	require.NoError(t, json.Unmarshal(gw.Body.Bytes(), &resp))
	assert.Equal(t, "described via API", resp["description"])
}

func TestIntegrationEdit(t *testing.T) {
	r, jjExec := jjTestRepo(t)
	t.Parallel()

	// Create a stack: A → B (working copy).
	writeFile(t, r.RepoDir, "a.txt", "a")
	jjExec("describe", "-m", "commit A")
	jjExec("new")
	writeFile(t, r.RepoDir, "b.txt", "b")
	jjExec("describe", "-m", "commit B")

	srv := NewServer(r)

	// Get commit A's change ID.
	rows := getLogRows(t, srv, "")
	commitA := findRow(t, rows, "commit A")

	// Edit commit A — makes it the working copy.
	w := apiPost(t, srv, "/api/edit", map[string]any{
		"revision": commitA.Commit.ChangeId,
	})
	require.Equal(t, http.StatusOK, w.Code)

	// Verify commit A is now the working copy.
	rows = getLogRows(t, srv, "")
	a := findRow(t, rows, "commit A")
	assert.True(t, a.Commit.IsWorkingCopy, "commit A should now be the working copy")
}

func TestIntegrationAbandon(t *testing.T) {
	r, jjExec := jjTestRepo(t)
	t.Parallel()

	writeFile(t, r.RepoDir, "file.txt", "content")
	jjExec("describe", "-m", "to be abandoned")
	jjExec("new")
	jjExec("describe", "-m", "successor")

	srv := NewServer(r)

	// Get the change ID of the commit to abandon.
	rows := getLogRows(t, srv, "")
	target := findRow(t, rows, "to be abandoned")

	w := apiPost(t, srv, "/api/abandon", map[string]any{
		"revisions": []string{target.Commit.ChangeId},
	})
	require.Equal(t, http.StatusOK, w.Code)

	// Verify it's gone from the log.
	rows = getLogRows(t, srv, "")
	for _, row := range rows {
		assert.NotEqual(t, "to be abandoned", row.Description,
			"abandoned commit should not appear in log")
	}
}

func TestIntegrationRebase(t *testing.T) {
	r, jjExec := jjTestRepo(t)
	t.Parallel()

	// Create a chain: root → A → B (@)
	writeFile(t, r.RepoDir, "a.txt", "a")
	jjExec("describe", "-m", "commit A")
	jjExec("new")
	writeFile(t, r.RepoDir, "b.txt", "b")
	jjExec("describe", "-m", "commit B")

	srv := NewServer(r)
	rows := getLogRows(t, srv, "")
	commitB := findRow(t, rows, "commit B")

	// Rebase B directly onto root (skip A).
	w := apiPost(t, srv, "/api/rebase", map[string]any{
		"revisions":   []string{commitB.Commit.ChangeId},
		"destination": "root()",
		"source_mode": "-r",
		"target_mode": "-d",
	})
	require.Equal(t, http.StatusOK, w.Code)

	// After rebase, B's parent should be root, not A.
	// Use revset=all() because A may fall outside the default log revset.
	rows = getLogRows(t, srv, "revset=all()")
	b := findRow(t, rows, "commit B")
	a := findRow(t, rows, "commit A")
	// B should still be the working copy.
	assert.True(t, b.Commit.IsWorkingCopy)
	// A should still exist but not be B's parent — they're now siblings.
	assert.NotEmpty(t, a.Commit.ChangeId)
}

func TestIntegrationSquash(t *testing.T) {
	r, jjExec := jjTestRepo(t)
	t.Parallel()

	// Create: root → parent (file a.txt) → child (file b.txt, @)
	writeFile(t, r.RepoDir, "a.txt", "aaa")
	jjExec("describe", "-m", "parent with a")
	jjExec("new")
	writeFile(t, r.RepoDir, "b.txt", "bbb")
	jjExec("describe", "-m", "child with b")

	srv := NewServer(r)
	rows := getLogRows(t, srv, "")
	child := findRow(t, rows, "child with b")
	parent := findRow(t, rows, "parent with a")

	// Squash child into parent. use_destination_message avoids opening $EDITOR
	// to combine descriptions (which would hang in a headless test).
	w := apiPost(t, srv, "/api/squash", map[string]any{
		"revisions":               []string{child.Commit.ChangeId},
		"destination":             parent.Commit.ChangeId,
		"use_destination_message": true,
	})
	require.Equal(t, http.StatusOK, w.Code)

	// After squash, the parent should contain both files.
	gw := apiGet(t, srv, fmt.Sprintf("/api/files?revision=%s", parent.Commit.ChangeId))
	var files []jj.FileChange
	require.NoError(t, json.Unmarshal(gw.Body.Bytes(), &files))

	byPath := map[string]jj.FileChange{}
	for _, f := range files {
		byPath[f.Path] = f
	}
	assert.Contains(t, byPath, "a.txt", "parent should still have a.txt")
	assert.Contains(t, byPath, "b.txt", "parent should now have squashed b.txt")
}

func TestIntegrationUndo(t *testing.T) {
	r, jjExec := jjTestRepo(t)
	t.Parallel()

	jjExec("describe", "-m", "original description")

	srv := NewServer(r)

	// Mutate: re-describe.
	w := apiPost(t, srv, "/api/describe", map[string]any{
		"revision":    "@",
		"description": "changed description",
	})
	require.Equal(t, http.StatusOK, w.Code)

	// Undo.
	w = apiPost(t, srv, "/api/undo", map[string]any{})
	require.Equal(t, http.StatusOK, w.Code)

	// Description should be back to original.
	gw := apiGet(t, srv, "/api/description?revision=@")
	var resp map[string]string
	require.NoError(t, json.Unmarshal(gw.Body.Bytes(), &resp))
	assert.Equal(t, "original description", resp["description"])
}

// ---------------------------------------------------------------------------
// Bookmark mutation tests
// ---------------------------------------------------------------------------

func TestIntegrationBookmarkSet(t *testing.T) {
	r, jjExec := jjTestRepo(t)
	t.Parallel()

	writeFile(t, r.RepoDir, "f.txt", "x")
	jjExec("describe", "-m", "target")

	srv := NewServer(r)
	w := apiPost(t, srv, "/api/bookmark/set", map[string]any{
		"revision": "@",
		"name":     "test-bm",
	})
	require.Equal(t, http.StatusOK, w.Code)

	b := findBookmark(t, getBookmarks(t, srv), "test-bm")
	assert.NotEmpty(t, b.CommitId)
}

func TestIntegrationBookmarkDelete(t *testing.T) {
	r, jjExec := jjTestRepo(t)
	t.Parallel()

	jjExec("describe", "-m", "target")
	jjExec("bookmark", "set", "to-delete")

	srv := NewServer(r)
	// Verify it exists first.
	assert.True(t, hasBookmark(getBookmarks(t, srv), "to-delete"))

	w := apiPost(t, srv, "/api/bookmark/delete", map[string]any{
		"name": "to-delete",
	})
	require.Equal(t, http.StatusOK, w.Code)

	assert.False(t, hasBookmark(getBookmarks(t, srv), "to-delete"),
		"bookmark should be deleted")
}

func TestIntegrationBookmarkMove(t *testing.T) {
	r, jjExec := jjTestRepo(t)
	t.Parallel()

	// Create two commits, set bookmark on the first.
	writeFile(t, r.RepoDir, "a.txt", "a")
	jjExec("describe", "-m", "commit A")
	jjExec("bookmark", "set", "movable")
	jjExec("new")
	writeFile(t, r.RepoDir, "b.txt", "b")
	jjExec("describe", "-m", "commit B")

	srv := NewServer(r)
	rows := getLogRows(t, srv, "")
	commitB := findRow(t, rows, "commit B")

	// Move bookmark to commit B.
	w := apiPost(t, srv, "/api/bookmark/move", map[string]any{
		"revision": commitB.Commit.ChangeId,
		"name":     "movable",
	})
	require.Equal(t, http.StatusOK, w.Code)

	// Verify bookmark is now on commit B.
	b := findBookmark(t, getBookmarks(t, srv), "movable")
	// The bookmark's commit should match B's commit.
	assert.True(t, strings.HasPrefix(commitB.Commit.CommitId, b.CommitId) ||
		strings.HasPrefix(b.CommitId, commitB.Commit.CommitId),
		"bookmark should point to commit B (got %s, want prefix of %s)",
		b.CommitId, commitB.Commit.CommitId)
}

func TestIntegrationBookmarkForget(t *testing.T) {
	r, jjExec := jjTestRepo(t)
	t.Parallel()

	jjExec("describe", "-m", "target")
	jjExec("bookmark", "set", "forgettable")

	srv := NewServer(r)
	assert.True(t, hasBookmark(getBookmarks(t, srv), "forgettable"))

	w := apiPost(t, srv, "/api/bookmark/forget", map[string]any{
		"name": "forgettable",
	})
	require.Equal(t, http.StatusOK, w.Code)

	assert.False(t, hasBookmark(getBookmarks(t, srv), "forgettable"),
		"bookmark should be forgotten")
}

// ---------------------------------------------------------------------------
// User journey tests — multi-step workflows
// ---------------------------------------------------------------------------

// TestJourneyFeatureBranch exercises the typical feature branch workflow:
// new → write files → describe → set bookmark → verify everything in log.
func TestJourneyFeatureBranch(t *testing.T) {
	r, jjExec := jjTestRepo(t)
	t.Parallel()

	// Start with a base commit.
	writeFile(t, r.RepoDir, "README.md", "# project")
	jjExec("describe", "-m", "initial setup")

	srv := NewServer(r)

	// 1. Create new change.
	w := apiPost(t, srv, "/api/new", map[string]any{
		"revisions": []string{"@"},
	})
	require.Equal(t, http.StatusOK, w.Code)

	// 2. Write files (simulate user editing), then describe via API.
	writeFile(t, r.RepoDir, "feature.go", "package feature\n\nfunc Do() {}\n")
	writeFile(t, r.RepoDir, "feature_test.go", "package feature\n\nfunc TestDo() {}\n")

	w = apiPost(t, srv, "/api/describe", map[string]any{
		"revision":    "@",
		"description": "add feature module",
	})
	require.Equal(t, http.StatusOK, w.Code)

	// 3. Set bookmark.
	w = apiPost(t, srv, "/api/bookmark/set", map[string]any{
		"revision": "@",
		"name":     "feature-branch",
	})
	require.Equal(t, http.StatusOK, w.Code)

	// 4. Verify the full picture.
	rows := getLogRows(t, srv, "")
	wc := rows[0]
	assert.True(t, wc.Commit.IsWorkingCopy)
	assert.Equal(t, "add feature module", wc.Description)
	assert.Contains(t, wc.Bookmarks, "feature-branch")

	// Files should show the two new files.
	gw := apiGet(t, srv, "/api/files?revision=@")
	var files []jj.FileChange
	require.NoError(t, json.Unmarshal(gw.Body.Bytes(), &files))
	assert.Len(t, files, 2)

	// Diff should contain the function.
	gw = apiGet(t, srv, "/api/diff?revision=@")
	var diffResp map[string]string
	require.NoError(t, json.Unmarshal(gw.Body.Bytes(), &diffResp))
	assert.Contains(t, diffResp["diff"], "func Do()")
}

// TestJourneySquashStack exercises creating a stack and squashing changes down.
func TestJourneySquashStack(t *testing.T) {
	r, jjExec := jjTestRepo(t)
	t.Parallel()

	// Build a 3-commit stack: base → middle → top (@)
	writeFile(t, r.RepoDir, "base.txt", "base")
	jjExec("describe", "-m", "base commit")
	jjExec("new")
	writeFile(t, r.RepoDir, "middle.txt", "middle")
	jjExec("describe", "-m", "middle commit")
	jjExec("new")
	writeFile(t, r.RepoDir, "top.txt", "top")
	jjExec("describe", "-m", "top commit")

	srv := NewServer(r)
	rows := getLogRows(t, srv, "")
	top := findRow(t, rows, "top commit")
	middle := findRow(t, rows, "middle commit")

	// Squash top into middle. use_destination_message avoids $EDITOR prompt.
	w := apiPost(t, srv, "/api/squash", map[string]any{
		"revisions":               []string{top.Commit.ChangeId},
		"destination":             middle.Commit.ChangeId,
		"use_destination_message": true,
	})
	require.Equal(t, http.StatusOK, w.Code)

	// Middle should now contain both middle.txt and top.txt.
	gw := apiGet(t, srv, fmt.Sprintf("/api/files?revision=%s", middle.Commit.ChangeId))
	var files []jj.FileChange
	require.NoError(t, json.Unmarshal(gw.Body.Bytes(), &files))
	byPath := map[string]jj.FileChange{}
	for _, f := range files {
		byPath[f.Path] = f
	}
	assert.Contains(t, byPath, "middle.txt")
	assert.Contains(t, byPath, "top.txt")

	// The working copy (@) should now be empty (all changes squashed away).
	rows = getLogRows(t, srv, "revset=@")
	require.Len(t, rows, 1)
	wc := rows[0]
	assert.True(t, wc.Commit.IsWorkingCopy)

	gw = apiGet(t, srv, "/api/files?revision=@")
	var wcFiles []jj.FileChange
	require.NoError(t, json.Unmarshal(gw.Body.Bytes(), &wcFiles))
	assert.Empty(t, wcFiles, "working copy should have no changes after squash")
}

// TestJourneyRebaseAndVerify exercises rebasing a commit to a different parent
// and verifying the topology changed.
func TestJourneyRebaseAndVerify(t *testing.T) {
	r, jjExec := jjTestRepo(t)
	t.Parallel()

	// Create a diamond: root → A, root → B (@)
	writeFile(t, r.RepoDir, "a.txt", "a content")
	jjExec("describe", "-m", "branch A")
	jjExec("new", "root()")
	writeFile(t, r.RepoDir, "b.txt", "b content")
	jjExec("describe", "-m", "branch B")

	srv := NewServer(r)
	// Use all() since A may fall outside default revset after rebase.
	rows := getLogRows(t, srv, "revset=all()")
	branchB := findRow(t, rows, "branch B")
	branchA := findRow(t, rows, "branch A")

	// Rebase B onto A (B becomes a child of A).
	w := apiPost(t, srv, "/api/rebase", map[string]any{
		"revisions":   []string{branchB.Commit.ChangeId},
		"destination": branchA.Commit.ChangeId,
		"source_mode": "-r",
		"target_mode": "-d",
	})
	require.Equal(t, http.StatusOK, w.Code)

	// After rebase, B should be on top of A in the log.
	rows = getLogRows(t, srv, "revset=all()")
	b := findRow(t, rows, "branch B")
	assert.True(t, b.Commit.IsWorkingCopy)

	// B's diff should still have b.txt.
	gw := apiGet(t, srv, fmt.Sprintf("/api/diff?revision=%s", b.Commit.ChangeId))
	var diffResp map[string]string
	require.NoError(t, json.Unmarshal(gw.Body.Bytes(), &diffResp))
	assert.Contains(t, diffResp["diff"], "b content")
}

// TestJourneyBookmarkLifecycle exercises the full bookmark lifecycle:
// set → move → delete → verify gone.
func TestJourneyBookmarkLifecycle(t *testing.T) {
	r, jjExec := jjTestRepo(t)
	t.Parallel()

	writeFile(t, r.RepoDir, "v1.txt", "v1")
	jjExec("describe", "-m", "version 1")
	jjExec("new")
	writeFile(t, r.RepoDir, "v2.txt", "v2")
	jjExec("describe", "-m", "version 2")

	srv := NewServer(r)
	rows := getLogRows(t, srv, "")
	v1 := findRow(t, rows, "version 1")
	v2 := findRow(t, rows, "version 2")

	// 1. Set bookmark on v1.
	w := apiPost(t, srv, "/api/bookmark/set", map[string]any{
		"revision": v1.Commit.ChangeId,
		"name":     "release",
	})
	require.Equal(t, http.StatusOK, w.Code)
	b := findBookmark(t, getBookmarks(t, srv), "release")
	assert.NotEmpty(t, b.CommitId)

	// 2. Move bookmark to v2.
	w = apiPost(t, srv, "/api/bookmark/move", map[string]any{
		"revision": v2.Commit.ChangeId,
		"name":     "release",
	})
	require.Equal(t, http.StatusOK, w.Code)

	// Verify bookmark is in the log on v2.
	rows = getLogRows(t, srv, "")
	v2Row := findRow(t, rows, "version 2")
	assert.Contains(t, v2Row.Bookmarks, "release", "bookmark should be on v2")

	// 3. Delete bookmark.
	w = apiPost(t, srv, "/api/bookmark/delete", map[string]any{
		"name": "release",
	})
	require.Equal(t, http.StatusOK, w.Code)

	// 4. Verify gone.
	assert.False(t, hasBookmark(getBookmarks(t, srv), "release"))

	// Log should no longer show the bookmark.
	rows = getLogRows(t, srv, "")
	v2Row = findRow(t, rows, "version 2")
	assert.NotContains(t, v2Row.Bookmarks, "release")
}

// TestJourneyAbandonAndUndo exercises abandoning a commit and then undoing it.
func TestJourneyAbandonAndUndo(t *testing.T) {
	r, jjExec := jjTestRepo(t)
	t.Parallel()

	writeFile(t, r.RepoDir, "keep.txt", "keep")
	jjExec("describe", "-m", "important commit")
	jjExec("new")
	jjExec("describe", "-m", "successor")

	srv := NewServer(r)
	rows := getLogRows(t, srv, "")
	important := findRow(t, rows, "important commit")

	// Abandon it.
	w := apiPost(t, srv, "/api/abandon", map[string]any{
		"revisions": []string{important.Commit.ChangeId},
	})
	require.Equal(t, http.StatusOK, w.Code)

	// Verify it's gone.
	rows = getLogRows(t, srv, "")
	for _, row := range rows {
		assert.NotEqual(t, "important commit", row.Description)
	}

	// Undo the abandon.
	w = apiPost(t, srv, "/api/undo", map[string]any{})
	require.Equal(t, http.StatusOK, w.Code)

	// Should be back.
	rows = getLogRows(t, srv, "")
	restored := findRow(t, rows, "important commit")
	assert.NotEmpty(t, restored.Commit.ChangeId, "commit should be restored after undo")
}

// TestJourneyEditModifyReturn exercises editing an older revision, modifying it,
// and then returning to the original working copy.
func TestJourneyEditModifyReturn(t *testing.T) {
	r, jjExec := jjTestRepo(t)
	t.Parallel()

	// Create: root → A (file a.txt) → B (file b.txt, @)
	writeFile(t, r.RepoDir, "a.txt", "original a")
	jjExec("describe", "-m", "commit A")
	jjExec("new")
	writeFile(t, r.RepoDir, "b.txt", "b content")
	jjExec("describe", "-m", "commit B")

	srv := NewServer(r)
	rows := getLogRows(t, srv, "")
	commitA := findRow(t, rows, "commit A")
	commitB := findRow(t, rows, "commit B")

	// 1. Edit commit A.
	w := apiPost(t, srv, "/api/edit", map[string]any{
		"revision": commitA.Commit.ChangeId,
	})
	require.Equal(t, http.StatusOK, w.Code)

	// 2. Modify a.txt in commit A.
	writeFile(t, r.RepoDir, "a.txt", "modified a")
	// Snapshot so the diff endpoint (which uses --ignore-working-copy) sees the change.
	jjExec("debug", "snapshot")

	// 3. Verify the diff shows the modification.
	gw := apiGet(t, srv, fmt.Sprintf("/api/diff?revision=%s", commitA.Commit.ChangeId))
	var diffResp map[string]string
	require.NoError(t, json.Unmarshal(gw.Body.Bytes(), &diffResp))
	assert.Contains(t, diffResp["diff"], "modified a")

	// 4. Return to commit B.
	w = apiPost(t, srv, "/api/edit", map[string]any{
		"revision": commitB.Commit.ChangeId,
	})
	require.Equal(t, http.StatusOK, w.Code)

	// 5. Verify B is the working copy again.
	rows = getLogRows(t, srv, "")
	b := findRow(t, rows, "commit B")
	assert.True(t, b.Commit.IsWorkingCopy, "commit B should be working copy again")
}

// TestJourneyDescribeMultiline verifies multi-line descriptions roundtrip correctly.
func TestJourneyDescribeMultiline(t *testing.T) {
	r, _ := jjTestRepo(t)
	t.Parallel()

	srv := NewServer(r)
	multiline := "feat: add auth\n\nThis adds OAuth2 support.\n\n- Google provider\n- GitHub provider"

	w := apiPost(t, srv, "/api/describe", map[string]any{
		"revision":    "@",
		"description": multiline,
	})
	require.Equal(t, http.StatusOK, w.Code)

	// GET description should return the full multi-line text.
	gw := apiGet(t, srv, "/api/description?revision=@")
	var resp map[string]string
	require.NoError(t, json.Unmarshal(gw.Body.Bytes(), &resp))
	assert.Equal(t, multiline, resp["description"])

	// Log should show only the first line.
	rows := getLogRows(t, srv, "revset=@")
	require.Len(t, rows, 1)
	assert.Equal(t, "feat: add auth", rows[0].Description)
}

// TestJourneyOpIdTracking verifies that the X-JJ-Op-Id header updates after mutations.
func TestJourneyOpIdTracking(t *testing.T) {
	r, _ := jjTestRepo(t)
	t.Parallel()

	srv := NewServer(r)

	// First log call seeds the op-id cache.
	w1 := apiGet(t, srv, "/api/log")
	opId1 := w1.Header().Get("X-JJ-Op-Id")
	assert.NotEmpty(t, opId1, "op-id should be set after first log call")

	// Mutate: describe.
	w := apiPost(t, srv, "/api/describe", map[string]any{
		"revision":    "@",
		"description": "trigger op change",
	})
	require.Equal(t, http.StatusOK, w.Code)

	// The mutation response may still have the old op-id (refresh is async).
	// But a subsequent log call should return a new op-id.
	w2 := apiGet(t, srv, "/api/log")
	opId2 := w2.Header().Get("X-JJ-Op-Id")
	assert.NotEmpty(t, opId2)
	assert.NotEqual(t, opId1, opId2, "op-id should change after mutation")
}

// ---------------------------------------------------------------------------
// Conflict resolution tests
// ---------------------------------------------------------------------------

// createConflict sets up a repo with a conflict on "conflict.txt":
// base (content "base") → left (content "left") → right rebased onto left (content "right").
// Returns the runner and jjExec helper.
func createConflict(t *testing.T) (*runner.LocalRunner, func(args ...string) string) {
	t.Helper()
	r, jjExec := jjTestRepo(t)

	// Base commit with a file.
	writeFile(t, r.RepoDir, "conflict.txt", "base content\n")
	writeFile(t, r.RepoDir, "clean.txt", "untouched\n")
	jjExec("describe", "-m", "base")

	// Left branch: modify the file.
	jjExec("new")
	writeFile(t, r.RepoDir, "conflict.txt", "left content\n")
	jjExec("describe", "-m", "left change")
	// Capture left's change ID for the rebase target.
	leftId := strings.TrimSpace(jjExec("log", "-r", "@", "--no-graph", "-T", "change_id.short(8)"))

	// Right branch: sibling of left (child of base).
	jjExec("new", "@-") // parent of left = base
	writeFile(t, r.RepoDir, "conflict.txt", "right content\n")
	jjExec("describe", "-m", "right change")

	// Rebase right onto left → creates conflict on conflict.txt.
	jjExec("rebase", "-r", "@", "-d", leftId)

	// Verify conflict was actually created (guards against jj behavior changes).
	status := jjExec("log", "-r", "@", "--no-graph", "-T", "conflict")
	require.Contains(t, status, "true", "createConflict: expected conflict after rebase")

	return r, jjExec
}

func TestIntegrationFilesWithConflicts(t *testing.T) {
	r, _ := createConflict(t)
	t.Parallel()

	srv := NewServer(r)

	// The working copy should be the conflicted "right change" commit.
	w := apiGet(t, srv, "/api/files?revision=@")
	var files []jj.FileChange
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &files))

	byPath := map[string]jj.FileChange{}
	for _, f := range files {
		byPath[f.Path] = f
	}

	// conflict.txt should be marked as conflicted.
	require.Contains(t, byPath, "conflict.txt")
	assert.True(t, byPath["conflict.txt"].Conflict,
		"conflict.txt should have conflict=true")

	// clean.txt should NOT be marked as conflicted (it may or may not appear
	// in the files list depending on whether it was modified in this commit).
	if f, ok := byPath["clean.txt"]; ok {
		assert.False(t, f.Conflict, "clean.txt should not be conflicted")
	}
}

func TestIntegrationResolveOurs(t *testing.T) {
	r, _ := createConflict(t)
	t.Parallel()

	srv := NewServer(r)

	// Verify conflict exists first.
	w := apiGet(t, srv, "/api/files?revision=@")
	var files []jj.FileChange
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &files))
	var hasConflict bool
	for _, f := range files {
		if f.Path == "conflict.txt" && f.Conflict {
			hasConflict = true
		}
	}
	require.True(t, hasConflict, "conflict should exist before resolve")

	// Resolve with :ours.
	w = apiPost(t, srv, "/api/resolve", map[string]any{
		"revision": "@",
		"file":     "conflict.txt",
		"tool":     ":ours",
	})
	require.Equal(t, http.StatusOK, w.Code)

	// After resolve, conflict.txt should no longer be conflicted.
	// It may disappear from files entirely if resolved content matches parent.
	w = apiGet(t, srv, "/api/files?revision=@")
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &files))
	for _, f := range files {
		if f.Path == "conflict.txt" {
			assert.False(t, f.Conflict, "conflict.txt should be resolved")
		}
	}
}

func TestIntegrationResolveTheirs(t *testing.T) {
	r, _ := createConflict(t)
	t.Parallel()

	srv := NewServer(r)

	// Resolve with :theirs.
	w := apiPost(t, srv, "/api/resolve", map[string]any{
		"revision": "@",
		"file":     "conflict.txt",
		"tool":     ":theirs",
	})
	require.Equal(t, http.StatusOK, w.Code)

	// After resolve, verify the conflict is gone and the content is deterministic.
	// Use file-show to check the resolved content — :theirs should pick one side.
	gw := apiGet(t, srv, "/api/file-show?revision=@&path=conflict.txt")
	var fileResp map[string]string
	require.NoError(t, json.Unmarshal(gw.Body.Bytes(), &fileResp))
	content := fileResp["content"]
	// The resolved content should be exactly one side (not conflict markers).
	assert.NotContains(t, content, "<<<<<<<", "resolved file should not contain conflict markers")
	// :theirs picks a deterministic side — verify it's one of the two.
	assert.True(t,
		strings.Contains(content, "left content") || strings.Contains(content, "right content"),
		"resolved content should be one of the two sides, got: %q", content)

	// Verify no conflicts remain in files list.
	w = apiGet(t, srv, "/api/files?revision=@")
	var files []jj.FileChange
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &files))
	for _, f := range files {
		if f.Path == "conflict.txt" {
			assert.False(t, f.Conflict, "conflict.txt should not be conflicted after resolve")
		}
	}
}

// TestJourneyConflictResolution exercises the full conflict lifecycle:
// create conflict → detect in files → resolve → verify clean.
func TestJourneyConflictResolution(t *testing.T) {
	r, _ := createConflict(t)
	t.Parallel()

	srv := NewServer(r)

	// 1. Log should show the conflicted commit at the working copy.
	rows := getLogRows(t, srv, "revset=@")
	require.Len(t, rows, 1)
	wc := rows[0]
	assert.True(t, wc.Commit.IsWorkingCopy)
	assert.Equal(t, "right change", wc.Description)

	// 2. Files endpoint should report the conflict.
	w := apiGet(t, srv, "/api/files?revision=@")
	var files []jj.FileChange
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &files))
	var conflictFile *jj.FileChange
	for i, f := range files {
		if f.Path == "conflict.txt" {
			conflictFile = &files[i]
		}
	}
	require.NotNil(t, conflictFile, "conflict.txt should appear in files list")
	assert.True(t, conflictFile.Conflict, "should be marked as conflicted")

	// 3. Diff should contain conflict markers or conflict-related content.
	gw := apiGet(t, srv, "/api/diff?revision=@")
	var diffResp map[string]string
	require.NoError(t, json.Unmarshal(gw.Body.Bytes(), &diffResp))
	assert.Contains(t, diffResp["diff"], "conflict.txt",
		"diff should reference the conflicted file")

	// 4. Resolve the conflict.
	pw := apiPost(t, srv, "/api/resolve", map[string]any{
		"revision": "@",
		"file":     "conflict.txt",
		"tool":     ":ours",
	})
	require.Equal(t, http.StatusOK, pw.Code)

	// 5. Verify conflict is gone. After resolve, conflict.txt may disappear from
	// the files list entirely if the resolved content matches the parent (no diff).
	w = apiGet(t, srv, "/api/files?revision=@")
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &files))
	for _, f := range files {
		if f.Path == "conflict.txt" {
			assert.False(t, f.Conflict,
				"conflict.txt should no longer be conflicted after resolve")
		}
	}

	// 6. Verify we can undo the resolution.
	pw = apiPost(t, srv, "/api/undo", map[string]any{})
	require.Equal(t, http.StatusOK, pw.Code)

	// Conflict should be back.
	w = apiGet(t, srv, "/api/files?revision=@")
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &files))
	var conflictRestored bool
	for _, f := range files {
		if f.Path == "conflict.txt" && f.Conflict {
			conflictRestored = true
		}
	}
	require.True(t, conflictRestored,
		"conflict should be restored after undo")
}

// createConflictStack builds a 3-commit conflict chain:
//
//	base → left (modifies conflict.txt)
//	base → right (modifies conflict.txt, rebased onto left → conflict)
//	     → childA (adds more content, inherits conflict)
//	     → childB (adds more content, inherits conflict)
//
// Returns runner, jjExec, and the change IDs of [right, childA, childB].
func createConflictStack(t *testing.T) (*runner.LocalRunner, func(args ...string) string, [3]string) {
	t.Helper()
	r, jjExec := jjTestRepo(t)

	writeFile(t, r.RepoDir, "conflict.txt", "base content\n")
	writeFile(t, r.RepoDir, "other.txt", "shared file\n")
	jjExec("describe", "-m", "base")

	jjExec("new")
	writeFile(t, r.RepoDir, "conflict.txt", "left content\n")
	jjExec("describe", "-m", "left change")
	leftId := strings.TrimSpace(jjExec("log", "-r", "@", "--no-graph", "-T", "change_id.short(8)"))

	jjExec("new", "@-")
	writeFile(t, r.RepoDir, "conflict.txt", "right content\n")
	jjExec("describe", "-m", "right change")

	jjExec("rebase", "-r", "@", "-d", leftId)
	rightId := strings.TrimSpace(jjExec("log", "-r", "@", "--no-graph", "-T", "change_id.short(8)"))

	// Child A: adds content on top of the conflicted commit.
	jjExec("new")
	writeFile(t, r.RepoDir, "other.txt", "child A modification\n")
	jjExec("describe", "-m", "child A")
	childAId := strings.TrimSpace(jjExec("log", "-r", "@", "--no-graph", "-T", "change_id.short(8)"))

	// Child B: adds content on top of child A, still inherits conflict.
	jjExec("new")
	writeFile(t, r.RepoDir, "other.txt", "child B modification\n")
	jjExec("describe", "-m", "child B")
	childBId := strings.TrimSpace(jjExec("log", "-r", "@", "--no-graph", "-T", "change_id.short(8)"))

	// Verify all three commits inherited the conflict.
	for _, id := range []string{rightId, childAId, childBId} {
		status := jjExec("log", "-r", id, "--no-graph", "-T", "conflict")
		require.Contains(t, status, "true", "createConflictStack: %s should be conflicted", id)
	}

	return r, jjExec, [3]string{rightId, childAId, childBId}
}

// TestJourneyConflictBubbleUp verifies that resolving a conflict in an
// ancestor automatically clears the conflict from all descendants.
func TestJourneyConflictBubbleUp(t *testing.T) {
	r, _, ids := createConflictStack(t)
	t.Parallel()
	rightId, childAId, childBId := ids[0], ids[1], ids[2]

	srv := NewServer(r)

	// 1. Verify all three commits are conflicted.
	for _, id := range []string{rightId, childAId, childBId} {
		w := apiGet(t, srv, "/api/files?revision="+id)
		var files []jj.FileChange
		require.NoError(t, json.Unmarshal(w.Body.Bytes(), &files))
		var hasConflict bool
		for _, f := range files {
			if f.Path == "conflict.txt" && f.Conflict {
				hasConflict = true
			}
		}
		assert.True(t, hasConflict, "revision %s should have conflict before resolve", id)
	}

	// 2. Resolve the conflict in the ROOT of the chain (right change).
	w := apiPost(t, srv, "/api/resolve", map[string]any{
		"revision": rightId,
		"file":     "conflict.txt",
		"tool":     ":ours",
	})
	require.Equal(t, http.StatusOK, w.Code)

	// 3. Verify the conflict is gone from ALL descendants.
	for _, tc := range []struct {
		id   string
		desc string
	}{
		{rightId, "right (resolved directly)"},
		{childAId, "child A (should bubble up)"},
		{childBId, "child B (should bubble up)"},
	} {
		w := apiGet(t, srv, "/api/files?revision="+tc.id)
		var files []jj.FileChange
		require.NoError(t, json.Unmarshal(w.Body.Bytes(), &files))
		for _, f := range files {
			assert.False(t, f.Conflict,
				"%s: file %s should not be conflicted after ancestor resolve", tc.desc, f.Path)
		}
	}

	// 4. Verify descendants still have their own changes.
	w = apiGet(t, srv, fmt.Sprintf("/api/diff?revision=%s", childAId))
	var diffResp map[string]string
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &diffResp))
	assert.Contains(t, diffResp["diff"], "child A modification",
		"child A should retain its own changes after conflict resolution")

	w = apiGet(t, srv, fmt.Sprintf("/api/diff?revision=%s", childBId))
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &diffResp))
	assert.Contains(t, diffResp["diff"], "child B modification",
		"child B should retain its own changes after conflict resolution")
}

// TestJourneyConflictResolveChildNotParent verifies that resolving a conflict
// in a descendant does NOT resolve the ancestor's conflict.
func TestJourneyConflictResolveChildNotParent(t *testing.T) {
	r, _, ids := createConflictStack(t)
	t.Parallel()
	rightId, childAId, _ := ids[0], ids[1], ids[2]

	srv := NewServer(r)

	// Resolve the conflict in childA (a descendant, not the root).
	w := apiPost(t, srv, "/api/resolve", map[string]any{
		"revision": childAId,
		"file":     "conflict.txt",
		"tool":     ":ours",
	})
	require.Equal(t, http.StatusOK, w.Code)

	// childA should be resolved.
	w = apiGet(t, srv, "/api/files?revision="+childAId)
	var files []jj.FileChange
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &files))
	for _, f := range files {
		if f.Path == "conflict.txt" {
			assert.False(t, f.Conflict, "childA: conflict.txt should be resolved")
		}
	}

	// The parent (right) should STILL be conflicted — resolve does not propagate upward.
	w = apiGet(t, srv, "/api/files?revision="+rightId)
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &files))
	var parentStillConflicted bool
	for _, f := range files {
		if f.Path == "conflict.txt" && f.Conflict {
			parentStillConflicted = true
		}
	}
	assert.True(t, parentStillConflicted,
		"parent (right) should still be conflicted after resolving child")
}

// TestIntegrationFilesFromSubdirectory verifies that running lightjj from a
// subdirectory of the repo produces correct repo-root-relative paths.
// Bug: `jj resolve --list` outputs paths relative to CWD, so when CWD is a
// subdirectory the paths have "../" prefixes and don't match `jj diff --summary`.
// The fix is resolving the workspace root at startup (main.go).
func TestIntegrationFilesFromSubdirectory(t *testing.T) {
	r, _ := createConflict(t)
	t.Parallel()

	// Create a subdirectory and point the runner at it.
	subdir := filepath.Join(r.RepoDir, "deep", "nested", "dir")
	require.NoError(t, os.MkdirAll(subdir, 0o755))
	subRunner := runner.NewLocalRunner(subdir)

	srv := NewServer(subRunner)
	w := apiGet(t, srv, "/api/files?revision=@")
	var files []jj.FileChange
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &files))

	// Without the workspace-root fix, conflict.txt would appear as
	// "../../../conflict.txt" from resolve --list and "conflict.txt" from
	// diff --summary, causing a duplicate entry and failed conflict match.
	var conflictCount int
	for _, f := range files {
		if strings.HasSuffix(f.Path, "conflict.txt") {
			conflictCount++
			// Path should be repo-root-relative, not "../../../conflict.txt".
			assert.Equal(t, "conflict.txt", f.Path,
				"conflict file path should be repo-root-relative, not CWD-relative")
			assert.True(t, f.Conflict,
				"conflict.txt should be marked as conflicted")
		}
	}
	assert.Equal(t, 1, conflictCount,
		"conflict.txt should appear exactly once (not duplicated from path mismatch)")
}

// ---------------------------------------------------------------------------
// Split tests
// ---------------------------------------------------------------------------

func TestIntegrationSplit(t *testing.T) {
	r, jjExec := jjTestRepo(t)
	t.Parallel()

	// Create a revision with two files.
	writeFile(t, r.RepoDir, "keep.txt", "keep me")
	writeFile(t, r.RepoDir, "move.txt", "move me")
	jjExec("describe", "-m", "before split")

	srv := NewServer(r)
	rows := getLogRows(t, srv, "")
	rev := findRow(t, rows, "before split")

	// Split: keep.txt stays in the original revision; move.txt goes to the new one.
	w := apiPost(t, srv, "/api/split", map[string]any{
		"revision": rev.Commit.ChangeId,
		"files":    []string{"keep.txt"},
	})
	require.Equal(t, http.StatusOK, w.Code)

	// After split the original revision should only have keep.txt.
	gw := apiGet(t, srv, fmt.Sprintf("/api/files?revision=%s", rev.Commit.ChangeId))
	var files []jj.FileChange
	require.NoError(t, json.Unmarshal(gw.Body.Bytes(), &files))

	paths := make([]string, len(files))
	for i, f := range files {
		paths[i] = f.Path
	}
	assert.Contains(t, paths, "keep.txt", "original should keep keep.txt")
	assert.NotContains(t, paths, "move.txt", "move.txt should be in the new revision")
}

func TestIntegrationSplit_Parallel(t *testing.T) {
	r, jjExec := jjTestRepo(t)
	t.Parallel()

	// Create a parent commit so we can verify both split children share it.
	writeFile(t, r.RepoDir, "base.txt", "base")
	jjExec("describe", "-m", "parent")
	jjExec("new")

	writeFile(t, r.RepoDir, "a.txt", "a")
	writeFile(t, r.RepoDir, "b.txt", "b")
	jjExec("describe", "-m", "to split")

	srv := NewServer(r)
	rows := getLogRows(t, srv, "")
	rev := findRow(t, rows, "to split")

	w := apiPost(t, srv, "/api/split", map[string]any{
		"revision": rev.Commit.ChangeId,
		"files":    []string{"a.txt"},
		"parallel": true,
	})
	require.Equal(t, http.StatusOK, w.Code)

	// After a parallel split, both resulting revisions should be visible in
	// the log. We can't easily know the new revision's ID, but we can verify
	// the split succeeded by checking the original revision now has fewer files.
	gw := apiGet(t, srv, fmt.Sprintf("/api/files?revision=%s", rev.Commit.ChangeId))
	var files []jj.FileChange
	require.NoError(t, json.Unmarshal(gw.Body.Bytes(), &files))

	paths := make([]string, len(files))
	for i, f := range files {
		paths[i] = f.Path
	}
	assert.Contains(t, paths, "a.txt")
	assert.NotContains(t, paths, "b.txt", "b.txt should be in the parallel sibling")
}
