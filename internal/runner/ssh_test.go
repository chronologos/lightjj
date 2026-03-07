package runner

import (
	"testing"

	"github.com/stretchr/testify/assert"
)

func TestSSHRunner_wrapArgs(t *testing.T) {
	r := NewSSHRunner("user@host", "/home/user/repo")
	got := r.wrapArgs([]string{"log", "-r", "@"})

	assert.Equal(t, "user@host", got[0])
	assert.Contains(t, got[1], "jj -R '/home/user/repo'")
	assert.Contains(t, got[1], "'log'")
	assert.Contains(t, got[1], "'-r'")
	assert.Contains(t, got[1], "'@'")
}

func TestSSHRunner_wrapRaw(t *testing.T) {
	r := NewSSHRunner("user@host", "/home/user/repo")
	got := r.wrapRaw([]string{"gh", "pr", "list", "--author", "@me"})

	assert.Equal(t, "user@host", got[0])
	// cd into the repo so gh can infer owner/repo from the git remote.
	// -- terminates option parsing in case RepoPath starts with a dash.
	assert.Equal(t, "cd -- '/home/user/repo' && 'gh' 'pr' 'list' '--author' '@me'", got[1])
}

func TestSSHRunner_wrapRaw_QuotesRepoPath(t *testing.T) {
	r := NewSSHRunner("user@host", "/home/user/it's mine")
	got := r.wrapRaw([]string{"gh", "pr", "list"})

	assert.Contains(t, got[1], `cd -- '/home/user/it'"'"'s mine' &&`)
}

func TestShellQuote(t *testing.T) {
	assert.Equal(t, "''", shellQuote(""))
	assert.Equal(t, "'simple'", shellQuote("simple"))
	assert.Equal(t, "'it'\"'\"'s'", shellQuote("it's"))
	assert.Equal(t, "'hello world'", shellQuote("hello world"))
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
