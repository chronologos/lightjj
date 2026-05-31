package api

import (
	"encoding/json"
	"errors"
	"net/http"
	"os"
	"path/filepath"
	"slices"
	"sync"
)

// jsonstore.go — generic keyed flat-file JSON-array store shared by
// annotations.go and doc_comments.go. Each jsonCollection[T] maps a string key
// to one JSON file holding a []T addressed by item ID, and centralizes the
// store machinery the two stores previously hand-mirrored: the
// read-modify-write mutex, merge-on-upsert (preserve-on-empty), server-side
// stamping, and delete-file-when-last-item-removed.

type hasID interface {
	GetID() string
}

// jsonCollection is a keyed store of JSON arrays: each key maps to one file
// (via pathFor), each file holds a []T addressed by item ID.
//
// Locking: each collection owns one mutex covering every read-modify-write
// cycle. Collections MUST be package-level vars, not Server fields — store
// files are shared across Server instances (tabs): annotations are keyed by
// changeId alone, so two tabs can address the same file, and a per-Server
// mutex would not prevent their lost updates. atomicWriteJSON prevents torn
// writes but not lost updates; the mutex prevents lost updates. Per-collection
// mutexes (rather than one shared global) keep the two stores' contention
// independent; either would do for flat-file CRUD.
type jsonCollection[T hasID] struct {
	mu sync.Mutex

	// pathFor maps a key to the absolute path of its JSON file. An error means
	// the key is invalid; it surfaces as a 400-status storeError.
	pathFor func(key string) (string, error)

	// merge reconciles an incoming upsert with the existing stored record of
	// the same ID. Implementations use preserve-on-empty semantics: a client
	// that re-POSTs without echoing back fields written by the server or by
	// another actor (resolution, createdAt) must not wipe them.
	merge func(existing, incoming T) T

	// stamp fills server-side defaults (generated ID, createdAt) on an item.
	// Runs AFTER merge so merge can detect "client omitted this" by zero value.
	stamp func(*T)

	// deleteMatch reports whether item should be removed when deleting id.
	// nil means exact ID match; doc comments override it to cascade replies.
	deleteMatch func(item T, id string) bool
}

// storeError carries the HTTP status a handler should respond with: key
// validation failures → 400, disk I/O failures → 500. Handlers map it via
// storeErrStatus so the GET/POST/DELETE structure stays uniform across stores.
type storeError struct {
	status int
	msg    string
}

func (e *storeError) Error() string { return e.msg }

// storeErrStatus returns the HTTP status for a store error (500 for anything
// that isn't a *storeError).
func storeErrStatus(err error) int {
	var se *storeError
	if errors.As(err, &se) {
		return se.status
	}
	return http.StatusInternalServerError
}

func (c *jsonCollection[T]) path(key string) (string, error) {
	p, err := c.pathFor(key)
	if err != nil {
		return "", &storeError{http.StatusBadRequest, err.Error()}
	}
	return p, nil
}

// List returns the items stored under key — an empty (non-nil) slice when the
// file is missing or unparseable.
func (c *jsonCollection[T]) List(key string) ([]T, error) {
	path, err := c.path(key)
	if err != nil {
		return nil, err
	}
	items, _ := readJSONStore[T](path)
	return items, nil
}

// Upsert merges item into the collection under key and returns the stored
// item (post-merge, post-stamp) so the HTTP response reflects what was
// actually written.
func (c *jsonCollection[T]) Upsert(key string, item T) (T, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	stored, err := c.upsertLocked(key, []T{item})
	if err != nil {
		return item, err
	}
	return stored[0], nil
}

// UpsertBatch merges items in order under a single lock acquisition so a
// concurrent single-item Upsert can't interleave between the read and the
// write. All-or-nothing: nothing is written if the key is invalid or the
// write fails. Callers validate item contents before calling.
func (c *jsonCollection[T]) UpsertBatch(key string, items []T) ([]T, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.upsertLocked(key, items)
}

func (c *jsonCollection[T]) upsertLocked(key string, incoming []T) ([]T, error) {
	path, err := c.path(key)
	if err != nil {
		return nil, err
	}
	items, _ := readJSONStore[T](path)
	stored := make([]T, len(incoming))
	for i, item := range incoming {
		items, stored[i] = c.mergeOne(items, item)
	}
	if err := atomicWriteJSON(path, items); err != nil {
		return nil, &storeError{http.StatusInternalServerError, "write failed: " + err.Error()}
	}
	return stored, nil
}

// mergeOne merges item against its existing record (matched by ID, if any),
// applies server stamps, and upserts it into items.
func (c *jsonCollection[T]) mergeOne(items []T, item T) ([]T, T) {
	if c.merge != nil {
		for i := range items {
			if items[i].GetID() == item.GetID() {
				item = c.merge(items[i], item)
				break
			}
		}
	}
	if c.stamp != nil {
		c.stamp(&item)
	}
	return upsertByID(items, item), item
}

// Delete removes the item(s) matching id under key (per deleteMatch). When
// the last item is removed, the file is deleted rather than left as an empty
// array.
func (c *jsonCollection[T]) Delete(key, id string) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	path, err := c.path(key)
	if err != nil {
		return err
	}
	match := c.deleteMatch
	if match == nil {
		match = func(item T, id string) bool { return item.GetID() == id }
	}
	items, _ := readJSONStore[T](path)
	items = slices.DeleteFunc(items, func(item T) bool { return match(item, id) })
	if len(items) == 0 {
		return removeStoreFile(path)
	}
	if err := atomicWriteJSON(path, items); err != nil {
		return &storeError{http.StatusInternalServerError, "write failed"}
	}
	return nil
}

// DeleteAll removes the whole file for key (clear all). A missing file is
// success — best-effort semantics.
func (c *jsonCollection[T]) DeleteAll(key string) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	path, err := c.path(key)
	if err != nil {
		return err
	}
	return removeStoreFile(path)
}

func removeStoreFile(path string) error {
	if err := os.Remove(path); err != nil && !os.IsNotExist(err) {
		return &storeError{http.StatusInternalServerError, "remove failed"}
	}
	return nil
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
	return atomicWriteFile(path, out)
}

// atomicWriteFile writes data to path via temp-file + rename so a crash
// mid-write can't leave a torn file. The parent directory is created if
// missing. This is the single atomic-write primitive shared by the JSON
// stores (this file), config.go, and state.go — note that it prevents torn
// writes only; preventing LOST updates (concurrent read-modify-write) is the
// caller's job via a mutex held across the whole cycle.
func atomicWriteFile(path string, data []byte) error {
	dir := filepath.Dir(path)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return err
	}
	tmp, err := os.CreateTemp(dir, ".lightjj-*.tmp")
	if err != nil {
		return err
	}
	tmpPath := tmp.Name()
	defer os.Remove(tmpPath)
	if _, err := tmp.Write(data); err != nil {
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
