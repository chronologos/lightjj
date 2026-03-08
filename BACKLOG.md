# lightjj Backlog

## Architecture Review Round 3 (2026-03-06)

Five-agent parallel audit (App.svelte state, backend API surface, DiffPanel, api.ts client, cross-cutting). Architecture is sound at the boundaries, sprawling in the middle — ~80% of maintainability risk lives in two god-files (App.svelte 2013L, DiffPanel.svelte 1755L). No single decision "really hampers" things; it's accretion.

### App.svelte state sprawl

**Scoped after deep-review (2026-03-06):** Modal-union rejected — of 9 booleans only 5 are real modals, all use `bind:open` (union would need 5 getter/setter binding pairs = more code than now). `evologOpen`/`oplogOpen` are panels (must coexist); `wsDropdownOpen` is a dropdown; `divergence.active` is an inline mode that's in `anyModalOpen` only for keyboard-blocking. Dispatch-table rejected — Cmd+K/Cmd+F fire regardless of mode (can't table), `split.handleKey(key)` is a wildcard (can't enumerate), Escape's 3-tier priority needs negation chains OR array-order-as-priority (both worse than code order).

- [x] **Extracted keyboard sub-handlers** — `handleKeydown` 210 → 12-line dispatcher. Sub-handlers: `handleGlobalOverrides` (Cmd+K/F, works in inputs), `handleInlineCommit` (inline Enter/Escape — `isInInput` sub-filter so cm-editor handles its own; `return true` IS the isInInput dedup), `handleInlineNav` (tuple destructure `[mode, jk]` per-mode: squash = cursor-only, rebase = full, split = none; then `mode.handleKey()`), `handleEscapeStack` (descriptionEditing > checks > error), `handleGlobalKeys` (10-key view-independent switch), `handleLogKeys` (14 keys; `singleOnly`/`oneOrMany` gate vars name the sub-policies previously open-coded 8×). Shared `navKey(e, select)` helper dedupes the 3 j/k implementations. Behavior-equivalent (traced: `return handleInlineNav(e)` is a return statement regardless of void expr → swallows-everything preserved; boundary j/k no longer preventDefault but no browser default exists). `handleInlineCommit`'s Enter dispatch: `inlineMode && !split && !squash ⇒ rebase` (invariant). ~155 LOC total. App.svelte 2014 → 1983.
- [x] **`welcomeOpen` orphaned from `closeModals()`** — `if (welcomeOpen) dismissWelcome()` in `closeModals()`. NOT just `welcomeOpen = false` — that'd close without persisting `config.tutorialVersion`, re-showing welcome every launch until user clicks the modal's own close. Guarded (Cmd+K path calls closeModals frequently).
- [x] **`openModal(name)` helper** — `closeAllModals(); xOpen = true` centralized. 6 call sites consolidated (palette actions :346/:350, `g`/`B` keys, toolbar Git button, context-menu :604). Palette is NOT in the union: Cmd+K uses `closeModals()` (not `closeAllModals()`) so inline modes survive palette open/close — the other modals don't want that.
- [x] **`DivergenceMode.handleKey` dead** — divergence is in `anyModalOpen` not `inlineMode` → never reaches `handleInlineNav`'s `mode.handleKey()`. Dropped `extends ModeBase` + the method.
- [x] **Redundant `onclose`/`oncancel` + `bind:open`** (Trivial) — ~~Made `onclose`/`oncancel` optional~~ → deleted entirely (never passed in production; tests spying on them were rewritten to assert DOM absence). `bind:open` alone propagates `false` to the parent.
- [x] ~~**`createDescribeMode()` factory**~~ (Scoped down to helper) — Factory rejected: the 4 vars are cohesive; `markSaved()` would need a `setTimeout` side-effect breaking "pure state". The ACTUAL dup was the fetch-or-fallback prefill logic (fullDescription → api.description → revision.description). Extracted to `fetchPrefillDescription()` + `focusDescEditor()` — `handleCommit`/`startDescriptionEdit` now 5 lines each.
- [ ] **`selectedFiles`/`totalFileCount` shared scratchpad** (Small) — :144-145. Written by both `enterSquashMode` (:869) and `enterSplitMode` (:933), read by both executes. Works only because `cancelInlineModes()` zeroes them — any new entry point that forgets → state leaks between modes. Either push into each mode factory (duplicate) or extract `createFileSelection()` that both compose.
- [ ] **Revset input ownership inversion** (Small) — 5 `onrevset*` callbacks on RevisionGraph (27 props total) exist because the input lives inside RevisionGraph but its state (`revsetFilter`) lives in App. Move ownership into RevisionGraph or extract; removes 5 callbacks.
- [x] **Context-menu state** (Trivial) — 4 vars → single `contextMenu: {items,x,y}|null`. Render site `{#if contextMenu}` + function binding `bind:open={() => true, (v) => { if (!v) contextMenu = null }}` — child writes `false`, parent nulls.

**Rejected:** Modal-union (see above). InputMode-enum dispatch table — `$derived inputMode` is impossible (`e.target.tagName` is event-scoped, not reactive); degrades to `computeInputMode(e)` at which point you've built the sub-handler extraction with a veneer. Keybind registry (PaletteCommand-shaped array with `when` predicates) — adding a new mode requires auditing every `when` to add `&& !newMode.active`; current early-return-and-swallow is structurally safer.

### DiffPanel god-component

**Scoped plan after deep-review (2026-03-06):** factory extractions for inline-edit/search rejected — singleton state whose lifecycle is OWNED by the reset effect (:586-622); factorizing creates "distributed monolith" with injected getters replacing closure access. The `diffTarget` stale-guard at :311/:313 compares captured vs *live* prop — per-call-arg factory would kill it (same bug class as `revGen`). Prop-object bundling (`edit={{...}}`) is a perf regression (fresh identity every render). What's left:

- [x] **`diff-cache.ts` module** — `<script module>` block (48 lines) → standalone module with `clearDiffCaches()`. App.svelte's hard-refresh palette action now calls `clearAllCaches(); clearDiffCaches()` — previously the hard refresh left `derivedCache`/`parsedDiffCache`/`collapseStateCache` intact. No api.ts→diff-cache import (would cycle; both import from each other). `parsedDiffCache` stays un-exported (internal to `parseDiffCached()`). `beforeEach` in DiffPanel.test.ts calls `clearDiffCaches()` — module-scoped caches were leaking collapse state between tests.
- [x] **`FileSelectionPanel.svelte`** — 263 lines (115 script/template + 148 CSS; duplicates `.file-dot`/`.file-tab-stats` from DiffPanel — Svelte scoping means no leak). Props: `mode`, `files`, `selected`, `ontoggle`. Focus effect simplified: `{#if fileSelectionMode}` wrapper means mount = mode entry → single `listEl?.focus()`, no blur-on-exit needed (element unmounts). Dropped the unused `split-selection` class. 11 tests: j/k clamping, Space/a/n toggles, Enter/Escape bubble unhandled (the App.svelte global handler contract).
- [x] **`DiffPanel.test.ts`** — 8 tests. The `startEdit` race (:264/:266) is tested BOTH ways: nav-during-api.edit (fileShow never fires) and nav-during-api.fileShow (stale content not written). Stale guards compare captured `revId` against LIVE `diffTarget` prop — `rerender()` updates the prop mid-await, the guard catches it. `discardFile` busy-guard: click Discard while `editBusy.has(path)` → `api.restore` never called. Reset-effect: editing state clears on nav; search BAR stays open (query clears) — encodes the `searchOpen` behavior a factory `close()` would have broken. Collapse save/restore keyed by **change_id** (test navigates to same change_id + new commit_id → collapse restored). Auto-collapse suppression on cache restore: `lastAutoCollapseDiff` set on restore → big file stays expanded on revisit IF something was manually collapsed at nav time (otherwise cache has nothing to save → auto-collapse reasserts, which is correct). jsdom IntersectionObserver stub added to vitest-setup.ts (DiffPanel's file-tab tracker uses it; no-op stub → `activeFilePath` stays null).
- [x] **Context-menu "Split..." while already in squash** (Low, edge) — Revision context-menu mode-transition items (Edit/New/Describe/Rebase/Squash/Split/Set bookmark) now gated on `disabled: inlineMode` in `openRevisionContextMenu`. Abandon stays enabled (straight mutation, no mode entry). Matches the existing keyboard/palette gates.

**Rejected (after review):** `createInlineEdit()` factory (stale-guard bug + net +90 LOC + `set error` smell), `createDiffSearch()` factory (extracts only arithmetic — `searchMatches` depends on `effectiveFiles`/`conflictFileDiffs`, `scrollToMatch` writes `collapsedFiles`), annotation-store hoist (moves load effect + `lastAnnCommitId` sentinel into 2013-line App.svelte; 2/5 `bind:this` calls survive anyway), EditProps bundling (fresh object identity → spurious DiffFileView invalidation).

**Not doing regardless:** derivation `$effect` (:541-574) + reset `$effect` (:586-622) + `collapsedFiles` + `expandFile` are the component's actual identity. Extracting them is `createDiffController()` — same coupling through thinner straws.

**Net:** DiffPanel 1755 → 1491. Script 899 → ~655. 19 new tests (564 total).

### Backend / API

- [x] **Dead command builders** (Trivial) — Deleted 9 zero-caller functions + tests from the jjui port: `DiffEdit`, `Redo`, `Duplicate`, `Absorb`, `OpRestore`, `GetParents`, `GetFirstChild`, `FilesInRevision`, `ConfigListAll`. -45 LOC commands.go, -50 LOC tests.
- [x] ~~**Extract `WorkspaceSpawner`**~~ — Moot; workspace-as-tab deleted `spawnWorkspaceInstance` entirely.
- [ ] **7 near-identical bookmark handlers** (Low, taste-dependent) — handlers.go:734-823 (~130 LOC). Each is decode → validate-non-empty → runMutation. Go's lack of structural typing makes table-driven dispatch awkward; current form is greppable. Defer unless bookmark family grows.
- [x] **`handleDescribe` duplicates `runMutation` body** (Trivial) — `runMutationWithInput(w, r, args, stdin)` sibling; `runMutation` delegates to it with `""` stdin (LocalRunner.run only sets cmd.Stdin when stdin != ""). handleDescribe is now a one-liner.
- [ ] **`RepoDir == ""` overloaded sentinel** (Low) — Used as SSH-mode flag across 6+ sites (server.go:193,407; handlers.go:396,426,1005; watcher.go:59). Conflates "SSH mode" / "test mode" / "no local fs". The real bit is "local filesystem access available" — name is wrong, semantics are coherent. A `Capabilities` bitset (or just `hasLocalFS bool`) would clarify error messages ("file writing requires local fs" not "SSH mode") but is cosmetic.

### api.ts client

- [x] **Wire-type drift test** (Small, test-only) — `TestWireTypes` in handlers_test.go POSTs raw JSON strings (the exact TS-side shape: `skip_emptied`, `ignore_immutable`, `source_mode`, `target_mode`, `keep_emptied`, `use_destination_message`) and asserts MockRunner sees the expected jj args. A Go tag typo → field zero-values → args diverge → test fails. Existing tests that `json.Marshal(goStruct)` are blind to this because the struct round-trips correctly regardless of the tag string.
- [x] **`context=0` cache-key collision** (Trivial) — `context != null` check for both URLSearchParams and cache key.
- [x] **SSE gives up on CLOSED, never reconnects** (Small) — `wireAutoRefresh` now has a reconnect loop with the SAME `everSawEvent` heuristic as `sshWatchLoop`: `handleEvents` pushes the current op-id immediately on connect, so CLOSED-before-any-event = watcher absent (204, `--no-watch`) → give up. CLOSED-after-events = transient (backend restart) → exponential backoff 1s→30s. No HEAD probe needed — the heuristic is simpler and distinguishes correctly.
- [x] **Mutation timeout** (Low) — `MUTATION_TIMEOUT_MS = 60_000` for non-streaming POSTs. `request()` now arms the AbortController for both GET (30s) and POST (60s) — the prior POST-is-unbounded rationale was cargo-culted from `streamPost` (which correctly has no timeout: minutes-long pushes are valid). Actual jj mutations finish in <1s; the timeout catches SSH stalls and WC lock deadlocks. Test: 31s advance doesn't abort POST, 61s does.
- [ ] **Flat `api` object at 44 methods** (Deferred) — bookmark sub-family (7 methods) is the strongest namespace case. Pure helpers (`effectiveId`/`multiRevset`/`computeConnectedCommitIds`) are zero-I/O and don't belong in api.ts. Hold until next expansion.

### UX consistency

- [x] **BookmarksPanel context menu** (Small) — `oncontextmenu` prop passes `(bm, actions: BookmarkRowActions, x, y)` — the `actions` gates (jump/del/track) are computed panel-side from the SAME `computeActions(bm)` helper that d/f/t keys use; App's menu builder doesn't duplicate. Right-click disarms any pending double-press confirm + syncs keyboard selection to the clicked row.
- [x] **Right-click → copy filename(s)** (Small) — Unified context-menu pattern: components build `ContextMenuItem[]` locally, emit via `oncontextmenu?.(items,x,y)`, App renders a single singleton. **DiffPanel**'s private `diffCtx` deleted → `anyModalOpen` now sees it. **DiffFileView** file-header: Copy path / Open in editor / Expand full / Collapse / Discard. **Diff-line** menu extended: Copy path + Open-at-line prepended before Copy reference. **FileSelectionPanel**: Copy path / Copy all / toggle / check-all / uncheck-all (shortcut hints: Space/a/n). **OplogPanel**: Copy op ID / Undo this op / Restore to here (`disabled: is_current`). **EvologPanel**: Copy commit ID / Restore this version (gated on `i>0 && !divergent` — divergent change_id → ambiguous `--to`). CLAUDE.md recipe added.
- [x] **Open in $EDITOR** (Small) — Config field `editorArgs: string[]` (pre-split argv, placeholders `{file}`/`{line}`). Backend `internal/api/open.go`: `buildEditorArgv` with per-element substitution + argv[0] validation (absolute OR LookPath, never relative — blocks config-poisoning → arbitrary relative binary). `handleOpenFile` reuses extracted `validateRepoRelativePath` (lexical only — symlink checks are write-protection, opening in own editor is harmless). `Setsid` via build-tagged `detachProcess` (open_unix.go/open_windows.go) so Ctrl+C on lightjj doesn't kill editor. `go cmd.Wait()` reaps zombie. Empty `editorArgs` → 400 "no editor configured" (terminal editors without tty = silent failure). SSH mode → 501. `/api/info` gained `ssh_mode: bool` (from `RepoDir==""`) — frontend gates `onopenfile` prop to `undefined` when true → menu item shows disabled "(local only)". **Defense-in-depth**: `handleConfigSet` now rejects non-loopback `Origin` headers (cross-origin page can't POST malicious editorArgs).

### Cross-cutting

- [ ] **Watcher struct does 5 things** (Deferred — testability already achieved) — The decomposition (`Broadcaster`/`OpHeadsWatcher` iface/`SnapshotTicker`) would add 3 lifecycle owners needing coordinated shutdown, a `getOpId` injection point into `Broadcaster.handleEvents` (second injection site), and TabManager `onSub`/`onUnsub` rewiring — for zero new testability: `sshWatchLoop` is now fully tested via function-param injection. Revisit only if a third `OpHeadsWatcher` impl appears.
- [x] **`sshWatchLoop` tests** (Small) — 7 cases via `scriptedOpen` harness (`io.Pipe()` per step with scripted lines/closeAfter/err). `fastClose`/`baseBackoff` are now **function params** (not struct fields — zero zero-value risk); tests use ~ms values, suite runs <1.5s. Covers: tool-missing bail, open-error-before-events bail, fast-close-after-events bail (5x), **open-error-after-events bail (the fix just shipped)**, line-resets-fastFails-AND-backoff, broadcast on line, ctx-cancel-during-backoff-sleep, timer-stopped-on-bail (the `defer timer.Stop()` fix — `AfterFunc` would broadcast post-exit otherwise).
- [x] **`handleConfigSet` / annotation upsert TOCTOU** (Trivial) — `configMu` / `annMu` package-level mutexes around the read-merge-write cycle. atomicWriteJSON prevents torn writes but not lost updates (two tabs both read S₀, both merge, last rename wins). `mergeAndWriteConfig()` extracted from handleConfigSet — holds configMu for the whole cycle, reused by `writePersistedTabs()`.
- [ ] **No `storage` event listener in config.svelte.ts** (Trivial) — two browser tabs on same port: A writes localStorage, B's `$state` never re-reads (`loadLocal()` runs once at module eval). Diverge until reload.

### Micro (file when bored)

- [x] **`annotations.forLine` allocates `[]` on every miss** (Trivial) — `const NO_ANN: readonly Annotation[] = []` singleton. Propagated `readonly` to interface return type + DiffFileView `annotationsForLine` prop (callers never mutate).
- [ ] **Double-slice per diff line** (Trivial) — DiffFileView.svelte:334 + :336 both slice `line.content`. One alloc.

## Multi-tab follow-ups (2026-03-06)

Tabs shipped: TabManager mounts N Server instances at `/tab/{id}/` via StripPrefix; frontend `{#key activeTabId}` remounts App per-tab; `basePath` in api.ts prefixes `/api/*`. commit_id cache is cross-tab safe (SHA-256 content hash). Deferred:

- [x] **State-preserving tab switch** (Small — approach rewritten post-review) — `createRepoView`+`createApiClient` was architecturally wrong: multiple clients → multiple SSE → breaks TabManager idle-shutdown; module-level `staleCallbacks` would cross-fire. **Actual fix:** AppShell snapshots `{selectedIndex, revsetFilter, activeView, diffScrollTop}` via `appRef.getState()` before `{#key}` remount, rehydrates as `initialState` prop. `{#key}` STAYS (SSE lifecycle correctness); only cursor/scroll thread through. Inline modes intentionally NOT preserved (half-complete operation across tabs = footgun). `untrack()` on `initialState` read silences `state_referenced_locally` (prop never changes mid-lifetime inside `{#key}`). Scroll restore: one-shot `$effect` fires once after first `!diffLoading` + `diffPanelRef`, then nulls `pendingScrollRestore`. ~40 LOC total.
- [x] **Tab persistence across restart** (Small) — `"openTabs": [{path, mode}]` in config.json, written by `persistTabs()` after handleCreate/handleClose (AFTER the HTTP response — config I/O doesn't delay the UI). Tab 0 (the `-R` flag tab) excluded — it's implicit from CLI, persisting it would conflict with a different `-R` on next launch. Startup loop in main.go: `ReadPersistedTabs()` → filter by mode (local session can't open ssh paths) → `resolve()` (re-validates, re-canonicalizes — handles moved/deleted repos gracefully) → `FindByPath` dedup against the -R tab → `AddTab`. `TabManager.Mode` = "" → persist no-ops (existing tests unaffected, no withConfigDir() churn). `writePersistedTabs()` goes through `mergeAndWriteConfig()` so theme/editorArgs survive.
- [x] ~~**SSH-mode multi-tab**~~ — `TabResolve`+`TabFactory` injection; `quoteRemotePath` handles `~` expansion on remote.
- [x] ~~**Replace `spawnWorkspaceInstance` with in-process tab**~~ — Workspace dropdown now calls `onOpenTab(ws.path)` → `POST /tabs`. `spawnLocked`/port-polling/child-tracking deleted (~130 LOC). SSH-mode paths via `RunRaw` cat of workspace_store/index.
- [ ] **Annotations repo-partitioning** (Trivial) — `annotations/{changeId}.json` — changeId is jj-random (~2^128 space), collision across repos is negligible but semantically wrong. Partition as `annotations/{repoRootHash}/{changeId}.json`. Fix when it matters.
- [x] **WelcomeModal re-show on tab switch** (Trivial) — `<script module>` block with `let welcomeCheckDone = false` — module-scope survives `{#key}` remount. `if (!welcomeCheckDone) config.ready.then(() => { welcomeCheckDone = true; ... })`.

## jj 0.39 compat (2026-03-04)

- [x] **`debug snapshot` → `util snapshot`** (Trivial) — jj 0.39 deprecated `debug snapshot` (removed v0.45). Periodic loop fires every 5s → deprecation warning firehose. `DebugSnapshot()` args changed; function name kept (4 call sites, zero semantic delta). `README.md:73` bumped min jj to 0.39.
- [x] **Workspace relative paths** (Small) — jj 0.39 anchors at `.jj/repo/` (verified: `default` → `../../`, secondary → `../../../sibling`). `readWorkspaceStore` resolves via `filepath.Join(repoStore, p)` (handles `..` traversal) before returning; callers (spawn IsAbs check, current-match `==`) both fixed at once. Parser stays pure. `s.RepoDir` comes from `jj workspace root` — already symlink-resolved, so the resolved path and RepoDir agree without `EvalSymlinks`.
- [ ] **`git push --option` / `-o`** (Trivial) — Add to `allowedGitPushFlags` (`handlers.go:20`). Passes server-side push options (Gerrit reviewers, GitLab merge options). Low demand; wait for a request.
- [x] **`jj bookmark advance`** (Small) — `a` key in BookmarkModal. Forward-only move: jj refuses backwards/sideways (`Error: Refusing to advance bookmark backwards or sideways`), so no confirm gate — accidentally hitting `a` on the wrong bookmark is harmless. Same `can.move` gate as Enter. Enter = unconditional move (has `--allow-backwards`); `a` = safe-move. `revsets.bookmark-advance-from`/`-to` are user config, not our concern.
- [ ] **`--simplify-parents` on rebase** (Trivial) — Add to `Rebase()` builder signature, wire a checkbox in rebase mode. Useful when rebasing onto a descendant of the old parent.
- [x] **Template list methods** (Investigated — no change) — `first()`/`get(N)`/`take()` on lists. Every `.map()` in our templates is `.map(transform).join(sep)` over the full list (parents, bookmarks, files, predecessors). The new methods only help for subset/single-element access; we want all elements transformed. Irreducible.

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
- [x] **`jj restore` — discard file from revision** (Small) — File-header "Discard" button next to Edit. `jj restore -c <changeId> file:"<path>"` resets file to parent content. `DiffTarget` gains `.immutable` → `canMutateFiles` gates both Discard and Edit (bonus: Edit on immutable was loading content from rev X and writing to `@` — `fileWrite` has no rev param). Gated on `type !== 'R'` — restore on rename dest-path only deletes new path, source isn't restored → rename becomes delete. `editBusy` reused for busy/race-guard.
- [x] **Restore on renames — source-path plumbing** (Small) — `diff-parser.ts` now extracts `sourcePath` from `rename from <path>` git-diff headers. `DiffFile.sourcePath?` → `ondiscard(path, sourcePath?)` → `discardFile` passes `[sourcePath, path]` when present. `type !== 'R'` gate removed. Rename-with-edits never hits this path: jj decomposes it to separate A+D entries (git's similarity-based rename detection), which the single-path Discard already handles correctly.
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
- [x] ~~**Sequential bookmark loop in divergence resolution** — `for await` → `Promise.all`.~~ **Reverted**: concurrent jj mutations produce divergent op history. Serial loop is correct; N is tiny (0-3).
- [x] **Cmd+F diff search** — search bar with match counter, Enter/Shift+Enter navigation, `<mark>` highlights, auto-expand collapsed files.

### Remaining — Performance
- [x] **`wordDiffMap` is sync `$derived`** — `computeWordDiffs` (LCS) runs synchronously for every hunk on diff load. Fixed: progressive async computation per-file with `setTimeout(0)` yields between files. Single-file expand only recomputes that file.
- [x] **`hoveredLane` fans out to every GraphSvg** — fixed: removed lane-level hover entirely. Lane 0 spans the entire graph, so highlighting it was visually jarring. Graph elements no longer have hover state — row-level `.hovered` class (background highlight) is sufficient.
- [x] **Phantom `:hover` after layout shift** — error bar mount/unmount, batch-actions bar toggle, `scrollIntoView`, and post-rebase DOM reshuffle all slide `:hover` onto whatever row is now under a stationary mouse. j/k moves `.selected` but the gray hover stays pinned. A suppress-flag `$effect` was tried but is whack-a-mole (3 untracked triggers found in review, including parent state that isn't even a prop). Fixed by replacing CSS `:hover` with JS-tracked `hoveredIndex` driven by `mousemove` — which per UI Events spec fires ONLY on physical pointer movement, never on layout shift. Structurally impossible to phantom. Side win: 8 sibling-chain `:has()` rules → 1 class selector (all rows of a revision share `entryIndex`).
- [x] **Opportunistic prefetch during nav debounce** — `selectRevision` fires `prefetchRevision()` for the next revision in the navigation direction, **but only when current is cached** (instant main load → no network contention). Unconditional prefetch during rapid uncached j/k stacked 3N requests, exhausting Chrome's 6-connection-per-origin limit. Fire-and-forget with swallowed errors.
- [x] **`statusText` re-scans revisions on every loading flip** — `revisions.find(r => r.commit.is_working_copy)` was running linearly on every `loading`/`mutating`/`diffLoading` state change (4-6 scans per mutation cycle × 500 revisions). Extracted to `workingCopyEntry = $derived(...)` — now only re-scans when `revisions` actually changes.
- [x] **`aliases`/`remotes` uncached** — session-stable data re-fetched on every GitModal/BookmarkModal open. Now lazily cached (promise-memoized) in api.ts; reset only on `clearAllCaches()`. Error path clears the memo so retries work.
- [x] **Remove `codemirror` meta-package** — never imported directly. `pnpm remove codemirror` done. Note: `@codemirror/autocomplete` is still a transitive dep of `@codemirror/lang-*` packages, so bundle savings are modest. Full elimination requires switching to bare Lezer grammars.
- [x] **Auto-collapse on total line count** — `AUTO_COLLAPSE_TOTAL_LINES = 2000`. When sum across all files exceeds this, collapse ALL files initially. Catches the "many moderate files" case (20 × 100 lines) that per-file `AUTO_COLLAPSE_LINE_LIMIT` (500) misses. Collapsed files render header-only (`{#if !isCollapsed}` at DiffFileView.svelte gates all hunks) — 20 headers ≈ 60 DOM nodes vs 4000. Expand-all is one click; Cmd+F search already auto-expands matched files; `scrollToFile` already deletes from the collapsed set. No new components, ~8 lines.
- [ ] **No virtualization for mega-files** — manual expand of 5000-line file renders all lines. Auto-collapse at 500 + total-line collapse at 2000 mitigate; `@tanstack/virtual` on the per-hunk `{#each}` inside DiffFileView would be the full fix.
- [x] **Batch endpoint `/api/revision?revision=X`** — returns `{diff, files, description}` in one round-trip (5 jj commands run in parallel server-side). Frontend `api.revision()` **seeds the three individual cache keys** (`diff:X`, `files:X`, `desc:X`) so `api.diff()`/`files()`/`description()` become cache hits; zero component-level refactoring. The `diff` loader's fetch function calls batch first (opt-in via `batch=true` param — multi-revset `loadDiffForRevset()` bypasses it), then `files.load()`/`description.load()` fire microtask-fast. `prefetchRevision()` simplified from 3 fetches to 1. Race-safety preserved: the batch await is inside the loader's fetch, so the generation counter gates it.
- [x] **~~Mutable→immutable cache promotion~~ — OBSOLETE: cache is now keyed by `commit_id`** (content-addressed, self-invalidating). No more two-tier mutable/immutable split; no `responseCache.clear()` on op-id change. `jj new`/`abandon`/`undo` invalidate zero cache entries; rewrites only invalidate the rewritten commit + descendants (via new commit_ids).
- [x] **Synchronous cache read for nav cache hits** — `getCached(commitId)` reads the api.ts Map directly. `selectRevision` uses `loader.set()` in the same tick as `selectedIndex` — Svelte batches into one render, eliminating the one-frame stale-fileset flash that `setTimeout(0)` deferral caused. Cache misses still get 50ms debounce. Cache-hit branch also bumps `revGen` so a `loadDiffAndFiles` suspended at `await api.revision()` can't resume and call `diff.load(stale)` (which would bump `loader.generation` past the `set()` and win).
- [x] **`Cache-Control: immutable` on `/api/revision`** — browser disk cache survives page reload; in-memory cache doesn't. Frontend sends `?immutable=1` (only it knows the param is a commit_id not a change_id). `writeJSON` suppresses `X-JJ-Op-Id` when the header is set — a year-old op-id baked into disk cache would ping-pong `lastOpId` on reload and fire spurious `loadLog()`. Degraded responses (GetDescription soft-fail) skip the header so `description:""` isn't cached forever.
- [x] **Batch file-list preload** — `GET /api/files-batch?revisions=X,Y,Z` runs a single `jj log -T 'self.diff().stat().files()...'` template for N revisions in one subprocess. Returns `map[commitId]{conflict, files[]}` with status char, path, `lines_added`, `lines_removed` — everything the file sidebar needs. Conflicted commits are skipped from cache seeding (they need side-count detail the template doesn't expose). Frontend `prefetchFilesBatch()` seeds `files:${commitId}` cache keys; fired from `loadLog()` + during nav (re-centers window around `selectedIndex`, filters to uncached internally so repeated calls are cheap). Result: file sidebar shows instantly during j/k; only the heavy diff text fetches per-rev.
- [x] **`commands` $derived rebuilds ~~on every j/k~~ on check/uncheck** — Split into `staticCommands` (zero-dep `$derived.by` → computes once, thunk sidesteps TDZ for handlers below), `dynamicCommands` (5 reactive-label entries), `aliasCommands`. Space-spam now rebuilds 5 objects + one spread instead of 30+. (Original claim was wrong: j/k doesn't touch `checkedRevisions.size`, the actual trigger was Space.)
- [x] **Consolidate Shiki → Lezer for diff highlighting** — `highlightCode()` + `classHighlighter` from `@lezer/highlight`. Bundle: 414.67 → 279.33 KB gzip (**−135 KB, −32.6%**); raw JS 1,697 → 809 KB. Lezer parse+highlight is ~30× faster than Shiki (500 lines ≈ 9ms vs ~250ms) → no chunking/isStale/HIGHLIGHT_MAX_CHARS guards needed — `highlighter.ts` 155 → 77 lines. `classHighlighter` emits `tok-*` class names (not inline styles) → theme toggle is a pure CSS var swap → deleted `clearHighlightCache()` + `rehighlight()` + the `toggleTheme` wiring. Bash/TOML via `StreamLanguage.define()` wrapping `@codemirror/legacy-modes`. Svelte → HTML parser fallback (no `@lezer/svelte` exists; tags/attrs highlighted, `{interpolation}` plain).
- [x] **Sync compute in `createDiffDerivation.run()`** — `run()` now branches on `result instanceof Promise` like `update()` already did. Sync compute (Lezer `highlightFile`) + `immediateBudget: Infinity` (no budget-check yields) → fully synchronous loop, zero microtask suspensions. `highlightFile` dropped its `async` wrapper. Test `'sync compute + immediateBudget:Infinity → run() completes synchronously'` asserts `byFile` is populated before `run()` returns (no `await` needed). ~1-2ms saved per 20-file diff — noise, but the `await`-on-non-Promise was pointless overhead.

### Cache coherence (2026-03-06)

See [docs/CACHING.md](docs/CACHING.md) for the full inventory. Audit outcomes:

- [x] **`createRevisionNavigator()` factory + `revGen` race test** — diff/files/description loaders + the batch-fetch orchestration (incl. `revGen`) extracted to `revision-navigator.svelte.ts`. App.svelte 2047→2013 lines (−34). 8 new tests covering: `applyCacheHit` invalidates suspended `loadDiffAndFiles` (the core race — without `revGen`, the resumed call's `diff.load(stale)` would bump `loader.generation` past any intervening `set()` and win), second-load-invalidates-first, `cancel()` bails in-flight, `shouldAbort` re-checked post-await (user-checked-during-fetch guard), happy-path, batch-failure → single error toast, sync `applyCacheHit`, `singleTarget` divergent fallback. The `shouldAbort` injection keeps `checkedRevisions` dependency out of the factory. This is a narrower slice than full `createRepoView()` (see Multi-tab follow-ups) — `selectedIndex`/debounce/evolog still in App.svelte — but it's the race-critical piece, now under test.
- [x] **Audit complete.** Already tested: batch-vs-individual shape coherence (`'seeded keys are hit by subsequent individual api calls'`), `prefetchFilesBatch` conflict-skip (`'skips seeding conflicted revisions'`). Added: `DERIVED_CACHE_SIZE ≤ MAX_CACHE_SIZE` module-init assert (throws on first import if inverted), `COLLAPSE_CACHE_SIZE` constant, `.toSorted()` in `multiRevset` (order-agnostic cache keys).

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
- [x] **RevisionGraph virtualization** — `@tanstack/svelte-virtual` with `estimateSize: () => 18` (fixed row height → simplest case, no dynamic measurement). Threshold `VIRTUALIZE_THRESHOLD = 150` flatLines (~50 commits); below that, eager full-render (jsdom tests unchanged). Above: `.revision-list` gets `position:relative` + `height:{totalSize}px`, each virtual item is `.virtual-row` with `transform:translateY({item.start})`. Row template extracted to `{#snippet graphRow(line)}` shared by both paths. `FlatLine.eid` precomputed — snippet no longer re-calls `effectiveId()` 4× per row. `scrollIntoView` → `scrollToIndex` via `findIndex` (entryIndex → node-row flatLines index; cheaper than a `$derived` Map built unconditionally). `listEl` binding dropped — `scrollEl?.querySelector()` reaches the same nodes. **Self-loop:** setOptions→measure→notify→writable.set → store emits → effect re-runs. Whole body wrapped in `untrack()` (not just the `$virtualizer` read — setOptions internally calls `getScrollElement()` which reads `scrollEl`, also a tracked $state). **Shrink-above-threshold crash:** template renders BEFORE the setOptions $effect (post-effect in Svelte 5), so virtual items hold OLD count while flatLines is shorter → `flatLines[item.index]` undefined. `{#if line}` guard + `?.key` fallback skips stale items for one frame; next tick setOptions corrects. All 39 existing tests pass + 3 new (threshold branch, totalSize, shrink-no-crash). Bundle: +5.9 KB gzip.
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
- [x] List virtualization for large repos — done, see Remaining-Performance above
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
- [x] **SSH inotify pipe for auto-refresh** (Small) — `NewSSHWatcher(srv, openFn)` in `watcher.go` consumes a line-oriented event stream; `main.go` supplies a closure piping `inotifywait -m -q -e create <heads>` via new `SSHRunner.StreamRaw()` (wraps `cd && argv` → `local.Stream`). `sshWatchLoop`: `bufio.Scanner` over the pipe, any line → debounce + `broadcast(refreshOpId())`. Reconnect with 1s→30s backoff on SSH drop; first-attempt-zero-lines → log `inotify-tools not installed?` and give up (no reconnect spam). One lifetime context tied to `w.stop` → `exec.CommandContext` kills remote ssh on Close(). Snapshot loop stays local-only. Remote dep: `inotify-tools` (Linux). ~80 lines.
- [x] **SSH jj command latency — port-forward as headline recommendation** — README.md "Remote repos" section leads with port-forward (`ssh -L 3001:localhost:3001 host "lightjj -R /path --addr localhost:3001 --no-browser"`) as **Recommended**, with `--remote` + ControlMaster noted as fallback. Zero code changes, 10× latency win, fsnotify works natively.
- [ ] **SSH stdin/stdout multiplexing protocol** (Complex, deferred) — one persistent SSH session, commands + responses over a framed protocol. Only worth it if port-forward isn't an option (firewall/policy). `--remote` mode stays viable for quick-peek; heavy use → port-forward.
- [ ] SSH remote repo browser
- [x] Live file watching (auto-refresh on working copy changes) — fsnotify on `.jj/repo/op_heads/heads/` + periodic `jj debug snapshot` → SSE push. See Agent Workflow section.
- [x] Git push/fetch with progress indication — `streamMutation` NDJSON → `streamPost` → `mutationProgress` in status bar. See commit `c2261066`.
- [x] Diff syntax highlighting — Lezer `highlightCode` + `classHighlighter` → `tok-*` CSS classes
- [x] Context expansion at hunk boundaries — "Show N hidden lines" buttons between hunks, click to expand full file context
- [x] Parse user aliases from jj config and expose them dynamically in the UI — `aliasCommands` in App.svelte, `api.aliases()` promise-memoized
- [ ] Search across revisions
- [x] Themes (light/dark) — Catppuccin Mocha (dark) + Latte (light), toggle via Cmd+K, persisted in localStorage
- [x] Syntax highlighting deadline — short-term chunking implemented. `highlightLines()` tokenizes at `HIGHLIGHT_CHUNK_LINES = 30` with `setTimeout(0)` yields + `isStale()` callback threaded down from `highlights.run()` → `highlightFile()` → per-chunk abort. Max block time ~15-30ms. Also `HIGHLIGHT_MAX_CHARS = 20_000` guards against single minified-bundle lines (line-count chunking doesn't help when one line is 50KB). Long-term Web Worker migration still open — `worker.terminate()` would be a true cancel primitive and delete the chunking hacks.
- [x] ~~Lazy rendering for large diffs (IntersectionObserver)~~ — superseded by `AUTO_COLLAPSE_TOTAL_LINES`. Collapsed files render header-only; the existing `{#if !isCollapsed}` gate does what lazy-mount would. IntersectionObserver would save the header DOM too, but headers are ~3 nodes each — not worth the complexity.
- [x] Draggable split view divider (resize ratio)
- [x] Support jj worktrees — detect and display workspace info via `working_copies` template field, workspace badges (teal) in graph, `GET /api/workspaces` endpoint
- [x] Workspace switching — v0.6.0's workspace-as-tab covers "switch serving context" (dropdown → `onOpenTab(ws.path)`). ~~"Move another workspace's working copy head" (`jj edit --workspace NAME`)~~ → not a thing in jj; `jj workspace update-stale` runs IN the target workspace. Opening that workspace as a tab and pressing `E` does it.
- [x] `jj split` support — inline file-level split from the UI, checked files stay, unchecked move to new revision, parallel toggle
- [x] Divergent commit resolution UI — `GET /api/divergence` + `classify()` (stack grouping via parent-change_id walk + `alignColumns` commit_id permutation, `alignable` bailout, tautology-guarded `liveVersion`). Panel renders columns (one per /N version, rows = stack levels). `KeepPlan` abandons losing columns + empty descendants, repoints bookmarks per-change_id (not tip). Non-empty descendants confirm. Cross-column-merge warning. `/N` = index emission order (NOT commit_id sort — that was the old bug). See docs/jj-divergence.md.
- [x] Divergence: "Rebase onto keeper" in non-empty-descendant confirm — third button (green, leftmost). `rebaseSources` runs before abandon. Safe from `-s` flattening: `g.descendants` is roots-only by classifier construction. See commit `e4160a26`.
- [x] Bookmark → GitHub PR linking — `GET /api/pull-requests` shells `gh pr list`, `prByBookmark` map in App.svelte, bookmark badges linked to PRs with `#number` suffix. Draft PRs dimmed.
- [x] Cmd+F diff search — intercept `Cmd+F` / `Ctrl+F` in the diff panel, search bar with match counter, Enter/Shift+Enter navigation, `<mark>` highlights, auto-expand collapsed files. Case-insensitive, 2-char minimum. Future: case toggle, regex.

## State Synchronization

**Implemented: Op-ID header + fsnotify SSE.** Every API response includes `X-JJ-Op-Id`; `api.ts` tracks it and fires `onStale()` callbacks on change. Local mode: `fsnotify` on `.jj/repo/op_heads/heads/` pushes events via SSE (`GET /api/events`) — instant refresh on any mutation including CLI use in another terminal. Periodic `jj debug snapshot` (5s, only when SSE subscribers exist) catches raw file edits. SSH mode: SSE returns 204, falls back to op-id header only — see [SSH inotify pipe](#p3--advanced) for the remote-watcher plan.

**Remaining:**

- ~~**Snapshot on `visibilitychange`**~~ — done. `POST /api/snapshot` (runMutation + DebugSnapshot) + `visibilitychange` listener in `watchEvents()`. If WC unchanged, op-id doesn't advance → `notifyOpId` dedup → zero work. Works in SSH mode too (header carries the refresh even without SSE).

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