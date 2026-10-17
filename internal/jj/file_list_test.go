package jj

import (
	"testing"

	"github.com/stretchr/testify/assert"
)

func TestFileListJSON(t *testing.T) {
	args := FileListJSON("commit_id(abc123def456)")
	assert.Equal(t, []string{"file", "list", "-r", "commit_id(abc123def456)", "--ignore-working-copy", "--color", "never", "-T"}, args[:8])
	tmpl := args[8]
	// Named fields, each json()-wrapped; repo-relative `path`, never the
	// cwd-relative format_path(); no whole-object serialization.
	assert.Contains(t, tmpl, `json(path)`)
	assert.Contains(t, tmpl, `json(file_type)`)
	assert.Contains(t, tmpl, `if(executable, "true", "false")`)
	assert.NotContains(t, tmpl, "format_path")
	assert.NotContains(t, tmpl, "json(self)")
}

func TestFileList(t *testing.T) {
	assert.Equal(t,
		[]string{"file", "list", "-r", "abc", "--ignore-working-copy", "--color", "never", "-T", `path ++ "\n"`},
		FileList("abc"))
}

func TestResolveCommitId(t *testing.T) {
	args := ResolveCommitId("@")
	assert.Equal(t, []string{"log", "-r", "@", "--no-graph", "--ignore-working-copy", "--color", "never", "-T", `commit_id ++ "\n"`}, args)
}

func TestParseFileListJSON(t *testing.T) {
	// As jj 0.45 emits it. Odd-but-legal names: spaces, unicode, embedded
	// quote, leading dash, a NEWLINE (only the JSON path can frame it), and
	// a trailing space.
	out := `{"path":"README.md","type":"file","executable":false}` + "\n" +
		`{"path":"bin/run.sh","type":"file","executable":true}` + "\n" +
		`{"path":"dir with spaces/naïve 文件.txt","type":"file","executable":false}` + "\n" +
		`{"path":"q/\"quoted\".go","type":"file","executable":false}` + "\n" +
		`{"path":"-rf","type":"file","executable":false}` + "\n" +
		`{"path":"weird/new\nline","type":"file","executable":false}` + "\n" +
		`{"path":"trailing ","type":"symlink","executable":false}` + "\n" +
		`{"path":"vendor/sub","type":"git-submodule","executable":false}` + "\n" +
		`{"path":"c.txt","type":"conflict","executable":false}` + "\n"
	files := ParseFileListJSON(out)
	assert.Equal(t, []TreeFile{
		{Path: "README.md", Type: "file"},
		{Path: "bin/run.sh", Type: "file", Executable: true},
		{Path: "dir with spaces/naïve 文件.txt", Type: "file"},
		{Path: `q/"quoted".go`, Type: "file"},
		{Path: "-rf", Type: "file"},
		{Path: "weird/new\nline", Type: "file"},
		{Path: "trailing ", Type: "symlink"},
		{Path: "vendor/sub", Type: "git-submodule"},
		{Path: "c.txt", Type: "conflict"},
	}, files)
}

func TestParseFileListJSON_EmptyAndGarbage(t *testing.T) {
	assert.NotNil(t, ParseFileListJSON(""))
	assert.Empty(t, ParseFileListJSON(""))
	// Garbage / path-less lines skipped; missing type defaults to "file".
	files := ParseFileListJSON("not json\n{}\n{\"path\":\"a\"}\n")
	assert.Equal(t, []TreeFile{{Path: "a", Type: "file"}}, files)
}

func TestParseFileList(t *testing.T) {
	assert.NotNil(t, ParseFileList(""))
	assert.Empty(t, ParseFileList(""))
	files := ParseFileList("a.go\n dir/lead space\n-rf\nnaïve 文件\ntrail \n")
	assert.Equal(t, []TreeFile{
		{Path: "a.go", Type: "file"},
		{Path: " dir/lead space", Type: "file"}, // verbatim — no TrimSpace
		{Path: "-rf", Type: "file"},
		{Path: "naïve 文件", Type: "file"},
		{Path: "trail ", Type: "file"},
	}, files)
}
