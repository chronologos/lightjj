package runner

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// These tests use sh as the binary to exercise exit-code handling without
// requiring jj on the test host. LocalRunner's error formatting is agnostic
// to which binary produced the error.

func shRunner() *LocalRunner {
	return &LocalRunner{Binary: "sh", RepoDir: ""}
}

func TestLocalRunner_Run_Success(t *testing.T) {
	r := shRunner()
	out, err := r.Run(context.Background(), []string{"-c", "echo hello"})
	require.NoError(t, err)
	assert.Equal(t, "hello", string(out))
}

func TestLocalRunner_Run_GrandchildHoldsPipe_WaitDelaySwallowed(t *testing.T) {
	if testing.Short() {
		t.Skip("3s WaitDelay wall time")
	}
	// sh exits 0 immediately; backgrounded sleep inherits stdout fd → Wait()
	// hangs on pipe drain. WaitDelay force-closes after 3s → ErrWaitDelay.
	// This is the SSH ControlMaster scenario: mux master inherits pipe fds
	// after ssh client exits. Without the errors.Is(ErrWaitDelay) normalization
	// in runSeparate, valid output is discarded with a spurious error.
	r := shRunner()
	start := time.Now()
	out, err := r.Run(context.Background(), []string{"-c", "echo ok; sleep 30 &"})
	require.NoError(t, err)
	assert.Equal(t, "ok", string(out))
	// Bounded by WaitDelay (~3s), not sleep 30.
	assert.Less(t, time.Since(start), 5*time.Second)
}

func TestLocalRunner_Run_SuccessWithStderrOnly(t *testing.T) {
	// jj mutations (new, abandon, rebase, etc) write confirmation to stderr
	// with empty stdout. `jj git push` with no tracked bookmarks writes the
	// "Nothing changed" warning to stderr and exits 0. Without returning
	// stderr on the empty-stdout path, all mutation output was silently lost.
	r := shRunner()
	out, err := r.Run(context.Background(), []string{"-c", "echo 'Working copy now at: xyz' >&2"})
	require.NoError(t, err)
	assert.Equal(t, "Working copy now at: xyz", string(out))
}

func TestLocalRunner_Run_SuccessStdoutWinsOverStderr(t *testing.T) {
	// Read commands (diff, log) may emit progress to stderr while producing
	// their real output on stdout. Stdout must always win when non-empty.
	r := shRunner()
	out, err := r.Run(context.Background(), []string{"-c", "echo 'progress...' >&2; echo 'diff output'"})
	require.NoError(t, err)
	assert.Equal(t, "diff output", string(out))
}

func TestLocalRunner_Run_ExitWithStderr(t *testing.T) {
	r := shRunner()
	_, err := r.Run(context.Background(), []string{"-c", "echo boom >&2; exit 3"})
	require.Error(t, err)
	assert.Contains(t, err.Error(), "exit code 3")
	assert.Contains(t, err.Error(), "boom")
}

func TestLocalRunner_Run_ExitWithStdoutOnly(t *testing.T) {
	// Some jj errors print to stdout instead of stderr (e.g., parse errors
	// in some versions). The fallback should surface stdout when stderr is empty.
	r := shRunner()
	_, err := r.Run(context.Background(), []string{"-c", "echo problem; exit 2"})
	require.Error(t, err)
	assert.Contains(t, err.Error(), "exit code 2")
	assert.Contains(t, err.Error(), "problem")
}

func TestLocalRunner_Run_ExitSilent(t *testing.T) {
	// Triple-empty: no stderr, no stdout. Error must include args so the
	// user knows which command failed.
	r := shRunner()
	_, err := r.Run(context.Background(), []string{"-c", "exit 5"})
	require.Error(t, err)
	assert.Contains(t, err.Error(), "exit code 5")
	assert.Contains(t, err.Error(), "sh -c exit 5")
	assert.Contains(t, err.Error(), "no output")
}

func TestLocalRunner_Run_BinaryNotFound(t *testing.T) {
	// Non-ExitError path (ENOENT). Original error must be preserved.
	r := &LocalRunner{Binary: "definitely-not-a-real-binary-name-xyz"}
	_, err := r.Run(context.Background(), []string{"arg"})
	require.Error(t, err)
	// Don't assert exact message (OS-specific), just that it's not our formatted error
	assert.NotContains(t, err.Error(), "exit code")
}

func TestLocalRunner_RunWithInput_StdinPassed(t *testing.T) {
	r := shRunner()
	out, err := r.RunWithInput(context.Background(), []string{"-c", "cat"}, "piped input")
	require.NoError(t, err)
	assert.Equal(t, "piped input", string(out))
}

func TestLocalRunner_RunWithInput_SharesErrorHandling(t *testing.T) {
	// RunWithInput delegates to the same run() helper — verify it gets
	// the same error formatting.
	r := shRunner()
	_, err := r.RunWithInput(context.Background(), []string{"-c", "echo err >&2; exit 1"}, "")
	require.Error(t, err)
	assert.Contains(t, err.Error(), "exit code 1: err")
}

func TestLocalRunner_RunRaw(t *testing.T) {
	// RunRaw execs argv[0] directly (not "jj"), with the same error
	// formatting as Run. Use a shRunner whose Binary is "sh" — RunRaw
	// must ignore that and use argv[0] instead.
	r := shRunner()
	out, err := r.RunRaw(context.Background(), []string{"printf", "raw"})
	require.NoError(t, err)
	assert.Equal(t, "raw", string(out))
}

func TestLocalRunner_RunRaw_PreservesErrorFormatting(t *testing.T) {
	r := shRunner()
	_, err := r.RunRaw(context.Background(), []string{"sh", "-c", "echo nope >&2; exit 4"})
	require.Error(t, err)
	assert.Contains(t, err.Error(), "exit code 4: nope")
}

func TestLocalRunner_RunRaw_HonorsRepoDir(t *testing.T) {
	// gh infers owner/repo from cwd. If RunRaw doesn't propagate RepoDir
	// to cmd.Dir, gh runs wherever lightjj was started and returns PRs
	// for the wrong repo (or none).
	dir := t.TempDir()
	want, _ := filepath.EvalSymlinks(dir) // darwin: /var → /private/var
	r := &LocalRunner{Binary: "jj", RepoDir: dir}
	out, err := r.RunRaw(context.Background(), []string{"pwd", "-P"})
	require.NoError(t, err)
	assert.Equal(t, want, string(out))
}

func TestLocalRunner_Run_TrimsTrailingNewlines(t *testing.T) {
	r := shRunner()
	out, err := r.Run(context.Background(), []string{"-c", "printf 'line\n\n\n'"})
	require.NoError(t, err)
	assert.Equal(t, "line", string(out))
	assert.False(t, strings.HasSuffix(string(out), "\n"))
}

func TestLocalRunner_ReadBytes_PreservesTrailingNewline(t *testing.T) {
	// Contrast with Run_TrimsTrailingNewlines above — this is the point.
	// `jj file show` output is the file's byte content; trimming it corrupts
	// the merge-editor round trip (saved file loses its final \n).
	r := shRunner()
	out, err := r.ReadBytes(context.Background(), []string{"-c", "printf 'line1\nline2\n'"})
	require.NoError(t, err)
	assert.Equal(t, "line1\nline2\n", string(out))
}

func TestLocalRunner_ReadBytes_PreservesCRLF(t *testing.T) {
	// CRLF file ending through Run() would strip only the \n, leaving a lone
	// \r — which CM6 normalizes to \n (phantom line) while JS split('\n')
	// doesn't. ReadBytes must not touch it.
	r := shRunner()
	out, err := r.ReadBytes(context.Background(), []string{"-c", "printf 'line\r\n'"})
	require.NoError(t, err)
	assert.Equal(t, "line\r\n", string(out))
}

func TestLocalRunner_ReadBytes_ExitWithStderr(t *testing.T) {
	r := shRunner()
	_, err := r.ReadBytes(context.Background(), []string{"-c", "echo oops >&2; exit 1"})
	require.Error(t, err)
	assert.Contains(t, err.Error(), "exit code 1")
	assert.Contains(t, err.Error(), "oops")
}

// WriteFile symlink-escape tests — moved from handler tests when the check
// migrated from handleFileWrite to LocalRunner.WriteFile (SSH-mode file-write
// support). The handler does lexical validation; the runner owns filesystem
// reality checks.

func TestLocalRunner_WriteFile_Success(t *testing.T) {
	dir := t.TempDir()
	r := &LocalRunner{RepoDir: dir}

	err := r.WriteFile(context.Background(), "hello.txt", []byte("content"))
	require.NoError(t, err)

	got, err := os.ReadFile(filepath.Join(dir, "hello.txt"))
	require.NoError(t, err)
	assert.Equal(t, "content", string(got))
}

func TestLocalRunner_WriteFile_ParentSymlinkEscape(t *testing.T) {
	// A tracked symlink inside the repo (`escape/ -> /tmp/outside`) passes
	// lexical checks (path is `escape/evil.txt` — relative, no `..`) but
	// resolves outside the repo tree. EvalSymlinks on the parent catches it.
	dir := t.TempDir()
	outside := t.TempDir()
	require.NoError(t, os.Symlink(outside, filepath.Join(dir, "escape")))
	r := &LocalRunner{RepoDir: dir}

	err := r.WriteFile(context.Background(), "escape/evil.txt", []byte("pwned"))
	require.Error(t, err)
	assert.Contains(t, err.Error(), "escapes repository")

	_, statErr := os.Stat(filepath.Join(outside, "evil.txt"))
	assert.True(t, os.IsNotExist(statErr), "file should not have been written outside repo")
}

func TestLocalRunner_WriteFile_LeafSymlinkEscape(t *testing.T) {
	// A symlink AT the target file level (`link.txt -> /tmp/stolen`) passes
	// the parent check (parent IS the repo) but would follow the link to an
	// arbitrary path. Lstat on the target catches it.
	dir := t.TempDir()
	stolen := filepath.Join(t.TempDir(), "stolen.txt")
	require.NoError(t, os.Symlink(stolen, filepath.Join(dir, "link.txt")))
	r := &LocalRunner{RepoDir: dir}

	err := r.WriteFile(context.Background(), "link.txt", []byte("pwned"))
	require.Error(t, err)
	assert.Contains(t, err.Error(), "symlink")

	_, statErr := os.Stat(stolen)
	assert.True(t, os.IsNotExist(statErr), "file should not have been written via symlink")
}

func TestLocalRunner_WriteFile_NonexistentParent(t *testing.T) {
	// Unlike os.WriteFile (which would ENOENT), we surface "parent directory
	// does not exist" — EvalSymlinks fails on missing paths. Handler
	// translates this to 500, not 400; jj's tracked files always have
	// existing parents so this is a "shouldn't happen" guard.
	dir := t.TempDir()
	r := &LocalRunner{RepoDir: dir}

	err := r.WriteFile(context.Background(), "does/not/exist.txt", []byte("x"))
	require.Error(t, err)
	assert.Contains(t, err.Error(), "parent directory does not exist")
}
