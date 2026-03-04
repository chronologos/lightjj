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
	Run(ctx context.Context, args []string) ([]byte, error)

	// RunWithInput executes a jj command with stdin input.
	RunWithInput(ctx context.Context, args []string, stdin string) ([]byte, error)

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
}
