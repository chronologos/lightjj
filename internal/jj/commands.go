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

// Version returns args for `jj --version`. Output format: `jj 0.39.0`.
func Version() CommandArgs {
	return []string{"--version"}
}

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
	// Template outputs: _PREFIX:shortestChangeId_PREFIX:shortestCommitId_PREFIX:divergent_PREFIX:empty_PREFIX:mine_PREFIX:author.email_PREFIX:committer.timestamp \x1F fullShortChangeId \x1F fullShortCommitId \x1F description \x1F working_copies \x1F parent_ids \x1F bookmarks
	// Uses ASCII unit separator (\x1F) instead of tab to avoid breakage if descriptions contain tabs.
	// Parent IDs are comma-joined (commit IDs are hex, commas can't appear).
	// Bookmarks are joined with \x1F and MUST be the last field — the parser's SplitN leaves the tail unsplit.
	// local_bookmarks + remote_bookmarks are concatenated — `bookmarks` alone collapses
	// tracked-and-synced remotes into the local form (main@upstream vanishes when local
	// main is at the same commit). Delimiter hierarchy (git refs can't contain control
	// chars per git-check-ref-format, all three are collision-safe):
	//   \x1F — outer field separator
	//   \x1E — distinguishes remote entries (name\x1Eremote); presence = remote
	//   \x1D — sub-field within locals (name\x1Dconflict\x1Dsynced); jj's "??"/"*" decorators
	// @ CAN appear in git-created branch names, which jj imports and RefSymbol-quotes.
	// .name() quote-wraps names containing revset-special chars; the parser strips
	// those quotes and filters the @git colocation synthetic remote.
	// mine + author.email() + committer.timestamp() appended via EXPLICIT '++ _PREFIX: ++'
	// — NOT inside separate(). separate() skips empty args (see bookmarkListTemplate
	// comment below); a root commit or malformed-import author.email() would shift
	// field positions. Explicit concat guarantees the _PREFIX markers are always
	// present even if the value is empty. Parser's len(prefixParts)>=6/>=7/>=8
	// checks still keep old test fixtures backward-compatible.
	tmpl := fmt.Sprintf(
		`stringify('%s' ++ separate('%s', change_id.shortest(), commit_id.shortest(), divergent, empty)) ++ '%s' ++ stringify(mine) ++ '%s' ++ author.email() ++ '%s' ++ committer.timestamp() ++ "\x1F" ++ change_id.short() ++ "\x1F" ++ commit_id.short() ++ "\x1F" ++ description.first_line() ++ "\x1F" ++ working_copies ++ "\x1F" ++ parents.map(|p| p.commit_id().short()).join(",") ++ "\x1F" ++ local_bookmarks.map(|b| b.name() ++ "\x1D" ++ stringify(b.conflict()) ++ "\x1D" ++ stringify(b.synced())).join("\x1F") ++ "\x1F" ++ remote_bookmarks.map(|b| b.name() ++ "\x1E" ++ b.remote()).join("\x1F") ++ "\n"`,
		JJUIPrefix, JJUIPrefix, JJUIPrefix, JJUIPrefix, JJUIPrefix)
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

func Split(revision string, files []string, parallel bool) CommandArgs {
	args := []string{"split", "-r", revision}
	if parallel {
		args = append(args, "--parallel")
	}
	// Suppress the description editor when filesets are provided. The second
	// commit keeps the original description automatically.
	if len(files) > 0 {
		args = append(args, "-m", "")
	}
	args = append(args, escapeFiles(files)...)
	return args
}

// SplitWithTool invokes `jj split` with a diff-editor tool defined in an
// ephemeral --config-file. The tool is our own binary re-entering via
// --apply-hunks (cmd/lightjj/apply_hunks.go). `-m` both suppresses jj's
// description-editor (without it jj opens vim → request hangs) AND sets
// the FIRST (selected=accepted) commit's description. The SECOND commit
// keeps the original. Caller passes the original description so the
// accepted hunks — the work that matters — keep the message.
// No --parallel: hunk-review produces parent→child (reviewing ≠ forking).
func SplitWithTool(revision, configFile, description string) CommandArgs {
	return []string{"split", "-r", revision, "-m", description,
		"--config-file", configFile, "--tool", "lightjj-hunks"}
}

func SetDescription(revision string, description string) (CommandArgs, string) {
	return []string{"describe", "-r", revision, "--stdin"}, description
}

func GetDescription(revision string) CommandArgs {
	return []string{"log", "-r", revision, "--template", "description", "--no-graph", "--ignore-working-copy", "--color", "never", "--quiet"}
}

// MetaeditUpdateChangeId gives one commit a fresh change_id — the jj-guide
// "split identity" divergence resolution. Divergence = two commits sharing a
// change_id; rerolling one commit's change_id breaks the link without touching
// content. Primary use case: divergent-with-immutable-sibling where abandon
// would discard the user's mutable work and Keep can't abandon the trunk copy.
func MetaeditUpdateChangeId(commitId string) CommandArgs {
	return []string{"metaedit", "-r", commitId, "--update-change-id"}
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

// OpShow returns args for `jj op show` — the human-formatted operation-diff
// (Changed commits +/-, Changed working copy, Changed bookmarks). There's no
// template surface for this; jj renders it from the Transaction internally.
// Returned verbatim to the frontend as a <pre> block — the one place where
// passing human output through is correct rather than lazy.
func OpShow(id string) CommandArgs {
	return []string{"op", "show", "--no-graph", "--color", "never", "--ignore-working-copy", id}
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

// BookmarkSetToRemote snaps a (typically conflicted) local bookmark to its
// remote-tracking ref `name@remote`. Always passes --allow-backwards because
// the whole point of this command is "override whatever local state is, match
// remote": a conflicted bookmark has multiple targets that aren't in any
// ancestry relation, and even non-conflicted overrides may move backwards.
//
// jj's revset syntax is `<name>@<remote>` UNQUOTED — the @ is the at-operator,
// not part of a string literal. Bookmark names allow letters/digits/-/_/. so
// no escaping needed here (jj's bookmark-name parser would have rejected the
// name at create time if it contained whitespace or special chars).
func BookmarkSetToRemote(name string, remote string) CommandArgs {
	return []string{"bookmark", "set", "-r", name + "@" + remote, name, "--allow-backwards"}
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

func Squash(from SelectedRevisions, destination string, files []string, keepEmptied bool, ignoreImmutable bool) CommandArgs {
	args := []string{"squash"}
	args = append(args, from.AsPrefixedArgs("--from")...)
	args = append(args, "--into", destination)
	if keepEmptied {
		args = append(args, "--keep-emptied")
	}
	// --use-destination-message is unconditional: jj would otherwise open an
	// editor when both source and destination have descriptions, and the web UI
	// has no way to compose a combined one. StatusBar used to surface this as a
	// toggle — it was a placebo (the condition here was `X || !interactive`
	// with interactive hardcoded false).
	args = append(args, "--use-destination-message")
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

// RebaseOptions' zero value = no extra flags. Struct instead of trailing bools
// so adding the next flag won't churn every test call site.
type RebaseOptions struct {
	SkipEmptied     bool
	IgnoreImmutable bool
	SimplifyParents bool
}

func Rebase(from SelectedRevisions, to, source, target string, opts RebaseOptions) CommandArgs {
	args := []string{"rebase"}
	args = append(args, from.AsPrefixedArgs(source)...)
	args = append(args, target, to)
	if opts.IgnoreImmutable {
		args = append(args, "--ignore-immutable")
	}
	if opts.SkipEmptied {
		args = append(args, "--skip-emptied")
	}
	if opts.SimplifyParents {
		args = append(args, "--simplify-parents")
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

// PollOpId is CurrentOpId WITHOUT --ignore-working-copy — it snapshots first.
// SSH mode has no fs-watcher and no snapshotLoop: this IS the snapshot path.
// Without it, remote editor saves are invisible (diff/log use
// --ignore-working-copy, nothing else snapshots). One SSH round trip does
// snapshot + op-id read.
func PollOpId() CommandArgs {
	return []string{"op", "log", "--no-graph", "--color", "never",
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

// ConfigGet returns args to read a single jj config key. Exits non-zero if
// the key is unset — caller treats that as "not configured".
func ConfigGet(key string) CommandArgs {
	return []string{"config", "get", key, "--color", "never", "--ignore-working-copy"}
}

// FileShow returns args for `jj file show` to get a file's content at a revision.
// Uses EscapeFileName for consistency and to prevent dash-prefix flag injection.
//
// snapshotMarkers forces ui.conflict-marker-style=snapshot so reconstructSides()
// sees byte-exact base in `-------` sections. ONLY merge-controller wants this —
// hunk-review (App.svelte executeHunkReview) needs FileShow to match Diff() and
// `jj split --tool`'s $left, which both use the user's configured style; a
// mismatch shifts applyHunks line offsets and silently commits corrupted output.
func FileShow(revision string, path string, snapshotMarkers bool) CommandArgs {
	args := []string{"file", "show", "-r", revision, "--ignore-working-copy"}
	if snapshotMarkers {
		args = append(args, "--config", "ui.conflict-marker-style=snapshot")
	}
	return append(args, EscapeFileName(path))
}

// ResolveApply commits a resolved file at any mutable revision via
// `jj resolve --tool`, where the "tool" is `cp <resultPath> $output`. jj
// materializes $base/$left/$right/$output as temp files, runs cp, and on
// exit 0 commits whatever's in $output. Inline --config (no temp TOML) so
// the only filesystem dependency is resultPath itself.
//
// Local-only — resultPath must be readable by the jj subprocess. SSH mode
// should 501 at the handler (matching handleSplitHunks). POSIX-only (`cp`) —
// release.yml ships darwin/linux only; if Windows lands, swap to a self-binary
// helper mode like writeHunkToolConfig's pattern.
func ResolveApply(rev, resultPath, repoRelPath string) CommandArgs {
	return []string{
		"resolve", "-r", rev,
		"--config", `merge-tools.ljjcp.program="cp"`,
		"--config", fmt.Sprintf(`merge-tools.ljjcp.merge-args=[%q,"$output"]`, resultPath),
		"--tool", "ljjcp",
		"--", EscapeFileName(repoRelPath),
	}
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

// FileLog returns LogGraph args scoped to commits touching path. Thin wrapper
// — the revset does all the work. Kept server-side so EscapeFileName's quote
// handling stays the single source of truth (paths can contain " and \).
//
// The mutable() intersection is a fallback for repos where the changed-path
// index hasn't been built: files() without the index is O(commits×tree-diff),
// 20+s on large repos. mutable() evaluates first (cheap) so files() only runs
// on those commits. full=true drops the scope — caller must ensure the index
// is built first (frontend hits /api/index-paths separately; handleFileHistory
// does NOT build inline — that exceeds the 30s read timeout on large repos).
func FileLog(path string, limit int, full bool) CommandArgs {
	revset := "files(" + EscapeFileName(path) + ")"
	if !full {
		revset = "mutable() & " + revset
	}
	return LogGraph(revset, limit)
}

// IndexChangedPaths builds jj's changed-path index (per-commit path Bloom
// filter, .jj/repo/index/changed_paths/). Once built, files() revsets use it
// automatically — ~70× speedup on merge-heavy repos per jj#4674. The index is
// segment-based and persists; re-running appends new commits only. Under
// `debug` because jj hasn't promoted it to stable yet (jj#7250).
//
func IndexChangedPaths() CommandArgs {
	return []string{"debug", "index-changed-paths"}
}

// ConflictList returns args for a jj log call emitting every conflicted
// commit in revset with its conflicted-files list + side counts. Used by
// the merge-mode conflict queue to show all conflicts in one fetch.
//
// Output per commit: commit_id\x1Echange_id\x1Edescription\x1Efiles\x1D
// Files: path\x1Fside_count\n (joined)
//
// Unlike FilesBatch this omits diff stats (additions/deletions) — the queue
// only needs path + side_count for the list UI.
func ConflictList(revset string) CommandArgs {
	if revset == "" {
		// `& mutable()` is a 60× speedup on large repos — jj evaluates the
		// cheap mutable() filter first, then checks conflicts only on those.
		// conflicts() alone scans every commit. Also semantically correct:
		// the user can only RESOLVE mutable conflicts anyway.
		revset = "conflicts() & mutable()"
	}
	tmpl := `self.commit_id().short() ++ "\x1E" ++ ` +
		`self.change_id().short() ++ "\x1E" ++ ` +
		`self.description().first_line() ++ "\x1E" ++ ` +
		`conflicted_files.map(|f| f.path() ++ "\x1F" ++ ` +
		`stringify(f.conflict_side_count())).join("\n") ++ "\x1D"`
	return []string{"log", "-r", revset,
		"--no-graph", "--color", "never", "--ignore-working-copy", "-T", tmpl}
}

// ConflictEntry is one commit's conflicted files from ConflictList.
type ConflictEntry struct {
	CommitId    string          `json:"commit_id"`
	ChangeId    string          `json:"change_id"`
	Description string          `json:"description"`
	Files       []*ConflictFile `json:"files"`
}

// ConflictFile is a single conflicted file with its N-way side count.
type ConflictFile struct {
	Path  string `json:"path"`
	Sides int    `json:"sides"`
}

// ParseConflictList parses ConflictList template output into an ordered slice.
// Order preserves jj log emission order (topological, descendants-first).
func ParseConflictList(output string) []*ConflictEntry {
	entries := []*ConflictEntry{}
	for record := range strings.SplitSeq(output, "\x1D") {
		if record == "" {
			continue
		}
		parts := strings.SplitN(record, "\x1E", 4)
		if len(parts) != 4 {
			continue
		}
		files := []*ConflictFile{}
		for line := range strings.SplitSeq(parts[3], "\n") {
			if line == "" {
				continue
			}
			kv := strings.SplitN(line, "\x1F", 2)
			if len(kv) != 2 {
				continue
			}
			sides, _ := strconv.Atoi(kv[1])
			files = append(files, &ConflictFile{Path: kv[0], Sides: sides})
		}
		entries = append(entries, &ConflictEntry{
			CommitId:    parts[0],
			ChangeId:    parts[1],
			Description: parts[2],
			Files:       files,
		})
	}
	return entries
}

// WorkspaceAdd returns args for `jj workspace add <dest> --name <name>`.
// Destination is an absolute path; jj refuses if it already exists with content.
// Name is optional (jj defaults to basename(dest)) but always passed here so
// callers see the same name in working_copies output as they typed.
func WorkspaceAdd(dest, name string) CommandArgs {
	args := []string{"workspace", "add", dest}
	if name != "" {
		args = append(args, "--name", name)
	}
	return args
}

// WorkspaceUpdateStale returns args for `jj workspace update-stale`.
// Recovers a workspace whose working-copy commit was rewritten by another
// workspace. jj snapshots any uncommitted edits into a new commit first, then
// checks out the current view's @ — no data loss, but files change on disk.
func WorkspaceUpdateStale() CommandArgs {
	return []string{"workspace", "update-stale"}
}

// WorkspaceList returns args for `jj workspace list` with a template.
// WorkspaceRef.name() + .target() (Commit) — structured output, no parsing
// of "default: skpssuxl a14ce848 desc" human format (which broke on
// workspace names containing ": ").
//
// target.current_working_copy() is "is this workspace's target commit MY @?"
// — NOT "is this the current workspace". Two workspaces pointing at the same
// commit both report true (observed: user opened default workspace, selector
// showed a secondary workspace because both were on the same commit and the
// secondary sorted last). handleWorkspaces breaks ties via path-match
// against RepoDir. Path-matching was the ORIGINAL approach but broke in SSH
// mode where --remote path isn't canonical; the hybrid keeps ws.Current as
// primary signal (works in SSH) and only path-matches on collision.
//
// withRoot appends self.root() (jj ≥ 0.40) so paths come from jj directly
// instead of the protobuf workspace_store parser. The fallback stays for
// older jj — handleWorkspaces picks via s.jjSupports(WorkspaceRootTmpl).
func WorkspaceList(withRoot bool) CommandArgs {
	tmpl := `name ++ "\x1F" ++ target.change_id().short() ++ "\x1F" ++ target.commit_id().short() ++ "\x1F" ++ stringify(target.current_working_copy())`
	if withRoot {
		tmpl += ` ++ "\x1F" ++ self.root()`
	}
	tmpl += ` ++ "\n"`
	return []string{"workspace", "list", "--color", "never", "--ignore-working-copy", "-T", tmpl}
}

// Workspace represents a jj workspace entry.
type Workspace struct {
	Name     string `json:"name"`
	ChangeId string `json:"change_id"`
	CommitId string `json:"commit_id"`
	Current  bool   `json:"current"`
	// Path is absolute root from self.root() (jj ≥ 0.40, withRoot=true).
	// Empty on older jj — handleWorkspaces backfills from workspace_store.
	Path string `json:"path,omitempty"`
}

// ParseWorkspaceList parses WorkspaceList template output.
// Each line: name\x1Fchange_id\x1Fcommit_id\x1Fcurrent[\x1Fpath]
// 5th field present only when withRoot=true.
func ParseWorkspaceList(output string) []Workspace {
	workspaces := []Workspace{}
	for line := range strings.SplitSeq(strings.TrimSpace(output), "\n") {
		parts := strings.SplitN(line, "\x1F", 5)
		if len(parts) < 4 {
			continue
		}
		ws := Workspace{
			Name: parts[0], ChangeId: parts[1], CommitId: parts[2], Current: parts[3] == "true",
		}
		if len(parts) == 5 {
			ws.Path = parts[4]
		}
		workspaces = append(workspaces, ws)
	}
	return workspaces
}
