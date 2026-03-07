package runner

import (
	"context"
	"fmt"
	"io"
	"strings"
)

// SSHRunner executes jj commands on a remote host via SSH.
// Each command is wrapped as: ssh -o LogLevel=ERROR <host> "jj -R <repoPath> <args...>"
type SSHRunner struct {
	Host     string
	RepoPath string
	local    *LocalRunner
}

// LogLevel=ERROR suppresses SSH's own Warning:/INFO stderr lines
// ("Warning: Permanently added 'host' (ED25519) to the list of known hosts.")
// which otherwise trip hasWarningLine() in server.go and surface as amber
// MessageBar toasts for every SSH mutation. ERROR-level (auth failure,
// connection refused) still passes through and becomes a proper Go error.
// Not `ssh -q`: that silences errors too.
var sshBaseOpts = []string{"-o", "LogLevel=ERROR"}

func NewSSHRunner(host string, repoPath string) *SSHRunner {
	return &SSHRunner{
		Host:     host,
		RepoPath: repoPath,
		local:    &LocalRunner{Binary: "ssh"},
	}
}

func (r *SSHRunner) sshArgv(remoteCmd string) []string {
	return append(append([]string(nil), sshBaseOpts...), r.Host, remoteCmd)
}

func (r *SSHRunner) wrapArgs(jjArgs []string) []string {
	return r.sshArgv(fmt.Sprintf("jj -R %s %s", shellQuote(r.RepoPath), quoteAll(jjArgs)))
}

func (r *SSHRunner) Run(ctx context.Context, args []string) ([]byte, error) {
	return r.local.Run(ctx, r.wrapArgs(args))
}

func (r *SSHRunner) RunWithInput(ctx context.Context, args []string, stdin string) ([]byte, error) {
	return r.local.RunWithInput(ctx, r.wrapArgs(args), stdin)
}

func (r *SSHRunner) RunForMutation(ctx context.Context, args []string, stdin string) ([]byte, []byte, error) {
	return r.local.RunForMutation(ctx, r.wrapArgs(args), stdin)
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
	return r.sshArgv(fmt.Sprintf("cd -- %s && %s", shellQuote(r.RepoPath), quoteAll(argv)))
}

func (r *SSHRunner) RunRaw(ctx context.Context, argv []string) ([]byte, error) {
	return r.local.Run(ctx, r.wrapRaw(argv))
}

// ResolveWorkspaceRoot returns the jj workspace root for an arbitrary path on
// the remote host (NOT r.RepoPath — used for tab-open validation where path
// is user input). -R lets jj do the upward .jj search, same as the local
// `cmd.Dir = dir` approach.
func (r *SSHRunner) ResolveWorkspaceRoot(ctx context.Context, path string) (string, error) {
	out, err := r.local.Run(ctx, r.sshArgv(fmt.Sprintf("jj -R %s workspace root", quoteRemotePath(path))))
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
