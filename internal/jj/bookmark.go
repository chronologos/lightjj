package jj

import (
	"strconv"
	"strings"
)

type BookmarkRemote struct {
	Remote      string `json:"remote"`
	CommitId    string `json:"commit_id"`
	Description string `json:"description"` // first line
	Ago         string `json:"ago"`         // committer timestamp, relative ("3 days ago")
	Tracked     bool   `json:"tracked"`
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

// ParseBookmarkListOutput parses the \x1F-delimited output from
// `jj bookmark list` with a custom template. defaultRemote is sorted to
// the front of each bookmark's Remotes slice.
func ParseBookmarkListOutput(output string, defaultRemote string) []Bookmark {
	lines := strings.Split(output, "\n")
	bookmarkMap := make(map[string]*Bookmark)
	var orderedNames []string

	for _, b := range lines {
		parts := strings.Split(b, "\x1f")
		if len(parts) < 11 {
			continue
		}

		name := strings.Trim(parts[0], "\"")
		remoteName := parts[1]
		tracked := parts[2] == "true"
		conflict := parts[3] == "true"
		commitId := parts[4] // empty when conflict or deleted-local (template guard)
		addedTargets := splitNonEmpty(parts[5], ",")
		ahead, _ := strconv.Atoi(parts[6])
		behind, _ := strconv.Atoi(parts[7])
		synced := parts[8] == "true"
		description := parts[9]
		ago := parts[10]

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
			// Deleted-local: jj emits a "." line with no normal_target and
			// no added_targets. Skip — the bookmark is remote-only now.
			// (Conflict case: commitId is also empty but addedTargets has
			// the "+" sides, so this correctly doesn't drop conflicts.)
			if commitId == "" && len(addedTargets) == 0 {
				continue
			}
			bookmark.Local = &BookmarkRemote{
				Remote:      ".",
				CommitId:    commitId,
				Description: description,
				Ago:         ago,
				Tracked:     tracked,
			}
			bookmark.CommitId = commitId
			bookmark.Conflict = conflict
			bookmark.AddedTargets = addedTargets
			bookmark.Synced = synced
		} else {
			remote := BookmarkRemote{
				Remote:      remoteName,
				Tracked:     tracked,
				CommitId:    commitId,
				Description: description,
				Ago:         ago,
				Ahead:       ahead,
				Behind:      behind,
			}
			if remoteName == defaultRemote {
				bookmark.Remotes = append([]BookmarkRemote{remote}, bookmark.Remotes...)
				// Remote-only bookmark: prefer defaultRemote's commit for
				// jump-to. The first line encountered (which set CommitId at
				// construction) may have been a non-default remote.
				if bookmark.Local == nil {
					bookmark.CommitId = commitId
				}
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
