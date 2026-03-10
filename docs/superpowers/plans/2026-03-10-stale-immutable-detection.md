# Stale Immutable Detection — Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Detect immutable divergence caused by force-pushes and surface it via MessageBar with one-click cleanup.

**Architecture:** New `GET /api/stale-immutable` endpoint returns actionable immutable divergent pairs (grouped by change_id, filtered by bookmark asymmetry). Frontend calls it after git fetch/push, shows a warning MessageBar with "Clean up" button that calls the existing `POST /api/abandon` with `ignore_immutable: true` and commit_ids.

**Tech Stack:** Go backend (command builder + handler), Svelte 5 frontend (api.ts + App.svelte MessageBar wiring)

**Key simplification:** The existing `POST /api/abandon` with `ignore_immutable: true` already works — `FromIDs` puts IDs into `-r` flags, and jj accepts commit_id prefixes in revsets. No new mutation endpoint needed.

---

## Chunk 1: Backend — Command Builder, Parser, Grouping

### Task 1: StaleImmutableEntry type + template + parser

**Files:**
- Modify: `internal/jj/divergence.go`
- Modify: `internal/jj/divergence_test.go`

- [ ] **Step 1: Write parser test**

Add to `internal/jj/divergence_test.go`:

```go
func TestParseStaleImmutable(t *testing.T) {
	output := "spzmpxnu\x1Fa4eecdf2f0dccfcec69fb4ec1e71fda4b0da6a36\x1F\x1F\x1Fv0.8.0: tab persistence\n" +
		"spzmpxnu\x1F9d3d2a067c6c5e9cc72c3c422ee5416d0c89f765\x1Fv0.8.0\x1Fv0.8.0@origin\x1Fv0.8.0: tab persistence\n"
	got := ParseStaleImmutable(output)
	assert.Equal(t, 2, len(got))
	assert.Equal(t, "spzmpxnu", got[0].ChangeId)
	assert.Equal(t, "a4eecdf2f0dccfcec69fb4ec1e71fda4b0da6a36", got[0].CommitId)
	assert.Equal(t, []string{}, got[0].LocalBookmarks)
	assert.Equal(t, []string{}, got[0].RemoteBookmarks)
	assert.Equal(t, "v0.8.0: tab persistence", got[0].Description)
	assert.Equal(t, []string{"v0.8.0"}, got[1].LocalBookmarks)
	assert.Equal(t, []string{"v0.8.0@origin"}, got[1].RemoteBookmarks)
}

func TestParseStaleImmutable_Empty(t *testing.T) {
	got := ParseStaleImmutable("")
	assert.Equal(t, []StaleImmutableEntry{}, got)
}

func TestParseStaleImmutable_MalformedLine(t *testing.T) {
	got := ParseStaleImmutable("only\x1Ftwo-fields\n")
	assert.Equal(t, []StaleImmutableEntry{}, got)
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Users/iantay/Documents/repos/lightjj && go test ./internal/jj/ -run TestParseStaleImmutable -v`
Expected: FAIL — `ParseStaleImmutable` undefined

- [ ] **Step 3: Add StaleImmutableEntry type + template + parser + command builder**

Add to `internal/jj/divergence.go`:

```go
// StaleImmutableEntry is one commit from the immutable-divergence query.
// Lighter than DivergenceEntry — no parent-ids or WC-reachable (those are
// for mutable stack resolution). We only need bookmarks for the asymmetry
// heuristic and description for the MessageBar details.
type StaleImmutableEntry struct {
	ChangeId        string   `json:"change_id"`
	CommitId        string   `json:"commit_id"`
	LocalBookmarks  []string `json:"local_bookmarks"`
	RemoteBookmarks []string `json:"remote_bookmarks"`
	Description     string   `json:"description"`
}

// Full commit_id (not .short()) — these IDs flow into jj abandon -r via the
// cleanup path. Short prefixes risk ambiguity in large repos. change_id stays
// .short() since it's display-only (the grouping key, never used in commands).
const staleImmutableTemplate = `change_id.short() ++ "\x1F" ++ ` +
	`commit_id ++ "\x1F" ++ ` +
	`local_bookmarks.map(|b| b.name()).join(",") ++ "\x1F" ++ ` +
	`remote_bookmarks.map(|b| b.name() ++ "@" ++ b.remote()).join(",") ++ "\x1F" ++ ` +
	`description.first_line() ++ "\n"`

// StaleImmutable returns args for the immutable-divergence detection query.
// Used after git fetch/push to find force-push leftovers.
func StaleImmutable() CommandArgs {
	return []string{
		"log",
		"-r", "divergent() & immutable()",
		"--no-graph",
		"--color", "never",
		"--ignore-working-copy",
		"-T", staleImmutableTemplate,
	}
}

func ParseStaleImmutable(output string) []StaleImmutableEntry {
	entries := []StaleImmutableEntry{}
	for line := range strings.SplitSeq(output, "\n") {
		if line == "" {
			continue
		}
		f := strings.Split(line, "\x1F")
		if len(f) != 5 {
			continue
		}
		entries = append(entries, StaleImmutableEntry{
			ChangeId:        f[0],
			CommitId:        f[1],
			LocalBookmarks:  splitNonEmpty(f[2], ","),
			RemoteBookmarks: splitNonEmpty(f[3], ","),
			Description:     f[4],
		})
	}
	return entries
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /Users/iantay/Documents/repos/lightjj && go test ./internal/jj/ -run TestParseStaleImmutable -v`
Expected: PASS (all 3 tests)

- [ ] **Step 5: Commit**

```bash
git add internal/jj/divergence.go internal/jj/divergence_test.go
git commit -m "$(cat <<'EOF'
feat: StaleImmutableEntry type + parser for immutable divergence detection

Co-Authored-By: Claude <noreply@anthropic.com>
EOF
)"
```

### Task 2: Grouping + actionable heuristic

**Files:**
- Modify: `internal/jj/divergence.go`
- Modify: `internal/jj/divergence_test.go`

- [ ] **Step 1: Write grouping tests**

Add to `internal/jj/divergence_test.go`:

```go
func TestGroupStaleImmutable_ActionablePair(t *testing.T) {
	entries := []StaleImmutableEntry{
		{ChangeId: "abc", CommitId: "111", LocalBookmarks: []string{}, RemoteBookmarks: []string{}, Description: "v1"},
		{ChangeId: "abc", CommitId: "222", LocalBookmarks: []string{"main"}, RemoteBookmarks: []string{"main@origin"}, Description: "v1"},
	}
	groups := GroupStaleImmutable(entries)
	assert.Equal(t, 1, len(groups))
	assert.Equal(t, "abc", groups[0].ChangeId)
	assert.Equal(t, "111", groups[0].Stale.CommitId)
	assert.Equal(t, "222", groups[0].Keeper.CommitId)
}

func TestGroupStaleImmutable_SymmetricBookmarks_NotActionable(t *testing.T) {
	entries := []StaleImmutableEntry{
		{ChangeId: "abc", CommitId: "111", LocalBookmarks: []string{"main"}, RemoteBookmarks: []string{}, Description: "v1"},
		{ChangeId: "abc", CommitId: "222", LocalBookmarks: []string{}, RemoteBookmarks: []string{"main@origin"}, Description: "v1"},
	}
	groups := GroupStaleImmutable(entries)
	assert.Equal(t, 0, len(groups))
}

func TestGroupStaleImmutable_ThreeCopies_NotActionable(t *testing.T) {
	entries := []StaleImmutableEntry{
		{ChangeId: "abc", CommitId: "111", Description: "v1"},
		{ChangeId: "abc", CommitId: "222", LocalBookmarks: []string{"main"}, Description: "v1"},
		{ChangeId: "abc", CommitId: "333", Description: "v1"},
	}
	groups := GroupStaleImmutable(entries)
	assert.Equal(t, 0, len(groups))
}

func TestGroupStaleImmutable_MultiplePairs(t *testing.T) {
	entries := []StaleImmutableEntry{
		{ChangeId: "abc", CommitId: "111", Description: "feat A"},
		{ChangeId: "abc", CommitId: "222", LocalBookmarks: []string{"feat-a"}, Description: "feat A"},
		{ChangeId: "xyz", CommitId: "333", Description: "feat B"},
		{ChangeId: "xyz", CommitId: "444", RemoteBookmarks: []string{"feat-b@origin"}, Description: "feat B"},
	}
	groups := GroupStaleImmutable(entries)
	assert.Equal(t, 2, len(groups))
}

func TestGroupStaleImmutable_NeitherHasBookmarks_NotActionable(t *testing.T) {
	entries := []StaleImmutableEntry{
		{ChangeId: "abc", CommitId: "111", Description: "v1"},
		{ChangeId: "abc", CommitId: "222", Description: "v1"},
	}
	groups := GroupStaleImmutable(entries)
	assert.Equal(t, 0, len(groups))
}

func TestGroupStaleImmutable_Empty(t *testing.T) {
	groups := GroupStaleImmutable([]StaleImmutableEntry{})
	assert.Equal(t, []StaleImmutableGroup{}, groups)
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /Users/iantay/Documents/repos/lightjj && go test ./internal/jj/ -run TestGroupStaleImmutable -v`
Expected: FAIL — `GroupStaleImmutable` undefined

- [ ] **Step 3: Implement grouping**

Add to `internal/jj/divergence.go`:

```go
// StaleImmutableGroup is one actionable immutable divergent pair.
// Keeper = bookmarked copy (remote considers canonical).
// Stale = un-bookmarked copy (leftover from before force-push).
type StaleImmutableGroup struct {
	ChangeId string               `json:"change_id"`
	Stale    StaleImmutableEntry  `json:"stale"`
	Keeper   StaleImmutableEntry  `json:"keeper"`
}

// GroupStaleImmutable groups entries by change_id and applies the actionable
// heuristic: exactly 2 copies, one has bookmarks (local or remote), the other
// has none. Returns only actionable groups.
func GroupStaleImmutable(entries []StaleImmutableEntry) []StaleImmutableGroup {
	groups := []StaleImmutableGroup{}
	byChange := map[string][]StaleImmutableEntry{}
	// Preserve insertion order for deterministic output.
	var order []string
	for _, e := range entries {
		if _, exists := byChange[e.ChangeId]; !exists {
			order = append(order, e.ChangeId)
		}
		byChange[e.ChangeId] = append(byChange[e.ChangeId], e)
	}
	for _, cid := range order {
		copies := byChange[cid]
		if len(copies) != 2 {
			continue
		}
		bm0 := len(copies[0].LocalBookmarks) + len(copies[0].RemoteBookmarks)
		bm1 := len(copies[1].LocalBookmarks) + len(copies[1].RemoteBookmarks)
		// Asymmetric: exactly one has bookmarks.
		if (bm0 == 0) == (bm1 == 0) {
			continue
		}
		if bm0 > 0 {
			groups = append(groups, StaleImmutableGroup{ChangeId: cid, Keeper: copies[0], Stale: copies[1]})
		} else {
			groups = append(groups, StaleImmutableGroup{ChangeId: cid, Keeper: copies[1], Stale: copies[0]})
		}
	}
	return groups
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd /Users/iantay/Documents/repos/lightjj && go test ./internal/jj/ -run TestGroupStaleImmutable -v`
Expected: PASS (all 6 tests)

- [ ] **Step 5: Commit**

```bash
git add internal/jj/divergence.go internal/jj/divergence_test.go
git commit -m "$(cat <<'EOF'
feat: GroupStaleImmutable with bookmark-asymmetry heuristic

Co-Authored-By: Claude <noreply@anthropic.com>
EOF
)"
```

### Task 3: Command builder test

**Files:**
- Modify: `internal/jj/divergence_test.go`

- [ ] **Step 1: Write command builder test**

```go
func TestStaleImmutable(t *testing.T) {
	got := StaleImmutable()
	assert.Equal(t, "log", got[0])
	assert.Contains(t, got, "divergent() & immutable()")
	assert.Contains(t, got, "--no-graph")
	assert.Contains(t, got, "--ignore-working-copy")
}
```

- [ ] **Step 2: Run test**

Run: `cd /Users/iantay/Documents/repos/lightjj && go test ./internal/jj/ -run TestStaleImmutable -v`
Expected: PASS (already implemented in Task 1)

- [ ] **Step 3: Commit**

```bash
git add internal/jj/divergence_test.go
git commit -m "$(cat <<'EOF'
test: StaleImmutable command builder test

Co-Authored-By: Claude <noreply@anthropic.com>
EOF
)"
```

## Chunk 2: Backend — HTTP Handler

### Task 4: GET /api/stale-immutable endpoint

**Files:**
- Modify: `internal/api/handlers.go`
- Modify: `internal/api/server.go`
- Modify: `internal/api/handlers_test.go`

- [ ] **Step 1: Write handler test**

Add to `internal/api/handlers_test.go`:

```go
func TestHandleStaleImmutable(t *testing.T) {
	runner := testutil.NewMockRunner(t)
	runner.Expect(jj.StaleImmutable()).SetOutput([]byte(
		"abc\x1F1110000000000000000000000000000000000000\x1F\x1F\x1Ffeat A\n" +
		"abc\x1F2220000000000000000000000000000000000000\x1Fmain\x1Fmain@origin\x1Ffeat A\n",
	))
	defer runner.Verify()

	srv := newTestServer(runner)
	req := httptest.NewRequest("GET", "/api/stale-immutable", nil)
	w := httptest.NewRecorder()
	srv.Mux.ServeHTTP(w, req)
	assert.Equal(t, http.StatusOK, w.Code)

	var groups []jj.StaleImmutableGroup
	json.Unmarshal(w.Body.Bytes(), &groups)
	assert.Equal(t, 1, len(groups))
	assert.Equal(t, "111", groups[0].Stale.CommitId)
	assert.Equal(t, "222", groups[0].Keeper.CommitId)
}

func TestHandleStaleImmutable_Empty(t *testing.T) {
	runner := testutil.NewMockRunner(t)
	runner.Expect(jj.StaleImmutable()).SetOutput([]byte(""))
	defer runner.Verify()

	srv := newTestServer(runner)
	req := httptest.NewRequest("GET", "/api/stale-immutable", nil)
	w := httptest.NewRecorder()
	srv.Mux.ServeHTTP(w, req)
	assert.Equal(t, http.StatusOK, w.Code)
	assert.Equal(t, "[]\n", w.Body.String())
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Users/iantay/Documents/repos/lightjj && go test ./internal/api/ -run TestHandleStaleImmutable -v`
Expected: FAIL — 404 (route not registered)

- [ ] **Step 3: Add handler + route**

Add to `internal/api/handlers.go` (near `handleDivergence`):

```go
func (s *Server) handleStaleImmutable(w http.ResponseWriter, r *http.Request) {
	output, err := s.Runner.Run(r.Context(), jj.StaleImmutable())
	if err != nil {
		s.writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	entries := jj.ParseStaleImmutable(string(output))
	s.writeJSON(w, r, http.StatusOK, jj.GroupStaleImmutable(entries))
}
```

Add to `internal/api/server.go` in `routes()`, in the GET section after the `divergence` line:

```go
s.Mux.HandleFunc("GET /api/stale-immutable", s.handleStaleImmutable)
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd /Users/iantay/Documents/repos/lightjj && go test ./internal/api/ -run TestHandleStaleImmutable -v`
Expected: PASS

- [ ] **Step 5: Run full backend test suite**

Run: `cd /Users/iantay/Documents/repos/lightjj && go test ./...`
Expected: All pass

- [ ] **Step 6: Commit**

```bash
git add internal/api/handlers.go internal/api/server.go internal/api/handlers_test.go
git commit -m "$(cat <<'EOF'
feat: GET /api/stale-immutable endpoint

Co-Authored-By: Claude <noreply@anthropic.com>
EOF
)"
```

## Chunk 3: Frontend — API Client + App Wiring

### Task 5: api.ts — staleImmutable() method

**Files:**
- Modify: `frontend/src/lib/api.ts`

- [ ] **Step 1: Add StaleImmutableGroup type + api method**

Add the type near the other divergence types (around line 55):

```typescript
export interface StaleImmutableGroup {
  change_id: string
  stale: { commit_id: string; description: string; local_bookmarks: string[]; remote_bookmarks: string[] }
  keeper: { commit_id: string; description: string; local_bookmarks: string[]; remote_bookmarks: string[] }
}
```

Add the method in the `api` object (near the `divergence` method, around line 795):

```typescript
staleImmutable: () => request<StaleImmutableGroup[]>('/api/stale-immutable'),
```

- [ ] **Step 2: Commit**

```bash
git add frontend/src/lib/api.ts
git commit -m "$(cat <<'EOF'
feat: api.staleImmutable() client method

Co-Authored-By: Claude <noreply@anthropic.com>
EOF
)"
```

### Task 6: App.svelte — stale immutable MessageBar wiring

**Files:**
- Modify: `frontend/src/App.svelte`

- [ ] **Step 1: Add stale-immutable state**

Near the `workspaceStale` state declaration (around line 77):

```typescript
// Stale immutable detection — force-push leftovers. Set after git fetch/push,
// cleared after cleanup or if resolved externally.
let staleImmutableGroups = $state<StaleImmutableGroup[]>([])
```

Add `StaleImmutableGroup` to the api.ts import.

- [ ] **Step 2: Add detection trigger after git fetch/push**

Modify `handleGitOp` (around line 985). In the `after` callback, fire stale-immutable detection:

Change:
```typescript
{ after: () => loadPullRequests() },
```
To:
```typescript
{ after: () => { loadPullRequests(); checkStaleImmutable() } },
```

Add the detection function near the other handlers:

```typescript
function checkStaleImmutable() {
  api.staleImmutable().then(groups => {
    // Guard: skip [] → [] to avoid no-op reactivity on every fetch/push.
    if (groups.length > 0 || staleImmutableGroups.length > 0) {
      staleImmutableGroups = groups
    }
  }).catch(() => {
    // Silent — detection is best-effort. Don't block the user with
    // an error about a background check.
  })
}
```

- [ ] **Step 3: Add cleanup handler**

```typescript
function handleCleanupStaleImmutable() {
  const staleIds = staleImmutableGroups.map(g => g.stale.commit_id)
  runMutation(
    () => api.abandon(staleIds, true),
    `Cleaned up ${staleIds.length} stale immutable commit${staleIds.length !== 1 ? 's' : ''}`,
    { after: () => { staleImmutableGroups = [] } },
  )
}
```

- [ ] **Step 4: Wire into MessageBar via displayMessage**

The stale-immutable message is lower priority than mutation errors, higher than stale-WC (stale-WC blocks mutations; stale-immutable doesn't). Update the `displayMessage` derived:

Change:
```typescript
let displayMessage = $derived(message ?? (workspaceStale ? staleWCMessage : null))
```
To:
```typescript
const staleImmutableMessage: Message | null = $derived(staleImmutableGroups.length > 0 ? {
  kind: 'warning' as const,
  text: `${staleImmutableGroups.length} stale immutable commit${staleImmutableGroups.length !== 1 ? 's' : ''} (likely force-pushed remotely)`,
  details: staleImmutableGroups.map(g =>
    `${g.stale.commit_id.slice(0, 8)} "${g.stale.description}" — keeper: ${g.keeper.commit_id.slice(0, 8)} (${g.keeper.local_bookmarks.concat(g.keeper.remote_bookmarks).join(', ')})`
  ).join('\n'),
  action: { label: 'Clean up', onClick: handleCleanupStaleImmutable },
} : null)

let displayMessage = $derived(message ?? (workspaceStale ? staleWCMessage : staleImmutableMessage))
```

- [ ] **Step 5: Commit**

```bash
git add frontend/src/App.svelte
git commit -m "$(cat <<'EOF'
feat: stale immutable detection after git fetch/push with MessageBar cleanup

Co-Authored-By: Claude <noreply@anthropic.com>
EOF
)"
```

### Task 7: Final verification + docs update

**Files:**
- Modify: `docs/jj-divergence.md`

- [ ] **Step 1: Run full backend tests**

Run: `cd /Users/iantay/Documents/repos/lightjj && go test ./...`
Expected: All pass

- [ ] **Step 2: Build frontend**

Run: `cd /Users/iantay/Documents/repos/lightjj/frontend && pnpm run build`
Expected: Build succeeds (no TS errors)

- [ ] **Step 3: Build binary**

Run: `cd /Users/iantay/Documents/repos/lightjj && go build ./cmd/lightjj`
Expected: Build succeeds

- [ ] **Step 4: Add docs section to jj-divergence.md**

Append to `docs/jj-divergence.md` before "## Open questions":

```markdown
## Stale immutable detection (shipped 2026-03-10)

Force-push from another machine creates immutable divergence: both copies are in trunk, neither clearable by `jj util gc`. The `divergent() & mutable()` revset misses them entirely.

**Detection:** `GET /api/stale-immutable` runs `jj log -r 'divergent() & immutable()'`, groups by change_id, filters to actionable pairs (exactly 2 copies, bookmark asymmetry — one has bookmarks, the other doesn't). The bookmarked copy is the keeper (remote considers it canonical after force-push).

**Trigger:** Post-git-fetch/push only. Zero overhead during normal editing.

**Resolution:** MessageBar warning with "Clean up" button → `POST /api/abandon` with `ignore_immutable: true` and the stale commit_ids. Reuses the existing abandon endpoint — jj accepts commit_id prefixes in `-r` flags, which disambiguates divergent copies that share a change_id.

**Why bookmark asymmetry works:** `jj git fetch` moves remote-tracking bookmarks to the newly imported commit. The old local copy loses its bookmark — it's an orphan. Verified empirically with force-push of tagged release.
```

- [ ] **Step 5: Commit**

```bash
git add docs/jj-divergence.md
git commit -m "$(cat <<'EOF'
docs: stale immutable detection in jj-divergence.md

Co-Authored-By: Claude <noreply@anthropic.com>
EOF
)"
```
