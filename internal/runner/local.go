package runner

import (
	"bytes"
	"context"
	"errors"
	"fmt"
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
	// Capture stderr separately so we can surface jj's advisory warnings on
	// exit-0 commands. `jj git push` with no tracked bookmarks prints
	// "Warning: Refusing to create new remote bookmark... Nothing changed."
	// to stderr and exits 0 — without this, the UI shows "Push complete"
	// with empty output and the user never sees why nothing happened.
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	output, err := cmd.Output()
	if err != nil {
		var exitErr *exec.ExitError
		if errors.As(err, &exitErr) {
			stderrStr := strings.TrimSpace(stderr.String())
			if stderrStr != "" {
				return nil, fmt.Errorf("exit code %d: %s", exitErr.ExitCode(), stderrStr)
			}
			// Empty stderr — include stdout (some jj errors print there)
			stdout := strings.TrimSpace(string(output))
			if stdout != "" {
				return nil, fmt.Errorf("exit code %d: %s", exitErr.ExitCode(), stdout)
			}
			// Triple-empty: no stderr, no stdout. Include args so the user
			// at least knows which operation failed silently.
			return nil, fmt.Errorf("%s %s: exit code %d (no output)",
				r.Binary, strings.Join(args, " "), exitErr.ExitCode())
		}
		return nil, err
	}
	// Success path: if stdout is empty but stderr has content (advisory
	// warnings), return stderr as the output so the user sees it.
	output = bytes.TrimRight(output, "\n")
	if len(output) == 0 && stderr.Len() > 0 {
		return bytes.TrimRight(stderr.Bytes(), "\n"), nil
	}
	return output, nil
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
