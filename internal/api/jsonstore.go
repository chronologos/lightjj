package api

import (
	"encoding/json"
	"os"
	"path/filepath"
)

// jsonstore.go — generic per-file JSON-array CRUD helpers shared by
// annotations.go and doc_comments.go. Callers hold their own sync.Mutex
// around read-modify-write; these functions do no locking.

type hasID interface {
	GetID() string
}

// readJSONStore returns the slice stored at path, or an empty (non-nil) slice
// if the file is missing or unparseable. The next write will overwrite a
// corrupt file, so surfacing the parse error would only block recovery.
func readJSONStore[T any](path string) ([]T, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return []T{}, nil
	}
	var items []T
	if err := json.Unmarshal(data, &items); err != nil {
		return []T{}, nil
	}
	if items == nil {
		items = []T{}
	}
	return items, nil
}

// atomicWriteJSON writes v to path via temp-file + rename so a crash mid-write
// can't leave a torn file. The parent directory is created if missing.
func atomicWriteJSON(path string, v any) error {
	out, err := json.MarshalIndent(v, "", "  ")
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	tmp, err := os.CreateTemp(filepath.Dir(path), ".jsonstore-*.json")
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

func upsertByID[T hasID](items []T, item T) []T {
	for i := range items {
		if items[i].GetID() == item.GetID() {
			items[i] = item
			return items
		}
	}
	return append(items, item)
}

func removeByID[T hasID](items []T, id string) []T {
	out := items[:0]
	for _, it := range items {
		if it.GetID() != id {
			out = append(out, it)
		}
	}
	return out
}
