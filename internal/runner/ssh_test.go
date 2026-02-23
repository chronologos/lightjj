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

func TestShellQuote(t *testing.T) {
	assert.Equal(t, "''", shellQuote(""))
	assert.Equal(t, "'simple'", shellQuote("simple"))
	assert.Equal(t, "'it'\"'\"'s'", shellQuote("it's"))
	assert.Equal(t, "'hello world'", shellQuote("hello world"))
}
