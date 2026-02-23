// Package parser parses `jj log` output with graph characters and _PREFIX: markers.
// Simplified from jjui's parser — no ANSI handling needed since we use --color never.
package parser

import (
	"strconv"
	"strings"

	"github.com/iant/lightjj/internal/jj"
)

// GraphRow represents one revision in the log, with its graph lines and commit data.
type GraphRow struct {
	Commit      jj.Commit `json:"commit"`
	Description string    `json:"description"`
	Bookmarks   []string  `json:"bookmarks,omitempty"`
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
			// It's a connector line (│, ├─╯, etc.) belonging to the current row
			current.GraphLines = append(current.GraphLines, GraphLine{
				Gutter: line,
			})
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

	// Unit-separator-delimited fields: prefixBlock \x1F fullChangeId \x1F fullCommitId \x1F description \x1F bookmarks
	parts := strings.SplitN(rest, "\x1f", 5)
	prefixBlock := parts[0]
	if len(parts) > 1 {
		row.Commit.ChangeId = parts[1]
	}
	if len(parts) > 2 {
		row.Commit.CommitId = parts[2]
	}
	if len(parts) > 3 {
		row.Description = parts[3]
	}
	if len(parts) > 4 && parts[4] != "" {
		// Bookmarks are joined with \x1F in the template to handle names with spaces.
		// After the top-level SplitN on \x1F, remaining separators within the bookmarks
		// field delimit individual bookmark names.
		for _, bm := range strings.Split(parts[4], "\x1f") {
			bm = strings.TrimSpace(bm)
			if bm != "" {
				row.Bookmarks = append(row.Bookmarks, bm)
			}
		}
	}

	// Parse the prefix block: _PREFIX:shortestChangeId_PREFIX:shortestCommitId_PREFIX:divergent
	prefixParts := strings.Split(prefixBlock, jj.JJUIPrefix)
	if len(prefixParts) >= 4 {
		row.Commit.ChangePrefix = len(prefixParts[1])
		row.Commit.CommitPrefix = len(prefixParts[2])
		divergent, _ := strconv.ParseBool(strings.TrimSpace(prefixParts[3]))
		if divergent {
			row.Commit.ChangeId += "??"
		}
		// If full IDs weren't in the tab fields, fall back to shortest
		if row.Commit.ChangeId == "" {
			row.Commit.ChangeId = prefixParts[1]
		}
		if row.Commit.CommitId == "" {
			row.Commit.CommitId = prefixParts[2]
		}
	}

	// Detect working copy, hidden, and immutable from graph characters
	row.Commit.IsWorkingCopy = strings.ContainsRune(gutter, '@')
	row.Commit.Hidden = strings.ContainsRune(gutter, '◌')
	row.Commit.Immutable = strings.ContainsRune(gutter, '◆')

	// Build the graph line for this node
	row.GraphLines = []GraphLine{{
		Gutter: gutter,
		IsNode: containsNodeRune(gutter),
	}}

	return row
}
