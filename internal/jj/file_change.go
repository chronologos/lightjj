package jj

import (
	"fmt"
	"regexp"
	"strings"
)

// FileChange represents a file affected by a revision, as reported by `jj diff --summary`.
type FileChange struct {
	Type      string `json:"type"`      // A (added), M (modified), D (deleted), R (renamed)
	Path      string `json:"path"`
	Additions int    `json:"additions"`
	Deletions int    `json:"deletions"`
	Conflict  bool   `json:"conflict"`
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

// ParseResolveList parses the output of `jj resolve --list` to extract conflicted file paths.
// Each line has the form: "path/to/file    2-sided conflict" — we extract just the path
// by splitting on multiple consecutive spaces (the separator jj uses between path and type).
func ParseResolveList(output string) []string {
	paths := []string{}
	for _, line := range strings.Split(output, "\n") {
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}
		// jj separates the file path from the conflict type with multiple spaces.
		// Split on "    " (4 spaces) to extract just the path.
		if idx := strings.Index(line, "    "); idx >= 0 {
			line = line[:idx]
		}
		paths = append(paths, line)
	}
	return paths
}

// MergeConflicts sets Conflict=true on FileChange entries whose paths appear in conflictPaths.
// Files in conflictPaths that aren't already in the list are appended (conflict-only files
// may not appear in DiffSummary output for merge commits).
func MergeConflicts(files []FileChange, conflictPaths []string) []FileChange {
	pathSet := make(map[string]bool, len(conflictPaths))
	for _, p := range conflictPaths {
		pathSet[p] = true
	}
	matched := make(map[string]bool, len(conflictPaths))
	for i := range files {
		if pathSet[files[i].Path] {
			files[i].Conflict = true
			matched[files[i].Path] = true
		}
	}
	for _, p := range conflictPaths {
		if !matched[p] {
			files = append(files, FileChange{Type: "M", Path: p, Conflict: true})
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
