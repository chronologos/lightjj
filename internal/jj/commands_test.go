package jj

import (
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
)

func TestLogJSON(t *testing.T) {
	args := LogJSON("@", 5)
	assert.Contains(t, args, "--no-graph")
	assert.Contains(t, args, "--color")
	assert.Contains(t, args, "never")
	assert.Contains(t, args, "-r")
	assert.Contains(t, args, "@")
	assert.Contains(t, args, "--limit")
	assert.Contains(t, args, "5")
}

func TestLogGraph(t *testing.T) {
	args := LogGraph("main..@", 500)
	assert.Equal(t, "log", args[0])
	assert.Contains(t, args, "--color")
	assert.Contains(t, args, "never")
	assert.Contains(t, args, "-r")
	assert.Contains(t, args, "main..@")
	assert.Contains(t, args, "--limit")
	assert.Contains(t, args, "500")
	// Must NOT contain --no-graph (unlike LogJSON) — graph chars encode topology
	assert.NotContains(t, args, "--no-graph")
	// Template must use \x1F field separator (not tabs, which appear in descriptions)
	joined := strings.Join(args, " ")
	assert.Contains(t, joined, "-T ")
	assert.Contains(t, joined, `\x1F`)
	assert.Contains(t, joined, JJUIPrefix)
	assert.Contains(t, joined, "divergent")
}

func TestLogGraph_NoRevset(t *testing.T) {
	args := LogGraph("", 0)
	assert.NotContains(t, args, "-r")
	assert.NotContains(t, args, "--limit")
}

func TestFileShow(t *testing.T) {
	got := FileShow("abc", "src/main.go")
	assert.Equal(t, []string{"file", "show", "-r", "abc", `file:"src/main.go"`}, got)
}

func TestFileShow_EscapesPath(t *testing.T) {
	// Dash-prefixed paths could be interpreted as flags without EscapeFileName
	got := FileShow("abc", "-rm")
	assert.Equal(t, `file:"-rm"`, got[len(got)-1])
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
	assert.Equal(t, []string{"diff", "-r", "abc", "--color", "always", "--ignore-working-copy"}, got)
}

func TestDiff_NoColor(t *testing.T) {
	got := Diff("abc", "", "never")
	assert.Equal(t, []string{"diff", "-r", "abc", "--color", "never", "--ignore-working-copy"}, got)
}

func TestDiff_WithFile(t *testing.T) {
	got := Diff("abc", "src/main.go", "")
	assert.Contains(t, got, `file:"src/main.go"`)
}

func TestSquash(t *testing.T) {
	from := NewSelectedRevisions(&Commit{ChangeId: "abc"})
	got := Squash(from, "def", nil, false, false, false, false)
	assert.Equal(t, []string{"squash", "--from", "abc", "--into", "def", "--use-destination-message"}, got)
}

func TestSquash_AllFlags(t *testing.T) {
	from := NewSelectedRevisions(&Commit{ChangeId: "abc"})
	got := Squash(from, "def", []string{"file.go"}, true, true, true, true)
	assert.Contains(t, got, "--keep-emptied")
	assert.Contains(t, got, "--use-destination-message")
	assert.Contains(t, got, "--interactive")
	assert.Contains(t, got, "--ignore-immutable")
	assert.Contains(t, got, `file:"file.go"`)
}

func TestBookmarkSet(t *testing.T) {
	got := BookmarkSet("abc", "main")
	assert.Equal(t, []string{"bookmark", "set", "-r", "abc", "main"}, got)
}

func TestBookmarkTrack(t *testing.T) {
	got := BookmarkTrack("main", "origin")
	assert.Equal(t, []string{"bookmark", "track", "main", "--remote", "origin"}, got)
}

func TestBookmarkTrack_NoRemote(t *testing.T) {
	got := BookmarkTrack("main", "")
	assert.Equal(t, []string{"bookmark", "track", "main"}, got)
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
	got := Rebase(from, "def", "-r", "-d", false, false)
	assert.Equal(t, []string{"rebase", "-r", "abc", "-d", "def"}, got)
}

func TestEscapeFileName(t *testing.T) {
	tests := []struct {
		name     string
		input    string
		expected string
	}{
		{"simple", "simple.go", `file:"simple.go"`},
		{"spaces", "path with spaces/file.go", `file:"path with spaces/file.go"`},
		{"double quote", `has"quote.go`, `file:"has\"quote.go"`},
		{"backslash", `path\to\file.go`, `file:"path\\to\\file.go"`},
		{"backslash and quote", `a\"b.go`, `file:"a\\\"b.go"`},
		{"unicode", "fichier-\u00e9t\u00e9.go", `file:"fichier-été.go"`},
		{"unicode CJK", "\u6587\u4ef6.txt", `file:"文件.txt"`},
		{"multiple spaces", "a  b  c.go", `file:"a  b  c.go"`},
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
	got := Split("abc", []string{"main.go"}, true, false)
	assert.Contains(t, got, "--parallel")
	assert.NotContains(t, got, "--interactive")
	assert.Contains(t, got, "-m")
	assert.Contains(t, got, `file:"main.go"`)
}

func TestSplit_NoFilesNoMessage(t *testing.T) {
	got := Split("abc", nil, false, false)
	assert.NotContains(t, got, "-m")
}

func TestSplit_InteractiveNoMessage(t *testing.T) {
	got := Split("abc", []string{"main.go"}, false, true)
	assert.Contains(t, got, "--interactive")
	assert.NotContains(t, got, "-m")
}

func TestUndoRedo(t *testing.T) {
	assert.Equal(t, []string{"undo"}, Undo())
	assert.Equal(t, []string{"redo"}, Redo())
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

func TestDiffSummary(t *testing.T) {
	got := DiffSummary("abc")
	assert.Equal(t, []string{"diff", "--summary", "--color", "never", "-r", "abc", "--ignore-working-copy"}, got)
}

func TestParseDiffSummary(t *testing.T) {
	tests := []struct {
		name  string
		input string
		want  []FileChange
	}{
		{
			name:  "mixed changes",
			input: "M src/main.go\nA new_file.go\nD old_file.go\n",
			want: []FileChange{
				{Type: "M", Path: "src/main.go"},
				{Type: "A", Path: "new_file.go"},
				{Type: "D", Path: "old_file.go"},
			},
		},
		{
			name:  "empty output",
			input: "",
			want:  []FileChange{},
		},
		{
			name:  "whitespace only",
			input: "  \n  \n",
			want:  []FileChange{},
		},
		{
			name:  "renamed file",
			input: "R {old_name.go => new_name.go}\n",
			want: []FileChange{
				{Type: "R", Path: "{old_name.go => new_name.go}"},
			},
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := ParseDiffSummary(tt.input)
			assert.Equal(t, tt.want, got)
		})
	}
}

func TestDiffStat(t *testing.T) {
	got := DiffStat("abc")
	assert.Equal(t, []string{"diff", "--stat", "--color", "never", "-r", "abc", "--ignore-working-copy", "--config", "ui.term-width=500"}, got)
}

func TestParseDiffStat(t *testing.T) {
	tests := []struct {
		name  string
		input string
		want  map[string]FileStat
	}{
		{
			name: "multiple files",
			input: ` src/main.go | 15 +++++++++------
 new_file.go |  3 +++
 2 files changed, 12 insertions(+), 6 deletions(-)
`,
			want: map[string]FileStat{
				"src/main.go": {Additions: 9, Deletions: 6},
				"new_file.go": {Additions: 3, Deletions: 0},
			},
		},
		{
			name:  "empty output",
			input: "",
			want:  map[string]FileStat{},
		},
		{
			name: "deletions only",
			input: ` old.go | 5 -----
 1 file changed, 5 deletions(-)
`,
			want: map[string]FileStat{
				"old.go": {Additions: 0, Deletions: 5},
			},
		},
		{
			name: "path with spaces",
			input: ` path with spaces/file.go | 2 +-
 1 file changed, 1 insertion(+), 1 deletion(-)
`,
			want: map[string]FileStat{
				"path with spaces/file.go": {Additions: 1, Deletions: 1},
			},
		},
		{
			name: "rename with braces",
			input: ` src/{old.go => new.go} | 4 ++--
 1 file changed, 2 insertions(+), 2 deletions(-)
`,
			want: map[string]FileStat{
				"src/new.go": {Additions: 2, Deletions: 2},
			},
		},
		{
			name: "rename entire path",
			input: ` {old_dir/file.go => new_dir/file.go} | 6 +++---
 1 file changed, 3 insertions(+), 3 deletions(-)
`,
			want: map[string]FileStat{
				"new_dir/file.go": {Additions: 3, Deletions: 3},
			},
		},
		{
			name: "proportional scaling large file",
			input: ` big.go | 100 +++++++++++++++++++++++++++++++++++++++++++++++++-
 1 file changed, 99 insertions(+), 1 deletion(-)
`,
			want: map[string]FileStat{
				"big.go": {Additions: 98, Deletions: 2},
			},
		},
		{
			// Real jj output for binary files. statLineRe requires [+-]+ bar,
			// so binaries are intentionally excluded (0/0 stats via MergeStats zero-value).
			name: "binary file (no bar)",
			input: `binary.bin | (binary) +100 bytes
1 file changed, 0 insertions(+), 0 deletions(-)
`,
			want: map[string]FileStat{},
		},
		{
			// Real jj output for pure renames (no content change). Also excluded
			// by statLineRe (| 0 has no bar). FileChange gets 0/0 from MergeStats.
			name: "pure rename (no bar)",
			input: `{file.txt => renamed.txt} | 0
1 file changed, 0 insertions(+), 0 deletions(-)
`,
			want: map[string]FileStat{},
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := ParseDiffStat(tt.input)
			assert.Equal(t, tt.want, got)
		})
	}
}

func TestMergeStats(t *testing.T) {
	files := []FileChange{
		{Type: "M", Path: "a.go"},
		{Type: "A", Path: "b.go"},
		{Type: "D", Path: "c.go"},
	}
	stats := map[string]FileStat{
		"a.go": {Additions: 10, Deletions: 3},
		"b.go": {Additions: 5, Deletions: 0},
	}
	MergeStats(files, stats)
	assert.Equal(t, 10, files[0].Additions)
	assert.Equal(t, 3, files[0].Deletions)
	assert.Equal(t, 5, files[1].Additions)
	assert.Equal(t, 0, files[1].Deletions)
	// c.go not in stats, should remain zero
	assert.Equal(t, 0, files[2].Additions)
	assert.Equal(t, 0, files[2].Deletions)
}

func TestMergeStats_TruncatedPaths(t *testing.T) {
	files := []FileChange{
		{Type: "M", Path: "internal/service/machineidentityservice/v1alpha/service_azure.go"},
		{Type: "M", Path: "obol/cmd/obol-agent/internal/azure/vtpm.go"},
	}
	// Simulate truncated paths from narrow terminal stat output
	stats := map[string]FileStat{
		"...rvice/machineidentityservice/v1alpha/service_azure.go": {Additions: 5, Deletions: 2},
		"obol/cmd/obol-agent/internal/azure/vtpm.go":               {Additions: 107, Deletions: 36},
	}
	MergeStats(files, stats)
	// Truncated path should match via suffix
	assert.Equal(t, 5, files[0].Additions)
	assert.Equal(t, 2, files[0].Deletions)
	// Exact match still works
	assert.Equal(t, 107, files[1].Additions)
	assert.Equal(t, 36, files[1].Deletions)
}

func TestBookmarkMove(t *testing.T) {
	got := BookmarkMove("abc", "feature")
	assert.Equal(t, []string{"bookmark", "move", "feature", "--to", "abc"}, got)
}

func TestBookmarkForget(t *testing.T) {
	got := BookmarkForget("feature")
	assert.Equal(t, []string{"bookmark", "forget", "feature"}, got)
}

func TestBookmarkDelete(t *testing.T) {
	got := BookmarkDelete("feature")
	assert.Equal(t, []string{"bookmark", "delete", "feature"}, got)
}

func TestBookmarkUntrack(t *testing.T) {
	got := BookmarkUntrack("main", "origin")
	assert.Equal(t, []string{"bookmark", "untrack", "main", "--remote", "origin"}, got)
}

func TestBookmarkUntrack_NoRemote(t *testing.T) {
	got := BookmarkUntrack("main", "")
	assert.Equal(t, []string{"bookmark", "untrack", "main"}, got)
}

func TestCommitWorkingCopy(t *testing.T) {
	assert.Equal(t, []string{"commit", "-m", ""}, CommitWorkingCopy(""))
	assert.Equal(t, []string{"commit", "-m", "my message"}, CommitWorkingCopy("my message"))
}

func TestDiffEdit(t *testing.T) {
	assert.Equal(t, []string{"diffedit", "-r", "abc"}, DiffEdit("abc"))
}

func TestRestore(t *testing.T) {
	got := Restore("abc", []string{"main.go"}, false)
	assert.Equal(t, []string{"restore", "-c", "abc", `file:"main.go"`}, got)
}

func TestRestore_Interactive(t *testing.T) {
	got := Restore("abc", nil, true)
	assert.Contains(t, got, "--interactive")
}

func TestSnapshot(t *testing.T) {
	assert.Equal(t, []string{"debug", "snapshot"}, Snapshot())
}

func TestDuplicate(t *testing.T) {
	from := NewSelectedRevisions(&Commit{ChangeId: "abc"})
	got := Duplicate(from, "def", "-d")
	assert.Equal(t, []string{"duplicate", "-r", "abc", "-d", "def"}, got)
}

func TestAbsorb(t *testing.T) {
	got := Absorb("abc", "main.go", "test.go")
	assert.Equal(t, []string{"absorb", "--from", "abc", "--color", "never", `file:"main.go"`, `file:"test.go"`}, got)
}

func TestAbsorb_NoFiles(t *testing.T) {
	got := Absorb("abc")
	assert.Equal(t, []string{"absorb", "--from", "abc", "--color", "never"}, got)
}

func TestOpRestore(t *testing.T) {
	assert.Equal(t, []string{"op", "restore", "abc123"}, OpRestore("abc123"))
}

func TestGetParents(t *testing.T) {
	got := GetParents("abc")
	assert.Contains(t, got, "-r")
	assert.Contains(t, got, "abc")
	assert.Contains(t, got, "--template")
}

func TestGetFirstChild(t *testing.T) {
	c := &Commit{CommitId: "abc123"}
	got := GetFirstChild(c)
	assert.Contains(t, got, "-r")
	assert.Contains(t, got, "abc123+")
}

func TestFilesInRevision(t *testing.T) {
	c := &Commit{CommitId: "abc123"}
	got := FilesInRevision(c)
	assert.Contains(t, got, "file")
	assert.Contains(t, got, "list")
	assert.Contains(t, got, "-r")
	assert.Contains(t, got, "abc123")
}

func TestConfigListAll(t *testing.T) {
	got := ConfigListAll()
	assert.Contains(t, got, "config")
	assert.Contains(t, got, "list")
	assert.Contains(t, got, "--include-defaults")
}

func TestParseOpLog(t *testing.T) {
	output := "abc123\x1fdescription one\x1f2026-01-01 00:00\x1ftrue\ndef456\x1fdescription two\x1f2026-01-01 00:01\x1ffalse\n"
	entries := ParseOpLog(output)
	assert.Len(t, entries, 2)
	assert.Equal(t, "abc123", entries[0].ID)
	assert.Equal(t, "description one", entries[0].Description)
	assert.True(t, entries[0].IsCurrent)
	assert.Equal(t, "def456", entries[1].ID)
	assert.False(t, entries[1].IsCurrent)
}

func TestParseOpLog_Empty(t *testing.T) {
	entries := ParseOpLog("")
	assert.Len(t, entries, 0)
	assert.NotNil(t, entries)
}

func TestParseOpLog_Malformed(t *testing.T) {
	// Lines with < 4 fields should be skipped
	entries := ParseOpLog("only\x1ftwo\x1ffields\n")
	assert.Empty(t, entries)
}

func TestDiffRange(t *testing.T) {
	got := DiffRange("abc", "def", nil)
	assert.Equal(t, []string{"diff", "--from", "abc", "--to", "def", "--tool", ":git", "--color", "never", "--ignore-working-copy"}, got)
}

func TestDiffRange_WithFiles(t *testing.T) {
	got := DiffRange("abc", "def", []string{"src/main.go", "README.md"})
	assert.Contains(t, got, `file:"src/main.go"`)
	assert.Contains(t, got, `file:"README.md"`)
	assert.Equal(t, "abc", got[2]) // --from value
	assert.Equal(t, "def", got[4]) // --to value
}

func TestEvolog(t *testing.T) {
	got := Evolog("abc")
	assert.Contains(t, got, "evolog")
	assert.Contains(t, got, "-r")
	assert.Contains(t, got, "abc")
	assert.Contains(t, got, "--no-graph")
}

func TestWorkspaceList(t *testing.T) {
	got := WorkspaceList()
	assert.Equal(t, []string{"workspace", "list", "--color", "never", "--ignore-working-copy"}, got)
}

func TestParseWorkspaceList(t *testing.T) {
	output := "base2: skpssuxl a14ce848 Architecture review burndown\ndefault: qqqqpqpq bbbbbbbb Other description\n"
	ws := ParseWorkspaceList(output)
	assert.Len(t, ws, 2)
	assert.Equal(t, "base2", ws[0].Name)
	assert.Equal(t, "skpssuxl", ws[0].ChangeId)
	assert.Equal(t, "a14ce848", ws[0].CommitId)
	assert.Equal(t, "default", ws[1].Name)
	assert.Equal(t, "qqqqpqpq", ws[1].ChangeId)
	assert.Equal(t, "bbbbbbbb", ws[1].CommitId)
}

func TestParseWorkspaceList_Malformed(t *testing.T) {
	// Lines without ": " separator or with too few fields are skipped
	output := "no-colon-here\ndefault: onlyOneField\nvalid: abc def description\n"
	ws := ParseWorkspaceList(output)
	assert.Len(t, ws, 1)
	assert.Equal(t, "valid", ws[0].Name)
	assert.Equal(t, "abc", ws[0].ChangeId)
	assert.Equal(t, "def", ws[0].CommitId)
}

func TestParseWorkspaceList_Single(t *testing.T) {
	output := "default: xyzwvuts abcdef12 my commit\n"
	ws := ParseWorkspaceList(output)
	assert.Len(t, ws, 1)
	assert.Equal(t, "default", ws[0].Name)
}

func TestParseWorkspaceList_Empty(t *testing.T) {
	ws := ParseWorkspaceList("")
	assert.Empty(t, ws)
}

func TestResolveList(t *testing.T) {
	got := ResolveList("abc")
	assert.Equal(t, []string{"resolve", "--list", "-r", "abc", "--color", "never", "--quiet"}, got)
}

func TestResolve(t *testing.T) {
	got := Resolve("abc", "src/main.go", ":ours")
	assert.Equal(t, []string{"resolve", "--tool", ":ours", "-r", "abc", `file:"src/main.go"`}, got)
}

func TestResolve_EscapedFile(t *testing.T) {
	got := Resolve("abc", `path with "quotes".go`, ":theirs")
	assert.Equal(t, []string{"resolve", "--tool", ":theirs", "-r", "abc", `file:"path with \"quotes\".go"`}, got)
}

func TestParseResolveList(t *testing.T) {
	output := "src/main.go    2-sided conflict\nREADME.md    3-sided conflict including 1 deletion\n"
	paths := ParseResolveList(output)
	assert.Equal(t, []string{"src/main.go", "README.md"}, paths)
}

func TestParseResolveList_PlainPaths(t *testing.T) {
	// Handles output without conflict type suffix (future-proofing).
	output := "src/main.go\nREADME.md\n"
	paths := ParseResolveList(output)
	assert.Equal(t, []string{"src/main.go", "README.md"}, paths)
}

func TestParseResolveList_Empty(t *testing.T) {
	paths := ParseResolveList("")
	assert.Empty(t, paths)
	assert.NotNil(t, paths)
}

func TestMergeConflicts(t *testing.T) {
	files := []FileChange{
		{Type: "M", Path: "a.go"},
		{Type: "M", Path: "b.go"},
		{Type: "A", Path: "c.go"},
	}
	files = MergeConflicts(files, []string{"b.go"})
	assert.Len(t, files, 3)
	assert.False(t, files[0].Conflict)
	assert.True(t, files[1].Conflict)
	assert.False(t, files[2].Conflict)
}

func TestMergeConflicts_NoConflicts(t *testing.T) {
	files := []FileChange{{Type: "M", Path: "a.go"}}
	for _, conflicts := range [][]string{nil, {}} {
		result := MergeConflicts(files, conflicts)
		assert.Len(t, result, 1)
		assert.False(t, result[0].Conflict)
	}
}

func TestMergeConflicts_AppendsConflictOnlyFiles(t *testing.T) {
	files := []FileChange{
		{Type: "M", Path: "a.go"},
	}
	files = MergeConflicts(files, []string{"a.go", "conflict-only.txt"})
	assert.Len(t, files, 2)
	assert.True(t, files[0].Conflict)
	assert.Equal(t, "conflict-only.txt", files[1].Path)
	assert.Equal(t, "M", files[1].Type)
	assert.True(t, files[1].Conflict)
}
