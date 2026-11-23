//go:build integration

package jj

import (
	"errors"
	"go/ast"
	"go/parser"
	"go/token"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// Unit tests assert a builder's argv against a copy of itself, and handler tests
// use the builder as its own oracle (runner.Expect(jj.X())), so neither notices
// when jj renames or removes a subcommand or flag. This runs every builder
// against the installed jj. The ids are bogus and most commands fail — all that
// matters is HOW: the argument parser reports lowercase "error: …", jj itself
// "Error: …". (Exit code 2 alone isn't it: `jj resolve` uses 2 for "no conflicts".)
func TestBuilders_AcceptedByInstalledJJ(t *testing.T) {
	one := FromIDs([]string{"@"})
	const op, file = "000000000000", "f.txt"
	describe, _ := SetDescription("@", "msg")

	cases := map[string][]CommandArgs{
		"Version":                {Version()},
		"LogGraph":               {LogGraph("@", 5)},
		"New":                    {New(one)},
		"CommitWorkingCopy":      {CommitWorkingCopy("m")},
		"Edit":                   {Edit("@", true)},
		"Split":                  {Split("@", []string{file}, true)},
		"SplitWithTool":          {SplitWithTool("@", os.DevNull, "m")},
		"SetDescription":         {describe},
		"GetDescription":         {GetDescription("@")},
		"MetaeditUpdateChangeId": {MetaeditUpdateChangeId("@")},
		"Abandon":                {Abandon(one, true)},
		"Diff":                   {Diff("@", file, "never")},
		"Restore":                {Restore("@", []string{file})},
		"Undo":                   {Undo()},
		"OpRevert":               {OpRevert(op)},
		"OpRestore":              {OpRestore(op)},
		"OpShow":                 {OpShow(op)},
		"RestoreFromTo":          {RestoreFromTo("@", "@")},
		"BookmarkSet":            {BookmarkSet("@", "b")},
		"BookmarkSetToRemote":    {BookmarkSetToRemote("b", "origin")},
		"BookmarkMove":           {BookmarkMove("@", "b")},
		"BookmarkAdvance":        {BookmarkAdvance("@", "b")},
		"BookmarkDelete":         {BookmarkDelete("b")},
		"BookmarkForget":         {BookmarkForget("b")},
		"BookmarkTrack":          {BookmarkTrack("b", "origin")},
		"BookmarkUntrack":        {BookmarkUntrack("b", "origin")},
		"Squash":                 {Squash(one, "@-", []string{file}, true, true, "m"), Squash(one, "@-", nil, false, false, "")},
		"DiffRange":              {DiffRange("@-", "@", []string{file})},
		"BookmarkList":           {BookmarkList("@")},
		"BookmarkListAll":        {BookmarkListAll()},
		"GitFetch":               {GitFetch("--all-remotes")},
		"GitPush":                {GitPush("--dry-run")},
		"GitRemoteList":          {GitRemoteList()},
		"Rebase": {
			Rebase(one, []string{"@-"}, "-r", "-d", RebaseOptions{}),
			Rebase(one, []string{"@-"}, "-s", "--insert-after", RebaseOptions{SkipEmptied: true, IgnoreImmutable: true, SimplifyParents: true}),
			Rebase(one, []string{"@-"}, "-b", "-d", RebaseOptions{}),
		},
		"Evolog":                 {Evolog("@")},
		"CurrentOpId":            {CurrentOpId()},
		"PollOpId":               {PollOpId()},
		"DebugSnapshot":          {DebugSnapshot()},
		"OpLog":                  {OpLog(5)},
		"ConfigListAliases":      {ConfigListAliases()},
		"ConfigGet":              {ConfigGet("ui.color")},
		"FileShow":               {FileShow("@", file, true)},
		"ResolveApply":           {ResolveApply("@", os.DevNull, os.DevNull, file)},
		"Resolve":                {Resolve("@", file, ":ours")},
		"FileLog":                {FileLog(file, 5, false), FileLog(file, 5, true)},
		"IndexChangedPaths":      {IndexChangedPaths()},
		"ConflictList":           {ConflictList("")},
		"WorkspaceAdd":           {WorkspaceAdd("ws", "ws", "@")},
		"WorkspaceForget":        {WorkspaceForget("nope")},
		"WorkspaceRename":        {WorkspaceRename("renamed")},
		"WorkspaceUpdateStale":   {WorkspaceUpdateStale()},
		"WorkspaceUpdateStaleAt": {WorkspaceUpdateStaleAt("/nonexistent")},
		"WorkspaceList":          {WorkspaceList()},
		"Divergence":             {Divergence()},
		"StaleImmutable":         {StaleImmutable()},
		"FilesTemplate":          {FilesTemplate("@")},
		"RevisionMeta":           {RevisionMeta("@")},
		"FileList":               {FileList("@")},
		"ResolveCommitId":        {ResolveCommitId("@")},
		"Identity":               {Identity("@")},
		"SnapshotIdentity":       {SnapshotIdentity("@")},
	}

	for _, name := range builderNames(t) {
		assert.Contains(t, cases, name, "new builder: add it to this table")
	}

	env := append(os.Environ(), "JJ_CONFIG=", "NO_COLOR=1", "JJ_USER=Test", "JJ_EMAIL=test@test")
	for name, argvs := range cases {
		t.Run(name, func(t *testing.T) {
			dir := t.TempDir() // per builder: several of these mutate
			run := func(args ...string) (string, error) {
				cmd := exec.Command("jj", args...)
				cmd.Dir, cmd.Env = dir, env
				out, err := cmd.CombinedOutput()
				return string(out), err
			}
			out, err := run("git", "init")
			require.NoError(t, err, out)
			for _, argv := range argvs {
				out, err := run(argv...)
				var exit *exec.ExitError
				if errors.As(err, &exit) {
					for line := range strings.Lines(out) {
						assert.False(t, strings.HasPrefix(line, "error:"), "jj rejected %q:\n%s", strings.Join(argv, " "), out)
					}
				} else {
					require.NoError(t, err)
				}
				// Revset and template errors exit 1, but mean the same thing here.
				assert.NotContains(t, out, "Failed to parse")
			}
		})
	}
}

// builderNames lists the package's exported functions whose first result is
// CommandArgs, so a new builder can't be forgotten above.
func builderNames(t *testing.T) []string {
	t.Helper()
	files, err := filepath.Glob("*.go")
	require.NoError(t, err)
	var names []string
	for _, f := range files {
		if strings.HasSuffix(f, "_test.go") {
			continue
		}
		parsed, err := parser.ParseFile(token.NewFileSet(), f, nil, 0)
		require.NoError(t, err)
		for _, d := range parsed.Decls {
			fn, ok := d.(*ast.FuncDecl)
			if !ok || fn.Recv != nil || !fn.Name.IsExported() || fn.Type.Results == nil {
				continue
			}
			if id, ok := fn.Type.Results.List[0].Type.(*ast.Ident); ok && id.Name == "CommandArgs" {
				names = append(names, fn.Name.Name)
			}
		}
	}
	require.NotEmpty(t, names)
	return names
}
