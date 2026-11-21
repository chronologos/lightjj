package jj

import (
	"encoding/json"
	"strings"
)

// RevIdentity is what a revision symbol resolves to right now. Ids are jj's
// .short() form, matching the ids the frontend holds (Commit.commit_id/change_id).
type RevIdentity struct {
	CommitId string `json:"commit_id"`
	ChangeId string `json:"change_id"`
	Hidden   bool   `json:"hidden"`
}

// Identity resolves one revision. --ignore-working-copy: callers snapshot first.
func Identity(revision string) CommandArgs {
	tmpl := `'{"commit_id":' ++ json(commit_id.short()) ++ ',"change_id":' ++ json(change_id.short()) ++ ',"hidden":' ++ json(self.hidden()) ++ "}\n"`
	return []string{"log", "-r", revision, "--no-graph", "--color", "never", "--ignore-working-copy", "-T", tmpl}
}

// ParseIdentity parses Identity output. false unless it is exactly one revision.
func ParseIdentity(output string) (RevIdentity, bool) {
	var id RevIdentity
	line := strings.TrimSpace(output)
	if strings.Contains(line, "\n") {
		return id, false
	}
	return id, json.Unmarshal([]byte(line), &id) == nil && id.CommitId != ""
}
