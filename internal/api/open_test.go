package api

import (
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"testing"

	"github.com/chronologos/lightjj/testutil"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func ptr(n int) *int { return &n }

// sh is a binary guaranteed present on PATH for the argv[0] LookPath check.
// Windows uses cmd instead.
func shellBin() string {
	if runtime.GOOS == "windows" {
		return "cmd"
	}
	return "sh"
}

func TestBuildEditorArgv(t *testing.T) {
	sh := shellBin()
	fileSub := func(f string, l *int) editorSubst { return editorSubst{File: f, Line: l} }
	tests := []struct {
		name    string
		tmpl    []string
		sub     editorSubst
		want    []string
		wantErr string
	}{
		{
			name: "placeholders substituted",
			tmpl: []string{sh, "--goto", "{file}:{line}"},
			sub:  fileSub("/a b/c.go", ptr(42)),
			want: []string{sh, "--goto", "/a b/c.go:42"},
		},
		{
			name: "no path placeholder appends {file}",
			tmpl: []string{sh},
			sub:  fileSub("/x.go", nil),
			want: []string{sh, "/x.go"},
		},
		{
			name: "nil line substitutes 1",
			tmpl: []string{sh, "-n", "+{line}", "{file}"},
			sub:  fileSub("/x.go", nil),
			want: []string{sh, "-n", "+1", "/x.go"},
		},
		{
			name: "{relpath} counts as path placeholder (no auto-append)",
			tmpl: []string{sh, "{relpath}"},
			sub:  editorSubst{File: "/repo/x.go", RelPath: "x.go"},
			want: []string{sh, "x.go"},
		},
		{
			name: "{host}+{file} for SSH-URI editors",
			tmpl: []string{sh, "zed://ssh/{host}{file}"},
			sub:  editorSubst{File: "/home/u/repo/x.go", Host: "u@devbox"},
			want: []string{sh, "zed://ssh/u@devbox/home/u/repo/x.go"},
		},
		{
			name:    "empty template rejected",
			tmpl:    []string{},
			sub:     fileSub("/x.go", nil),
			wantErr: "no editor configured",
		},
		{
			name:    "relative argv0 rejected",
			tmpl:    []string{"./foo", "{file}"},
			sub:     fileSub("/x.go", nil),
			wantErr: "absolute path or bare command",
		},
		{
			name:    "parent-relative argv0 rejected",
			tmpl:    []string{"../foo", "{file}"},
			sub:     fileSub("/x.go", nil),
			wantErr: "absolute path or bare command",
		},
		{
			name:    "forward-slash relative argv0 rejected (Windows)",
			tmpl:    []string{"subdir/foo", "{file}"},
			sub:     fileSub("/x.go", nil),
			wantErr: "absolute path or bare command",
		},
		{
			name:    "placeholder in argv0 rejected",
			tmpl:    []string{"{file}"},
			sub:     fileSub("/repo/evil.sh", nil),
			wantErr: "cannot contain placeholders",
		},
		{
			name:    "{relpath} in argv0 rejected",
			tmpl:    []string{"{relpath}"},
			sub:     editorSubst{RelPath: "evil.sh"},
			wantErr: "cannot contain placeholders",
		},
		{
			name: "path containing {line} not double-substituted",
			tmpl: []string{sh, "{file}"},
			sub:  fileSub("/repo/src/{line}.go", ptr(42)),
			want: []string{sh, "/repo/src/{line}.go"},
		},
		{
			name: "path containing {host} not double-substituted",
			tmpl: []string{sh, "{file}"},
			sub:  editorSubst{File: "/repo/{host}/x.go", Host: "devbox"},
			want: []string{sh, "/repo/{host}/x.go"},
		},
		{
			name:    "missing binary on PATH rejected",
			tmpl:    []string{"lightjj-definitely-not-a-real-binary-xyz", "{file}"},
			sub:     fileSub("/x.go", nil),
			wantErr: "not found on PATH",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, err := buildEditorArgv(tt.tmpl, tt.sub)
			if tt.wantErr != "" {
				require.Error(t, err)
				assert.Contains(t, err.Error(), tt.wantErr)
				return
			}
			require.NoError(t, err)
			assert.Equal(t, tt.want, got)
		})
	}
}

func TestBuildEditorArgv_AbsoluteBinary(t *testing.T) {
	// Use a temp file as an "editor" to test absolute-path validation.
	dir := t.TempDir()
	bin := filepath.Join(dir, "fake-editor")
	require.NoError(t, os.WriteFile(bin, []byte("#!/bin/sh\n"), 0o755))

	got, err := buildEditorArgv([]string{bin, "{file}"}, editorSubst{File: "/x.go"})
	require.NoError(t, err)
	assert.Equal(t, []string{bin, "/x.go"}, got)

	// Missing absolute binary rejected
	_, err = buildEditorArgv([]string{filepath.Join(dir, "missing"), "{file}"}, editorSubst{File: "/x.go"})
	require.Error(t, err)
	assert.Contains(t, err.Error(), "not found")
}

func TestEditorTemplate_ModeSelection(t *testing.T) {
	path := withConfigDir(t)
	require.NoError(t, os.MkdirAll(filepath.Dir(path), 0o755))
	require.NoError(t, os.WriteFile(path, []byte(`{
		"editorArgs": ["code", "--goto", "{file}:{line}"],
		"editorArgsRemote": ["zed", "zed://ssh/{host}{file}:{line}"]
	}`), 0o644))

	// Local mode: RepoDir set → editorArgs, {file} = filepath.Join
	{
		srv := NewServer(testutil.NewMockRunner(t), "/repo")
		tmpl, sub, err := srv.editorTemplate("src/x.go", ptr(7))
		require.NoError(t, err)
		assert.Equal(t, []string{"code", "--goto", "{file}:{line}"}, tmpl)
		assert.Equal(t, filepath.Join("/repo", "src/x.go"), sub.File)
		assert.Equal(t, "src/x.go", sub.RelPath)
		assert.Empty(t, sub.Host)
	}

	// --remote mode: RepoDir="" → editorArgsRemote, {file} = POSIX join of RepoPath
	{
		srv := NewServer(testutil.NewMockRunner(t), "")
		srv.RepoPath = "/home/u/repo"
		srv.SSHHost = "u@devbox"
		// Input uses filepath separator (what validateRepoRelativePath returns);
		// output must be POSIX regardless of host OS.
		tmpl, sub, err := srv.editorTemplate(filepath.Join("src", "x.go"), nil)
		require.NoError(t, err)
		assert.Equal(t, []string{"zed", "zed://ssh/{host}{file}:{line}"}, tmpl)
		assert.Equal(t, "/home/u/repo/src/x.go", sub.File) // POSIX, not filepath
		assert.Equal(t, "src/x.go", sub.RelPath)           // POSIX (ToSlash)
		assert.Equal(t, "u@devbox", sub.Host)
	}
}

func TestHandleOpenFile_PathValidation(t *testing.T) {
	runner := testutil.NewMockRunner(t)
	defer runner.Verify()
	srv := NewServer(runner, t.TempDir())

	cases := []struct{ body, wantErr string }{
		{`{"path":""}`, "path is required"},
		{`{"path":"/etc/passwd"}`, "absolute"},
		{`{"path":"../escape"}`, "traversal"},
		{`{"path":".jj/repo/op_heads/heads/x"}`, "internal"},
	}
	for _, c := range cases {
		w := httptest.NewRecorder()
		srv.Mux.ServeHTTP(w, jsonPost("/api/open-file", []byte(c.body)))
		assert.Equal(t, 400, w.Code, c.body)
		assert.Contains(t, w.Body.String(), c.wantErr, c.body)
	}
}

func TestHandleOpenFile_NoEditorConfigured(t *testing.T) {
	withConfigDir(t) // empty config dir → no editorArgs
	runner := testutil.NewMockRunner(t)
	defer runner.Verify()
	srv := NewServer(runner, t.TempDir())

	w := httptest.NewRecorder()
	srv.Mux.ServeHTTP(w, jsonPost("/api/open-file", []byte(`{"path":"a.go"}`)))
	assert.Equal(t, 400, w.Code)
	assert.Contains(t, w.Body.String(), "no editor configured")
}

func TestHandleOpenFile_RemoteModeNoConfig(t *testing.T) {
	// --remote mode with no editorArgsRemote → "no editor configured"
	// (not a 501 — the feature is usable if configured).
	withConfigDir(t)
	runner := testutil.NewMockRunner(t)
	defer runner.Verify()
	srv := NewServer(runner, "")

	w := httptest.NewRecorder()
	srv.Mux.ServeHTTP(w, jsonPost("/api/open-file", []byte(`{"path":"a.go"}`)))
	assert.Equal(t, 400, w.Code)
	assert.Contains(t, w.Body.String(), "no editor configured")
}

func TestReadConfigEditor(t *testing.T) {
	path := withConfigDir(t)
	require.NoError(t, os.MkdirAll(filepath.Dir(path), 0o755))
	require.NoError(t, os.WriteFile(path, []byte(`{"editorArgs":["code","--goto","{file}:{line}"],"editorArgsRemote":["zed","{host}{file}"],"theme":"dark"}`), 0o644))

	got, err := readConfigEditor()
	require.NoError(t, err)
	assert.Equal(t, []string{"code", "--goto", "{file}:{line}"}, got.EditorArgs)
	assert.Equal(t, []string{"zed", "{host}{file}"}, got.EditorArgsRemote)
}

func TestValidateRepoRelativePath(t *testing.T) {
	repo := "/repo"
	cases := []struct{ in, wantErr string }{
		{"", "path is required"},
		{"a\x00b", "invalid path"},
		{"/abs", "absolute"},
		{"../x", "traversal"},
		{".jj", "internal"},
		{".jj/x", "internal"},
		{".git/x", "internal"},
	}
	for _, c := range cases {
		_, _, err := validateRepoRelativePath(repo, c.in)
		require.Error(t, err, c.in)
		assert.Contains(t, err.Error(), c.wantErr, c.in)
	}

	// Happy path
	cleaned, abs, err := validateRepoRelativePath(repo, "src/main.go")
	require.NoError(t, err)
	assert.Equal(t, filepath.Join("src", "main.go"), cleaned)
	assert.Equal(t, filepath.Join(repo, "src", "main.go"), abs)
}
