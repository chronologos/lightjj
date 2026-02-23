package jj

import "strings"

const RootChangeId = "zzzzzzzz"

type Commit struct {
	ChangeId      string `json:"change_id"`
	CommitId      string `json:"commit_id"`
	IsWorkingCopy bool   `json:"is_working_copy"`
	Hidden        bool   `json:"hidden"`
}

func (c Commit) IsRoot() bool {
	return c.ChangeId == RootChangeId
}

func (c Commit) IsConflicting() bool {
	return strings.HasSuffix(c.ChangeId, "??")
}

// GetChangeId returns the best identifier for this commit.
// For hidden or conflicting revisions, the commit ID is more reliable.
func (c Commit) GetChangeId() string {
	if c.Hidden || c.IsConflicting() {
		return c.CommitId
	}
	return c.ChangeId
}
