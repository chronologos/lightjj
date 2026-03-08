package jj

type SelectedRevisions struct {
	Revisions []*Commit
}

func NewSelectedRevisions(revisions ...*Commit) SelectedRevisions {
	return SelectedRevisions{Revisions: revisions}
}

// FromIDs builds a SelectedRevisions directly from change/commit ID strings.
func FromIDs(ids []string) SelectedRevisions {
	commits := make([]*Commit, len(ids))
	for i, id := range ids {
		commits[i] = &Commit{ChangeId: id}
	}
	return SelectedRevisions{Revisions: commits}
}

func (s SelectedRevisions) AsPrefixedArgs(prefix string) []string {
	var ret []string
	for _, revision := range s.Revisions {
		ret = append(ret, prefix, revision.GetChangeId())
	}
	return ret
}

func (s SelectedRevisions) AsArgs() []string {
	return s.AsPrefixedArgs("-r")
}
