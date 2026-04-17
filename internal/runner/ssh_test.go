package runner

import (
	"path/filepath"
	"testing"

	"github.com/stretchr/testify/assert"
)

// Both wrap* helpers go through sshArgv → prepend LogLevel=ERROR then host.
// Indices: [0..len(sshBaseOpts)-1]=opts, [n]=host, [n+1]=remoteCmd.
var n = len(sshBaseOpts)

func TestSSHRunner_wrapArgs(t *testing.T) {
	r := NewSSHRunner("user@host", "/home/user/repo")
	got := r.wrapArgs([]string{"log", "-r", "@"})

	assert.Equal(t, sshBaseOpts, got[:n])
	assert.Equal(t, "user@host", got[n])
	assert.Contains(t, got[n+1], "jj -R '/home/user/repo'")
	assert.Contains(t, got[n+1], "'log'")
	assert.Contains(t, got[n+1], "'-r'")
	assert.Contains(t, got[n+1], "'@'")
	// jjNoWrap injected at the runner boundary so every jj command gets
	// wrap-safe output without per-builder overrides.
	assert.Contains(t, got[n+1], "'--config=ui.log-word-wrap=false'")
}

func TestSSHRunner_wrapRaw_NoJJFlagInjection(t *testing.T) {
	// RunRaw is for non-jj binaries (gh). Prepending a jj flag would break
	// argv — verify wrapRaw leaves it alone.
	r := NewSSHRunner("user@host", "/home/user/repo")
	got := r.wrapRaw([]string{"gh", "pr", "list"})
	assert.NotContains(t, got[n+1], "log-word-wrap")
}

func TestSSHRunner_wrapRaw(t *testing.T) {
	r := NewSSHRunner("user@host", "/home/user/repo")
	got := r.wrapRaw([]string{"gh", "pr", "list", "--author", "@me"})

	assert.Equal(t, sshBaseOpts, got[:n])
	assert.Equal(t, "user@host", got[n])
	// cd into the repo so gh can infer owner/repo from the git remote.
	// -- terminates option parsing in case RepoPath starts with a dash.
	assert.Equal(t, "cd -- '/home/user/repo' && 'gh' 'pr' 'list' '--author' '@me'", got[n+1])
}

func TestSSHRunner_wrapRaw_QuotesRepoPath(t *testing.T) {
	r := NewSSHRunner("user@host", "/home/user/it's mine")
	got := r.wrapRaw([]string{"gh", "pr", "list"})

	assert.Contains(t, got[n+1], `cd -- '/home/user/it'"'"'s mine' &&`)
}

func TestShellQuote(t *testing.T) {
	assert.Equal(t, "''", shellQuote(""))
	assert.Equal(t, "'simple'", shellQuote("simple"))
	assert.Equal(t, "'it'\"'\"'s'", shellQuote("it's"))
	assert.Equal(t, "'hello world'", shellQuote("hello world"))
}

func TestSSHRunner_writeFileCmd(t *testing.T) {
	r := NewSSHRunner("user@host", "/home/user/repo")
	got := r.writeFileCmd("src/main.go")
	assert.Equal(t, "cd -- '/home/user/repo' && cat > 'src/main.go'", got)
}

func TestSSHRunner_writeFileCmd_ToSlash(t *testing.T) {
	// filepath.ToSlash is a no-op unless the host separator is '\' — so this
	// test only exercises the conversion on Windows. Scenario: filepath.Clean
	// on the handler side turns `src/main.go` into `src\main.go` on Windows;
	// writeFileCmd must undo that so the POSIX remote doesn't create a file
	// literally named `src\main.go` at repo root. Same pattern as open.go:127.
	if filepath.Separator == '/' {
		t.Skip("filepath.ToSlash is a no-op on this platform; conversion only applies on Windows")
	}
	r := NewSSHRunner("user@host", "/repo")
	got := r.writeFileCmd(`src\main.go`)
	assert.Equal(t, "cd -- '/repo' && cat > 'src/main.go'", got)
}

func TestSSHRunner_writeFileCmd_QuotesInjectionAttempts(t *testing.T) {
	// relPath is handler-validated (no .., no .jj, no abs) but shellQuote is
	// the second defense for anything lexical checks don't catch. Single-quotes
	// suppress all metachar interpretation — ;|&$`* become literals.
	r := NewSSHRunner("user@host", "/repo")
	got := r.writeFileCmd("foo; rm -rf /")
	assert.Equal(t, "cd -- '/repo' && cat > 'foo; rm -rf /'", got)

	// Embedded single-quote: shellQuote's '"'"' escape. The path is
	// handler-rejected (no legit filename has this) but the escaping itself
	// must be correct — if `'` broke out of the quote, arbitrary shell runs.
	got = r.writeFileCmd("it's.txt")
	assert.Equal(t, `cd -- '/repo' && cat > 'it'"'"'s.txt'`, got)
}

func TestQuoteRemotePath(t *testing.T) {
	// ~/ expands to "$HOME"/ (double-quoted so remote shell evaluates it);
	// rest is single-quoted. Adjacent quoted strings concatenate.
	assert.Equal(t, `"$HOME"`, quoteRemotePath("~"))
	assert.Equal(t, `"$HOME"/'repo'`, quoteRemotePath("~/repo"))
	assert.Equal(t, `"$HOME"/'repo/sub dir'`, quoteRemotePath("~/repo/sub dir"))
	// Absolute paths: plain shellQuote, no expansion.
	assert.Equal(t, `'/abs/path'`, quoteRemotePath("/abs/path"))
	// ~user/ form is NOT expanded (bash-specific, not POSIX). Falls through
	// to shellQuote — jj will error with a clear message, which is fine.
	assert.Equal(t, `'~alice/repo'`, quoteRemotePath("~alice/repo"))
}
