// Package api provides HTTP handlers that bridge the Svelte frontend to jj commands.
package api

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net/http"
	"os"
	"path"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/chronologos/lightjj/internal/jj"
	"github.com/chronologos/lightjj/internal/runner"
)

// Server holds the HTTP handler and its dependencies.
type Server struct {
	Runner        runner.CommandRunner
	Mux           *http.ServeMux
	RepoDir       string // absolute path to repo root (empty for SSH mode)
	DefaultRemote string // preferred remote name for bookmark/remote sorting; main.go can override
	// ConfiguredLogRevset is the user's revsets.log config — what `jj log`
	// uses when no -r is passed. Shown as the filter-bar placeholder so
	// "empty filter = what?" is visible. Empty if unset (jj uses its
	// built-in default). main.go reads via ConfigGet at tab-open.
	ConfiguredLogRevset string
	Hostname      string // display hostname for tab title (local os.Hostname or SSH host); main.go sets
	RepoPath      string // display repo path for tab title (RepoDir or SSH remote path); main.go sets
	SSHHost       string // full user@host spec for --remote mode (empty in local mode); feeds {host} placeholder
	SelfBinary    string // os.Executable() — for --apply-hunks re-entry; empty in tests/SSH mode
	cachedOp string // last known op-id, refreshed after mutations
	cachedMu sync.RWMutex

	// ghRepo is "owner/name" derived from DefaultRemote's URL. Lazy-resolved
	// on first handlePullRequests; "" is a valid cached answer (not GitHub).
	// ghRepoMu+ghRepoResolved (not sync.Once) so a transient failure
	// (10s timeout on slow SSH startup) retries instead of permanently
	// disabling PR badges for the server lifetime.
	ghRepo         string
	ghRepoResolved bool
	ghRepoMu       sync.Mutex

	// Watcher provides SSE auto-refresh. Nil only on --no-watch or constructor
	// failure. Set by main.go after NewServer; routes() tolerates nil.
	Watcher *Watcher

	// jjVersion is the `jj --version` output (e.g. "jj 0.39.0"). Lazy-resolved
	// on first handleInfo / jjSupports. Mutex+bool (not sync.Once) so a
	// transient failure retries — same pattern as ghRepo. jjVer is the parsed
	// form; jjVerOK=false means parse failed (jjSupports treats as "unknown").
	jjVersion         string
	jjVer             jj.Semver
	jjVerOK           bool
	jjVersionResolved bool
	jjVersionMu       sync.Mutex
}

// hasLocalFS reports whether this Server can read the repo filesystem directly
// (op_heads/, workspace_store/). True in local mode; false in SSH mode (repo
// lives on the remote) and tests (no repo at all).
func (s *Server) hasLocalFS() bool { return s.RepoDir != "" }

// isSSHMode reports whether jj runs on a remote host via SSH. Distinct from
// !hasLocalFS(): tests have neither local fs NOR SSH. In prod they're
// equivalent (main.go sets RepoDir/SSHHost together).
func (s *Server) isSSHMode() bool { return s.SSHHost != "" }

func NewServer(r runner.CommandRunner, repoDir string) *Server {
	s := &Server{
		Runner:        r,
		Mux:           http.NewServeMux(),
		RepoDir:       repoDir,
		DefaultRemote: "origin",
	}
	s.routes()
	return s
}

// Shutdown stops the filesystem watcher.
func (s *Server) Shutdown() {
	if s.Watcher != nil {
		s.Watcher.Close()
	}
}

// routes registers all Server endpoints. ALL routes MUST be under /api/ —
// the frontend's tabScoped() (api.ts) uses that prefix as the discriminant
// for per-tab routing. A non-/api/ route would silently 404 in production
// (tests hit srv.Mux directly and wouldn't catch it).
func (s *Server) routes() {
	s.Mux.HandleFunc("GET /api/log", s.handleLog)
	s.Mux.HandleFunc("GET /api/bookmarks", s.handleBookmarks)
	s.Mux.HandleFunc("GET /api/diff", s.handleDiff)
	s.Mux.HandleFunc("GET /api/files", s.handleFiles)
	s.Mux.HandleFunc("GET /api/description", s.handleGetDescription)
	s.Mux.HandleFunc("GET /api/revision", s.handleRevision)
	s.Mux.HandleFunc("GET /api/revision-meta", s.handleRevisionMeta)
	s.Mux.HandleFunc("GET /api/files-batch", s.handleFilesBatch)
	s.Mux.HandleFunc("GET /api/conflicts", s.handleConflicts)
	s.Mux.HandleFunc("GET /api/file-history", s.handleFileHistory)
	s.Mux.HandleFunc("POST /api/index-paths", s.handleIndexPaths)
	s.Mux.HandleFunc("GET /api/remotes", s.handleRemotes)
	s.Mux.HandleFunc("GET /api/oplog", s.handleOpLog)
	s.Mux.HandleFunc("GET /api/op/show", s.handleOpShow)
	s.Mux.HandleFunc("GET /api/evolog", s.handleEvolog)
	s.Mux.HandleFunc("GET /api/divergence", s.handleDivergence)
	s.Mux.HandleFunc("GET /api/stale-immutable", s.handleStaleImmutable)
	s.Mux.HandleFunc("GET /api/diff-range", s.handleDiffRange)
	s.Mux.HandleFunc("GET /api/file-show", s.handleFileShow)
	s.Mux.HandleFunc("GET /api/file-raw", s.handleFileRaw)
	s.Mux.HandleFunc("GET /api/info", s.handleInfo)
	s.Mux.HandleFunc("GET /api/workspaces", s.handleWorkspaces)

	s.Mux.HandleFunc("POST /api/new", s.handleNew)
	s.Mux.HandleFunc("POST /api/edit", s.handleEdit)
	s.Mux.HandleFunc("POST /api/abandon", s.handleAbandon)
	s.Mux.HandleFunc("POST /api/metaedit-change-id", s.handleMetaeditChangeId)
	s.Mux.HandleFunc("POST /api/restore", s.handleRestore)
	s.Mux.HandleFunc("POST /api/describe", s.handleDescribe)
	s.Mux.HandleFunc("POST /api/rebase", s.handleRebase)
	s.Mux.HandleFunc("POST /api/squash", s.handleSquash)
	s.Mux.HandleFunc("POST /api/split", s.handleSplit)
	s.Mux.HandleFunc("POST /api/split-hunks", s.handleSplitHunks)
	s.Mux.HandleFunc("POST /api/resolve", s.handleResolve)
	s.Mux.HandleFunc("POST /api/undo", s.handleUndo)
	s.Mux.HandleFunc("POST /api/op/undo", s.opMutation(jj.OpUndo))
	s.Mux.HandleFunc("POST /api/op/restore", s.opMutation(jj.OpRestore))
	s.Mux.HandleFunc("POST /api/restore-from", s.handleRestoreFrom)
	s.Mux.HandleFunc("POST /api/snapshot", s.handleSnapshot)
	s.Mux.HandleFunc("POST /api/workspace/update-stale", s.handleWorkspaceUpdateStale)
	s.Mux.HandleFunc("POST /api/commit", s.handleCommit)
	s.Mux.HandleFunc("POST /api/open-file", s.handleOpenFile)

	s.Mux.HandleFunc("POST /api/bookmark/set", s.bookmarkRevMutation(jj.BookmarkSet))
	s.Mux.HandleFunc("POST /api/bookmark/delete", s.bookmarkMutation(jj.BookmarkDelete))
	s.Mux.HandleFunc("POST /api/bookmark/move", s.bookmarkRevMutation(func(rev, name string) jj.CommandArgs {
		return jj.BookmarkMove(rev, name, "--allow-backwards")
	}))
	s.Mux.HandleFunc("POST /api/bookmark/advance", s.bookmarkRevMutation(jj.BookmarkAdvance))
	s.Mux.HandleFunc("POST /api/bookmark/forget", s.bookmarkMutation(jj.BookmarkForget))
	s.Mux.HandleFunc("POST /api/bookmark/track", s.bookmarkRemoteMutation(jj.BookmarkTrack))
	s.Mux.HandleFunc("POST /api/bookmark/untrack", s.bookmarkRemoteMutation(jj.BookmarkUntrack))

	s.Mux.HandleFunc("GET /api/aliases", s.handleAliases)
	s.Mux.HandleFunc("POST /api/alias", s.handleRunAlias)

	s.Mux.HandleFunc("GET /api/pull-requests", s.handlePullRequests)

	s.Mux.HandleFunc("GET /api/config", handleConfigGet)
	s.Mux.HandleFunc("POST /api/config", handleConfigSet)

	s.Mux.HandleFunc("GET /api/annotations", s.handleAnnotationsGet)
	s.Mux.HandleFunc("POST /api/annotations", s.handleAnnotationsPost)
	s.Mux.HandleFunc("DELETE /api/annotations", s.handleAnnotationsDelete)

  // handle file edits
	s.Mux.HandleFunc("POST /api/file-write", s.handleFileWrite)

	s.Mux.HandleFunc("POST /api/git/push", s.handleGitPush)
	s.Mux.HandleFunc("POST /api/git/fetch", s.handleGitFetch)

	// SSE auto-refresh — registered lazily since Watcher is set after NewServer.
	s.Mux.HandleFunc("GET /api/events", func(w http.ResponseWriter, r *http.Request) {
		if s.Watcher != nil {
			s.Watcher.handleEvents(w, r)
		} else {
			handleEventsDisabled(w, r)
		}
	})
}

func (s *Server) writeJSON(w http.ResponseWriter, r *http.Request, status int, v any) {
	// Suppress op-id on immutable responses — the header is baked into the
	// browser disk cache and would surface as a stale op-id on reload,
	// triggering spurious loadLog() fires via trackOpId. Immutable responses
	// are per-revision reads; staleness is covered by log + SSE.
	if w.Header().Get("Cache-Control") == "" {
		// Dynamic responses must not be cached — the same URL (e.g. /api/log)
		// returns different data after mutations. Without this, browsers may
		// serve stale responses from memory cache (observed: bookmark * persists
		// after git push until hard-refresh bypasses cache).
		w.Header().Set("Cache-Control", "no-store")
		if opId := s.getOpId(); opId != "" {
			w.Header().Set("X-JJ-Op-Id", opId)
		}
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	if err := json.NewEncoder(w).Encode(v); err != nil {
		log.Printf("writeJSON encode error: %v", err)
	}
}

// writeJSONError writes an error response without fetching op-id (errors should be cheap).
// Package-level so TabManager and package-level handlers (config) can use it.
func writeJSONError(w http.ResponseWriter, status int, msg string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	if err := json.NewEncoder(w).Encode(map[string]string{"error": msg}); err != nil {
		log.Printf("writeJSONError encode error: %v", err)
	}
}

// writeError delegates to writeJSONError. Kept as a method for the 100+ call
// sites in handlers.go; the receiver is unused.
func (s *Server) writeError(w http.ResponseWriter, status int, msg string) {
	writeJSONError(w, status, msg)
}

// refreshOpId fetches the current op-id, caches it, and returns it.
// The return value lets callers (e.g., the SSE watcher's fire() closure) use the
// fresh value directly instead of a separate getOpId() read — eliminating a
// TOCTOU window where a concurrent refreshOpId from another goroutine could
// interleave between this call's write and a subsequent read.
//
// Local-mode fast path: the op-id IS the filename in .jj/repo/op_heads/heads/
// (first 12 hex chars). jj atomically swaps a single 0-byte file on every
// operation commit — the same mechanism fsnotify watches. Reading it directly
// is <1ms vs ~15-20ms for the `jj op log` subprocess. Falls through to the
// subprocess for SSH mode (no local fs) or divergent ops (>1 head, rare,
// self-healing on next jj command).
func (s *Server) refreshOpId() string {
	if s.hasLocalFS() {
		heads := filepath.Join(s.RepoDir, ".jj", "repo", "op_heads", "heads")
		if entries, err := os.ReadDir(heads); err == nil && len(entries) == 1 {
			name := entries[0].Name()
			if len(name) >= 12 {
				opId := name[:12]
				s.cachedMu.Lock()
				s.cachedOp = opId
				s.cachedMu.Unlock()
				return opId
			}
		}
	}
	// Fallback: SSH mode, divergent ops, or unexpected dir state. Detached
	// from the HTTP request (so it completes even on client cancel) but WITH
	// a timeout — handleEvents calls this on SSE connect when cachedOp is
	// empty; a hanging SSH would otherwise block SSE setup indefinitely.
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	output, err := s.Runner.Run(ctx, jj.CurrentOpId())
	cancel()
	if err != nil {
		return ""
	}
	opId := strings.TrimSpace(string(output))
	s.cachedMu.Lock()
	s.cachedOp = opId
	s.cachedMu.Unlock()
	return opId
}

// runMutation executes a jj command, synchronously refreshes the op-id, and
// writes the output as JSON. This is the standard pattern for all mutation handlers.
//
// The refresh MUST be synchronous so the X-JJ-Op-Id header reflects the
// post-mutation state. With SSE auto-refresh, a stale header would mean:
// client sees old op-id → SSE arrives with new op-id → dedup fails → redundant
// loadLog() fire. The ~15ms cost of one `jj op log --limit 1` call is acceptable.
func (s *Server) runMutation(w http.ResponseWriter, r *http.Request, args []string) {
	s.runMutationWithInput(w, r, args, "")
}

// runMutationWithInput is runMutation for commands that need stdin (describe).
// Empty stdin = plain Run (LocalRunner.runSeparate only sets cmd.Stdin when stdin != "").
//
// jj writes ALL informational output to stderr (working-copy status, rebase
// summaries, etc.) — stdout is reserved for machine-parseable data. Real
// warnings are prefixed "Warning:" (with follow-up "Hint:" lines). Only stderr
// containing a "Warning:" line is returned as "warnings"; otherwise it's merged
// into "output" so the MessageBar shows success but details are still expandable.
func (s *Server) runMutationWithInput(w http.ResponseWriter, r *http.Request, args []string, stdin string) {
	stdout, stderr, err := s.Runner.RunForMutation(r.Context(), args, stdin)
	if err != nil {
		s.writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	s.refreshOpId()
	out := strings.TrimSpace(string(stdout))
	errOut := strings.TrimSpace(string(stderr))
	resp := map[string]string{}
	if hasWarningLine(errOut) {
		resp["output"] = out
		resp["warnings"] = errOut
	} else {
		resp["output"] = strings.TrimSpace(out + "\n" + errOut)
	}
	s.writeJSON(w, r, http.StatusOK, resp)
}

func hasWarningLine(s string) bool {
	return strings.HasPrefix(s, "Warning:") || strings.Contains(s, "\nWarning:")
}

// streamMutation is runMutation for slow network ops (git push/fetch). Streams
// combined stdout+stderr line-by-line as NDJSON: `{"line":"..."}` per progress
// line, terminated by `{"done":true,"output"|"error":...,"op_id":...}`.
//
// jj git push writes everything to stderr (stdout is 0 bytes) — that's why
// StreamCombined not Stream. The exit code surfaces via rc.Close() = cmd.Wait(),
// but by then the stream already carried jj's error text as lines, so closeErr
// is effectively a boolean; the accumulated output becomes the error message.
//
// Status 200 is committed before the process runs; errors surface in-band only.
// op_id rides the terminal frame (header slot already flushed) so the frontend
// can dedup against SSE — without this, SSE arrives with the new op-id and
// fires a redundant loadLog() (the race runMutation's doc warns about).
func (s *Server) streamMutation(w http.ResponseWriter, r *http.Request, args []string) {
	rc, err := s.Runner.StreamCombined(r.Context(), args)
	if err != nil {
		s.writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	defer rc.Close() // idempotent; panic safety net — reaps subprocess

	// Disable WriteTimeout — push over slow network can exceed 120s.
	// Returns ErrNotSupported on httptest.ResponseRecorder; ignored.
	_ = http.NewResponseController(w).SetWriteDeadline(time.Time{})

	w.Header().Set("Content-Type", "application/x-ndjson")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(http.StatusOK)

	flusher, _ := w.(http.Flusher)
	flush := func() {
		if flusher != nil {
			flusher.Flush()
		}
	}

	var output strings.Builder
	enc := json.NewEncoder(w)
	sc := bufio.NewScanner(rc)
	// Remote git hooks can dump arbitrary stderr; default 64KB token limit
	// would silently truncate mid-push (ErrTooLong looks like EOF here).
	sc.Buffer(make([]byte, 0, 64*1024), 1<<20)
	for sc.Scan() {
		line := sc.Text()
		output.WriteString(line)
		output.WriteByte('\n')
		if line == "" {
			continue // don't ship empty frames; frontend would just filter them
		}
		_ = enc.Encode(map[string]string{"line": line})
		flush()
	}
	scanErr := sc.Err()

	closeErr := rc.Close()
	if r.Context().Err() != nil {
		return // client gone — skip refreshOpId (~440ms in SSH mode) + dead write
	}
	opId := s.refreshOpId()

	done := map[string]any{"done": true, "op_id": opId}
	out := strings.TrimRight(output.String(), "\n")
	if err := errors.Join(closeErr, scanErr); err != nil {
		msg := out
		if msg == "" {
			msg = err.Error()
		}
		done["error"] = msg
	} else {
		// StreamCombined merges stdout+stderr (jj git push writes everything
		// to stderr). Post-process the full output so mutationMessage() on the
		// frontend shows amber instead of green when jj warned. Don't ALSO set
		// output — frontend concatenates both for the details expand and they're
		// the same string here (stdout+stderr combined).
		if hasWarningLine(out) {
			done["warnings"] = out
		} else {
			done["output"] = out
		}
	}
	_ = enc.Encode(done)
	flush()
}

// getOpId returns the cached op-id (may be empty on first call).
func (s *Server) getOpId() string {
	s.cachedMu.RLock()
	defer s.cachedMu.RUnlock()
	return s.cachedOp
}

// readWorkspaceStore reads and parses the workspace store index file.
// Returns nil map if the file can't be read (secondary workspace with .jj/repo
// pointer file, SSH cat failure, etc.) — callers treat nil as "no paths".
//
// LIMITATION: the index is ADDITIVE-ONLY. Workspaces created before the user's
// jj version started writing it (or before the index feature existed) won't be
// there — jj doesn't backfill. Observed: a repo with 5 workspaces had only 3
// in the index. jj ≥ 0.40 has WorkspaceRef.root() (see jj.WorkspaceRootTmpl)
// which makes this whole reader the <0.40 fallback; missing entries on that
// path → disabled dropdown row with tooltip.
//
// jj 0.39+ writes RELATIVE paths (anchored at .jj/repo/ — the shared store
// all workspaces point back to). Pre-0.39 wrote absolute. We resolve here,
// not in the parser, because resolution needs the repo path (fs knowledge the
// pure parser shouldn't have). Callers need absolute for TabResolve's IsAbs.
func (s *Server) readWorkspaceStore(ctx context.Context) (map[string]string, error) {
	if s.hasLocalFS() {
		// Local: direct fs read. filepath.* for host OS semantics (Windows
		// absolute paths in pre-0.39 stores wouldn't survive path.IsAbs).
		repoStore := filepath.Join(s.RepoDir, ".jj", "repo")
		data, err := os.ReadFile(filepath.Join(repoStore, "workspace_store", "index"))
		if err != nil {
			return nil, fmt.Errorf("reading workspace store: %w", err)
		}
		return resolveWSPaths(data, repoStore, filepath.IsAbs, filepath.Clean, filepath.Join)
	}
	if s.RepoPath != "" {
		// SSH: cat via RunRaw (runs on remote host). path.* for POSIX —
		// remote is Linux regardless of local OS. Fails with ENOTDIR on
		// secondary workspaces (.jj/repo is a pointer file) → nil map,
		// same as pre-enrichment behavior.
		repoStore := path.Join(s.RepoPath, ".jj", "repo")
		data, err := s.Runner.RunRaw(ctx, []string{"cat", path.Join(repoStore, "workspace_store", "index")})
		if err != nil {
			return nil, nil
		}
		return resolveWSPaths(data, repoStore, path.IsAbs, path.Clean, path.Join)
	}
	return nil, nil
}

// resolveWSPaths is the parse + relative-path-resolution shared by local and
// SSH modes. Each takes its own isAbs/clean/join so local mode can use
// filepath.* (Windows-aware) and SSH can use path.* (POSIX remote).
func resolveWSPaths(data []byte, repoStore string, isAbs func(string) bool, clean func(string) string, join func(...string) string) (map[string]string, error) {
	raw, err := jj.ParseWorkspaceStorePaths(data)
	if err != nil {
		return nil, err
	}
	resolved := make(map[string]string, len(raw))
	for name, p := range raw {
		if isAbs(p) {
			resolved[name] = clean(p)
		} else {
			resolved[name] = join(repoStore, p)
		}
	}
	return resolved, nil
}

func decodeBodyLimit(w http.ResponseWriter, r *http.Request, v any, limit int64) error {
	// Require application/json content type. Triggers CORS preflight for cross-origin
	// requests, blocking simple form-based CSRF. Full protection requires CORS origin
	// restrictions (the Host header validation in the server already provides this).
	ct := r.Header.Get("Content-Type")
	if !strings.HasPrefix(ct, "application/json") {
		return fmt.Errorf("Content-Type must be application/json")
	}
	r.Body = http.MaxBytesReader(w, r.Body, limit)
	defer r.Body.Close()
	return json.NewDecoder(r.Body).Decode(v)
}

func decodeBody(w http.ResponseWriter, r *http.Request, v any) error {
	return decodeBodyLimit(w, r, v, 1<<20)
}