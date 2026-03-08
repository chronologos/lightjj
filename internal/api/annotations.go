package api

import (
	"encoding/json"
	"errors"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"sync"
)

// annMu serializes read-modify-write across POST/DELETE handlers. Without it,
// two concurrent writes (cross-tab, same changeId) both read [a,b], one appends
// c, the other appends d; whichever renames last wins, the other is lost.
// atomicWriteJSON prevents torn writes but not lost updates. Global (not
// per-changeId) is fine — contention is rare, handlers are fast.
var annMu sync.Mutex

// Annotations are per-change_id review comments for agent-iteration workflows.
// Stored at $XDG_CONFIG_HOME/lightjj/annotations/{changeId}.json so spawned
// workspace instances on different ports share one store — localStorage would
// isolate by origin.
//
// The backend is a dumb CRUD store. Re-anchoring (line number drift across
// agent iterations) is computed client-side via /api/diff-range — the server
// doesn't know which commit_id is "current", and re-anchor math belongs with
// the diff parser that's already in the frontend.

// Annotation mirrors the frontend type. The server treats it as opaque JSON
// beyond the fields it validates (ChangeId for routing, ID for upsert/delete).
// Unknown fields survive round-trip via the raw storage — the frontend can
// add severity/status without backend changes.
type Annotation struct {
	ID                string `json:"id"`
	ChangeId          string `json:"changeId"`
	FilePath          string `json:"filePath"`
	LineNum           int    `json:"lineNum"`
	LineContent       string `json:"lineContent"`
	Comment           string `json:"comment"`
	Severity          string `json:"severity,omitempty"`
	CreatedAt         int64  `json:"createdAt"`
	CreatedAtCommitId string `json:"createdAtCommitId"`
	Status            string `json:"status,omitempty"`
	ResolvedAtCommitId string `json:"resolvedAtCommitId,omitempty"`
}

// changeId is embedded in a filesystem path — restrict to jj's charset
// (lowercase alphanum for change_ids, hex for commit_ids if used as fallback).
// This prevents path traversal (../, null bytes) and keeps filenames portable.
var changeIdRe = regexp.MustCompile(`^[a-z0-9]{1,64}$`)

func annotationsPath(changeId string) (string, error) {
	if !changeIdRe.MatchString(changeId) {
		return "", errors.New("invalid changeId")
	}
	dir, err := userConfigDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(dir, "lightjj", "annotations", changeId+".json"), nil
}

// atomicWriteJSON writes v to path via temp-file + rename (same pattern as
// config.go). The parent directory is created if missing.
func atomicWriteJSON(path string, v any) error {
	out, err := json.MarshalIndent(v, "", "  ")
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	tmp, err := os.CreateTemp(filepath.Dir(path), ".annotations-*.json")
	if err != nil {
		return err
	}
	tmpPath := tmp.Name()
	defer os.Remove(tmpPath)
	if _, err := tmp.Write(out); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	return os.Rename(tmpPath, path)
}

// readAnnotations returns the stored annotations for changeId, or an empty
// slice if the file doesn't exist. Corrupt files are treated as empty with
// no error — the next write will replace them.
func readAnnotations(changeId string) ([]Annotation, error) {
	path, err := annotationsPath(changeId)
	if err != nil {
		return nil, err
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return []Annotation{}, nil // missing = empty state
	}
	var anns []Annotation
	if err := json.Unmarshal(data, &anns); err != nil {
		return []Annotation{}, nil // corrupt = empty state
	}
	if anns == nil {
		anns = []Annotation{}
	}
	return anns, nil
}

// GET /api/annotations?changeId=X
func (s *Server) handleAnnotationsGet(w http.ResponseWriter, r *http.Request) {
	changeId := r.URL.Query().Get("changeId")
	if changeId == "" {
		s.writeError(w, http.StatusBadRequest, "changeId required")
		return
	}
	anns, err := readAnnotations(changeId)
	if err != nil {
		s.writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	s.writeJSON(w, r, http.StatusOK, anns)
}

// POST /api/annotations — upsert. Body is a single Annotation. Matched by ID
// within the file for its ChangeId; appended if not found.
func (s *Server) handleAnnotationsPost(w http.ResponseWriter, r *http.Request) {
	var ann Annotation
	if err := decodeBody(w, r, &ann); err != nil {
		s.writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	if ann.ChangeId == "" || ann.ID == "" {
		s.writeError(w, http.StatusBadRequest, "changeId and id required")
		return
	}

	annMu.Lock()
	defer annMu.Unlock()

	anns, err := readAnnotations(ann.ChangeId)
	if err != nil {
		s.writeError(w, http.StatusBadRequest, err.Error())
		return
	}

	found := false
	for i := range anns {
		if anns[i].ID == ann.ID {
			anns[i] = ann
			found = true
			break
		}
	}
	if !found {
		anns = append(anns, ann)
	}

	path, _ := annotationsPath(ann.ChangeId) // validated via readAnnotations
	if err := atomicWriteJSON(path, anns); err != nil {
		s.writeError(w, http.StatusInternalServerError, "write failed: "+err.Error())
		return
	}
	s.writeJSON(w, r, http.StatusOK, ann)
}

// DELETE /api/annotations?changeId=X&id=Y — remove by ID. If id is omitted,
// the entire file is deleted (clear all for this change).
func (s *Server) handleAnnotationsDelete(w http.ResponseWriter, r *http.Request) {
	changeId := r.URL.Query().Get("changeId")
	id := r.URL.Query().Get("id")
	if changeId == "" {
		s.writeError(w, http.StatusBadRequest, "changeId required")
		return
	}
	path, err := annotationsPath(changeId)
	if err != nil {
		s.writeError(w, http.StatusBadRequest, err.Error())
		return
	}

	annMu.Lock()
	defer annMu.Unlock()

	if id == "" {
		// Clear all — best-effort; missing file is success.
		if err := os.Remove(path); err != nil && !os.IsNotExist(err) {
			s.writeError(w, http.StatusInternalServerError, "remove failed")
			return
		}
		w.WriteHeader(http.StatusOK)
		return
	}

	anns, err := readAnnotations(changeId)
	if err != nil {
		s.writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	out := anns[:0]
	for _, a := range anns {
		if a.ID != id {
			out = append(out, a)
		}
	}
	if len(out) == 0 {
		// Last one deleted — remove the file rather than keep an empty array.
		if err := os.Remove(path); err != nil && !os.IsNotExist(err) {
			s.writeError(w, http.StatusInternalServerError, "remove failed")
			return
		}
	} else if err := atomicWriteJSON(path, out); err != nil {
		s.writeError(w, http.StatusInternalServerError, "write failed")
		return
	}
	w.WriteHeader(http.StatusOK)
}
