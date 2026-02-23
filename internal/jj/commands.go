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
	if strings.Contains(fileName, "\\") {
		fileName = strings.ReplaceAll(fileName, "\\", "\\\\")
	}
	if strings.Contains(fileName, "\"") {
		fileName = strings.ReplaceAll(fileName, "\"", "\\\"")
	}
	return fmt.Sprintf("file:\"%s\"", fileName)
}

func escapeFiles(files []string) []string {
	escaped := make([]string, len(files))
	for i, f := range files {
		escaped[i] = EscapeFileName(f)
	}
	return escaped
}

// Log builds args for `jj log`.
// template is the jj template expression for formatting output.
func Log(revset string, limit int, template string) CommandArgs {
	args := []string{"log", "--color", "always", "--quiet"}
	if revset != "" {
		args = append(args, "-r", revset)
	}
	if limit > 0 {
		args = append(args, "--limit", strconv.Itoa(limit))
	}
	if template != "" {
		prefix := fmt.Sprintf(
			"stringify('%s' ++ separate('%s', change_id.shortest(), commit_id.shortest(), divergent))",
			JJUIPrefix, JJUIPrefix)
		template = fmt.Sprintf("%s ++ ' ' ++ %s", prefix, template)
		args = append(args, "-T", template)
	}
	return args
}

// LogJSON builds args for `jj log` with JSON output — preferred for web.
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

func New(revisions SelectedRevisions) CommandArgs {
	args := []string{"new"}
	args = append(args, revisions.AsArgs()...)
	return args
}

func CommitWorkingCopy() CommandArgs {
	return []string{"commit"}
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

func Diff(revision string, fileName string, extraArgs ...string) CommandArgs {
	args := []string{"diff", "-r", revision, "--color", "always", "--ignore-working-copy"}
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

func Status(revision string) CommandArgs {
	template := `separate(";", diff.files().map(|x| x.target().conflict())) ++ " $\n"`
	return []string{"log", "-r", revision, "--summary", "--no-graph", "--color", "never", "--quiet", "--template", template, "--ignore-working-copy"}
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
	if useDestinationMessage {
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

func BookmarkList(revset string) CommandArgs {
	const template = `separate(";", name, if(remote, remote, "."), tracked, conflict, 'false', normal_target.commit_id().shortest(1)) ++ "\n"`
	return []string{"bookmark", "list", "-a", "-r", revset, "--template", template, "--color", "never", "--ignore-working-copy"}
}

func BookmarkListAll() CommandArgs {
	const template = `separate(";", name, if(remote, remote, "."), tracked, conflict, 'false', normal_target.commit_id().shortest(1)) ++ "\n"`
	return []string{"bookmark", "list", "-a", "--template", template, "--color", "never", "--ignore-working-copy"}
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

func Evolog(revision string) CommandArgs {
	return []string{"evolog", "-r", revision, "--color", "always", "--quiet", "--ignore-working-copy"}
}

func OpLog(limit int) CommandArgs {
	args := []string{"op", "log", "--color", "always", "--quiet", "--ignore-working-copy"}
	if limit > 0 {
		args = append(args, "--limit", strconv.Itoa(limit))
	}
	return args
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
