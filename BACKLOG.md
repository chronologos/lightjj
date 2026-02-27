# lightjj Backlog

## Agent Workflow (2026-02-27)

Features to support human-in-the-loop review of agent work across jj worktrees.

- [x] **Copy reference from diff lines** (Small) — Right-click selected diff lines → "Copy reference" with `path:line-range @ changeId` + line content. Detects native text selection via `window.getSelection()` + `Range.intersectsNode()` to find all `.diff-line` elements in the selection. Falls back to single clicked line. `DiffFileView` exports `DiffLineInfo` interface (reusable for future annotations). `DiffPanel` formats the reference with the revision's change ID.
- [x] **Per-step evolog diffs** (Small) — `jj evolog` now emits structured template output (`CommitEvolutionEntry` type: commit_id, timestamp, operation description, predecessor IDs). EvologPanel shows a clickable entry list; clicking an entry fetches `api.diffRange(predecessor, current)` and renders via existing `DiffFileView`. Zero new state tracking — hidden evolution commits are fully addressable by `jj diff --from X --to Y`. `{#key selectedRevision?.commit.change_id}` in App.svelte resets panel state on revision change. Multi-predecessor entries show `(+N)` badge; origin entries dimmed.
- [ ] **Evolog: rebase-safe inter-diff** (Small) — `diffRange(pred, cur)` shows parent churn when the revision was rebased between snapshots. `CommitEvolutionEntry.inter_diff()` template method is rebase-safe (same as `jj evolog -p`). For now the "agent editing WC" case has stable parents so this is a non-issue; worth a follow-up if agents start rebasing.
- [ ] **Evolog: keyboard navigation** (Small) — ArrowUp/Down to step through entries. The sequential step-through-history workflow would benefit from j/k-style navigation.
- [ ] **Evolog: resizable panel height** (Small) — 360px viewport shows ~14 diff lines. Drag handle on border-top or CSS `resize: vertical`.
- [ ] **Auto-refresh via filesystem watch** (Medium) — `fsnotify` on `.jj/repo/op_heads/` + SSE push to frontend. Periodic `jj debug snapshot` (~5s) catches raw file edits. Frontend `EventSource` → existing `onStale()` callbacks. New `internal/api/watcher.go`. Adds `fsnotify` Go dependency. ~1 day.
- [ ] **Inline diff annotations** (Medium-Large) — Click diff line to add a comment, stored in localStorage keyed by `changeId + filePath + lineNumber`. Fuzzy re-matching via `lineContent` snapshot. Export as structured JSON for agent prompts. New `annotations.svelte.ts`. ~2-3 days.
- [ ] **File-level accept/reject mode** (Small) — Relabeled split mode for reviewing agent work. Check files to "accept", unchecked files "rejected" into a new revision. Reuses existing split infrastructure. ~2-4 hours.
- [ ] **Hunk-level accept/reject** (Large) — Per-hunk checkboxes in DiffFileView. Requires programmatic patch application (no jj CLI hunk selection). Mini patch-apply engine. ~3-5 days. Depends on file-level accept/reject.

## Architecture Review Round 2 (2026-02-26)

Four-agent deep analysis (Go backend, Svelte frontend, performance paths, API design). Items marked ✅ are fixed.

### Fixed
- [x] **No default log limit** — unbounded fetch on large repos. Now defaults to 500, caps at 1000.
- [x] **Workspace spawn race condition** — two concurrent requests could both spawn child processes. Fixed: lock held across check + spawn + write (extracted to `spawnLocked` with `defer Unlock()`).
- [x] **Dead `/api/status` endpoint** — route + handler + `jj.Status()` builder + tests removed.
- [x] **Evolog not debounced** — holding j/k with evolog open fired requests on every keypress. Now included in the 50ms debounce for all paths.
- [x] **`@const` recomputation** — `toSplitView`/`computeLineNumbers` in `DiffFileView` re-evaluated on every render (including every Shiki update). Moved to `$derived`.
- [x] **`api.ts` fails on non-JSON error bodies** — Go panic / proxy error returns plain text, `res.json()` threw, user saw JSON parse error instead of HTTP status. Now parsed defensively.
- [x] **Mode prop drilling** — RevisionGraph/StatusBar received 11 individual mode props. Now pass mode objects directly (RevisionGraph 31→23 props, StatusBar 12→8 props).
- [x] **Log limit clamp policy** — `>1000` was clamping to 500 instead of 1000.
- [x] **`highlightedLines` invalidates all DiffFileViews** — progressive Shiki updates replaced global Map → every file re-rendered. Now `highlightsByFile: Map<filePath, Map<key, html>>`; inner Maps for unchanged files keep their reference, so only newly-highlighted files re-render.
- [x] **`searchMatches` O(files × matches)** — every DiffFileView received full match array and filtered per-file. Pre-grouped by filePath in parent via `groupByWithIndex()`. O(matches) total.
- [x] **Sequential bookmark loop in divergence resolution** — `for await` → `Promise.all`.
- [x] **Cmd+F diff search** — search bar with match counter, Enter/Shift+Enter navigation, `<mark>` highlights, auto-expand collapsed files.

### Remaining — Performance
- [x] **`wordDiffMap` is sync `$derived`** — `computeWordDiffs` (LCS) runs synchronously for every hunk on diff load. Fixed: progressive async computation per-file with `setTimeout(0)` yields between files. Single-file expand only recomputes that file.
- [x] **`hoveredLane` fans out to every GraphSvg** — fixed: removed lane-level hover entirely. Lane 0 spans the entire graph, so highlighting it was visually jarring. Graph elements no longer have hover state — row-level `:hover` on `.graph-row` (background highlight) is sufficient.
- [x] **Opportunistic prefetch during nav debounce** — `selectRevision` fires `prefetchRevision()` for the next revision in the navigation direction, **but only when current is cached** (instant main load → no network contention). Unconditional prefetch during rapid uncached j/k stacked 3N requests, exhausting Chrome's 6-connection-per-origin limit. Fire-and-forget with swallowed errors.
- [x] **`statusText` re-scans revisions on every loading flip** — `revisions.find(r => r.commit.is_working_copy)` was running linearly on every `loading`/`mutating`/`diffLoading` state change (4-6 scans per mutation cycle × 500 revisions). Extracted to `workingCopyEntry = $derived(...)` — now only re-scans when `revisions` actually changes.
- [x] **`aliases`/`remotes` uncached** — session-stable data re-fetched on every GitModal/BookmarkModal open. Now lazily cached (promise-memoized) in api.ts; reset only on `clearAllCaches()`. Error path clears the memo so retries work.
- [x] **Remove `codemirror` meta-package** — never imported directly. `pnpm remove codemirror` done. Note: `@codemirror/autocomplete` is still a transitive dep of `@codemirror/lang-*` packages, so bundle savings are modest. Full elimination requires switching to bare Lezer grammars.
- [ ] **No virtualization for mega-files** — manual expand of 5000-line file renders all lines. Auto-collapse at 500 is the mitigation; `@tanstack/virtual` would be the full fix.
- [ ] **Batch endpoint `/api/revision?r=X`** — `diff`+`files`+`description` are three separate HTTP requests per cache miss. One endpoint returning `{diff, files, description}` would halve cache-miss latency locally and 3×→1× SSH round-trips. `isCached()` already treats the three as atomic — the wire protocol just doesn't reflect it.
- [ ] **Mutable→immutable cache promotion** — when op-id changes after a push/merge, commits that were mutable become immutable. Their cached data is identical but gets wiped with `responseCache.clear()`. Could buffer old entries and re-insert for newly-immutable commits after the log re-fetch.
- [ ] **`commands` $derived rebuilds on every j/k** — ~30 PaletteCommand objects allocated per keypress. Labels like `` `Abandon ${size} checked` `` depend on reactive state so the whole array re-creates. CommandPalette's `if (!open) return []` guard prevents downstream re-rendering, but the allocation still happens. Fix: split static vs dynamic commands, or move label interpolation into palette render.
- [ ] **Consolidate Shiki → CM6 for diff highlighting** — two syntax engines ship in the bundle (Shiki ~1,074 KB + CM6 ~1,254 KB source). CM6's `highlightCode()` API can produce static tokens without an editor, replacing Shiki for read-only diffs. Would eliminate ~180 KB gzip. Requires adding ~8 Lezer grammar packages and rewriting `highlighter.ts`. See ARCHITECTURE.md "Syntax Highlighting: Dual Engine".

### Remaining — Maintainability
- [x] **Extract `diffLoader.svelte.ts`** — Done as `createLoader()` factory in `loader.svelte.ts`. 6 copy-pasted load functions collapsed to 6 one-line declarations; 11 `$state` vars replaced with `$derived` aliases. 17 tests covering races, cancellation, cache-hit fast path (macrotask-deferred loading flag).
- [x] **`gh pr list` bypasses runner interface** — moved `execGhPRList` from package-level var to `Server.ExecGhPRList` field. Production default set in `NewServer()`, tests inject stubs directly on the server instance. Eliminates global mutable state.
- [x] **Backend fields unexposed in frontend** — wired `skipEmptied` and `ignoreImmutable` to rebase mode (`e`/`x` keys), `ignoreImmutable` to squash mode (`x` key). Added to `modes.svelte.ts` interfaces + factories, `api.ts` parameters, `App.svelte` execute functions, and `StatusBar.svelte` key indicators.

### Remaining — Reliability
- [ ] **Settings don't persist across sessions** — default `--addr localhost:0` picks a random ephemeral port on each launch → different origin → empty localStorage → tutorial reappears, theme reverts to `dark`. Didn't surface in dev (Vite serves on fixed 5173). Fix options: (a) fixed default port — simplest but collides when running multiple repos; (b) derive port deterministically from `resolvedRepoDir` hash — same repo → same origin, different repos get isolated prefs; (c) server-side config at `~/.config/lightjj/` via `/api/config` — port-agnostic, survives cache clears. Recommend (b).
- [x] **`handleBookmarkTrack/Untrack` don't validate `Remote`** — empty remote passes validation, jj errors instead of 400. Fixed: both now return 400 if `Remote` is empty.
- [x] **JSON encoding errors silently dropped** — `json.Encode()` return value discarded in `writeJSON`/`writeError`. Fixed: now logged via `log.Printf`.
- [x] **`LocalRunner` discards exit code** — `errors.New(stderr)` loses `ExitError` type. Fixed: error message now includes exit code, falls back to stdout when stderr empty.

## Architecture Review Findings (2026-02-23)

Deep review across 6 perspectives (maintainability, performance, reliability, correctness, testability, API design/security). Items marked ✅ are fixed.

### Critical
- [x] Bookmark template uses `;` delimiter — silent parsing corruption if bookmark names contain semicolons. Should use `\x1F` like everything else.

### Warnings
- [x] DNS rebinding — no Host header validation. Malicious webpage can DNS-rebind to `127.0.0.1` and call mutation endpoints.
- [x] No HTTP server timeouts — hung jj subprocess holds connections forever.
- [x] `handleFiles` spawns two sequential subprocesses (summary + stat) on the hottest read path.
- [x] `refreshOpId` fires synchronously before every mutation response, adding ~50-150ms.
- [x] Repeated mutation handler boilerplate — `refreshOpId` is manually called at 15 sites, easy to forget.
- [x] `handleNew` and `handleAbandon` accept empty revision lists (inconsistent with rebase/squash).
- [x] No frontend fetch timeouts — stuck spinners with no escape if backend hangs.
- [x] Response cache clears entirely on any op-id change; immutable commits' diffs should be preserved. Fixed: separate `immutableCache` Map keyed by bare `cacheId` (no opId) — survives op-id changes with no re-keying needed. Bounded at 300 entries with insertion-order eviction.
- [x] `wordDiffMap` recomputes all hunks when a single file is expanded. Fixed: per-file word diff computation, single-file expand only recomputes that file.
- [x] `MaxBytesReader` called with `nil` ResponseWriter — violates Go API contract.
- [x] `ParseGraphLog` returns nil instead of empty slice — produces JSON `null` not `[]`.
- [x] Modal fetch errors silently swallowed (GitModal, BookmarkModal).
- [ ] `"origin"` hardcoded as preferred remote — no way to configure.
- [x] MockRunner `RunWithInput` silently discards stdin — can't verify describe content.

### Suggestions
- [x] `App.svelte` is 1010 lines — rebase/squash/split state is ambient and threaded through multiple components. Extract to shared module.
- [x] Rename `squashMode` → `fileSelectionMode` in DiffPanel props — partially done; App.svelte still uses `squashMode` internally.
- [x] Rename `squashSelectedFiles`/`squashTotalFiles`/`toggleSquashFile` to `selectedFiles`/`totalFileCount`/`toggleFileSelection` in App.svelte — now shared by squash and split modes.
- [x] Rename CSS classes `rebase-badge`/`rebase-source`/`rebase-target` to `mode-badge`/`badge-source`/`badge-target` — shared across rebase, squash, split.
- [x] Squash mode StatusBar file count now says "N/M files to move" for parity with split's "N/M files stay".
- [x] Add bulk select/deselect toggle for file checkboxes (applies to squash + split modes).
- [ ] No list virtualization for large repos (500+ commits).
- [ ] No HTTP response compression (especially impacts SSH mode).
- [x] `highlightDiff` re-highlights all files when one is expanded. Fixed: `expandFile()` now only highlights the expanded file.
- [x] Diff parser uses `a/` (source) path from git headers — duplicate keys crash on copy/rename. Fixed to use `b/` (destination).
- [x] No word-diff skip for non-code files — SVGs/XML/JSON/lock files cause freeze. Added `shouldSkipWordDiff` with extension + line-count limits.
- [x] No auto-collapse for large diffs — files >500 lines now start collapsed.
- [x] `onStale` supports only a single callback — second caller silently replaces first.
- [x] SSH host not validated against flag injection (`-oProxyCommand=...`).
- [x] 11 command builder functions have no unit tests.
- [x] `handleBookmarkTrack`/`handleBookmarkUntrack` have zero test coverage.
- [x] No mutation handler runner-error tests.
- [x] Frontend `onStale`/`isCached` entirely untested.
- [x] Frontend HTTP error responses not tested.
- [x] No integration tests against a real jj repo.
- [ ] Frontend DOM integration tests (in progress).

### Nitpicks
- [x] `\x1F` vs `\x1f` case inconsistency across files.
- [x] Divergent commit `??` suffix is a string hack — a `Divergent bool` field would be cleaner.
- [x] `GET /api/oplog` has no upper bound on `limit` parameter.
- [x] No `Content-Type: application/json` validation on POST requests.
- [x] `commitsFromIds` wraps raw strings in fake `Commit` structs with zero-valued fields.

### Remaining Items by Effort

**Quick wins (< 30 min):**
- [x] `Content-Type: application/json` validation on POST requests — also serves as CSRF defense-in-depth
- [x] `commitsFromIds` → `jj.FromIDs(ids)` on SelectedRevisions

**Medium effort (1-2 hours):**
- [x] Immutable commit cache preservation — don't clear cached diffs for `◆` commits on op-id change
- [x] `wordDiffMap` per-file computation — moved to progressive async in DiffPanel with per-file `wordDiffsByFile` Map
- [x] `highlightDiff` partial re-highlight — `expandFile()` now only re-tokenizes the expanded file, merges into existing `highlightsByFile`
- [ ] `"origin"` hardcoded as preferred remote — make configurable via startup flag or jj config query
- [x] `OplogPanel` inline error display — `Loader` factory now exposes `.error`; OplogPanel shows inline error + Retry button instead of routing to global `showError`

**Larger refactors (half day+):**
- [x] `App.svelte` rebase state extraction — moved rebase/squash/split mode state to `modes.svelte.ts`, theme CSS to `theme.css`, added `runMutation` helper (App.svelte 1590→1269 lines)
- [ ] List virtualization for large repos — `@tanstack/virtual` for 500+ commit histories
- [ ] HTTP response compression (gzip middleware) — mainly benefits SSH mode
- [x] Integration tests — build-tagged tests against a real jj repo
- [ ] Frontend DOM integration tests (in progress)
- [x] `Divergent bool` field — replace `??` string suffix hack on `ChangeId`

## Test Gaps — Medium/Low Priority (2026-02-24)

Remaining test coverage gaps identified during the Round 2 test audit. These are pattern inconsistencies or edge cases, not missing critical logic.

### Runner error tests (13 handlers)
Unit tests verifying 500 response when runner returns an error. Already covered for `handleNew`, `handleAbandon`, `handleDescribe`, `handleRebase`, `handleGitPush`, `handleCommit`, `handleWorkspaces`. Missing for:
- [x] `handleBookmarks`
- [x] `handleDiff`
- [x] `handleStatus` — endpoint removed (dead code)
- [x] `handleGetDescription`
- [x] `handleRemotes`
- [x] `handleUndo`
- [x] `handleOpLog`
- [x] `handleEvolog`
- [x] `handleBookmarkSet`
- [x] `handleBookmarkDelete`
- [x] `handleBookmarkMove`
- [x] `handleBookmarkForget`
- [x] `handleBookmarkTrack`

### Edge case tests
- [x] `decodeBody` with body exceeding 1MB `MaxBytesReader` limit
- [x] `ParseBookmarkListOutput` with `conflict=true` or `backwards=true`
- [x] `ParseDiffStat` with binary files
- [x] `LogGraph` / `FileShow` command builder direct tests (`Status` removed as dead code)
- [x] HTTP 405 for wrong method — Go 1.22 method-prefixed routes auto-return 405; test locks in the behaviour
- [x] `ParseGraphLog("")` empty input

## UI Inspirations

### Sublime Merge
- **Three-panel layout**: left sidebar (branches/remotes/tags), commit list (center), detail view (right/bottom)
- **Commit list with graph lines**: DAG visualization with colored lanes connecting commits
- **Summary tab per commit**: hash, tree, author, committer, date, parents, branches, signature, stats
- **File tabs in diff view**: click individual changed files to view their diffs
- **Collapsible file sections**: expand/collapse individual file diffs
- **Diff stats badges**: `-0 +150` per file, color-coded
- **Branch/HEAD badges** inline with commit messages: `HEAD`, `main`, styled distinctly
- **Location sidebar**: branches, remotes (expandable tree), tags, stashes

### jjui (TUI)
- **Graph view**: ASCII DAG with `@`, `○`, `◆`, `×` node symbols, lane tracking with `│`, `╭`, `╰`
- **Keyboard-first navigation**: j/k up/down, enter for details, r for rebase, S for squash, etc.
- **Status bar**: shows current mode + available shortcuts
- **Revset bar**: editable revset filter at the top
- **Working copy `@` indicator**: amber concentric circle in graph, amber `@` badge inline
- **Conflict markers**: `×` symbol, red-colored for conflicting revisions
- **Multi-select**: check multiple revisions for batch operations
- **Preview panel**: diff preview without leaving the revision list
- **Command palette**: fuzzy-search all available actions

### Diff-viewer prior art
- **Split/unified toggle** with draggable divider for resize
- **Collapsible file diffs** with lazy rendering (IntersectionObserver)
- **Separate old/new highlighting** for accurate syntax highlighting
- **Context expansion** — on-demand "show more lines" at hunk boundaries
- **FileTable sidebar** with review checkboxes, type badges, +/- stats
- **FileTree** with directory grouping (collapsible tree)

## Features — Prioritized

### P0 — Core ✅
- [x] Revision list with change IDs
- [x] Diff viewer (unified, +/- colored)
- [x] Basic operations: new, abandon, undo
- [x] Keyboard navigation (j/k, enter, escape, e, n, u, r, /)
- [x] Status bar with shortcuts
- [x] Working copy `@` badge (detected from graph chars)

### P1 — Essential ✅
- [x] Graph view — pixel-perfect continuous DAG from jj's graph output
- [x] Full change IDs with highlighted unique prefix (like jjui)
- [x] Revset filter input (/ to focus, Escape to clear)
- [x] Describe (edit commit message inline, fetch current from API)
- [x] File list per revision (click to scroll to file diff)
- [x] Bookmark management (set, delete, move, forget endpoints)
- [x] Security: flag whitelist on git push/fetch, input validation, MaxBytesReader
- [x] `\x1F` unit separator for safe template parsing

### P2 — Polish ✅
- [x] Collapsible file diffs with sticky headers
- [x] Diff stats per file (`+N -N`, proportionally scaled from jj --stat)
- [x] Split view (side-by-side diff, unified/split toggle)
- [x] Change type badges (M blue, A green, D red)
- [x] Pinned file list + toolbar (outside scroll container)
- [x] Multi-select revisions for batch operations
- [x] Command palette (Cmd+K / Ctrl+K)
- [x] Inline diff (word-level highlighting)
- [x] Operation log viewer
- [x] Evolog viewer — structured entry list with per-step diffs (reuses `diffRange` + `DiffFileView`)

### P3 — Advanced
- [x] Retain collapse/expand state per revision (cached per change-id, restored on revisit)
- [x] Show total diff stats (aggregate +N -N across all files) in the file list header
- [ ] Branch/remote sidebar (like Sublime Merge left panel)
- [ ] Drag-and-drop rebase (drag revision onto destination)
- [x] Inline rebase mode (keyboard-driven, not a modal)
- [x] Squash support (file-level selection, keep-emptied, use-dest-message)
- [x] Split support (inline mode, file checkboxes, parallel toggle)
- [x] Conflict resolution UI — detect `×` conflicting revisions, parse jj's conflict markers (`<<<<<<<`, `%%%%%%%`, `+++++++`, `>>>>>>>`), render with A/B letter badges for spatial correspondence between buttons and section tabs. "Keep [A]"/"Keep [B]" buttons per-region + file-header. Hover preview (amber glow on kept, redaction stripes on discarded). `conflicted_files` template for structured conflict detection (replaces `resolve --list` regex parsing), `jj file show` for conflict-only files not in diff output.
- [x] Inline file editing — CodeMirror 6 editor in split-view right column. Edit button in file headers (both views — auto-switches to split, hidden for deleted files). Auto `jj edit` for non-WC revisions. Hunk folding, CSS-var theme, indent detection (tabs vs N-spaces from file content), `tabSize=4` matching `.diff-line`. Cmd+S save, Escape cancel. Stale-while-revalidate on save preserves scroll. Backend `POST /api/file-write` with symlink escape protection, .jj/.git blocking, path traversal + null-byte prevention.
- [x] **Stacked-revision combined diff** — turns out `jj diff -r 'X|Y|Z'` already produces a combined stack diff natively. Only gapped selections errored. Fixed: multi-check revsets now wrap in `connected()` (fills gaps, no-op otherwise). Added `parent_ids` to Commit + client-side connected-set computation → revisions implicitly included via gap-fill show a dotted `◌` in the check gutter. `multiRevset()` / `computeConnectedCommitIds()` in api.ts.
- [ ] **Subtle reload over SSH** — mutations over SSH cause full-screen "Loading…" state because each jj call takes ~440ms and the `loading` flag flips. Fix: extend the stale-while-revalidate pattern from DiffPanel to RevisionGraph — keep showing stale log/diff content during reload, just dim it or show a thin progress bar. **Block further mutations** during reload (optimistic UI lock) so users don't queue up conflicting ops against stale state. `loader.loading` becomes a "refreshing" indicator, not a content gate. Separate visual state for initial-load (spinner) vs refresh (dimmed + top progress bar, like GitHub/Linear).
- [ ] Three-way merge editor — replace inline conflict markers with a CodeMirror `@codemirror/merge` three-way view (base | ours | theirs). Phase 1: add backend endpoint returning `{base, ours, theirs}` per conflicted file (via `jj file show` on parent revisions). Phase 2: read-only three-pane view with diff highlighting + existing Accept Ours/Theirs buttons. Phase 3: editable center pane with "Save Resolution" that writes merged content back. Current inline card view remains as fallback for N-way conflicts (3+ sides). See [CodeMirror merge demo](https://codemirror.net/3/demo/merge.html) for the UX pattern.
- [ ] SSH remote mode performance — each jj command spawns a new SSH connection (~440ms via Coder ProxyCommand). Options: (a) batch endpoint combining diff+files+evolog into one SSH call, (b) persistent SSH session with stdin/stdout multiplexing, (c) run backend on remote with SSH port-forward (`ssh -L 3001:localhost:3001 host "lightjj -R /path"`). Option (c) sidesteps the problem entirely.
- [ ] SSH remote repo browser
- [ ] Live file watching (auto-refresh on working copy changes)
- [ ] Git push/fetch with progress indication
- [x] Diff syntax highlighting (language-aware, Shiki)
- [x] Context expansion at hunk boundaries — "Show N hidden lines" buttons between hunks, click to expand full file context
- [ ] Parse user aliases from jj config and expose them dynamically in the UI (command palette, context menu)
- [ ] Search across revisions
- [x] Themes (light/dark) — Catppuccin Mocha (dark) + Latte (light), toggle via Cmd+K, persisted in localStorage
- [ ] Syntax highlighting deadline / Web Worker — `codeToHtml` is synchronous and can freeze the UI for seconds on pathological files (e.g., 200-line CSS). Short-term: chunk input into ~30-line batches with yields between. Long-term: move Shiki into a Web Worker so `worker.terminate()` acts as a true cancellation primitive.
- [ ] Lazy rendering for large diffs (IntersectionObserver)
- [x] Draggable split view divider (resize ratio)
- [x] Support jj worktrees — detect and display workspace info via `working_copies` template field, workspace badges (teal) in graph, `GET /api/workspaces` endpoint
- [ ] Workspace switching — click a workspace badge to switch the app's serving context to that workspace, or move a workspace's working copy head to a different revision (`jj workspace update-stale`, `jj edit` from another workspace)
- [x] `jj split` support — inline file-level split from the UI, checked files stay, unchecked move to new revision, parallel toggle
- [x] Divergent commit resolution UI — detect divergent commits via `Divergent` field, show `divergent` badge + dashed ring in graph, DivergencePanel for comparing versions with color-coded cards (red=from, green=to), cross-version diff filtered to union of changed files, parent info display, "Keep" action with bookmark conflict resolution, `/N` offset labels matching jj convention
- [x] Bookmark → GitHub PR linking — `GET /api/pull-requests` shells `gh pr list`, `prByBookmark` map in App.svelte, bookmark badges linked to PRs with `#number` suffix. Draft PRs dimmed.
- [x] Cmd+F diff search — intercept `Cmd+F` / `Ctrl+F` in the diff panel, search bar with match counter, Enter/Shift+Enter navigation, `<mark>` highlights, auto-expand collapsed files. Case-insensitive, 2-char minimum. Future: case toggle, regex.

## State Synchronization

**Implemented: Op-ID header (option 1).** Every API response includes `X-JJ-Op-Id`. The frontend (`api.ts`) tracks this value; when it changes, the cache is cleared and stale callbacks fire to refresh the log. Mutation endpoints refresh the cached op-id asynchronously via `runMutation()`.

**Future improvements:**

1. **Polling endpoint** (simple): `GET /api/op-id` returns current operation ID. Frontend polls every N seconds. Refresh if changed. Adds network traffic but works without SSE/WebSocket.

2. **File watch + SSE** (best UX): Backend watches `.jj/repo/op_heads/` directory using fsnotify. On change, push event via Server-Sent Events to connected frontends. Instant refresh on any repo mutation — including CLI usage in another terminal. This is the ideal end state.

3. **Snapshot on focus**: When the browser tab gains focus (`visibilitychange` event), call `jj debug snapshot` to capture working copy changes, then check op-id and refresh if needed.

## Graph View Notes

Current implementation uses option 4 (jj's graph output) with pixel-perfect rendering:
- Each graph line (node or connector) is its own DOM row at identical height
- Node lines show commit IDs + description on a second line
- Description lines get a continuation gutter (`│` extended from the node)
- Working copy `@` detected from graph characters, not template functions

1. **SVG-based**: ✅ Implemented. Each lane character is mapped to SVG elements (`GraphSvg.svelte`). 8-color muted palette from `--graph-N` CSS vars, opacity-based hover (lines 0.45→0.7, nodes 0.8→1.0), dashed rings for divergent nodes.
2. **Canvas**: Better performance for large repos but harder to make interactive.
3. **HTML/CSS grid**: Each cell in the graph is a div with borders. Simple but limited.
4. **Use jj's graph output**: ✅ Implemented. Parse `jj log` with graph characters; SVG renderer maps them to visual elements.