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

// EscapeFileName wraps a filename for safe use in jj file: arguments.
func EscapeFileName(fileName string) string {
	fileName = strings.ReplaceAll(fileName, "\\", "\\\\")
	fileName = strings.ReplaceAll(fileName, "\"", "\\\"")
	return fmt.Sprintf("file:\"%s\"", fileName)
}

func escapeFiles(files []string) []string {
	escaped := make([]string, len(files))
	for i, f := range files {
		escaped[i] = EscapeFileName(f)
	}
	return escaped
}

// LogJSON builds args for `jj log` with flat (no graph) output.
func LogJSON(revset string, limit int) CommandArgs {
	args := []string{"log", "--no-graph", "--color", "never", "--quiet"}
	if revset != "" {
		args = append(args, "-r", revset)
	}
	if limit > 0 {
		args = append(args, "--limit", strconv.Itoa(limit))
	}
	tmpl := `change_id.shortest() ++ "\t" ++ commit_id.shortest() ++ "\t" ++ if(working_copies, "true", "false") ++ "\t" ++ if(hidden, "true", "false") ++ "\t" ++ description.first_line() ++ "\t" ++ bookmarks ++ "\n"`
	args = append(args, "-T", tmpl)
	return args
}

// LogGraph builds args for `jj log` WITH graph topology.
// Output includes graph characters (│, ○, @, ├─╮, etc.) and _PREFIX: markers
// for extracting commit data. The graph characters encode the DAG topology
// which jj computes for us — we just parse it.
func LogGraph(revset string, limit int) CommandArgs {
	args := []string{"log", "--color", "never", "--quiet"}
	if revset != "" {
		args = append(args, "-r", revset)
	}
	if limit > 0 {
		args = append(args, "--limit", strconv.Itoa(limit))
	}
	// Template outputs: _PREFIX:shortestChangeId_PREFIX:shortestCommitId_PREFIX:divergent \x1F fullShortChangeId \x1F fullShortCommitId \x1F description \x1F working_copies \x1F bookmarks
	// Uses ASCII unit separator (\x1F) instead of tab to avoid breakage if descriptions contain tabs.
	// working_copies is inserted before bookmarks since bookmarks use \x1F as internal separator.
	// Bookmarks are joined with \x1F to avoid breakage if bookmark names contain spaces.
	tmpl := fmt.Sprintf(
		`stringify('%s' ++ separate('%s', change_id.shortest(), commit_id.shortest(), divergent)) ++ "\x1F" ++ change_id.short() ++ "\x1F" ++ commit_id.short() ++ "\x1F" ++ description.first_line() ++ "\x1F" ++ working_copies ++ "\x1F" ++ bookmarks.join("\x1F") ++ "\n"`,
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

func DiffEdit(changeId string) CommandArgs {
	return []string{"diffedit", "-r", changeId}
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

func Describe(revisions SelectedRevisions) CommandArgs {
	args := []string{"describe", "--editor"}
	args = append(args, revisions.AsArgs()...)
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

func Restore(revision string, files []string, interactive bool) CommandArgs {
	args := []string{"restore", "-c", revision}
	if interactive {
		args = append(args, "--interactive")
	}
	args = append(args, escapeFiles(files)...)
	return args
}

func Undo() CommandArgs {
	return []string{"undo"}
}

func Redo() CommandArgs {
	return []string{"redo"}
}

func Snapshot() CommandArgs {
	return []string{"debug", "snapshot"}
}

func BookmarkSet(revision string, name string) CommandArgs {
	return []string{"bookmark", "set", "-r", revision, name}
}

func BookmarkMove(revision string, bookmark string, extraFlags ...string) CommandArgs {
	args := []string{"bookmark", "move", bookmark, "--to", revision}
	args = append(args, extraFlags...)
	return args
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

const bookmarkListTemplate = `separate("\x1F", name, if(remote, remote, "."), tracked, conflict, 'false', normal_target.commit_id().shortest(1)) ++ "\n"`

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
	return []string{"git", "remote", "list"}
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

func Duplicate(from SelectedRevisions, to string, target string) CommandArgs {
	args := []string{"duplicate"}
	args = append(args, from.AsPrefixedArgs("-r")...)
	args = append(args, target, to)
	return args
}

func Absorb(changeId string, files ...string) CommandArgs {
	args := []string{"absorb", "--from", changeId, "--color", "never"}
	args = append(args, escapeFiles(files)...)
	return args
}

// DiffSummary builds args for `jj diff --summary` which outputs one line per
// changed file with a status prefix (A/M/D/R).
func DiffSummary(revision string) CommandArgs {
	return []string{"diff", "--summary", "--color", "never", "-r", revision, "--ignore-working-copy"}
}

func Evolog(revision string) CommandArgs {
	return []string{"evolog", "-r", revision, "--no-graph", "--color", "never", "--quiet", "--ignore-working-copy"}
}

// CurrentOpId returns the short ID of the most recent operation.
func CurrentOpId() CommandArgs {
	return []string{"op", "log", "--no-graph", "--color", "never", "--ignore-working-copy",
		"--limit", "1", "-T", `self.id().short()`}
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
	for _, line := range strings.Split(strings.TrimSpace(output), "\n") {
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

func OpRestore(operationId string) CommandArgs {
	return []string{"op", "restore", operationId}
}

func GetParents(revision string) CommandArgs {
	return []string{"log", "-r", revision,
		"--color", "never", "--no-graph", "--quiet", "--ignore-working-copy",
		"--template", "parents.map(|x| x.commit_id().shortest())"}
}

func GetFirstChild(revision *Commit) CommandArgs {
	return []string{"log", "-r", fmt.Sprintf("%s+", revision.CommitId),
		"-n", "1", "--color", "never", "--no-graph", "--quiet", "--ignore-working-copy",
		"--template", "commit_id.shortest()"}
}

func FilesInRevision(revision *Commit) CommandArgs {
	return []string{
		"file", "list", "-r", revision.CommitId,
		"--color", "never", "--no-pager", "--quiet", "--ignore-working-copy",
		"--template", "self.path() ++ \"\n\"",
	}
}

func ConfigListAll() CommandArgs {
	return []string{"config", "list", "--color", "never", "--include-defaults", "--ignore-working-copy"}
}

func ConfigListAliases() CommandArgs {
	return []string{"config", "list", "aliases", "--color", "never", "--ignore-working-copy"}
}

// FileShow returns args for `jj file show` to get a file's content at a revision.
// Uses EscapeFileName for consistency and to prevent dash-prefix flag injection.
func FileShow(revision string, path string) CommandArgs {
	return []string{"file", "show", "-r", revision, EscapeFileName(path)}
}

// ResolveList returns args for `jj resolve --list` to enumerate conflicted files.
func ResolveList(revision string) CommandArgs {
	return []string{"resolve", "--list", "-r", revision, "--color", "never", "--quiet"}
}

// Resolve returns args for `jj resolve` to resolve a conflicted file with a tool.
func Resolve(revision string, file string, tool string) CommandArgs {
	return []string{"resolve", "--tool", tool, "-r", revision, EscapeFileName(file)}
}

// WorkspaceList returns args for `jj workspace list` to enumerate all workspaces.
func WorkspaceList() CommandArgs {
	return []string{"workspace", "list", "--color", "never", "--ignore-working-copy"}
}

// Workspace represents a jj workspace entry.
type Workspace struct {
	Name     string `json:"name"`
	ChangeId string `json:"change_id"`
	CommitId string `json:"commit_id"`
}

// ParseWorkspaceList parses `jj workspace list` output.
// Each line looks like: "default: skpssuxl a14ce848 description text"
func ParseWorkspaceList(output string) []Workspace {
	workspaces := []Workspace{}
	for _, line := range strings.Split(strings.TrimSpace(output), "\n") {
		if line == "" {
			continue
		}
		colonIdx := strings.Index(line, ": ")
		if colonIdx == -1 {
			continue
		}
		fields := strings.Fields(line[colonIdx+2:])
		if len(fields) < 2 {
			continue
		}
		workspaces = append(workspaces, Workspace{
			Name:     line[:colonIdx],
			ChangeId: fields[0],
			CommitId: fields[1],
		})
	}
	return workspaces
}
