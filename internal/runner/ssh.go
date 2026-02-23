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
	quoted := make([]string, len(jjArgs))
	for i, arg := range jjArgs {
		quoted[i] = shellQuote(arg)
	}
	remoteCmd := fmt.Sprintf("jj -R %s %s", shellQuote(r.RepoPath), strings.Join(quoted, " "))
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

func shellQuote(s string) string {
	if s == "" {
		return "''"
	}
	return "'" + strings.ReplaceAll(s, "'", "'\"'\"'") + "'"
}
