package jj

const RootChangeId = "zzzzzzzz"

type Commit struct {
	ChangeId       string   `json:"change_id"`
	CommitId       string   `json:"commit_id"`
	ChangePrefix   int      `json:"change_prefix"`
	CommitPrefix   int      `json:"commit_prefix"`
	IsWorkingCopy  bool     `json:"is_working_copy"`
	Hidden         bool     `json:"hidden"`
	Immutable      bool     `json:"immutable"`
	Conflicted     bool     `json:"conflicted"`
	Divergent      bool     `json:"divergent"`
	WorkingCopies  []string `json:"working_copies,omitempty"`
}

func (c Commit) IsRoot() bool {
	return c.ChangeId == RootChangeId
}

// GetChangeId returns the best identifier for this commit.
// For hidden or divergent revisions, the commit ID is more reliable
// since the change ID may be ambiguous.
func (c Commit) GetChangeId() string {
	if c.Hidden || c.Divergent {
		return c.CommitId
	}
	return c.ChangeId
}
