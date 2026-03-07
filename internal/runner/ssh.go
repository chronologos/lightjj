package runner

import (
	"context"
	"fmt"
	"io"
	"strings"
)

// SSHRunner executes jj commands on a remote host via SSH.
// Each command is wrapped as: ssh <host> "jj -R <repoPath> <args...>"
type SSHRunner struct {
	Host     string
	RepoPath string
	local    *LocalRunner
}

func NewSSHRunner(host string, repoPath string) *SSHRunner {
	return &SSHRunner{
		Host:     host,
		RepoPath: repoPath,
		local:    &LocalRunner{Binary: "ssh"},
	}
}

func (r *SSHRunner) wrapArgs(jjArgs []string) []string {
	remoteCmd := fmt.Sprintf("jj -R %s %s", shellQuote(r.RepoPath), quoteAll(jjArgs))
	return []string{r.Host, remoteCmd}
}

func (r *SSHRunner) Run(ctx context.Context, args []string) ([]byte, error) {
	return r.local.Run(ctx, r.wrapArgs(args))
}

func (r *SSHRunner) RunWithInput(ctx context.Context, args []string, stdin string) ([]byte, error) {
	return r.local.RunWithInput(ctx, r.wrapArgs(args), stdin)
}

func (r *SSHRunner) StreamCombined(ctx context.Context, args []string) (io.ReadCloser, error) {
	// Merging the local ssh process's stderr→stdout also merges the remote's:
	// ssh routes remote stderr → local stderr, remote stdout → local stdout.
	return r.local.StreamCombined(ctx, r.wrapArgs(args))
}

// wrapRaw builds an ssh invocation that runs argv in the remote repo
// directory. gh has no -R equivalent; it infers the repo from cwd, so we
// cd into RepoPath first.
func (r *SSHRunner) wrapRaw(argv []string) []string {
	remoteCmd := fmt.Sprintf("cd -- %s && %s", shellQuote(r.RepoPath), quoteAll(argv))
	return []string{r.Host, remoteCmd}
}

func (r *SSHRunner) RunRaw(ctx context.Context, argv []string) ([]byte, error) {
	return r.local.Run(ctx, r.wrapRaw(argv))
}

// StreamRaw opens a persistent pipe to argv running in the remote repo
// directory. Used by the SSH watcher to pipe `inotifywait -m` — each stdout
// line is an fs event, consumed line-by-line until the SSH connection drops
// or ctx is cancelled.
func (r *SSHRunner) StreamRaw(ctx context.Context, argv []string) (io.ReadCloser, error) {
	return r.local.Stream(ctx, r.wrapRaw(argv))
}

// ResolveWorkspaceRoot returns the jj workspace root for an arbitrary path on
// the remote host (NOT r.RepoPath — used for tab-open validation where path
// is user input). -R lets jj do the upward .jj search, same as the local
// `cmd.Dir = dir` approach.
func (r *SSHRunner) ResolveWorkspaceRoot(ctx context.Context, path string) (string, error) {
	remoteCmd := fmt.Sprintf("jj -R %s workspace root", quoteRemotePath(path))
	out, err := r.local.Run(ctx, []string{r.Host, remoteCmd})
	if err != nil {
		return "", fmt.Errorf("not a jj repository on %s: %s", r.Host, path)
	}
	return strings.TrimSpace(string(out)), nil
}

// quoteRemotePath quotes a user-supplied remote path for safe shell use,
// but allows a leading ~/ to expand to the remote user's home. shellQuote
// (single-quotes) suppresses both ~ and $HOME; jj doesn't expand ~ itself.
// So we emit a double-quoted "$HOME" prefix and single-quote the rest —
// adjacent quoted strings concatenate in the shell.
func quoteRemotePath(path string) string {
	if path == "~" {
		return `"$HOME"`
	}
	if rest, ok := strings.CutPrefix(path, "~/"); ok {
		return `"$HOME"/` + shellQuote(rest)
	}
	return shellQuote(path)
}

func shellQuote(s string) string {
	if s == "" {
		return "''"
	}
	return "'" + strings.ReplaceAll(s, "'", "'\"'\"'") + "'"
}

func quoteAll(args []string) string {
	quoted := make([]string, len(args))
	for i, a := range args {
		quoted[i] = shellQuote(a)
	}
	return strings.Join(quoted, " ")
}
