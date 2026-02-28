package jj

import (
	"strconv"
	"strings"
)

// FileChange represents a file affected by a revision, with per-file stats and
// conflict info. Populated by ParseFilesTemplate from structured template output.
type FileChange struct {
	Type          string `json:"type"`           // A (added), M (modified), D (deleted), R (renamed)
	Path          string `json:"path"`
	Additions     int    `json:"additions"`
	Deletions     int    `json:"deletions"`
	Conflict      bool   `json:"conflict"`
	ConflictSides int    `json:"conflict_sides"` // 2 for 2-sided, 3+ for N-way merges. 0 when not conflicted.
}

// FilesTemplate returns a single jj log template call that emits file stats
// (status char, path, +/- line counts) AND conflict side-counts for one
// revision. Replaces the prior DiffSummary + DiffStat + ConflictedFiles
// three-subprocess pipeline with one call and structured output (no regex,
// no brace-syntax expansion, exact line counts — DiffStatEntry gives integers,
// not proportional ASCII bars).
//
// Output: {files section}\x1E{conflicts section}
//   files:     status_char\x1Fpath\x1Fadded\x1Fdeleted\n (joined)
//   conflicts: path\x1Fside_count\n (joined)
//
// DiffStatEntry.path() returns the DESTINATION path for renames — no brace
// expansion needed.
//
// Multi-revision caveat: `jj log -r 'X|Y'` runs the template PER-COMMIT (not
// a net combined diff like `jj diff -r 'X|Y'`). ParseFilesTemplate sums stats
// on duplicate paths so the file sidebar has no duplicate {#each} keys;
// the Type and counts are approximate for files touched in multiple commits.
func FilesTemplate(revision string) CommandArgs {
	tmpl := `self.diff().stat(200).files().map(|f| ` +
		`f.status_char() ++ "\x1F" ++ f.path() ++ "\x1F" ++ ` +
		`stringify(f.lines_added()) ++ "\x1F" ++ stringify(f.lines_removed())` +
		`).join("\n") ++ "\x1E" ++ ` +
		`conflicted_files.map(|f| f.path() ++ "\x1F" ++ stringify(f.conflict_side_count())).join("\n")`
	return []string{"log", "-r", revision, "--no-graph", "--color", "never",
		"--ignore-working-copy", "-T", tmpl}
}

// ParseFilesTemplate parses FilesTemplate output into a []FileChange.
// Conflict-only files (in conflicted_files but not in the diff — merge commits
// can have conflicts with no diff hunks) are appended with Type="M".
// Multi-revision revsets may emit the same conflict path multiple times;
// the byPath-keyed merge deduplicates so {#each} keys stay unique.
func ParseFilesTemplate(output string) []FileChange {
	filesSection, conflictSection, _ := strings.Cut(output, "\x1E")

	changes := []FileChange{}
	byPath := make(map[string]int) // path → index in changes (for conflict merge)

	for _, line := range strings.Split(filesSection, "\n") {
		if line == "" {
			continue
		}
		fields := strings.SplitN(line, "\x1F", 4)
		if len(fields) != 4 {
			continue
		}
		add, _ := strconv.Atoi(fields[2])
		del, _ := strconv.Atoi(fields[3])
		// Multi-revision revsets emit the template per-commit — sum stats
		// on duplicate paths to avoid duplicate {#each} keys. Type from the
		// FIRST occurrence (newest commit in jj log's default newest-first order).
		if idx, ok := byPath[fields[1]]; ok {
			changes[idx].Additions += add
			changes[idx].Deletions += del
			continue
		}
		byPath[fields[1]] = len(changes)
		changes = append(changes, FileChange{
			Type: fields[0], Path: fields[1], Additions: add, Deletions: del,
		})
	}

	for _, line := range strings.Split(conflictSection, "\n") {
		if line == "" {
			continue
		}
		fields := strings.SplitN(line, "\x1F", 2)
		path := fields[0]
		sides := 0
		if len(fields) == 2 {
			sides, _ = strconv.Atoi(fields[1])
		}
		if idx, ok := byPath[path]; ok {
			changes[idx].Conflict = true
			changes[idx].ConflictSides = sides
		} else {
			// Conflict-only file (merge commit, no diff hunks). Deduped via
			// byPath so multi-revision revsets don't produce duplicate entries.
			byPath[path] = len(changes)
			changes = append(changes, FileChange{
				Type: "M", Path: path, Conflict: true, ConflictSides: sides,
			})
		}
	}

	return changes
}
