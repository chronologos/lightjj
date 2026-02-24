// Package api provides HTTP handlers that bridge the Svelte frontend to jj commands.
package api

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"sync"

	"github.com/iant/lightjj/internal/jj"
	"github.com/iant/lightjj/internal/runner"
)

// Server holds the HTTP handler and its dependencies.
type Server struct {
	Runner    runner.CommandRunner
	Mux       *http.ServeMux
	cachedOp  string // last known op-id, refreshed after mutations
	cachedMu  sync.RWMutex
}

func NewServer(r runner.CommandRunner) *Server {
	s := &Server{Runner: r, Mux: http.NewServeMux()}
	s.routes()
	return s
}

func (s *Server) routes() {
	s.Mux.HandleFunc("GET /api/log", s.handleLog)
	s.Mux.HandleFunc("GET /api/bookmarks", s.handleBookmarks)
	s.Mux.HandleFunc("GET /api/diff", s.handleDiff)
	s.Mux.HandleFunc("GET /api/status", s.handleStatus)
	s.Mux.HandleFunc("GET /api/files", s.handleFiles)
	s.Mux.HandleFunc("GET /api/description", s.handleGetDescription)
	s.Mux.HandleFunc("GET /api/remotes", s.handleRemotes)
	s.Mux.HandleFunc("GET /api/oplog", s.handleOpLog)
	s.Mux.HandleFunc("GET /api/evolog", s.handleEvolog)
	s.Mux.HandleFunc("GET /api/workspaces", s.handleWorkspaces)

	s.Mux.HandleFunc("POST /api/new", s.handleNew)
	s.Mux.HandleFunc("POST /api/edit", s.handleEdit)
	s.Mux.HandleFunc("POST /api/abandon", s.handleAbandon)
	s.Mux.HandleFunc("POST /api/describe", s.handleDescribe)
	s.Mux.HandleFunc("POST /api/rebase", s.handleRebase)
	s.Mux.HandleFunc("POST /api/squash", s.handleSquash)
	s.Mux.HandleFunc("POST /api/split", s.handleSplit)
	s.Mux.HandleFunc("POST /api/resolve", s.handleResolve)
	s.Mux.HandleFunc("POST /api/undo", s.handleUndo)

	s.Mux.HandleFunc("POST /api/bookmark/set", s.handleBookmarkSet)
	s.Mux.HandleFunc("POST /api/bookmark/delete", s.handleBookmarkDelete)
	s.Mux.HandleFunc("POST /api/bookmark/move", s.handleBookmarkMove)
	s.Mux.HandleFunc("POST /api/bookmark/forget", s.handleBookmarkForget)
	s.Mux.HandleFunc("POST /api/bookmark/track", s.handleBookmarkTrack)
	s.Mux.HandleFunc("POST /api/bookmark/untrack", s.handleBookmarkUntrack)

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
