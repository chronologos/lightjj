package api

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"net/http"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"time"
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

// cleanDocPath normalizes filePath to a canonical repo-relative form so that
// "./docs/X.md" and "docs/X.md" hash to the same store. Agents POST against
// paths they read from /api/file-show; the UI uses paths from the diff parser —
// without normalization those silently diverge. Rejects absolute paths and
// ..-escapes (the hash already prevents traversal on disk, but a rejected error
// is clearer to the agent than a silently empty store).
func cleanDocPath(p string) (string, error) {
	c := filepath.ToSlash(filepath.Clean(p))
	c = strings.TrimPrefix(c, "./")
	if c == ".." || strings.HasPrefix(c, "../") || strings.HasPrefix(c, "/") {
		return "", errors.New("path escapes repo")
	}
	return c, nil
}

func (s *Server) docCommentPath(filePath string) (string, error) {
	clean, err := cleanDocPath(filePath)
	if err != nil {
		return "", err
	}
	dir, err := userConfigDir()
	if err != nil {
		return "", err
	}
	h := sha256.Sum256([]byte(s.RepoPath + "|" + clean))
	return filepath.Join(dir, "lightjj", "doc-comments", hex.EncodeToString(h[:])[:16]+".json"), nil
}

func randID() string {
	var b [8]byte
	_, _ = rand.Read(b[:])
	return hex.EncodeToString(b[:])
}

// GET    /api/doc-comments?path=X       — list (empty array if none)
// POST   /api/doc-comments              — upsert by id (body = DocComment)
// DELETE /api/doc-comments?path=X&id=Y  — remove one (cascades to replies)
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
			s.writeError(w, http.StatusBadRequest, err.Error())
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
		if c.FilePath == "" {
			s.writeError(w, http.StatusBadRequest, "filePath required")
			return
		}
		if c.Anchor.Selection == "" {
			s.writeError(w, http.StatusBadRequest, "anchor.selection required")
			return
		}
		clean, err := cleanDocPath(c.FilePath)
		if err != nil {
			s.writeError(w, http.StatusBadRequest, err.Error())
			return
		}
		c.FilePath = clean
		if c.ID == "" {
			c.ID = randID()
		}
		stamped := c.CreatedAt == 0
		if stamped {
			c.CreatedAt = time.Now().UnixMilli()
		}
		path, err := s.docCommentPath(c.FilePath)
		if err != nil {
			s.writeError(w, http.StatusInternalServerError, err.Error())
			return
		}
		docCommentMu.Lock()
		defer docCommentMu.Unlock()
		items, _ := readJSONStore[DocComment](path)
		// Whole-record upsert would let an agent re-POST clobber the user's
		// resolution. Preserve resolution + original timestamp when the incoming
		// record omits them — explicit "" still can't clear, but the only writer
		// of resolution is resolveComment() which always sets a non-empty value.
		for i := range items {
			if items[i].ID == c.ID {
				if c.Resolution == "" {
					c.Resolution = items[i].Resolution
					c.ResolvedAt = items[i].ResolvedAt
				}
				if stamped {
					c.CreatedAt = items[i].CreatedAt
				}
				break
			}
		}
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
			s.writeError(w, http.StatusBadRequest, err.Error())
			return
		}
		if id == "" {
			s.writeError(w, http.StatusBadRequest, "id required")
			return
		}
		docCommentMu.Lock()
		defer docCommentMu.Unlock()
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
