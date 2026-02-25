package jj

import (
	"testing"

	"github.com/stretchr/testify/assert"
)

func TestParseAliases_SingleLine(t *testing.T) {
	output := `aliases.sync = ['git', 'fetch', '-b', 'glob:iant/*', '-b']
aliases.evolve = ['rebase', '--skip-emptied', '-o']
aliases.push = ['git', 'push', '-r', '@-']
`
	aliases := ParseAliases(output)
	assert.Len(t, aliases, 3)
	assert.Equal(t, "sync", aliases[0].Name)
	assert.Equal(t, []string{"git", "fetch", "-b", "glob:iant/*", "-b"}, aliases[0].Command)
	assert.Equal(t, "evolve", aliases[1].Name)
	assert.Equal(t, []string{"rebase", "--skip-emptied", "-o"}, aliases[1].Command)
	assert.Equal(t, "push", aliases[2].Name)
	assert.Equal(t, []string{"git", "push", "-r", "@-"}, aliases[2].Command)
}

func TestParseAliases_DoubleQuotes(t *testing.T) {
	output := `aliases.up = ["util", "exec", "--", "bash", "-c", "echo hello"]
`
	aliases := ParseAliases(output)
	assert.Len(t, aliases, 1)
	assert.Equal(t, "up", aliases[0].Name)
	assert.Equal(t, []string{"util", "exec", "--", "bash", "-c", "echo hello"}, aliases[0].Command)
}

func TestParseAliases_MultiLine(t *testing.T) {
	output := `aliases.pre-commit = [
    "util",
    "exec",
    "--",
    "bash",
    "-c",
    "cd $(jj root) && jj diff",
]
aliases.sync = ['git', 'fetch']
`
	aliases := ParseAliases(output)
	assert.Len(t, aliases, 2)
	assert.Equal(t, "pre-commit", aliases[0].Name)
	assert.Equal(t, []string{"util", "exec", "--", "bash", "-c", "cd $(jj root) && jj diff"}, aliases[0].Command)
	assert.Equal(t, "sync", aliases[1].Name)
	assert.Equal(t, []string{"git", "fetch"}, aliases[1].Command)
}

func TestParseAliases_Empty(t *testing.T) {
	assert.Equal(t, []Alias{}, ParseAliases(""))
	assert.Equal(t, []Alias{}, ParseAliases("  \n  "))
}

func TestParseAliases_MixedQuotes(t *testing.T) {
	output := `aliases.a = ['git', 'fetch']
aliases.b = ["rebase", "-d", "trunk()"]
`
	aliases := ParseAliases(output)
	assert.Len(t, aliases, 2)
	assert.Equal(t, []string{"git", "fetch"}, aliases[0].Command)
	assert.Equal(t, []string{"rebase", "-d", "trunk()"}, aliases[1].Command)
}

func TestParseAliases_DoubleQuoteInsideSingleQuote(t *testing.T) {
	output := `aliases.fmt = ['log', '-T', '"hello"']
`
	aliases := ParseAliases(output)
	assert.Len(t, aliases, 1)
	assert.Equal(t, "fmt", aliases[0].Name)
	assert.Equal(t, []string{"log", "-T", `"hello"`}, aliases[0].Command)
}

func TestConfigListAliases(t *testing.T) {
	args := ConfigListAliases()
	assert.Equal(t, []string{"config", "list", "aliases", "--color", "never", "--ignore-working-copy"}, args)
}
