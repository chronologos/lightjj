package jj

import (
	"testing"

	"github.com/stretchr/testify/assert"
)

func TestParseAliases_SingleLine(t *testing.T) {
	output := `aliases.sync = ['git', 'fetch', '-b', 'glob:alice/*', '-b']
aliases.evolve = ['rebase', '--skip-emptied', '-o']
aliases.push = ['git', 'push', '-r', '@-']
`
	aliases := ParseAliases(output)
	assert.Len(t, aliases, 3)
	assert.Equal(t, "sync", aliases[0].Name)
	assert.Equal(t, []string{"git", "fetch", "-b", "glob:alice/*", "-b"}, aliases[0].Command)
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

func TestParseAliases_TripleQuotedString(t *testing.T) {
	// TOML multi-line literal strings (''') are used in jj aliases for
	// shell scripts passed to `util exec`. The first newline after the
	// opening ''' is stripped per TOML spec.
	output := "aliases.l = [\"log\"]\n" +
		"aliases.up = [\"util\", \"exec\", \"--\", \"bash\", \"-c\", '''\n" +
		"set -e\n" +
		"jj git fetch\n" +
		"jj rebase\n" +
		"''', \"bash\"]\n" +
		"aliases.s = [\"status\"]"
	aliases := ParseAliases(output)
	assert.Len(t, aliases, 3)

	assert.Equal(t, "l", aliases[0].Name)
	assert.Equal(t, []string{"log"}, aliases[0].Command)

	assert.Equal(t, "up", aliases[1].Name)
	assert.Equal(t, []string{"util", "exec", "--", "bash", "-c", "set -e\njj git fetch\njj rebase\n", "bash"}, aliases[1].Command)

	assert.Equal(t, "s", aliases[2].Name)
	assert.Equal(t, []string{"status"}, aliases[2].Command)
}

func TestParseAliases_TripleDoubleQuotedString(t *testing.T) {
	output := `aliases.run = ["util", "exec", "--", "bash", "-c", """
echo "hello world"
"""]`
	aliases := ParseAliases(output)
	assert.Len(t, aliases, 1)
	assert.Equal(t, "run", aliases[0].Name)
	assert.Equal(t, []string{"util", "exec", "--", "bash", "-c", "echo \"hello world\"\n"}, aliases[0].Command)
}

// Table-form aliases — `{ definition = [...], doc = "..." }` — flatten to one
// config key per sub-field. The name must drop the `.definition`/`.doc` suffix
// and the doc must be captured, not treated as a bogus alias named "s.doc".
func TestParseAliases_TableForm(t *testing.T) {
	output := `aliases.l = ["log", "-r", "@"]
aliases.s.definition = ["show"]
aliases.s.doc = "show a revision"
`
	aliases := ParseAliases(output)
	assert.Len(t, aliases, 2)

	assert.Equal(t, "l", aliases[0].Name)
	assert.Equal(t, []string{"log", "-r", "@"}, aliases[0].Command)
	assert.Equal(t, "", aliases[0].Doc)

	assert.Equal(t, "s", aliases[1].Name)
	assert.Equal(t, []string{"show"}, aliases[1].Command)
	assert.Equal(t, "show a revision", aliases[1].Doc)
}

// jj may emit .definition and .doc in either order; coalescing is keyed by
// name, not by adjacency.
func TestParseAliases_TableFormDocBeforeDefinition(t *testing.T) {
	output := `aliases.s.doc = "show a revision"
aliases.s.definition = ["show"]
`
	aliases := ParseAliases(output)
	assert.Len(t, aliases, 1)
	assert.Equal(t, "s", aliases[0].Name)
	assert.Equal(t, []string{"show"}, aliases[0].Command)
	assert.Equal(t, "show a revision", aliases[0].Doc)
}

// Table-form .definition can span lines (jj pretty-prints long arrays) with a
// following .doc on the same name — the continuation path must accumulate the
// array AND still coalesce the doc.
func TestParseAliases_TableFormMultiLineDefinition(t *testing.T) {
	output := `aliases.run.definition = [
    "util",
    "exec",
    "--",
    "bash",
    "-c",
    "echo hi",
]
aliases.run.doc = "run a thing"
`
	aliases := ParseAliases(output)
	assert.Len(t, aliases, 1)
	assert.Equal(t, "run", aliases[0].Name)
	assert.Equal(t, []string{"util", "exec", "--", "bash", "-c", "echo hi"}, aliases[0].Command)
	assert.Equal(t, "run a thing", aliases[0].Doc)
}

// Triple-quoted doc: jj's first-newline-after-delimiter is stripped; content
// is taken literally (no escape processing).
func TestParseAliases_TableFormTripleQuotedDoc(t *testing.T) {
	output := "aliases.x.definition = [\"log\"]\naliases.x.doc = '''\nline one\nline two\n'''\n"
	aliases := ParseAliases(output)
	assert.Len(t, aliases, 1)
	assert.Equal(t, "line one\nline two\n", aliases[0].Doc)
}

// A doc string can contain " = " (the key/value split must use the FIRST one)
// and JSON escapes like \n (decoded for display).
func TestParseAliases_TableFormDocEscapes(t *testing.T) {
	output := `aliases.x.definition = ["log"]
aliases.x.doc = "a = b\nsecond line"
`
	aliases := ParseAliases(output)
	assert.Len(t, aliases, 1)
	assert.Equal(t, "a = b\nsecond line", aliases[0].Doc)
}

// A .doc with no matching .definition yields no runnable command, so the entry
// is dropped rather than surfaced as a command-less palette item.
func TestParseAliases_TableFormDocWithoutDefinition(t *testing.T) {
	output := `aliases.orphan.doc = "no command here"
`
	assert.Equal(t, []Alias{}, ParseAliases(output))
}

// An alias literally named "doc" is a simple-form alias, not a doc sub-field.
func TestParseAliases_AliasNamedDoc(t *testing.T) {
	output := `aliases.doc = ["log", "-r", "@"]
`
	aliases := ParseAliases(output)
	assert.Len(t, aliases, 1)
	assert.Equal(t, "doc", aliases[0].Name)
	assert.Equal(t, []string{"log", "-r", "@"}, aliases[0].Command)
	assert.Equal(t, "", aliases[0].Doc)
}

// Literal (single-quoted) doc strings carry no escapes.
func TestParseAliases_TableFormLiteralDoc(t *testing.T) {
	output := `aliases.x.definition = ["log"]
aliases.x.doc = 'literal \n stays literal'
`
	aliases := ParseAliases(output)
	assert.Len(t, aliases, 1)
	assert.Equal(t, `literal \n stays literal`, aliases[0].Doc)
}

func TestConfigListAliases(t *testing.T) {
	args := ConfigListAliases()
	assert.Equal(t, []string{"config", "list", "aliases", "--color", "never", "--ignore-working-copy"}, args)
}
