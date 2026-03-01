package jj

import "strings"

type BookmarkRemote struct {
	Remote   string `json:"remote"`
	CommitId string `json:"commit_id"`
	Tracked  bool   `json:"tracked"`
}

type Bookmark struct {
	Name      string           `json:"name"`
	Local     *BookmarkRemote  `json:"local,omitempty"`
	Remotes   []BookmarkRemote `json:"remotes,omitempty"`
	Conflict  bool             `json:"conflict"`
	Backwards bool             `json:"backwards"`
	CommitId  string           `json:"commit_id"`
}

func (b Bookmark) IsDeletable() bool {
	return b.Local != nil
}

func (b Bookmark) IsTrackable() bool {
	return b.Local != nil && len(b.Remotes) == 0
}

// ParseBookmarkListOutput parses the \x1F-delimited output from
// `jj bookmark list` with a custom template. defaultRemote is sorted to
// the front of each bookmark's Remotes slice.
func ParseBookmarkListOutput(output string, defaultRemote string) []Bookmark {
	lines := strings.Split(output, "\n")
	bookmarkMap := make(map[string]*Bookmark)
	var orderedNames []string

	for _, b := range lines {
		parts := strings.Split(b, "\x1f")
		if len(parts) < 6 {
			continue
		}

		name := strings.Trim(parts[0], "\"")
		remoteName := parts[1]
		tracked := parts[2] == "true"
		conflict := parts[3] == "true"
		backwards := parts[4] == "true"
		commitId := parts[5]

		if remoteName == "git" {
			continue
		}

		bookmark, exists := bookmarkMap[name]
		if !exists {
			bookmark = &Bookmark{
				Name:      name,
				Conflict:  conflict,
				Backwards: backwards,
				CommitId:  commitId,
			}
			bookmarkMap[name] = bookmark
			orderedNames = append(orderedNames, name)
		}

		if remoteName == "." {
			bookmark.Local = &BookmarkRemote{
				Remote:   ".",
				CommitId: commitId,
				Tracked:  tracked,
			}
			bookmark.CommitId = commitId
		} else {
			remote := BookmarkRemote{
				Remote:   remoteName,
				Tracked:  tracked,
				CommitId: commitId,
			}
			if remoteName == defaultRemote {
				bookmark.Remotes = append([]BookmarkRemote{remote}, bookmark.Remotes...)
			} else {
				bookmark.Remotes = append(bookmark.Remotes, remote)
			}
		}
	}

	bookmarks := make([]Bookmark, len(orderedNames))
	for i, name := range orderedNames {
		bookmarks[i] = *bookmarkMap[name]
	}
	return bookmarks
}

// ParseRemoteListOutput parses `jj git remote list` output into remote names.
func ParseRemoteListOutput(output string, defaultRemote string) []string {
	remotes := []string{}
	for line := range strings.SplitSeq(strings.TrimSpace(output), "\n") {
		if name := strings.TrimSpace(line); name != "" {
			remotes = append(remotes, strings.Fields(name)[0])
		}
	}
	// Move defaultRemote to front if present
	for i, r := range remotes {
		if r == defaultRemote {
			remotes = append([]string{defaultRemote}, append(remotes[:i], remotes[i+1:]...)...)
			break
		}
	}
	return remotes
}
