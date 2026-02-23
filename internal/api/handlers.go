package api

import (
	"net/http"
	"strconv"
	"strings"

	"github.com/chronologos/lightjj/internal/jj"
)

// --- Read handlers ---

func (s *Server) handleLog(w http.ResponseWriter, r *http.Request) {
	revset := r.URL.Query().Get("revset")
	limitStr := r.URL.Query().Get("limit")
	limit, _ := strconv.Atoi(limitStr)

	args := jj.LogJSON(revset, limit)
	output, err := s.Runner.Run(r.Context(), args)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}

	revisions, err := parseLogOutput(string(output))
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, revisions)
}

func (s *Server) handleBookmarks(w http.ResponseWriter, r *http.Request) {
	revset := r.URL.Query().Get("revset")
	var args []string
	if revset != "" {
		args = jj.BookmarkList(revset)
	} else {
		args = jj.BookmarkListAll()
	}

	output, err := s.Runner.Run(r.Context(), args)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}

	bookmarks := jj.ParseBookmarkListOutput(string(output))
	if bookmarks == nil {
		bookmarks = []jj.Bookmark{}
	}
	writeJSON(w, http.StatusOK, bookmarks)
}

func (s *Server) handleDiff(w http.ResponseWriter, r *http.Request) {
	revision := r.URL.Query().Get("revision")
	if revision == "" {
		writeError(w, http.StatusBadRequest, "revision is required")
		return
	}
	file := r.URL.Query().Get("file")

	args := jj.Diff(revision, file, "never", "--tool", ":git")
	output, err := s.Runner.Run(r.Context(), args)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"diff": string(output)})
}

func (s *Server) handleStatus(w http.ResponseWriter, r *http.Request) {
	revision := r.URL.Query().Get("revision")
	if revision == "" {
		writeError(w, http.StatusBadRequest, "revision is required")
		return
	}

	args := jj.Status(revision)
	output, err := s.Runner.Run(r.Context(), args)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": string(output)})
}

func (s *Server) handleGetDescription(w http.ResponseWriter, r *http.Request) {
	revision := r.URL.Query().Get("revision")
	if revision == "" {
		writeError(w, http.StatusBadRequest, "revision is required")
		return
	}

	args := jj.GetDescription(revision)
	output, err := s.Runner.Run(r.Context(), args)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"description": string(output)})
}

func (s *Server) handleRemotes(w http.ResponseWriter, r *http.Request) {
	args := jj.GitRemoteList()
	output, err := s.Runner.Run(r.Context(), args)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	remotes := jj.ParseRemoteListOutput(string(output), "origin")
	writeJSON(w, http.StatusOK, remotes)
}

// --- Write handlers ---

type newRequest struct {
	Revisions []string `json:"revisions"`
}

func (s *Server) handleNew(w http.ResponseWriter, r *http.Request) {
	var req newRequest
	if err := decodeBody(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	revs := commitsFromIds(req.Revisions)
	args := jj.New(revs)
	output, err := s.Runner.Run(r.Context(), args)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"output": string(output)})
}

type editRequest struct {
	Revision         string `json:"revision"`
	IgnoreImmutable  bool   `json:"ignore_immutable"`
}

func (s *Server) handleEdit(w http.ResponseWriter, r *http.Request) {
	var req editRequest
	if err := decodeBody(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	args := jj.Edit(req.Revision, req.IgnoreImmutable)
	output, err := s.Runner.Run(r.Context(), args)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"output": string(output)})
}

type abandonRequest struct {
	Revisions        []string `json:"revisions"`
	IgnoreImmutable  bool     `json:"ignore_immutable"`
}

func (s *Server) handleAbandon(w http.ResponseWriter, r *http.Request) {
	var req abandonRequest
	if err := decodeBody(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	revs := commitsFromIds(req.Revisions)
	args := jj.Abandon(revs, req.IgnoreImmutable)
	output, err := s.Runner.Run(r.Context(), args)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"output": string(output)})
}

type describeRequest struct {
	Revision    string `json:"revision"`
	Description string `json:"description"`
}

func (s *Server) handleDescribe(w http.ResponseWriter, r *http.Request) {
	var req describeRequest
	if err := decodeBody(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	args, stdin := jj.SetDescription(req.Revision, req.Description)
	output, err := s.Runner.RunWithInput(r.Context(), args, stdin)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"output": string(output)})
}

type rebaseRequest struct {
	Revisions       []string `json:"revisions"`
	Destination     string   `json:"destination"`
	SkipEmptied     bool     `json:"skip_emptied"`
	IgnoreImmutable bool     `json:"ignore_immutable"`
}

func (s *Server) handleRebase(w http.ResponseWriter, r *http.Request) {
	var req rebaseRequest
	if err := decodeBody(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	revs := commitsFromIds(req.Revisions)
	args := jj.Rebase(revs, req.Destination, "-r", "-d", req.SkipEmptied, req.IgnoreImmutable)
	output, err := s.Runner.Run(r.Context(), args)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"output": string(output)})
}

type squashRequest struct {
	Revisions              []string `json:"revisions"`
	Destination            string   `json:"destination"`
	KeepEmptied            bool     `json:"keep_emptied"`
	UseDestinationMessage  bool     `json:"use_destination_message"`
	IgnoreImmutable        bool     `json:"ignore_immutable"`
}

func (s *Server) handleSquash(w http.ResponseWriter, r *http.Request) {
	var req squashRequest
	if err := decodeBody(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	revs := commitsFromIds(req.Revisions)
	args := jj.Squash(revs, req.Destination, nil, req.KeepEmptied, req.UseDestinationMessage, false, req.IgnoreImmutable)
	output, err := s.Runner.Run(r.Context(), args)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"output": string(output)})
}

func (s *Server) handleUndo(w http.ResponseWriter, r *http.Request) {
	output, err := s.Runner.Run(r.Context(), jj.Undo())
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"output": string(output)})
}

type bookmarkSetRequest struct {
	Revision string `json:"revision"`
	Name     string `json:"name"`
}

func (s *Server) handleBookmarkSet(w http.ResponseWriter, r *http.Request) {
	var req bookmarkSetRequest
	if err := decodeBody(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	args := jj.BookmarkSet(req.Revision, req.Name)
	output, err := s.Runner.Run(r.Context(), args)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"output": string(output)})
}

type bookmarkDeleteRequest struct {
	Name string `json:"name"`
}

func (s *Server) handleBookmarkDelete(w http.ResponseWriter, r *http.Request) {
	var req bookmarkDeleteRequest
	if err := decodeBody(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	args := jj.BookmarkDelete(req.Name)
	output, err := s.Runner.Run(r.Context(), args)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"output": string(output)})
}

type gitPushRequest struct {
	Flags []string `json:"flags,omitempty"`
}

func (s *Server) handleGitPush(w http.ResponseWriter, r *http.Request) {
	var req gitPushRequest
	if err := decodeBody(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	args := jj.GitPush(req.Flags...)
	output, err := s.Runner.Run(r.Context(), args)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"output": string(output)})
}

type gitFetchRequest struct {
	Flags []string `json:"flags,omitempty"`
}

func (s *Server) handleGitFetch(w http.ResponseWriter, r *http.Request) {
	var req gitFetchRequest
	if err := decodeBody(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	args := jj.GitFetch(req.Flags...)
	output, err := s.Runner.Run(r.Context(), args)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"output": string(output)})
}

// --- Helpers ---

// parseLogOutput parses tab-delimited output from LogJSON into Revision structs.
func parseLogOutput(output string) ([]LogEntry, error) {
	var entries []LogEntry
	for _, line := range strings.Split(strings.TrimSpace(output), "\n") {
		if line == "" {
			continue
		}
		parts := strings.SplitN(line, "\t", 6)
		if len(parts) < 5 {
			continue
		}
		entry := LogEntry{
			ChangeId:     parts[0],
			CommitId:     parts[1],
			IsWorkingCopy: parts[2] == "true",
			Hidden:       parts[3] == "true",
			Description:  parts[4],
		}
		if len(parts) > 5 && parts[5] != "" {
			entry.Bookmarks = strings.Fields(parts[5])
		}
		entries = append(entries, entry)
	}
	return entries, nil
}

// LogEntry is the JSON response for a revision from `jj log`.
type LogEntry struct {
	ChangeId      string   `json:"change_id"`
	CommitId      string   `json:"commit_id"`
	IsWorkingCopy bool     `json:"is_working_copy"`
	Hidden        bool     `json:"hidden"`
	Description   string   `json:"description"`
	Bookmarks     []string `json:"bookmarks,omitempty"`
}

// commitsFromIds builds a SelectedRevisions from a list of change/commit IDs.
func commitsFromIds(ids []string) jj.SelectedRevisions {
	commits := make([]*jj.Commit, len(ids))
	for i, id := range ids {
		commits[i] = &jj.Commit{ChangeId: id}
	}
	return jj.NewSelectedRevisions(commits...)
}
