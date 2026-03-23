# Merge Mode & File History — Design Plan

**Status:** Proposed
**Inspired by:** Kaleidoscope (file history + commit context + intuitive merge UI)

## Problem Statement

The current 3-pane `MergePanel` is functionally solid — position surgery, undo inversion, LCS block alignment all work. But it's **per-file, buried inside DiffPanel**, invoked one file at a time with no awareness of the broader conflict set. Kaleidoscope's model treats merge as a first-class mode with three things we lack:

1. **Global conflict queue** — "10 Unresolved Conflicts" across all files, with prev/next navigation
2. **File history** — browse every revision that touched a file, diff any two
3. **Commit context in-pane** — author/message/date/commit-id on each merge column, so you know *who* wrote what you're about to discard

The current flow forces: open DiffPanel → spot a conflict badge → click "Resolve" → MergePanel for ONE file → save → back to DiffPanel → find the next one. For a rebase that conflicts 5 files across 3 commits, that's 15 modal round-trips.

## What we already have (don't rebuild)

| Piece | Location | Reusable as-is? |
|---|---|---|
| 3-pane CM6 editor + arrows | `MergePanel.svelte` | ✅ Core stays; props interface widens |
| Position surgery | `merge-surgery.ts` (pure, tested) | ✅ No changes |
| LCS block diff | `merge-diff.ts` | ✅ No changes |
| Conflict marker parser | `conflict-extract.ts` | ⚠️ Extend to capture commit refs, not just description labels |
| File-at-revision | `api.fileShow(rev, path)` | ✅ |
| Cross-revision diff | `api.diffRange(from, to, files?)` | ✅ Powers file history compare |
| Conflict file list | `FilesTemplate` → `conflict_sides` | ✅ Already per-commit via `/api/files` |
| jj file-scoped log | `jj log <path>` (not yet wrapped) | Needs `commands.go` builder |

## Phase 1 — MergePanel quick wins

**Goal:** Make the existing per-file editor feel like a polished tool before widening scope. Each item is self-contained.

### 1.1 Conflict navigation within a file ✅

Kaleidoscope's bottom-right "Conflict 1 of 10 ⬆ ⬇".

- **Data:** Already in `blocks[]` — each `ChangeBlock` is one conflict. `pendingCount` already derived.
- **UI:** "N of M" nav pill in toolbar with ‹/› buttons. `]`/`[` keyboard (vim-diff style). Amber outline ring on current block's arrows.
- **Impl:** `scrollToBlock(i)` → `centerView.dispatch({ effects: EditorView.scrollIntoView(tracked[i].from, { y: 'center' }) })`. `currentBlockIdx` is **explicit state**, not scrollTop-derived — predictable when multiple blocks fit on screen. Updated by `[`/`]`, nav buttons, and arrow clicks (nav continuity). Keys gated on `!centerEl.contains(target)` — `[`/`]` are valid source chars, can't hijack typing.

### 1.2 Minimap gutter ✅

Kaleidoscope's right-edge color strip showing where conflicts sit in the file.

- **Impl:** 12px right-edge strip. Chips at `top = (blk.bFrom - 1) / totalLines * 100%`, `height = max(3px, (bTo - bFrom) / totalLines * 100%)`. Positions from **immutable theirs-lines** — "where are conflicts" doesn't change during resolution, only color does. Color from `oursArrows[i].source` (already reactive). Click → `scrollToBlock(i)`. Current chip gets amber outline + `opacity: 1`.
- **~50 lines, zero new tracking.**

### 1.3 Rich commit metadata in column headers ✅ (partial — refs only)

Current headers show only `sides.oursLabel` (the quoted commit description from conflict markers). Kaleidoscope shows author + commit-id + date + message.

- **Problem:** `reconstructSides()` extracted `extractSideLabel()` → just the quoted description. The full marker line looks like `wlykovwr 562576c8 "commit message"` — the change-id and commit-id were RIGHT THERE, we were throwing them away.
- **Shipped:** `MergeSides` gains optional `oursRef?: {changeId, commitId}` / `theirsRef?`. `parseRef()` regex `/(?:diff (?:from|to):\s*)?([k-z]{8,})\s+([0-9a-f]{8,})\s+"(.+)"/` — the `[k-z]` alphabet is jj's change-id disambiguation from hex commit-id. `setLabel()` helper consolidates the 3 label-setting sites. Headers render `<code>changeId</code> · label` when ref present.
- **Deferred:** `api.revision(commitId)` enrichment for author/date. The refs-only version is 80% of the value at 20% of the complexity.
- **Fallback:** Generic "side #N" markers → no ref → header shows label only (unchanged).

### 1.4 "Take all ours" / "Take all theirs" bulk actions ✅

- Toolbar buttons: `→→ All ours` / `All theirs ←←` (green/blue tinted to match flank colors).
- `takeAll(side)` loops `takeBlock(i, side)`. Synchronous dispatches land within CM6's `newGroupDelay` (500ms) → typically one Cmd+Z undoes the batch. Empty-source blocks included — "take ours" when ours has nothing = delete center content (planTake's srcEmpty branch), semantically correct.
- **Invariant test:** `takeAll(side) → save() emits sides[side]`. Round-trips through every block's planTake separator-math.

### 1.5 Keyboard-first block navigation — DEFERRED

`]`/`[` (from 1.1) already work when focus is outside the center pane — clicking a flank or toolbar = nav keys active; clicking center = editing active. That's a natural nav/edit split without explicit modal state. Adding `h`/`l`/`Space` + an `i`/`Esc` toggle is over-engineering until a user asks for it. YAGNI.

## Phase 2 — Merge Mode (`activeView='merge'`)

**Goal:** Promote conflict resolution to a top-level view alongside `log` / `branches`. Toolbar nav tab `⧉ Merge [5]` (badge = conflict count across the selected revision, or across `conflicts()` revset if nothing selected).

### Layout

```
┌─────────────────────────────────────────────────────────────┐
│  ◉ Revisions  ⑂ Branches  ⧉ Merge [3]                       │  toolbar
├──────────────┬──────────────────────────────────────────────┤
│ Conflict     │                                              │
│ queue        │         MergePanel (current file)            │
│ (left rail)  │                                              │
│              │                                              │
│ ○ foo.go     │  ← ours  │  result  │  theirs →             │
│ ● bar.ts  ◄──┤                                              │
│ ○ baz.md     │                                              │
│              │                                              │
│ [3/5 done]   │  Conflict 2 of 4          [n] [p]  minimap  │
└──────────────┴──────────────────────────────────────────────┘
```

### 2.1 Conflict queue (left rail) ✅

`ConflictQueue.svelte` + backend `GET /api/conflicts`.

- **Backend:** `ConflictList(revset)` (commands.go:536) builds a `jj log -T` template emitting `commit_id\x1Echange_id\x1Edesc\x1Econflicted_files.map(path\x1Fsides)\x1D`. `ParseConflictList` returns `[]*ConflictEntry` (never nil → JSON `[]`). Handler at `/api/conflicts?revset=X` defaults to `conflicts()`.
- **Frontend:** `api.conflicts(revset?)` + `ConflictQueue.svelte`. Flattens commit-grouped entries into a navigable list, renders ○/● resolved dots from a `Set<commitId:path>`, exports `handleKeydown` for App delegation (BookmarksPanel pattern). j/k clamp at bounds (no wrap — unlike in-file `[`/`]` which wraps). N-way badge (red) when `sides > 2`.
- **Auto-select on mount** so MergePanel immediately has content.

### 2.2 Merge mode entry points ✅

- **Toolbar tab** `⧉ Merge [5]` — always visible (simpler than conditional; empty queue shows "No conflicts").
- Keyboard: `5` key → `switchToMergeView()`.
- **Deferred:** DiffPanel "Resolve all" button + RevisionGraph badge click — both are additive entry points, add on demand.

### 2.3 Keeping App.svelte sane ✅

`activeView='merge'` follows `branches` pattern: full-right-column takeover. State block (`conflictQueue`, `mergeCurrent`, `mergeResolved`, `mergeSides`, `mergeBusy`) separate from `selectedIndex`/diff loader. `switchToMergeView()` async-loads `api.conflicts()`; queue `onselect` → `loadMergeFile()` → `reconstructSides()` → `{#key commitId:path}` remounts MergePanel.

**Save path (v1, @-only):** `saveMergeResult()` guards `mergeCurrent.commitId === workingCopyEntry.commit_id`; non-`@` shows a "use `jj edit` first" warning. The `jj resolve --tool` path for arbitrary revisions is the next increment.

**Keyboard:** `activeView === 'merge'` delegates j/k to `conflictQueueRef.handleKeydown()` (same gate level as branches→bookmarksPanel). MergePanel's own `swallowKeydown` still handles `[`/`]`/Escape within the panel — no refactor needed since the queue sits OUTSIDE `.merge-panel`.

**Layout:** RevisionGraph hidden entirely in merge view (`{#if activeView !== 'merge'}` around `.revision-panel-wrapper`) — ConflictQueue + 3-pane MergePanel need the full width. The earlier `!== 'log'` onselect gate is now moot (graph isn't rendered).

**TabState intentionally excludes `'merge'`** — `getState()` coerces to `'log'`. Half-done conflict resolution across tabs is the same footgun as half-done rebase.

### Bughunter round 4 (full Phase 2 diff) — 6 confirmed, all fixed

- **bug_040** (most subtle): `@`-guard compared `commit_id`, but `fileWrite` snapshots `@` → new commit_id → second save of the session fails. Fix: compare `change_id` (stable across snapshots).
- **bug_047**: `loadMergeFile` didn't clear `mergeSides` before await → MergePanel remounted (new `{#key}`) with stale file A's sides during `fileShow(B)` round-trip. Fix: `mergeSides = null` at entry.
- **bug_048/051**: `saveMergeResult` bypassed `withMutation()` (every other mutation uses it) and didn't participate in `mergeGen` (nav during save raced `mergeBusy`). Fix: wrap in `withMutation`, bump `mergeGen`.
- **bug_049**: Unsupported-format (N-way, git-style) showed "Loading conflict…" forever after `reconstructSides()` returned null. Fix: three-way template branch (`mergeBusy` vs not).
- **bug_039**: Re-entering merge view showed stale `mergeSides` from the prior session. Fix: reset `mergeCurrent`/`mergeSides` (NOT `mergeResolved` — resolved-dots persist intentionally) in `switchToMergeView`.
- **bug_014**: StatusBar had no key hints for merge. Fix: added `j/k file · [/] block · ⌘S save · Esc exit`.

## Phase 3 — File History Mode

Kaleidoscope's headline feature: "browse and compare all revisions of a file."

### 3.1 Entry point ✅

- Right-click any diff line in DiffPanel → "View history" context-menu item (`onfilehistory` callback prop)
- `api.fileHistory(path)` → `GET /api/file-history?path=X`
- Backend: `FileLog(path, limit)` is a **thin wrapper** — `LogGraph("files("+EscapeFileName(path)+")", limit)`. Zero new template/parser logic; `root-file:` escaping stays server-side (single source of truth for paths with `"` / `\`).

### 3.2 Layout

```
┌──────────────────────────────────────────────────────────────┐
│  File: src/lib/api.ts                         [✕ close]      │
├──────────────┬───────────────────────────────────────────────┤
│ Revisions    │  ┌─A──────────┐       ┌─B──────────┐         │
│ touching     │  │ rev A      │       │ rev B      │         │
│ this file    │  │ @ abc123   │  ⇄    │ @ def456   │         │
│              │  │ (pinned)   │       │ (cursor)   │         │
│ ◆ abc123 2d  │  └────────────┘       └────────────┘         │
│ ○ def456 5d  │                                               │
│ ○ fed321 2w  │       unified diff: A → B                     │
│ ○ 987cba 1mo │       (or split view — reuse DiffFileView)    │
│              │                                               │
└──────────────┴───────────────────────────────────────────────┘
```

### 3.3 Two-cursor compare

- **A-cursor (pinned):** Space to pin a revision. Sticky until re-pinned.
- **B-cursor (live):** j/k navigation. Diff auto-updates as you move.
- Default: A = newest revision, B = cursor. Moving j/k walks backward through history showing "what changed in this commit".
- **Diff source:** `api.diffRange(commitA, commitB, [path])` — already exists, already cached by `diffRange` LRU.

### 3.2-3.4 FileHistoryPanel ✅

- **Component:** `FileHistoryPanel.svelte` — custom left rail (RevisionGraph was too heavy; inline 18px rows with change_id + description + timestamp). Right = A/B header cards + `DiffFileView` fed from `api.diffRange(A, B, [path])` via `createLoader`.
- **Two-cursor compare:** `cursorB` moves with j/k, `pinnedA` set by Space. Both default to 0 → empty-state prompt on mount. `{#key fileHistoryPath}` remount gives fresh cursors free on path change.
- **Layout:** Full-screen overlay (`position: fixed; inset: 0`). Added to `anyModalOpen` so log j/k doesn't fire beneath. Keyboard delegated BEFORE the modal gate so overlay's j/k/Space/Escape work.
- **Duplicated `relativeTime` helper** from RevisionGraph (15 LOC) — DRY candidate if a third copy appears.

### 3.5 "Open this revision in merge" bridge

If the file-history revision is conflicted (jj tracks this), a "Resolve conflict here" button jumps to merge mode with that file pre-selected. Closes the loop between the two new modes.

## Phase 4 — Polish (Kaleidoscope parity)

### 4.1 Connecting ribbons between panes

The curvy SVG lines Kaleidoscope draws between matching blocks in A / center / B.

- **Impl:** Absolute-positioned `<svg>` overlay spanning all three panes. For each block, draw a bezier from `(oursPane.right, oursBlock.y)` → `(centerPane.left, centerBlock.y)` and mirror for theirs. Y positions already tracked in `oursArrows` / `theirsArrows` — they're the same data.
- **Complexity:** Scroll sync means Y coords shift together, so ribbons translate with `scrollTop`. The tricky bit is the X coords when a flank is hidden (`hiddenFlank`). Gate the SVG layer on `hiddenFlank === null`.
- **Value:** High visual payoff, ~100 lines of SVG path math. `GraphSvg.svelte` has the bezier patterns already.

### 4.2 Base-diff inline popup

Kaleidoscope's "BASE vs B" floating panel — shows what the base looked like vs what the side changed.

- **Data:** `sides.base` is already parsed by `reconstructSides()`. Currently unused.
- **UI:** Hover a block arrow for >500ms (or click a `ⓘ` icon) → floating popup with a mini 2-col diff of `base` vs `side` for JUST that block's line range. Reuses `diffBlocks()` + the highlight classes.
- **Value:** Medium. Helps answer "why did this side change this?" — particularly for rebase conflicts where "theirs" is your own stale commit.

### 4.3 Per-block "both" action ✅

For additive conflicts (dueling imports, new list entries) where you want both changes kept.

- **Impl:** `planTakeBoth()` in merge-surgery.ts — simpler than `planTake` since "both" only applies when both sides have content (the empty-source/zero-width edge cases that complicate `planTake` degenerate to regular take, so return null). Replaces tracked range with `ours + '\n' + theirs`. `BlockSource` gains `'both'` variant.
- **UI:** `b` key at current block (same focus gate as `[`/`]` — outside center editor only). Green→blue gradient highlight + minimap chip. No gutter arrow (YAGNI — keyboard suffices for v1).
- **Invariant test:** `takeBoth → save() === A\n${ours}\n${theirs}\nC` round-trips through the position math.

### 4.4 Auto-resolve trivial conflicts

`jj resolve --tool :ours` / `:theirs` already exists. For blocks where one side == base (no-op change), offer "Auto-resolve trivial" button that runs `takeBlock(i, nonTrivialSide)` for all such blocks.

- **Detection:** Compare each block's `ours` slice vs `base` slice (extracted from `sides.base`). If identical → theirs is the real change → auto-take theirs. And vice versa.

## Implementation order & sizing

| Phase | Item | Size | Depends on |
|---|---|---|---|
| 1.1 | In-file conflict nav | S | — |
| 1.2 | Minimap | S | — |
| 1.3 | Rich headers | M | conflict-extract refactor |
| 1.4 | Take-all | S | — |
| 1.5 | Keyboard nav | M | 1.1 |
| 2.1 | Conflict queue | M | new `/api/conflicts` |
| 2.2 | Merge mode entry | S | 2.1 |
| 2.3 | App integration | M | 2.1, keyboard rework |
| 3.1 | File history API | S | `FileLog` builder |
| 3.2-3.4 | FileHistoryPanel | L | 3.1, RevisionList extraction |
| 3.5 | Merge↔History bridge | S | 2.x + 3.x |
| 4.1 | Ribbons | M | — |
| 4.2 | Base popup | M | — |
| 4.3 | Take-both | M | merge-surgery extension |
| 4.4 | Auto-resolve trivial | S | base-relative LCS |

**Suggested batching:**
- **v1.4.0:** Phase 1 complete (MergePanel polish). Low-risk, touches one component.
- **v1.5.0:** Phase 2 (merge mode). New `activeView`, backend endpoint, one new component.
- **v1.6.0:** Phase 3 (file history). Standalone feature, minimal coupling.
- **v1.7.0:** Phase 4 cherry-picked by demand.

## Open questions

1. **Merge mode scope:** Conflicts at `@` only, or across the whole `conflicts()` revset? The latter is more powerful (resolve a whole rebase stack in one session) but needs per-commit grouping in the queue. Lean toward revset-scoped with commit headers in the queue — matches jj's mental model where conflicts propagate through descendants.

2. **Saving semantics in merge mode:** Current `saveMerge` writes to WC via `api.fileWrite` — `@`-only. But `jj resolve -r <rev> --tool <name>` works for ANY revision. The pattern is **already proven** in this codebase: `writeHunkToolConfig` (handlers.go:1077) registers lightjj as an ephemeral merge tool via `--config-file`, jj invokes it with `$left`/`$right`/`$output` paths, handler writes the result. For merge mode:
   - Frontend POSTs `{revision, path, content}` to `/api/resolve-write`
   - Backend writes `content` to a temp file, emits a `merge-tools.lightjj-resolve` config with `merge-args = ["--write-resolved", tmpPath, "$output"]`, runs `jj resolve -r <rev> --tool lightjj-resolve <path>`
   - lightjj's `--write-resolved` mode (new CLI flag) just copies tmp → `$output`
   - Works for any revision, leverages jj's own conflict-resolution bookkeeping (marks file resolved, updates descendants)

   This also gives us `$base` for free — the tool config can capture it to a second temp file, letting us drop `reconstructSides()`'s marker-parsing entirely in favor of jj handing us the three sides directly. **Significant simplification** — no more {7,} regex edge cases.

3. **File history for renamed files:** `jj log <path>` follows renames? Need to verify. Git's `--follow` equivalent. If not, file history truncates at rename — acceptable v1, note in UI.

4. **N-way conflicts (sides > 2):** `reconstructSides()` returns `null` today → falls back to raw FileEditor. Kaleidoscope doesn't handle these either. Keep the fallback; show "N-way conflict, edit raw" in the queue with a distinct icon.

## Testing strategy

- **merge-surgery.ts:** Already has round-trip invariant tests. `planTakeBoth` (4.3) adds one more shape.
- **conflict-extract.ts:** Add fixtures with commit-ref markers for the `MergeSideMeta` regex (1.3).
- **ConflictQueue.svelte:** Mock `/api/conflicts` response, test j/k nav + auto-advance-on-save.
- **FileHistoryPanel:** Mock `diffRange` responses, test A/B cursor pinning + diff update on j/k.
- **Integration:** `handlers_test.go` for `/api/conflicts` + `/api/file-history` with MockRunner.
