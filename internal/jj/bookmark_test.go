package jj

import (
	"slices"
	"testing"

	"github.com/stretchr/testify/assert"
)

func TestParseBookmarkListOutput(t *testing.T) {
	tests := []struct {
		name string
		input string
		want []Bookmark
	}{
		{
			name: "empty",
			input: "",
			want: []Bookmark{},
		},
		{
			name: "single local",
			input: "feat-1;.;false;false;false;9",
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
			name: "with remote",
			input: "feature;.;false;false;false;b\nfeature;origin;true;false;false;b",
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
			name: "quoted bookmarks",
			input: "\"test--bookmark\";.;false;false;false;7\n\"test--bookmark\";git;true;false;false;7\n\"test--bookmark\";origin;true;false;false;6",
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
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			assert.Equal(t, tt.want, ParseBookmarkListOutput(tt.input))
		})
	}
}

func TestParseBookmarkListOutput_NonLocal(t *testing.T) {
	output := "alpha;origin;false;false;false;2\nmain;.;false;false;false;b\nmain;git;true;false;false;b\nmain;origin;true;false;false;b\nzeta;origin;false;false;false;c"
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
