package api

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"path"
	"slices"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/chronologos/lightjj/internal/jj"
)

// Full-tree browsing at a revision (issue #39): GET /api/file-tree returns ONE
// directory's children, GET /api/file-tree/search fuzzy-matches over every
// path. Both are served from a per-commit index built from a single
// `jj file list` run.
//
// Why whole-listing + server-side laziness: jj filesets can't enumerate a
// directory's immediate children (`root:"dir"` yields every DESCENDANT), so a
// per-directory jj call would still walk the whole subtree — the root
// directory costs a full listing either way. One listing per commit_id, kept
// in a small LRU, then every expand/search is an in-memory lookup. Shipping
// the full list to the browser instead was rejected: 200k paths is ~12 MB of
// JSON to parse + hold per revision in the tab, and it doesn't degrade at all
// past that; per-directory responses stay small at any repo size.
//
// Measured (jj 0.45.1, M-series Mac): 200k files → ~2–3s, 17.6 MB template
// output; ghostty (6k files) → ~0.1s. The cache key is a commit id, so an
// entry is valid forever (content-addressed) — eviction is purely for memory.

// Caps are vars (not consts) only so tests can shrink them.
var (
	// fileTreeMaxFiles caps one listing. jj emits paths sorted, so a
	// truncated tree keeps a lexicographic prefix and says so (`truncated`).
	// ~3s of jj time and a few tens of MB of Go heap at the cap.
	fileTreeMaxFiles = 250_000
	// fileTreeCacheEntries / fileTreeCacheFiles bound the LRU by entry count
	// AND total file count (the memory proxy — ~200 B/file of index). The
	// newest entry is always kept even if it alone exceeds the file budget.
	fileTreeCacheEntries = 6
	fileTreeCacheFiles   = 600_000
	// fileTreeMaxDirEntries caps one directory response. A flat dir with more
	// children than this returns the first N (dirs-first order) + `omitted`;
	// search still reaches the rest.
	fileTreeMaxDirEntries = 20_000
)

const (
	// Search result cap (default / hard max).
	fileTreeSearchDefault = 200
	fileTreeSearchMax     = 1000
	// fileTreeLoadTimeout bounds the detached jj run (see fileTreeCache.get).
	fileTreeLoadTimeout = 2 * time.Minute
)

// treeChild is one row of a directory listing. Files carry their jj type;
// directories are synthesized ("dir") with a descendant-file count.
type treeChild struct {
	Name       string `json:"name"`
	Path       string `json:"path"`
	Type       string `json:"type"` // "dir" | "file" | "symlink" | "git-submodule" | "conflict"
	Executable bool   `json:"executable,omitempty"`
	Files      int    `json:"files,omitempty"` // dirs only: files beneath (recursive)
}

// fileTree is the immutable per-commit index. Never mutated after build, so
// concurrent readers need no lock.
type fileTree struct {
	files     []jj.TreeFile
	lower     []string // lowercased paths, parallel to files (search)
	dirs      map[string][]treeChild
	truncated bool
}

// buildFileTree derives the directory index from a flat path listing.
// Children sort directories-first, then case-insensitively by name (byte
// order as tiebreak so the order is total).
func buildFileTree(files []jj.TreeFile, truncated bool) *fileTree {
	t := &fileTree{
		files:     files,
		lower:     make([]string, len(files)),
		dirs:      map[string][]treeChild{"": {}},
		truncated: truncated,
	}
	counts := map[string]int{}
	for i, f := range files {
		t.lower[i] = strings.ToLower(f.Path) // returns f.Path itself when already lower — no copy
		dir, rest := "", f.Path
		for {
			slash := strings.IndexByte(rest, '/')
			if slash < 0 {
				break
			}
			name := rest[:slash]
			sub := name
			if dir != "" {
				sub = dir + "/" + name
			}
			if _, ok := t.dirs[sub]; !ok {
				t.dirs[sub] = []treeChild{}
				t.dirs[dir] = append(t.dirs[dir], treeChild{Name: name, Path: sub, Type: "dir"})
			}
			counts[sub]++
			dir, rest = sub, rest[slash+1:]
		}
		t.dirs[dir] = append(t.dirs[dir], treeChild{Name: rest, Path: f.Path, Type: f.Type, Executable: f.Executable})
	}
	for _, kids := range t.dirs {
		for i := range kids {
			if kids[i].Type == "dir" {
				kids[i].Files = counts[kids[i].Path]
			}
		}
		slices.SortFunc(kids, compareTreeChild)
	}
	return t
}

func compareTreeChild(a, b treeChild) int {
	if ad, bd := a.Type == "dir", b.Type == "dir"; ad != bd {
		if ad {
			return -1
		}
		return 1
	}
	if c := strings.Compare(strings.ToLower(a.Name), strings.ToLower(b.Name)); c != 0 {
		return c
	}
	return strings.Compare(a.Name, b.Name)
}

// fileTreeMatch is a search hit.
type fileTreeMatch struct {
	Path       string `json:"path"`
	Type       string `json:"type"`
	Executable bool   `json:"executable,omitempty"`
}

// search ranks every path against q (case-insensitive) and returns the best
// `limit` plus the total match count. Tiers, best first: basename prefix,
// basename substring, path substring, subsequence (the fuzzy.ts rule — what
// the palette users already know). Within a tier: shorter path, then path.
// Whitespace in q separates terms that must ALL match (each as a substring or,
// failing that, subsequence); the tier is the worst term's tier.
func (t *fileTree) search(q string, limit int) ([]fileTreeMatch, int) {
	terms := strings.Fields(strings.ToLower(q))
	if len(terms) == 0 {
		return []fileTreeMatch{}, 0
	}
	type hit struct {
		idx  int
		tier int
	}
	hits := []hit{}
	for i, lp := range t.lower {
		worst := 0
		for _, term := range terms {
			tier := matchTier(lp, term)
			if tier == 0 {
				worst = 0
				break
			}
			if worst == 0 || tier < worst {
				worst = tier
			}
		}
		if worst > 0 {
			hits = append(hits, hit{i, worst})
		}
	}
	slices.SortFunc(hits, func(a, b hit) int {
		if a.tier != b.tier {
			return b.tier - a.tier
		}
		pa, pb := t.files[a.idx].Path, t.files[b.idx].Path
		if len(pa) != len(pb) {
			return len(pa) - len(pb)
		}
		return strings.Compare(pa, pb)
	})
	out := make([]fileTreeMatch, 0, min(limit, len(hits)))
	for _, h := range hits[:min(limit, len(hits))] {
		f := t.files[h.idx]
		out = append(out, fileTreeMatch{Path: f.Path, Type: f.Type, Executable: f.Executable})
	}
	return out, len(hits)
}

// matchTier: 4 basename prefix, 3 basename substring, 2 path substring,
// 1 subsequence, 0 no match. Both args already lowercased.
func matchTier(lowerPath, term string) int {
	base := lowerPath[strings.LastIndexByte(lowerPath, '/')+1:]
	switch {
	case strings.HasPrefix(base, term):
		return 4
	case strings.Contains(base, term):
		return 3
	case strings.Contains(lowerPath, term):
		return 2
	case isSubsequence(term, lowerPath):
		return 1
	}
	return 0
}

func isSubsequence(q, s string) bool {
	qi := 0
	for i := 0; i < len(s) && qi < len(q); i++ {
		if s[i] == q[qi] {
			qi++
		}
	}
	return qi == len(q)
}

// ── Cache ───────────────────────────────────────────────────────────────────

// fileTreeCache is a small LRU of per-commit indexes with in-flight dedup:
// concurrent requests for the same commit share ONE jj run (expanding three
// folders while the first listing is still running must not spawn three 3s
// subprocesses). Errors are never cached — the next request retries (the
// sync.Once-caches-errors trap, CLAUDE.md).
type fileTreeCache struct {
	mu         sync.Mutex
	entries    []fileTreeEntry // LRU order: oldest first
	inflight   map[string]*fileTreeCall
	maxEntries int
	maxFiles   int
}

type fileTreeEntry struct {
	key  string
	tree *fileTree
}

type fileTreeCall struct {
	done chan struct{}
	tree *fileTree
	err  error
}

func newFileTreeCache() *fileTreeCache {
	return &fileTreeCache{
		inflight:   map[string]*fileTreeCall{},
		maxEntries: fileTreeCacheEntries,
		maxFiles:   fileTreeCacheFiles,
	}
}

// get returns the cached tree for key, or runs load (once across concurrent
// callers). load gets a context DETACHED from the caller's request (bounded by
// fileTreeLoadTimeout): the leader's client navigating away must not fail the
// followers or waste a multi-second listing that's about to be cached. Each
// caller still stops WAITING when its own ctx ends.
func (c *fileTreeCache) get(ctx context.Context, key string, load func(context.Context) (*fileTree, error)) (*fileTree, error) {
	c.mu.Lock()
	for i, e := range c.entries {
		if e.key == key {
			c.entries = append(append(c.entries[:i:i], c.entries[i+1:]...), e) // bump to newest
			c.mu.Unlock()
			return e.tree, nil
		}
	}
	call, ok := c.inflight[key]
	if !ok {
		call = &fileTreeCall{done: make(chan struct{})}
		c.inflight[key] = call
		go func() {
			lctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), fileTreeLoadTimeout)
			defer cancel()
			tree, err := load(lctx)
			c.mu.Lock()
			delete(c.inflight, key)
			if err == nil {
				c.insertLocked(key, tree)
			}
			c.mu.Unlock()
			call.tree, call.err = tree, err
			close(call.done)
		}()
	}
	c.mu.Unlock()
	select {
	case <-call.done:
		return call.tree, call.err
	case <-ctx.Done():
		return nil, ctx.Err()
	}
}

func (c *fileTreeCache) insertLocked(key string, tree *fileTree) {
	c.entries = append(c.entries, fileTreeEntry{key, tree})
	total := 0
	for _, e := range c.entries {
		total += len(e.tree.files)
	}
	// Evict oldest-first while over either budget, always keeping the newest.
	for len(c.entries) > 1 && (len(c.entries) > c.maxEntries || total > c.maxFiles) {
		total -= len(c.entries[0].tree.files)
		c.entries = c.entries[1:]
	}
}

// ── Handlers ────────────────────────────────────────────────────────────────

// errBadRevision marks a revision that resolved to zero or several commits —
// a client error (400), unlike a jj failure (500).
var errBadRevision = errors.New("bad revision")

// fileTreeFor resolves `revision` to a commit id and returns that commit's
// index. Hex commit ids (what the UI always sends) are used as-is and pinned
// with commit_id() — a same-named bookmark/tag must not alias them (see
// commitIdRe). Anything else (`@`, a bookmark — handy for agents) is resolved
// to its commit id FIRST, so the cache key is always content-addressed.
func (s *Server) fileTreeFor(ctx context.Context, revision string) (*fileTree, string, error) {
	commitId := revision
	if !commitIdRe.MatchString(revision) {
		out, err := s.Runner.Run(ctx, jj.ResolveCommitId(revision))
		if err != nil {
			return nil, "", err
		}
		ids := strings.Fields(string(out))
		if len(ids) != 1 {
			return nil, "", fmt.Errorf("%w: %q resolves to %d commits (need exactly 1)", errBadRevision, revision, len(ids))
		}
		commitId = ids[0]
	}
	rev := commitId
	if s.jjSupports(ctx, jj.CommitIdRevsetFn) {
		rev = jj.CommitIdRevset(commitId)
	}
	useJSON := s.jjSupports(ctx, jj.JSONTemplates)
	tree, err := s.fileTrees.get(ctx, commitId, func(lctx context.Context) (*fileTree, error) {
		// ReadBytes: stdout only, byte-exact (paths may end in spaces; Run
		// would also fold a stderr warning into the output on empty stdout).
		var files []jj.TreeFile
		if useJSON {
			out, err := s.Runner.ReadBytes(lctx, jj.FileListJSON(rev))
			if err != nil {
				return nil, err
			}
			files = jj.ParseFileListJSON(string(out))
		} else {
			out, err := s.Runner.ReadBytes(lctx, jj.FileList(rev))
			if err != nil {
				return nil, err
			}
			files = jj.ParseFileList(string(out))
		}
		truncated := len(files) > fileTreeMaxFiles
		if truncated {
			files = slices.Clip(files[:fileTreeMaxFiles])
		}
		return buildFileTree(files, truncated), nil
	})
	return tree, commitId, err
}

func (s *Server) writeFileTreeErr(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, errBadRevision):
		s.writeError(w, http.StatusBadRequest, err.Error())
	case errors.Is(err, context.Canceled):
		// Client went away; nothing useful to write.
	default:
		s.writeError(w, http.StatusInternalServerError, err.Error())
	}
}

// cleanTreeDir normalizes the `dir` query param: "" / "." / "/" = root,
// trailing slashes dropped, no traversal/absolute/NUL. Repo paths are always
// '/'-separated (jj RepoPath), so this uses package path, not filepath.
func cleanTreeDir(d string) (string, error) {
	if strings.ContainsRune(d, 0) {
		return "", fmt.Errorf("invalid dir")
	}
	d = strings.Trim(d, "/")
	if d == "" || d == "." {
		return "", nil
	}
	c := path.Clean(d)
	if c == ".." || strings.HasPrefix(c, "../") {
		return "", fmt.Errorf("path traversal is not allowed")
	}
	return c, nil
}

type fileTreeResponse struct {
	CommitId   string      `json:"commit_id"`
	Dir        string      `json:"dir"`
	Entries    []treeChild `json:"entries"`
	Omitted    int         `json:"omitted,omitempty"` // children beyond fileTreeMaxDirEntries
	TotalFiles int         `json:"total_files"`
	Truncated  bool        `json:"truncated"` // whole listing hit fileTreeMaxFiles
}

// handleFileTree: GET /api/file-tree?revision=<rev>&dir=<repo-relative dir>
// → one directory's children (dirs first). 404 when dir isn't a directory in
// that revision.
func (s *Server) handleFileTree(w http.ResponseWriter, r *http.Request) {
	revision := r.URL.Query().Get("revision")
	if revision == "" {
		s.writeError(w, http.StatusBadRequest, "revision is required")
		return
	}
	dir, err := cleanTreeDir(r.URL.Query().Get("dir"))
	if err != nil {
		s.writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	tree, commitId, err := s.fileTreeFor(r.Context(), revision)
	if err != nil {
		s.writeFileTreeErr(w, err)
		return
	}
	kids, ok := tree.dirs[dir]
	if !ok {
		s.writeError(w, http.StatusNotFound, fmt.Sprintf("no directory %q at this revision", dir))
		return
	}
	resp := fileTreeResponse{CommitId: commitId, Dir: dir, Entries: kids, TotalFiles: len(tree.files), Truncated: tree.truncated}
	if len(kids) > fileTreeMaxDirEntries {
		resp.Entries, resp.Omitted = kids[:fileTreeMaxDirEntries], len(kids)-fileTreeMaxDirEntries
	}
	s.writeJSON(w, r, http.StatusOK, resp)
}

type fileTreeSearchResponse struct {
	CommitId  string          `json:"commit_id"`
	Matches   []fileTreeMatch `json:"matches"`
	Total     int             `json:"total"` // all matches, before the limit
	Truncated bool            `json:"truncated"`
}

// handleFileTreeSearch: GET /api/file-tree/search?revision=&q=&limit=
// → best-first file matches across the whole tree (see fileTree.search).
func (s *Server) handleFileTreeSearch(w http.ResponseWriter, r *http.Request) {
	revision := r.URL.Query().Get("revision")
	q := r.URL.Query().Get("q")
	if revision == "" || strings.TrimSpace(q) == "" {
		s.writeError(w, http.StatusBadRequest, "revision and q are required")
		return
	}
	limit := fileTreeSearchDefault
	if l := r.URL.Query().Get("limit"); l != "" {
		n, err := strconv.Atoi(l)
		if err != nil || n <= 0 {
			s.writeError(w, http.StatusBadRequest, "limit must be a positive integer")
			return
		}
		limit = min(n, fileTreeSearchMax)
	}
	tree, commitId, err := s.fileTreeFor(r.Context(), revision)
	if err != nil {
		s.writeFileTreeErr(w, err)
		return
	}
	matches, total := tree.search(q, limit)
	s.writeJSON(w, r, http.StatusOK, fileTreeSearchResponse{CommitId: commitId, Matches: matches, Total: total, Truncated: tree.truncated})
}
