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
	tests := []struct {
		name    string
		tmpl    []string
		absPath string
		line    *int
		want    []string
		wantErr string
	}{
		{
			name:    "placeholders substituted",
			tmpl:    []string{sh, "--goto", "{file}:{line}"},
			absPath: "/a b/c.go",
			line:    ptr(42),
			want:    []string{sh, "--goto", "/a b/c.go:42"},
		},
		{
			name:    "no {file} appends path",
			tmpl:    []string{sh},
			absPath: "/x.go",
			line:    nil,
			want:    []string{sh, "/x.go"},
		},
		{
			name:    "nil line substitutes 1",
			tmpl:    []string{sh, "-n", "+{line}", "{file}"},
			absPath: "/x.go",
			line:    nil,
			want:    []string{sh, "-n", "+1", "/x.go"},
		},
		{
			name:    "empty template rejected",
			tmpl:    []string{},
			absPath: "/x.go",
			wantErr: "no editor configured",
		},
		{
			name:    "relative argv0 rejected",
			tmpl:    []string{"./foo", "{file}"},
			absPath: "/x.go",
			wantErr: "absolute path or bare command",
		},
		{
			name:    "parent-relative argv0 rejected",
			tmpl:    []string{"../foo", "{file}"},
			absPath: "/x.go",
			wantErr: "absolute path or bare command",
		},
		{
			name:    "forward-slash relative argv0 rejected (Windows)",
			tmpl:    []string{"subdir/foo", "{file}"},
			absPath: "/x.go",
			wantErr: "absolute path or bare command",
		},
		{
			name:    "placeholder in argv0 rejected",
			tmpl:    []string{"{file}"},
			absPath: "/repo/evil.sh",
			wantErr: "cannot contain placeholders",
		},
		{
			name:    "path containing {line} not double-substituted",
			tmpl:    []string{sh, "{file}"},
			absPath: "/repo/src/{line}.go",
			line:    ptr(42),
			want:    []string{sh, "/repo/src/{line}.go"},
		},
		{
			name:    "missing binary on PATH rejected",
			tmpl:    []string{"lightjj-definitely-not-a-real-binary-xyz", "{file}"},
			absPath: "/x.go",
			wantErr: "not found on PATH",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, err := buildEditorArgv(tt.tmpl, tt.absPath, tt.line)
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

	got, err := buildEditorArgv([]string{bin, "{file}"}, "/x.go", nil)
	require.NoError(t, err)
	assert.Equal(t, []string{bin, "/x.go"}, got)

	// Missing absolute binary rejected
	_, err = buildEditorArgv([]string{filepath.Join(dir, "missing"), "{file}"}, "/x.go", nil)
	require.Error(t, err)
	assert.Contains(t, err.Error(), "not found")
}

func TestHandleOpenFile_SSHMode(t *testing.T) {
	runner := testutil.NewMockRunner(t)
	defer runner.Verify()
	srv := NewServer(runner, "") // RepoDir="" → SSH mode

	w := httptest.NewRecorder()
	srv.Mux.ServeHTTP(w, jsonPost("/api/open-file", []byte(`{"path":"a.go"}`)))
	assert.Equal(t, 501, w.Code)
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

func TestReadConfigEditorArgs(t *testing.T) {
	path := withConfigDir(t)
	require.NoError(t, os.MkdirAll(filepath.Dir(path), 0o755))
	require.NoError(t, os.WriteFile(path, []byte(`{"editorArgs":["code","--goto","{file}:{line}"],"theme":"dark"}`), 0o644))

	got, err := readConfigEditorArgs()
	require.NoError(t, err)
	assert.Equal(t, []string{"code", "--goto", "{file}:{line}"}, got)
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
