package jj

import (
	"slices"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
)

// bml joins template-output lines. Fields:
// name, remote, tracked, conflict, commitId, addedTargets, ahead, behind, synced
func bml(lines ...string) string { return strings.Join(lines, "\n") }

func TestParseBookmarkListOutput(t *testing.T) {
	tests := []struct {
		name  string
		input string
		want  []Bookmark
	}{
		{
			name:  "empty",
			input: "",
			want:  []Bookmark{},
		},
		{
			name:  "single local",
			input: "feat-1\x1f.\x1ffalse\x1ffalse\x1f9\x1f9\x1f0\x1f0\x1ftrue",
			want: []Bookmark{
				{
					Name:         "feat-1",
					Local:        &BookmarkRemote{Remote: ".", CommitId: "9"},
					AddedTargets: []string{"9"},
					Synced:       true,
					CommitId:     "9",
				},
			},
		},
		{
			name: "local + tracked remote",
			input: bml(
				"feature\x1f.\x1ffalse\x1ffalse\x1fb\x1fb\x1f0\x1f0\x1ftrue",
				"feature\x1forigin\x1ftrue\x1ffalse\x1fb\x1fb\x1f0\x1f0\x1ftrue",
			),
			want: []Bookmark{
				{
					Name:         "feature",
					Local:        &BookmarkRemote{Remote: ".", CommitId: "b"},
					Remotes:      []BookmarkRemote{{Remote: "origin", CommitId: "b", Tracked: true}},
					AddedTargets: []string{"b"},
					Synced:       true,
					CommitId:     "b",
				},
			},
		},
		{
			name: "git remote filtered out",
			input: bml(
				"\"test--bm\"\x1f.\x1ffalse\x1ffalse\x1f7\x1f7\x1f0\x1f0\x1ffalse",
				"\"test--bm\"\x1fgit\x1ftrue\x1ffalse\x1f7\x1f7\x1f0\x1f0\x1ftrue",
				"\"test--bm\"\x1forigin\x1ftrue\x1ffalse\x1f6\x1f6\x1f0\x1f0\x1ffalse",
			),
			want: []Bookmark{
				{
					Name:         "test--bm",
					Local:        &BookmarkRemote{Remote: ".", CommitId: "7"},
					Remotes:      []BookmarkRemote{{Remote: "origin", CommitId: "6", Tracked: true}},
					AddedTargets: []string{"7"},
					CommitId:     "7",
				},
			},
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			assert.Equal(t, tt.want, ParseBookmarkListOutput(tt.input, "origin"))
		})
	}
}

func TestParseBookmarkListOutput_Conflict(t *testing.T) {
	// Conflicted local: commitId empty (template if-guard), added_targets has
	// multiple sides. @git filtered out.
	input := bml(
		"t2\x1f.\x1ffalse\x1ftrue\x1f\x1fa3f4719d,9b24d090\x1f0\x1f0\x1ffalse",
		"t2\x1fgit\x1ftrue\x1ffalse\x1fa3f4719d\x1fa3f4719d\x1f0\x1f1\x1ffalse",
	)
	bms := ParseBookmarkListOutput(input, "origin")
	assert.Len(t, bms, 1)
	bm := bms[0]
	assert.True(t, bm.Conflict)
	assert.Empty(t, bm.CommitId)
	assert.Equal(t, []string{"a3f4719d", "9b24d090"}, bm.AddedTargets)
	assert.NotNil(t, bm.Local)
	assert.False(t, bm.Synced)
	assert.Empty(t, bm.Remotes) // @git filtered
}

func TestParseBookmarkListOutput_AheadBehind(t *testing.T) {
	// Local ahead of remote: remote.behind > 0 (we have unpushed commits).
	// Remote ahead of local: remote.ahead > 0 (we need to fetch/rebase).
	input := bml(
		"feat\x1f.\x1ffalse\x1ffalse\x1fabc\x1fabc\x1f0\x1f0\x1ffalse",
		"feat\x1forigin\x1ftrue\x1ffalse\x1fdef\x1fdef\x1f3\x1f1\x1ffalse",
	)
	bms := ParseBookmarkListOutput(input, "origin")
	assert.Len(t, bms, 1)
	r := bms[0].Remotes[0]
	assert.Equal(t, 3, r.Ahead)
	assert.Equal(t, 1, r.Behind)
	assert.False(t, bms[0].Synced)
}

func TestParseBookmarkListOutput_RemoteOnly(t *testing.T) {
	// Untracked remote bookmark — no local line, Local nil, CommitId from
	// the first line encountered (remote's).
	input := "alpha\x1forigin\x1ffalse\x1ffalse\x1f2\x1f2\x1f0\x1f0\x1ffalse"
	bms := ParseBookmarkListOutput(input, "origin")
	assert.Len(t, bms, 1)
	assert.Nil(t, bms[0].Local)
	assert.Equal(t, "2", bms[0].CommitId)
	assert.Len(t, bms[0].Remotes, 1)
	assert.False(t, bms[0].Remotes[0].Tracked)
}

func TestParseBookmarkListOutput_MultipleRemotes(t *testing.T) {
	// defaultRemote sorted to front regardless of input order
	input := bml(
		"main\x1f.\x1ffalse\x1ffalse\x1fabc\x1fabc\x1f0\x1f0\x1ftrue",
		"main\x1fupstream\x1ftrue\x1ffalse\x1fdef\x1fdef\x1f0\x1f0\x1ftrue",
		"main\x1forigin\x1ftrue\x1ffalse\x1fghi\x1fghi\x1f0\x1f0\x1ftrue",
	)
	bms := ParseBookmarkListOutput(input, "origin")
	assert.Len(t, bms, 1)
	assert.Len(t, bms[0].Remotes, 2)
	assert.Equal(t, "origin", bms[0].Remotes[0].Remote)
	assert.Equal(t, "upstream", bms[0].Remotes[1].Remote)

	bms = ParseBookmarkListOutput(input, "upstream")
	assert.Equal(t, "upstream", bms[0].Remotes[0].Remote)
	assert.Equal(t, "origin", bms[0].Remotes[1].Remote)
}

func TestParseBookmarkListOutput_NonLocal(t *testing.T) {
	input := bml(
		"alpha\x1forigin\x1ffalse\x1ffalse\x1f2\x1f2\x1f0\x1f0\x1ffalse",
		"main\x1f.\x1ffalse\x1ffalse\x1fb\x1fb\x1f0\x1f0\x1ftrue",
		"main\x1fgit\x1ftrue\x1ffalse\x1fb\x1fb\x1f0\x1f0\x1ftrue",
		"main\x1forigin\x1ftrue\x1ffalse\x1fb\x1fb\x1f0\x1f0\x1ftrue",
		"zeta\x1forigin\x1ffalse\x1ffalse\x1fc\x1fc\x1f0\x1f0\x1ffalse",
	)
	bookmarks := ParseBookmarkListOutput(input, "origin")
	assert.Len(t, bookmarks, 3)

	alpha := bookmarks[slices.IndexFunc(bookmarks, func(b Bookmark) bool { return b.Name == "alpha" })]
	assert.Nil(t, alpha.Local)
	assert.Len(t, alpha.Remotes, 1)

	main := bookmarks[slices.IndexFunc(bookmarks, func(b Bookmark) bool { return b.Name == "main" })]
	assert.NotNil(t, main.Local)
	assert.Len(t, main.Remotes, 1) // git filtered
}

func TestParseRemoteListOutput(t *testing.T) {
	tests := []struct {
		name          string
		output        string
		defaultRemote string
		want          []string
	}{
		{"single", "origin https://example.com/r.git\n", "origin", []string{"origin"}},
		{"multi, default to front", "upstream https://u.git\norigin https://o.git\n", "origin", []string{"origin", "upstream"}},
		{"empty", "", "origin", []string{}},
		{"extra spaces", "  origin   https://o.git  \n  upstream   https://u.git  \n", "origin", []string{"origin", "upstream"}},
		{"non-origin default", "origin https://o.git\nupstream https://u.git\n", "upstream", []string{"upstream", "origin"}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			assert.Equal(t, tt.want, ParseRemoteListOutput(tt.output, tt.defaultRemote))
		})
	}
}

func TestBookmark_IsDeletable(t *testing.T) {
	assert.True(t, Bookmark{Local: &BookmarkRemote{}}.IsDeletable())
	assert.False(t, Bookmark{}.IsDeletable())
}

func TestBookmark_IsTrackable(t *testing.T) {
	assert.True(t, Bookmark{Local: &BookmarkRemote{}, Remotes: nil}.IsTrackable())
	assert.False(t, Bookmark{Local: &BookmarkRemote{}, Remotes: []BookmarkRemote{{}}}.IsTrackable())
	assert.False(t, Bookmark{}.IsTrackable())
}
