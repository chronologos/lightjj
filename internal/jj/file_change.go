package jj

import "strings"

// FileChange represents a file affected by a revision, as reported by `jj diff --summary`.
type FileChange struct {
	Type string `json:"type"` // A (added), M (modified), D (deleted), R (renamed)
	Path string `json:"path"`
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
