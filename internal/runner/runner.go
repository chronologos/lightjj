// Package runner defines the CommandRunner interface for executing jj commands.
// Production code uses LocalRunner (or SSHRunner for remote repos).
// Tests use testutil.MockRunner.
package runner

import (
	"context"
	"io"
)

// CommandRunner abstracts jj command execution.
// This is the key seam between the web API layer and the jj CLI.
type CommandRunner interface {
	// Run executes a jj command synchronously and returns its output.
	// Trailing newlines are stripped — output is display-oriented text.
	// For byte-exact content (file bodies), use ReadBytes.
	Run(ctx context.Context, args []string) ([]byte, error)

	// ReadBytes executes a jj command and returns stdout byte-exact, no
	// trailing-newline stripping. Use for `jj file show` — file content
	// is data, not display text; a stripped trailing newline breaks the
	// merge-editor round trip (saved file loses its final \n → spurious
	// "\ No newline at end of file" diff).
	ReadBytes(ctx context.Context, args []string) ([]byte, error)

	// RunWithInput executes a jj command with stdin input.
	RunWithInput(ctx context.Context, args []string, stdin string) ([]byte, error)

	// RunForMutation is RunWithInput but returns stdout and stderr separately.
	// Only server.runMutation uses this — `jj rebase` prints rebased commits
	// to stdout AND "Warning: conflicts created" to stderr on exit-0. Run()
	// drops stderr when stdout is non-empty; mutations need both.
	RunForMutation(ctx context.Context, args []string, stdin string) (stdout, stderr []byte, err error)

	// StreamCombined executes a jj command and returns a streaming reader for
	// combined stdout+stderr. `jj git push`/`fetch` write all progress to
	// stderr (stdout is empty). Close() returns the process exit error and
	// is idempotent — safe to defer alongside an explicit close.
	StreamCombined(ctx context.Context, args []string) (io.ReadCloser, error)

	// RunRaw executes an arbitrary command (argv[0] is the binary) in the
	// repo's working directory. Unlike Run, this does NOT prepend "jj".
	// Used for sidecar tooling (gh) that must run where the repo lives —
	// in SSH mode that means on the remote host.
	RunRaw(ctx context.Context, argv []string) ([]byte, error)

	// WriteFile writes content to relPath under the repo root. relPath is
	// ASSUMED lexically-validated (the handler does `..`/`.jj`/absolute
	// checks). Local does symlink-escape hardening + os.WriteFile; SSH
	// pipes content via `cd <repo> && cat > <path>` — symlink checks are
	// omitted in SSH mode (same trust boundary as having remote shell).
	WriteFile(ctx context.Context, relPath string, content []byte) error
}
