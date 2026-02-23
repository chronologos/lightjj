package jj

import (
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
	assert.Equal(t, []string{"squash", "--from", "abc", "--into", "def"}, got)
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
	assert.Contains(t, got, `file:"main.go"`)
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
	assert.Equal(t, []string{"diff", "--stat", "--color", "never", "-r", "abc", "--ignore-working-copy"}, got)
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

func TestBookmarkMove(t *testing.T) {
	got := BookmarkMove("abc", "feature")
	assert.Equal(t, []string{"bookmark", "move", "feature", "--to", "abc"}, got)
}

func TestBookmarkForget(t *testing.T) {
	got := BookmarkForget("feature")
	assert.Equal(t, []string{"bookmark", "forget", "feature"}, got)
}
