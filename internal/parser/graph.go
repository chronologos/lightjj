// Package parser parses `jj log` output with graph characters and _PREFIX: markers.
// Simplified from jjui's parser — no ANSI handling needed since we use --color never.
package parser

import (
	"strconv"
	"strings"

	"github.com/chronologos/lightjj/internal/jj"
)

// stripRefQuotes removes enclosing double-quotes from a RefSymbol-formatted
// name. jj's template .name() quotes names containing revset-special chars
// (e.g. `@`, `/`, `::`) — same behavior `bookmark.go:48` strips for.
func stripRefQuotes(s string) string {
	if len(s) >= 2 && s[0] == '"' && s[len(s)-1] == '"' {
		return s[1 : len(s)-1]
	}
	return s
}

// RemoteRef is a remote bookmark split into its name and remote components.
// The @git synthetic remote (jj's git-colocation tracking) is filtered out
// at parse time — it's not a real remote and clutters UI.
type RemoteRef struct {
	Name   string `json:"name"`
	Remote string `json:"remote"`
}

// LocalRef is a local bookmark with its conflict state. A conflicted bookmark
// (jj's "??" decorator) points at multiple commits and appears on each of them.
type LocalRef struct {
	Name     string `json:"name"`
	Conflict bool   `json:"conflict,omitempty"`
}

// GraphRow represents one revision in the log, with its graph lines and commit data.
type GraphRow struct {
	Commit      jj.Commit `json:"commit"`
	Description string    `json:"description"`
	// Bookmarks holds LOCAL bookmarks with conflict state (RefSymbol quotes
	// stripped). Before the local/remote_bookmarks template split, this was a
	// mixed array with `name@remote` strings — consumers had to parse them, and
	// the naive @-split broke on git-side branch names containing `@`.
	Bookmarks []LocalRef `json:"bookmarks,omitempty"`
	// RemoteBookmarks holds remote refs split at parse time. The \x1E
	// template separator never crosses the wire.
	RemoteBookmarks []RemoteRef `json:"remote_bookmarks,omitempty"`
	// GraphLines contains all the visual lines for this row,
	// including the node line and any connector lines below it.
	GraphLines []GraphLine `json:"graph_lines"`
}

// GraphLine is a single visual line, split into the graph gutter and content.
type GraphLine struct {
	// Gutter is the graph characters (│, ○, @, ├─╮, etc.)
	Gutter string `json:"gutter"`
	// Content is the text after the graph characters (may be empty for connector lines)
	Content string `json:"content,omitempty"`
	// IsNode is true if this line contains the revision node symbol (@, ○, ◆, ×)
	IsNode bool `json:"is_node,omitempty"`
}

// nodeRunes are the characters jj uses for revision nodes in the graph.
var nodeRunes = map[rune]bool{
	'@': true, // working copy
	'○': true, // normal commit
	'◆': true, // immutable commit
	'×': true, // conflicting commit
	'◌': true, // hidden commit
}

// containsNodeRune reports whether s contains any node symbol character.
func containsNodeRune(s string) bool {
	for _, r := range s {
		if nodeRunes[r] {
			return true
		}
	}
	return false
}

// ParseGraphLog parses the output of LogGraph into structured rows.
func ParseGraphLog(output string) []GraphRow {
	lines := strings.Split(output, "\n")
	rows := []GraphRow{}
	var current *GraphRow

	for _, line := range lines {
		if line == "" {
			continue
		}

		// Check if this line contains a _PREFIX: marker (it's a node line with commit data)
		if strings.Contains(line, jj.JJUIPrefix) {
			// Start a new row
			row := parseNodeLine(line)
			rows = append(rows, row)
			current = &rows[len(rows)-1]
		} else if current != nil {
			// It's a connector line (│, ├─╯, etc.) belonging to the current row.
			// Some lines contain text after graph chars, e.g. "~  (elided revisions)".
			// Split at the first '(' to preserve the text as Content.
			gl := GraphLine{Gutter: line}
			if idx := strings.Index(line, "("); idx > 0 {
				gl.Gutter = line[:idx]
				gl.Content = line[idx:]
			}
			current.GraphLines = append(current.GraphLines, gl)
		}
	}

	return rows
}

// parseNodeLine parses a line like:
// "○  _PREFIX:r_PREFIX:f_PREFIX:false\tui v1\tmain"
// into a GraphRow with commit data extracted.
func parseNodeLine(line string) GraphRow {
	row := GraphRow{}

	// Find where the _PREFIX: marker starts
	prefixIdx := strings.Index(line, jj.JJUIPrefix)
	if prefixIdx == -1 {
		return row
	}

	// Everything before the prefix is the graph gutter
	gutter := line[:prefixIdx]

	// The rest contains the markers and content
	rest := line[prefixIdx:]

	// Fields: [0]=prefixBlock [1]=changeId [2]=commitId [3]=description [4]=working_copies [5]=parent_ids [6]=bookmarks
	// Bookmarks MUST be last — SplitN(7) leaves the tail unsplit so \x1F-joined bookmark names survive.
	parts := strings.SplitN(rest, "\x1f", 7)
	prefixBlock := parts[0]

	// Parse the prefix block: _PREFIX:shortestChangeId_PREFIX:shortestCommitId_PREFIX:divergent_PREFIX:empty
	prefixParts := strings.Split(prefixBlock, jj.JJUIPrefix)
	var divergent bool
	if len(prefixParts) >= 4 {
		row.Commit.ChangePrefix = len(prefixParts[1])
		row.Commit.CommitPrefix = len(prefixParts[2])
		row.Commit.ChangeId = prefixParts[1]
		row.Commit.CommitId = prefixParts[2]
		divergent, _ = strconv.ParseBool(strings.TrimSpace(prefixParts[3]))
	}
	if len(prefixParts) >= 5 {
		row.Commit.Empty, _ = strconv.ParseBool(strings.TrimSpace(prefixParts[4]))
	}
	if len(prefixParts) >= 6 {
		row.Commit.Mine, _ = strconv.ParseBool(strings.TrimSpace(prefixParts[5]))
	}
	if len(prefixParts) >= 7 {
		row.Commit.AuthorEmail = strings.TrimSpace(prefixParts[6])
	}

	// Full IDs and content fields override the shortest prefix fallbacks
	if len(parts) >= 4 {
		row.Commit.ChangeId = parts[1]
		row.Commit.CommitId = parts[2]
		row.Description = parts[3]
	}

	row.Commit.Divergent = divergent

	// working_copies outputs "base2@ default@" — space-separated workspace names with @ suffix
	if len(parts) > 4 && parts[4] != "" {
		for wc := range strings.FieldsSeq(parts[4]) {
			name := strings.TrimSuffix(wc, "@")
			if name != "" {
				row.Commit.WorkingCopies = append(row.Commit.WorkingCopies, name)
			}
		}
	}

	// Parent commit IDs (comma-separated; empty for root)
	if len(parts) > 5 && parts[5] != "" {
		row.Commit.ParentIds = strings.Split(parts[5], ",")
	}

	// Bookmarks field (after SplitN(7) keeps tail unsplit) contains locals then
	// remotes, all \x1F-joined. Remotes are `name\x1Eremote`; locals are
	// `name\x1Dconflict` (\x1E presence is the local/remote distinguisher).
	// RefSymbol quoting (`"name"`) is stripped — it's a template-output detail
	// (jj quotes names with revset-special chars). The @git synthetic colocation
	// remote is dropped here so no consumer needs to filter it.
	if len(parts) > 6 && parts[6] != "" {
		for bm := range strings.SplitSeq(parts[6], "\x1f") {
			bm = strings.TrimSpace(bm)
			if bm == "" {
				continue
			}
			if name, remote, ok := strings.Cut(bm, "\x1e"); ok {
				if remote == "git" {
					continue
				}
				row.RemoteBookmarks = append(row.RemoteBookmarks, RemoteRef{
					Name:   stripRefQuotes(name),
					Remote: remote,
				})
			} else {
				name, conflict, _ := strings.Cut(bm, "\x1d")
				row.Bookmarks = append(row.Bookmarks, LocalRef{
					Name:     stripRefQuotes(name),
					Conflict: conflict == "true",
				})
			}
		}
	}

	// Detect working copy, hidden, immutable, and conflicted from graph characters
	row.Commit.IsWorkingCopy = strings.ContainsRune(gutter, '@')
	row.Commit.Hidden = strings.ContainsRune(gutter, '◌')
	row.Commit.Immutable = strings.ContainsRune(gutter, '◆')
	row.Commit.Conflicted = strings.ContainsRune(gutter, '×')

	// Build the graph line for this node
	row.GraphLines = []GraphLine{{
		Gutter: gutter,
		IsNode: containsNodeRune(gutter),
	}}

	return row
}
