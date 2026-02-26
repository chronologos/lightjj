// Package api provides HTTP handlers that bridge the Svelte frontend to jj commands.
package api

import (
	"context"
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/iant/lightjj/internal/jj"
	"github.com/iant/lightjj/internal/runner"
)

// Server holds the HTTP handler and its dependencies.
type Server struct {
	Runner   runner.CommandRunner
	Mux      *http.ServeMux
	RepoDir  string // absolute path to repo root (empty for SSH mode)
	cachedOp string // last known op-id, refreshed after mutations
	cachedMu sync.RWMutex

	spawnedWorkspaces map[string]string // workspace name → URL of spawned instance
	children          []*exec.Cmd       // spawned workspace instances
	childrenMu        sync.Mutex
}

func NewServer(r runner.CommandRunner, repoDir string) *Server {
	s := &Server{Runner: r, Mux: http.NewServeMux(), RepoDir: repoDir}
	s.routes()
	return s
}

// Shutdown kills any child lightjj processes spawned for other workspaces.
func (s *Server) Shutdown() {
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

	s.Mux.HandleFunc("POST /api/git/push", s.handleGitPush)
	s.Mux.HandleFunc("POST /api/git/fetch", s.handleGitFetch)
}

func (s *Server) writeJSON(w http.ResponseWriter, r *http.Request, status int, v any) {
	if opId := s.getOpId(); opId != "" {
		w.Header().Set("X-JJ-Op-Id", opId)
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(v)
}

// writeError writes an error response without fetching op-id (errors should be cheap).
func (s *Server) writeError(w http.ResponseWriter, status int, msg string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(map[string]string{"error": msg})
}

// refreshOpId fetches the current op-id from jj and caches it.
// Uses a detached context so it completes even if the HTTP request is cancelled.
func (s *Server) refreshOpId() {
	output, err := s.Runner.Run(context.Background(), jj.CurrentOpId())
	if err != nil {
		return
	}
	opId := strings.TrimSpace(string(output))
	s.cachedMu.Lock()
	s.cachedOp = opId
	s.cachedMu.Unlock()
}

// runMutation executes a jj command, refreshes the op-id in the background,
// and writes the output as JSON. This is the standard pattern for all mutation handlers.
func (s *Server) runMutation(w http.ResponseWriter, r *http.Request, args []string) {
	output, err := s.Runner.Run(r.Context(), args)
	if err != nil {
		s.writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	go s.refreshOpId()
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
