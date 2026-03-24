package api

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"mime"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"time"

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
	// Seed op-id cache on first log fetch only. Subsequent refreshes come
	// from the watcher (local) or sshPollLoop (remote) — a sync refreshOpId
	// here adds ~440ms to every /api/log in SSH mode for no benefit.
	if s.getOpId() == "" {
		s.refreshOpId()
	}
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

func (s *Server) handleStaleImmutable(w http.ResponseWriter, r *http.Request) {
	output, err := s.Runner.Run(r.Context(), jj.StaleImmutable())
	if err != nil {
		s.writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	entries := jj.ParseStaleImmutable(string(output))
	s.writeJSON(w, r, http.StatusOK, jj.GroupStaleImmutable(entries))
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

// handleConflicts returns every conflicted commit in revset with its
// conflicted-files list + side counts. Feeds the merge-mode queue.
//
// Query: ?revset=X (optional; defaults to conflicts())
// Response: [{commit_id, change_id, description, files: [{path, sides}]}]
func (s *Server) handleConflicts(w http.ResponseWriter, r *http.Request) {
	revset := r.URL.Query().Get("revset")
	output, err := s.Runner.Run(r.Context(), jj.ConflictList(revset))
	if err != nil {
		s.writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	s.writeJSON(w, r, http.StatusOK, jj.ParseConflictList(string(output)))
}

// handleFileHistory is handleLog scoped to commits touching one file.
// Separate endpoint so EscapeFileName's root-file: escaping stays server-side.
func (s *Server) handleFileHistory(w http.ResponseWriter, r *http.Request) {
	path := r.URL.Query().Get("path")
	if path == "" {
		s.writeError(w, http.StatusBadRequest, "path query param required")
		return
	}
	full := r.URL.Query().Get("full") == "1"
	output, err := s.Runner.Run(r.Context(), jj.FileLog(path, 100, full))
	if err != nil {
		s.writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	s.writeJSON(w, r, http.StatusOK, parser.ParseGraphLog(string(output)))
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

// remoteListOutput runs `jj git remote list` with a `git remote -v` fallback.
// jj rejects refspecs it can't parse (e.g. negative glob ^refs/heads/ci/*);
// git doesn't validate refspecs when listing. Both parsers (ParseRemoteURLs,
// ParseRemoteListOutput) accept either format.
func (s *Server) remoteListOutput(ctx context.Context) ([]byte, error) {
	out, err := s.Runner.Run(ctx, jj.GitRemoteList())
	if err == nil || s.RepoPath == "" {
		return out, err
	}
	jjErr := err
	out, err = s.Runner.RunRaw(ctx, []string{"git", "-C", s.RepoPath, "remote", "-v"})
	if err != nil {
		return nil, fmt.Errorf("jj failed (%w); git fallback also failed: %v", jjErr, err)
	}
	return out, nil
}

func (s *Server) handleRemotes(w http.ResponseWriter, r *http.Request) {
	output, err := s.remoteListOutput(r.Context())
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
	// ReadBytes (not Run) — file content is data, not display text. Run's
	// TrimRight("\n") corrupts the merge-editor round trip: a file ending
	// in \n gets stripped here → center doc has no final \n → saveMerge
	// writes it back without → diff shows "\ No newline at end of file".
	// Worse: CRLF-ending files have their final \n stripped leaving a lone
	// \r, which CM6 normalizes to \n (phantom extra line) while split('\n')
	// doesn't — line-count mismatch breaks diffBlocks' LCS matching.
	output, err := s.Runner.ReadBytes(r.Context(), jj.FileShow(revision, path))
	if err != nil {
		s.writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	s.writeJSON(w, r, http.StatusOK, map[string]string{"content": string(output)})
}

// commitIdRe matches 40+ lowercase hex — the frontend passes diffTarget.commitId
// (content hash, immutable). Shorter values are change_ids or symbolic refs
// which CAN move, so those skip the aggressive cache.
var commitIdRe = regexp.MustCompile(`^[a-f0-9]{40,}$`)

// handleFileRaw serves file bytes at a revision with a browser-usable
// Content-Type. Feeds <img src> in markdown preview so images work in SSH
// mode (browser can't reach the remote filesystem; jj can).
//
// XSS defenses layered — belt-and-suspenders since repo content is untrusted:
//   - non-image → attachment + octet-stream (direct-nav downloads, doesn't render)
//   - CSP default-src 'none' neuters SVG <script> on direct nav; <img> rendering
//     is unaffected (a resource's CSP governs it-as-document, not the embedder)
//   - nosniff prevents content-sniffing a .png-with-HTML-body into text/html
func (s *Server) handleFileRaw(w http.ResponseWriter, r *http.Request) {
	revision := r.URL.Query().Get("revision")
	if revision == "" {
		s.writeError(w, http.StatusBadRequest, "revision is required")
		return
	}
	cleaned, err := validateRepoRelativePath(r.URL.Query().Get("path"))
	if err != nil {
		s.writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	output, err := s.Runner.ReadBytes(r.Context(), jj.FileShow(revision, filepath.ToSlash(cleaned)))
	if err != nil {
		s.writeError(w, http.StatusNotFound, err.Error())
		return
	}
	ct := mime.TypeByExtension(filepath.Ext(cleaned))
	if strings.HasPrefix(ct, "image/") {
		w.Header().Set("Content-Type", ct)
	} else {
		w.Header().Set("Content-Type", "application/octet-stream")
		w.Header().Set("Content-Disposition", "attachment")
	}
	w.Header().Set("X-Content-Type-Options", "nosniff")
	// style-src for SVG's internal <style> (beautiful-mermaid emits one);
	// everything else denied — scripts, frames, connects, objects.
	w.Header().Set("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'")
	if commitIdRe.MatchString(revision) {
		w.Header().Set("Cache-Control", "private, max-age=31536000, immutable")
	}
	w.Write(output)
}

func (s *Server) handleInfo(w http.ResponseWriter, r *http.Request) {
	// editor_configured = "the mode-appropriate config field is non-empty".
	// Drives the frontend's onopenfile gate — empty config means the menu
	// item stays disabled instead of 400ing on click.
	tmpl, _, _ := s.editorTemplate("", nil)
	s.writeJSON(w, r, http.StatusOK, map[string]any{
		"hostname":          s.Hostname,
		"repo_path":         s.RepoPath,
		"ssh_mode":          s.RepoDir == "",
		"editor_configured": len(tmpl) > 0,
		"default_remote":    s.DefaultRemote,
		"log_revset":        s.ConfiguredLogRevset,
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

// pickCurrentWorkspace resolves which ws.Current=true candidate is actually
// us. One candidate → trust it (SSH mode's only signal). Multiple → the
// collision case: break the tie by path-matching against repoDir. The
// workspace_store index is additive-only (server.go: readWorkspaceStore) —
// the primary workspace (created at jj git init) often predates it and has
// no path entry. If exactly one candidate is missing from the index and no
// other candidate's path matches us, the missing one is us by elimination.
func pickCurrentWorkspace(candidates []string, pathMap map[string]string, repoDir string) string {
	if len(candidates) == 1 {
		return candidates[0]
	}
	if repoDir == "" {
		return "" // SSH + collision: no reliable tiebreaker
	}
	clean := filepath.Clean(repoDir)
	var unmapped []string
	for _, name := range candidates {
		p := pathMap[name]
		if p == "" {
			unmapped = append(unmapped, name)
			continue
		}
		if filepath.Clean(p) == clean {
			return name // exact match wins
		}
	}
	// No path matched. If exactly one candidate was missing from the index,
	// it's the primary (predates the index) and we're it by elimination —
	// every OTHER candidate has a path that ISN'T us.
	if len(unmapped) == 1 {
		return unmapped[0]
	}
	return ""
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

	// ws.Current = target.current_working_copy() = "is this workspace's target
	// commit MY @?" — wrong question when two workspaces point at the same
	// commit (both answer true, last-in-loop wins). Path-matching is reliable
	// in local mode (RepoDir is canonical via ResolveWorkspaceRoot) but breaks
	// in SSH mode (user-typed --remote path may not be canonical). Hybrid:
	// ws.Current narrows candidates; path-match breaks ties. See commands.go
	// WorkspaceList comment for the history.
	var candidates []string
	resp := workspacesResponse{Workspaces: make([]workspaceWithPath, len(workspaces))}
	for i, ws := range workspaces {
		resp.Workspaces[i] = workspaceWithPath{
			Name:     ws.Name,
			ChangeId: ws.ChangeId,
			CommitId: ws.CommitId,
			Path:     pathMap[ws.Name],
		}
		if ws.Current {
			candidates = append(candidates, ws.Name)
		}
	}
	resp.Current = pickCurrentWorkspace(candidates, pathMap, s.RepoDir)
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

type metaeditChangeIdRequest struct {
	Revision string `json:"revision"`
}

// handleMetaeditChangeId wraps `jj metaedit --update-change-id` — the "split
// identity" divergence resolution. See docs/jj-divergence.md and the jj guide
// (docs.jj-vcs.dev/latest/guides/divergence/ §Strategy 2).
func (s *Server) handleMetaeditChangeId(w http.ResponseWriter, r *http.Request) {
	var req metaeditChangeIdRequest
	if err := decodeBody(w, r, &req); err != nil {
		s.writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	if req.Revision == "" {
		s.writeError(w, http.StatusBadRequest, "revision is required")
		return
	}
	s.runMutation(w, r, jj.MetaeditUpdateChangeId(req.Revision))
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
	s.runMutationWithInput(w, r, args, stdin)
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
	Revisions       []string `json:"revisions"`
	Destination     string   `json:"destination"`
	Files           []string `json:"files"`
	KeepEmptied     bool     `json:"keep_emptied"`
	IgnoreImmutable bool     `json:"ignore_immutable"`
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
	s.runMutation(w, r, jj.Squash(revs, req.Destination, req.Files, req.KeepEmptied, req.IgnoreImmutable))
}

func (s *Server) handleUndo(w http.ResponseWriter, r *http.Request) {
	if err := decodeBody(w, r, &struct{}{}); err != nil {
		s.writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	s.runMutation(w, r, jj.Undo())
}

// opIdRe validates op-ids: hex, at least 12 chars (jj's short form).
// Embedded in a jj arg, so charset restriction blocks flag injection.
var opIdRe = regexp.MustCompile(`^[a-f0-9]{12,64}$`)

// opMutation returns a handler that decodes {id}, validates via opIdRe,
// and runs the given command builder. Shared by /api/op/undo + /api/op/restore.
func (s *Server) opMutation(build func(id string) jj.CommandArgs) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var req struct {
			ID string `json:"id"`
		}
		if err := decodeBody(w, r, &req); err != nil {
			s.writeError(w, http.StatusBadRequest, err.Error())
			return
		}
		if !opIdRe.MatchString(req.ID) {
			s.writeError(w, http.StatusBadRequest, "invalid op id")
			return
		}
		s.runMutation(w, r, build(req.ID))
	}
}

type restoreFromRequest struct {
	From string `json:"from"`
	To   string `json:"to"`
}

func (s *Server) handleRestoreFrom(w http.ResponseWriter, r *http.Request) {
	var req restoreFromRequest
	if err := decodeBody(w, r, &req); err != nil {
		s.writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	if req.From == "" || req.To == "" {
		s.writeError(w, http.StatusBadRequest, "from and to are required")
		return
	}
	s.runMutation(w, r, jj.RestoreFromTo(req.From, req.To))
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
	// Successful snapshot proves not-stale (jj auto-update-stale would have
	// either cleared it or errored). Same reasoning as handleWorkspaceUpdateStale
	// below — without this, CLI-fixed staleness + tab-focus snapshot leaves
	// server stale=true until the next snapshotLoop tick (≤5s), and an SSE
	// reconnect in that window shows a false stale-wc.
	s.clearStale()
}

// handleWorkspaceUpdateStale recovers a stale working copy. The watcher's
// snapshotLoop detects staleness and pushes an SSE warning; this is the
// one-click fix.
func (s *Server) handleWorkspaceUpdateStale(w http.ResponseWriter, r *http.Request) {
	if err := decodeBody(w, r, &struct{}{}); err != nil {
		s.writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	s.runMutation(w, r, jj.WorkspaceUpdateStale())
	// Clear + broadcast immediately so OTHER SSE clients (2nd browser window)
	// unstick. The clicking tab is covered by the frontend's `after` callback.
	// Runs even on error: runMutation early-returns internally but Go doesn't
	// propagate that to us. Self-heals — if update-stale FAILED, the next
	// snapshot re-detects within 5s. Brief false-clear, bounded by one tick.
	s.clearStale()
}

// clearStale is the handler-side stale reset. setStale serializes the
// Swap+broadcast so this can't race a concurrent snapshotLoop set (which would
// emit sentinels out-of-order with no self-heal).
func (s *Server) clearStale() {
	if s.Watcher != nil {
		s.Watcher.setStale(false)
	}
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

func (s *Server) handleOpShow(w http.ResponseWriter, r *http.Request) {
	id := r.URL.Query().Get("id")
	if !opIdRe.MatchString(id) {
		s.writeError(w, http.StatusBadRequest, "invalid op id")
		return
	}
	output, err := s.Runner.Run(r.Context(), jj.OpShow(id))
	if err != nil {
		s.writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	s.writeJSON(w, r, http.StatusOK, map[string]string{"output": string(output)})
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
	s.runMutation(w, r, jj.Split(req.Revision, req.Files, req.Parallel))
}

// hunkSpecRequest mirrors frontend's HunkSpec. The handler treats Spec as an
// opaque json.RawMessage — it's the frontend↔apply_hunks.go contract; the
// handler is just a courier. Schema changes there don't touch this file.
type hunkSpecRequest struct {
	Revision    string          `json:"revision"`
	Spec        json.RawMessage `json:"spec"`
	Description string          `json:"description"`
}

// Endpoints carrying full file content as JSON strings (split-hunks spec,
// file-write from merge/inline editors). 64MB: enough for a large repo-scale
// lock file, still bounded. decodeBody's 1MB default rejects these.
const fileContentBodyLimit = 64 << 20

func (s *Server) handleSplitHunks(w http.ResponseWriter, r *http.Request) {
	// Local-only: jj must be able to exec our binary. In SSH mode the jj
	// subprocess runs on the REMOTE host where this binary doesn't exist.
	// RepoDir=="" is the SSH sentinel (see BACKLOG.md `RepoDir` debt note);
	// SelfBinary=="" covers tests and any future mode that skips os.Executable.
	if s.RepoDir == "" || s.SelfBinary == "" {
		s.writeError(w, http.StatusNotImplemented, "hunk-level split requires local mode")
		return
	}

	var req hunkSpecRequest
	if err := decodeBodyLimit(w, r, &req, fileContentBodyLimit); err != nil {
		s.writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	if req.Revision == "" {
		s.writeError(w, http.StatusBadRequest, "revision is required")
		return
	}
	if len(req.Spec) == 0 {
		s.writeError(w, http.StatusBadRequest, "spec is required")
		return
	}

	// Two tempfiles: the spec (JSON, consumed by apply_hunks.go) and the
	// tool config (TOML, consumed by jj). Both in os.TempDir — jj will
	// create its OWN temp dir for $left/$right alongside these.
	// CreateTemp is 0600 since Go 1.11 (go.mod requires 1.25+) — a
	// same-user racer can still stat/read but the threat is bounded:
	// that user can run `jj` directly anyway.
	specFile, err := os.CreateTemp("", "lightjj-spec-*.json")
	if err != nil {
		s.writeError(w, http.StatusInternalServerError, fmt.Sprintf("tempfile: %v", err))
		return
	}
	defer os.Remove(specFile.Name())
	if _, err := specFile.Write(req.Spec); err != nil {
		specFile.Close()
		s.writeError(w, http.StatusInternalServerError, fmt.Sprintf("write spec: %v", err))
		return
	}
	specFile.Close()

	configFile, err := writeHunkToolConfig(s.SelfBinary, specFile.Name())
	if err != nil {
		s.writeError(w, http.StatusInternalServerError, fmt.Sprintf("write tool config: %v", err))
		return
	}
	defer os.Remove(configFile)

	s.runMutation(w, r, jj.SplitWithTool(req.Revision, configFile, req.Description))
}

// writeHunkToolConfig emits an ephemeral merge-tools TOML definition.
// %q for the path values — Go's strconv.Quote escapes (\" \\ \n etc) are a
// subset of TOML basic-string escapes for any path that doesn't contain
// control chars (which filesystem paths don't). This avoids a TOML encoder
// dep for three lines of config.
func writeHunkToolConfig(selfBinary, specPath string) (string, error) {
	f, err := os.CreateTemp("", "lightjj-tool-*.toml")
	if err != nil {
		return "", err
	}
	defer f.Close()
	_, err = fmt.Fprintf(f,
		"[merge-tools.lightjj-hunks]\nprogram = %q\nedit-args = [%q, \"$left\", \"$right\"]\n",
		selfBinary, "--apply-hunks="+specPath)
	if err != nil {
		os.Remove(f.Name())
		return "", err
	}
	return f.Name(), nil
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

// ghPRListArgs builds the gh invocation for listing the current user's open
// PRs. --repo lets gh skip git-dir discovery, so this works from secondary
// workspaces (no .git/) and any cwd. repo is "owner/name" — STATIC server
// value from resolveGHRepo, never request-derived (flows to a remote shell
// via SSHRunner.wrapRaw).
func ghPRListArgs(repo string) []string {
	return []string{
		"gh", "pr", "list",
		"--repo", repo,
		"--state", "open",
		"--author", "@me",
		"--json", "headRefName,url,number,isDraft",
		"--limit", "100",
	}
}

// githubRepoFromURL extracts "owner/repo" from a GitHub remote URL.
// Handles https, ssh (git@github.com:...), ssh with host alias
// (git@github.com-personal:...), and ssh:// scheme. Returns "" if the URL
// isn't a recognizable GitHub remote — caller treats that as "no PR badges".
func githubRepoFromURL(url string) string {
	const host = "github.com"
	idx := strings.Index(url, host)
	if idx < 0 {
		return ""
	}
	// Boundary check: "github.com" must start the URL or follow '@' (ssh)
	// or '/' (https). Prevents matching "notgithub.com".
	if idx > 0 && url[idx-1] != '@' && url[idx-1] != '/' {
		return ""
	}
	rest := url[idx+len(host):]
	// SSH host alias: github.com-foo — skip -foo to reach the ':' or '/'.
	if after, ok := strings.CutPrefix(rest, "-"); ok {
		i := strings.IndexAny(after, ":/")
		if i < 0 {
			return ""
		}
		rest = after[i:]
	}
	if len(rest) == 0 || (rest[0] != ':' && rest[0] != '/') {
		return ""
	}
	// Reject port-like suffix (github.com:443/...). SSH paths always
	// start with a letter (owner name); ports always start with a digit.
	if rest[0] == ':' && len(rest) > 1 && rest[1] >= '0' && rest[1] <= '9' {
		return ""
	}
	rest = strings.TrimSuffix(rest[1:], ".git")
	rest = strings.TrimSuffix(rest, "/")
	// Must be exactly "owner/repo" — anything else is ambiguous.
	if rest == "" || strings.Count(rest, "/") != 1 {
		return ""
	}
	return rest
}

// resolveGHRepo derives "owner/repo" for PR-badge queries. Lazy-init via
// mutex+bool — the `jj git remote list` call happens once per Server lifetime
// (on the first PR-badge fetch), unless it fails transiently.
//
// Remote priority: upstream > DefaultRemote > any GitHub remote. Fork
// workflows put PRs in upstream (origin=fork, upstream=canonical); the gh
// CLI's headRefName matching works across forks as long as --repo points at
// the canonical repo.
//
// Uses its own timeout (not the request ctx): the remote URL is server-lifetime
// state. A cancelled first request would otherwise permanently cache "".
func (s *Server) resolveGHRepo() string {
	s.ghRepoMu.Lock()
	defer s.ghRepoMu.Unlock()
	if s.ghRepoResolved {
		return s.ghRepo
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	out, err := s.remoteListOutput(ctx)
	if err != nil {
		log.Printf("resolveGHRepo: %v", err)
		return "" // transient or no git — next call retries (ghRepoResolved still false)
	}
	urls := jj.ParseRemoteURLs(string(out))

	tryRemote := func(name string) bool {
		if repo := githubRepoFromURL(urls[name]); repo != "" {
			s.ghRepo = repo
			return true
		}
		return false
	}
	if !tryRemote("upstream") && !tryRemote(s.DefaultRemote) {
		for _, url := range urls { // any-GitHub fallback — non-deterministic but rare
			if repo := githubRepoFromURL(url); repo != "" {
				s.ghRepo = repo
				break
			}
		}
	}
	s.ghRepoResolved = true // cache result (even if "" = not GitHub)
	return s.ghRepo
}

func (s *Server) handlePullRequests(w http.ResponseWriter, r *http.Request) {
	empty := []PullRequest{}

	repo := s.resolveGHRepo()
	if repo == "" {
		// No GitHub remote → no PR badges. Silent — non-GitHub repos and
		// remotes-without-a-default are normal, not an error worth logging.
		s.writeJSON(w, r, http.StatusOK, empty)
		return
	}

	out, err := s.Runner.RunRaw(r.Context(), ghPRListArgs(repo))
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

// validateRepoRelativePath applies lexical security checks to a user-supplied
// repo-relative path: rejects null bytes, absolute paths, traversal, and
// .jj/.git. Returns the cleaned path (filepath.Clean — OS-native separators;
// callers sending to a POSIX remote must filepath.ToSlash it). Filesystem
// reality checks (symlink escape) are the Runner's concern — see
// LocalRunner.WriteFile.
func validateRepoRelativePath(p string) (cleaned string, err error) {
	if p == "" {
		return "", fmt.Errorf("path is required")
	}
	if strings.ContainsRune(p, 0) {
		return "", fmt.Errorf("invalid path")
	}
	if filepath.IsAbs(p) {
		return "", fmt.Errorf("absolute paths are not allowed")
	}
	cleaned = filepath.Clean(p)
	if strings.HasPrefix(cleaned, "..") {
		return "", fmt.Errorf("path traversal is not allowed")
	}
	sep := string(filepath.Separator)
	if cleaned == ".jj" || strings.HasPrefix(cleaned, ".jj"+sep) ||
		cleaned == ".git" || strings.HasPrefix(cleaned, ".git"+sep) {
		return "", fmt.Errorf("internal directories are not allowed")
	}
	return cleaned, nil
}

func (s *Server) handleFileWrite(w http.ResponseWriter, r *http.Request) {
	var req fileWriteRequest
	if err := decodeBodyLimit(w, r, &req, fileContentBodyLimit); err != nil {
		s.writeError(w, http.StatusBadRequest, err.Error())
		return
	}

	// Lexical validation only — traversal, .jj/.git, absolute, null bytes.
	// Symlink-escape is the Runner's concern (LocalRunner does EvalSymlinks;
	// SSHRunner omits it — same trust boundary as remote shell).
	// Runner.WriteFile joins against its own repo-root knowledge.
	cleaned, err := validateRepoRelativePath(req.Path)
	if err != nil {
		s.writeError(w, http.StatusBadRequest, err.Error())
		return
	}

	if err := s.Runner.WriteFile(r.Context(), cleaned, []byte(req.Content)); err != nil {
		s.writeError(w, http.StatusInternalServerError, fmt.Sprintf("failed to write %s: %v", cleaned, err))
		return
	}
	// Snapshot + refresh so the X-JJ-Op-Id header is fresh. Without this the
	// merge editor's "Save" returns a stale op-id → frontend's loadLog fetches
	// pre-write state → conflict still shows as unresolved until the periodic
	// snapshotLoop catches up (default 5s; worse in SSH where each round trip
	// is ~440ms). The watcher watches op_heads/ not the WC — it won't fire
	// until SOMETHING snapshots. Error swallowed: the write succeeded, which
	// is the primary contract; a failed snapshot just means the UI lags.
	_, _ = s.Runner.Run(r.Context(), jj.DebugSnapshot())
	s.refreshOpId()
	s.writeJSON(w, r, http.StatusOK, map[string]bool{"ok": true})
}
