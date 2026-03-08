// Package jj provides pure functions that build jj CLI argument lists.
// These functions have no side effects — they only construct []string slices.
// Execution is handled by the runner package.
//
// Ported from github.com/idursun/jjui/internal/jj/commands.go
package jj

import (
	"fmt"
	"strconv"
	"strings"
)

const (
	JJUIPrefix = "_PREFIX:"
)

type CommandArgs = []string

// EscapeFileName wraps a path as a jj fileset pattern. Uses root-file: (not
// file:) — callers pass paths from diff/template output, which are workspace-
// root-relative. file: is cwd-relative and breaks in secondary workspaces AND
// SSH mode (wrapArgs uses -R, no cd → remote cwd is ~): jj walks .. →
// "Invalid component '..' in repo-relative path". Not root: — that's
// prefix-recursive (root:"a" matches a/ too), not exact-file.
func EscapeFileName(fileName string) string {
	fileName = strings.ReplaceAll(fileName, "\\", "\\\\")
	fileName = strings.ReplaceAll(fileName, "\"", "\\\"")
	return fmt.Sprintf("root-file:\"%s\"", fileName)
}

func escapeFiles(files []string) []string {
	escaped := make([]string, len(files))
	for i, f := range files {
		escaped[i] = EscapeFileName(f)
	}
	return escaped
}

// LogGraph builds args for `jj log` WITH graph topology.
// Output includes graph characters (│, ○, @, ├─╮, etc.) and _PREFIX: markers
// for extracting commit data. The graph characters encode the DAG topology
// which jj computes for us — we just parse it.
//
// Uses --ignore-working-copy: the snapshot loop (watcher.go) already runs
// `jj util snapshot` every 5s. Without this flag, every log fetch re-stats
// every tracked file (~485ms on medium repos) AND contends on the WC lock
// with the snapshot loop. With it: ~33ms. Worst case: an external file edit
// seen ≤5s late before SSE corrects — same contract as every other read.
func LogGraph(revset string, limit int) CommandArgs {
	args := []string{"log", "--color", "never", "--quiet", "--ignore-working-copy"}
	if revset != "" {
		args = append(args, "-r", revset)
	}
	if limit > 0 {
		args = append(args, "--limit", strconv.Itoa(limit))
	}
	// Template outputs: _PREFIX:shortestChangeId_PREFIX:shortestCommitId_PREFIX:divergent_PREFIX:empty \x1F fullShortChangeId \x1F fullShortCommitId \x1F description \x1F working_copies \x1F parent_ids \x1F bookmarks
	// Uses ASCII unit separator (\x1F) instead of tab to avoid breakage if descriptions contain tabs.
	// Parent IDs are comma-joined (commit IDs are hex, commas can't appear).
	// Bookmarks are joined with \x1F and MUST be the last field — the parser's SplitN leaves the tail unsplit.
	// Uses local_bookmarks.map(|b| b.name()) — the raw bookmarks keyword includes remote tracking
	// entries (@origin) and a * suffix for bookmarks ahead of their remote. .name() strips both.
	tmpl := fmt.Sprintf(
		`stringify('%s' ++ separate('%s', change_id.shortest(), commit_id.shortest(), divergent, empty)) ++ "\x1F" ++ change_id.short() ++ "\x1F" ++ commit_id.short() ++ "\x1F" ++ description.first_line() ++ "\x1F" ++ working_copies ++ "\x1F" ++ parents.map(|p| p.commit_id().short()).join(",") ++ "\x1F" ++ local_bookmarks.map(|b| b.name()).join("\x1F") ++ "\n"`,
		JJUIPrefix, JJUIPrefix)
	args = append(args, "-T", tmpl)
	return args
}

func New(revisions SelectedRevisions) CommandArgs {
	args := []string{"new"}
	args = append(args, revisions.AsArgs()...)
	return args
}

func CommitWorkingCopy(message string) CommandArgs {
	return []string{"commit", "-m", message}
}

func Edit(changeId string, ignoreImmutable bool) CommandArgs {
	args := []string{"edit", "-r", changeId}
	if ignoreImmutable {
		args = append(args, "--ignore-immutable")
	}
	return args
}

func Split(revision string, files []string, parallel bool, interactive bool) CommandArgs {
	args := []string{"split", "-r", revision}
	if parallel {
		args = append(args, "--parallel")
	}
	if interactive {
		args = append(args, "--interactive")
	}
	// When filesets are provided non-interactively, suppress the description
	// editor by passing an empty message. The second commit keeps the original
	// description automatically.
	if !interactive && len(files) > 0 {
		args = append(args, "-m", "")
	}
	args = append(args, escapeFiles(files)...)
	return args
}

func SetDescription(revision string, description string) (CommandArgs, string) {
	return []string{"describe", "-r", revision, "--stdin"}, description
}

func GetDescription(revision string) CommandArgs {
	return []string{"log", "-r", revision, "--template", "description", "--no-graph", "--ignore-working-copy", "--color", "never", "--quiet"}
}

func Abandon(revisions SelectedRevisions, ignoreImmutable bool) CommandArgs {
	args := []string{"abandon", "--retain-bookmarks"}
	args = append(args, revisions.AsArgs()...)
	if ignoreImmutable {
		args = append(args, "--ignore-immutable")
	}
	return args
}

func Diff(revision string, fileName string, color string, extraArgs ...string) CommandArgs {
	if color == "" {
		color = "always"
	}
	args := []string{"diff", "-r", revision, "--color", color, "--ignore-working-copy"}
	if fileName != "" {
		args = append(args, EscapeFileName(fileName))
	}
	args = append(args, extraArgs...)
	return args
}

// Restore resets the named files in `revision` to their content at `revision`'s
// parent(s) — undoes this revision's changes to those files. Uses `-c` (changes-in)
// which is `--from rev- --into rev` for single-parent revisions, or restore-to-merge
// for merge commits. Callers must pass at least one file; `jj restore -c X` with
// no files empties the whole revision, which is abandon's job.
func Restore(revision string, files []string) CommandArgs {
	args := []string{"restore", "-c", revision}
	args = append(args, escapeFiles(files)...)
	return args
}

func Undo() CommandArgs {
	return []string{"undo"}
}

// OpUndo reverts a specific operation by id. Unlike Undo() (latest-op
// shorthand), this targets an arbitrary op — the oplog right-click flow.
func OpUndo(id string) CommandArgs {
	return []string{"op", "undo", id}
}

// OpRestore resets the repo state to what it was at the given operation.
// This is the "time-travel" restore — everything after `id` is discarded.
func OpRestore(id string) CommandArgs {
	return []string{"op", "restore", id}
}

// RestoreFromTo copies the full tree from `from` into `to` — the evolog
// "restore this version" action. No file filter (full-tree by design);
// file-scoped restore is Restore()'s job.
func RestoreFromTo(from, to string) CommandArgs {
	return []string{"restore", "--from", from, "--to", to}
}

func BookmarkSet(revision string, name string) CommandArgs {
	return []string{"bookmark", "set", "-r", revision, name}
}

func BookmarkMove(revision string, bookmark string, extraFlags ...string) CommandArgs {
	args := []string{"bookmark", "move", bookmark, "--to", revision}
	args = append(args, extraFlags...)
	return args
}

// BookmarkAdvance is move restricted to forward-only (ancestor→descendant).
// jj 0.39's built-in `jj tug`. Unlike move, this refuses sideways/backwards
// moves — so accidentally hitting the wrong bookmark is safe. No
// --allow-backwards; that's the point.
func BookmarkAdvance(revision string, bookmark string) CommandArgs {
	return []string{"bookmark", "advance", bookmark, "--to", revision}
}

func BookmarkDelete(name string) CommandArgs {
	return []string{"bookmark", "delete", name}
}

func BookmarkForget(name string) CommandArgs {
	return []string{"bookmark", "forget", name}
}

func BookmarkTrack(name string, remote string) CommandArgs {
	args := []string{"bookmark", "track", name}
	if remote != "" {
		args = append(args, "--remote", remote)
	}
	return args
}

func BookmarkUntrack(name string, remote string) CommandArgs {
	args := []string{"bookmark", "untrack", name}
	if remote != "" {
		args = append(args, "--remote", remote)
	}
	return args
}

func Squash(from SelectedRevisions, destination string, files []string, keepEmptied bool, useDestinationMessage bool, interactive bool, ignoreImmutable bool) CommandArgs {
	args := []string{"squash"}
	args = append(args, from.AsPrefixedArgs("--from")...)
	args = append(args, "--into", destination)
	if keepEmptied {
		args = append(args, "--keep-emptied")
	}
	// Always pass --use-destination-message in non-interactive mode to prevent
	// jj from opening an editor when both source and destination have descriptions.
	// The web UI has no way to interactively compose a combined description.
	if useDestinationMessage || !interactive {
		args = append(args, "--use-destination-message")
	}
	if interactive {
		args = append(args, "--interactive")
	}
	if ignoreImmutable {
		args = append(args, "--ignore-immutable")
	}
	if len(files) > 0 {
		args = append(args, escapeFiles(files)...)
	}
	return args
}

// DiffRange builds args for `jj diff --from X --to Y` to compare two specific commits.
func DiffRange(from, to string, files []string) CommandArgs {
	args := []string{"diff", "--from", from, "--to", to, "--tool", ":git", "--color", "never", "--ignore-working-copy"}
	if len(files) > 0 {
		args = append(args, escapeFiles(files)...)
	}
	return args
}

// Explicit concatenation, NOT separate() — separate() skips empty arguments,
// so if(conflict, "", ...) would shift field positions. Empirically verified.
// Guards: if(normal_target, ...) because normal_target is absent for BOTH
//         conflicted AND deleted-local refs (conflict=false in the latter,
//         so if(conflict, ...) alone leaks "<Error: No Commit available>").
//         if(tracked, ...) because self.tracking_*_count() errors on
//         non-tracked refs. self. prefix is required on tracking_* methods.
// .short() (no arg) matches the log template so commit_id strings compare
// equal across endpoints (jumpToBookmark findIndex depends on this).
const bookmarkListTemplate = `name ++ "\x1F" ++ if(remote, remote, ".") ++ "\x1F" ++ stringify(tracked) ++ "\x1F" ++ stringify(conflict) ++ "\x1F" ++ if(normal_target, normal_target.commit_id().short(), "") ++ "\x1F" ++ added_targets.map(|c| c.commit_id().short()).join(",") ++ "\x1F" ++ if(tracked, stringify(self.tracking_ahead_count().lower()), "0") ++ "\x1F" ++ if(tracked, stringify(self.tracking_behind_count().lower()), "0") ++ "\x1F" ++ stringify(synced) ++ "\x1F" ++ if(normal_target, normal_target.description().first_line(), "") ++ "\x1F" ++ if(normal_target, normal_target.committer().timestamp().ago(), "") ++ "\n"`

func BookmarkList(revset string) CommandArgs {
	return []string{"bookmark", "list", "-a", "-r", revset, "--template", bookmarkListTemplate, "--color", "never", "--ignore-working-copy"}
}

func BookmarkListAll() CommandArgs {
	return []string{"bookmark", "list", "-a", "--template", bookmarkListTemplate, "--color", "never", "--ignore-working-copy"}
}

func GitFetch(flags ...string) CommandArgs {
	args := []string{"git", "fetch"}
	args = append(args, flags...)
	return args
}

func GitPush(flags ...string) CommandArgs {
	args := []string{"git", "push"}
	args = append(args, flags...)
	return args
}

func GitRemoteList() CommandArgs {
	return []string{"git", "remote", "list", "--color", "never", "--ignore-working-copy"}
}

func Rebase(from SelectedRevisions, to string, source string, target string, skipEmptied bool, ignoreImmutable bool) CommandArgs {
	args := []string{"rebase"}
	args = append(args, from.AsPrefixedArgs(source)...)
	args = append(args, target, to)
	if ignoreImmutable {
		args = append(args, "--ignore-immutable")
	}
	if skipEmptied {
		args = append(args, "--skip-emptied")
	}
	return args
}

// Evolog emits per-entry records including the rebase-safe inter_diff in git format.
// inter_diff() diffs the patch each version contributes relative to its own parents
// (like `jj evolog -p`) — a `diff --from pred --to cur` would instead show parent
// churn when the revision was rebased between snapshots. Records are \x1E-separated
// since the embedded diff text contains newlines.
func Evolog(revision string) CommandArgs {
	tmpl := `commit.commit_id().short(12) ++ "\x1F" ++ ` +
		`commit.committer().timestamp() ++ "\x1F" ++ ` +
		`operation.description() ++ "\x1F" ++ ` +
		`predecessors.map(|p| p.commit_id().short(12)).join(",") ++ "\x1F" ++ ` +
		`self.inter_diff().git() ++ "\x1E"`
	return []string{"evolog", "-r", revision, "--no-graph", "--color", "never", "--ignore-working-copy", "-T", tmpl}
}

type EvologEntry struct {
	CommitId       string   `json:"commit_id"`
	Time           string   `json:"time"`
	Operation      string   `json:"operation"`
	PredecessorIds []string `json:"predecessor_ids"`
	Diff           string   `json:"diff"`
}

func ParseEvolog(output string) []EvologEntry {
	entries := []EvologEntry{}
	for record := range strings.SplitSeq(output, "\x1E") {
		if record == "" {
			continue
		}
		parts := strings.SplitN(record, "\x1F", 5)
		if len(parts) < 5 {
			continue
		}
		entries = append(entries, EvologEntry{
			CommitId:       parts[0],
			Time:           parts[1],
			Operation:      parts[2],
			PredecessorIds: splitNonEmpty(parts[3], ","),
			Diff:           parts[4],
		})
	}
	return entries
}

// CurrentOpId returns the short ID of the most recent operation.
func CurrentOpId() CommandArgs {
	return []string{"op", "log", "--no-graph", "--color", "never", "--ignore-working-copy",
		"--limit", "1", "-T", `self.id().short()`}
}

// DebugSnapshot asks jj to snapshot the working copy. Advances op_heads only
// if the WC actually differs. Used by the filesystem watcher to catch raw file
// edits that jj hasn't observed yet.
//
// Was `debug snapshot` until jj 0.39 promoted it to `util snapshot` (the old
// form is deprecated, removed in v0.45). Function name kept for call-site
// stability — the periodic loop fires this every 5s, so the deprecation
// warning would have been a log-spam firehose.
func DebugSnapshot() CommandArgs {
	return []string{"util", "snapshot"}
}

func OpLog(limit int) CommandArgs {
	args := []string{"op", "log", "--no-graph", "--color", "never", "--ignore-working-copy"}
	if limit > 0 {
		args = append(args, "--limit", strconv.Itoa(limit))
	}
	tmpl := `self.id().short() ++ "\x1F" ++ self.description() ++ "\x1F" ++ self.time().start() ++ "\x1F" ++ if(self.current_operation(), "true", "false") ++ "\n"`
	args = append(args, "-T", tmpl)
	return args
}

type OpEntry struct {
	ID          string `json:"id"`
	Description string `json:"description"`
	Time        string `json:"time"`
	IsCurrent   bool   `json:"is_current"`
}

func ParseOpLog(output string) []OpEntry {
	entries := []OpEntry{}
	for line := range strings.SplitSeq(strings.TrimSpace(output), "\n") {
		if line == "" {
			continue
		}
		parts := strings.SplitN(line, "\x1f", 4)
		if len(parts) < 4 {
			continue
		}
		entries = append(entries, OpEntry{
			ID:          parts[0],
			Description: parts[1],
			Time:        parts[2],
			IsCurrent:   parts[3] == "true",
		})
	}
	return entries
}

func ConfigListAliases() CommandArgs {
	return []string{"config", "list", "aliases", "--color", "never", "--ignore-working-copy"}
}

// FileShow returns args for `jj file show` to get a file's content at a revision.
// Uses EscapeFileName for consistency and to prevent dash-prefix flag injection.
func FileShow(revision string, path string) CommandArgs {
	return []string{"file", "show", "-r", revision, "--ignore-working-copy", EscapeFileName(path)}
}

// FilesBatch returns args for a single jj log template call that emits file
// stats (status char, path, +/- line counts) for multiple revisions. Used to
// pre-load the file-list sidebar for a window of revisions in one subprocess.
//
// Output format per commit: {commitId}\x1E{conflicted:0|1}\x1E{files}\x1D
// Files: status_char\x1Fpath\x1Flines_added\x1Flines_removed\n (joined)
//
// DiffStatEntry.path() returns the destination path for renames — no brace
// expansion needed (unlike parsing `jj diff --stat` human output).
//
// Conflict detail (side counts) is NOT included — commits with conflict=true
// should fall back to the full /api/files endpoint. This keeps the batch call
// fast and avoids a second template iteration for the rare conflicted case.
func FilesBatch(commitIds []string) CommandArgs {
	if len(commitIds) == 0 {
		return nil
	}
	// The template uses diff().stat(200) — the width arg affects the textual
	// bar rendering (which we don't use), not the numeric counts. 200 avoids
	// any internal truncation edge cases.
	tmpl := `self.commit_id().short() ++ "\x1E" ++ ` +
		`if(self.conflict(), "1", "0") ++ "\x1E" ++ ` +
		`self.diff().stat(200).files().map(|f| ` +
		`f.status_char() ++ "\x1F" ++ f.path() ++ "\x1F" ++ ` +
		`stringify(f.lines_added()) ++ "\x1F" ++ stringify(f.lines_removed())` +
		`).join("\n") ++ "\x1D"`
	return []string{"log", "-r", strings.Join(commitIds, "|"),
		"--no-graph", "--color", "never", "--ignore-working-copy", "-T", tmpl}
}

// FilesBatchEntry is one commit's result from FilesBatch.
type FilesBatchEntry struct {
	Conflict bool          `json:"conflict"`
	Files    []*FileChange `json:"files"`
}

// ParseFilesBatch parses FilesBatch template output into a map keyed by
// commit_id. Records are \x1D-separated; each record has three \x1E-separated
// fields: commit_id, conflict flag, and \n-joined file lines (each with four
// \x1F-separated fields: status_char, path, additions, deletions).
func ParseFilesBatch(output string) map[string]FilesBatchEntry {
	result := make(map[string]FilesBatchEntry)
	for record := range strings.SplitSeq(output, "\x1D") {
		if record == "" {
			continue
		}
		parts := strings.SplitN(record, "\x1E", 3)
		if len(parts) != 3 {
			continue
		}
		commitId := parts[0]
		conflicted := parts[1] == "1"
		files := []*FileChange{}
		for line := range strings.SplitSeq(parts[2], "\n") {
			if line == "" {
				continue
			}
			fields := strings.SplitN(line, "\x1F", 4)
			if len(fields) != 4 {
				continue
			}
			add, _ := strconv.Atoi(fields[2])
			del, _ := strconv.Atoi(fields[3])
			files = append(files, &FileChange{
				Type:      fields[0],
				Path:      fields[1],
				Additions: add,
				Deletions: del,
			})
		}
		result[commitId] = FilesBatchEntry{Conflict: conflicted, Files: files}
	}
	return result
}

// Resolve returns args for `jj resolve` to resolve a conflicted file with a tool.
func Resolve(revision string, file string, tool string) CommandArgs {
	return []string{"resolve", "--tool", tool, "-r", revision, EscapeFileName(file)}
}

// WorkspaceList returns args for `jj workspace list` with a template.
// WorkspaceRef.name() + .target() (Commit) — structured output, no parsing
// of "default: skpssuxl a14ce848 desc" human format (which broke on
// workspace names containing ": ").
//
// target.current_working_copy() identifies "this is the current workspace"
// — true only when target IS the current workspace's @ commit. Path-matching
// (wsPath == RepoDir) broke in SSH mode where the user-typed --remote path
// isn't canonical. Edge case: two workspaces on the same commit both read
// true — rare, cosmetic (wrong badge at worst).
func WorkspaceList() CommandArgs {
	tmpl := `name ++ "\x1F" ++ target.change_id().short() ++ "\x1F" ++ target.commit_id().short() ++ "\x1F" ++ stringify(target.current_working_copy()) ++ "\n"`
	return []string{"workspace", "list", "--color", "never", "--ignore-working-copy", "-T", tmpl}
}

// Workspace represents a jj workspace entry.
type Workspace struct {
	Name     string `json:"name"`
	ChangeId string `json:"change_id"`
	CommitId string `json:"commit_id"`
	Current  bool   `json:"current"`
}

// ParseWorkspaceList parses WorkspaceList template output.
// Each line: name\x1Fchange_id\x1Fcommit_id\x1Fcurrent
func ParseWorkspaceList(output string) []Workspace {
	workspaces := []Workspace{}
	for line := range strings.SplitSeq(strings.TrimSpace(output), "\n") {
		parts := strings.SplitN(line, "\x1F", 4)
		if len(parts) != 4 {
			continue
		}
		workspaces = append(workspaces, Workspace{
			Name: parts[0], ChangeId: parts[1], CommitId: parts[2], Current: parts[3] == "true",
		})
	}
	return workspaces
}
