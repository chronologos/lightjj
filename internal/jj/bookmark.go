package jj

import (
	"strconv"
	"strings"
)

type BookmarkRemote struct {
	Remote   string `json:"remote"`
	CommitId string `json:"commit_id"`
	Tracked  bool   `json:"tracked"`
	// Ahead = commits on remote not in local (pull needed).
	// Behind = commits in local not on remote (push needed).
	// Only meaningful when Tracked; zero otherwise.
	Ahead  int `json:"ahead"`
	Behind int `json:"behind"`
}

type Bookmark struct {
	Name    string           `json:"name"`
	Local   *BookmarkRemote  `json:"local,omitempty"` // nil = remote-only OR deleted-local
	Remotes []BookmarkRemote `json:"remotes,omitempty"`
	// AddedTargets: "+" sides of a conflict. For non-conflict, single
	// element equal to CommitId. Source of truth for conflict resolution UI.
	AddedTargets []string `json:"added_targets,omitempty"`
	Conflict     bool     `json:"conflict"`
	// Synced: true iff local matches all tracked remotes.
	Synced   bool   `json:"synced"`
	CommitId string `json:"commit_id"` // empty when Conflict
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
		if len(parts) < 9 {
			continue
		}

		name := strings.Trim(parts[0], "\"")
		remoteName := parts[1]
		tracked := parts[2] == "true"
		conflict := parts[3] == "true"
		commitId := parts[4] // empty when conflict (template guard)
		addedTargets := splitNonEmpty(parts[5], ",")
		ahead, _ := strconv.Atoi(parts[6])
		behind, _ := strconv.Atoi(parts[7])
		synced := parts[8] == "true"

		if remoteName == "git" {
			continue
		}

		bookmark, exists := bookmarkMap[name]
		if !exists {
			bookmark = &Bookmark{
				Name:     name,
				Conflict: conflict,
				CommitId: commitId,
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
			bookmark.Conflict = conflict
			bookmark.AddedTargets = addedTargets
			bookmark.Synced = synced
		} else {
			remote := BookmarkRemote{
				Remote:   remoteName,
				Tracked:  tracked,
				CommitId: commitId,
				Ahead:    ahead,
				Behind:   behind,
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
