package runner

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"time"
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
	// Error swallowed: if dir isn't a repo, RepoDir stays as-is and the first
	// jj command surfaces a clear error. Callers that need to fail fast (tab
	// opening) should call ResolveWorkspaceRoot explicitly first.
	if root, err := ResolveWorkspaceRoot(repoDir); err == nil {
		repoDir = root
	}
	return &LocalRunner{Binary: "jj", RepoDir: repoDir}
}

// jjNoWrap disables ui.log-word-wrap globally for jj invocations. User config
// with log-word-wrap=true splits single-line template output across graph
// lines — every parser in internal/jj (LogGraph, OpLog, Divergence,
// StaleImmutable, GetDescription, …) splits on \n and either drops rows with
// the wrong field count or injects spurious newlines into editor prefill.
// Applied once at the runner boundary so per-builder overrides aren't needed.
const jjNoWrap = "--config=ui.log-word-wrap=false"

// prependJJFlags injects jjNoWrap when Binary resolves to jj. Skipped for
// RunRaw paths (gh, etc.) and for SSHRunner's internal ssh invocations (the
// flag is prepended to jj args inside wrapArgs before the ssh wrap).
// filepath.Base so absolute paths (`/usr/local/bin/jj`) match too.
func (r *LocalRunner) prependJJFlags(args []string) []string {
	if filepath.Base(r.Binary) != "jj" {
		return args
	}
	return append([]string{jjNoWrap}, args...)
}

// waitDelay force-closes pipes when a grandchild process (SSH ControlMaster
// mux master) inherits them — ctx expiry kills the direct child, but Wait()
// blocks in awaitGoroutines until the pipe-copier sees EOF. Applied to every
// exec.CommandContext path below. ResolveWorkspaceRoot is excluded: local
// `jj workspace root` has no SSH, no ctx, no grandchild that could hold fds.
// Observed 2026-03-17: Tailscale down → ssh hangs → 10s ctx fires → process
// stuck 90+s at ResolveWorkspaceRoot (the SSH-mode caller of runSeparate).
const waitDelay = 3 * time.Second

// ResolveWorkspaceRoot returns the jj workspace root for dir, or an error if
// dir is not inside a jj repository. Used for tab-open validation (fail fast
// with a 400 instead of constructing a Server that errors on every request)
// and canonical-path dedup (opening /repo/src/ and /repo/ should be one tab).
func ResolveWorkspaceRoot(dir string) (string, error) {
	cmd := exec.Command("jj", "workspace", "root")
	cmd.Dir = dir
	out, err := cmd.Output()
	if err != nil {
		return "", fmt.Errorf("not a jj repository: %s", dir)
	}
	return strings.TrimSpace(string(out)), nil
}

// ResolveLocalTabPath is the local-mode TabResolve: ~ expansion, abs check,
// then ResolveWorkspaceRoot. Lives here (not main.go) so it's testable and
// sits next to its sibling — both take user input → canonical root.
func ResolveLocalTabPath(path string) (string, error) {
	if path == "~" || strings.HasPrefix(path, "~/") {
		if home, err := os.UserHomeDir(); err == nil {
			path = filepath.Join(home, path[1:])
		}
	}
	if !filepath.IsAbs(path) {
		return "", errors.New("path must be absolute")
	}
	return ResolveWorkspaceRoot(path)
}

func (r *LocalRunner) Run(ctx context.Context, args []string) ([]byte, error) {
	return r.run(ctx, args, "")
}

func (r *LocalRunner) RunWithInput(ctx context.Context, args []string, stdin string) ([]byte, error) {
	return r.run(ctx, args, stdin)
}

// runSeparate executes a jj command and returns stdout and stderr separately
// on success. On non-zero exit, stderr is baked into the error message
// (stdout/stderr are nil).
func (r *LocalRunner) runSeparate(ctx context.Context, args []string, stdin string) ([]byte, []byte, error) {
	args = r.prependJJFlags(args)
	cmd := exec.CommandContext(ctx, r.Binary, args...)
	cmd.Dir = r.RepoDir
	cmd.WaitDelay = waitDelay
	// Always set stdin (even for ""). SSHRunner.WriteFile pipes file content
	// here; the empty-content path should go through the same machinery as
	// non-empty rather than relying on nil→/dev/null to accidentally produce
	// the right outcome.
	cmd.Stdin = bytes.NewReader([]byte(stdin))
	// Capture stderr separately so we can surface jj's advisory warnings on
	// exit-0 commands. `jj git push` with no tracked bookmarks prints
	// "Warning: Refusing to create new remote bookmark... Nothing changed."
	// to stderr and exits 0 — without this, the UI shows "Push complete"
	// with empty output and the user never sees why nothing happened.
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	output, err := cmd.Output()
	// ErrWaitDelay = process exited 0 but pipe-drain timed out. Only
	// returned on clean exit (process killed → ExitError instead). output
	// has everything the process wrote before exit; the copier was just
	// waiting on a grandchild's inherited fd (SSH mux master). Normalize
	// to nil so it falls through to the single success return below.
	if errors.Is(err, exec.ErrWaitDelay) {
		err = nil
	}
	if err != nil {
		var exitErr *exec.ExitError
		if errors.As(err, &exitErr) {
			stderrStr := strings.TrimSpace(stderr.String())
			if stderrStr != "" {
				return nil, nil, fmt.Errorf("exit code %d: %s", exitErr.ExitCode(), stderrStr)
			}
			// Empty stderr — include stdout (some jj errors print there)
			stdout := strings.TrimSpace(string(output))
			if stdout != "" {
				return nil, nil, fmt.Errorf("exit code %d: %s", exitErr.ExitCode(), stdout)
			}
			// Triple-empty: no stderr, no stdout. Include args so the user
			// at least knows which operation failed silently.
			return nil, nil, fmt.Errorf("%s %s: exit code %d (no output)",
				r.Binary, strings.Join(args, " "), exitErr.ExitCode())
		}
		return nil, nil, err
	}
	return bytes.TrimRight(output, "\n"), bytes.TrimRight(stderr.Bytes(), "\n"), nil
}

func (r *LocalRunner) run(ctx context.Context, args []string, stdin string) ([]byte, error) {
	stdout, stderr, err := r.runSeparate(ctx, args, stdin)
	if err != nil {
		return nil, err
	}
	// Success path: if stdout is empty but stderr has content (advisory
	// warnings), return stderr as the output so the user sees it.
	if len(stdout) == 0 && len(stderr) > 0 {
		return stderr, nil
	}
	return stdout, nil
}

func (r *LocalRunner) RunForMutation(ctx context.Context, args []string, stdin string) ([]byte, []byte, error) {
	return r.runSeparate(ctx, args, stdin)
}

// ReadBytes executes a jj command and returns stdout byte-exact. Unlike Run,
// no trailing-newline trim. Stderr is discarded on success (file content
// queries shouldn't warn; if they did, mixing warnings into the byte stream
// would corrupt it anyway).
func (r *LocalRunner) ReadBytes(ctx context.Context, args []string) ([]byte, error) {
	args = r.prependJJFlags(args)
	cmd := exec.CommandContext(ctx, r.Binary, args...)
	cmd.Dir = r.RepoDir
	cmd.WaitDelay = waitDelay
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	out, err := cmd.Output()
	if errors.Is(err, exec.ErrWaitDelay) {
		err = nil // see runSeparate — clean exit, output is valid
	}
	if err != nil {
		var exitErr *exec.ExitError
		if errors.As(err, &exitErr) {
			msg := strings.TrimSpace(stderr.String())
			if msg == "" {
				msg = strings.TrimSpace(string(out))
			}
			return nil, fmt.Errorf("exit code %d: %s", exitErr.ExitCode(), msg)
		}
		return nil, err
	}
	return out, nil
}

func (r *LocalRunner) RunRaw(ctx context.Context, argv []string) ([]byte, error) {
	// Fresh struct rather than mutating r.Binary — Server.Runner is shared
	// across HTTP handler goroutines. Reuses run()'s exit-code/stderr handling.
	sub := &LocalRunner{Binary: argv[0], RepoDir: r.RepoDir}
	return sub.run(ctx, argv[1:], "")
}

// WriteFile writes content to relPath under RepoDir, with symlink-escape
// hardening. relPath MUST be pre-validated (lexical checks: no `..`, no
// absolute, no `.jj`/`.git`) — this layer only guards against a tracked
// symlink inside the repo (e.g. `link → /etc`) that would pass lexical
// checks but resolve outside the tree.
func (r *LocalRunner) WriteFile(_ context.Context, relPath string, content []byte) error {
	target := filepath.Join(r.RepoDir, relPath)

	// Parent-directory symlink escape: `src/link/foo.go` where `src/link → /`.
	// EvalSymlinks on the parent, check it's still under RepoDir.
	parentDir := filepath.Dir(target)
	resolvedParent, err := filepath.EvalSymlinks(parentDir)
	if err != nil {
		return fmt.Errorf("parent directory does not exist")
	}
	resolvedRepo, err := filepath.EvalSymlinks(r.RepoDir)
	if err != nil {
		return fmt.Errorf("cannot resolve repository path")
	}
	sep := string(filepath.Separator)
	if resolvedParent != resolvedRepo && !strings.HasPrefix(resolvedParent+sep, resolvedRepo+sep) {
		return fmt.Errorf("path escapes repository")
	}

	// Leaf-level symlink escape: `link.txt → /etc/shadow`. Parent check
	// passes (parent IS in repo); Lstat catches it.
	if info, err := os.Lstat(target); err == nil && info.Mode()&os.ModeSymlink != 0 {
		return fmt.Errorf("cannot write to symlink")
	}

	return os.WriteFile(target, content, 0o644)
}

func (r *LocalRunner) StreamCombined(ctx context.Context, args []string) (io.ReadCloser, error) {
	return r.stream(ctx, args, true)
}

func (r *LocalRunner) stream(ctx context.Context, args []string, mergeStderr bool) (io.ReadCloser, error) {
	args = r.prependJJFlags(args)
	cmd := exec.CommandContext(ctx, r.Binary, args...)
	cmd.Dir = r.RepoDir
	// StdoutPipe case: the hang is in the CALLER's Scanner.Read (grandchild
	// holds write-end → no EOF), not in Wait. WaitDelay still helps the
	// ctx-cancel path — Go's closeDescriptors(parentIOPipes) includes
	// StdoutPipe, so Scanner sees closed pipe after ctx-done + delay.
	cmd.WaitDelay = waitDelay
	pipe, err := cmd.StdoutPipe()
	if err != nil {
		return nil, err
	}
	if mergeStderr {
		// StdoutPipe() set cmd.Stdout to the pipe's write end — reuse it
		// for stderr so both fds write to the same pipe. OS-level dup;
		// both close on process exit.
		cmd.Stderr = cmd.Stdout
	}
	if err := cmd.Start(); err != nil {
		return nil, err
	}
	return &streamCloser{ReadCloser: pipe, cmd: cmd}, nil
}

type streamCloser struct {
	io.ReadCloser
	cmd  *exec.Cmd
	once sync.Once
	err  error
}

// Close is idempotent so callers can `defer rc.Close()` as a panic safety net
// AND explicitly close to capture the exit error. Second call returns cached err.
func (s *streamCloser) Close() error {
	s.once.Do(func() {
		_ = s.ReadCloser.Close()
		s.err = s.cmd.Wait()
	})
	return s.err
}
