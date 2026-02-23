// Package api provides HTTP handlers that bridge the Svelte frontend to jj commands.
package api

import (
	"encoding/json"
	"net/http"

	"github.com/iant/jj-web/internal/runner"
)

// Server holds the HTTP handler and its dependencies.
type Server struct {
	Runner runner.CommandRunner
	Mux    *http.ServeMux
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
	s.Mux.HandleFunc("GET /api/description", s.handleGetDescription)
	s.Mux.HandleFunc("GET /api/remotes", s.handleRemotes)

	s.Mux.HandleFunc("POST /api/new", s.handleNew)
	s.Mux.HandleFunc("POST /api/edit", s.handleEdit)
	s.Mux.HandleFunc("POST /api/abandon", s.handleAbandon)
	s.Mux.HandleFunc("POST /api/describe", s.handleDescribe)
	s.Mux.HandleFunc("POST /api/rebase", s.handleRebase)
	s.Mux.HandleFunc("POST /api/squash", s.handleSquash)
	s.Mux.HandleFunc("POST /api/undo", s.handleUndo)

	s.Mux.HandleFunc("POST /api/bookmark/set", s.handleBookmarkSet)
	s.Mux.HandleFunc("POST /api/bookmark/delete", s.handleBookmarkDelete)

	s.Mux.HandleFunc("POST /api/git/push", s.handleGitPush)
	s.Mux.HandleFunc("POST /api/git/fetch", s.handleGitFetch)
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(v)
}

func writeError(w http.ResponseWriter, status int, msg string) {
	writeJSON(w, status, map[string]string{"error": msg})
}

func decodeBody(r *http.Request, v any) error {
	defer r.Body.Close()
	return json.NewDecoder(r.Body).Decode(v)
}
