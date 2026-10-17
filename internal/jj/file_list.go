package jj

import (
	"encoding/json"
	"strings"
)

// TreeFile is one entry of a revision's full tree listing (`jj file list`):
// every file that EXISTS in the commit, not just the changed ones (that's
// FileChange). Directories are never emitted by jj — the API layer derives
// them from path prefixes.
type TreeFile struct {
	Path string `json:"path"`
	// Type is TreeEntry.file_type(): "file", "symlink", "git-submodule", or
	// "conflict" ("tree" never appears in a file listing). The plain-path
	// fallback (FileList) can't see it and reports "file".
	Type       string `json:"type"`
	Executable bool   `json:"executable,omitempty"`
}

// fileListJSONTemplate composes one JSON object per entry from named fields
// (CLAUDE.md: never json(self) — that schema is jj's, not ours). json(path)
// renders the REPO-relative path — unlike the default `jj file list` template
// (`format_path(path)`, jj ≥ 0.36), which is cwd-relative and would come out
// as `../x` from a non-root cwd (SSH mode's remote cwd is `~`). Booleans use
// the proven if(...) form; json() is only relied on to escape strings.
//
// Measured on jj 0.45.1 (200k-file synthetic repo, warm): the extra
// file_type/executable fields cost nothing measurable over a bare
// `path ++ "\n"` (both ~2–3s, dominated by tree walking); output is ~88 B/file.
const fileListJSONTemplate = `'{"path":' ++ json(path) ++ ',"type":' ++ json(file_type) ++ ',"executable":' ++ if(executable, "true", "false") ++ '}' ++ "\n"`

// FileListJSON lists every file in `revision` as one JSON object per line.
// `jj file list -T` exists since jj 0.26 (TreeEntry template type with
// path/file_type/executable); json() since 0.31 — callers gate on
// JSONTemplates and fall back to FileList. --ignore-working-copy: a read
// (callers pass a resolved commit id, so a snapshot couldn't change the answer).
func FileListJSON(revision string) CommandArgs {
	return []string{"file", "list", "-r", revision, "--ignore-working-copy", "--color", "never", "-T", fileListJSONTemplate}
}

// FileList is the pre-json() fallback: bare repo-relative paths, one per line.
// `path` (not the default template's format_path) for the same cwd-relativity
// reason as above. Loses only (a) file type/executable bits and (b) paths
// containing a newline — a legal but vanishingly rare filename, which this
// format can't frame (it would split into two bogus entries). Older-jj-only.
func FileList(revision string) CommandArgs {
	return []string{"file", "list", "-r", revision, "--ignore-working-copy", "--color", "never", "-T", `path ++ "\n"`}
}

// ParseFileListJSON parses FileListJSON output. Unparseable or path-less
// lines are skipped (same tolerance as ParseOpLogJSON). Returns an empty
// slice, never nil. Order is preserved (jj emits paths in sorted order).
func ParseFileListJSON(output string) []TreeFile {
	files := []TreeFile{}
	for line := range strings.SplitSeq(output, "\n") {
		if line == "" {
			continue
		}
		var f TreeFile
		if err := json.Unmarshal([]byte(line), &f); err != nil || f.Path == "" {
			continue
		}
		if f.Type == "" {
			f.Type = "file"
		}
		files = append(files, f)
	}
	return files
}

// ParseFileList parses FileList output. Lines are taken VERBATIM (no
// TrimSpace — leading/trailing spaces and \r are legal in filenames).
// Every entry is Type "file".
func ParseFileList(output string) []TreeFile {
	files := []TreeFile{}
	for line := range strings.SplitSeq(output, "\n") {
		if line == "" {
			continue
		}
		files = append(files, TreeFile{Path: line, Type: "file"})
	}
	return files
}

// ResolveCommitId resolves a revset to commit ids (one per line). Used to pin
// a symbolic revision (`@`, a bookmark) to its content-addressed id before
// caching anything keyed on it. Callers treat != 1 line as an error.
func ResolveCommitId(revision string) CommandArgs {
	return []string{"log", "-r", revision, "--no-graph", "--ignore-working-copy", "--color", "never", "-T", `commit_id ++ "\n"`}
}
