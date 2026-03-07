package api

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"slices"
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
	// Cap unbounded requests to prevent runaway fetches on large repos.
	// Default: 500 commits (typically covers months of history).
	if limit <= 0 {
		limit = 500
	} else if limit > 1000 {
		limit = 1000
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

	bookmarks := jj.ParseBookmarkListOutput(string(output), s.DefaultRemote)

	// ?local=true filters to bookmarks with a local ref — used by the
	// bookmark modal to hide remote-only tracking entries.
	if r.URL.Query().Get("local") == "true" {
		filtered := make([]jj.Bookmark, 0, len(bookmarks))
		for _, bm := range bookmarks {
			if bm.Local != nil {
				filtered = append(filtered, bm)
			}
		}
		bookmarks = filtered
	}

	s.writeJSON(w, r, http.StatusOK, bookmarks)
}

// maybeCacheForever sets Cache-Control: immutable when the client signals
// (via ?immutable=1) that the revision query param is a commit_id. Commit_id
// is a content hash — the response for a given commit_id is valid forever.
// Browser disk cache survives page reload; our in-memory cache doesn't. The
// backend can't tell commit_id from change_id on its own (both are hex
// strings), so the frontend opts in.
//
// Currently only handleRevision uses this — it's the nav hot path and the
// only endpoint the frontend marks. Setting this header also suppresses
// X-JJ-Op-Id in writeJSON (a year-old op-id baked into disk cache would
// trigger spurious staleness fires on reload).
func maybeCacheForever(w http.ResponseWriter, r *http.Request) {
	if r.URL.Query().Get("immutable") == "1" {
		w.Header().Set("Cache-Control", "max-age=31536000, immutable")
	}
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

// asyncResult holds the output of a background goroutine.
// Channels carrying these values are buffered (cap 1) — the goroutine writes
// and exits immediately. If the handler returns early without reading, the
// channel is GC'd with its buffered value; no drain required.
type asyncResult struct {
	output []byte
	err    error
}

// runAsync starts a jj command in a goroutine and returns a buffered channel
// that will receive exactly one result. Safe to abandon — the goroutine exits
// after its single write regardless of whether anyone reads.
func (s *Server) runAsync(ctx context.Context, args []string) <-chan asyncResult {
	ch := make(chan asyncResult, 1)
	go func() {
		out, err := s.Runner.Run(ctx, args)
		ch <- asyncResult{out, err}
	}()
	return ch
}

func (s *Server) handleFiles(w http.ResponseWriter, r *http.Request) {
	revision := r.URL.Query().Get("revision")
	if revision == "" {
		s.writeError(w, http.StatusBadRequest, "revision is required")
		return
	}

	output, err := s.Runner.Run(r.Context(), jj.FilesTemplate(revision))
	if err != nil {
		s.writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	s.writeJSON(w, r, http.StatusOK, jj.ParseFilesTemplate(string(output)))
}

// handleDivergence returns the classification dataset: mutable divergent
// commits + their descendants, with parent-change-ids/wc-reachable/empty
// signals. Classification (stack grouping, kind, tautology guard) happens
// client-side — this is pure data. See docs/jj-divergence.md.
func (s *Server) handleDivergence(w http.ResponseWriter, r *http.Request) {
	output, err := s.Runner.Run(r.Context(), jj.Divergence())
	if err != nil {
		s.writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	s.writeJSON(w, r, http.StatusOK, jj.ParseDivergence(string(output)))
}

// revisionResponse is the batch payload for diff + files + description.
// Matches the shape of the three individual endpoints' combined output so the
// frontend can seed individual cache keys from a single fetch.
type revisionResponse struct {
	Diff        string          `json:"diff"`
	Files       []jj.FileChange `json:"files"`
	Description string          `json:"description"`
}

// handleRevision batches diff + files + description into a single response.
// Three underlying jj commands run in parallel. Over SSH this turns three
// ~440ms round-trips into one HTTP round-trip (goroutines share the TCP/SSH
// setup cost only on LocalRunner; for SSHRunner each is still a separate
// ssh exec).
//
// Error policy: diff/files failures are hard errors (the revision likely
// doesn't exist). Description failure is soft — not load-bearing for the
// diff panel.
func (s *Server) handleRevision(w http.ResponseWriter, r *http.Request) {
	revision := r.URL.Query().Get("revision")
	if revision == "" {
		s.writeError(w, http.StatusBadRequest, "revision is required")
		return
	}

	ctx := r.Context()
	diffCh := s.runAsync(ctx, jj.Diff(revision, "", "never", "--tool", ":git"))
	descCh := s.runAsync(ctx, jj.GetDescription(revision))

	// Files template runs on the request goroutine — gives an early hard-error
	// signal if the revision doesn't exist, before we bother parsing the rest.
	filesOutput, err := s.Runner.Run(ctx, jj.FilesTemplate(revision))
	if err != nil {
		s.writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	files := jj.ParseFilesTemplate(string(filesOutput))

	dr := <-diffCh
	if dr.err != nil {
		s.writeError(w, http.StatusInternalServerError, dr.err.Error())
		return
	}

	var desc string
	descR := <-descCh
	if descR.err == nil {
		desc = string(descR.output)
		maybeCacheForever(w, r)
	} else {
		// Degraded response — don't cache forever. A transient failure would
		// otherwise bake description:"" into the browser disk cache for a year.
		log.Printf("handleRevision: GetDescription failed for %s: %v", revision, descR.err)
	}
	s.writeJSON(w, r, http.StatusOK, revisionResponse{
		Diff:        string(dr.output),
		Files:       files,
		Description: desc,
	})
}

// handleFilesBatch returns file stats for multiple commits in a single jj
// subprocess call. Used by the frontend to pre-load the file-list sidebar for
// a window of revisions around the current selection.
//
// Query: ?revisions=abc,def,ghi (comma-separated short commit_ids)
// Response: map[commitId]{conflict: bool, files: FileChange[]}
//
// Conflicted commits return files WITHOUT side-count detail; the client should
// fall back to /api/files for those. This keeps the batch call at one
// template iteration (DiffStatEntry doesn't expose .target().conflict_side_count()).
func (s *Server) handleFilesBatch(w http.ResponseWriter, r *http.Request) {
	revStr := r.URL.Query().Get("revisions")
	if revStr == "" {
		s.writeError(w, http.StatusBadRequest, "revisions is required")
		return
	}
	// Filter empty strings — trailing/double commas produce invalid revsets.
	// The frontend never sends them, but direct API calls might.
	commitIds := slices.DeleteFunc(strings.Split(revStr, ","), func(s string) bool { return s == "" })
	if len(commitIds) == 0 {
		s.writeError(w, http.StatusBadRequest, "revisions is required")
		return
	}
	if len(commitIds) > 50 {
		s.writeError(w, http.StatusBadRequest, "too many revisions (max 50)")
		return
	}

	args := jj.FilesBatch(commitIds)
	output, err := s.Runner.Run(r.Context(), args)
	if err != nil {
		s.writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	result := jj.ParseFilesBatch(string(output))
	s.writeJSON(w, r, http.StatusOK, result)
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
	remotes := jj.ParseRemoteListOutput(string(output), s.DefaultRemote)
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

func (s *Server) handleInfo(w http.ResponseWriter, r *http.Request) {
	s.writeJSON(w, r, http.StatusOK, map[string]string{
		"hostname":  s.Hostname,
		"repo_path": s.RepoPath,
	})
}

type workspacesResponse struct {
	Current    string              `json:"current"`
	Workspaces []workspaceWithPath `json:"workspaces"`
}

type workspaceWithPath struct {
	Name     string `json:"name"`
	ChangeId string `json:"change_id"`
	CommitId string `json:"commit_id"`
	Path     string `json:"path,omitempty"`
}

func (s *Server) handleWorkspaces(w http.ResponseWriter, r *http.Request) {
	args := jj.WorkspaceList()
	output, err := s.Runner.Run(r.Context(), args)
	if err != nil {
		s.writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	workspaces := jj.ParseWorkspaceList(string(output))

	// Enrich with paths from workspace store (best-effort — for tab-open)
	pathMap, _ := s.readWorkspaceStore(r.Context())

	current := ""
	resp := workspacesResponse{Workspaces: make([]workspaceWithPath, len(workspaces))}
	for i, ws := range workspaces {
		resp.Workspaces[i] = workspaceWithPath{
			Name:     ws.Name,
			ChangeId: ws.ChangeId,
			CommitId: ws.CommitId,
			Path:     pathMap[ws.Name],
		}
		if ws.Current {
			current = ws.Name
		}
	}
	resp.Current = current
	s.writeJSON(w, r, http.StatusOK, resp)
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

type restoreRequest struct {
	Revision string   `json:"revision"`
	Files    []string `json:"files"`
}

func (s *Server) handleRestore(w http.ResponseWriter, r *http.Request) {
	var req restoreRequest
	if err := decodeBody(w, r, &req); err != nil {
		s.writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	if req.Revision == "" {
		s.writeError(w, http.StatusBadRequest, "revision is required")
		return
	}
	// `jj restore -c X` with no files empties the whole revision. That's
	// abandon's job — enforce at least one non-empty file so a frontend bug
	// can't silently nuke a commit's content. [""] is rejected too:
	// `root-file:""` is a fileset expression, not "no file".
	if len(req.Files) == 0 || slices.Contains(req.Files, "") {
		s.writeError(w, http.StatusBadRequest, "files is required")
		return
	}
	s.runMutation(w, r, jj.Restore(req.Revision, req.Files))
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
	s.refreshOpId()
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

// handleSnapshot asks jj to observe the working copy on demand. Called by the
// frontend on tab focus so users don't wait up to 5s for the periodic loop
// after editing in another terminal. If the WC is unchanged, op_heads doesn't
// advance and the frontend's notifyOpId dedup makes this a no-op. Works in SSH
// mode too (no fsnotify there — the X-JJ-Op-Id header carries the refresh).
func (s *Server) handleSnapshot(w http.ResponseWriter, r *http.Request) {
	if err := decodeBody(w, r, &struct{}{}); err != nil {
		s.writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	s.runMutation(w, r, jj.DebugSnapshot())
}

func (s *Server) handleCommit(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Message string `json:"message"`
	}
	if err := decodeBody(w, r, &req); err != nil {
		s.writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	s.runMutation(w, r, jj.CommitWorkingCopy(req.Message))
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

func (s *Server) handleDiffRange(w http.ResponseWriter, r *http.Request) {
	from := r.URL.Query().Get("from")
	to := r.URL.Query().Get("to")
	if from == "" || to == "" {
		s.writeError(w, http.StatusBadRequest, "from and to are required")
		return
	}
	files := r.URL.Query()["files"] // repeated params: ?files=a&files=b
	output, err := s.Runner.Run(r.Context(), jj.DiffRange(from, to, files))
	if err != nil {
		s.writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	s.writeJSON(w, r, http.StatusOK, map[string]string{"diff": string(output)})
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
	entries := jj.ParseEvolog(string(output))
	s.writeJSON(w, r, http.StatusOK, entries)
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

func (s *Server) handleBookmarkAdvance(w http.ResponseWriter, r *http.Request) {
	var req bookmarkRevisionRequest
	if err := decodeBody(w, r, &req); err != nil {
		s.writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	if req.Revision == "" || req.Name == "" {
		s.writeError(w, http.StatusBadRequest, "revision and name are required")
		return
	}
	s.runMutation(w, r, jj.BookmarkAdvance(req.Revision, req.Name))
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
	if req.Name == "" || req.Remote == "" {
		s.writeError(w, http.StatusBadRequest, "name and remote are required")
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
	if req.Name == "" || req.Remote == "" {
		s.writeError(w, http.StatusBadRequest, "name and remote are required")
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
	s.streamMutation(w, r, jj.GitPush(req.Flags...))
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
	s.streamMutation(w, r, jj.GitFetch(req.Flags...))
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

func (s *Server) handleAliases(w http.ResponseWriter, r *http.Request) {
	output, err := s.Runner.Run(r.Context(), jj.ConfigListAliases())
	if err != nil {
		// No aliases configured is not an error — return empty list
		s.writeJSON(w, r, http.StatusOK, []jj.Alias{})
		return
	}
	aliases := jj.ParseAliases(string(output))
	s.writeJSON(w, r, http.StatusOK, aliases)
}

type runAliasRequest struct {
	Name string `json:"name"`
}

func (s *Server) handleRunAlias(w http.ResponseWriter, r *http.Request) {
	var req runAliasRequest
	if err := decodeBody(w, r, &req); err != nil {
		s.writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	if req.Name == "" {
		s.writeError(w, http.StatusBadRequest, "name is required")
		return
	}

	// Validate alias name against actual alias list to prevent arbitrary command execution
	output, err := s.Runner.Run(r.Context(), jj.ConfigListAliases())
	if err != nil {
		s.writeError(w, http.StatusInternalServerError, "failed to list aliases")
		return
	}
	aliases := jj.ParseAliases(string(output))
	if !slices.ContainsFunc(aliases, func(a jj.Alias) bool { return a.Name == req.Name }) {
		s.writeError(w, http.StatusBadRequest, fmt.Sprintf("unknown alias: %s", req.Name))
		return
	}

	s.runMutation(w, r, []string{req.Name})
}

// --- Pull requests ---

// PullRequest maps a GitHub PR to a bookmark (branch) name.
type PullRequest struct {
	Bookmark string `json:"bookmark"`
	URL      string `json:"url"`
	Number   int    `json:"number"`
	IsDraft  bool   `json:"is_draft"`
}

// ghPRListArgv is the gh invocation for listing the current user's open PRs.
// Passed to Runner.RunRaw so it executes where the repo lives (local or SSH).
// STATIC — never append request-derived input; this flows to a remote shell
// via SSHRunner.wrapRaw.
var ghPRListArgv = []string{
	"gh", "pr", "list",
	"--state", "open",
	"--author", "@me",
	"--json", "headRefName,url,number,isDraft",
	"--limit", "100",
}

func (s *Server) handlePullRequests(w http.ResponseWriter, r *http.Request) {
	empty := []PullRequest{}

	out, err := s.Runner.RunRaw(r.Context(), ghPRListArgv)
	if err != nil {
		log.Printf("pull-requests: gh failed (badges disabled): %v", err)
		s.writeJSON(w, r, http.StatusOK, empty)
		return
	}

	var ghPRs []struct {
		HeadRefName string `json:"headRefName"`
		URL         string `json:"url"`
		Number      int    `json:"number"`
		IsDraft     bool   `json:"isDraft"`
	}
	if err := json.Unmarshal(out, &ghPRs); err != nil {
		log.Printf("pull-requests: gh output not JSON (badges disabled): %v", err)
		s.writeJSON(w, r, http.StatusOK, empty)
		return
	}

	prs := make([]PullRequest, len(ghPRs))
	for i, gh := range ghPRs {
		prs[i] = PullRequest{
			Bookmark: gh.HeadRefName,
			URL:      gh.URL,
			Number:   gh.Number,
			IsDraft:  gh.IsDraft,
		}
	}
	s.writeJSON(w, r, http.StatusOK, prs)
}

// --- File write handler ---

type fileWriteRequest struct {
	Path    string `json:"path"`
	Content string `json:"content"`
}

func (s *Server) handleFileWrite(w http.ResponseWriter, r *http.Request) {
	if s.RepoDir == "" {
		s.writeError(w, http.StatusNotImplemented, "file writing is not supported in SSH mode")
		return
	}

	var req fileWriteRequest
	if err := decodeBody(w, r, &req); err != nil {
		s.writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	if req.Path == "" {
		s.writeError(w, http.StatusBadRequest, "path is required")
		return
	}

	// Security: reject null bytes, path traversal, absolute paths, and internal dirs
	if strings.ContainsRune(req.Path, 0) {
		s.writeError(w, http.StatusBadRequest, "invalid path")
		return
	}
	if filepath.IsAbs(req.Path) {
		s.writeError(w, http.StatusBadRequest, "absolute paths are not allowed")
		return
	}
	cleaned := filepath.Clean(req.Path)
	if strings.HasPrefix(cleaned, "..") {
		s.writeError(w, http.StatusBadRequest, "path traversal is not allowed")
		return
	}
	sep := string(filepath.Separator)
	if cleaned == ".jj" || strings.HasPrefix(cleaned, ".jj"+sep) ||
		cleaned == ".git" || strings.HasPrefix(cleaned, ".git"+sep) {
		s.writeError(w, http.StatusBadRequest, "writing to internal directories is not allowed")
		return
	}

	target := filepath.Join(s.RepoDir, cleaned)

	// Resolve symlinks in the parent directory to prevent symlink escape.
	// A tracked symlink inside the repo (e.g. link -> /etc) would pass
	// lexical checks but resolve outside the repo tree.
	parentDir := filepath.Dir(target)
	resolvedParent, err := filepath.EvalSymlinks(parentDir)
	if err != nil {
		s.writeError(w, http.StatusBadRequest, "parent directory does not exist")
		return
	}
	resolvedRepo, err := filepath.EvalSymlinks(s.RepoDir)
	if err != nil {
		s.writeError(w, http.StatusInternalServerError, "cannot resolve repository path")
		return
	}
	if !strings.HasPrefix(resolvedParent+string(filepath.Separator), resolvedRepo+string(filepath.Separator)) && resolvedParent != resolvedRepo {
		s.writeError(w, http.StatusBadRequest, "path escapes repository")
		return
	}

	// Check if the target itself is a symlink (leaf-level symlink escape).
	// Parent directory symlinks are caught by EvalSymlinks above, but a
	// symlink at the file level (e.g. link.txt -> /etc/shadow) would pass
	// parent checks and follow the link to an arbitrary location.
	if info, err := os.Lstat(target); err == nil && info.Mode()&os.ModeSymlink != 0 {
		s.writeError(w, http.StatusBadRequest, "cannot write to symlink")
		return
	}

	if err := os.WriteFile(target, []byte(req.Content), 0644); err != nil {
		s.writeError(w, http.StatusInternalServerError, fmt.Sprintf("failed to write %s", cleaned))
		return
	}
	s.writeJSON(w, r, http.StatusOK, map[string]bool{"ok": true})
}
