# lightjj Backlog

## Agent Workflow (2026-02-27)

Features to support human-in-the-loop review of agent work across jj worktrees.

- [x] **Copy reference from diff lines** (Small) — Right-click selected diff lines → "Copy reference" with `path:line-range @ changeId` + line content. Detects native text selection via `window.getSelection()` + `Range.intersectsNode()` to find all `.diff-line` elements in the selection. Falls back to single clicked line. `DiffFileView` exports `DiffLineInfo` interface (reusable for future annotations). `DiffPanel` formats the reference with the revision's change ID.
- [x] **Per-step evolog diffs** (Small) — `jj evolog` now emits structured template output (`CommitEvolutionEntry` type: commit_id, timestamp, operation description, predecessor IDs). EvologPanel shows a clickable entry list; clicking an entry fetches `api.diffRange(predecessor, current)` and renders via existing `DiffFileView`. Zero new state tracking — hidden evolution commits are fully addressable by `jj diff --from X --to Y`. `{#key selectedRevision?.commit.change_id}` in App.svelte resets panel state on revision change. Multi-predecessor entries show `(+N)` badge; origin entries dimmed.
- [x] **Evolog: rebase-safe inter-diff** (Small) — Template now emits `self.inter_diff().git()` inline as a 5th field per entry (record sep `\x1E` since diff text has newlines). `EvologEntry` struct/interface gained `Diff string`. EvologPanel dropped its `createLoader`/`api.diffRange` dependency entirely — diff arrives with the entry list, zero per-click round-trip. Net -30 LOC, pure-presentation component, rebase-safe by construction.
- [x] **Evolog: keyboard navigation** (Small) — ArrowUp/Down to step through entries. `.entry-list` is `tabindex="-1"` with `role="listbox"`, auto-focuses when entries load, `scrollIntoView({block:'nearest'})` on selection change.
- [x] **Evolog: resizable panel height** (Small) — top-border drag handle in App.svelte (mirrors `startDividerDrag` for Y-axis, clamped 120px–70vh). Persisted in `config.evologPanelHeight` (debounced save to `/api/config`).
- [x] **Auto-refresh via filesystem watch** (Medium) — `fsnotify` on `.jj/repo/op_heads/heads/` + SSE push (`GET /api/events`) to frontend. Periodic `jj debug snapshot` (5s default, `--snapshot-interval` flag) catches raw file edits, fires **only when SSE subscribers exist** to avoid oplog pollution. 150ms server-side debounce coalesces multi-commit rebase bursts. Frontend `EventSource` → `notifyOpId()` → existing `onStale()` callbacks; same `lastOpId` dedup as HTTP header path so UI-initiated mutations don't double-fire. `http.ResponseController.SetWriteDeadline(time.Time{})` disables the 120s WriteTimeout for the SSE handler only. SSH mode returns 204 (watcher nil) → frontend closes EventSource cleanly. `--no-watch` flag to disable. New `internal/api/watcher.go`. Adds `fsnotify` Go dependency.
- [x] **Inline diff annotations** (Medium) — Per-line review comments for agent iteration feedback. Right-click diff line → "💬 Annotate" context menu (single-rev, single-line only). `annotations.svelte.ts` store keyed by `changeId`, each entry `{filePath, lineNum, lineContent, comment, severity, createdAtCommitId, status}`. Server-side storage at `$XDG_CONFIG_HOME/lightjj/annotations/{changeId}.json` via CRUD `/api/annotations` (path-traversal-safe; spawned workspace tabs share one store). **Re-anchor** on `diffTarget.commitId` change (agent iterated): `diffRange(createdAtCommitId, currentCommitId)` → delta-adjust lineNum for hunks above, content-match ±5 for spanning hunks, `orphaned` status if both fail (likely addressed). `💬` gutter badge (severity-colored, orphaned = dashed) via extracted `gutter` snippet. `AnnotationBubble` overlay popup (severity select + textarea + ⌘Enter save). Summary bar above diff toolbar: `N open · M possibly addressed` + clickable chips + Export button. Palette: "Export annotations (markdown/JSON → clipboard)". **59 frontend tests** (reanchor: delta math + spanning-hunk search + boundary/empty-line/whitespace edge cases + file-deleted; store: load/add/update/remove/clear + diffRange batching by createdAtCommitId + orphan-all-on-abandoned-commit + forLine O(1) + busy flag + reactive updates; AnnotationBubble: create/edit modes, severity select, ⌘/Ctrl+Enter save, Escape/Cancel/backdrop close, whitespace-only guard, reopen-repopulate; DiffFileView gutter badge: severity classes + orphaned styling + count superscript + click callback with raw content + no-call-on-removed-lines) + **24 backend tests** (CRUD round-trip, independent changeIds, delete-last-removes-file, clear-all, 7-way validation incl. traversal URL-encoded, corrupt-file recovery, 17 regex charset boundary cases).
- [x] **File-level accept/reject mode** (Small) — `SplitMode.review: boolean` field, `enter(id, asReview)` second param. `v` key / palette entry "Review revision". UI branches on `split.review`: badge "review"/"split", count suffix "accepted"/"stay", `lastAction` "Reviewed … (N accepted)". `DiffPanel` prop `splitMode: boolean` → `fileSelectionLabel: 'squash'|'split'|'review'`. Same jj split under the hood — checked=accepted=stays, unchecked=rejected=moves to child.
- [ ] **`jj restore` — discard file from revision** (Small) — `jj.Restore()` builder exists (`commands.go:141`, `-c` flag = restore files in `revision` to its parent's content) but has zero callers. Natural inverse of file-level squash/split. UX: right-click file header in DiffPanel → "Discard from this revision" (single-rev only). Also file-list context menu. One handler (`handleRestore` → `runMutation`) + `api.restore(commitId, files[])` + context menu item + file-header button next to Edit. `--interactive` not useful from UI (no tty). ~1h.
- [ ] **Hunk-level accept/reject** (Medium) — Per-hunk checkboxes in DiffFileView during review mode. **Via `jj split --tool` diff-editor protocol**: tool receives `$left`/`$right` directories, modifies `$right` in place, jj reads it back as the first half of the split. lightjj binary re-enters as the tool (`--apply-hunks=<spec.json>` flag): read `$left/file` + `$right/file`, apply only accepted hunks from spec to left content, write `$right/file`, exit 0. jj handles all revision graph work (descendant rebasing, etc). Hunk application is line-splicing on the already-parsed `DiffFile.hunks` (context lines verify offset, `-` skip, `+` insert). Spec passed via temp file. SSH caveat: tool must exist on remote — hunk-level is local-only unless binary is shipped. ~1-2 days.

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
- [x] **`hoveredLane` fans out to every GraphSvg** — fixed: removed lane-level hover entirely. Lane 0 spans the entire graph, so highlighting it was visually jarring. Graph elements no longer have hover state — row-level `.hovered` class (background highlight) is sufficient.
- [x] **Phantom `:hover` after layout shift** — error bar mount/unmount, batch-actions bar toggle, `scrollIntoView`, and post-rebase DOM reshuffle all slide `:hover` onto whatever row is now under a stationary mouse. j/k moves `.selected` but the gray hover stays pinned. A suppress-flag `$effect` was tried but is whack-a-mole (3 untracked triggers found in review, including parent state that isn't even a prop). Fixed by replacing CSS `:hover` with JS-tracked `hoveredIndex` driven by `mousemove` — which per UI Events spec fires ONLY on physical pointer movement, never on layout shift. Structurally impossible to phantom. Side win: 8 sibling-chain `:has()` rules → 1 class selector (all rows of a revision share `entryIndex`).
- [x] **Opportunistic prefetch during nav debounce** — `selectRevision` fires `prefetchRevision()` for the next revision in the navigation direction, **but only when current is cached** (instant main load → no network contention). Unconditional prefetch during rapid uncached j/k stacked 3N requests, exhausting Chrome's 6-connection-per-origin limit. Fire-and-forget with swallowed errors.
- [x] **`statusText` re-scans revisions on every loading flip** — `revisions.find(r => r.commit.is_working_copy)` was running linearly on every `loading`/`mutating`/`diffLoading` state change (4-6 scans per mutation cycle × 500 revisions). Extracted to `workingCopyEntry = $derived(...)` — now only re-scans when `revisions` actually changes.
- [x] **`aliases`/`remotes` uncached** — session-stable data re-fetched on every GitModal/BookmarkModal open. Now lazily cached (promise-memoized) in api.ts; reset only on `clearAllCaches()`. Error path clears the memo so retries work.
- [x] **Remove `codemirror` meta-package** — never imported directly. `pnpm remove codemirror` done. Note: `@codemirror/autocomplete` is still a transitive dep of `@codemirror/lang-*` packages, so bundle savings are modest. Full elimination requires switching to bare Lezer grammars.
- [ ] **No virtualization for mega-files** — manual expand of 5000-line file renders all lines. Auto-collapse at 500 is the mitigation; `@tanstack/virtual` would be the full fix.
- [x] **Batch endpoint `/api/revision?revision=X`** — returns `{diff, files, description}` in one round-trip (5 jj commands run in parallel server-side). Frontend `api.revision()` **seeds the three individual cache keys** (`diff:X`, `files:X`, `desc:X`) so `api.diff()`/`files()`/`description()` become cache hits; zero component-level refactoring. The `diff` loader's fetch function calls batch first (opt-in via `batch=true` param — multi-revset `loadDiffForRevset()` bypasses it), then `files.load()`/`description.load()` fire microtask-fast. `prefetchRevision()` simplified from 3 fetches to 1. Race-safety preserved: the batch await is inside the loader's fetch, so the generation counter gates it.
- [x] **~~Mutable→immutable cache promotion~~ — OBSOLETE: cache is now keyed by `commit_id`** (content-addressed, self-invalidating). No more two-tier mutable/immutable split; no `responseCache.clear()` on op-id change. `jj new`/`abandon`/`undo` invalidate zero cache entries; rewrites only invalidate the rewritten commit + descendants (via new commit_ids).
- [x] **Synchronous cache read for nav cache hits** — `getCached(commitId)` reads the api.ts Map directly. `selectRevision` uses `loader.set()` in the same tick as `selectedIndex` — Svelte batches into one render, eliminating the one-frame stale-fileset flash that `setTimeout(0)` deferral caused. Cache misses still get 50ms debounce. Cache-hit branch also bumps `revGen` so a `loadDiffAndFiles` suspended at `await api.revision()` can't resume and call `diff.load(stale)` (which would bump `loader.generation` past the `set()` and win).
- [x] **`Cache-Control: immutable` on `/api/revision`** — browser disk cache survives page reload; in-memory cache doesn't. Frontend sends `?immutable=1` (only it knows the param is a commit_id not a change_id). `writeJSON` suppresses `X-JJ-Op-Id` when the header is set — a year-old op-id baked into disk cache would ping-pong `lastOpId` on reload and fire spurious `loadLog()`. Degraded responses (GetDescription soft-fail) skip the header so `description:""` isn't cached forever.
- [x] **Batch file-list preload** — `GET /api/files-batch?revisions=X,Y,Z` runs a single `jj log -T 'self.diff().stat().files()...'` template for N revisions in one subprocess. Returns `map[commitId]{conflict, files[]}` with status char, path, `lines_added`, `lines_removed` — everything the file sidebar needs. Conflicted commits are skipped from cache seeding (they need side-count detail the template doesn't expose). Frontend `prefetchFilesBatch()` seeds `files:${commitId}` cache keys; fired from `loadLog()` + during nav (re-centers window around `selectedIndex`, filters to uncached internally so repeated calls are cheap). Result: file sidebar shows instantly during j/k; only the heavy diff text fetches per-rev.
- [x] **`commands` $derived rebuilds ~~on every j/k~~ on check/uncheck** — Split into `staticCommands` (zero-dep `$derived.by` → computes once, thunk sidesteps TDZ for handlers below), `dynamicCommands` (5 reactive-label entries), `aliasCommands`. Space-spam now rebuilds 5 objects + one spread instead of 30+. (Original claim was wrong: j/k doesn't touch `checkedRevisions.size`, the actual trigger was Space.)
- [ ] **Consolidate Shiki → CM6 for diff highlighting** — two syntax engines ship in the bundle (Shiki ~1,074 KB + CM6 ~1,254 KB source). CM6's `highlightCode()` API can produce static tokens without an editor, replacing Shiki for read-only diffs. Would eliminate ~180 KB gzip. Requires adding ~8 Lezer grammar packages and rewriting `highlighter.ts`. See ARCHITECTURE.md "Syntax Highlighting: Dual Engine".

### Remaining — Maintainability
- [x] **Extract `diffLoader.svelte.ts`** — Done as `createLoader()` factory in `loader.svelte.ts`. 6 copy-pasted load functions collapsed to 6 one-line declarations; 11 `$state` vars replaced with `$derived` aliases. 17 tests covering races, cancellation, cache-hit fast path (macrotask-deferred loading flag). `set()` bumps generation so in-flight loads can't overwrite an authoritative write (fixes a cache-hit navigation race). `reset = () => set(initial)`.
- [x] **Extract `diff-derivation.svelte.ts`** — `createDiffDerivation()` factory for per-file progressive computations (Shiki highlighting, word-diff LCS). DiffPanel 1616→1534 lines; two 40-line `$effect` blocks + `highlightDiff`/`computeAllWordDiffs` collapsed into two factory instances. 17 tests on abort/memo/progressive-publish that the inline version never had. `run(files, cacheKey)` yields between files with optional `immediateBudget` (first N lines without yield to prevent plain-text flicker). `update(file)` for single-file deltas (context expansion). `tryRestore(cacheKey)` for synchronous memo check — called before the setTimeout deferral so revisits restore zero-frame. Memo externalized via `readMemo`/`writeMemo` accessors so both derivations share one LRU bucket in `derivedCache` (evict together).
- [x] **Svelte 5.44+ `effect_update_depth_exceeded` in `diff-derivation`** — PR #17145 changed effect batching so the derivation `$effect`, template effects reading `byFile`, and the reset effect writing `expandedDiffs` run in the same flush. `update()`'s `new Map(byFile)` registered the Source as an effect dep → `schedule_possible_effect_self_invalidation` → loop. Fix: `readByFile = () => untrack(() => byFile)` for internal reads (load-bearing); writes stay naked (untrack doesn't affect `mark_reactions`). `writeMemo` now stores local `done` instead of aliased `byFile` — storing the live ref risked equality-check no-op on restore. RevisionHeader's previous-value sentinel reset effect replaced with `{#key}` (5.50+ flags the pattern as `state_referenced_locally`).
- [x] **`gh pr list` bypasses runner interface** — ~~moved `execGhPRList` from package-level var to `Server.ExecGhPRList` field~~ → superseded: added `CommandRunner.RunRaw(argv)`. `gh` now goes through the runner like everything else. SSHRunner wraps it as `ssh host "cd <path> && gh ..."` so PR badges work in `--remote` mode. `ExecGhPRList` hook deleted — tests use `MockRunner.Expect(ghPRListArgv)` like any other command.
- [x] **Backend fields unexposed in frontend** — wired `skipEmptied` and `ignoreImmutable` to rebase mode (`e`/`x` keys), `ignoreImmutable` to squash mode (`x` key). Added to `modes.svelte.ts` interfaces + factories, `api.ts` parameters, `App.svelte` execute functions, and `StatusBar.svelte` key indicators.

### Remaining — Reliability
- [x] **Settings don't persist across sessions** — implemented option (c): server-side config at `os.UserConfigDir()/lightjj/config.json` via `GET/POST /api/config`. Port-agnostic. localStorage stays as write-through cache for instant initial paint. Forward-compat: backend merges with `map[string]json.RawMessage` so unknown keys survive older-version writes. Atomic temp+rename write. Works in SSH mode (config dir is local, not repo-relative). Frontend exposes `config.ready` promise — the tutorial/what's-new check awaits it so `tutorialVersion` reads the disk value, not the pre-hydration default.
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
- [x] `"origin"` hardcoded as preferred remote — now configurable via `--default-remote` flag. `Server.DefaultRemote` field defaults to `"origin"` in `NewServer()` body (zero test churn across 69 call sites); `main.go` overrides post-construction. `ParseBookmarkListOutput` parameterized.
- [x] MockRunner `RunWithInput` silently discards stdin — can't verify describe content.

### Suggestions
- [x] `App.svelte` is 1010 lines — rebase/squash/split state is ambient and threaded through multiple components. Extract to shared module.
- [x] Rename `squashMode` → `fileSelectionMode` in DiffPanel props — partially done; App.svelte still uses `squashMode` internally.
- [x] Rename `squashSelectedFiles`/`squashTotalFiles`/`toggleSquashFile` to `selectedFiles`/`totalFileCount`/`toggleFileSelection` in App.svelte — now shared by squash and split modes.
- [x] Rename CSS classes `rebase-badge`/`rebase-source`/`rebase-target` to `mode-badge`/`badge-source`/`badge-target` — shared across rebase, squash, split.
- [x] Squash mode StatusBar file count now says "N/M files to move" for parity with split's "N/M files stay".
- [x] Add bulk select/deselect toggle for file checkboxes (applies to squash + split modes).
- [ ] No list virtualization for large repos (500+ commits).
- [x] No HTTP response compression — `api.Gzip()` middleware (`gzip.go`) wraps the mux in `main.go`. Lazy gzip.Writer init (204/304 stay empty), `sync.Pool` for writer reuse, `Flush()` passthrough for SSE. 3 tests covering compress/skip/empty-body.
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
- [x] `"origin"` hardcoded as preferred remote — `--default-remote` startup flag (see Warnings section)
- [x] `OplogPanel` inline error display — `Loader` factory now exposes `.error`; OplogPanel shows inline error + Retry button instead of routing to global `showError`

**Larger refactors (half day+):**
- [x] `App.svelte` rebase state extraction — moved rebase/squash/split mode state to `modes.svelte.ts`, theme CSS to `theme.css`, added `runMutation` helper (App.svelte 1590→1269 lines)
- [ ] List virtualization for large repos — `@tanstack/virtual` for 500+ commit histories
- [x] HTTP response compression (gzip middleware) — see Suggestions section
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
- [x] `EvologPanel` keyboard nav — ArrowUp/Down boundary clamping, `selectedIdx === -1` → 0 for both keys, empty-entries no-op. 11 tests in `EvologPanel.test.ts` (rendering + keyboard + diff-display states).

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
- [x] **Subtle reload over SSH** — mutations over SSH cause full-screen "Loading…" state because each jj call takes ~440ms and the `loading` flag flips. Fixed in `RevisionGraph.svelte` — `isRefreshing` derived + `.refresh-bar` always-mounted element. `loader.loading` is now a "refreshing" indicator, not a content gate; initial-load shows spinner, refresh dims + top progress bar.
- [ ] Three-way merge editor — replace inline conflict markers with a CodeMirror `@codemirror/merge` three-way view (base | ours | theirs). Phase 1: add backend endpoint returning `{base, ours, theirs}` per conflicted file (via `jj file show` on parent revisions). Phase 2: read-only three-pane view with diff highlighting + existing Accept Ours/Theirs buttons. Phase 3: editable center pane with "Save Resolution" that writes merged content back. Current inline card view remains as fallback for N-way conflicts (3+ sides). See [CodeMirror merge demo](https://codemirror.net/3/demo/merge.html) for the UX pattern.
- [ ] **SSH inotify pipe for auto-refresh** (Small) — `SSHRunner.Stream()` already holds a persistent SSH connection open. Add `NewSSHWatcher(srv, sshRunner, repoPath)` that pipes `inotifywait -m -e create $repo/.jj/repo/op_heads/heads` (or `fswatch` on macOS) through the existing Stream interface. Each stdout line = one fs event → same `broadcast()` path as local fsnotify. Needs: `SSHRunner.StreamRaw(ctx, rawCmd)` method (bypasses `wrapArgs` which is jj-specific), `sshWatchLoop()` with reconnect on stream close, `bufio.Scanner` over the `io.ReadCloser`. Remote dep: `inotify-tools` package (Linux). Snapshot loop stays disabled for SSH (would need second persistent pipe). ~60 lines in watcher.go.
- [ ] **SSH jj command latency** — ~440ms per call via Coder ProxyCommand. Options in order of complexity: (a) **SSH ControlMaster** — user-side SSH config (`ControlMaster auto`, `ControlPersist 10m`), zero code changes, eliminates TCP/auth handshake for subsequent calls; (b) **Run lightjj on remote + port-forward** — `ssh -L 3001:localhost:3001 host "lightjj -R /path --addr localhost:3001 --no-browser"`, full local-quality perf, fsnotify watcher works natively, sidesteps every SSH-latency issue (documented in README); (c) **stdin/stdout multiplexing protocol** — one persistent SSH session, commands + responses over a simple framed protocol, complex.
- [ ] SSH remote repo browser
- [x] Live file watching (auto-refresh on working copy changes) — fsnotify on `.jj/repo/op_heads/heads/` + periodic `jj debug snapshot` → SSE push. See Agent Workflow section.
- [ ] Git push/fetch with progress indication
- [x] Diff syntax highlighting (language-aware, Shiki)
- [x] Context expansion at hunk boundaries — "Show N hidden lines" buttons between hunks, click to expand full file context
- [x] Parse user aliases from jj config and expose them dynamically in the UI — `aliasCommands` in App.svelte, `api.aliases()` promise-memoized
- [ ] Search across revisions
- [x] Themes (light/dark) — Catppuccin Mocha (dark) + Latte (light), toggle via Cmd+K, persisted in localStorage
- [x] Syntax highlighting deadline — short-term chunking implemented. `highlightLines()` tokenizes at `HIGHLIGHT_CHUNK_LINES = 30` with `setTimeout(0)` yields + `isStale()` callback threaded down from `highlights.run()` → `highlightFile()` → per-chunk abort. Max block time ~15-30ms. Also `HIGHLIGHT_MAX_CHARS = 20_000` guards against single minified-bundle lines (line-count chunking doesn't help when one line is 50KB). Long-term Web Worker migration still open — `worker.terminate()` would be a true cancel primitive and delete the chunking hacks.
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