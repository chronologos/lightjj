package runner

import (
	"context"
	"path/filepath"
	"strings"
	"testing"

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
