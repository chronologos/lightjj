# Frontend Caching

Inventories every revision-data cache and the coherence invariants each
relies on. See [ARCHITECTURE.md](ARCHITECTURE.md) for the system overview.

## The keying decision

**jj's commit_id is content-addressed.** Cache entries keyed by commit_id (or a
string embedding commit_ids) need zero invalidation logic — a rewrite mints a
new commit_id, stale entries simply never match again. They sit in the LRU
until evicted, dead but harmless. We call this **self-invalidating**. The
canonical statement lives in the comment above `MAX_CACHE_SIZE` in api.ts.

Entries keyed by **change_id** survive rewrites. Those caches either store data
that is *intentionally* rewrite-stable (collapse preferences, annotations) or
need explicit invalidation. Every cache in this doc falls into one of these two
key-type buckets; when adding a new one, decide which and document why.

Corollary: **op-id changes never touch the response cache.** They fire
`staleCallbacks` → `loadLog()` (graph refresh) but commit_id-keyed entries
stay valid across arbitrary operations.

---

## Inventory

| # | Cache | Location | Key format | Keyed by | Size | Invalidation |
|---|---|---|---|---|---|---|
| 1 | `cache` (response) | api.ts module | `diff:${cid}` · `files:${cid}` · `desc:${cid}` · `diff:${id}:${file}:ctx${n}` | commit_id | `MAX_CACHE_SIZE` | self-invalidating |
| 2 | `_remotes`/`_aliases`/`_info` | api.ts module | promise memo | repo identity | single-slot | `clearSessionMemos()` on tab-switch / hard-refresh |
| 3 | Browser HTTP disk cache | browser | `/api/revision?...&immutable=1` URL | commit_id | browser-managed | `Cache-Control: immutable` — never |
| 4 | `derivedCache` | diff-cache.ts | `diffTargetKey(t)` = commit_id OR `connected(a\|b\|c)` | commit_id-embedding | `DERIVED_CACHE_SIZE` | self-invalidating · `clearDiffCaches()` on hard-refresh |
| 5 | `parsedDiffCache` | diff-cache.ts | raw diff string | content | `DERIVED_CACHE_SIZE` | self-invalidating (same content → same parse) · `clearDiffCaches()` |
| 6 | `collapseStateCache` | diff-cache.ts | **change_id** | change_id | `COLLAPSE_CACHE_SIZE` | none — preferences intentionally survive rewrites · `clearDiffCaches()` |

**Explicitly uncached:** `api.evolog()`, `api.divergence()`, `api.annotations()`,
`api.log()` — see the code comment above each for why.

**Out of scope:** `config.svelte.ts` (user prefs, localStorage + `/api/config`)
and `recent-actions.svelte.ts` (localStorage frequency counter) are preference
stores, not revision caches — no coherence relationship with commit_id/op-id.

---

## Per-cache notes

### 1. Response cache

Three prefixes (`diff:`, `files:`, `desc:`) can be populated by **multiple
callers**:

| Prefix | Populated by |
|---|---|
| `diff:${cid}` | `api.diff()`, `fetchRevision()` batch |
| `files:${cid}` | `api.files()`, `fetchRevision()`, `prefetchFilesBatch()` |
| `desc:${cid}` | `api.description()`, `fetchRevision()` |

**Batch-vs-individual shape coherence.** `fetchRevision()` must seed each key
with a shape byte-identical to what the individual endpoint returns. If
`/api/files` adds a field but `/api/revision`'s `files` array doesn't, cache
consumers get different shapes depending on which path populated the slot.
Tested: `'seeded keys are hit by subsequent individual api calls'`.

**Conflicted-commit skip.** `prefetchFilesBatch()` skips conflicted commits —
the batch template lacks `conflict_sides`. Tested: `'skips seeding conflicted
revisions'`.

**LRU mechanics.** `storeInCache` does delete-then-set so rewrites bump
recency (`Map.set` on an existing key does not reorder).

**Cross-tab.** Module-global, shared across all tabs. commit_id is SHA-256 —
collision across repos is cryptographically negligible. `setActiveTab` does
NOT clear it; switching back to a tab serves cached diffs instantly.

### 2. Promise memos

Session-stable repo config. The *Promise* is memoized (not the resolved
value) so concurrent callers share one request. Error path clears the slot:
`.catch(e => { _remotes = undefined; throw e })` — otherwise a transient
network error memoizes a rejected Promise and every future call rejects until
hard-refresh. Tested (`api.test.ts`: "retries remotes() after failure").

### 3. Browser HTTP cache

Frontend sends `?immutable=1` on `/api/revision` requests (only it knows the
`revision` param is a commit_id). Backend sets `Cache-Control: max-age=31536000,
immutable`. Two backend-side invariants (both tested in `handlers_test.go`):

- **Immutable responses omit `X-JJ-Op-Id`** (`writeJSON` suppresses when
  `Cache-Control` already set). Otherwise a year-old op-id in disk cache
  ping-pongs `lastOpId` on reload.
- **Degraded responses skip the immutable header** (`handleRevision` only
  calls `maybeCacheForever` when all parts succeeded). Otherwise
  `description: ""` caches for a year.

### 4. `derivedCache` (highlights + word-diffs)

App-lifetime (lives in `diff-cache.ts`) — survives DiffPanel unmount
(DivergencePanel replaces it via `{#if}`). Key is `diffTargetKey(diffTarget)`:
commit_id for single-rev, revset string for multi-check — both embed commit_ids,
both self-invalidate.

Both derivations share one LRU bucket via `readMemo`/`writeMemo` accessors so
they evict together. Memo writes store the local accumulator (`done`), not the
live `$state` ref — see `diff-derivation.svelte.ts` for why.

`multiRevset()` sorts ids before joining, so the same set produces the same
key regardless of input order. (The only caller already iterates `revisions`
in log order, so this was never manifest — but the sort makes the function
caller-agnostic at no cost.)

### 5. `parsedDiffCache`

Maps raw diff string → `DiffFile[]`. On A→B→A navigation, returns the same
`DiffFile[]` reference → `DiffFileView`'s `file` prop is ref-equal → its
`$derived` chains stay quiet.

**Lifetime.** In normal navigation each parsed diff corresponds to ≥3 api.ts
cache writes (diff + files + desc), so parsedDiffCache's tighter window
(`DERIVED_CACHE_SIZE`) evicts first. Pathological sequences — heavy context
expansion without navigation — can desync the two LRUs; worst case leaks
~`DERIVED_CACHE_SIZE` diff strings. Not observed in practice.

### 6. `collapseStateCache`

**The one change_id-keyed cache.** Collapse preferences should survive
rewrites — if you collapsed `big_generated_file.go` at commit X, you probably
still want it collapsed after describing (commit → Y). Multi-check collapse
state is not saved (`lastCollapseCacheKey` is null).

After a rewrite that renames files, the cached `Set` contains paths that no
longer exist in the diff → they silently never match. Acceptable — the file
list changed, so losing the preference for that file is correct behavior.

---

## Race-safety layer: generation counters

Not caches, but the mechanism that keeps async writes from clobbering state.

| Counter | Location | Protects |
|---|---|---|
| `loader.generation` | `createLoader()` | result application — `set()` bumps so in-flight `load()` loses |
| `derivation.generation` | `createDiffDerivation()` | per-file writes + memo-write; `update`/`clear`/`tryRestore` all bump |
| `revGen` | `createRevisionNavigator()` | the await-before-load gap (below) |
| `conflictFetchGen` | DiffPanel | in-flight `api.fileShow()` on revision switch |

### The `revGen` await-gap race

`loadDiffAndFiles(commit)` awaits `api.revision()` *before* calling
`diff.load()`. The loader's internal generation invalidates in-flight `load()`
calls — but not calls that haven't fired yet. A suspended `loadDiffAndFiles(A)`
would resume and call `diff.load(A)`, bumping `loader.generation` *past* any
intervening `diff.set(B)`, and win.

```
loadDiffAndFiles(A)
  gen = ++revGen           // revGen=1
  await api.revision(A)    // ── suspended ──────────────────────────┐
                                                                     │
         selectRevision(B) cache-hit:                                │
           revGen++                // revGen=2 ← invalidates A       │
           diff.set(B)             // loader.generation++            │
                                                                     │
  // resumed ───────────────────────────────────────────────────────┘
  if (gen !== revGen) return       // 1 !== 2 → bails ✓
  diff.load(singleTarget(A))       // ← never reached
```

Two generation counters, one outer (`revGen`, guards the await gap) and one
inner (`loader.generation`, guards in-flight results). Neither subsumes the
other. Tested: `'applyCacheHit invalidates suspended loadDiffAndFiles'`
(revision-navigator.svelte.test.ts).

### `getCached` all-or-nothing

`getCached(commitId)` returns null if *any* of `diff:X`/`files:X`/`desc:X`
is missing. LRU eviction is per-key; the three can evict independently. When
one is evicted but two survive, `getCached` → null → full batch refetch —
self-healing, costs one redundant HTTP round-trip. Rare at current LRU size.

### Tab-switch op-id reset

`setActiveTab(B)` sets `lastOpId = null` so tab B's first response seeds it
cleanly. Known bounded race: an in-flight request from tab A can arrive after
the reset and seed A's op-id → B's next response fires one redundant
`loadLog`. Bounded to one extra refresh; App's `!loading` guard prevents
stacking. The **cache write** from that in-flight request is always correct —
commit_id-keyed data is valid regardless of which tab fetched it.

---

## Gaps

None currently open. See BACKLOG.md ("Cache coherence") for the audit trail.
