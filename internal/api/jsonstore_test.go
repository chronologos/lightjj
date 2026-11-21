package api

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"sync"
	"testing"

	"github.com/chronologos/lightjj/testutil"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// storeItem is a minimal hasID type exercising every jsonCollection hook:
// Note uses preserve-on-empty merge, CreatedAt is server-stamped, Parent
// drives a cascade deleteMatch.
type storeItem struct {
	ID        string `json:"id"`
	Parent    string `json:"parent,omitempty"`
	Body      string `json:"body,omitempty"`
	Note      string `json:"note,omitempty"`
	CreatedAt int64  `json:"createdAt,omitempty"`
}

func (it storeItem) GetID() string { return it.ID }

const stampedAt = int64(42)

func newTestCollection(t *testing.T) (*jsonCollection[storeItem], string) {
	t.Helper()
	dir := t.TempDir()
	col := &jsonCollection[storeItem]{
		pathFor: func(key string) (string, error) {
			if key == "" {
				return "", errors.New("invalid key")
			}
			return filepath.Join(dir, key+".json"), nil
		},
		merge: func(existing, incoming storeItem) storeItem {
			if incoming.Note == "" {
				incoming.Note = existing.Note
			}
			if incoming.CreatedAt == 0 {
				incoming.CreatedAt = existing.CreatedAt
			}
			return incoming
		},
		stamp: func(it *storeItem) {
			if it.CreatedAt == 0 {
				it.CreatedAt = stampedAt
			}
		},
	}
	return col, dir
}

func TestJSONCollection_UpsertStampsAndMerges(t *testing.T) {
	col, _ := newTestCollection(t)

	// New item without CreatedAt → server-stamped.
	stored, err := col.Upsert("k", storeItem{ID: "a", Body: "v1", Note: "keep me"})
	require.NoError(t, err)
	assert.Equal(t, stampedAt, stored.CreatedAt)

	// Re-upsert same ID omitting Note and CreatedAt → both preserved from the
	// existing record (merge runs before stamp, so the preserved CreatedAt is
	// not overwritten by a fresh stamp).
	stored, err = col.Upsert("k", storeItem{ID: "a", Body: "v2"})
	require.NoError(t, err)
	assert.Equal(t, "v2", stored.Body)
	assert.Equal(t, "keep me", stored.Note)
	assert.Equal(t, stampedAt, stored.CreatedAt)

	// The returned item matches what was persisted.
	items, err := col.List("k")
	require.NoError(t, err)
	require.Len(t, items, 1)
	assert.Equal(t, stored, items[0])
}

func TestJSONCollection_ListInvalidKey(t *testing.T) {
	col, _ := newTestCollection(t)
	_, err := col.List("")
	require.Error(t, err)
	assert.Equal(t, http.StatusBadRequest, storeErrStatus(err))
	assert.Equal(t, "invalid key", err.Error())

	// Non-store errors map to 500.
	assert.Equal(t, http.StatusInternalServerError, storeErrStatus(errors.New("boom")))
}

func TestJSONCollection_ListMissingFileIsEmptyNotNil(t *testing.T) {
	col, _ := newTestCollection(t)
	items, err := col.List("nothing-here")
	require.NoError(t, err)
	assert.NotNil(t, items)
	assert.Empty(t, items)
}

func TestJSONCollection_DeleteDefaultMatch(t *testing.T) {
	col, dir := newTestCollection(t)
	for _, id := range []string{"a", "b"} {
		_, err := col.Upsert("k", storeItem{ID: id})
		require.NoError(t, err)
	}

	require.NoError(t, col.Delete("k", "a"))
	items, err := col.List("k")
	require.NoError(t, err)
	require.Len(t, items, 1)
	assert.Equal(t, "b", items[0].ID)

	// Deleting the last item removes the file instead of writing [].
	require.NoError(t, col.Delete("k", "b"))
	_, statErr := os.Stat(filepath.Join(dir, "k.json"))
	assert.True(t, os.IsNotExist(statErr))
}

func TestJSONCollection_DeleteCascade(t *testing.T) {
	col, _ := newTestCollection(t)
	col.deleteMatch = func(it storeItem, id string) bool {
		return it.ID == id || it.Parent == id
	}
	for _, it := range []storeItem{
		{ID: "root"},
		{ID: "reply", Parent: "root"},
		{ID: "other"},
	} {
		_, err := col.Upsert("k", it)
		require.NoError(t, err)
	}

	require.NoError(t, col.Delete("k", "root"))
	items, err := col.List("k")
	require.NoError(t, err)
	require.Len(t, items, 1)
	assert.Equal(t, "other", items[0].ID)
}

func TestJSONCollection_DeleteAll(t *testing.T) {
	col, dir := newTestCollection(t)
	_, err := col.Upsert("k", storeItem{ID: "a"})
	require.NoError(t, err)

	require.NoError(t, col.DeleteAll("k"))
	_, statErr := os.Stat(filepath.Join(dir, "k.json"))
	assert.True(t, os.IsNotExist(statErr))

	// Clearing an already-missing file is success (best-effort).
	require.NoError(t, col.DeleteAll("k"))
}

func TestJSONCollection_UpsertBatch(t *testing.T) {
	col, _ := newTestCollection(t)

	// Seed an existing record whose Note must survive a batch re-upsert.
	_, err := col.Upsert("k", storeItem{ID: "a", Note: "decision"})
	require.NoError(t, err)

	stored, err := col.UpsertBatch("k", []storeItem{
		{ID: "a", Body: "amended"},
		{ID: "b", Body: "new"},
	})
	require.NoError(t, err)
	require.Len(t, stored, 2)
	assert.Equal(t, "decision", stored[0].Note, "merge applies per batch item")
	assert.Equal(t, stampedAt, stored[1].CreatedAt, "stamp applies per batch item")

	items, err := col.List("k")
	require.NoError(t, err)
	assert.Len(t, items, 2)

	// Invalid key writes nothing and surfaces a 400-status error.
	_, err = col.UpsertBatch("", []storeItem{{ID: "x"}})
	require.Error(t, err)
	assert.Equal(t, http.StatusBadRequest, storeErrStatus(err))
}

// TestStores_DiskLayout locks the on-disk layouts both collections inherited
// from the pre-jsonCollection implementations. Existing store files written
// before the refactor must keep resolving to the same paths — a silent
// derivation change would orphan every store on disk.
//
//   - annotations: <config>/lightjj/annotations/{changeId}.json
//   - doc-comments: <config>/lightjj/doc-comments/{sha256(RepoPath|cleanPath)[:16]}.json
//
// Both hold a JSON array of their item type.
func TestStores_DiskLayout(t *testing.T) {
	withConfigDir(t)
	runner := testutil.NewMockRunner(t)
	t.Cleanup(func() { runner.Verify() })
	srv := NewServer(runner, "")
	srv.RepoPath = "/repo"
	configDir, err := userConfigDir()
	require.NoError(t, err)

	// Annotation store path: changeId is the filename.
	annBody, _ := json.Marshal(Annotation{ID: "a1", ChangeId: "abc", Comment: "x"})
	w := httptest.NewRecorder()
	srv.Mux.ServeHTTP(w, jsonPost("/api/annotations", annBody))
	require.Equal(t, http.StatusOK, w.Code)

	annFile := filepath.Join(configDir, "lightjj", "annotations", "abc.json")
	annData, err := os.ReadFile(annFile)
	require.NoError(t, err, "annotation store must live at annotations/{changeId}.json")
	var anns []Annotation
	require.NoError(t, json.Unmarshal(annData, &anns))
	require.Len(t, anns, 1)
	assert.Equal(t, "a1", anns[0].ID)

	// Doc-comment store path: sha256(RepoPath + "|" + cleanedPath)[:16] is the
	// filename.
	docBody, _ := json.Marshal(DocComment{ID: "c1", FilePath: "docs/design.md", Kind: "comment", Anchor: DocAnchor{Selection: "x"}})
	w = httptest.NewRecorder()
	srv.Mux.ServeHTTP(w, jsonPost("/api/doc-comments", docBody))
	require.Equal(t, http.StatusOK, w.Code)

	h := sha256.Sum256([]byte("/repo|docs/design.md"))
	docFile := filepath.Join(configDir, "lightjj", "doc-comments", hex.EncodeToString(h[:])[:16]+".json")
	docData, err := os.ReadFile(docFile)
	require.NoError(t, err, "doc-comment store must live at the sha256-derived path")
	var docs []DocComment
	require.NoError(t, json.Unmarshal(docData, &docs))
	require.Len(t, docs, 1)
	assert.Equal(t, "c1", docs[0].ID)
}

// TestJSONCollection_ConcurrentUpserts locks the reason the mutex exists:
// concurrent read-modify-write cycles on the same key must not lose updates
// (atomicWriteJSON alone prevents torn files, not lost updates).
func TestJSONCollection_ConcurrentUpserts(t *testing.T) {
	col, _ := newTestCollection(t)
	const n = 20
	var wg sync.WaitGroup
	for i := 0; i < n; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			_, err := col.Upsert("k", storeItem{ID: fmt.Sprintf("id-%d", i)})
			assert.NoError(t, err)
		}(i)
	}
	wg.Wait()

	items, err := col.List("k")
	require.NoError(t, err)
	assert.Len(t, items, n, "no upsert may be lost to a concurrent write")
}

// "Couldn't read it" must never become "it was empty": the next write would
// replace every stored comment with the one being posted.
func TestJSONCollection_UnreadableFileIsNeverOverwritten(t *testing.T) {
	if os.Getuid() == 0 {
		t.Skip("root ignores file modes")
	}
	col, dir := newTestCollection(t)
	_, err := col.Upsert("k", storeItem{ID: "a", Body: "keep"})
	require.NoError(t, err)
	path := filepath.Join(dir, "k.json")
	require.NoError(t, os.Chmod(path, 0o000))
	t.Cleanup(func() { _ = os.Chmod(path, 0o644) })

	_, err = col.List("k")
	assert.Error(t, err)
	_, err = col.Upsert("k", storeItem{ID: "b"})
	assert.Equal(t, http.StatusInternalServerError, storeErrStatus(err))
	assert.Error(t, col.Delete("k", "a"))

	require.NoError(t, os.Chmod(path, 0o644))
	items, err := col.List("k")
	require.NoError(t, err)
	require.Len(t, items, 1)
	assert.Equal(t, "keep", items[0].Body)
}

func TestJSONCollection_ZeroByteFileIsFresh(t *testing.T) {
	col, dir := newTestCollection(t)
	path := filepath.Join(dir, "k.json")
	require.NoError(t, os.WriteFile(path, nil, 0o644))
	items, err := col.List("k")
	require.NoError(t, err)
	assert.Equal(t, []storeItem{}, items)
	_, err = col.Upsert("k", storeItem{ID: "a"})
	require.NoError(t, err)
	backups, _ := filepath.Glob(path + ".corrupt-*")
	assert.Empty(t, backups)
}
