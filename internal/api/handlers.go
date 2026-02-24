package api

import (
	"fmt"
	"net/http"
	"strconv"
	"strings"

	"github.com/iant/lightjj/internal/jj"
	"github.com/iant/lightjj/internal/parser"
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
	s.refreshOpId() // seed/refresh cache on log fetch
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

// asyncResult holds the output of a background goroutine.
type asyncResult struct {
	output []byte
	err    error
}

func (s *Server) handleFiles(w http.ResponseWriter, r *http.Request) {
	revision := r.URL.Query().Get("revision")
	if revision == "" {
		s.writeError(w, http.StatusBadRequest, "revision is required")
		return
	}

	// Run summary, stat, and conflict list in parallel to minimize latency.
	statCh := make(chan asyncResult, 1)
	go func() {
		out, err := s.Runner.Run(r.Context(), jj.DiffStat(revision))
		statCh <- asyncResult{out, err}
	}()

	conflictCh := make(chan asyncResult, 1)
	go func() {
		out, err := s.Runner.Run(r.Context(), jj.ResolveList(revision))
		conflictCh <- asyncResult{out, err}
	}()

	summaryOutput, err := s.Runner.Run(r.Context(), jj.DiffSummary(revision))
	if err != nil {
		<-statCh     // drain buffered channels (goroutines self-exit)
		<-conflictCh
		s.writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	files := jj.ParseDiffSummary(string(summaryOutput))

	// Collect stat result and merge if successful
	sr := <-statCh
	if sr.err == nil {
		stats := jj.ParseDiffStat(string(sr.output))
		jj.MergeStats(files, stats)
	}

	// Collect conflict result and merge if successful
	cr := <-conflictCh
	if cr.err == nil {
		conflictPaths := jj.ParseResolveList(string(cr.output))
		files = jj.MergeConflicts(files, conflictPaths)
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

func (s *Server) handleFileShow(w http.ResponseWriter, r *http.Request) {
	revision := r.URL.Query().Get("revision")
	path := r.URL.Query().Get("path")
	if revision == "" || path == "" {
		s.writeError(w, http.StatusBadRequest, "revision and path are required")
		return
	}
	output, err := s.Runner.Run(r.Context(), jj.FileShow(revision, path))
	if err != nil {
		s.writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	s.writeJSON(w, r, http.StatusOK, map[string]string{"content": string(output)})
}
func (s *Server) handleWorkspaces(w http.ResponseWriter, r *http.Request) {
	args := jj.WorkspaceList()
	output, err := s.Runner.Run(r.Context(), args)
	if err != nil {
		s.writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	workspaces := jj.ParseWorkspaceList(string(output))
	s.writeJSON(w, r, http.StatusOK, workspaces)
}

// --- Write handlers ---

type newRequest struct {
	Revisions []string `json:"revisions"`
}

func (s *Server) handleNew(w http.ResponseWriter, r *http.Request) {
	var req newRequest
	if err := decodeBody(w, r, &req); err != nil {
		s.writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	if len(req.Revisions) == 0 {
		s.writeError(w, http.StatusBadRequest, "revisions is required")
		return
	}
	revs := jj.FromIDs(req.Revisions)
	s.runMutation(w, r, jj.New(revs))
}

type editRequest struct {
	Revision        string `json:"revision"`
	IgnoreImmutable bool   `json:"ignore_immutable"`
}

func (s *Server) handleEdit(w http.ResponseWriter, r *http.Request) {
	var req editRequest
	if err := decodeBody(w, r, &req); err != nil {
		s.writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	if req.Revision == "" {
		s.writeError(w, http.StatusBadRequest, "revision is required")
		return
	}
	s.runMutation(w, r, jj.Edit(req.Revision, req.IgnoreImmutable))
}

type abandonRequest struct {
	Revisions       []string `json:"revisions"`
	IgnoreImmutable bool     `json:"ignore_immutable"`
}

func (s *Server) handleAbandon(w http.ResponseWriter, r *http.Request) {
	var req abandonRequest
	if err := decodeBody(w, r, &req); err != nil {
		s.writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	if len(req.Revisions) == 0 {
		s.writeError(w, http.StatusBadRequest, "revisions is required")
		return
	}
	revs := jj.FromIDs(req.Revisions)
	s.runMutation(w, r, jj.Abandon(revs, req.IgnoreImmutable))
}

type describeRequest struct {
	Revision    string `json:"revision"`
	Description string `json:"description"`
}

func (s *Server) handleDescribe(w http.ResponseWriter, r *http.Request) {
	var req describeRequest
	if err := decodeBody(w, r, &req); err != nil {
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
	go s.refreshOpId()
	s.writeJSON(w, r, http.StatusOK, map[string]string{"output": string(output)})
}

type rebaseRequest struct {
	Revisions       []string `json:"revisions"`
	Destination     string   `json:"destination"`
	SourceMode      string   `json:"source_mode"`
	TargetMode      string   `json:"target_mode"`
	SkipEmptied     bool     `json:"skip_emptied"`
	IgnoreImmutable bool     `json:"ignore_immutable"`
}

var validSourceModes = map[string]bool{"-r": true, "-s": true, "-b": true}
var validTargetModes = map[string]bool{"-d": true, "--insert-after": true, "--insert-before": true}

// defaultAndValidate returns val if non-empty, otherwise defaultVal. Returns an
// error if the resolved value is not in the allowed set.
func defaultAndValidate(val, defaultVal string, allowed map[string]bool) (string, error) {
	if val == "" {
		val = defaultVal
	}
	if !allowed[val] {
		return "", fmt.Errorf("invalid value: %s", val)
	}
	return val, nil
}

func (s *Server) handleRebase(w http.ResponseWriter, r *http.Request) {
	var req rebaseRequest
	if err := decodeBody(w, r, &req); err != nil {
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
	sourceMode, err := defaultAndValidate(req.SourceMode, "-r", validSourceModes)
	if err != nil {
		s.writeError(w, http.StatusBadRequest, "invalid source_mode")
		return
	}
	targetMode, err := defaultAndValidate(req.TargetMode, "-d", validTargetModes)
	if err != nil {
		s.writeError(w, http.StatusBadRequest, "invalid target_mode")
		return
	}
	revs := jj.FromIDs(req.Revisions)
	s.runMutation(w, r, jj.Rebase(revs, req.Destination, sourceMode, targetMode, req.SkipEmptied, req.IgnoreImmutable))
}

type squashRequest struct {
	Revisions             []string `json:"revisions"`
	Destination           string   `json:"destination"`
	Files                 []string `json:"files"`
	KeepEmptied           bool     `json:"keep_emptied"`
	UseDestinationMessage bool     `json:"use_destination_message"`
	IgnoreImmutable       bool     `json:"ignore_immutable"`
}

func (s *Server) handleSquash(w http.ResponseWriter, r *http.Request) {
	var req squashRequest
	if err := decodeBody(w, r, &req); err != nil {
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
	revs := jj.FromIDs(req.Revisions)
	s.runMutation(w, r, jj.Squash(revs, req.Destination, req.Files, req.KeepEmptied, req.UseDestinationMessage, false, req.IgnoreImmutable))
}

func (s *Server) handleUndo(w http.ResponseWriter, r *http.Request) {
	if err := decodeBody(w, r, &struct{}{}); err != nil {
		s.writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	s.runMutation(w, r, jj.Undo())
}

func (s *Server) handleOpLog(w http.ResponseWriter, r *http.Request) {
	limit := 50
	if l := r.URL.Query().Get("limit"); l != "" {
		n, err := strconv.Atoi(l)
		if err != nil {
			s.writeError(w, http.StatusBadRequest, "limit must be an integer")
			return
		}
		if n > 0 && n <= 1000 {
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
	if err := decodeBody(w, r, &req); err != nil {
		s.writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	if req.Revision == "" || req.Name == "" {
		s.writeError(w, http.StatusBadRequest, "revision and name are required")
		return
	}
	s.runMutation(w, r, jj.BookmarkSet(req.Revision, req.Name))
}

func (s *Server) handleBookmarkDelete(w http.ResponseWriter, r *http.Request) {
	var req bookmarkNameRequest
	if err := decodeBody(w, r, &req); err != nil {
		s.writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	if req.Name == "" {
		s.writeError(w, http.StatusBadRequest, "name is required")
		return
	}
	s.runMutation(w, r, jj.BookmarkDelete(req.Name))
}

func (s *Server) handleBookmarkMove(w http.ResponseWriter, r *http.Request) {
	var req bookmarkRevisionRequest
	if err := decodeBody(w, r, &req); err != nil {
		s.writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	if req.Revision == "" || req.Name == "" {
		s.writeError(w, http.StatusBadRequest, "revision and name are required")
		return
	}
	s.runMutation(w, r, jj.BookmarkMove(req.Revision, req.Name, "--allow-backwards"))
}

func (s *Server) handleBookmarkForget(w http.ResponseWriter, r *http.Request) {
	var req bookmarkNameRequest
	if err := decodeBody(w, r, &req); err != nil {
		s.writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	if req.Name == "" {
		s.writeError(w, http.StatusBadRequest, "name is required")
		return
	}
	s.runMutation(w, r, jj.BookmarkForget(req.Name))
}

func (s *Server) handleBookmarkTrack(w http.ResponseWriter, r *http.Request) {
	var req bookmarkRemoteRequest
	if err := decodeBody(w, r, &req); err != nil {
		s.writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	if req.Name == "" {
		s.writeError(w, http.StatusBadRequest, "name is required")
		return
	}
	s.runMutation(w, r, jj.BookmarkTrack(req.Name, req.Remote))
}

func (s *Server) handleBookmarkUntrack(w http.ResponseWriter, r *http.Request) {
	var req bookmarkRemoteRequest
	if err := decodeBody(w, r, &req); err != nil {
		s.writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	if req.Name == "" {
		s.writeError(w, http.StatusBadRequest, "name is required")
		return
	}
	s.runMutation(w, r, jj.BookmarkUntrack(req.Name, req.Remote))
}

func (s *Server) handleGitPush(w http.ResponseWriter, r *http.Request) {
	var req gitFlagsRequest
	if err := decodeBody(w, r, &req); err != nil {
		s.writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	if err := validateFlags(req.Flags, allowedGitPushFlags); err != nil {
		s.writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	s.runMutation(w, r, jj.GitPush(req.Flags...))
}

type splitRequest struct {
	Revision string   `json:"revision"`
	Files    []string `json:"files"`
	Parallel bool     `json:"parallel"`
}

func (s *Server) handleSplit(w http.ResponseWriter, r *http.Request) {
	var req splitRequest
	if err := decodeBody(w, r, &req); err != nil {
		s.writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	if req.Revision == "" {
		s.writeError(w, http.StatusBadRequest, "revision is required")
		return
	}
	if len(req.Files) == 0 {
		s.writeError(w, http.StatusBadRequest, "files is required")
		return
	}
	s.runMutation(w, r, jj.Split(req.Revision, req.Files, req.Parallel, false))
}

func (s *Server) handleGitFetch(w http.ResponseWriter, r *http.Request) {
	var req gitFlagsRequest
	if err := decodeBody(w, r, &req); err != nil {
		s.writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	if err := validateFlags(req.Flags, allowedGitFetchFlags); err != nil {
		s.writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	s.runMutation(w, r, jj.GitFetch(req.Flags...))
}

// Whitelisted merge tools for resolve to prevent arbitrary tool execution.
var allowedResolveTools = map[string]bool{":ours": true, ":theirs": true}

type resolveRequest struct {
	Revision string `json:"revision"`
	File     string `json:"file"`
	Tool     string `json:"tool"` // ":ours" or ":theirs"
}

func (s *Server) handleResolve(w http.ResponseWriter, r *http.Request) {
	var req resolveRequest
	if err := decodeBody(w, r, &req); err != nil {
		s.writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	if req.Revision == "" || req.File == "" || req.Tool == "" {
		s.writeError(w, http.StatusBadRequest, "revision, file, and tool are required")
		return
	}
	if !allowedResolveTools[req.Tool] {
		s.writeError(w, http.StatusBadRequest, "tool must be :ours or :theirs")
		return
	}
	s.runMutation(w, r, jj.Resolve(req.Revision, req.File, req.Tool))
}

