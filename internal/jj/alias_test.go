package jj

import (
	"testing"

	"github.com/stretchr/testify/assert"
)

// Recorded from jj 0.40 / 0.43 / 0.47 (identical), plus the warnings they add.
func TestParseAliases(t *testing.T) {
	got := ParseAliases("Warning: Failed to load `aliases.bad`: Expected a string list\n" +
		`{"key":"aliases.l","value":["log","-r","@"]}
{"key":"aliases.\"my alias\"","value":["show"]}
{"key":"aliases.\"a.b\"","value":["status"]}
{"key":"aliases.'q\"q'","value":["status"]}
{"key":"aliases.definition","value":["status"]}
{"key":"aliases.doc","value":["status"]}
{"key":"aliases.multi","value":["util","exec","--","bash","-c","set -e\necho \"hi \\n there\"\n",""]}
{"key":"aliases.s.doc","value":"a = b \"q\""}
{"key":"aliases.s.definition","value":["show"]}
{"key":"aliases.\"x.doc\"","value":["log"]}
{"key":"aliases.\"x y\".definition","value":["log"]}
{"key":"aliases.bad","value":"notalist"}
{"key":"aliases.empty","value":[]}
{"key":"aliases.orphan.doc","value":"no definition"}
{"key":"aliases.\"日本\"","value":["log"]}
`)
	assert.Equal(t, []Alias{
		{Name: "l", Command: []string{"log", "-r", "@"}},
		{Name: "my alias", Command: []string{"show"}},
		{Name: "a.b", Command: []string{"status"}},
		{Name: `q"q`, Command: []string{"status"}},
		{Name: "definition", Command: []string{"status"}},
		{Name: "doc", Command: []string{"status"}},
		{Name: "multi", Command: []string{"util", "exec", "--", "bash", "-c", "set -e\necho \"hi \\n there\"\n", ""}},
		{Name: "s", Command: []string{"show"}, Doc: `a = b "q"`},
		{Name: "x.doc", Command: []string{"log"}},
		{Name: "x y", Command: []string{"log"}},
		{Name: "日本", Command: []string{"log"}},
	}, got)
}

func TestParseAliases_None(t *testing.T) {
	assert.Equal(t, []Alias{}, ParseAliases(""))
	assert.Equal(t, []Alias{}, ParseAliases("Warning: No matching config key for aliases\n"))
	assert.Equal(t, []Alias{}, ParseAliases(`{"key":"aliases.","value":["x"]}`+"\n"+`{"key":"aliases.\"x","value":["x"]}`+"\n"+`{"key":"ui.color","value":["x"]}`))
}
