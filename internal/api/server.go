// Package api provides HTTP handlers that bridge the Svelte frontend to jj commands.
package api

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/chronologos/lightjj/internal/jj"
	"github.com/chronologos/lightjj/internal/runner"
)

// Server holds the HTTP handler and its dependencies.
type Server struct {
	Runner   runner.CommandRunner
	Mux      *http.ServeMux
	RepoDir  string // absolute path to repo root (empty for SSH mode)
	cachedOp string // last known op-id, refreshed after mutations
	cachedMu sync.RWMutex

	// ExecGhPRList runs `gh pr list` and returns the raw JSON output.
	// Injected at construction; tests can override with a stub.
	ExecGhPRList func(ctx context.Context, repoDir string) ([]byte, error)

	spawnedWorkspaces map[string]string // workspace name → URL of spawned instance
	children          []*exec.Cmd       // spawned workspace instances
	childrenMu        sync.Mutex

	// Watcher provides SSE auto-refresh. Nil in SSH mode (no local fs to watch).
	// Set by main.go after NewServer; routes() tolerates it being nil.
	Watcher *Watcher
}

func NewServer(r runner.CommandRunner, repoDir string) *Server {
	s := &Server{
		Runner:       r,
		Mux:          http.NewServeMux(),
		RepoDir:      repoDir,
		ExecGhPRList: defaultExecGhPRList,
	}
	s.routes()
	return s
}

// Shutdown kills any child lightjj processes spawned for other workspaces
// and stops the filesystem watcher.
func (s *Server) Shutdown() {
	if s.Watcher != nil {
		s.Watcher.Close()
	}
	s.childrenMu.Lock()
	defer s.childrenMu.Unlock()
	for _, cmd := range s.children {
		if cmd.Process != nil {
			_ = cmd.Process.Kill()
		}
	}
	s.children = nil
}

func (s *Server) routes() {
	s.Mux.HandleFunc("GET /api/log", s.handleLog)
	s.Mux.HandleFunc("GET /api/bookmarks", s.handleBookmarks)
	s.Mux.HandleFunc("GET /api/diff", s.handleDiff)
	s.Mux.HandleFunc("GET /api/files", s.handleFiles)
	s.Mux.HandleFunc("GET /api/description", s.handleGetDescription)
	s.Mux.HandleFunc("GET /api/revision", s.handleRevision)
	s.Mux.HandleFunc("GET /api/files-batch", s.handleFilesBatch)
	s.Mux.HandleFunc("GET /api/remotes", s.handleRemotes)
	s.Mux.HandleFunc("GET /api/oplog", s.handleOpLog)
	s.Mux.HandleFunc("GET /api/evolog", s.handleEvolog)
	s.Mux.HandleFunc("GET /api/diff-range", s.handleDiffRange)
	s.Mux.HandleFunc("GET /api/file-show", s.handleFileShow)
	s.Mux.HandleFunc("GET /api/workspaces", s.handleWorkspaces)
	s.Mux.HandleFunc("POST /api/workspace/open", s.handleWorkspaceOpen)

	s.Mux.HandleFunc("POST /api/new", s.handleNew)
	s.Mux.HandleFunc("POST /api/edit", s.handleEdit)
	s.Mux.HandleFunc("POST /api/abandon", s.handleAbandon)
	s.Mux.HandleFunc("POST /api/describe", s.handleDescribe)
	s.Mux.HandleFunc("POST /api/rebase", s.handleRebase)
	s.Mux.HandleFunc("POST /api/squash", s.handleSquash)
	s.Mux.HandleFunc("POST /api/split", s.handleSplit)
	s.Mux.HandleFunc("POST /api/resolve", s.handleResolve)
	s.Mux.HandleFunc("POST /api/undo", s.handleUndo)
	s.Mux.HandleFunc("POST /api/commit", s.handleCommit)

	s.Mux.HandleFunc("POST /api/bookmark/set", s.handleBookmarkSet)
	s.Mux.HandleFunc("POST /api/bookmark/delete", s.handleBookmarkDelete)
	s.Mux.HandleFunc("POST /api/bookmark/move", s.handleBookmarkMove)
	s.Mux.HandleFunc("POST /api/bookmark/forget", s.handleBookmarkForget)
	s.Mux.HandleFunc("POST /api/bookmark/track", s.handleBookmarkTrack)
	s.Mux.HandleFunc("POST /api/bookmark/untrack", s.handleBookmarkUntrack)

	s.Mux.HandleFunc("GET /api/aliases", s.handleAliases)
	s.Mux.HandleFunc("POST /api/alias", s.handleRunAlias)

	s.Mux.HandleFunc("GET /api/pull-requests", s.handlePullRequests)

	s.Mux.HandleFunc("GET /api/config", s.handleConfigGet)
	s.Mux.HandleFunc("POST /api/config", s.handleConfigSet)

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

// writeError writes an error response without fetching op-id (errors should be cheap).
func (s *Server) writeError(w http.ResponseWriter, status int, msg string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	if err := json.NewEncoder(w).Encode(map[string]string{"error": msg}); err != nil {
		log.Printf("writeError encode error: %v", err)
	}
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
	if s.RepoDir != "" {
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
	// context so it completes even if the HTTP request is cancelled.
	output, err := s.Runner.Run(context.Background(), jj.CurrentOpId())
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
	output, err := s.Runner.Run(r.Context(), args)
	if err != nil {
		s.writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	s.refreshOpId()
	s.writeJSON(w, r, http.StatusOK, map[string]string{"output": string(output)})
}

// getOpId returns the cached op-id (may be empty on first call).
func (s *Server) getOpId() string {
	s.cachedMu.RLock()
	defer s.cachedMu.RUnlock()
	return s.cachedOp
}

// spawnWorkspaceInstance starts a new lightjj instance for a workspace at the given path.
// Returns the URL of the new instance. The process is tracked for cleanup on shutdown.
// If an instance was already spawned for this workspace name, returns its URL.
func (s *Server) spawnWorkspaceInstance(name, workspacePath string) (string, error) {
	// Validate path before spawning
	workspacePath = filepath.Clean(workspacePath)
	if !filepath.IsAbs(workspacePath) {
		return "", fmt.Errorf("workspace path must be absolute: %s", workspacePath)
	}
	if info, err := os.Stat(workspacePath); err != nil || !info.IsDir() {
		return "", fmt.Errorf("workspace path is not a directory: %s", workspacePath)
	}

	url, addr, err := s.spawnLocked(name, workspacePath)
	if err != nil {
		return "", err
	}
	if addr == "" {
		return url, nil // already-spawned instance, no need to poll
	}

	// Wait briefly for the new server to accept connections
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		conn, err := net.DialTimeout("tcp", addr, 100*time.Millisecond)
		if err == nil {
			conn.Close()
			return url, nil
		}
		time.Sleep(50 * time.Millisecond)
	}
	return url, nil // return URL even if poll timed out — server may just be slow
}

// spawnLocked holds childrenMu across dedup check, port allocation, and exec.Start
// to prevent concurrent requests from spawning duplicate instances.
// Lock duration is ~50ms — acceptable for a manual, infrequent action.
func (s *Server) spawnLocked(name, workspacePath string) (url string, addr string, err error) {
	s.childrenMu.Lock()
	defer s.childrenMu.Unlock()

	// Return existing instance if already spawned
	if existing, ok := s.spawnedWorkspaces[name]; ok {
		return existing, "", nil
	}

	// Find a free port
	ln, err := net.Listen("tcp", "localhost:0")
	if err != nil {
		return "", "", fmt.Errorf("finding free port: %w", err)
	}
	addr = ln.Addr().String()
	ln.Close()

	// Find our own binary path
	exe, err := os.Executable()
	if err != nil {
		return "", "", fmt.Errorf("finding executable: %w", err)
	}

	cmd := exec.Command(exe, "-R", workspacePath, "--addr", addr, "--no-browser")
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	if err := cmd.Start(); err != nil {
		return "", "", fmt.Errorf("starting lightjj: %w", err)
	}

	// Reap child process to prevent zombies
	go cmd.Wait()

	url = "http://" + addr
	s.children = append(s.children, cmd)
	if s.spawnedWorkspaces == nil {
		s.spawnedWorkspaces = make(map[string]string)
	}
	s.spawnedWorkspaces[name] = url
	return url, addr, nil
}

// readWorkspaceStore reads and parses the workspace store index file.
// Returns nil map if RepoDir is empty (SSH mode) or if the file can't be read.
func (s *Server) readWorkspaceStore() (map[string]string, error) {
	if s.RepoDir == "" {
		return nil, nil
	}
	storePath := filepath.Join(s.RepoDir, ".jj", "repo", "workspace_store", "index")
	data, err := os.ReadFile(storePath)
	if err != nil {
		return nil, fmt.Errorf("reading workspace store: %w", err)
	}
	return jj.ParseWorkspaceStorePaths(data)
}

func decodeBody(w http.ResponseWriter, r *http.Request, v any) error {
	// Require application/json content type. Triggers CORS preflight for cross-origin
	// requests, blocking simple form-based CSRF. Full protection requires CORS origin
	// restrictions (the Host header validation in the server already provides this).
	ct := r.Header.Get("Content-Type")
	if !strings.HasPrefix(ct, "application/json") {
		return fmt.Errorf("Content-Type must be application/json")
	}
	r.Body = http.MaxBytesReader(w, r.Body, 1<<20) // 1 MB limit
	defer r.Body.Close()
	return json.NewDecoder(r.Body).Decode(v)
}