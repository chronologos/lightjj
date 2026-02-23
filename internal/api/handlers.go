package api

import (
	"fmt"
	"net/http"
	"strconv"
	"strings"

	"github.com/chronologos/lightjj/internal/jj"
	"github.com/chronologos/lightjj/internal/parser"
)

// Whitelisted flags for git push/fetch to prevent injection of arbitrary jj flags.
var allowedGitPushFlags = map[string]bool{
	"--bookmark": true,
	"--change":   true,
	"--all":      true,
	"--deleted":  true,
	"--remote":   true,
	"--dry-run":  true,
	"--tracked":  true,
}

var allowedGitFetchFlags = map[string]bool{
	"--remote":      true,
	"--all-remotes": true,
	"--branch":      true,
	"--tracked":     true,
}

// validateFlags checks that every element in flags is either an allowed flag
// or a bare value (argument to a preceding flag). Any string starting with "-"
// (single or double dash) must be in the allowed set. This prevents injection
// of arbitrary jj flags via single-dash variants.
func validateFlags(flags []string, allowed map[string]bool) error {
	for _, f := range flags {
		if !strings.HasPrefix(f, "-") {
			// Bare value (argument to a preceding flag), not a flag itself.
			continue
		}
		key := f
		if idx := strings.Index(f, "="); idx > 0 {
			key = f[:idx]
		}
		if !allowed[key] {
			return fmt.Errorf("flag not allowed: %s", f)
		}
	}
	return nil
}

// --- Read handlers ---

func (s *Server) handleLog(w http.ResponseWriter, r *http.Request) {
	revset := r.URL.Query().Get("revset")
	limitStr := r.URL.Query().Get("limit")
	var limit int
	if limitStr != "" {
		var err error
		limit, err = strconv.Atoi(limitStr)
		if err != nil {
			s.writeError(w, http.StatusBadRequest, "limit must be an integer")
			return
		}
	}

	args := jj.LogGraph(revset, limit)
	output, err := s.Runner.Run(r.Context(), args)
	if err != nil {
		s.writeError(w, http.StatusInternalServerError, err.Error())
		return
	}

	rows := parser.ParseGraphLog(string(output))
	s.refreshOpId(r) // seed/refresh cache on log fetch
	s.writeJSON(w, r, http.StatusOK, rows)
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
		s.writeError(w, http.StatusInternalServerError, err.Error())
		return
	}

	bookmarks := jj.ParseBookmarkListOutput(string(output))
	s.writeJSON(w, r, http.StatusOK, bookmarks)
}

func (s *Server) handleDiff(w http.ResponseWriter, r *http.Request) {
	revision := r.URL.Query().Get("revision")
	if revision == "" {
		s.writeError(w, http.StatusBadRequest, "revision is required")
		return
	}
	file := r.URL.Query().Get("file")

	extraArgs := []string{"--tool", ":git"}
	if ctx := r.URL.Query().Get("context"); ctx != "" {
		if n, err := strconv.Atoi(ctx); err == nil && n > 0 && n <= 100000 {
			extraArgs = append(extraArgs, "--context", ctx)
		}
	}
	args := jj.Diff(revision, file, "never", extraArgs...)
	output, err := s.Runner.Run(r.Context(), args)
	if err != nil {
		s.writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	s.writeJSON(w, r, http.StatusOK, map[string]string{"diff": string(output)})
}

func (s *Server) handleStatus(w http.ResponseWriter, r *http.Request) {
	revision := r.URL.Query().Get("revision")
	if revision == "" {
		s.writeError(w, http.StatusBadRequest, "revision is required")
		return
	}

	args := jj.Status(revision)
	output, err := s.Runner.Run(r.Context(), args)
	if err != nil {
		s.writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	s.writeJSON(w, r, http.StatusOK, map[string]string{"status": string(output)})
}

func (s *Server) handleFiles(w http.ResponseWriter, r *http.Request) {
	revision := r.URL.Query().Get("revision")
	if revision == "" {
		s.writeError(w, http.StatusBadRequest, "revision is required")
		return
	}

	summaryArgs := jj.DiffSummary(revision)
	summaryOutput, err := s.Runner.Run(r.Context(), summaryArgs)
	if err != nil {
		s.writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	files := jj.ParseDiffSummary(string(summaryOutput))

	// Fetch stat counts and merge into file list
	statArgs := jj.DiffStat(revision)
	statOutput, err := s.Runner.Run(r.Context(), statArgs)
	if err == nil {
		stats := jj.ParseDiffStat(string(statOutput))
		jj.MergeStats(files, stats)
	}

	s.writeJSON(w, r, http.StatusOK, files)
}

func (s *Server) handleGetDescription(w http.ResponseWriter, r *http.Request) {
	revision := r.URL.Query().Get("revision")
	if revision == "" {
		s.writeError(w, http.StatusBadRequest, "revision is required")
		return
	}

	args := jj.GetDescription(revision)
	output, err := s.Runner.Run(r.Context(), args)
	if err != nil {
		s.writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	s.writeJSON(w, r, http.StatusOK, map[string]string{"description": string(output)})
}

func (s *Server) handleRemotes(w http.ResponseWriter, r *http.Request) {
	args := jj.GitRemoteList()
	output, err := s.Runner.Run(r.Context(), args)
	if err != nil {
		s.writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	remotes := jj.ParseRemoteListOutput(string(output), "origin")
	s.writeJSON(w, r, http.StatusOK, remotes)
}

// --- Write handlers ---

type newRequest struct {
	Revisions []string `json:"revisions"`
}

func (s *Server) handleNew(w http.ResponseWriter, r *http.Request) {
	var req newRequest
	if err := decodeBody(r, &req); err != nil {
		s.writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	revs := commitsFromIds(req.Revisions)
	args := jj.New(revs)
	output, err := s.Runner.Run(r.Context(), args)
	if err != nil {
		s.writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	s.refreshOpId(r)
	s.writeJSON(w, r, http.StatusOK, map[string]string{"output": string(output)})
}

type editRequest struct {
	Revision         string `json:"revision"`
	IgnoreImmutable  bool   `json:"ignore_immutable"`
}

func (s *Server) handleEdit(w http.ResponseWriter, r *http.Request) {
	var req editRequest
	if err := decodeBody(r, &req); err != nil {
		s.writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	if req.Revision == "" {
		s.writeError(w, http.StatusBadRequest, "revision is required")
		return
	}
	args := jj.Edit(req.Revision, req.IgnoreImmutable)
	output, err := s.Runner.Run(r.Context(), args)
	if err != nil {
		s.writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	s.refreshOpId(r)
	s.writeJSON(w, r, http.StatusOK, map[string]string{"output": string(output)})
}

type abandonRequest struct {
	Revisions        []string `json:"revisions"`
	IgnoreImmutable  bool     `json:"ignore_immutable"`
}

func (s *Server) handleAbandon(w http.ResponseWriter, r *http.Request) {
	var req abandonRequest
	if err := decodeBody(r, &req); err != nil {
		s.writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	revs := commitsFromIds(req.Revisions)
	args := jj.Abandon(revs, req.IgnoreImmutable)
	output, err := s.Runner.Run(r.Context(), args)
	if err != nil {
		s.writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	s.refreshOpId(r)
	s.writeJSON(w, r, http.StatusOK, map[string]string{"output": string(output)})
}

type describeRequest struct {
	Revision    string `json:"revision"`
	Description string `json:"description"`
}

func (s *Server) handleDescribe(w http.ResponseWriter, r *http.Request) {
	var req describeRequest
	if err := decodeBody(r, &req); err != nil {
		s.writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	if req.Revision == "" {
		s.writeError(w, http.StatusBadRequest, "revision is required")
		return
	}
	args, stdin := jj.SetDescription(req.Revision, req.Description)
	output, err := s.Runner.RunWithInput(r.Context(), args, stdin)
	if err != nil {
		s.writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	s.refreshOpId(r)
	s.writeJSON(w, r, http.StatusOK, map[string]string{"output": string(output)})
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
		s.writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	if len(req.Revisions) == 0 {
		s.writeError(w, http.StatusBadRequest, "revisions is required")
		return
	}
	if req.Destination == "" {
		s.writeError(w, http.StatusBadRequest, "destination is required")
		return
	}
	revs := commitsFromIds(req.Revisions)
	args := jj.Rebase(revs, req.Destination, "-r", "-d", req.SkipEmptied, req.IgnoreImmutable)
	output, err := s.Runner.Run(r.Context(), args)
	if err != nil {
		s.writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	s.refreshOpId(r)
	s.writeJSON(w, r, http.StatusOK, map[string]string{"output": string(output)})
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
		s.writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	if len(req.Revisions) == 0 {
		s.writeError(w, http.StatusBadRequest, "revisions is required")
		return
	}
	if req.Destination == "" {
		s.writeError(w, http.StatusBadRequest, "destination is required")
		return
	}
	revs := commitsFromIds(req.Revisions)
	args := jj.Squash(revs, req.Destination, nil, req.KeepEmptied, req.UseDestinationMessage, false, req.IgnoreImmutable)
	output, err := s.Runner.Run(r.Context(), args)
	if err != nil {
		s.writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	s.refreshOpId(r)
	s.writeJSON(w, r, http.StatusOK, map[string]string{"output": string(output)})
}

func (s *Server) handleUndo(w http.ResponseWriter, r *http.Request) {
	output, err := s.Runner.Run(r.Context(), jj.Undo())
	if err != nil {
		s.writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	s.refreshOpId(r)
	s.writeJSON(w, r, http.StatusOK, map[string]string{"output": string(output)})
}

func (s *Server) handleOpLog(w http.ResponseWriter, r *http.Request) {
	limit := 50
	if l := r.URL.Query().Get("limit"); l != "" {
		if n, err := strconv.Atoi(l); err == nil && n > 0 {
			limit = n
		}
	}
	args := jj.OpLog(limit)
	output, err := s.Runner.Run(r.Context(), args)
	if err != nil {
		s.writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	entries := jj.ParseOpLog(string(output))
	s.writeJSON(w, r, http.StatusOK, entries)
}

func (s *Server) handleEvolog(w http.ResponseWriter, r *http.Request) {
	revision := r.URL.Query().Get("revision")
	if revision == "" {
		s.writeError(w, http.StatusBadRequest, "revision is required")
		return
	}
	args := jj.Evolog(revision)
	output, err := s.Runner.Run(r.Context(), args)
	if err != nil {
		s.writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	s.writeJSON(w, r, http.StatusOK, map[string]string{"output": string(output)})
}

type bookmarkRevisionRequest struct {
	Revision string `json:"revision"`
	Name     string `json:"name"`
}

type bookmarkNameRequest struct {
	Name string `json:"name"`
}

type bookmarkRemoteRequest struct {
	Name   string `json:"name"`
	Remote string `json:"remote"`
}

type gitFlagsRequest struct {
	Flags []string `json:"flags,omitempty"`
}

func (s *Server) handleBookmarkSet(w http.ResponseWriter, r *http.Request) {
	var req bookmarkRevisionRequest
	if err := decodeBody(r, &req); err != nil {
		s.writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	if req.Revision == "" || req.Name == "" {
		s.writeError(w, http.StatusBadRequest, "revision and name are required")
		return
	}
	args := jj.BookmarkSet(req.Revision, req.Name)
	output, err := s.Runner.Run(r.Context(), args)
	if err != nil {
		s.writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	s.refreshOpId(r)
	s.writeJSON(w, r, http.StatusOK, map[string]string{"output": string(output)})
}

func (s *Server) handleBookmarkDelete(w http.ResponseWriter, r *http.Request) {
	var req bookmarkNameRequest
	if err := decodeBody(r, &req); err != nil {
		s.writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	if req.Name == "" {
		s.writeError(w, http.StatusBadRequest, "name is required")
		return
	}
	args := jj.BookmarkDelete(req.Name)
	output, err := s.Runner.Run(r.Context(), args)
	if err != nil {
		s.writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	s.refreshOpId(r)
	s.writeJSON(w, r, http.StatusOK, map[string]string{"output": string(output)})
}

func (s *Server) handleBookmarkMove(w http.ResponseWriter, r *http.Request) {
	var req bookmarkRevisionRequest
	if err := decodeBody(r, &req); err != nil {
		s.writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	if req.Revision == "" || req.Name == "" {
		s.writeError(w, http.StatusBadRequest, "revision and name are required")
		return
	}
	args := jj.BookmarkMove(req.Revision, req.Name, "--allow-backwards")
	output, err := s.Runner.Run(r.Context(), args)
	if err != nil {
		s.writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	s.refreshOpId(r)
	s.writeJSON(w, r, http.StatusOK, map[string]string{"output": string(output)})
}

func (s *Server) handleBookmarkForget(w http.ResponseWriter, r *http.Request) {
	var req bookmarkNameRequest
	if err := decodeBody(r, &req); err != nil {
		s.writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	if req.Name == "" {
		s.writeError(w, http.StatusBadRequest, "name is required")
		return
	}
	args := jj.BookmarkForget(req.Name)
	output, err := s.Runner.Run(r.Context(), args)
	if err != nil {
		s.writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	s.refreshOpId(r)
	s.writeJSON(w, r, http.StatusOK, map[string]string{"output": string(output)})
}

func (s *Server) handleBookmarkTrack(w http.ResponseWriter, r *http.Request) {
	var req bookmarkRemoteRequest
	if err := decodeBody(r, &req); err != nil {
		s.writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	if req.Name == "" {
		s.writeError(w, http.StatusBadRequest, "name is required")
		return
	}
	args := jj.BookmarkTrack(req.Name, req.Remote)
	output, err := s.Runner.Run(r.Context(), args)
	if err != nil {
		s.writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	s.refreshOpId(r)
	s.writeJSON(w, r, http.StatusOK, map[string]string{"output": string(output)})
}

func (s *Server) handleBookmarkUntrack(w http.ResponseWriter, r *http.Request) {
	var req bookmarkRemoteRequest
	if err := decodeBody(r, &req); err != nil {
		s.writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	if req.Name == "" {
		s.writeError(w, http.StatusBadRequest, "name is required")
		return
	}
	args := jj.BookmarkUntrack(req.Name, req.Remote)
	output, err := s.Runner.Run(r.Context(), args)
	if err != nil {
		s.writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	s.refreshOpId(r)
	s.writeJSON(w, r, http.StatusOK, map[string]string{"output": string(output)})
}

func (s *Server) handleGitPush(w http.ResponseWriter, r *http.Request) {
	var req gitFlagsRequest
	if err := decodeBody(r, &req); err != nil {
		s.writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	if err := validateFlags(req.Flags, allowedGitPushFlags); err != nil {
		s.writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	args := jj.GitPush(req.Flags...)
	output, err := s.Runner.Run(r.Context(), args)
	if err != nil {
		s.writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	s.refreshOpId(r)
	s.writeJSON(w, r, http.StatusOK, map[string]string{"output": string(output)})
}

func (s *Server) handleGitFetch(w http.ResponseWriter, r *http.Request) {
	var req gitFlagsRequest
	if err := decodeBody(r, &req); err != nil {
		s.writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	if err := validateFlags(req.Flags, allowedGitFetchFlags); err != nil {
		s.writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	args := jj.GitFetch(req.Flags...)
	output, err := s.Runner.Run(r.Context(), args)
	if err != nil {
		s.writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	s.refreshOpId(r)
	s.writeJSON(w, r, http.StatusOK, map[string]string{"output": string(output)})
}

// --- Helpers ---

// commitsFromIds builds a SelectedRevisions from a list of change/commit IDs.
func commitsFromIds(ids []string) jj.SelectedRevisions {
	commits := make([]*jj.Commit, len(ids))
	for i, id := range ids {
		commits[i] = &jj.Commit{ChangeId: id}
	}
	return jj.NewSelectedRevisions(commits...)
}
