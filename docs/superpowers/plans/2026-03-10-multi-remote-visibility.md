# Multi-Remote Visibility Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Per-remote and per-bookmark visibility toggles that control which remote bookmarks appear in the revision graph and as badges.

**Architecture:** Expand the jj log template to emit all bookmarks (local + remote). Frontend filters by visibility config (persisted in config.json). BookmarksPanel gains grouped-by-remote view with eye toggles. "Tracked" view toggle removed; Log view dynamically includes visible remote bookmarks in its revset.

**Tech Stack:** Go backend (jj template/parser), Svelte 5 frontend (TypeScript), existing config system (config.svelte.ts + /api/config).

**Key corrections from review:**
- jj revset: `remote_bookmarks(remote="upstream")` (named arg), NOT `remote_bookmarks("upstream")` (that's a bookmark name pattern)
- Svelte 5: NO event modifiers (`onclick|stopPropagation` is Svelte 4). Use `onclick={(e) => { e.stopPropagation(); ... }}`
- `hasLabels` guard must be updated in the `flatLines` JS computation, not just in the template
- BookmarksPanel: `rows` → `panelRows` across ALL references (j/k bounds, empty state, count, restore)
- `PanelRow` union: all `.bm` accesses must narrow to `kind === 'bookmark'` first

---

## Chunk 1: Backend + Config + Remote Badges

### Task 1: Expand log template to emit all bookmarks

**Files:**
- Modify: `internal/jj/commands.go:58-66`
- Modify: `internal/jj/commands_test.go`
- Modify: `internal/parser/graph_test.go`

The log template currently uses `local_bookmarks.map(|b| b.name())`. Change to `bookmarks.map(|b| if(b.remote(), b.name() ++ "@" ++ b.remote(), b.name()))`. This emits local bookmarks as `main` and remote bookmarks as `main@origin`. `.name()` strips the `*` suffix for bookmarks ahead of their remote.

- [ ] **Step 1: Update the log template in commands.go**

Change line 65 — the last segment of the template string:
```
FROM: local_bookmarks.map(|b| b.name()).join("\x1F")
TO:   bookmarks.map(|b| if(b.remote(), b.name() ++ "@" ++ b.remote(), b.name())).join("\x1F")
```

Update the comment on lines 62-63:
```go
// Uses bookmarks.map(|b| if(b.remote(), b.name() ++ "@" ++ b.remote(), b.name()))
// — emits local bookmarks as "name" and remote as "name@remote". .name() strips
// the * suffix for bookmarks ahead of their remote.
```

- [ ] **Step 2: Add commands_test.go regression assertion**

In `TestLogGraph`, add an assertion that the template contains `bookmarks.map` and NOT `local_bookmarks`:
```go
joined := strings.Join(got, " ")
assert.Contains(t, joined, "bookmarks.map")
assert.NotContains(t, joined, "local_bookmarks")
```

- [ ] **Step 3: Update graph parser tests**

In `internal/parser/graph_test.go`, update `TestParseGraphLog_LinearHistory`:

Change the first row's bookmark field from `\x1fmain\n` to `\x1fmain\x1fmain@origin\n` and update the assertion:
```go
assert.Equal(t, []string{"main", "main@origin"}, rows[0].Bookmarks)
```

Add a new test for remote-only bookmarks:
```go
func TestParseGraphLog_RemoteOnlyBookmarks(t *testing.T) {
	output := "◆  _PREFIX:a_PREFIX:1_PREFIX:false_PREFIX:false\x1fabcdefgh\x1f12345678\x1ffix something\x1f\x1f00000000\x1ffeat/foo@upstream\n"
	rows := ParseGraphLog(output)
	require.Len(t, rows, 1)
	assert.Equal(t, []string{"feat/foo@upstream"}, rows[0].Bookmarks)
}
```

- [ ] **Step 4: Run tests**

Run: `go test ./... -v`
Expected: all pass

- [ ] **Step 5: Commit**

```bash
jj describe -m 'feat: expand log template to emit local + remote bookmarks'
jj new
```

### Task 2: Add remoteVisibility to config system

**Files:**
- Modify: `frontend/src/lib/api.ts` (type only)
- Modify: `frontend/src/lib/config.svelte.ts`

- [ ] **Step 1: Add RemoteVisibility type to api.ts**

Add near the other type exports:
```typescript
export interface RemoteVisibilityEntry {
  visible: boolean
  hidden?: string[]
}

export type RemoteVisibility = Record<string, RemoteVisibilityEntry>
```

- [ ] **Step 2: Add to Config interface and defaults in config.svelte.ts**

```typescript
import type { RemoteVisibility } from './api'
```

Add `remoteVisibility: RemoteVisibility` to `Config` interface.
Add `remoteVisibility: {},` to `defaults`.
Add getter/setter in `createConfig()` return:
```typescript
get remoteVisibility() { return state.remoteVisibility },
set remoteVisibility(v: RemoteVisibility) { state.remoteVisibility = v },
```

- [ ] **Step 3: Build and verify config round-trip**

Run: `cd frontend && pnpm run build`
Manual test via browser console — POST then GET `/api/config`, confirm `remoteVisibility` round-trips.

- [ ] **Step 4: Commit**

```bash
jj describe -m 'feat: add remoteVisibility to config system'
jj new
```

### Task 3: Remote badge rendering in RevisionGraph

**Files:**
- Modify: `frontend/src/lib/RevisionGraph.svelte`

- [ ] **Step 1: Add prop + helper**

Add `remoteVisibility: RemoteVisibility` prop. Add helper:
```typescript
function isRemoteVisible(ref: string, vis: RemoteVisibility): boolean {
  const atIdx = ref.lastIndexOf('@')
  if (atIdx < 0) return false
  const name = ref.slice(0, atIdx)
  const remote = ref.slice(atIdx + 1)
  const entry = vis[remote]
  if (!entry?.visible) return false
  if (entry.hidden?.includes(name)) return false
  return true
}
```

- [ ] **Step 2: Update `flatLines` JS to account for visibility in `hasLabels`**

In the `flatLines` `$derived.by()` (around line 170-200), where `hasLabels` is computed per entry:
```typescript
// OLD:
const hasLabels = (entry.bookmarks?.length ?? 0) + (entry.commit.working_copies?.length ?? 0) > 0

// NEW — filter before counting:
const localBms = (entry.bookmarks ?? []).filter(b => !b.includes('@'))
const visibleRemoteBms = (entry.bookmarks ?? []).filter(b => b.includes('@') && isRemoteVisible(b, remoteVisibility))
const hasLabels = (localBms.length + visibleRemoteBms.length + (entry.commit.working_copies?.length ?? 0)) > 0
```

This prevents blank 18px rows when all bookmarks on a commit are remote-only and invisible.

- [ ] **Step 3: Split bookmarks in the template**

In the node-line rendering block (around line 450), replace the `{#each entry.bookmarks ?? [] as bm}` with:
```svelte
{@const localBookmarks = (entry.bookmarks ?? []).filter(b => !b.includes('@'))}
{@const visibleRemoteBookmarks = (entry.bookmarks ?? []).filter(b => b.includes('@') && isRemoteVisible(b, remoteVisibility))}
{#each localBookmarks as bm}
  <!-- existing local bookmark rendering unchanged -->
{/each}
{#each visibleRemoteBookmarks as ref}
  {@const atIdx = ref.lastIndexOf('@')}
  <span class="remote-bookmark-badge">{ref.slice(atIdx + 1)}/{ref.slice(0, atIdx)}</span>
{/each}
```

- [ ] **Step 4: Add CSS for remote-bookmark-badge**

```css
.remote-bookmark-badge {
  display: inline-flex;
  align-items: center;
  padding: 0 4px;
  border-radius: 3px;
  font-size: 9px;
  font-weight: 500;
  color: var(--overlay0);
  border: 1px solid var(--surface0);
  line-height: 1.15;
  letter-spacing: 0.02em;
  vertical-align: baseline;
}
```

- [ ] **Step 5: Wire prop from App.svelte**

Pass `remoteVisibility={config.remoteVisibility}` to `RevisionGraph`.

- [ ] **Step 6: Build and verify**

Run: `cd frontend && pnpm run build`

- [ ] **Step 7: Commit**

```bash
jj describe -m 'feat: render visible remote bookmarks as subdued badges in revision graph'
jj new
```

### Task 4: Revset construction + remove Tracked view

**Files:**
- Modify: `frontend/src/App.svelte`
- Modify: `frontend/src/lib/RevisionGraph.svelte` (prop types + template)
- Modify: `frontend/src/lib/RevisionGraph.test.ts`

- [ ] **Step 1: Add buildVisibilityRevset helper in App.svelte**

```typescript
function buildVisibilityRevset(vis: RemoteVisibility, bookmarks: Bookmark[]): string {
  const parts: string[] = []
  for (const [remote, entry] of Object.entries(vis)) {
    if (!entry.visible) continue
    if (!entry.hidden?.length) {
      // All bookmarks in this remote visible — named remote arg
      parts.push(`remote_bookmarks(remote="${remote}")`)
    } else {
      const hidden = new Set(entry.hidden)
      const visible = bookmarks
        .flatMap(bm => (bm.remotes ?? [])
          .filter(r => r.remote === remote && !hidden.has(bm.name))
          .map(() => `"${bm.name}@${remote}"`)
        )
      if (visible.length > 0) parts.push(visible.join(' | '))
    }
  }
  if (parts.length === 0) return ''
  return `ancestors(${parts.join(' | ')}, 2)`
}
```

Note: uses `remote_bookmarks(remote="upstream")` — the named `remote=` arg. Single-arg `remote_bookmarks("upstream")` matches by bookmark name pattern, not remote name (verified empirically).

- [ ] **Step 2: Replace TRACKED_REVSET and viewMode**

Delete `TRACKED_REVSET`. The bookmarks data comes from the loader — find the correct variable name in App.svelte (likely `bookmarksLoader.value` or the prop passed to BookmarksPanel).

```typescript
let visibilityRevset = $derived(buildVisibilityRevset(config.remoteVisibility, bookmarkData))

const viewMode = $derived(
  revsetFilter === '' || revsetFilter === visibilityRevset ? 'log' : 'custom'
)
```

- [ ] **Step 3: Add visibility-change effect**

```typescript
$effect(() => {
  const vr = visibilityRevset
  untrack(() => {
    if (viewMode === 'log') {
      revsetFilter = vr
      handleRevsetSubmit()
    }
  })
})
```

- [ ] **Step 4: Simplify RevisionGraph props and template**

Remove `'tracked'` from `viewMode` type → `viewMode: 'log' | 'custom'`.
Remove `onviewmodechange` prop.
Replace Log/Tracked toggle buttons:
```svelte
{#if viewMode === 'custom'}
  <span class="view-btn view-btn-active">Custom</span>
{/if}
```

- [ ] **Step 5: Update RevisionGraph.test.ts**

Remove or update tests referencing `viewMode: 'tracked'` and the `onviewmodechange` callback. Update test props to match the new interface (no `onviewmodechange`, `viewMode` without `'tracked'`).

- [ ] **Step 6: Clean up App.svelte**

Remove in the SAME commit as Step 4 (transient inconsistency otherwise):
- `TRACKED_REVSET` constant
- `'Switch to tracked view'` palette command (replace with nothing or a toggle command)
- `onviewmodechange` prop on RevisionGraph element
- `setViewMode` function (or simplify to only handle `'log'`)

- [ ] **Step 7: Build and test**

```bash
go test ./... && go vet ./...
cd frontend && pnpm run build
```

- [ ] **Step 8: Commit**

```bash
jj describe -m 'feat: dynamic revset from visibility config, remove Tracked view toggle'
jj new
```

## Chunk 2: BookmarksPanel Grouped View

### Task 5: Restructure BookmarksPanel into grouped-by-remote view

**Files:**
- Modify: `frontend/src/lib/BookmarksPanel.svelte`
- Modify: `frontend/src/lib/BookmarksPanel.test.ts`

This is the largest task. The flat list becomes a two-level tree: remote groups → bookmarks.

- [ ] **Step 1: Define group data structure**

```typescript
interface GroupRow {
  kind: 'group'
  remote: string
  label: string
  count: number
  expanded: boolean
  visibility: RemoteVisibilityEntry | null  // null = local (no toggle)
}

interface BookmarkRow {
  kind: 'bookmark'
  bm: Bookmark
  sync: SyncState
  remote: string
  visibleInLog: boolean
}

type PanelRow = GroupRow | BookmarkRow
```

Add new props:
```typescript
remoteVisibility: RemoteVisibility
onvisibilitychange: (vis: RemoteVisibility) => void
```

- [ ] **Step 2: Build grouped row list with dual-membership**

Bookmarks with both local AND remote presence appear in BOTH groups. The local group is for interaction (jump, delete, push); the remote group is for eye toggle control.

```typescript
let expandedGroups = $state(new Set<string>(['.']))

let panelRows = $derived.by((): PanelRow[] => {
  const result: PanelRow[] = []

  // 1. Local group
  const localBms = bookmarks.filter(bm => bm.local)
  const filteredLocal = query ? localBms.filter(b => fuzzyMatch(query, b.name)) : localBms
  result.push({
    kind: 'group', remote: '.', label: 'LOCAL',
    count: filteredLocal.length, expanded: expandedGroups.has('.'),
    visibility: null,
  })
  if (expandedGroups.has('.')) {
    for (const bm of filteredLocal
      .map(bm => ({ bm, sync: classifyBookmark(bm) }))
      .sort((a, b) => {
        const p = syncPriority(a.sync) - syncPriority(b.sync)
        return p !== 0 ? p : a.bm.name.localeCompare(b.bm.name)
      })) {
      result.push({ kind: 'bookmark', bm: bm.bm, sync: bm.sync, remote: '.', visibleInLog: true })
    }
  }

  // 2. Per-remote groups — includes bookmarks that ALSO have local presence
  for (const remote of allRemotes) {
    const entry = remoteVisibility[remote]
    const remoteBms = bookmarks.filter(bm => bm.remotes?.some(r => r.remote === remote))
    const filtered = query ? remoteBms.filter(b => fuzzyMatch(query, b.name)) : remoteBms
    result.push({
      kind: 'group', remote, label: remote.toUpperCase(),
      count: filtered.length, expanded: expandedGroups.has(remote),
      visibility: entry ?? { visible: false },
    })
    if (expandedGroups.has(remote)) {
      for (const bm of filtered.sort((a, b) => a.name.localeCompare(b.name))) {
        const hidden = entry?.hidden?.includes(bm.name) ?? false
        result.push({
          kind: 'bookmark', bm, sync: classifyBookmark(bm), remote,
          visibleInLog: (entry?.visible ?? false) && !hidden,
        })
      }
    }
  }
  return result
})
```

- [ ] **Step 3: Update all `rows` references to `panelRows`**

Replace EVERY reference to the old `rows` variable:
- `rows.length` → `panelRows.length` (in empty-state check and count display)
- `rows[index]` → `panelRows[index]` (selected derivation)
- `Math.max(rows.length - 1, 0)` → `Math.max(panelRows.length - 1, 0)` (j/k bounds)
- `rows.findIndex(...)` → must narrow to BookmarkRow

Update `selected`:
```typescript
let selected = $derived(panelRows[index] as PanelRow | undefined)
```

Update `selActions` — guard on BookmarkRow:
```typescript
let selActions = $derived(
  selected?.kind === 'bookmark' ? computeActions(selected.bm) : null
)
```

Update `can` — guard `forget` on bookmark:
```typescript
let can = $derived({
  jump: selActions?.jump ?? false,
  del: selActions?.del ?? false,
  pushDelete: selActions?.pushDelete ?? [],
  forget: selected?.kind === 'bookmark',
  track: trackInfo.length > 0,
})
```

Update `lastSelectedName` restore:
```typescript
$effect(() => {
  void bookmarks
  untrack(() => {
    if (lastSelectedName) {
      const i = panelRows.findIndex(r => r.kind === 'bookmark' && r.bm.name === lastSelectedName)
      if (i >= 0) index = i
    }
    if (index >= panelRows.length && panelRows.length > 0) index = panelRows.length - 1
  })
})
$effect(() => { lastSelectedName = selected?.kind === 'bookmark' ? selected.bm.name : undefined })
```

Count display: `<span class="bp-count">{panelRows.filter(r => r.kind === 'bookmark').length}</span>`

- [ ] **Step 4: Guard `d`/`f`/`t` handlers against GroupRow**

At the top of the switch block that handles `d`/`f`/`t`, before the existing cases, add an early return:
```typescript
// After `if (!row) { ... return }`:
if (selected?.kind !== 'bookmark') {
  if (['d', 'f', 't'].includes(e.key)) e.preventDefault()
  return
}
// Now `selected` is narrowed to BookmarkRow
```

- [ ] **Step 5: Add `e` key handler**

```typescript
case 'e': {
  e.preventDefault()
  const row = panelRows[index]
  if (!row) return
  if (row.kind === 'group' && row.visibility) {
    const vis = { ...remoteVisibility }
    const current = vis[row.remote]
    vis[row.remote] = { ...current, visible: !current?.visible, hidden: current?.hidden ?? [] }
    onvisibilitychange(vis)
  } else if (row.kind === 'bookmark' && row.remote !== '.') {
    const vis = { ...remoteVisibility }
    const entry = vis[row.remote]
    if (!entry?.visible) return
    const hidden = new Set(entry.hidden ?? [])
    if (hidden.has(row.bm.name)) hidden.delete(row.bm.name)
    else hidden.add(row.bm.name)
    vis[row.remote] = { ...entry, hidden: [...hidden] }
    onvisibilitychange(vis)
  }
  return
}
```

Update Enter for groups:
```typescript
case 'Enter':
  e.preventDefault()
  e.stopPropagation()
  confirm.disarm()
  if (selected?.kind === 'group') {
    const next = new Set(expandedGroups)
    if (next.has(selected.remote)) next.delete(selected.remote)
    else next.add(selected.remote)
    expandedGroups = next
  } else if (can.jump && selected?.kind === 'bookmark') {
    onjump(selected.bm)
  }
  return
```

- [ ] **Step 6: Update footer with `e` key hint**

Add after the `track` span in the footer:
```svelte
<span class:dim={selected?.kind === 'group' ? !selected.visibility : selected?.remote === '.'}><kbd>e</kbd> eye</span>
```

- [ ] **Step 7: Update template for grouped rendering**

Replace `{#each rows ...}` block. Eye buttons use Svelte 5 event handling (NO `|stopPropagation`):

For group header eye button:
```svelte
<button class="bp-eye" class:bp-eye-off={!row.visibility.visible}
  onclick={(ev: MouseEvent) => {
    ev.stopPropagation()
    const vis = { ...remoteVisibility }
    const current = vis[row.remote]
    vis[row.remote] = { ...current, visible: !current?.visible, hidden: current?.hidden ?? [] }
    onvisibilitychange(vis)
  }}
  title={row.visibility.visible ? 'Hide from revision graph' : 'Show in revision graph'}>
  👁
</button>
```

The `.bp-eye-off` CSS class handles the visual difference (opacity: 0.3) — no need for different emoji.

For per-bookmark eye button:
```svelte
<button class="bp-eye bp-eye-inline" class:bp-eye-off={!row.visibleInLog}
  onclick={(ev: MouseEvent) => {
    ev.stopPropagation()
    const vis = { ...remoteVisibility }
    const entry = vis[row.remote]
    if (!entry?.visible) return
    const hidden = new Set(entry.hidden ?? [])
    if (hidden.has(row.bm.name)) hidden.delete(row.bm.name)
    else hidden.add(row.bm.name)
    vis[row.remote] = { ...entry, hidden: [...hidden] }
    onvisibilitychange(vis)
  }}
  title={row.visibleInLog ? 'Hide from revision graph' : 'Show in revision graph'}>
  👁
</button>
```

- [ ] **Step 8: Add CSS for group rows and eye toggles**

See CSS block in design (bp-group-row, bp-chevron, bp-group-label, bp-group-count, bp-eye, bp-eye-off, bp-eye-inline, bp-bookmark-row, bp-row-hidden).

- [ ] **Step 9: Wire from App.svelte**

```typescript
remoteVisibility={config.remoteVisibility}
onvisibilitychange={(vis) => { config.remoteVisibility = vis }}
```

- [ ] **Step 10: Update BookmarksPanel.test.ts**

Existing tests reference `rows` via `.bp-name` queries. After the refactor:
- Group header rows have `.bp-group-label` instead of `.bp-name`
- Bookmark rows still have `.bp-name`
- Tests querying `.bp-name` will skip group headers naturally (good)

Update test props to include new required props:
```typescript
remoteVisibility: {},
onvisibilitychange: vi.fn(),
```

Add new tests:
- `e` key on group header fires `onvisibilitychange`
- `e` key on remote bookmark toggles hidden list
- Enter on group header toggles expand/collapse
- `d`/`f` are no-ops on group header (no crash)
- Dual-membership: bookmark with local+remote appears in both groups

- [ ] **Step 11: Build and test**

```bash
cd frontend && pnpm run build && pnpm test
```

- [ ] **Step 12: Commit**

```bash
jj describe -m 'feat: BookmarksPanel grouped-by-remote view with visibility toggles'
jj new
```

### Task 6: Auto-expand groups on remote discovery

**Files:**
- Modify: `frontend/src/lib/BookmarksPanel.svelte`

- [ ] **Step 1: Add effect with untrack to avoid self-loop**

```typescript
$effect(() => {
  void allRemotes  // tracked dep
  const current = untrack(() => expandedGroups)  // untrack avoids self-loop
  const next = new Set(current)
  let changed = false
  for (const r of allRemotes) {
    if (!next.has(r)) { next.add(r); changed = true }
  }
  if (changed) expandedGroups = next
})
```

- [ ] **Step 2: Commit**

```bash
jj describe -m 'fix: auto-expand remote groups in BookmarksPanel'
jj new
```

### Task 7: Final cleanup

- [ ] **Step 1: Search and remove all remaining `'tracked'` references**

In App.svelte and RevisionGraph.svelte/test — any leftover `'tracked'` in viewMode types, palette commands, or callbacks.

- [ ] **Step 2: Run full test suite**

```bash
go test ./... && go vet ./...
cd frontend && pnpm run build && pnpm test
```

- [ ] **Step 3: Commit**

```bash
jj describe -m 'chore: remove tracked view remnants, final cleanup'
```
