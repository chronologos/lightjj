package jj

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
	Empty          bool     `json:"empty"`
	// Mine: author.email matches user.email config. Drives the author-chip:
	// shown only when false (bot commits like atlantis, teammates' work).
	Mine        bool   `json:"mine"`
	AuthorEmail string `json:"author_email,omitempty"`
	WorkingCopies  []string `json:"working_copies,omitempty"`
	ParentIds      []string `json:"parent_ids,omitempty"`
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
