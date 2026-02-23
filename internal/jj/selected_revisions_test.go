package jj

import (
	"testing"

	"github.com/stretchr/testify/assert"
)

func TestSelectedRevisions_Contains(t *testing.T) {
	a := &Commit{ChangeId: "abc"}
	b := &Commit{ChangeId: "def"}
	revs := NewSelectedRevisions(a)

	assert.True(t, revs.Contains(a))
	assert.False(t, revs.Contains(b))
	assert.False(t, revs.Contains(nil))
}

func TestSelectedRevisions_GetIds(t *testing.T) {
	a := &Commit{ChangeId: "abc"}
	b := &Commit{ChangeId: "def"}
	revs := NewSelectedRevisions(a, b)
	assert.Equal(t, []string{"abc", "def"}, revs.GetIds())
}

func TestSelectedRevisions_AsArgs(t *testing.T) {
	a := &Commit{ChangeId: "abc"}
	revs := NewSelectedRevisions(a)
	assert.Equal(t, []string{"-r", "abc"}, revs.AsArgs())
}

func TestSelectedRevisions_AsPrefixedArgs(t *testing.T) {
	a := &Commit{ChangeId: "abc"}
	b := &Commit{ChangeId: "def"}
	revs := NewSelectedRevisions(a, b)
	assert.Equal(t, []string{"--from", "abc", "--from", "def"}, revs.AsPrefixedArgs("--from"))
}

func TestSelectedRevisions_Last(t *testing.T) {
	a := &Commit{ChangeId: "abc"}
	b := &Commit{ChangeId: "def"}
	assert.Equal(t, "def", NewSelectedRevisions(a, b).Last())
	assert.Equal(t, "", NewSelectedRevisions().Last())
}
