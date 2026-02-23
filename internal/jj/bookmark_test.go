package jj

import (
	"slices"
	"testing"

	"github.com/stretchr/testify/assert"
)

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
			input: "feat-1\x1f.\x1ffalse\x1ffalse\x1ffalse\x1f9",
			want: []Bookmark{
				{
					Name:    "feat-1",
					Remotes: nil,
					Local: &BookmarkRemote{
						Remote:   ".",
						CommitId: "9",
						Tracked:  false,
					},
					CommitId: "9",
				},
			},
		},
		{
			name:  "with remote",
			input: "feature\x1f.\x1ffalse\x1ffalse\x1ffalse\x1fb\nfeature\x1forigin\x1ftrue\x1ffalse\x1ffalse\x1fb",
			want: []Bookmark{
				{
					Name: "feature",
					Remotes: []BookmarkRemote{
						{"origin", "b", true},
					},
					Local: &BookmarkRemote{
						Remote: ".", CommitId: "b",
					},
					CommitId: "b",
				},
			},
		},
		{
			name:  "quoted bookmarks",
			input: "\"test--bookmark\"\x1f.\x1ffalse\x1ffalse\x1ffalse\x1f7\n\"test--bookmark\"\x1fgit\x1ftrue\x1ffalse\x1ffalse\x1f7\n\"test--bookmark\"\x1forigin\x1ftrue\x1ffalse\x1ffalse\x1f6",
			want: []Bookmark{
				{
					Name: "test--bookmark",
					Remotes: []BookmarkRemote{
						{"origin", "6", true},
					},
					Local: &BookmarkRemote{
						Remote: ".", CommitId: "7",
					},
					CommitId: "7",
				},
			},
		},
		{
			name:  "bookmark name with semicolon",
			input: "feat;one\x1f.\x1ffalse\x1ffalse\x1ffalse\x1fa",
			want: []Bookmark{
				{
					Name:    "feat;one",
					Remotes: nil,
					Local: &BookmarkRemote{
						Remote:   ".",
						CommitId: "a",
						Tracked:  false,
					},
					CommitId: "a",
				},
			},
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			assert.Equal(t, tt.want, ParseBookmarkListOutput(tt.input))
		})
	}
}

func TestParseBookmarkListOutput_NonLocal(t *testing.T) {
	output := "alpha\x1forigin\x1ffalse\x1ffalse\x1ffalse\x1f2\nmain\x1f.\x1ffalse\x1ffalse\x1ffalse\x1fb\nmain\x1fgit\x1ftrue\x1ffalse\x1ffalse\x1fb\nmain\x1forigin\x1ftrue\x1ffalse\x1ffalse\x1fb\nzeta\x1forigin\x1ffalse\x1ffalse\x1ffalse\x1fc"
	bookmarks := ParseBookmarkListOutput(output)
	assert.Len(t, bookmarks, 3)

	alpha := bookmarks[slices.IndexFunc(bookmarks, func(b Bookmark) bool { return b.Name == "alpha" })]
	assert.Nil(t, alpha.Local)
	assert.Len(t, alpha.Remotes, 1)

	main := bookmarks[slices.IndexFunc(bookmarks, func(b Bookmark) bool { return b.Name == "main" })]
	assert.NotNil(t, main.Local)
	assert.Len(t, main.Remotes, 1) // git remote filtered out
}

func TestParseRemoteListOutput(t *testing.T) {
	tests := []struct {
		name          string
		output        string
		defaultRemote string
		want          []string
	}{
		{
			name:          "single remote",
			output:        "origin https://github.com/user/repo.git\n",
			defaultRemote: "origin",
			want:          []string{"origin"},
		},
		{
			name:          "multiple remotes, default moved to front",
			output:        "upstream https://github.com/upstream/repo.git\norigin https://github.com/user/repo.git\n",
			defaultRemote: "origin",
			want:          []string{"origin", "upstream"},
		},
		{
			name:          "empty",
			output:        "",
			defaultRemote: "origin",
			want:          []string{},
		},
		{
			name:          "with trailing newline",
			output:        "origin https://github.com/user/repo.git\nupstream https://github.com/upstream/repo.git\n",
			defaultRemote: "origin",
			want:          []string{"origin", "upstream"},
		},
		{
			name:          "with extra spaces",
			output:        "  origin   https://github.com/user/repo.git  \n  upstream   https://github.com/upstream/repo.git  \n",
			defaultRemote: "origin",
			want:          []string{"origin", "upstream"},
		},
		{
			name:          "three remotes",
			output:        "origin https://github.com/user/repo.git\nupstream https://github.com/upstream/repo.git\nfork https://github.com/fork/repo.git\n",
			defaultRemote: "origin",
			want:          []string{"origin", "upstream", "fork"},
		},
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
