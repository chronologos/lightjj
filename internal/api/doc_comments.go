package api

import (
	"crypto/sha256"
	"encoding/hex"
	"net/http"
	"os"
	"path/filepath"
	"slices"
	"sync"
)

// doc_comments.go — range-anchored, per-filePath document comments for the
// ProseMirror doc mode. Unlike annotations (per-changeId, line-anchored,
// review-of-a-diff), these are per-file and survive across commits — closer to
// a Google Docs comment than a code-review note.
//
// Storage: $XDG_CONFIG_HOME/lightjj/doc-comments/{hash}.json where
// hash = sha256(RepoPath + "|" + filePath)[:16]. Hashing the key sidesteps
// path-traversal validation and filesystem-unsafe characters in filePath.
// RepoPath (not RepoDir) is set in both local and SSH mode.

var docCommentMu sync.Mutex

type DocAnchor struct {
	Selection     string `json:"selection"`
	ContextBefore string `json:"contextBefore"`
	ContextAfter  string `json:"contextAfter"`
}

type DocSuggestion struct {
	Replacement string `json:"replacement"`
	BaseVersion int    `json:"baseVersion"`
}

type DocComment struct {
	ID         string         `json:"id"`
	FilePath   string         `json:"filePath"`
	ParentId   string         `json:"parentId,omitempty"`
	Anchor     DocAnchor      `json:"anchor"`
	Kind       string         `json:"kind"` // comment | suggestion
	Body       string         `json:"body"`
	Suggestion *DocSuggestion `json:"suggestion,omitempty"`
	Resolution string         `json:"resolution,omitempty"` // addressed | wontfix
	ResolvedAt int64          `json:"resolvedAt,omitempty"`
	Author     string         `json:"author"`
	CreatedAt  int64          `json:"createdAt"`
}

func (c DocComment) GetID() string { return c.ID }

func (s *Server) docCommentPath(filePath string) (string, error) {
	dir, err := userConfigDir()
	if err != nil {
		return "", err
	}
	h := sha256.Sum256([]byte(s.RepoPath + "|" + filePath))
	return filepath.Join(dir, "lightjj", "doc-comments", hex.EncodeToString(h[:])[:16]+".json"), nil
}

// GET    /api/doc-comments?path=X       — list (empty array if none)
// POST   /api/doc-comments              — upsert by id (body = DocComment)
// DELETE /api/doc-comments?path=X&id=Y  — remove one; omit id to clear all
func (s *Server) handleDocComments(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		fp := r.URL.Query().Get("path")
		if fp == "" {
			s.writeError(w, http.StatusBadRequest, "path required")
			return
		}
		path, err := s.docCommentPath(fp)
		if err != nil {
			s.writeError(w, http.StatusInternalServerError, err.Error())
			return
		}
		items, _ := readJSONStore[DocComment](path)
		s.writeJSON(w, r, http.StatusOK, items)

	case http.MethodPost:
		var c DocComment
		if err := decodeBody(w, r, &c); err != nil {
			s.writeError(w, http.StatusBadRequest, err.Error())
			return
		}
		if c.FilePath == "" || c.ID == "" {
			s.writeError(w, http.StatusBadRequest, "filePath and id required")
			return
		}
		path, err := s.docCommentPath(c.FilePath)
		if err != nil {
			s.writeError(w, http.StatusInternalServerError, err.Error())
			return
		}
		docCommentMu.Lock()
		defer docCommentMu.Unlock()
		items, _ := readJSONStore[DocComment](path)
		items = upsertByID(items, c)
		if err := atomicWriteJSON(path, items); err != nil {
			s.writeError(w, http.StatusInternalServerError, "write failed: "+err.Error())
			return
		}
		s.writeJSON(w, r, http.StatusOK, c)

	case http.MethodDelete:
		fp := r.URL.Query().Get("path")
		id := r.URL.Query().Get("id")
		if fp == "" {
			s.writeError(w, http.StatusBadRequest, "path required")
			return
		}
		path, err := s.docCommentPath(fp)
		if err != nil {
			s.writeError(w, http.StatusInternalServerError, err.Error())
			return
		}
		docCommentMu.Lock()
		defer docCommentMu.Unlock()
		if id == "" {
			if err := os.Remove(path); err != nil && !os.IsNotExist(err) {
				s.writeError(w, http.StatusInternalServerError, "remove failed")
				return
			}
			w.WriteHeader(http.StatusOK)
			return
		}
		items, _ := readJSONStore[DocComment](path)
		// Cascade-delete replies: a thread root delete must take its children
		// or they reload as ghost highlights with no rail card and no UI delete.
		items = slices.DeleteFunc(items, func(c DocComment) bool {
			return c.ID == id || c.ParentId == id
		})
		if len(items) == 0 {
			if err := os.Remove(path); err != nil && !os.IsNotExist(err) {
				s.writeError(w, http.StatusInternalServerError, "remove failed")
				return
			}
		} else if err := atomicWriteJSON(path, items); err != nil {
			s.writeError(w, http.StatusInternalServerError, "write failed")
			return
		}
		w.WriteHeader(http.StatusOK)

	default:
		s.writeError(w, http.StatusMethodNotAllowed, "method not allowed")
	}
}
