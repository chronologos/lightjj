package api

import (
	"bytes"
	"context"
	"fmt"
	"net/http"
	"regexp"
	"strings"

	"github.com/chronologos/lightjj/internal/jj"
)

// Write preconditions. The UI captures content at one moment and writes it at a
// later one; in between a snapshot, a CLI command or an agent may have moved the
// target. The client says what it was looking at, the server snapshots, checks,
// and answers 409 with a machine-readable code instead of writing.
//
// X-JJ-Expect — "rev=commit_id,…": each rev must still resolve to that visible
// commit. Any endpoint that goes through runMutation honours it.
const (
	expectHeader = "X-JJ-Expect"
	maxExpect    = 32

	codeRevisionChanged = "revision_changed"
	codeWCMoved         = "wc_moved"
	codeContentChanged  = "content_changed"
)

// expectIdRe admits change/commit ids only — never revset syntax.
var expectIdRe = regexp.MustCompile(`^[a-z0-9]{1,64}$`)

type expectation struct{ rev, commitId string }

func parseExpect(header string) ([]expectation, error) {
	if header == "" {
		return nil, nil
	}
	pairs := strings.Split(header, ",")
	if len(pairs) > maxExpect {
		return nil, fmt.Errorf("%s: too many entries", expectHeader)
	}
	out := make([]expectation, 0, len(pairs))
	for _, p := range pairs {
		rev, commitId, ok := strings.Cut(strings.TrimSpace(p), "=")
		if !ok || !expectIdRe.MatchString(rev) || !expectIdRe.MatchString(commitId) {
			return nil, fmt.Errorf("%s: invalid entry %q", expectHeader, p)
		}
		out = append(out, expectation{rev, commitId})
	}
	return out, nil
}

// checkExpect enforces the X-JJ-Expect header. On failure it has written the
// response. No header → no subprocess.
func (s *Server) checkExpect(ctx context.Context, w http.ResponseWriter, r *http.Request) bool {
	expected, err := parseExpect(r.Header.Get(expectHeader))
	if err != nil {
		s.writeError(w, http.StatusBadRequest, err.Error())
		return false
	}
	if len(expected) == 0 {
		return true
	}
	// Snapshot first: a dirty working copy is a change the client hasn't seen.
	if _, err := s.Runner.Run(ctx, jj.DebugSnapshot()); err != nil {
		s.writeError(w, http.StatusInternalServerError, err.Error())
		return false
	}
	for _, e := range expected {
		out, err := s.Runner.Run(ctx, jj.Identity(e.rev))
		id, ok := jj.ParseIdentity(string(out))
		if err != nil || !ok || id.Hidden || id.CommitId != e.commitId {
			s.refreshOpId() // the snapshot may have advanced it; the header tells the client to reload
			s.writeConflict(w, codeRevisionChanged, fmt.Sprintf("%s changed since you opened it", shortID(e.rev)))
			return false
		}
	}
	return true
}

// checkFileWrite enforces file-write's expect_change_id / base_commit_id. The
// base comparison is byte-exact via `jj file show`, so it works over SSH and
// needs no hashing in the browser.
func (s *Server) checkFileWrite(ctx context.Context, w http.ResponseWriter, req fileWriteRequest, path string) bool {
	if req.ExpectChangeId == "" && req.BaseCommitId == "" {
		return true
	}
	// Also the safety net for the write itself: whatever is on disk now becomes
	// recoverable from the evolog before it is replaced.
	if _, err := s.Runner.Run(ctx, jj.DebugSnapshot()); err != nil {
		s.writeError(w, http.StatusInternalServerError, err.Error())
		return false
	}
	if req.ExpectChangeId != "" {
		out, err := s.Runner.Run(ctx, jj.Identity("@"))
		if err != nil {
			s.writeError(w, http.StatusInternalServerError, err.Error())
			return false
		}
		if id, ok := jj.ParseIdentity(string(out)); !ok || id.ChangeId != req.ExpectChangeId {
			s.refreshOpId()
			s.writeConflict(w, codeWCMoved, fmt.Sprintf("the working copy is no longer at %s", shortID(req.ExpectChangeId)))
			return false
		}
	}
	if req.BaseCommitId != "" {
		cur, curErr := s.Runner.ReadBytes(ctx, jj.FileShow("@", path, false))
		base, baseErr := s.Runner.ReadBytes(ctx, jj.FileShow(req.BaseCommitId, path, false))
		// Missing on both sides = a new file, which is not a conflict.
		if (curErr == nil) != (baseErr == nil) || !bytes.Equal(cur, base) {
			s.refreshOpId()
			s.writeConflict(w, codeContentChanged, fmt.Sprintf("%s changed since you opened it", path))
			return false
		}
	}
	return true
}

func shortID(id string) string {
	if len(id) > 8 {
		return id[:8]
	}
	return id
}
