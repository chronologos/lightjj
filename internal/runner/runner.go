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

	// Stream executes a jj command and returns a streaming reader for its stdout.
	Stream(ctx context.Context, args []string) (io.ReadCloser, error)
}
