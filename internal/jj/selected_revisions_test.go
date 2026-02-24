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

func TestFromIDs(t *testing.T) {
	sel := FromIDs([]string{"abc", "def"})
	assert.Len(t, sel.Revisions, 2)
	assert.Equal(t, "abc", sel.Revisions[0].ChangeId)
	assert.Equal(t, "def", sel.Revisions[1].ChangeId)
}

func TestContains_HiddenCommit(t *testing.T) {
	// Hidden commits use CommitId for matching via GetChangeId()
	sel := NewSelectedRevisions(&Commit{ChangeId: "abc", CommitId: "commit123", Hidden: true})
	// Match against CommitId since the commit is hidden
	assert.True(t, sel.Contains(&Commit{CommitId: "commit123", Hidden: true}))
	// ChangeId won't match because Hidden uses CommitId
	assert.False(t, sel.Contains(&Commit{ChangeId: "abc"}))
}
