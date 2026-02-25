# lightjj Backlog

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
- [ ] Response cache clears entirely on any op-id change; immutable commits' diffs should be preserved.
- [ ] `wordDiffMap` recomputes all hunks when a single file is expanded.
- [x] `MaxBytesReader` called with `nil` ResponseWriter — violates Go API contract.
- [x] `ParseGraphLog` returns nil instead of empty slice — produces JSON `null` not `[]`.
- [x] Modal fetch errors silently swallowed (GitModal, BookmarkModal).
- [ ] `"origin"` hardcoded as preferred remote — no way to configure.
- [x] MockRunner `RunWithInput` silently discards stdin — can't verify describe content.

### Suggestions
- [ ] `App.svelte` is 1010 lines — rebase/squash/split state is ambient and threaded through multiple components. Extract to shared module.
- [x] Rename `squashMode` → `fileSelectionMode` in DiffPanel props — partially done; App.svelte still uses `squashMode` internally.
- [ ] Rename `squashSelectedFiles`/`squashTotalFiles`/`toggleSquashFile` to generic names in App.svelte — now shared by squash and split modes.
- [ ] Rename CSS classes `rebase-badge`/`rebase-source`/`rebase-target` to generic `mode-badge-inline`/`badge-source`/`badge-target` — shared across rebase, squash, split.
- [ ] Squash mode StatusBar file count should say "N/M files to move" (not just "N/M files") for parity with split's "N/M files stay".
- [ ] Add bulk select/deselect toggle for file checkboxes (applies to squash + split modes).
- [ ] No list virtualization for large repos (500+ commits).
- [ ] No HTTP response compression (especially impacts SSH mode).
- [ ] `highlightDiff` re-highlights all files when one is expanded.
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
- [ ] Divergent commit `??` suffix is a string hack — a `Divergent bool` field would be cleaner.
- [x] `GET /api/oplog` has no upper bound on `limit` parameter.
- [x] No `Content-Type: application/json` validation on POST requests.
- [x] `commitsFromIds` wraps raw strings in fake `Commit` structs with zero-valued fields.

### Remaining Items by Effort

**Quick wins (< 30 min):**
- [x] `Content-Type: application/json` validation on POST requests — also serves as CSRF defense-in-depth
- [x] `commitsFromIds` → `jj.FromIDs(ids)` on SelectedRevisions

**Medium effort (1-2 hours):**
- [ ] Immutable commit cache preservation — don't clear cached diffs for `◆` commits on op-id change
- [ ] `wordDiffMap` per-file computation — move to component-local `$derived` in `DiffFileView`
- [ ] `highlightDiff` partial re-highlight — only re-tokenize the expanded file, merge into existing highlights
- [ ] `"origin"` hardcoded as preferred remote — make configurable via startup flag or jj config query
- [ ] `OplogPanel` inline error display — pass error prop, match GitModal/BookmarkModal pattern

**Larger refactors (half day+):**
- [ ] `App.svelte` rebase state extraction — move rebase mode, source/target types, keyboard handling into shared module
- [ ] List virtualization for large repos — `@tanstack/virtual` for 500+ commit histories
- [ ] HTTP response compression (gzip middleware) — mainly benefits SSH mode
- [x] Integration tests — build-tagged tests against a real jj repo
- [ ] Frontend DOM integration tests (in progress)
- [ ] `Divergent bool` field — replace `??` string suffix hack on `ChangeId`

## Test Gaps — Medium/Low Priority (2026-02-24)

Remaining test coverage gaps identified during the Round 2 test audit. These are pattern inconsistencies or edge cases, not missing critical logic.

### Runner error tests (13 handlers)
Unit tests verifying 500 response when runner returns an error. Already covered for `handleNew`, `handleAbandon`, `handleDescribe`, `handleRebase`, `handleGitPush`, `handleCommit`, `handleWorkspaces`. Missing for:
- [ ] `handleBookmarks`
- [ ] `handleDiff`
- [ ] `handleStatus`
- [ ] `handleGetDescription`
- [ ] `handleRemotes`
- [ ] `handleUndo`
- [ ] `handleOpLog`
- [ ] `handleEvolog`
- [ ] `handleBookmarkSet`
- [ ] `handleBookmarkDelete`
- [ ] `handleBookmarkMove`
- [ ] `handleBookmarkForget`
- [ ] `handleBookmarkTrack`

### Edge case tests
- [ ] `decodeBody` with body exceeding 1MB `MaxBytesReader` limit
- [ ] `ParseBookmarkListOutput` with `conflict=true` or `backwards=true`
- [ ] `ParseDiffStat` with binary files
- [ ] `LogGraph` / `Status` / `FileShow` command builder direct tests
- [ ] HTTP 405 for wrong method
- [ ] `ParseGraphLog("")` empty input

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
- **Working copy `@` indicator**: prominent, green-colored
- **Conflict markers**: `×` symbol, red-colored for conflicting revisions
- **Multi-select**: check multiple revisions for batch operations
- **Preview panel**: diff preview without leaving the revision list
- **Command palette**: fuzzy-search all available actions

### Antique (internal code review)
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
- [x] Evolog viewer

### P3 — Advanced
- [x] Retain collapse/expand state per revision (cached per change-id, restored on revisit)
- [x] Show total diff stats (aggregate +N -N across all files) in the file list header
- [ ] Branch/remote sidebar (like Sublime Merge left panel)
- [ ] Drag-and-drop rebase (drag revision onto destination)
- [x] Inline rebase mode (keyboard-driven, not a modal)
- [x] Squash support (file-level selection, keep-emptied, use-dest-message)
- [x] Split support (inline mode, file checkboxes, parallel toggle)
- [x] Conflict resolution UI (basic) — detect `×` conflicting revisions, parse jj's conflict markers (`<<<<<<<`, `%%%%%%%`, `+++++++`, `>>>>>>>`), render inline with color-coded cards (peach for diff side, mauve for snapshot side), "Accept Ours" / "Accept Theirs" buttons per file. `jj resolve --list` for conflict detection, `jj file show` for conflict-only files not in diff output.
- [ ] Three-way merge editor — replace inline conflict markers with a CodeMirror `@codemirror/merge` three-way view (base | ours | theirs). Phase 1: add backend endpoint returning `{base, ours, theirs}` per conflicted file (via `jj file show` on parent revisions). Phase 2: read-only three-pane view with diff highlighting + existing Accept Ours/Theirs buttons. Phase 3: editable center pane with "Save Resolution" that writes merged content back. Current inline card view remains as fallback for N-way conflicts (3+ sides). See [CodeMirror merge demo](https://codemirror.net/3/demo/merge.html) for the UX pattern.
- [ ] SSH remote mode performance — each jj command spawns a new SSH connection (~440ms via Coder ProxyCommand). Options: (a) batch endpoint combining diff+files+evolog into one SSH call, (b) persistent SSH session with stdin/stdout multiplexing, (c) run backend on remote with SSH port-forward (`ssh -L 3001:localhost:3001 host "lightjj -R /path"`). Option (c) sidesteps the problem entirely.
- [ ] SSH remote repo browser
- [ ] Live file watching (auto-refresh on working copy changes)
- [ ] Git push/fetch with progress indication
- [x] Diff syntax highlighting (language-aware, Shiki like antique)
- [x] Context expansion at hunk boundaries — "Show N hidden lines" buttons between hunks, click to expand full file context
- [ ] Parse user aliases from jj config and expose them dynamically in the UI (command palette, context menu)
- [ ] Search across revisions
- [x] Themes (light/dark) — Catppuccin Mocha (dark) + Latte (light), toggle via Cmd+K, persisted in localStorage
- [ ] Syntax highlighting deadline / Web Worker — `codeToHtml` is synchronous and can freeze the UI for seconds on pathological files (e.g., 200-line CSS). Short-term: chunk input into ~30-line batches with yields between. Long-term: move Shiki into a Web Worker so `worker.terminate()` acts as a true cancellation primitive.
- [ ] Lazy rendering for large diffs (IntersectionObserver, like antique)
- [ ] Draggable split view divider (resize ratio)
- [x] Support jj worktrees — detect and display workspace info via `working_copies` template field, workspace badges (teal) in graph, `GET /api/workspaces` endpoint
- [ ] Workspace switching — click a workspace badge to switch the app's serving context to that workspace, or move a workspace's working copy head to a different revision (`jj workspace update-stale`, `jj edit` from another workspace)
- [x] `jj split` support — inline file-level split from the UI, checked files stay, unchecked move to new revision, parallel toggle

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

Future: migrate to SVG-based rendering (option 1) for colored lanes, hover interactions, and smooth curves at merge/fork points.

1. **SVG-based**: Each lane is a vertical path, merge/fork points are curves. Interactive (hover, click). This is what Sublime Merge does.
2. **Canvas**: Better performance for large repos but harder to make interactive.
3. **HTML/CSS grid**: Each cell in the graph is a div with borders. Simple but limited.
4. **Use jj's graph output**: ✅ Implemented. Parse `jj log` with graph characters and render them as styled HTML.
