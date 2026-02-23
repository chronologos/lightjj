package jj

import (
	"testing"

	"github.com/stretchr/testify/assert"
)

func TestCommit_IsRoot(t *testing.T) {
	assert.True(t, Commit{ChangeId: RootChangeId}.IsRoot())
	assert.False(t, Commit{ChangeId: "abc"}.IsRoot())
}

func TestCommit_IsConflicting(t *testing.T) {
	assert.True(t, Commit{ChangeId: "abc??"}.IsConflicting())
	assert.False(t, Commit{ChangeId: "abc"}.IsConflicting())
}

func TestCommit_GetChangeId(t *testing.T) {
	// Normal: returns change ID
	c := Commit{ChangeId: "abc", CommitId: "xyz"}
	assert.Equal(t, "abc", c.GetChangeId())

	// Hidden: returns commit ID
	c.Hidden = true
	assert.Equal(t, "xyz", c.GetChangeId())

	// Conflicting: returns commit ID
	c2 := Commit{ChangeId: "abc??", CommitId: "xyz"}
	assert.Equal(t, "xyz", c2.GetChangeId())
}
