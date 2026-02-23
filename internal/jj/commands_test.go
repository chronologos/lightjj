package jj

import (
	"testing"

	"github.com/stretchr/testify/assert"
)

func TestLog(t *testing.T) {
	tests := []struct {
		name     string
		revset   string
		limit    int
		template string
		want     []string
	}{
		{
			name: "default",
			want: []string{"log", "--color", "always", "--quiet"},
		},
		{
			name:   "with revset",
			revset: "@",
			want:   []string{"log", "--color", "always", "--quiet", "-r", "@"},
		},
		{
			name:  "with limit",
			limit: 10,
			want:  []string{"log", "--color", "always", "--quiet", "--limit", "10"},
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := Log(tt.revset, tt.limit, tt.template)
			assert.Equal(t, tt.want, got)
		})
	}
}

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
	assert.Equal(t, `file:"simple.go"`, EscapeFileName("simple.go"))
	assert.Equal(t, `file:"path with spaces/file.go"`, EscapeFileName("path with spaces/file.go"))
	assert.Equal(t, `file:"has\"quote.go"`, EscapeFileName(`has"quote.go`))
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
