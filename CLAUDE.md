# lightjj

Browser-based UI for Jujutsu (jj) version control. See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for system design, [BACKLOG.md](BACKLOG.md) for planned features.

## Build & Test

```bash
go test ./...                                        # Go tests
go vet ./...                                         # static analysis
cd frontend && pnpm install && pnpm run build        # build frontend
go build ./cmd/lightjj                               # build binary (needs frontend build first)

# Dev mode: two terminals
# 1: go run ./cmd/lightjj --addr localhost:3000 --no-browser
# 2: cd frontend && pnpm run dev
# Vite proxies /api/* to localhost:3000
```

## Project Structure

```
cmd/lightjj/main.go       — CLI entry point, flag parsing, embeds frontend-dist/
internal/
  jj/                     — Command builders + data models (PURE — no I/O, no side effects)
    commands.go            — Functions that return []string args for jj subcommands
    commands_test.go       — Command builder tests
    commit.go              — Commit model with ChangePrefix/CommitPrefix, Immutable, Divergent, WorkingCopies
    commit_test.go         — Commit model tests
    bookmark.go            — Bookmark model + output parsers; ParseBookmarkListOutput/ParseRemoteListOutput take defaultRemote param for sort order
    bookmark_test.go       — Bookmark parser tests
    alias.go               — jj config alias parser
    file_change.go         — FileChange model, FilesTemplate (single-call file stats + conflict info), ParseFilesTemplate
    divergence.go          — DivergenceEntry, Divergence() template builder, ParseDivergence. committer_ts DELIBERATELY absent (structurally inverted for --at-op). splitNonEmpty helper.
    selected_revisions.go  — Multi-revision selection helper
    workspace_store.go     — Protobuf parser for .jj/repo/workspace_store/index (name→path map)
    workspace_store_test.go — Parser tests with real binary data
  runner/                  — CommandRunner interface + implementations
    runner.go              — Interface definition (Run, RunWithInput, Stream)
    local.go               — LocalRunner: exec("jj", args) with configurable Binary
    ssh.go                 — SSHRunner: wraps jj args in ssh command
    ssh_test.go            — SSH arg escaping tests
  api/                     — HTTP handlers
    server.go              — Route registration, runMutation, op-id caching, workspace store reader, helpers
    handlers.go            — All endpoint implementations, flag validation
    handlers_test.go       — Handler tests with MockRunner
    integration_test.go    — Integration tests (build-tagged)
    watcher.go             — fsnotify on .jj/repo/op_heads/heads/ + SSE push, periodic util snapshot
    config.go              — Server-side config storage (os.UserConfigDir()/lightjj/config.json)
    annotations.go         — CRUD for per-changeId review comments (annotations/{changeId}.json); changeId path-traversal validation via regex
    gzip.go                — Gzip response middleware (lazy-init writer, sync.Pool, Flush passthrough for SSE)
  parser/                  — Graph log parser
    graph.go               — Parses jj log graph output with _PREFIX: markers into GraphRow[]
    graph_test.go          — Graph parser tests
testutil/                  — Test infrastructure
  mock_runner.go           — MockRunner with Expect(args)/Verify() pattern
frontend/                  — Svelte 5 SPA (Vite + TypeScript + pnpm)
  src/App.svelte           — Main app shell: layout, keyboard handling, state management. `handleKeydown` is a 12-line gate dispatcher (globalOverrides → inlineCommit → isInInput → modifier → modal → inlineNav → escape → global → logView); gate ORDER is load-bearing (Cmd+K before isInInput = works in text fields; inlineNav swallows everything = normal-mode keys don't leak into modes). Cmd+K uses `closeModals()` not `closeAllModals()` — palette opens without cancelling inline modes.
  src/lib/
    api.ts                 — Typed API client, op-id tracking, commit_id-keyed LRU cache, SSE auto-refresh
    api.test.ts            — API client tests
    RevisionGraph.svelte   — Revision list with graph gutter rendering; JS-tracked hoveredIndex (mousemove-driven, not :hover). Virtualized via @tanstack/svelte-virtual above VIRTUALIZE_THRESHOLD=150 flatLines (~50 commits). Fixed 18px rows → estimateSize:()=>18. Row template is a {#snippet} shared by virtual/eager paths. untrack($virtualizer) in update-effects prevents setOptions→notify→store-emit self-loop.
    GraphSvg.svelte        — SVG renderer for graph gutter characters (pipes, curves, node dots)
    DiffPanel.svelte       — Diff viewer: unified/split toggle, syntax highlighting, edit-state management. Reset effect (activeRevisionId change) clears edit/search/expanded state + saves/restores collapseStateCache (change_id-keyed). startEdit/discardFile guard against navigation-during-await by comparing captured changeId vs LIVE diffTarget prop.
    diff-cache.ts          — App-lifetime caches: derivedCache (highlight+word-diff, commit_id-keyed), parsedDiffCache (diff-text-keyed for ref-identity on revisit), collapseStateCache (change_id-keyed). Previously DiffPanel `<script module>`; hoisted so clearDiffCaches() is callable from hard-refresh. NOT wired into clearAllCaches() (would create api.ts ↔ diff-cache cycle); App calls both.
    FileSelectionPanel.svelte — Squash/split/review file checkbox panel. j/k/Space/a/n keys, auto-focus on mount. Mounted via `{#if fileSelectionMode}` so mount = mode entry.
    RevisionHeader.svelte  — Header slot rendered by DiffPanel via `{@render header()}`: change_id, description expand, bookmark/PR badges, Describe/Divergence buttons, DescriptionEditor
    DiffFileView.svelte    — Individual file diff with collapsible sections, context expansion, conflict A/B badges
    FileEditor.svelte      — CodeMirror 6 wrapper for inline editing (split-view right column)
    DescriptionEditor.svelte — Inline commit message editor
    CommandPalette.svelte  — Fuzzy-search command palette (Cmd+K)
    ContextMenu.svelte     — Reusable right-click context menu (positioned at cursor)
    StatusBar.svelte       — Bottom status bar with mode indicators and shortcuts
    BookmarkModal.svelte   — Bookmark modal: noun-first list, Enter=move, a=advance (forward-only, jj refuses backwards — no confirm), d/f/t action keys with double-press confirm (via confirm-gate). Modal (not input) holds focus on open — `tick().then(() => modalEl?.focus())` since `{#if open}` hasn't mounted when `$effect` fires.
    BookmarksPanel.svelte  — Branches view (activeView='branches'): flat list sorted trouble-first (conflict→diverged→ahead→…→synced). Sync dot + PR badge + sync label + commit description + age. handleKeydown EXPORTED — App delegates via bind:this so panel owns d/f/t/r regardless of DOM focus (toolbar click → focus drift would otherwise make t=toggleTheme). Selection tracked by name across reloads (untrack on index reads to prevent j/k self-restore).
    bookmark-sync.ts       — classifyBookmark() → 7 sync states, syncPriority() trouble-first sort, fmtCount() compact formatting (7.4k, 131k)
    confirm-gate.svelte.ts — createConfirmGate<K>() double-press factory: first press arms, second of SAME key fires, any other key disarms. No timeout — nav disarms naturally. Shared by BookmarkModal + BookmarksPanel.
    BookmarkInput.svelte   — Bookmark name input with autocomplete
    GitModal.svelte        — Git push/fetch modal
    EvologPanel.svelte     — Evolution log: entry list with inline diffs (server emits rebase-safe inter_diff per entry), ArrowUp/Down navigation
    OplogPanel.svelte      — Operation log panel
    DivergencePanel.svelte — Stack-aware divergence resolution. classify() → columns (one per /N version, rows = stack levels). KeepPlan computed here, executed in App.svelte. {#key changeId} in parent enforces single-mount-per-changeId.
    divergence.ts          — classify(): stack grouping (parent-change_id walk + alignColumns commit_id permutation), kind (same/diff/compound), liveVersion with jj-edit tautology guard, descendants, conflicted bookmarks. refineRebaseKind() fileUnion subtraction. See docs/jj-divergence.md.
    diff-parser.ts         — Unified diff parser
    conflict-parser.ts     — jj conflict marker parser; diff-side labels use \\\\\\\ "to:" value (what :ours keeps), not %%%%%%% "from:"
    split-view.ts          — Side-by-side diff alignment
    word-diff.ts           — Word-level inline diff computation
    highlighter.ts         — Lezer highlightCode → tok-* spans. Sync, theme-independent (class names not inline styles)
    fuzzy.ts               — Fuzzy string matching
    group-by.ts            — groupByWithIndex utility for per-file match scoping
    loader.svelte.ts       — createLoader() async factory with generation counter
    revision-navigator.svelte.ts — createRevisionNavigator(): diff/files/description loaders + revGen batch-fetch orchestration. shouldAbort callback re-checked post-await (e.g. checkedRevisions.size > 0)
    diff-derivation.svelte.ts — createDiffDerivation() factory for per-file progressive computation (highlights, word-diff)
    modes.svelte.ts        — Rebase/squash/split mode state factories. SplitMode.review distinguishes 'v' (review: accepted/rejected labels) from 's' (split: stays/moves labels) — same jj split underneath
    config.svelte.ts       — Reactive config singleton — primary storage os.UserConfigDir()/lightjj/config.json, localStorage as write-through cache
    recent-actions.svelte.ts — localStorage-backed frequency counter for bookmarks
    annotations.svelte.ts   — Per-line review comment store for agent workflows. createAnnotationStore() + reanchor() + exportMarkdown/JSON. Server-side storage via /api/annotations (workspace tabs share). Re-anchor via diffRange delta + ±5 content scan.
    AnnotationBubble.svelte — Annotation create/edit popup (severity select + textarea)
    WelcomeModal.svelte    — "What's new" modal shown on version bump; content from tutorial-content.ts
    tutorial-content.ts    — Feature announcements keyed by version
    version.ts             — APP_VERSION constant (bump to show WelcomeModal)
  vite.config.ts           — Dev proxy + build output to ../cmd/lightjj/frontend-dist/
```

## Code Conventions

### Go backend

- **Command builders are pure functions.** `internal/jj/commands.go` takes parameters, returns `[]string`. No execution, no config reads, no globals. If you need a new jj command, add a function here.
- **Never call `exec.Command` outside of `internal/runner/`.** All jj execution goes through the `CommandRunner` interface. Non-jj sidecar tools (`gh`) go through `Runner.RunRaw(argv)` — this is what makes them work in SSH mode (they run on the remote host, not locally).
- **Test with MockRunner.** Use `testutil.NewMockRunner(t)` with `.Expect(args).SetOutput(output)` and `defer runner.Verify()`. See existing tests for the pattern. Also supports `SetExpectedStdin()`, `SetError()`, and `Allow()` for flexible matching.
- **API handlers are thin.** Parse request → call command builder → call runner → return JSON. No business logic in handlers.
- **Mutation handlers use `runMutation()`.** Centralizes run + async op-id refresh. Exception: `handleDescribe` uses `RunWithInput` directly.
- **Validate POST inputs.** All POST handlers check required fields and return 400 on empty values.
- **Validate flags.** `validateFlags()` whitelists allowed `--` and `-` flags for git push/fetch. Reject anything not in the allowed set.
- **Rebase API accepts `source_mode` and `target_mode` params.** `source_mode` maps to `-r`/`-s`/`-b`; `target_mode` maps to `-d`/`--insert-after`/`--insert-before`.
- **Use `--tool :git`** when requesting diff output for the web API. Users may have external diff formatters (difftastic) configured that output ANSI codes.
- **Use `--color never`** for any jj output the backend will parse. Use `--color always` only if passing through to a terminal.
- **Use `\x1F` (unit separator)** as the field delimiter in jj templates, not tabs. Tabs can appear in commit descriptions and break parsing.
- **Use `root-file:"path"` (via `EscapeFileName`) for file arguments**, never `file:`. `file:` is cwd-relative — it breaks in secondary workspaces (divergent rev authored in A, viewed from B) and in SSH mode (`wrapArgs` uses `-R`, no cd → remote cwd is `~`). `root-file:` anchors at the workspace root. Not `root:` — that's prefix-recursive; `root:"a"` would match `a/` too.
- **Use `--ignore-working-copy` on read commands** (`log`, `file show`, `workspace list`). The snapshot loop (`watcher.go`) runs `jj util snapshot` every 5s — read-path snapshots are redundant (~485ms/call wasted) and contend on the WC lock. Do NOT use on mutations or anything that needs the freshest WC state.
- **Prefer templates over human-output parsing.** Check `jj help -k templates` before writing regex/string parsers. `FilesTemplate` uses `self.diff().stat().files()` + `conflicted_files.map()` — one subprocess returns status char, path, exact +/- counts, and conflict side-counts. `DiffStatEntry.path()` returns the DESTINATION path for renames (no brace expansion needed). Exits 0 on clean revisions, works with multi-revision revsets, no regex.
- **Parsers return empty slices, not nil.** This ensures JSON serialization produces `[]` not `null`.
- **`NewServer(runner, repoDir)`** takes the resolved repo dir as second arg. Pass `""` for SSH mode or tests. The `RepoDir` enables workspace store reading. `Server.DefaultRemote` defaults to `"origin"` in the constructor body; `main.go` overrides post-construction from the `--default-remote` flag (zero test churn across existing call sites).
- **Workspace store parser** (`internal/jj/workspace_store.go`) manually parses protobuf wire format — no protobuf dependency. The `.jj/repo/workspace_store/index` file has a simple schema: `repeated Entry { string name = 1; string path = 2; }`.
- **Tabs via `TabResolve`+`TabFactory` injection.** `handleCreate` is mode-agnostic — the injected `resolve` closure does validation + canonicalization (local `~` expansion + `jj workspace root`, or SSH `quoteRemotePath` round trip). Workspaces open as tabs too: the dropdown calls `onOpenTab(ws.path)` → `POST /tabs`. Same-repo workspaces share commit_ids → cross-tab diff-cache hits are free.

### Svelte frontend

- **Svelte 5 runes** — use `$state()`, `$derived()`, `$effect()`. No Svelte 4 stores.
- **api.ts is the single API boundary** — all backend calls go through the `api` object in `src/lib/api.ts`. Don't use raw `fetch()` in components.
- **Cache by `commit_id`, not `change_id`.** Per-revision data (diff, files, description) is keyed by `commit_id` — a content hash of tree + parents + message. If the commit_id hasn't changed, the cached data is provably valid. No op-id suffix, no clear-on-mutation. `jj new` / `jj abandon` (leaf) / `jj undo` leave existing commit_ids unchanged → **zero** cache invalidation. Only rewrites (describe, rebase, squash) change commit_ids, and then only for the rewritten commit and its descendants. Pass `commit.commit_id` to `api.diff()`/`files()`/`description()`/`revision()`; use `effectiveId()` (change_id) only for mutations and UI-state that should survive rewrites.
- **pnpm, not npm** — the project uses pnpm for package management.
- **Graph rendering uses flattened lines.** Each graph line (node or connector) is its own DOM row at identical height. Node lines show commit content; description lines show the description; connector lines are just gutter characters. This ensures pixel-perfect continuous graph pipes. **Graph rows use a fixed `height: 18px`** to guarantee identical sizing across all modes (normal, rebase, squash, split). This prevents inline badges, buttons, or text from influencing row height. All inline elements (badges, `@` indicator, action buttons) must fit within 18px. Content is clipped by `overflow: hidden`. Never change this to `min-height` or remove the fixed height — it's the only way to prevent sub-pixel height differences between modes that break graph pipe continuity.
- **Change IDs show full short form with highlighted prefix.** `commit.change_prefix` determines how many characters to highlight. Same for `commit_prefix`.
- **Rebase mode is inline, not a modal.** Press `R` to enter rebase mode. `j`/`k` navigate the destination; Enter executes; Escape cancels. Source mode (`r`/`s`/`b`) and target mode (`o`/`a`/`i`) can be switched while in rebase mode. Source and destination commits are marked with inline badges directly in the revision graph.
- **Immutable commits** (`◆` in jj graph output) are dimmed in the UI. Mutable `○` nodes use graph palette colors; working-copy `@` is an amber concentric circle. Graph colors come from `--graph-N` CSS vars (Tier 3: muted, decorative) at static opacity (lines 0.45, nodes 0.8) — lane-level hover was removed (lane 0 spans the whole graph so highlighting was visually jarring). Row-level `.hovered` class provides the only hover feedback.
- **View mode toggle** — The revision panel header has a Log/Tracked toggle (click or command palette). Tracked view uses the `tracked_remote_bookmarks()` revset to show remote work. `t` key toggles theme.
- **Divergent commit handling** — Commits with `divergent: true` share the same `change_id`. Use `effectiveId(commit)` (from `api.ts`) for all identity operations — falls back to `commit_id` for divergent/hidden. DivergencePanel fetches `GET /api/divergence` (revset `(divergent() & mutable())::`) → `classify()` groups into stacks. **`/N` offsets = jj's index-insertion order** (`GlobalCommitPosition` per `lib/src/index.rs:217`), NOT commit_id sort, NOT committer_ts — both would mislabel. Preserve emission order. `is_working_copy` field is the tautology guard: `wc_reachable` alone inverts when the user `jj edit`s into a divergent commit to inspect it. `alignable: false` when columns can't be bijectively mapped parent↔child — panel disables Keep (buildPlan would abandon wrong commits). See docs/jj-divergence.md.
- **`DiffTarget` discriminated union** (`api.ts`) — `{kind:'single', commitId, changeId} | {kind:'multi', revset, commitIds[]}`. Replaces the stringly-typed `activeRevisionId` that was sometimes a commit_id and sometimes a `connected(X|Y)` revset. `diffTargetKey()` returns a stable string for cache-key equality (the `$derived` object is new every recompute). Operations that only make sense on a single revision (`api.fileShow`, `startEdit`, copy-reference attribution) gate on `diffTarget?.kind === 'single'`. `api.diff`/`expandFile` are NOT gated — `jj diff -r 'connected(a|b)' --context=N` is valid.
- **Diff line context menu** — Right-click selected diff lines → single "Copy reference" action with `path:line-range @ changeId` + content. `DiffFileView` detects native text selection via `window.getSelection()` + `Range.intersectsNode()`, collects line numbers from `.line-num` spans and text from `.diff-line` elements. Exports `DiffLineInfo` interface (`{ filePath, lines[] }`) reusable for future inline annotations. `DiffPanel` formats the reference with `diffTarget.changeId` (single mode) or omits the `@ changeId` suffix (multi mode — the line could be from any commit in the revset).
- **Top toolbar (no sidebar)** — Navigation, workspace selector, search trigger, and action buttons live in a compact top toolbar in `App.svelte`. Nav tabs (`◉ Revisions`, `⑂ Branches`, `⟲ Operations`) switch views; keyboard shortcuts `1`/`2`/`3` still work. Workspace selector uses `◇` glyph with dropdown for multi-workspace repos (`w` key toggles). `GET /api/workspaces` returns `{ current, workspaces[] }` (enriched with paths from workspace store — local fs read or SSH `cat` via RunRaw). Selecting a workspace opens it as a tab via `onOpenTab(ws.path)` → `POST /tabs`.

### Testing patterns

```go
// Command builder test — pure input/output
func TestRebase(t *testing.T) {
    from := jj.NewSelectedRevisions(&jj.Commit{ChangeId: "abc"})
    got := jj.Rebase(from, "def", "-r", "-d", false, false)
    assert.Equal(t, []string{"rebase", "-r", "abc", "-d", "def"}, got)
}

// API handler test — mock runner + httptest
func TestHandleAbandon(t *testing.T) {
    runner := testutil.NewMockRunner(t)
    revs := jj.NewSelectedRevisions(&jj.Commit{ChangeId: "abc"})
    runner.Expect(jj.Abandon(revs, false)).SetOutput([]byte(""))
    defer runner.Verify()

    srv := api.NewServer(runner, "")
    body, _ := json.Marshal(abandonRequest{Revisions: []string{"abc"}})
    req := httptest.NewRequest("POST", "/api/abandon", bytes.NewReader(body))
    w := httptest.NewRecorder()
    srv.Mux.ServeHTTP(w, req)
    assert.Equal(t, http.StatusOK, w.Code)
}
```

### Adding a new operation

1. Add a command builder function in `internal/jj/commands.go`
2. Add tests for it in `internal/jj/commands_test.go`
3. Add a request struct + handler in `internal/api/handlers.go`
4. Register the route in `internal/api/server.go` → `routes()`. **Path must start with `/api/`** — `tabScoped()` in api.ts uses that prefix to route per-tab; anything else 404s in production (tests hit `srv.Mux` directly and won't catch it).
5. Add handler tests in `internal/api/handlers_test.go`
6. Add the API call to `frontend/src/lib/api.ts`
7. Wire it into the Svelte UI

## Svelte Frontend Performance

Patterns learned from profiling j/k keyboard navigation:

- **Don't use `:hover` for keyboard-navigable lists.** `:hover` recomputes on every paint — layout shift (error bar mount, `scrollIntoView`, post-mutation DOM reshuffle) slides it onto whatever row is now under a stationary mouse. Use JS-tracked `hoveredIndex` driven by `mousemove` (fires only on physical pointer movement, never on layout shift). See `RevisionGraph.svelte`: delegated `onmousemove` on container + `data-entry` attr + `class:hovered={hoveredIndex === line.entryIndex}`. Collapses sibling-chain `:has()` rules to one class selector when multiple rows belong to one logical item.
- **`untrack()` Svelte-4-store reads in effects that write back to the store.** `@tanstack/svelte-virtual`'s `createVirtualizer` returns a `Readable` store; `setOptions`→`measure`→internal `notify`→`writable.set` emits. Reading `$virtualizer` in the same `$effect` that calls `setOptions` creates a self-loop. `const v = untrack(() => $virtualizer)` severs the dep; template reads (`$virtualizer.getVirtualItems()`/`getTotalSize()`) stay reactive. Same pattern as `readByFile` in `diff-derivation.svelte.ts`.
- **Debounce expensive work, not the selection state.** Update `selectedIndex` synchronously for instant visual feedback. Debounce network fetches (~50ms). **On cache hits, apply values synchronously in the same tick** — `getCached(commitId)` reads the api.ts Map directly, `loader.set()` applies it. Svelte batches both `selectedIndex` and the loader values into one render → no one-frame stale-content flash. Cache-hit branch must also bump `revGen` so a `loadDiffAndFiles` suspended at `await api.revision()` can't resume and call `diff.load(stale)` after the synchronous set.
- **Opportunistic prefetch — only when current is cached.** `selectRevision` fires `prefetchRevision()` for the next revision in the navigation direction, but only when the current revision is already cached (instant main load → no network contention). With the batch `/api/revision` endpoint (1 req per prefetch, not 3) the 6-connection limit is no longer reachable, but the contention argument still holds: unconditional prefetch during rapid uncached j/k fires requests for revisions the user skips past. Fire-and-forget with swallowed errors.
- **Scope expensive `$derived` to minimal dependencies.** `workingCopyEntry = $derived(revisions.find(...))` only re-runs when `revisions` changes, not when `loading`/`mutating`/`diffLoading` flip. Nested inside `statusText` it was re-scanning 500 revisions 4-6× per mutation cycle.
- **Session-cache stable data.** `api.remotes()`/`api.aliases()` are promise-memoized — fetched once, reused for the session. Reset via `clearAllCaches()` (hard refresh). Error path clears the memo so retries work.
- **`createLoader()` factory** (`loader.svelte.ts`) encapsulates the generation-counter race-safe async pattern. Its `loading` flag is deferred via `setTimeout(0)` so cache hits (microtask-fast) never flip it — zero reactive updates on cached j/k navigation. `loader.set()` bumps generation so any in-flight `load()` is invalidated — "authoritative write wins". `loader.reset()` is `set(initial)`. **Prefer this over manual `diffLoading`/`diffError`/`diffGen` state** — the manual pattern has a subtle spinner-freeze bug when a no-fetch code path (early return) runs while a prior fetch is in flight (its `finally` gen-check fails to clear the flag).
- **`{#key}` over manual reset effects.** When component state should reset on identity change, wrap the component in `{#key identityExpr}` in the parent — the component remounts with fresh state. Manual `$effect` + previous-value-tracking `let` is 7+ lines, fragile (sentinel collisions), and reinvents what Svelte gives you. Svelte 5.50+ flags the pattern as `state_referenced_locally`. See `EvologPanel` and `RevisionHeader` usage in `App.svelte`.
- **Guard `$derived` in hidden components.** `CommandPalette`'s `availableCommands` uses `if (!open) return []` to avoid recomputing when the palette is closed but its `commands` prop changes.
- **Split static and dynamic `$derived` arrays.** `commands` in App.svelte was rebuilding ~30 `PaletteCommand` objects on every check/uncheck (Space spam) because a few labels interpolate `checkedRevisions.size`. Now `staticCommands` (zero-dep `$derived.by` — thunk sidesteps TDZ for handlers declared below) + `dynamicCommands` (5 entries that actually need reactive labels) + `aliasCommands` → spread into final `commands`. Space-spam rebuilds 5 objects not 30.
- **`createDiffDerivation()` factory** (`diff-derivation.svelte.ts`) for per-file progressive computation. `run(files, cacheKey)` yields between files, publishes per-file, aborts on supersede, memoizes complete runs by cacheKey. `update(file)` for single-file deltas (context expansion) — preserves all other entries, aborts in-flight `run()`. `tryRestore(cacheKey)` for synchronous memo check — call it before deferring `run()` via setTimeout so memo hits restore zero-frame. `immediateBudget` option processes first N lines without yield to prevent plain-text flicker. Memo externalized via `readMemo`/`writeMemo` so multiple derivations can share one LRU bucket. **Internal `byFile` reads go through `readByFile()` (untracks)** — methods are called from `$effect` bodies; a naked `new Map(byFile)` would register the Source as a dep → `schedule_possible_effect_self_invalidation` → `effect_update_depth_exceeded` (Svelte 5.44+ batching change). Writes don't need untrack.
- **Defer `highlights.run()` via `setTimeout(0)` — but check `tryRestore` first.** The deferral lets the browser paint the selection highlight before any sync work runs. Memo hits skip the deferral: checking `tryRestore` synchronously in the `$effect` gives zero-frame restoration on revisit.
- **Cache derived computations by commit_id, not just the source data.** `derivedCache` (30-entry LRU keyed by `activeRevisionId`, in `diff-cache.ts` so it survives DiffPanel unmount) persists `highlightsByFile`/`wordDiffsByFile` so revisits restore instantly. Commit_id keying means rewrites auto-invalidate. Highlight HTML uses `tok-*` class names (not inline styles) → theme-agnostic → theme toggle is a pure CSS var swap, no cache invalidation.
- **`user-select: none`** on interactive lists prevents text selection artifacts during click/keyboard navigation.
- **Svelte 5 effects run after DOM updates** — no need for `requestAnimationFrame` to query updated DOM in `$effect`.
- **Fire-and-forget async in effects is fine** when the async function has its own error handling and generation counter for cancellation.
- **Skip word-diff for non-code files.** `shouldSkipWordDiff()` in DiffPanel skips LCS computation for SVG/XML/JSON/lock/map/minified files and any file with >1000 diff lines.
- **Progressive word diffs.** The `wordDiffs` DiffDerivation yields between files and publishes per-file entries incrementally. Single-file context expansion calls `wordDiffs.update(file)` — only that file recomputes.
- **Auto-collapse large diffs.** Two triggers: (1) any single file >500 lines (`AUTO_COLLAPSE_LINE_LIMIT`) starts collapsed; (2) total lines across all files >2000 (`AUTO_COLLAPSE_TOTAL_LINES`) collapses EVERYTHING — catches the "many moderate files" DOM-flooding case the per-file check misses. Collapsed files render header-only via `{#if !isCollapsed}` in DiffFileView. Collapse state is cached per change_id; auto-collapse is suppressed when restoring from cache. Expand-all is one toolbar click; Cmd+F search auto-expands matches.
- **Diff parser uses `b/` (destination) path** from `diff --git a/source b/destination` headers. The `a/` path is the source and can appear in multiple entries for copies/renames, causing duplicate `{#each}` keys.
