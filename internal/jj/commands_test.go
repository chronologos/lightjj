package jj

import (
	"slices"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestLogGraph(t *testing.T) {
	args := LogGraph("main..@", 500)
	assert.Equal(t, "log", args[0])
	assert.Contains(t, args, "--color")
	assert.Contains(t, args, "never")
	assert.Contains(t, args, "-r")
	assert.Contains(t, args, "main..@")
	assert.Contains(t, args, "--limit")
	assert.Contains(t, args, "500")
	// Must NOT contain --no-graph — graph chars encode topology
	assert.NotContains(t, args, "--no-graph")
	// Snapshot loop handles WC snapshots; log must not redundantly snapshot
	// (saves ~485ms/call and avoids WC lock contention with the snapshot loop).
	assert.Contains(t, args, "--ignore-working-copy")
	// Template must use \x1F field separator (not tabs, which appear in descriptions)
	joined := strings.Join(args, " ")
	assert.Contains(t, joined, "-T ")
	assert.Contains(t, joined, `\x1F`)
	assert.Contains(t, joined, JJUIPrefix)
	assert.Contains(t, joined, "divergent")
	assert.Contains(t, joined, "empty")
	// Outside separate() — explicit concat so empty email doesn't shift positions.
	assert.Contains(t, joined, "stringify(mine)")
	assert.Contains(t, joined, "author.email()")
	// self.hidden() marker — REQUIRED so revset-resurrected hidden commits
	// (normal `○` glyph, glyph inference misses them) are flagged; without it two
	// rows can share a change_id with hidden=false → duplicate frontend each-keys.
	// Explicit '++ _PREFIX: ++' concat, NOT separate().
	assert.Contains(t, joined, "stringify(self.hidden())")
	assert.Contains(t, joined, "parents")
	// local_bookmarks + remote_bookmarks concatenated — `bookmarks` alone
	// collapses tracked-and-synced remotes into the local form.
	assert.Contains(t, joined, "local_bookmarks.map")
	assert.Contains(t, joined, "remote_bookmarks.map")
	assert.Contains(t, joined, `\x1E`) // name/remote separator (git-ref-safe)
}

func TestLogGraph_NoRevset(t *testing.T) {
	args := LogGraph("", 0)
	assert.NotContains(t, args, "-r")
	assert.NotContains(t, args, "--limit")
}

func TestFileShow(t *testing.T) {
	// Default (snapshotMarkers=false) — must match Diff() / `jj split --tool`'s
	// $left so executeHunkReview's applyHunks line offsets stay aligned.
	got := FileShow("abc", "src/main.go", false)
	assert.Equal(t, []string{
		"file", "show", "-r", "abc", "--ignore-working-copy",
		`root-file:"src/main.go"`,
	}, got)
	// snapshotMarkers=true — merge-controller path. Byte-exact base.
	got = FileShow("abc", "src/main.go", true)
	assert.Equal(t, []string{
		"file", "show", "-r", "abc", "--ignore-working-copy",
		"--config", "ui.conflict-marker-style=snapshot",
		`root-file:"src/main.go"`,
	}, got)
}

func TestFileShow_EscapesPath(t *testing.T) {
	// Dash-prefixed paths could be interpreted as flags without EscapeFileName
	got := FileShow("abc", "-rm", false)
	assert.Equal(t, `root-file:"-rm"`, got[len(got)-1])
}

func TestResolveApply(t *testing.T) {
	got := ResolveApply("abc", "/tmp/result.txt", "src/main.go")
	assert.Equal(t, []string{
		"resolve", "-r", "abc",
		"--config", `merge-tools.ljjcp.program="cp"`,
		"--config", `merge-tools.ljjcp.merge-args=["/tmp/result.txt","$output"]`,
		"--tool", "ljjcp",
		"--", `root-file:"src/main.go"`,
	}, got)
}

func TestResolveApply_QuotesResultPath(t *testing.T) {
	// %q escapes embedded quotes/backslashes — TOML basic-string compatible.
	got := ResolveApply("abc", `/tmp/a"b.txt`, "f.go")
	assert.Contains(t, got, `merge-tools.ljjcp.merge-args=["/tmp/a\"b.txt","$output"]`)
}

func TestNew(t *testing.T) {
	revs := NewSelectedRevisions(&Commit{ChangeId: "abc"})
	got := New(revs)
	assert.Equal(t, []string{"new", "-r", "abc"}, got)
}

func TestEdit(t *testing.T) {
	assert.Equal(t, []string{"edit", "-r", "xyz"}, Edit("xyz", false))
	assert.Equal(t, []string{"edit", "-r", "xyz", "--ignore-immutable"}, Edit("xyz", true))
}

func TestMetaeditUpdateChangeId(t *testing.T) {
	assert.Equal(t,
		[]string{"metaedit", "-r", "abc123", "--update-change-id"},
		MetaeditUpdateChangeId("abc123"),
	)
}

func TestAbandon(t *testing.T) {
	revs := NewSelectedRevisions(&Commit{ChangeId: "abc"}, &Commit{ChangeId: "def"})
	got := Abandon(revs, false)
	assert.Equal(t, []string{"abandon", "--retain-bookmarks", "-r", "abc", "-r", "def"}, got)
}

func TestAbandon_IgnoreImmutable(t *testing.T) {
	revs := NewSelectedRevisions(&Commit{ChangeId: "abc"})
	got := Abandon(revs, true)
	assert.Contains(t, got, "--ignore-immutable")
}

func TestDiff(t *testing.T) {
	got := Diff("abc", "", "")
	assert.Equal(t, []string{"diff", "-r", "abc", "--color", "always", "--ignore-working-copy", "--config", pinGitDiffPrefix}, got)
}

func TestDiff_NoColor(t *testing.T) {
	got := Diff("abc", "", "never")
	assert.Equal(t, []string{"diff", "-r", "abc", "--color", "never", "--ignore-working-copy", "--config", pinGitDiffPrefix}, got)
}

func TestDiff_WithFile(t *testing.T) {
	got := Diff("abc", "src/main.go", "")
	assert.Contains(t, got, `root-file:"src/main.go"`)
}

func TestSquash(t *testing.T) {
	from := NewSelectedRevisions(&Commit{ChangeId: "abc"})
	got := Squash(from, "def", nil, false, false, "")
	assert.Equal(t, []string{"squash", "--from", "abc", "--into", "def", "--use-destination-message"}, got)
}

func TestSquash_AllFlags(t *testing.T) {
	from := NewSelectedRevisions(&Commit{ChangeId: "abc"})
	got := Squash(from, "def", []string{"file.go"}, true, true, "")
	assert.Contains(t, got, "--keep-emptied")
	assert.Contains(t, got, "--use-destination-message")
	assert.Contains(t, got, "--ignore-immutable")
	assert.Contains(t, got, `root-file:"file.go"`)
}

func TestSquash_Message(t *testing.T) {
	from := NewSelectedRevisions(&Commit{ChangeId: "abc"})
	got := Squash(from, "def", nil, false, false, "combined desc")
	assert.Equal(t, []string{"squash", "--from", "abc", "--into", "def", "-m", "combined desc"}, got)
	assert.NotContains(t, got, "--use-destination-message")
}

func TestBookmarkSet(t *testing.T) {
	got := BookmarkSet("abc", "main")
	assert.Equal(t, []string{"bookmark", "set", "-r", "abc", "main"}, got)
}

func TestBookmarkSetToRemote(t *testing.T) {
	got := BookmarkSetToRemote("master", "origin")
	assert.Equal(t, []string{"bookmark", "set", "-r", "master@origin", "master", "--allow-backwards"}, got)
}

func TestBookmarkSetToRemote_DotInName(t *testing.T) {
	// jj allows dots in bookmark names (e.g. release/v1.21.1) — verify the
	// builder doesn't try to quote/escape (revset @ operator must stay
	// unquoted, and the name itself is safe per jj's bookmark-name grammar).
	got := BookmarkSetToRemote("release/v1.21.1", "origin")
	assert.Equal(t, []string{"bookmark", "set", "-r", "release/v1.21.1@origin", "release/v1.21.1", "--allow-backwards"}, got)
}

func TestBookmarkTrack(t *testing.T) {
	got := BookmarkTrack("main", "origin")
	assert.Equal(t, []string{"bookmark", "track", "exact:main", "--remote", "origin"}, got)
}

func TestBookmarkTrack_NoRemote(t *testing.T) {
	got := BookmarkTrack("main", "")
	assert.Equal(t, []string{"bookmark", "track", "exact:main"}, got)
}

func TestGitPush(t *testing.T) {
	got := GitPush("--bookmark", "main")
	assert.Equal(t, []string{"git", "push", "--bookmark", "main"}, got)
}

func TestGitFetch(t *testing.T) {
	got := GitFetch("--remote", "origin")
	assert.Equal(t, []string{"git", "fetch", "--remote", "origin"}, got)
}

func TestRebase(t *testing.T) {
	from := NewSelectedRevisions(&Commit{ChangeId: "abc"})
	got := Rebase(from, []string{"def"}, "-r", "-d", RebaseOptions{})
	assert.Equal(t, []string{"rebase", "-r", "abc", "-d", "def"}, got)
}

func TestRebase_MultipleDestinations(t *testing.T) {
	// Megamerge: rewrite abc's parent set to {def, ghi, jkl} — one repeated
	// target flag per destination.
	from := NewSelectedRevisions(&Commit{ChangeId: "abc"})
	got := Rebase(from, []string{"def", "ghi", "jkl"}, "-r", "-d", RebaseOptions{})
	assert.Equal(t, []string{"rebase", "-r", "abc", "-d", "def", "-d", "ghi", "-d", "jkl"}, got)
}

func TestRebase_Flags(t *testing.T) {
	from := NewSelectedRevisions(&Commit{ChangeId: "abc"})
	got := Rebase(from, []string{"def"}, "-r", "-d", RebaseOptions{SkipEmptied: true, IgnoreImmutable: true, SimplifyParents: true})
	assert.Equal(t, []string{"rebase", "-r", "abc", "-d", "def", "--ignore-immutable", "--skip-emptied", "--simplify-parents"}, got)
}

func TestEscapeFileName(t *testing.T) {
	tests := []struct {
		name     string
		input    string
		expected string
	}{
		{"simple", "simple.go", `root-file:"simple.go"`},
		{"spaces", "path with spaces/file.go", `root-file:"path with spaces/file.go"`},
		{"double quote", `has"quote.go`, `root-file:"has\"quote.go"`},
		{"backslash", `path\to\file.go`, `root-file:"path\\to\\file.go"`},
		{"backslash and quote", `a\"b.go`, `root-file:"a\\\"b.go"`},
		{"unicode", "fichier-\u00e9t\u00e9.go", `root-file:"fichier-été.go"`},
		{"unicode CJK", "\u6587\u4ef6.txt", `root-file:"文件.txt"`},
		{"multiple spaces", "a  b  c.go", `root-file:"a  b  c.go"`},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			assert.Equal(t, tt.expected, EscapeFileName(tt.input))
		})
	}
}

func TestSetDescription(t *testing.T) {
	args, stdin := SetDescription("abc", "my description")
	assert.Equal(t, []string{"describe", "-r", "abc", "--stdin"}, args)
	assert.Equal(t, "my description", stdin)
}

func TestSplit(t *testing.T) {
	got := Split("abc", []string{"main.go"}, true)
	assert.Contains(t, got, "--parallel")
	assert.Contains(t, got, "-m")
	assert.Contains(t, got, `root-file:"main.go"`)
}

func TestSplit_NoFilesNoMessage(t *testing.T) {
	got := Split("abc", nil, false)
	assert.NotContains(t, got, "-m")
}

func TestSplitWithTool(t *testing.T) {
	got := SplitWithTool("abc", "/tmp/tool.toml", "fix: the bug")
	want := []string{"split", "-r", "abc", "-m", "fix: the bug",
		"--config-file", "/tmp/tool.toml", "--tool", "lightjj-hunks"}
	assert.Equal(t, want, got)
	// -m is load-bearing twice: suppresses $EDITOR (hang) AND preserves
	// the description on the accepted-hunks commit (jj split -m sets the
	// FIRST commit's message; second keeps original automatically).
}

func TestUndo(t *testing.T) {
	assert.Equal(t, []string{"undo"}, Undo())
}

func TestOpRevert(t *testing.T) {
	assert.Equal(t, []string{"op", "revert", "abc123"}, OpRevert("abc123"))
}

func TestOpRestore(t *testing.T) {
	assert.Equal(t, []string{"op", "restore", "abc123"}, OpRestore("abc123"))
}

func TestOpShow(t *testing.T) {
	got := OpShow("abc123")
	assert.Equal(t, "op", got[0])
	assert.Equal(t, "show", got[1])
	assert.Contains(t, got, "--no-graph")
	assert.Contains(t, got, "--color")
	assert.Contains(t, got, "never")
	assert.Contains(t, got, "--ignore-working-copy")
	assert.Equal(t, "abc123", got[len(got)-1])
}

func TestRestoreFromTo(t *testing.T) {
	assert.Equal(t, []string{"restore", "--from", "abc", "--to", "def"}, RestoreFromTo("abc", "def"))
}

func TestCurrentOpId(t *testing.T) {
	got := CurrentOpId()
	assert.Contains(t, got, "op")
	assert.Contains(t, got, "log")
	assert.Contains(t, got, "--no-graph")
	assert.Contains(t, got, "--limit")
	assert.Contains(t, got, "1")
	assert.Contains(t, got, "--ignore-working-copy")
	// Must use -T with the template string
	assert.Contains(t, got, "-T")
	assert.Contains(t, got, "self.id().short()")
}

func TestPollOpId(t *testing.T) {
	// The absence of --ignore-working-copy IS the feature — it makes
	// sshPollLoop the snapshot path in SSH mode (no snapshotLoop there).
	got := PollOpId()
	assert.NotContains(t, got, "--ignore-working-copy")
	assert.Contains(t, got, "op")
	assert.Contains(t, got, "log")
	assert.Contains(t, got, "--no-graph")
	assert.Contains(t, got, "--limit")
	assert.Contains(t, got, "1")
	assert.Contains(t, got, "-T")
	assert.Contains(t, got, "self.id().short()")
}

func TestDebugSnapshot(t *testing.T) {
	got := DebugSnapshot()
	assert.Equal(t, CommandArgs{"util", "snapshot"}, got)
}

func TestWorkspaceAdd(t *testing.T) {
	assert.Equal(t,
		CommandArgs{"workspace", "add", "/tmp/r-feat", "--name", "feat"},
		WorkspaceAdd("/tmp/r-feat", "feat", ""))
	assert.Equal(t,
		CommandArgs{"workspace", "add", "/tmp/r-feat"},
		WorkspaceAdd("/tmp/r-feat", "", ""))
	assert.Equal(t,
		CommandArgs{"workspace", "add", "/tmp/r-feat", "--name", "feat", "-r", "xyz"},
		WorkspaceAdd("/tmp/r-feat", "feat", "xyz"))
}

func TestWorkspaceForget(t *testing.T) {
	assert.Equal(t, CommandArgs{"workspace", "forget", "--", "feat"}, WorkspaceForget("feat"))
	// Flag-like names stay positional: without "--", clap would parse this as
	// a global flag and forget the CURRENT workspace.
	assert.Equal(t, CommandArgs{"workspace", "forget", "--", "--quiet"}, WorkspaceForget("--quiet"))
}

func TestWorkspaceRename(t *testing.T) {
	assert.Equal(t, CommandArgs{"workspace", "rename", "--", "feat"}, WorkspaceRename("feat"))
	assert.Equal(t, CommandArgs{"workspace", "rename", "--", "--quiet"}, WorkspaceRename("--quiet"))
}

func TestWorkspaceUpdateStale(t *testing.T) {
	got := WorkspaceUpdateStale()
	assert.Equal(t, CommandArgs{"workspace", "update-stale"}, got)
}

func TestWorkspaceUpdateStaleAt(t *testing.T) {
	got := WorkspaceUpdateStaleAt("/home/u/repo-feat")
	assert.Equal(t, CommandArgs{"-R", "/home/u/repo-feat", "workspace", "update-stale"}, got)
}

func TestFilesTemplate(t *testing.T) {
	args := FilesTemplate("abc")
	assert.Equal(t, "log", args[0])
	assert.Contains(t, args, "-r")
	assert.Contains(t, args, "abc")
	assert.Contains(t, args, "--no-graph")
	assert.Contains(t, args, "--ignore-working-copy")
	joined := strings.Join(args, " ")
	// Single template combines file stats + conflict info
	assert.Contains(t, joined, "diff().stat(")
	assert.Contains(t, joined, "status_char()")
	assert.Contains(t, joined, "lines_added()")
	assert.Contains(t, joined, "lines_removed()")
	assert.Contains(t, joined, "conflicted_files")
	assert.Contains(t, joined, "conflict_side_count()")
	assert.Contains(t, joined, `\x1F`)
	assert.Contains(t, joined, `\x1E`)
	assert.Contains(t, joined, `\x1D`)
}

func TestParseFilesTemplate(t *testing.T) {
	tests := []struct {
		name  string
		input string
		want  []FileChange
	}{
		{
			name:  "files only, no conflicts",
			input: "M\x1Fsrc/main.go\x1F7\x1F3\nA\x1Fnew.go\x1F5\x1F0\x1E\x1D",
			want: []FileChange{
				{Type: "M", Path: "src/main.go", Additions: 7, Deletions: 3},
				{Type: "A", Path: "new.go", Additions: 5, Deletions: 0},
			},
		},
		{
			name:  "file with conflict flag set",
			input: "M\x1Fa.go\x1F2\x1F1\nM\x1Fb.go\x1F0\x1F0\x1Eb.go\x1F2\x1D",
			want: []FileChange{
				{Type: "M", Path: "a.go", Additions: 2, Deletions: 1},
				{Type: "M", Path: "b.go", Conflict: true, ConflictSides: 2},
			},
		},
		{
			// Merge commits can have conflicted files with no diff hunks.
			// They must be appended (not dropped) so the UI can show them.
			name:  "conflict-only file appended",
			input: "M\x1Fa.go\x1F1\x1F0\x1Ephantom.go\x1F3\x1D",
			want: []FileChange{
				{Type: "M", Path: "a.go", Additions: 1},
				{Type: "M", Path: "phantom.go", Conflict: true, ConflictSides: 3},
			},
		},
		{
			// Multi-revision revsets can emit the same conflict path in
			// separate commits. byPath-keyed merge dedups so {#each} keys
			// stay unique. Last-write-wins for ConflictSides.
			name:  "duplicate conflict paths deduped (multi-commit)",
			input: "\x1Efile.go\x1F2\x1D\x1Efile.go\x1F3\x1D",
			want: []FileChange{
				{Type: "M", Path: "file.go", Conflict: true, ConflictSides: 3},
			},
		},
		{
			// Multi-revision revsets emit the template PER-COMMIT. A file
			// touched in both commits appears in separate chunks.
			// Stats are summed; Type from the first (newest) occurrence.
			// Without this, duplicate FileChange entries break {#each} keys.
			name:  "duplicate file paths (multi-rev) — stats summed",
			input: "M\x1Fa.go\x1F3\x1F1\x1E\x1DA\x1Fa.go\x1F5\x1F0\x1E\x1D",
			want: []FileChange{
				{Type: "M", Path: "a.go", Additions: 8, Deletions: 1},
			},
		},
		{
			// Clean revision — both template sections empty but \x1E always present.
			name:  "empty sections (clean revision)",
			input: "\x1E\x1D",
			want:  []FileChange{},
		},
		{
			// DiffStatEntry.path() returns the DESTINATION for renames — no
			// brace expansion needed. Template output is already the dest path.
			name:  "rename has destination path (no braces)",
			input: "R\x1Fnew_name.go\x1F10\x1F0\x1E\x1D",
			want: []FileChange{
				{Type: "R", Path: "new_name.go", Additions: 10},
			},
		},
		{
			// Multi-commit: each commit produces its own \x1D-terminated chunk.
			// Without per-commit splitting, commit 2's files land in commit 1's
			// conflict section and are misinterpreted.
			name:  "multi-commit — files from all commits visible",
			input: "M\x1Ffoo.go\x1F10\x1F5\x1E\x1DM\x1Fbar.go\x1F3\x1F1\x1E\x1D",
			want: []FileChange{
				{Type: "M", Path: "foo.go", Additions: 10, Deletions: 5},
				{Type: "M", Path: "bar.go", Additions: 3, Deletions: 1},
			},
		},
		{
			// Multi-commit where one commit has conflicts and another doesn't.
			name:  "multi-commit — conflicts correctly separated",
			input: "M\x1Ffoo.go\x1F10\x1F5\x1Efoo.go\x1F2\x1DM\x1Fbar.go\x1F3\x1F1\x1E\x1D",
			want: []FileChange{
				{Type: "M", Path: "foo.go", Additions: 10, Deletions: 5, Conflict: true, ConflictSides: 2},
				{Type: "M", Path: "bar.go", Additions: 3, Deletions: 1},
			},
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := ParseFilesTemplate(tt.input)
			assert.Equal(t, tt.want, got)
		})
	}
}

func TestBookmarkMove(t *testing.T) {
	got := BookmarkMove("abc", "feature")
	assert.Equal(t, []string{"bookmark", "move", "exact:feature", "--to", "abc"}, got)
}

func TestBookmarkAdvance(t *testing.T) {
	got := BookmarkAdvance("abc", "feature")
	assert.Equal(t, []string{"bookmark", "advance", "exact:feature", "--to", "abc"}, got)
}

func TestBookmarkForget(t *testing.T) {
	got := BookmarkForget("feature")
	assert.Equal(t, []string{"bookmark", "forget", "exact:feature"}, got)
}

func TestBookmarkDelete(t *testing.T) {
	got := BookmarkDelete("feature")
	assert.Equal(t, []string{"bookmark", "delete", "exact:feature"}, got)
}

// Locks the glob-guard: a bookmark named `feat-*` (jj accepts; git-export
// warns) must NOT match feat-a, feat-b. The exact: prefix is what makes this
// safe — without it, `jj bookmark delete feat-*` deletes every feat- bookmark.
func TestBookmarkDelete_GlobCharName(t *testing.T) {
	got := BookmarkDelete("feat-*")
	assert.Equal(t, []string{"bookmark", "delete", "exact:feat-*"}, got)
}

func TestBookmarkUntrack(t *testing.T) {
	got := BookmarkUntrack("main", "origin")
	assert.Equal(t, []string{"bookmark", "untrack", "exact:main", "--remote", "origin"}, got)
}

func TestBookmarkUntrack_NoRemote(t *testing.T) {
	got := BookmarkUntrack("main", "")
	assert.Equal(t, []string{"bookmark", "untrack", "exact:main"}, got)
}

func TestCommitWorkingCopy(t *testing.T) {
	assert.Equal(t, []string{"commit", "-m", ""}, CommitWorkingCopy(""))
	assert.Equal(t, []string{"commit", "-m", "my message"}, CommitWorkingCopy("my message"))
}

func TestRestore(t *testing.T) {
	got := Restore("abc", []string{"main.go"})
	assert.Equal(t, []string{"restore", "-c", "abc", `root-file:"main.go"`}, got)
}

func TestRestore_MultipleFiles(t *testing.T) {
	got := Restore("abc", []string{"a.go", "b/c.go"})
	assert.Equal(t, []string{"restore", "-c", "abc", `root-file:"a.go"`, `root-file:"b/c.go"`}, got)
}

// ── OpLog / ParseOpLog — the json()-template exemplar ──────────────

func TestOpLog(t *testing.T) {
	args := OpLog(50)
	assert.Equal(t, "op", args[0])
	assert.Equal(t, "log", args[1])
	assert.Contains(t, args, "--limit")
	assert.Contains(t, args, "50")
	assert.Contains(t, args, "--no-graph")
	assert.Contains(t, args, "--ignore-working-copy")

	tmpl := args[len(args)-1]
	// Each string field is individually json()-wrapped (named-field schema we
	// control), the boolean uses the proven if() form, and there are NO
	// control-character delimiters anywhere.
	assert.Contains(t, tmpl, `json(self.id().short())`)
	assert.Contains(t, tmpl, `json(self.description())`)
	assert.Contains(t, tmpl, `json(stringify(self.time().start()))`)
	assert.Contains(t, tmpl, `if(self.current_operation(), "true", "false")`)
	assert.NotContains(t, tmpl, "\x1f")
	assert.NotContains(t, tmpl, "\x1e")
	assert.NotContains(t, tmpl, "\x1d")
	// And no whole-object serialization — schema must stay under our control.
	assert.NotContains(t, tmpl, "json(self)")
}

func TestOpLog_NoLimit(t *testing.T) {
	args := OpLog(0)
	assert.NotContains(t, args, "--limit")
}

func TestParseOpLog(t *testing.T) {
	// As jj emits it: one JSON object per line. The second record's description
	// carries the exact payload class that breaks positional parsers — embedded
	// quote, newline, and a \x1F unit separator — all JSON-escaped by json() so
	// the record still occupies a single line.
	output := `{"id":"abc123","description":"describe commit xyz","time":"2026-05-30 10:00:00.000 -07:00","current":true}` + "\n" +
		`{"id":"def456","description":"weird \"quoted\" desc with\nnewline and \u001f separator","time":"2026-05-30 09:00:00.000 -07:00","current":false}` + "\n"
	entries := ParseOpLog(output)
	assert.Len(t, entries, 2)
	assert.Equal(t, "abc123", entries[0].ID)
	assert.Equal(t, "describe commit xyz", entries[0].Description)
	assert.Equal(t, "2026-05-30 10:00:00.000 -07:00", entries[0].Time)
	assert.True(t, entries[0].IsCurrent)
	assert.Equal(t, "weird \"quoted\" desc with\nnewline and \x1f separator", entries[1].Description)
	assert.False(t, entries[1].IsCurrent)
}

func TestParseOpLog_Empty(t *testing.T) {
	entries := ParseOpLog("")
	assert.Empty(t, entries)
	assert.NotNil(t, entries) // empty slice, not nil — JSON serializes as []
}

func TestParseOpLog_SkipsMalformedLines(t *testing.T) {
	output := `{"id":"good","description":"d","time":"t","current":false}` + "\n" +
		"this is not json\n" +
		`{"id":"also-good","description":"d2","time":"t2","current":true}` + "\n"
	entries := ParseOpLog(output)
	assert.Len(t, entries, 2)
	assert.Equal(t, "good", entries[0].ID)
	assert.Equal(t, "also-good", entries[1].ID)
}

func TestDiffRange(t *testing.T) {
	got := DiffRange("abc", "def", nil)
	assert.Equal(t, []string{"diff", "--from", "abc", "--to", "def", "--tool", ":git", "--color", "never", "--ignore-working-copy", "--config", pinGitDiffPrefix}, got)
}

func TestDiffRange_WithFiles(t *testing.T) {
	got := DiffRange("abc", "def", []string{"src/main.go", "README.md"})
	assert.Contains(t, got, `root-file:"src/main.go"`)
	assert.Contains(t, got, `root-file:"README.md"`)
	assert.Equal(t, "abc", got[2]) // --from value
	assert.Equal(t, "def", got[4]) // --to value
}

func TestEvolog(t *testing.T) {
	got := Evolog("abc")
	assert.Contains(t, got, "evolog")
	assert.Contains(t, got, "-r")
	assert.Contains(t, got, "abc")
	assert.Contains(t, got, "--no-graph")
	assert.Contains(t, got, "-T")
}

func TestParseEvolog(t *testing.T) {
	// Diff text (5th field) contains newlines — \x1E record sep keeps it intact.
	diffText := "diff --git a/f.txt b/f.txt\n--- a/f.txt\n+++ b/f.txt\n@@ -1 +1 @@\n-old\n+new\n"
	output := "d00e01ea653d\x1f2026-02-27 15:03:07\x1fsnapshot working copy\x1f3e06196802f1\x1f" + diffText + "\x1e" +
		"3e06196802f1\x1f2026-02-27 15:03:01\x1fsnapshot working copy\x1fb2b7be97c389,abc123\x1f\x1e" +
		"b48bc18a97e2\x1f2026-02-27 14:49:04\x1fnew empty commit\x1f\x1f\x1e"
	entries := ParseEvolog(output)
	assert.Len(t, entries, 3)
	assert.Equal(t, "d00e01ea653d", entries[0].CommitId)
	assert.Equal(t, "2026-02-27 15:03:07", entries[0].Time)
	assert.Equal(t, "snapshot working copy", entries[0].Operation)
	assert.Equal(t, []string{"3e06196802f1"}, entries[0].PredecessorIds)
	assert.Equal(t, diffText, entries[0].Diff)
	assert.Equal(t, []string{"b2b7be97c389", "abc123"}, entries[1].PredecessorIds)
	assert.Equal(t, "", entries[1].Diff, "empty diff for metadata-only op")
	assert.Equal(t, "2026-02-27 14:49:04", entries[2].Time)
	assert.Equal(t, []string{}, entries[2].PredecessorIds)
}

func TestParseEvolog_Empty(t *testing.T) {
	entries := ParseEvolog("")
	assert.Len(t, entries, 0)
	assert.NotNil(t, entries)
}

func TestParseEvolog_Malformed(t *testing.T) {
	entries := ParseEvolog("only\x1ftwo\x1ffields\x1e")
	assert.Empty(t, entries)
}

func TestWorkspaceList(t *testing.T) {
	joined := strings.Join(WorkspaceList(), " ")
	assert.True(t, strings.HasPrefix(joined, "workspace list "))
	for _, want := range []string{"--ignore-working-copy", "-T", "name", "target.change_id()", "target.commit_id()", "target.current_working_copy()", `\x1F`, "self.root()"} {
		assert.Contains(t, joined, want)
	}
}

// Verified against jj 0.40/0.43 (error text) and 0.47 (empty).
func TestParseWorkspaceList_UnknownPath(t *testing.T) {
	for _, root := range []string{"", "<Error: Workspace has no recorded path: b>", "<Error: Failed to resolve workspace root: b: /x/../b: No such file or directory (os error 2)>"} {
		ws := ParseWorkspaceList("b\x1Fabc\x1Fdef\x1Ffalse\x1F" + root + "\na\x1Fabc\x1Fdef\x1Ftrue\x1F/repo\n")
		assert.Len(t, ws, 2)
		assert.Empty(t, ws[0].Path)
		assert.Equal(t, "/repo", ws[1].Path)
	}
}

func TestTooOld(t *testing.T) {
	for v, want := range map[string]bool{"jj 0.39.0": true, "jj 0.40.0": false, "jj 0.47.1-abc": false, "jj 1.0.0": false, "jj-dev": false, "": false} {
		assert.Equal(t, want, TooOld(v), v)
	}
}

func TestParseWorkspaceList(t *testing.T) {
	output := "base2\x1Fskpssuxl\x1Fa14ce848\x1Ffalse\x1F/b2\ndefault\x1Fqqqqpqpq\x1Fbbbbbbbb\x1Ftrue\x1F/d\n"
	ws := ParseWorkspaceList(output)
	assert.Len(t, ws, 2)
	assert.Equal(t, "base2", ws[0].Name)
	assert.Equal(t, "skpssuxl", ws[0].ChangeId)
	assert.Equal(t, "a14ce848", ws[0].CommitId)
	assert.False(t, ws[0].Current)
	assert.Equal(t, "default", ws[1].Name)
	assert.Equal(t, "qqqqpqpq", ws[1].ChangeId)
	assert.Equal(t, "bbbbbbbb", ws[1].CommitId)
	assert.True(t, ws[1].Current)
}

func TestParseWorkspaceList_NameWithColon(t *testing.T) {
	// Workspace names containing ": " broke the old human-output parser.
	// Template output is \x1F-delimited so colons are safe.
	output := "weird: name\x1Fabc\x1Fdef\x1Ffalse\x1F/w\n"
	ws := ParseWorkspaceList(output)
	assert.Len(t, ws, 1)
	assert.Equal(t, "weird: name", ws[0].Name)
}

func TestParseWorkspaceList_Empty(t *testing.T) {
	ws := ParseWorkspaceList("")
	assert.Empty(t, ws)
}

func TestParseWorkspaceList_WithRoot(t *testing.T) {
	output := "default\x1Fabc\x1Fdef\x1Ftrue\x1F/home/u/repo\n"
	ws := ParseWorkspaceList(output)
	assert.Len(t, ws, 1)
	assert.Equal(t, "default", ws[0].Name)
	assert.True(t, ws[0].Current)
	assert.Equal(t, "/home/u/repo", ws[0].Path)
}

func TestResolve(t *testing.T) {
	got := Resolve("abc", "src/main.go", ":ours")
	assert.Equal(t, []string{"resolve", "--tool", ":ours", "-r", "abc", `root-file:"src/main.go"`}, got)
}

func TestResolve_EscapedFile(t *testing.T) {
	got := Resolve("abc", `path with "quotes".go`, ":theirs")
	assert.Equal(t, []string{"resolve", "--tool", ":theirs", "-r", "abc", `root-file:"path with \"quotes\".go"`}, got)
}

func TestConfigGet(t *testing.T) {
	got := ConfigGet("git.push")
	assert.Equal(t, []string{"config", "get", "git.push", "--color", "never", "--ignore-working-copy"}, got)
}

func TestConflictList(t *testing.T) {
	t.Run("default revset", func(t *testing.T) {
		args := ConflictList("")
		assert.Equal(t, "log", args[0])
		assert.Contains(t, args, "-r")
		// & mutable() is the 60× speedup on large repos — jj can evaluate
		// the cheap set filter first, skip immutable-tree walk.
		assert.Contains(t, args, "conflicts() & mutable()")
		assert.Contains(t, args, "--ignore-working-copy")
		assert.Contains(t, args, "--no-graph")
		joined := strings.Join(args, " ")
		assert.Contains(t, joined, "conflicted_files")
		assert.Contains(t, joined, "conflict_side_count")
	})

	t.Run("custom revset", func(t *testing.T) {
		args := ConflictList("conflicts() & ::@")
		assert.Contains(t, args, "conflicts() & ::@")
	})
}

func TestParseConflictList(t *testing.T) {
	// Two commits, first with 2 conflicted files (one 3-way), second with 1.
	raw := "abc12345\x1Ewlykovwr\x1Erebase stack\x1E" +
		"src/a.go\x1F2\nsrc/b.go\x1F3\x1D" +
		"def67890\x1Exyzmnopq\x1Efix\x1E" +
		"README.md\x1F2\x1D"

	got := ParseConflictList(raw)
	assert.Len(t, got, 2)

	assert.Equal(t, "abc12345", got[0].CommitId)
	assert.Equal(t, "wlykovwr", got[0].ChangeId)
	assert.Equal(t, "rebase stack", got[0].Description)
	assert.Len(t, got[0].Files, 2)
	assert.Equal(t, &ConflictFile{Path: "src/a.go", Sides: 2}, got[0].Files[0])
	assert.Equal(t, &ConflictFile{Path: "src/b.go", Sides: 3}, got[0].Files[1])

	assert.Equal(t, "def67890", got[1].CommitId)
	assert.Len(t, got[1].Files, 1)
}

func TestFileLog(t *testing.T) {
	t.Run("default (mutable-scoped)", func(t *testing.T) {
		args := FileLog("src/main.go", 50, false)
		joined := strings.Join(args, " ")
		// Must use root-file: (not file:) — file: is cwd-relative, breaks in SSH
		// mode + secondary workspaces per CLAUDE.md.
		assert.Contains(t, joined, `files(root-file:"src/main.go")`)
		// mutable() intersection is the large repo speedup — 20s → 0.3s.
		assert.Contains(t, joined, `mutable() & files`)
		assert.Contains(t, joined, "--limit 50")
		assert.Contains(t, joined, JJUIPrefix)
	})

	t.Run("full=true drops mutable scope", func(t *testing.T) {
		// Exact -r value: the template text itself contains self.immutable().
		args := FileLog("src/main.go", 50, true)
		i := slices.Index(args, "-r")
		require.GreaterOrEqual(t, i, 0)
		assert.Equal(t, `files(root-file:"src/main.go")`, args[i+1])
	})
}

func TestLogGraph_IgnoresUserGraphConfig(t *testing.T) {
	joined := strings.Join(LogGraph("", 0), " ")
	assert.Contains(t, joined, "--config ui.graph.style=curved")
	assert.Contains(t, joined, "--config templates.log_node=builtin_log_node")
	for _, flag := range []string{"self.immutable()", "self.conflict()", "self.current_working_copy()"} {
		assert.Contains(t, joined, flag)
	}
}

func TestFileLog_EscapesQuotes(t *testing.T) {
	// Paths with " must be escaped to not break the revset string literal.
	args := FileLog(`weird"name.go`, 10, false)
	joined := strings.Join(args, " ")
	assert.Contains(t, joined, `root-file:`)
	assert.NotContains(t, joined, `weird"name.go")`) // unescaped would close early
}

func TestIndexChangedPaths(t *testing.T) {
	assert.Equal(t, []string{"debug", "index-changed-paths"}, IndexChangedPaths())
}

func TestParseConflictList_EmptyAndMalformed(t *testing.T) {
	// Parsers must return empty slices, not nil (JSON serializes [] not null).
	assert.Equal(t, []*ConflictEntry{}, ParseConflictList(""))
	// Trailing \x1D + malformed record → skipped, good record preserved.
	got := ParseConflictList("abc\x1Ewlyk\x1Edesc\x1E\x1Dmalformed\x1D")
	assert.Len(t, got, 1)
	assert.Equal(t, []*ConflictFile{}, got[0].Files)
}
