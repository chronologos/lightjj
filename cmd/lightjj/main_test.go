package main

import (
	"flag"
	"testing"

	"github.com/stretchr/testify/assert"
)

// --allowed-host is repeatable AND comma-separated; empty segments survive the
// split so NewHostPolicy rejects them instead of silently dropping a typo.
func TestHostListFlag(t *testing.T) {
	var hl hostList
	fs := flag.NewFlagSet("t", flag.ContinueOnError)
	fs.Var(&hl, "allowed-host", "")
	assert.NoError(t, fs.Parse([]string{"--allowed-host", "a.example,b.example", "--allowed-host=c.example", "--allowed-host", "d.example,"}))
	assert.Equal(t, hostList{"a.example", "b.example", "c.example", "d.example", ""}, hl)
}
