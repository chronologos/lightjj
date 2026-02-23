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
}

// FileStat holds per-file addition/deletion counts parsed from `jj diff --stat`.
type FileStat struct {
	Additions int
	Deletions int
}

// DiffStat builds args for `jj diff --stat` which outputs per-file change counts.
func DiffStat(revision string) CommandArgs {
	return []string{"diff", "--stat", "--color", "never", "-r", revision, "--ignore-working-copy"}
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
func MergeStats(files []FileChange, stats map[string]FileStat) {
	for i := range files {
		if s, ok := stats[files[i].Path]; ok {
			files[i].Additions = s.Additions
			files[i].Deletions = s.Deletions
		}
	}
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
