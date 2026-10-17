package api

import (
	"net/http"
	"time"
)

// FocusState is the frontend's report of what the user is currently looking
// at. The agent steering loop is otherwise push-only (POST /api/navigate
// scrolls the user's view); GET /api/focus is the read path.
//
// Per-tab: each tab is its own Server instance, so each gets its own focus
// singleton — no cross-tab coordination needed.
type FocusState struct {
	ChangeID    string `json:"change_id,omitempty"`
	CommitID    string `json:"commit_id,omitempty"`
	ActiveView  string `json:"active_view,omitempty"`   // log | branches | merge | doc | oplog | evolog
	DocFilePath string `json:"doc_file_path,omitempty"` // set when active_view == "doc"
	// Revset is the filter of the last SUCCESSFULLY loaded graph — not the
	// filter input's live text (an unsubmitted or rejected revset never shows
	// up here). Pointer: "" = the default log view (revsets.log), nil = not
	// yet reported. Lets an agent confirm a revset-only POST /api/navigate.
	Revset    *string `json:"revset,omitempty"`
	UpdatedAt int64   `json:"updated_at"` // ms epoch, server-stamped on POST
}

// validActiveViews is the closed set of frontend view names the focus endpoint
// accepts. Empty string is also accepted (frontend hasn't resolved a view yet
// or is mid-transition) — handleFocusSet checks that separately.
var validActiveViews = map[string]bool{
	"log":      true,
	"branches": true,
	"merge":    true,
	"doc":      true,
	"oplog":    true,
	"evolog":   true,
}

// handleFocusGet returns the last-reported focus. Zero value (UpdatedAt == 0)
// means the frontend has never POSTed — treat as "unknown", not an error.
func (s *Server) handleFocusGet(w http.ResponseWriter, r *http.Request) {
	s.focusMu.Lock()
	f := s.focus
	s.focusMu.Unlock()
	s.writeJSON(w, r, http.StatusOK, f)
}

// handleFocusSet stores the frontend's view report. UpdatedAt is server-stamped
// (don't trust the client's clock) so agents reading GET /api/focus can do a
// staleness check against their own clock.
func (s *Server) handleFocusSet(w http.ResponseWriter, r *http.Request) {
	var incoming FocusState
	if err := decodeBody(w, r, &incoming); err != nil {
		s.writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	if incoming.ActiveView != "" && !validActiveViews[incoming.ActiveView] {
		s.writeError(w, http.StatusBadRequest, "invalid active_view")
		return
	}
	// Same field caps as handleNavigate for consistency. Focus doesn't fan out
	// to SSE subscribers (no amplification), but it IS stored and re-served on
	// every GET — without a cap a 1MB POST becomes a 1MB-per-tab memory anchor.
	if len(incoming.ChangeID) > 256 || len(incoming.CommitID) > 256 || len(incoming.DocFilePath) > 4096 ||
		(incoming.Revset != nil && len(*incoming.Revset) > maxNavigateRevsetLen) {
		s.writeError(w, http.StatusBadRequest, "field too long")
		return
	}
	incoming.UpdatedAt = time.Now().UnixMilli()
	s.focusMu.Lock()
	s.focus = incoming
	s.focusMu.Unlock()
	s.writeJSON(w, r, http.StatusOK, incoming)
}
