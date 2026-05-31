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

Corollary: **op-id changes never touch the response cache.** They feed the
frontend's staleness model (below) — graph refresh, never cache invalidation —
and commit_id-keyed entries stay valid across arbitrary operations. The one
exception is the aliases/remotes promise memos (#2), which ARE dropped on
op-id change: they're keyed by repo identity, not commit_id, so "an operation
happened" is the only signal that they might have changed.

---

## Inventory

| # | Cache | Location | Key format | Keyed by | Size | Invalidation |
|---|---|---|---|---|---|---|
| 1 | `cache` (response) | api.ts module | `diff:${cid}` · `files:${cid}` · `desc:${cid}` · `diff:${id}:${file}:ctx${n}` · `range:${from}\x1F${to}\x1F${sortedFiles}` | commit_id | `MAX_CACHE_SIZE` | self-invalidating |
| 2 | `_remotes`/`_aliases`/`_info` | api.ts module | promise memo | repo identity | single-slot | `clearSessionMemos()` on tab-switch / hard-refresh; `_remotes`/`_aliases` (NOT `_info`) also dropped on op-id change |
| 3 | Browser HTTP disk cache | browser | `/api/revision?...&immutable=1` URL | commit_id | browser-managed | `Cache-Control: immutable` — never |
| 4 | `derivedCache` | diff-cache.ts | `diffTargetKey(t)` = commit_id OR `connected(a\|b\|c)` | commit_id-embedding | `DERIVED_CACHE_SIZE` | self-invalidating · `clearDiffCaches()` on hard-refresh |
| 5 | `parsedDiffCache` | diff-cache.ts | raw diff string | content | `DERIVED_CACHE_SIZE` | self-invalidating (same content → same parse) · `clearDiffCaches()` |
| 6 | `collapseStateCache` | diff-cache.ts | **change_id** | change_id | `COLLAPSE_CACHE_SIZE` | none — preferences intentionally survive rewrites · `clearDiffCaches()` |

**Explicitly uncached:** `api.evolog()`, `api.divergence()`, `api.annotations()`,
`api.log()` — see the code comment above each for why.

**Out of scope:** `config.svelte.ts` (user prefs, `/api/config` + localStorage
write-through + `storage` event cross-tab sync) and `recent-actions.svelte.ts`
(last-used timestamps, stored server-side in state.json via
`/api/state/recent-actions`) are preference stores, not revision caches — no
coherence relationship with commit_id/op-id.

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
| `range:${from}\x1F${to}\x1F...` | `api.diffRange()` — uses `\x1F` delimiter since paths can contain `:`; file list sorted via `[...files].sort()` so caller argument order doesn't matter |

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

**Op-id invalidation (aliases/remotes only).** `notifyOpId` drops `_remotes`
and `_aliases` whenever the op-id changes: a CLI `jj config set` or
`git remote add` doesn't itself advance the op-id, but the user's *next*
operation does, and at that point "session-stable" is no longer a safe
assumption. Bounded staleness instead of forever-staleness; the next consumer
(GitModal open, App's throttled mirror refresh) refetches. `_info` is NOT
dropped — repo identity / SSH mode can't change for a running server, and
clearing it would flap the jj feature gates that `resolvedInfo()` feeds
synchronously. Tested (`api.test.ts`: "op-id change drops the aliases/remotes
session memos", "does NOT drop the info memo").

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
| `previewGen` | DiffPanel | barrier-gen — bumped once per identity-change to invalidate ALL in-flight per-file fetches; no single `.value`, so not a `createLoader` candidate |
| `mergeGen` | App (merge mode) | `loadMergeFile`/`saveMergeResult` against rapid j/k in `ConflictQueue` |
| `saveGen` | config.svelte.ts | `saveRemote`'s `onError` callback — overlapping flushes resolving out-of-order would let a stale 422 stomp a fresh ok's null-clear |

### `diffContentKey` — content-matches-target invariant

Not a counter — a **content-key marker**. `loadedTarget` (= `activeRevisionId`
in DiffPanel) flips synchronously at navigate; `diff.value` lags the fetch.
`diffContentKey` is set to `diffTargetKey(target)` only when `diff.value` is
known to hold that target's content (post-`diff.load` resolve with
`applied=true`, or sync via `applyCacheHit`/`loadMulti`). DiffPanel's
derivation effect gates on `diffContentKey === activeRevisionId` — running in
the gap would write `derivedCache[newKey]` with old files, then `tryRestore`
the poisoned entry on the next fire. Three write sites, all in
`createRevisionNavigator`: `loadDiffAndFiles`, `applyCacheHit`, `loadMulti`.
**App must not call `diff.load()` directly** — that's the path that desyncs the
triple. Tested: `describe('diffContentKey')` in
revision-navigator.svelte.test.ts (producer) + DiffPanel.test.ts (consumer).

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
`loadLog`. Bounded to one extra refresh; App's gates prevent stacking. The
**cache write** from that in-flight request is always correct — commit_id-keyed
data is valid regardless of which tab fetched it.

---

## Staleness model

How the frontend decides "this rendered server data no longer reflects the
repo." Not a cache (nothing is stored) but the coherence mechanism that drives
every non-explicit refresh.

**Staleness is derived state, never an event — and it is owned per resource by
`createOpSync` (lib/op-sync.svelte.ts).** Every repo-scoped server resource is a
`createLoader` (owns value/loading/error + generation supersede) paired with an
op-sync (owns refresh policy). App.svelte holds exactly one piece of shared
state: `currentOpId`, written by the `onStale` subscription (record-only — all
policy lives in the syncs).

| Sync | Loader | Policy |
|---|---|---|
| `logSync` | `log` | eager; `run` = `loadLog()` (fetch + cursor reconciliation + diff chase + evolog chain + prefetch) |
| `workspacesSync` | `workspaces` | eager |
| `oplogSync` / `bookmarksSync` | panel loaders | eager, `enabled:` panel-open predicates (op-id staleness while open); panel-open itself calls `refresh()` explicitly so the gate can't defer the first paint |
| `prsSync` / `aliasesSync` / `remotesSync` | mirror loaders | throttled 60s (per-resource timestamps) |
| `staleImmSync` | `staleImm` | throttled 60s + `startFresh` (the scan never runs at mount) |

**The evolog has NO op-sync** — it is *selection-scoped* per-revision data (the
other identity granularity). Every op-id change refreshes the log, and `loadLog`
chains the evolog **after** cursor reconciliation so it always follows the
post-refresh selection; an op-sync run thunk would read the pre-reconciliation
selection and stamp the wrong load as fresh. Its loads are all explicit:
toggle-open, the 50ms selection-follow debounce, and the loadLog chain.

Per sync, the staleness comparison is
`!hasApplied || (currentOpId !== null && currentOpId !== reflectsOpId)`:

- **`reflectsOpId`** — op-id captured at the **start** of the last applied run
  (a lower bound: the response is at least that fresh, since op-ids only
  advance). An op-id arriving mid-fetch leaves the sync stale → exactly one
  more refresh. Conservative, never lossy.
- **`hasApplied`** — a never-loaded resource is stale by definition. This is
  what makes a panel's first open fetch even though `currentOpId` is still
  null (api.ts treats the first observed op-id as the baseline and only fires
  `onStale` on *changes*).
- **`attempted`** (non-reactive on purpose) — one auto attempt per op-id, so a
  persistently failing fetch doesn't retry-loop, and the macrotask-deferred
  re-check can skip the duplicate when a post-mutation flow already called
  `refresh()` explicitly.

The auto-refresh `$effect` is suppressed by the gate
(`loading || mutating || anyModalOpen || inlineMode`) and the `enabled`
predicate — but suppression retains staleness: the gates are dependencies only
while stale, so the effect re-fires the moment one clears. **Explicit
`refresh()` bypasses gate/enabled/throttle** (post-mutation refreshes run while
`mutating` is still true) and resolves only after the value is applied, so
callers can read the mirror right after the await.

**Critical implementation rule: the effect reads its staleness inputs RAW**
(`opId()`, `reflectsOpId`, the completion `epoch`) — never through a memoized
boolean `$derived`. A derived that recomputes true→true does not advance its
write version, so dependent effects do not re-run; folding staleness into a
boolean would silently drop every op-id that arrives while already stale.
Tested: `op-sync.svelte.test.ts` `describe('the three review races')`.

The cursor survives log refreshes because selection is identity-keyed:
`selectedId` (effectiveId) is the `$state`, `selectedIndex` is derived from it
against the current `revisions` list, and `loadLog`'s reconciliation falls
back to the working-copy row only when the selected revision disappeared.
Tested: `App.interactions.test.ts` `describe('staleness + identity cursor')`.

---

## Rejected designs

Documented so they don't get re-proposed. Both were assessed against svelte
5.55 reactivity source during the op-sync design review.

**Reactive content-keyed read-model for the revision navigator** ("replace
`revGen`/`diffContentKey` with a `SvelteMap` keyed by commit_id; displayed diff
= `$derived(map.get(key))`"). The map mechanics are fine — SvelteMap tracks
per-key for present keys and wakes missing-key readers on insertion, and
propagation is synchronous. What kills it: presence-in-map is a **two-state**
signal, but DiffPanel's stale-while-revalidate behavior (snapshot refresh:
show old content, no spinner, scroll preserved — the `isRefresh` path) needs
the **three-state** distinction that `diffContentKey`/`diffPending` encode.
Rebuilding that on top of a keyed map reinvents `diffContentKey` as an "SWR
fallback marker" and deletes nothing. Also: optimistic writes
(`description.set(draft)`) would poison a content-addressed store — `jj undo`
resurrects the old commit_id and the map would serve a never-committed draft.

**Making the api.ts response cache itself reactive** (C16 unification). The
LRU bumps recency on read via delete+reinsert; under SvelteMap that is 2
structural changes × 3 keys = 6 whole-map invalidations per `getCached` hit —
on the cache-hit j/k path whose flagship invariant is **zero** reactive
updates. Eviction would also become user-visible (evicting the displayed key
blanks the screen). The plain-Map cache + loader value slots stay.

---

## Gaps

None currently open.
