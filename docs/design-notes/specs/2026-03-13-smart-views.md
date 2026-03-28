# Plan: Smart Views (revised)

> **STATUS**: Shipped. `STATIC_PRESETS` + `prsRevset` + `viewLabel` + `.preset-chip` all live in `App.svelte`; `RevisionGraph` takes `viewLabel: string | null`.

## What changed from v1

Three reviewers converged on the same conclusion: the original plan conflated two unrelated things under "views" — (a) revset-apply buttons and (b) the bookmarks list surface. `BACKLOG:7` says "bookmarks becomes one of the views" — that's a MEANS dressed up as an END. The END is "one-click revset access".

Once decoupled, `ViewsPanel`'s entire reason to exist (tab-strip hosting BookmarksPanel as one-of-N) disappears. What's left — preset chips — fits in the existing filter bar using the existing `applyRevsetExample()` plumbing. The comment at `App.svelte:2130` already names "smart views" as exactly this use case.

**Dropped from v1:** `ViewsPanel.svelte` (~150 LOC), `PresetDetail`, `smart-views.ts`, `stale` preset, `when()` gates, `revset` thunks, `onapply` callback.
**Net:** ~35 LOC inline vs ~240 LOC across 3 files + tests.

## What it is

Inline preset chips in the revset filter bar. Click → `revsetFilter` set + `handleRevsetSubmit()`. The chip whose revset currently equals `revsetFilter` shows active.

`BookmarksPanel` stays on key `2`, untouched. It is a list-interaction surface (914 LOC: d/f/t confirm-gate, sync-state sort, per-remote visibility, PR badges) with a different interaction model — not a revset-apply button.

## Preset catalogue

| Label | Revset | Shape |
|---|---|---|
| My work | `mine() & mutable()` | static literal |
| WIP | `trunk()..@` | static literal |
| Conflicts | `conflicts()` | static literal |
| Divergent | `(divergent() & mutable())::` | static literal (same revset `DivergencePanel` fetches) |
| PRs | `ancestors("bm1" \| "bm2" \| ..., 3) \| @` | `$derived` over `pullRequests` |

### Dropped from v1

- **`stale` preset** — `mine() & ::trunk()~` is a **syntax error**. `~` in jj revsets is prefix-complement or infix-difference, never postfix (the parents operator is `x-`). Even corrected to `::trunk()-`, everything in trunk ancestry is immutable under default `immutable_heads()` so `jj abandon` refuses. The user's actual goal (delete merged bookmarks) is already surfaced in `BookmarksPanel` via `bookmark-sync.ts` sync-state dots.
- **`when()` gates for conflicts/divergent** — `revisions.some(r => r.commit.conflicted)` reads `App.svelte:184` `revisions = $derived(log.value)`, which is only what's currently **loaded in the graph**. If conflicts exist outside the active revset (side branch, stale rebase), the gate → `false` → chip hidden precisely when the user needs discovery. Worse: switching to any other preset re-scopes `revisions` to that preset's result; if those commits are clean, the Conflicts chip vanishes from under the user. The gate uses the VIEW to decide whether to offer a VIEW — circularly self-defeating. **Always-show is simpler AND more correct**: clicking Conflicts on a clean repo → empty graph → self-explanatory.
- **`when()` gate for prs** — replaced by `{#if pullRequests.length}` around the chip. Same effect, no gate abstraction.
- **`revset: () => string` thunks** — `buildSmartViews(ctx)` already captures deps at the call boundary; a second layer of closures that close over what the builder already has in scope is redundant indirection. 4 of 5 presets are string literals. With thunks gone, the only remaining logic is `pullRequests.map(p => revsetQuote(p.bookmark)).join(' | ')` — one line, `revsetQuote` already tested at `remote-visibility.ts`. A separate `smart-views.ts` module is not justified.

## Implementation

### `App.svelte` script block — preset state (~12 LOC, near :152 `viewMode`)

```ts
// Static presets are string literals — module-level, zero reactivity.
const STATIC_PRESETS = [
  { key: 'mine',      label: 'My work',   revset: 'mine() & mutable()' },
  { key: 'wip',       label: 'WIP',       revset: 'trunk()..@' },
  { key: 'conflicts', label: 'Conflicts', revset: 'conflicts()' },
  { key: 'divergent', label: 'Divergent', revset: '(divergent() & mutable())::' },
] as const

// PRs preset: computed from live pullRequests. Empty list → '' (chip hidden
// by {#if pullRequests.length}, so this never hits jj). revsetQuote from
// remote-visibility.ts — bookmark names can contain revset operators.
const prsRevset = $derived(
  pullRequests.length === 0
    ? ''
    : `ancestors(${pullRequests.map(p => revsetQuote(p.bookmark)).join(' | ')}, 3) | @`
)
```

Import `revsetQuote` from `./lib/remote-visibility` (already exported at `remote-visibility.ts:12`).

### `viewMode` — replace with `viewLabel` (`App.svelte:152-154`)

The current `viewMode: 'log' | 'custom'` has a single consumer at `RevisionGraph.svelte:295`, which checks `=== 'custom'` to render a badge. Widening the enum to include preset keys would require widening `RevisionGraph.svelte:24`'s prop type to something RevisionGraph doesn't care about.

Instead, derive the **label string** directly. `null` → no badge (default log); non-null → show it.

```ts
// Label shown in RevisionGraph's header badge. null = default log view.
// Pure string-match on revsetFilter — a preset's identity IS its revset string.
// No separate "appliedPresetKey" state: that would need clearing at every
// revsetFilter write site (oninput :2138, clearRevsetFilter :1640, visibility
// effect :167, jumpToBookmark :820, tab-restore) and each is a desync bug site.
// String-equality means editing the applied revset → 'Custom' — correct: the
// user is now customizing.
const viewLabel = $derived.by(() => {
  if (revsetFilter === '' || revsetFilter === visibilityRevset) return null
  for (const p of STATIC_PRESETS) if (revsetFilter === p.revset) return p.label
  if (prsRevset !== '' && revsetFilter === prsRevset) return 'PRs'
  return 'Custom'
})
```

**No `when()` check in this loop.** viewMode/viewLabel is a PURE string-match — a preset's identity is its revset string, not whether its data-dependent gate is currently true. v1 had `if (p.when && !p.when()) continue`, which conflated (a) should the chip render with (b) does `revsetFilter` match. Scenario: user applies Conflicts → resolves them via MergePanel → log reloads → `revisions.some(r => r.conflicted)` → `false` → loop skips → badge says "Custom" over an empty graph, no signal that they just won. String-match alone gives the correct "Conflicts" label over the empty graph.

**Reactive footprint:** `STATIC_PRESETS` is a module const (zero deps). The loop adds no tracking. `prsRevset` tracks `pullRequests` — that's one additional dep vs the current `viewMode`, but `pullRequests` changes only on `loadPullRequests()` (mount + git push/fetch), not on every log reload. Strictly narrower than v1's design, which would have tracked `revisions` transitively through `hasConflicts`/`hasDivergent`.

**Drift caveat (preserved from v1, wording corrected):** if `pullRequests` changes while the PRs preset is active (push/fetch closes a PR), `prsRevset` recomputes → string mismatch vs the stale `revsetFilter` → label drops to "Custom". v1 said "graph content stays correct" — that's wrong wording. `revsetFilter` was snapshot-assigned at click time, so the graph still shows `ancestors("now-merged-branch" | ..., 3) | @`. The "Custom" label is actually the only honesty signal here: what's on screen no longer matches the "Open PRs" definition. Don't auto-reapply — surprise graph reload mid-navigation is worse. Acceptable frequency (requires push/fetch + concurrent PR state change).

### `RevisionGraph.svelte` — narrow prop to `viewLabel: string | null`

- `RevisionGraph.svelte:24` — replace `viewMode: 'log' | 'custom'` with `viewLabel: string | null`
- `RevisionGraph.svelte:295-297` — replace check + hardcoded text:
  ```svelte
  {#if viewLabel}
    <span class="view-btn view-btn-active">{viewLabel}</span>
  {/if}
  ```
- `App.svelte:2178` — pass `{viewLabel}` instead of `{viewMode}`

RevisionGraph never needs to know preset keys — it just renders a label. v1 would have required widening the enum to `'log' | 'custom' | PresetKey`, which TypeScript flags at the prop boundary, and which would have made the `=== 'custom'` check accidentally-correct-but-fragile (preset values silently fall through to the else).

### `App.svelte` template — preset chips in filter bar (`:2133-2170`)

Insert a second row inside `.revset-filter-bar`, between the input row and the `(?)` popover. The existing `applyRevsetExample()` at `:1649` is exactly right — it sets `revsetHelpOpen = false` (harmless no-op when already false) then `revsetFilter = r; handleRevsetSubmit()`. No new handler.

```svelte
<div class="preset-chips">
  {#each STATIC_PRESETS as p (p.key)}
    <button
      class="preset-chip"
      class:active={revsetFilter === p.revset}
      onclick={() => applyRevsetExample(p.revset)}
      title={p.revset}
    >{p.label}</button>
  {/each}
  {#if pullRequests.length > 0}
    <button
      class="preset-chip"
      class:active={revsetFilter === prsRevset}
      onclick={() => applyRevsetExample(prsRevset)}
      title={prsRevset}
    >PRs <span class="chip-count">{pullRequests.length}</span></button>
  {/if}
</div>
```

The `title` attr shows the revset on hover — covers v1's `PresetDetail` "revset code display" use case. The revset also appears verbatim in the input at `:2137` after click (the bar IS the revset display). The `(?)` popover at `:2157` already covers syntax explanation.

`class:active` is per-chip inline string-equality — no loop, no derived intermediate. Fire-and-forget chips don't need centralized active-state tracking.

### CSS (~8 LOC in `App.svelte` `<style>`)

```css
.preset-chips { display: flex; gap: 4px; flex-wrap: wrap; padding: 2px 6px; }
.preset-chip { font-size: 11px; padding: 2px 8px; border-radius: 3px;
               background: var(--bg-muted); border: 1px solid transparent; cursor: pointer; }
.preset-chip:hover { background: var(--bg-hover); }
.preset-chip.active { border-color: var(--accent); color: var(--accent); }
.chip-count { opacity: 0.6; margin-left: 2px; }
```

`flex-wrap` handles overflow if the bar is narrow (`config.revisionPanelWidth` is user-resizable).

### CommandPalette entries (optional, ~6 LOC in `staticCommands`)

Free addition — zero new UI, aids discovery for keyboard users. Static presets go in `staticCommands` (zero-dep `$derived.by`, per CLAUDE.md); PRs goes in `dynamicCommands` (needs reactive label).

```ts
// in staticCommands:
...STATIC_PRESETS.map(p => ({
  id: `view-${p.key}`,
  label: `View: ${p.label}`,
  hint: p.revset,
  action: () => applyRevsetExample(p.revset),
})),

// in dynamicCommands (only when pullRequests.length > 0):
{ id: 'view-prs', label: `View: Open PRs (${pullRequests.length})`,
  action: () => applyRevsetExample(prsRevset) },
```

## revsetFilter write-path audit

Three code paths write `revsetFilter` independently of the user typing. All correctly kick out of presets:

| Path | Writes | Preset interaction |
|---|---|---|
| `oninput` at `:2138` | whatever the user types | editing the applied revset → chip `active` goes false → `viewLabel` → "Custom". Correct: user is customizing. |
| visibility `$effect` at `:167-177` | `buildVisibilityRevset()` output | guard at `:171` is `revsetFilter === '' \|\| revsetFilter === prevVisibilityRevset`. `prevVisibilityRevset` holds what THIS effect last wrote — either `''` or `ancestors(remote_bookmarks(...), 2)` per `remote-visibility.ts:42`. No preset collides: PRs is `ancestors(..., 3) \| @` (different depth + `\| @` suffix); static presets are entirely different shapes. Guard correctly rejects → preset survives visibility toggle. `visibilityRevset` depends on `bookmarksPanel.value` (reloaded at `:640`/`:1886`/`:1892`) but `$derived` memoizes by string equality so same-data reload doesn't fire the effect. |
| `jumpToBookmark` at `:820` | `ancestors(${target}, 20) \| @` | pre-existing, explicit navigation action. Kicks out of preset. Correct — user asked to jump. |
| `clearRevsetFilter` at `:1640` | `''` | Escape in input / ✕ button. Kicks out of preset → `viewLabel` → `null`. Correct. |
| tab-restore (`initialState.revsetFilter`) | saved string | string-match derives the right chip/label automatically. No separate state to restore — this is the payoff of keeping `viewLabel` as a pure discretization. |

## What this does NOT do

- **Touch `BookmarksPanel`** — stays on key `2`, renders in the right column, 914 LOC untouched.
- **Touch `activeView`** — stays `'log' | 'branches'`.
- **Touch visibility `$effect`** (`App.svelte:167-177`) — orthogonal, audit above confirms no collision.
- **Persist which preset was last clicked** — it's derived from `revsetFilter`, which IS persisted via `initialState` tab-restore. Nothing to add.
- **User-defined presets** — YAGNI. Natural follow-up via `config.json` if asked.
- **Repo-wide `hasConflicts` check** — if always-visible Conflicts/Divergent chips prove too cluttering, the fix is dimming via a dedicated backend check (`jj log -r 'conflicts()' -n1 --no-graph` → non-empty), NOT `revisions.some()`. Not this change.

## Test surface

No new `.test.ts` file. The only logic with test value is the PRs revset synthesis — `revsetQuote` is already tested at `remote-visibility.test.ts`, and `.map().join()` over a typed array doesn't need a unit test.

Manual verification:
- Click each static chip → graph reloads, chip shows `active`, badge in RevisionGraph header shows label, input shows revset verbatim.
- Edit the applied revset → chip `active` drops, badge → "Custom".
- Escape / ✕ → back to default, no badge.
- PRs chip absent when `pullRequests.length === 0`, present with count badge otherwise.
- Toggle remote visibility while a preset is active → preset survives (guard rejects).
- Apply preset in tab A, switch to tab B, switch back → chip still active (via `initialState.revsetFilter` restore).

## Risk

Very low. `revsetFilter = r; handleRevsetSubmit()` is the same mechanism as the `(?)` popover's clickable examples (`App.svelte:2160`), already in production. No new components, no new callback props, no new reactive state beyond one `$derived` string. RevisionGraph's prop change is a narrowing (enum → nullable string), callers can't accidentally pass preset-keys-as-strings because `viewLabel` is the only source.
