// Package api provides HTTP handlers that bridge the Svelte frontend to jj commands.
package api

import (
	"encoding/json"
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

	s.Mux.HandleFunc("POST /api/new", s.handleNew)
	s.Mux.HandleFunc("POST /api/edit", s.handleEdit)
	s.Mux.HandleFunc("POST /api/abandon", s.handleAbandon)
	s.Mux.HandleFunc("POST /api/describe", s.handleDescribe)
	s.Mux.HandleFunc("POST /api/rebase", s.handleRebase)
	s.Mux.HandleFunc("POST /api/squash", s.handleSquash)
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
// Call after mutation handlers to pick up the new state.
func (s *Server) refreshOpId(r *http.Request) {
	output, err := s.Runner.Run(r.Context(), jj.CurrentOpId())
	if err != nil {
		return
	}
	opId := strings.TrimSpace(string(output))
	s.cachedMu.Lock()
	s.cachedOp = opId
	s.cachedMu.Unlock()
}

// getOpId returns the cached op-id (may be empty on first call).
func (s *Server) getOpId() string {
	s.cachedMu.RLock()
	defer s.cachedMu.RUnlock()
	return s.cachedOp
}

func decodeBody(r *http.Request, v any) error {
	r.Body = http.MaxBytesReader(nil, r.Body, 1<<20) // 1 MB limit
	defer r.Body.Close()
	return json.NewDecoder(r.Body).Decode(v)
}
