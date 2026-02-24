package runner

import (
	"bytes"
	"context"
	"errors"
	"io"
	"os/exec"
	"strings"
)

// LocalRunner executes jj commands as local subprocesses.
type LocalRunner struct {
	// Binary is the command to execute (default: "jj").
	Binary string
	// RepoDir is the working directory for jj commands.
	// Always resolved to the workspace root so all commands produce
	// repo-root-relative paths (prevents path mismatches when started
	// from a subdirectory).
	RepoDir string
}

func NewLocalRunner(repoDir string) *LocalRunner {
	// Resolve jj workspace root so all commands produce consistent paths.
	cmd := exec.Command("jj", "workspace", "root")
	cmd.Dir = repoDir
	if root, err := cmd.Output(); err == nil {
		repoDir = strings.TrimSpace(string(root))
	}
	return &LocalRunner{Binary: "jj", RepoDir: repoDir}
}

func (r *LocalRunner) Run(ctx context.Context, args []string) ([]byte, error) {
	return r.run(ctx, args, "")
}

func (r *LocalRunner) RunWithInput(ctx context.Context, args []string, stdin string) ([]byte, error) {
	return r.run(ctx, args, stdin)
}

func (r *LocalRunner) run(ctx context.Context, args []string, stdin string) ([]byte, error) {
	cmd := exec.CommandContext(ctx, r.Binary, args...)
	cmd.Dir = r.RepoDir
	if stdin != "" {
		cmd.Stdin = bytes.NewReader([]byte(stdin))
	}
	output, err := cmd.Output()
	if err != nil {
		var exitErr *exec.ExitError
		if errors.As(err, &exitErr) {
			return nil, errors.New(string(exitErr.Stderr))
		}
		return nil, err
	}
	return bytes.TrimRight(output, "\n"), nil
}

func (r *LocalRunner) Stream(ctx context.Context, args []string) (io.ReadCloser, error) {
	cmd := exec.CommandContext(ctx, r.Binary, args...)
	cmd.Dir = r.RepoDir
	pipe, err := cmd.StdoutPipe()
	if err != nil {
		return nil, err
	}
	if err := cmd.Start(); err != nil {
		return nil, err
	}
	return &streamCloser{ReadCloser: pipe, cmd: cmd}, nil
}

type streamCloser struct {
	io.ReadCloser
	cmd *exec.Cmd
}

func (s *streamCloser) Close() error {
	_ = s.ReadCloser.Close()
	return s.cmd.Wait()
}
