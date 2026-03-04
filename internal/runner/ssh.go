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

func (r *SSHRunner) Stream(ctx context.Context, args []string) (io.ReadCloser, error) {
	return r.local.Stream(ctx, r.wrapArgs(args))
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
