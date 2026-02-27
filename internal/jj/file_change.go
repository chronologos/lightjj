package jj

import (
	"fmt"
	"regexp"
	"strings"
)

// FileChange represents a file affected by a revision, as reported by `jj diff --summary`.
type FileChange struct {
	Type          string `json:"type"`           // A (added), M (modified), D (deleted), R (renamed)
	Path          string `json:"path"`
	Additions     int    `json:"additions"`
	Deletions     int    `json:"deletions"`
	Conflict      bool   `json:"conflict"`
	ConflictSides int    `json:"conflict_sides"` // 2 for 2-sided, 3+ for N-way merges. 0 when not conflicted.
}

// FileStat holds per-file addition/deletion counts parsed from `jj diff --stat`.
type FileStat struct {
	Additions int
	Deletions int
}

// DiffStat builds args for `jj diff --stat` which outputs per-file change counts.
// Uses a wide term-width to prevent jj from truncating long file paths with "..."
// when the server inherits a narrow COLUMNS from the launching terminal.
func DiffStat(revision string) CommandArgs {
	return []string{"diff", "--stat", "--color", "never", "-r", revision, "--ignore-working-copy", "--config", "ui.term-width=500"}
}

// statLineRe matches lines like: " file1.go | 15 +++++++++------"
// Captures: filename, total count, bar graph chars.
// The bar is proportional — for large files jj truncates it.
// We use the total count and the +/- ratio in the bar to compute actual additions/deletions.
var statLineRe = regexp.MustCompile(`^\s*(.+?)\s+\|\s+(\d+)\s+([+-]+)\s*$`)

// ParseDiffStat parses the output of `jj diff -r <rev> --stat --color never`.
// Returns a map from file path to FileStat. The summary line at the end
// ("N files changed, ...") is ignored.
func ParseDiffStat(output string) map[string]FileStat {
	stats := make(map[string]FileStat)
	for _, line := range strings.Split(output, "\n") {
		m := statLineRe.FindStringSubmatch(line)
		if m == nil {
			continue
		}
		path := strings.TrimSpace(m[1])
		// Handle rename syntax: "{old => new}" or "dir/{old => new}"
		if idx := strings.Index(path, " => "); idx >= 0 {
			braceStart := strings.LastIndex(path[:idx], "{")
			braceEnd := strings.Index(path[idx:], "}")
			if braceStart >= 0 && braceEnd >= 0 {
				prefix := path[:braceStart]
				newName := path[idx+4 : idx+braceEnd]
				suffix := path[idx+braceEnd+1:]
				path = prefix + newName + suffix
			}
		}
		total := 0
		fmt.Sscanf(m[2], "%d", &total)
		bar := m[3]
		plusCount := strings.Count(bar, "+")
		minusCount := strings.Count(bar, "-")
		barTotal := plusCount + minusCount
		if barTotal > 0 && total > 0 {
			// Scale proportionally: the bar may be truncated for large files
			additions := (total * plusCount) / barTotal
			deletions := total - additions
			stats[path] = FileStat{Additions: additions, Deletions: deletions}
		}
	}
	return stats
}

// MergeStats enriches a slice of FileChange with stats from ParseDiffStat output.
// Falls back to suffix matching when stat paths are truncated (e.g., "...dir/file.go").
func MergeStats(files []FileChange, stats map[string]FileStat) {
	for i := range files {
		if s, ok := stats[files[i].Path]; ok {
			files[i].Additions = s.Additions
			files[i].Deletions = s.Deletions
			continue
		}
		// Fallback: match truncated stat paths by suffix.
		// jj truncates paths like "...dir/file.go" when terminal is narrow.
		for statPath, s := range stats {
			if strings.HasPrefix(statPath, "...") && strings.HasSuffix(files[i].Path, statPath[3:]) {
				files[i].Additions = s.Additions
				files[i].Deletions = s.Deletions
				break
			}
		}
	}
}

// ConflictEntry represents a conflicted file from `jj resolve --list`.
type ConflictEntry struct {
	Path  string
	Sides int // 2 for 2-way, 3+ for N-way. 0 if arity couldn't be parsed.
}

// resolveArityRe matches "N-sided" in resolve --list output.
var resolveArityRe = regexp.MustCompile(`(\d+)-sided`)

// ParseResolveList parses the output of `jj resolve --list` to extract conflicted
// file paths and their conflict arity. Each line has the form:
//   "path/to/file    2-sided conflict"
//   "other/file      3-sided conflict including 1 deletion"
// jj separates path from type with multiple spaces (right-aligns the path column).
func ParseResolveList(output string) []ConflictEntry {
	entries := []ConflictEntry{}
	for _, line := range strings.Split(output, "\n") {
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}
		e := ConflictEntry{Path: line}
		if idx := strings.Index(line, "    "); idx >= 0 {
			e.Path = line[:idx]
			if m := resolveArityRe.FindStringSubmatch(line[idx:]); m != nil {
				fmt.Sscanf(m[1], "%d", &e.Sides)
			}
		}
		entries = append(entries, e)
	}
	return entries
}

// ConflictPaths extracts just the paths from a ConflictEntry slice (for callers
// that don't need arity).
func ConflictPaths(entries []ConflictEntry) []string {
	paths := make([]string, len(entries))
	for i, e := range entries {
		paths[i] = e.Path
	}
	return paths
}

// MergeConflicts sets Conflict/ConflictSides on FileChange entries whose paths appear
// in the conflict entry list. Files in conflicts that aren't already in the list are
// appended (conflict-only files may not appear in DiffSummary output for merge commits).
func MergeConflicts(files []FileChange, conflicts []ConflictEntry) []FileChange {
	byPath := make(map[string]ConflictEntry, len(conflicts))
	for _, c := range conflicts {
		byPath[c.Path] = c
	}
	matched := make(map[string]bool, len(conflicts))
	for i := range files {
		if c, ok := byPath[files[i].Path]; ok {
			files[i].Conflict = true
			files[i].ConflictSides = c.Sides
			matched[c.Path] = true
		}
	}
	for _, c := range conflicts {
		if !matched[c.Path] {
			files = append(files, FileChange{Type: "M", Path: c.Path, Conflict: true, ConflictSides: c.Sides})
		}
	}
	return files
}

// ParseDiffSummary parses the output of `jj diff --summary --color never`.
// Each line has the form: "M src/main.go" or "A new_file.go".
func ParseDiffSummary(output string) []FileChange {
	changes := []FileChange{}
	for _, line := range strings.Split(output, "\n") {
		line = strings.TrimSpace(line)
		if len(line) < 2 {
			continue
		}
		changeType := string(line[0])
		path := strings.TrimSpace(line[1:])
		if path == "" {
			continue
		}
		changes = append(changes, FileChange{Type: changeType, Path: path})
	}
	return changes
}
