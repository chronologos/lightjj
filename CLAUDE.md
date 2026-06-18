# lightjj

Browser-based UI for Jujutsu (jj) version control. See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for system design, [docs/FILES.md](docs/FILES.md) for the detailed per-file guide, [BACKLOG.md](BACKLOG.md) for planned features.

## Build & Test

```bash
go test ./...                                        # Go tests
go vet ./...                                         # static analysis
cd frontend && pnpm install && pnpm run build        # build frontend
cd frontend && pnpm run bench                        # diff perf benchmarks (see docs/design-notes/diff-perf-benchmarks.md)
go build -tags embed ./cmd/lightjj                   # build binary (needs frontend build first; no tag = stub)

# Dev mode: two terminals
# 1: go run ./cmd/lightjj --addr localhost:3000 --no-browser
# 2: cd frontend && pnpm run dev
# Vite proxies /api/* to localhost:3000
```

## Project Structure

One line per file; routine `*_test.go` / `*.test.ts` files are omitted (they sit alongside their subjects), shared test infrastructure is listed. **Detailed per-file notes and invariants live in [docs/FILES.md](docs/FILES.md)** — read a file's entry there before modifying the file or adding a new caller of its exports; update the entry (plus the one-liner here) when adding, removing, or renaming a file or when its contract changes.

```
cmd/lightjj/main.go       — CLI entry point, flag parsing, embeds frontend-dist/
cmd/lightjj/frontend_embed.go — go:embed frontend-dist/ handler (-tags embed)
cmd/lightjj/frontend_stub.go — No-embed fallback: static "frontend not bundled" help page
cmd/lightjj/session_file.go — Agent port-discovery session files ($XDG_RUNTIME_DIR/lightjj/sessions/<pid>.json)
cmd/lightjj/session_file_unix.go — verifyOwner uid check on the session dir (unix)
cmd/lightjj/session_file_other.go — verifyOwner no-op stub (non-unix)
cmd/lightjj/api_cmd.go    — lightjj api / lightjj sessions subcommands: loopback HTTP client for agent harnesses
cmd/lightjj/skill_cmd.go  — lightjj skill [install]: prints/installs embedded SKILL.md agent guide
cmd/lightjj/apply_hunks.go — --apply-hunks re-entry for `jj split --tool lightjj-hunks` (writes hunk spec into $right)
internal/
  jj/                     — Command builders + data models (PURE — no I/O, no side effects)
    commands.go            — Functions that return []string args for jj subcommands
    commit.go              — Commit model (ChangePrefix/CommitPrefix, Immutable, Divergent, WorkingCopies, …)
    bookmark.go            — Bookmark model + output parsers
    alias.go               — jj config alias parser
    file_change.go         — FileChange model, FilesTemplate, ParseFilesTemplate
    divergence.go          — DivergenceEntry, Divergence() template builder, ParseDivergence
    selected_revisions.go  — Multi-revision selection helper
    version.go             — Semver type + named jj feature gates + FeatureGates wire registry (→ /api/info features)
    workspace_store.go     — Protobuf parser for .jj/repo/workspace_store/index (<0.40 fallback)
  runner/                  — CommandRunner interface + implementations
    runner.go              — Interface (Run, RunWithInput, RunForMutation, StreamCombined, RunRaw, WriteFile)
    local.go               — LocalRunner: exec("jj", args); WriteFile symlink-escape hardening; resolve rejects forgotten workspaces
    ssh.go                 — SSHRunner: wraps jj args in an ssh command
  api/                     — HTTP handlers
    server.go              — Route registration (route lines ARE the pure-mutation handlers), runMutation, op-id cache (getOpId/setOpId/casOpId), helpers
    handlers.go            — Endpoint implementations, generic mutation[Req] factory, flag validation
    watcher.go             — Op-id watcher: fsnotify + SSE push (local), sshPollLoop (SSH), typed sseEvent broadcasts, shared probeTracker, stale-WC detection
    tabs.go                — TabManager: per-tab Server + Watcher mounted at /tab/{id}/
    config.go              — Server-side JSONC config (hujson); mergeAndWriteConfig single write path for human-edited keys
    config_jsonc.go        — hujson helpers: standardizeJSONC, unmarshalJSONC, patchConfigKeys, removeConfigKeys
    config_template.go     — First-run JSONC template constant
    state.go               — Machine-state store (state.json, plain JSON): openTabs + recentActions, GET/POST /api/state/recent-actions, legacy-key migration
    jsonstore.go           — jsonCollection[T]: generic keyed flat-file JSON store (mutex, merge-on-upsert, stamping, cascade delete, batch) + atomicWriteFile primitive
    annotations.go         — Per-changeId review comments: Annotation type + store config + GET/POST/DELETE handlers
    doc_comments.go        — Doc-mode range-anchored comments: DocComment types + store config + GET/POST/DELETE/batch handlers
    agent_docs.go          — GET /api/agent serves embedded agent_api.md (doc/route drift guard test)
    symbol.go              — rg-backed go-to-definition (GET /api/symbol) via RunRaw rg --json
    focus.go               — GET/POST /api/focus: frontend view-state report for agent steering
    open.go                — Open-in-$EDITOR ({file}/{line} substitution, detached process)
    open_unix.go           — detachProcess via Setsid (!windows)
    open_windows.go        — detachProcess no-op (windows)
    gzip.go                — Gzip response middleware (Flush passthrough for SSE)
  parser/                  — Graph log parser
    graph.go               — Parses jj log graph output with _PREFIX: markers into GraphRow[]
testutil/                  — Go test infrastructure
  mock_runner.go           — MockRunner with Expect(args)/Verify() pattern
frontend/                  — Svelte 5 SPA (Vite + TypeScript + pnpm)
  src/testutil/            — mock-api.ts (vi.mock netStubs + builders), wait-for.ts (frame/predicate waits)
  src/App.interactions.test.ts — In-process keyboard-gate tests
  src/main.ts              — Vite entry point: mounts AppShell, imports theme.css
  src/AppShell.svelte      — Tab-switch host ({#key activeTabId} remount + state snapshot)
  src/App.svelte           — Main app shell: layout, keyboard routing, state, revset filter bar
  src/lib/
    api.ts                 — Typed API client, op-id tracking, commit_id-keyed LRU cache, SSE auto-refresh
    RevisionGraph.svelte   — Revision list + graph gutter; always windowed via createWindower
    virtual.svelte.ts      — createWindower() fixed-row virtualization + holdViewport()
    GraphSvg.svelte        — SVG renderer for graph gutter characters
    DiffPanel.svelte       — Diff viewer: unified/split, collapse/defer, search, hunk/annotation nav
    file-actions.svelte.ts — createFileActions(): per-file edit/preview/merge/quick-resolve state + actions (DiffPanel's mutation cluster)
    diff-cache.ts          — App-lifetime caches: derived highlights, parsed diffs, collapse state
    SearchResults.svelte   — Diff search match jump-list dropdown (capped render, snippet windowing)
    ReviewJumpList.svelte  — Annotation jump-list dropdown over navAnnotations (SearchResults sibling, parent-owned cursor)
    FileSelectionPanel.svelte — Squash/split/review file checkbox panel
    hunk-apply.ts          — PURE — hunk selection model + forward-apply accepted hunks (spec for apply_hunks.go)
    RevisionHeader.svelte  — Header slot: change_id, description, badges, Describe/Divergence buttons
    DiffFileView.svelte    — Per-file diff: collapse, context expansion, conflict badges, Alt+click annotate
    SymbolHover.svelte     — Go-to-definition hover card (signature + doc context, click → open in $EDITOR)
    symbol-hover.svelte.ts — createSymbolHover() hover controller (span dedup, exit grace, gen-guarded fetch)
    FileEditor.svelte      — CodeMirror 6 wrapper for inline editing
    MergePanel.svelte      — 3-pane conflict editor (ours | result | theirs)
    merge-surgery.ts       — PURE — planTake/planTakeBoth/remapBlock position surgery
    cm-shared.ts           — CM6 helpers: detectIndent, getCmLanguage, cmTheme
    conflict-markers.ts    — PURE — shared conflict-marker scanner (escalation-aware width discovery, exact-width matching)
    conflict-extract.ts    — reconstructSides(): jj conflict markers → {base, ours, theirs, blocks}
    conflict-resolve.ts    — PURE — resolveConflictFile(): single @/non-@/SSH conflict-resolution strategy (both surfaces)
    merge-diff.ts          — ChangeBlock/LineDiff types; diffBlocks() LCS is test-only
    ConflictQueue.svelte   — Merge-view left rail: conflicted files grouped by commit
    merge-controller.svelte.ts — createMergeController(): merge-view queue/sides/save orchestration (shared gen)
    DocView.svelte         — Doc-mode ProseMirror editor (View|Edit)
    DocCommentRail.svelte  — Doc-mode comment rail (PlacedReview threads → CommentCard)
    review.ts              — Unified read-model over Annotation + DocComment (Review/PlacedReview + reviewed-marker predicate)
    review-mutations.svelte.ts — createReviewMutations(): shared optimistic-mutation policy for both review stores
    CommentCard.svelte     — Pure presentational comment card
    comment-visibility.svelte.ts — createCommentVisibility() per-App comment visibility store
    doc-session.svelte.ts  — createDocSession(): PM ↔ file two-tier model; comments = PlacedReview projection
    pm-schema.ts           — ProseMirror Schema + parseMarkdown/serializeMarkdown
    pm-mermaid.ts          — Mermaid code_block NodeView
    reanchor.ts            — Content-addressed anchor capture/refind
    FileHistoryPanel.svelte — Two-cursor file history overlay
    FileHistoryRail.svelte — Reusable file-history revision rail (two-tier mutable→full loading)
    FileComparePicker.svelte — Compare a file against another revision (FileHistoryRail + diffRange)
    DescriptionEditor.svelte — Inline commit message editor
    CommandPalette.svelte  — Fuzzy-search command palette (Cmd+K) with submenus
    ContextMenu.svelte     — Reusable right-click context menu
    StatusBar.svelte       — Bottom status bar with mode indicators and shortcuts
    MessageBar.svelte      — Single user-facing message surface (error/warning/success)
    TabBar.svelte          — Tab strip (click to switch, ✕ close, + open)
    BookmarkModal.svelte   — Bookmark modal (move/advance/delete/forget/track)
    BookmarksPanel.svelte  — Branches view: bookmark list (sortable Priority/Recent/Name, author shown + filterable)
    bookmark-sync.ts       — classifyBookmark() → 8 sync states + sort/format helpers
    workspace-recovery.ts  — PURE — planRecoverAll()/recoverAllMessage() for "Update all (recover stale)"
    remote-visibility.ts   — buildVisibilityRevset(): per-remote visibility → revset string
    themes.ts              — 7 builtin themes + lazy Ghostty palettes + deriveTheme()
    jj-features.svelte.ts  — jj feature labels; booleans come from /api/info features (optimistic until loaded)
    confirm-gate.svelte.ts — createConfirmGate() double-press confirm factory
    list-cursor.svelte.ts  — createListCursor() keyboard-list cursor factory (nav/hover/clamp/scroll)
    BookmarkPicker.svelte  — Shared autocomplete bookmark-picker modal (BookmarkInput/DestinationInput wrap it)
    BookmarkInput.svelte   — Bookmark name input with autocomplete (BookmarkPicker wrapper)
    DestinationInput.svelte — Destination picker (/) for inline rebase/squash (BookmarkPicker wrapper, raw revset pass-through)
    ConfigModal.svelte     — Cmd+K → "Edit config" CodeMirror JSON editor
    GitModal.svelte        — Git push/fetch modal
    EvologPanel.svelte     — Evolution log with inline per-entry diffs
    OplogPanel.svelte      — Operation log panel
    DivergencePanel.svelte — Stack-aware divergence resolution UI
    divergence.ts          — classify() + buildKeepPlan() + refined-kind taxonomy (see docs/jj-divergence.md)
    divergence-strategy.ts — recommend(): ranked resolution strategies
    divergence-actions.ts  — executeKeepPlan/splitIdentity/squashDivergent/abandonMutable (api-calling execution)
    divergence.fixtures.ts — Shared DivergenceEntry/DivergenceGroup test builders
    diff-parser.ts         — Unified diff parser
    context-expand.ts      — PURE — expandGaps() merges revealed context gaps
    conflict-parser.ts     — Diff-side adapter over conflict-markers.ts → ConflictRegion[] for DiffFileView
    split-view.ts          — Side-by-side diff alignment
    word-diff.ts           — Word-level inline diff computation
    perf-fixtures.ts       — Synthetic diff generators for diff-compute.bench.ts (`pnpm run bench`)
    languages.ts           — SINGLE language registry (one LANGUAGES entry per language)
    lang-zig.ts            — Zig StreamLanguage tokenizer (legacy simple-mode, lazy-loaded)
    highlighter.ts         — Lezer highlightCode → tok-* spans + escapeHtml/escapeAttr
    markdown-render.ts     — marked (GFM) + DOMPurify renderMarkdown + gutter block stamping
    mermaid.ts             — beautiful-mermaid lazy-load + render
    panzoom.ts             — wireSvg() wheel-zoom/drag-pan/dblclick-reset
    excalidraw-render.ts   — PURE — .excalidraw JSON → SVG string
    ExcalidrawPreview.svelte — .excalidraw preview (lazy chunk)
    MarkdownPreview.svelte — .md preview toggle with annotation gutter
    fuzzy.ts               — Fuzzy string matching
    group-by.ts            — groupByWithIndex utility
    paths.ts               — basename()/dirname() display helpers (jump-list dropdowns)
    time-format.ts         — relativeTime() compact ages + firstLine()
    scroll-into-view.ts    — scrollIdxIntoView() data-idx row scroll helper
    loader.svelte.ts       — createLoader() async factory with generation counter
    op-sync.svelte.ts      — createOpSync(): op-id-driven auto-refresh policy for repo-scoped loaders
    revision-navigator.svelte.ts — createRevisionNavigator(): diff/files/description load orchestration
    diff-derivation.svelte.ts — createDiffDerivation() per-file progressive computation
    keyboard-gate.ts       — PURE — routeKeydown() gate-priority router
    modes.svelte.ts        — Rebase/squash/split mode state factories (ModeBase: kind/sources/diffFollows/hasDestination)
    slide.ts               — computeSlide(): Shift+J/K single-step reorder along linear graph segments
    config.svelte.ts       — Reactive config singleton (server config + localStorage cache)
    recent-actions.svelte.ts — State-backed (state.json) last-used timestamps for bookmark recency sort
    annotations.svelte.ts  — Per-line review comment store (server-backed, agent workflows; PlacedReview projection)
    AnnotationBubble.svelte — Annotation create/edit popup
    WelcomeModal.svelte    — "What's new" modal on version bump
    tutorial-content.ts    — Feature announcements keyed by version
    version.ts             — APP_VERSION constant
  vite.config.ts           — Dev proxy + build output to ../cmd/lightjj/frontend-dist/
```

## Dependencies

**Minimize them.** Every dep (including transitives) is an install-time exfil vector (postinstall scripts run with your shell's credentials — SSH keys, cloud creds, env vars). Before adding a dep, ask: can this be ~100 lines of in-tree code instead? If the dep has zero transitives, is maintained by a known-trustworthy author, and does something genuinely hard (parsers, sanitizers, syscall wrappers), keep it. Otherwise yoink.

**Go**: 3 direct (`fsnotify` for cross-platform fs watch, `tailscale/hujson` for comment-preserving JSONC config edits, `testify` test-only). Don't add more without strong justification.

**Frontend**: CodeMirror/Lezer (editor core, one author), `marked`+`dompurify` (markdown+XSS — don't hand-roll sanitization), `beautiful-mermaid` (lazy-loaded, opt-in), `jsonc-parser` (lazy-loaded, ~30KB gzip — only used by ConfigModal save path), `prosemirror-*` (9 packages, one author, lazy-loaded via doc-mode `await import` — ~31KB gzip), `fast-check` (dev-only, 1 transitive — property tests for data-loss paths). Versions pinned exact (no `^`). `pnpm.onlyBuiltDependencies: ["esbuild"]` allowlists the ONE package permitted to run install scripts — everything else is blocked. Run `pnpm audit` before shipping a dep bump.

## Code Conventions

### Go backend

- **Command builders are pure functions.** `internal/jj/commands.go` takes parameters, returns `[]string`. No execution, no config reads, no globals. If you need a new jj command, add a function here.
- **Never call `exec.Command` outside of `internal/runner/`** — with one deliberate exception: detached editor spawning in `internal/api/open.go`. The editor must run where *lightjj* runs (it opens a window on the user's machine), not where *jj* runs — routing it through the runner would launch the editor on the SSH remote. Everything else: all jj execution goes through the `CommandRunner` interface, and non-jj sidecar tools (`gh`) go through `Runner.RunRaw(argv)` — this is what makes them work in SSH mode (they run on the remote host, not locally).
- **Test with MockRunner.** Use `testutil.NewMockRunner(t)` with `.Expect(args).SetOutput(output)` and `defer runner.Verify()`. See existing tests for the pattern. Also supports `SetExpectedStdin()`, `SetError()`, and `Allow()` for flexible matching.
- **API handlers are thin.** Parse request → call command builder → call runner → return JSON. No business logic in handlers.
- **Mutation handlers use `runMutation()` / `runMutationWithInput()`.** Centralizes `RunForMutation` (separate stderr for warning detection via `hasWarningLine`) + sync op-id refresh + response write. Streaming mutations (git push/fetch) use `streamMutation()` instead.
- **Validate POST inputs.** All POST handlers check required fields and return 400 on empty values.
- **Validate flags.** `validateFlags()` whitelists allowed `--` and `-` flags for git push/fetch. Reject anything not in the allowed set.
- **Rebase API accepts `source_mode` and `target_mode` params.** `source_mode` maps to `-r`/`-s`/`-b`; `target_mode` maps to `-d`/`--insert-after`/`--insert-before`.
- **Use `--tool :git`** when requesting diff output for the web API. Users may have external diff formatters (difftastic) configured that output ANSI codes.
- **Use `--color never`** for any jj output the backend will parse. Use `--color always` only if passing through to a terminal.
- **New jj output parsing MUST use `json(...)` templates, not delimiter-positional templates.** jj ≥ 0.31 templates have `json(value)`: compose each record as one JSON object per line — `'{"field":' ++ json(value) ++ …` — and parse with `encoding/json`. json() escapes embedded newlines/quotes/control chars and fields are named, so neither the delimiter hierarchy below nor positional `SplitN` parsing applies. Wrap each field in `json()` individually; do NOT use `json(self)` whole-object serialization (that schema belongs to jj and can change between releases). Gate on jj version via `jjSupports` (see version gating below; the gate constant is `jj.JSONTemplates`), keeping a delimiter parser as the older-jj fallback only when the feature must work there. `OpLogJSON`/`ParseOpLogJSON` (commands.go) is the reference migration. Existing delimiter parsers migrate opportunistically — don't batch-rewrite them.
- **Delimiter hierarchy in jj templates** (existing parsers only — new parsers use the json() rule above) — Git refs can't contain any ASCII control chars per `git-check-ref-format`, so these are all collision-safe. Split at parse time (Go parser); control chars never cross the wire.
  - **`\x1F` (unit separator)** — top-level field delimiter (not tabs; tabs appear in commit descriptions)
  - **`\x1E` (record separator)** — distinguishes remote bookmark entries (`name\x1Eremote`); presence of `\x1E` = remote entry
  - **`\x1D` (group separator)** — sub-field within local bookmarks (`name\x1Dconflict`); the `??` decorator in jj's log
- **Use `root-file:"path"` (via `EscapeFileName`) for file arguments**, never `file:`. `file:` is cwd-relative — it breaks in secondary workspaces (divergent rev authored in A, viewed from B) and in SSH mode (`wrapArgs` uses `-R`, no cd → remote cwd is `~`). `root-file:` anchors at the workspace root. Not `root:` — that's prefix-recursive; `root:"a"` would match `a/` too.
- **Use `--ignore-working-copy` on read commands** (`log`, `file show`, `workspace list`). The watcher snapshot path runs every `--snapshot-interval` (default 5s) — `snapshotLoop` via `jj util snapshot` in local mode, `sshPollLoop` via `PollOpId` (implicit snapshot) in SSH mode. Read-path snapshots are redundant (~485ms/call wasted) and contend on the WC lock. Do NOT use on mutations or anything that needs the freshest WC state. Both loops are standard jj commands — `snapshot.auto-update-stale` (jj's own config, default true) detects stale WCs and checks out the new tree before snapshotting, so multi-workspace rebase is safe.
- **Prefer templates over human-output parsing.** Check `jj help -k templates` before writing regex/string parsers. `FilesTemplate` uses `self.diff().stat().files()` + `conflicted_files.map()` — one subprocess returns status char, path, exact +/- counts, and conflict side-counts. `DiffStatEntry.path()` returns the DESTINATION path for renames (no brace expansion needed). Exits 0 on clean revisions, works with multi-revision revsets, no regex.
- **Intersect expensive revset predicates with `mutable()` for large repo speed.** `conflicts()` and `files(path)` are O(commits×tree-check) with no index — 20+ seconds on large repos. `mutable() & <predicate>` lets jj evaluate the cheap set-membership check first, then run the expensive predicate only on those commits. Both `ConflictList` and `FileLog` learned this (20s→0.3s). Trade-off: scopes results to the user's own mutable work; callers wanting full scope should opt-in explicitly.
- **Never use `separate()` for positional field output.** jj's `separate(sep, a, b, c)` SKIPS empty arguments — an empty `author.email()` on root commits shifts every following field one position left. Use explicit `++ sep ++` concatenation. Both `LogGraph` and `bookmarkListTemplate` learned this the hard way (see comments in `commands.go`).
- **Parsers return empty slices, not nil.** This ensures JSON serialization produces `[]` not `null`.
- **jj version gating** (capability gates — "does the installed jj support X?"; distinct from the frontend's *keyboard* gate in keyboard-gate.ts and the double-press *confirm* gate) — backend is the single authority: add a named `jj.Semver` constant in `internal/jj/version.go` AND an entry in `jj.FeatureGates` (the wire-name → minimum-version registry), branch on `s.jjSupports(ctx, jj.YourGate)` in the handler, keep the older codepath as the `else`. `jjSupports` auto-resolves `jj --version` once (mutex-cached) and is PESSIMISTIC on unknown — gated handlers fall back, never 500. Tests: `newTestServer` defaults to 0.39 via `Allow(jj.Version())`; use `withJJ(srv, jj.Semver{0,40})` to exercise the new path. Frontend: there is NO frontend version table — `GET /api/info` ships a `features` map (every `FeatureGates` entry resolved to a boolean) and `jj-features.svelte.ts` only labels those names (`JJ_FEATURE_LABELS`). UI gates call `jjSupports('feature')` in `$derived`/templates — OPTIMISTIC while the info response hasn't loaded (so dev builds don't lose UI), then authoritative (= the backend's pessimistic booleans). A frontend-only gate still goes through the backend: add the Semver constant + `FeatureGates` entry there, add only the label here.
- **`NewServer(runner, repoDir)`** takes the resolved repo dir as second arg. Pass `""` for SSH mode or tests. **Use `s.hasLocalFS()` / `s.isSSHMode()` for mode checks, not `RepoDir == ""`.** They're distinct: tests have neither local fs NOR SSH (both false); prod has exactly one. `Server.DefaultRemote` defaults to `"origin"` in the constructor body; `main.go` overrides post-construction from the `--default-remote` flag (zero test churn across existing call sites).
- **Read-modify-write handlers need a `sync.Mutex`.** `atomicWriteFile`/`os.Rename` prevents torn writes but NOT lost updates — two concurrent POSTs both read `[a,b]`, one appends `c`, other appends `d`, last-rename wins. See `jsonCollection.mu` (jsonstore.go), `configMu` (config.go), `stateMu` (state.go). Contention is rare so a global mutex is fine; don't reach for per-key locks. Flat-file stores should be built on `jsonCollection[T]` rather than hand-rolling the lock + merge + write cycle (the annotations/doc-comments duplication was a recurring bug source).
- **`sync.Once` permanently caches errors.** If the `Do()` closure can fail transiently (SSH slow-start, network blip), use `sync.Mutex` + `bool` resolved flag set only on success. See `resolveGHRepo` — `sync.Once` would have disabled PR badges for the server lifetime on a single timeout.
- **Workspace store parser** (`internal/jj/workspace_store.go`) manually parses protobuf wire format — no protobuf dependency. The `.jj/repo/workspace_store/index` file has a simple schema: `repeated Entry { string name = 1; string path = 2; }`.
- **Tabs via `TabResolve`+`TabFactory` injection.** `handleCreate` is mode-agnostic — the injected `resolve` closure does validation + canonicalization (local `~` expansion + `jj workspace root`, or SSH `quoteRemotePath` round trip). Workspaces open as tabs too: the dropdown calls `onOpenTab(ws.path)` → `POST /tabs`. Same-repo workspaces share commit_ids → cross-tab diff-cache hits are free. Tab list persists to `state.json` (`openTabs: [{path, mode, host}]` via `SetOpenTabs`, state.go) on create/close; tab 0 (the `-R` flag) is excluded — persisting it would fight with a different `-R` on next launch. Startup restore re-runs `resolve()` per tab so moved/deleted repos log-and-skip instead of crashing.
- **Config (human) vs state (machine) split.** config.json is the user's hand-commented JSONC file; state.json (state.go) is plain JSON that lightjj writes itself (openTabs, recentActions). Machine writes must NEVER go through the config path — that's how the comment-stripping bug class happens. New machine-written values get a field on `appState` + a per-section setter, not a config key.
- **`mergeAndWriteConfig()` is the single config write path.** Holds `configMu` for the whole read-merge-write cycle (atomic-rename prevents corruption, the mutex prevents lost updates). `handleConfigSet` goes through it — any new config writer must too, or it will stomp unknown keys (older instance writing its subset would drop newer instance's keys). The frontend cooperates by POSTing only dirty keys (config.svelte.ts) so concurrent instances converge per-key.
- **`hujson.Standardize` aliases AND mutates its input buffer.** The docs say the returned `Value`'s `Extra`/`Literal` fields alias input; what they understate is that `Standardize` REPLACES comments and trailing commas with spaces IN PLACE. `standardizeJSONC` clones via `bytes.Clone(data)` before handing to hujson; without it, any caller that reads the same bytes twice — e.g. `MigrateStateIfNeeded`, which decodes config via `unmarshalJSONC` then re-patches the SAME buffer through `removeConfigKeys` — silently strips every comment. Tests caught the symptom via a workaround comment in one test but left the helper broken — see the "fix the helper, not the test" rule below. Applies to any hujson read-path call that shares its bytes with another caller. Read-path mirror: any `json.Unmarshal` of config bytes must go through `unmarshalJSONC` — raw Unmarshal breaks the moment the config contains a comment, and the seeded first-run template always has comments.
- **`Content-Type: text/plain` is CORS-safelisted and does NOT force preflight.** Alongside `application/x-www-form-urlencoded` and `multipart/form-data`. Requiring `text/plain` on a POST handler adds zero CSRF defense — a cross-origin `<form enctype="text/plain">` submit goes through without preflight. Content-Type enforcement only adds value for NON-safelisted types (e.g. `application/json`, which forces preflight and is what `decodeBody` enforces). For text/plain endpoints, `isLocalOrigin` is the only real cross-origin gate — see the comment in `handleConfigSetRaw`.
- **Zero-byte files from partial or truncated writes are "fresh," not "corrupt."** Mid-rename crashes or disk-full events can leave a 0-byte file behind. If the read path treats it as an unparseable JSONC file and returns 422, the user is in an unrecoverable loop: `handleConfigGetRaw` also 422s so the editor can't open, and there's no shell-free recovery. `readOrTemplate`, `handleConfigGetRaw`, and `readStateLocked` (state.go) all treat `len(data) == 0` as "no file."
- **Fix the helper, not the test.** If a library has a subtle behavior (hujson alias-mutates, a client returns stale data, etc.) and you find yourself snapshotting bytes / deferring reads / adding `// workaround:` comments in a single test to make it pass, the workaround belongs in the helper being tested — every OTHER caller of that helper still has the bug. The hujson aliasing bug lived in `writePersistedTabs` for an entire feature-chain because one test worked around it locally instead of upstreaming the `bytes.Clone` to `standardizeJSONC`.

### Svelte frontend

- **Svelte 5 runes** — use `$state()`, `$derived()`, `$effect()`. No Svelte 4 stores.
- **api.ts is the single API boundary** — all backend calls go through the `api` object in `src/lib/api.ts`. Don't use raw `fetch()` in components.
- **Shared UI primitives in `theme.css`** — Don't redefine these per-component; the `.panel-header` pattern was copy-pasted 5× before consolidation. Component CSS adds only layout/positioning overrides.
  - Typography: `--font-size` (config-settable base, default 14px) + derived `--fs-3xs/2xs/xs/sm/md/lg/xl` (additive offsets → 9/10/11/12/13/15/17 at default). **Never write `font-size: Npx`** — use the scale vars. `--font-ui`/`--font-mono` are config-overridable family stacks.
  - Dim/secondary **text** color: `--text-faint` (`color-mix(--text 45%, transparent)` — derived, so legible on every theme polarity). **Never use `--surface2` as a text `color`** — it's the gray ramp's darkest *border* step and collapses into the background in dark themes (issue #13). `--surface2` stays for `border-color`/dividers only.
  - Buttons: `.btn` (ghost), `.btn-sm` (compact), `.btn-primary` (filled amber), `.btn-danger` (red outline → fill on hover)
  - Toggle: `.seg`/`.seg-btn`/`.active` (segmented control)
  - Panel chrome: `.panel-header`, `.panel-title`
  - Modal chrome: `.modal-backdrop`, `.modal`, `.modal-header`, `.modal-input`
  - Prose: `.prose` — rendered-markdown typography (heading scale + h1/h2 underlines, leading, code/pre/blockquote, table stripes). MarkdownPreview + DocView both use it; don't redefine per-component.
  - Misc: `.close-btn` (borderless ×), `.placeholder-text` (dimmed "(no description)"), `.nav-hint` (kbd badge)
- **Keyboard-navigable lists use `createListCursor`** (`list-cursor.svelte.ts`) — one factory for cursor + hovered state, j/k/Arrow routing with the filter-input guard, Enter/Escape/`/` hooks, delegated `[data-idx]` hover (the no-:hover rule), bounds clamping, and data-idx scroll-into-view. Don't hand-roll the skeleton; layer domain keys behind `if (cursor.handleKey(e)) return`. Works for both self-focused lists (element onkeydown) and delegated-key lists (exported handleKeydown the App router calls).
- **Cache by `commit_id`, not `change_id`.** Per-revision data (diff, files, description) is keyed by `commit_id` — a content hash of tree + parents + message. If the commit_id hasn't changed, the cached data is provably valid. No op-id suffix, no clear-on-mutation. `jj new` / `jj abandon` (leaf) / `jj undo` leave existing commit_ids unchanged → **zero** cache invalidation. Only rewrites (describe, rebase, squash) change commit_ids, and then only for the rewritten commit and its descendants. Pass `commit.commit_id` to `api.diff()`/`files()`/`description()`/`revision()`/`fileShow()`; use `effectiveId()` (change_id) only for mutations and UI-state that should survive rewrites — never as a cached-read key (a change_id-keyed `fileShow` served pre-save content to the second Edit click, issue #16). **Selection is identity-keyed too**: the cursor is `selectedId` (effectiveId) in App.svelte with `selectedIndex` derived from it, so a refresh that shifts row positions can't re-bind the cursor (or the diff panel) to a different revision. Repo-scoped staleness is likewise derived, per resource: every repo-scoped loader (log, workspaces, PRs, aliases, remotes, stale-immutable, oplog/bookmarks panels) pairs with a `createOpSync` that compares the op-id its value reflects against the latest reported op-id (see docs/CACHING.md "Staleness model" and op-sync.svelte.ts) — never an event that can be dropped. **A new server-state mirror is one `createLoader` + one `createOpSync` declaration**, not a `$state` + load function + a line in some refresh effect. The evolog is the deliberate exception: selection-scoped (per-revision) data gets explicit loads, not an op-sync — see CACHING.md.
- **pnpm, not npm** — the project uses pnpm for package management.
- **Graph rendering uses flattened lines.** Each graph line (node or connector) is its own DOM row at identical height. Node lines show commit content; description lines show the description; connector lines are just gutter characters. This ensures pixel-perfect continuous graph pipes. **Graph rows use a fixed `height: 18px`** to guarantee identical sizing across all modes (normal, rebase, squash, split). This prevents inline badges, buttons, or text from influencing row height. All inline elements (badges, `@` indicator, action buttons) must fit within 18px. Content is clipped by `overflow: hidden`. Never change this to `min-height` or remove the fixed height — it's the only way to prevent sub-pixel height differences between modes that break graph pipe continuity.
- **Change IDs show full short form with highlighted prefix.** `commit.change_prefix` determines how many characters to highlight. Same for `commit_prefix`.
- **Rebase mode is inline, not a modal.** Press `R` to enter rebase mode. `j`/`k` navigate the destination; Enter executes; Escape cancels. Source mode (`r`/`s`/`b`) and target mode (`o`/`a`/`i`) can be switched while in rebase mode. Source and destination commits are marked with inline badges directly in the revision graph.
- **Immutable commits** (`◆` in jj graph output) are dimmed in the UI. Mutable `○` nodes use graph palette colors; working-copy `@` is an amber concentric circle. Graph colors come from `--graph-N` CSS vars (Tier 3: muted, decorative) at static opacity (lines 0.45, nodes 0.8) — lane-level hover was removed (lane 0 spans the whole graph so highlighting was visually jarring). Row-level `.hovered` class provides the only hover feedback.
- **Preset chips + per-remote visibility** — The filter bar has inline preset chips (My work / WIP / Conflicts / Divergent / PRs) that set `revsetFilter` via `STATIC_PRESETS`. Remote-bookmark visibility is per-remote via `config.remoteVisibility` (BookmarksPanel eye toggles → `buildVisibilityRevset`). The old Log/Tracked segmented toggle was removed. `t` key toggles dark/light theme.
- **Divergent commit handling** — Commits with `divergent: true` share the same `change_id`. Use `effectiveId(commit)` (from `api.ts`) for all identity operations — falls back to `commit_id` for divergent/hidden. DivergencePanel fetches `GET /api/divergence` (revset `(divergent() & mutable())::`) → `classify()` groups into stacks. **`/N` offsets = jj's index-insertion order** (`GlobalCommitPosition` per `lib/src/index.rs:217`), NOT commit_id sort, NOT committer_ts — both would mislabel. Preserve emission order. `is_working_copy` field is the tautology guard: `wc_reachable` alone inverts when the user `jj edit`s into a divergent commit to inspect it. `alignable: false` when columns can't be bijectively mapped parent↔child — panel disables Keep (buildPlan would abandon wrong commits). See docs/jj-divergence.md.
- **`DiffTarget` discriminated union** (`api.ts`) — `{kind:'single', commitId, changeId, isWorkingCopy, immutable} | {kind:'multi', revset, commitIds[]}`. Replaces the stringly-typed `activeRevisionId` that was sometimes a commit_id and sometimes a `connected(X|Y)` revset. `diffTargetKey()` returns a stable string for cache-key equality (the `$derived` object is new every recompute). Operations that only make sense on a single revision (`api.fileShow`, `startEdit`, copy-reference attribution) gate (capability-gate, in the jj-version-gating sense — not keyboard routing) on `diffTarget?.kind === 'single'`. `api.diff`/`expandFile` are NOT gated — `jj diff -r 'connected(a|b)' --context=N` is valid.
- **Diff line context menu** — Right-click selected diff lines → single "Copy reference" action with `path:line-range @ changeId` + content. `DiffFileView` detects native text selection via `window.getSelection()` + `Range.intersectsNode()`, collects line numbers from `.line-num` spans and text from `.diff-line` elements. Exports `DiffLineInfo` interface (`{ filePath, lines[] }`) reusable for future inline annotations. `DiffPanel` formats the reference with `diffTarget.changeId` (single mode) or omits the `@ changeId` suffix (multi mode — the line could be from any commit in the revset).
- **Top toolbar (no sidebar)** — Navigation, workspace selector, search trigger, and action buttons live in a compact top toolbar in `App.svelte`. Nav tabs (`◉ Revisions [1]`, `⑂ Branches [2]`, `⧉ Merge [3]`) switch `activeView` (what fills the right column — or full-width for merge); drawer toggles (`⟲ Oplog [4]`, `◐ Evolog [5]`) open bottom panels. Inline `<kbd class="nav-hint">` badges make shortcuts discoverable. Workspace selector uses `◇` glyph with dropdown for multi-workspace repos (`w` key toggles). `GET /api/workspaces` returns `{ current, workspaces[] }` (enriched with paths from workspace store — local fs read or SSH `cat` via RunRaw). `openWorkspaceTab(name)` is the shared helper (dropdown + RevisionGraph `◇ {ws}@` badge clicks both call it) — looks up path in `workspaceList`, calls `onOpenTab(path)` → `POST /tabs`, or warns when path is unknown. `POST /api/workspace/add` creates a sibling-dir workspace (local-fs only); Cmd+K → "New workspace…" wires it.
- **`switchToLogView()` helper** — sets `activeView = 'log'` AND resyncs diff if cursor moved while in branches view (where graph clicks use `selectRevisionCursorOnly`). Returns `true` if diff already matches cursor; `enterSquash/SplitMode` gate on `false` to avoid initializing `selectedFiles` from stale `changedFiles`. Calls `nav.cancel()` (clears pending navigate* schedule) to prevent redundant loads via context-menu → `selectByChangeId` path. The `checkedRevisions.size > 0` early-return is load-bearing — multi-check diff is what `enterSquashMode` needs for `selectedFiles` init.
- **`switchToMergeView()` helper** — sets `activeView = 'merge'`, resets `mergeCurrent`/`mergeSides` (NOT `mergeResolved` — resolved-dots persist across view switches intentionally), fetches `api.conflicts()`. (It's a *view*, not a mode — "mode" is reserved for the inline rebase/squash/split states; the merge surface is just `activeView === 'merge'`.) The merge view **hides RevisionGraph entirely** (`{#if activeView !== 'merge'}` around `.revision-panel-wrapper`) — ConflictQueue + 3-pane MergePanel need the full width, unlike branches which keeps the graph as a left sibling. `mergeGen` generation counter guards `loadMergeFile`+`saveMergeResult` against rapid j/k nav (same pattern as `revGen`). **Conflict-resolution writes (merge view AND DiffPanel quick-resolve/⧉ Merge) share ONE strategy — `resolveConflictFile()` in conflict-resolve.ts**: `@` → fileWrite (the `@` check compares `change_id`, NOT `commit_id` — `api.fileWrite` snapshots `@` → new commit_id, but conflictQueue was fetched pre-snapshot); non-@ local → `api.mergeResolve` (does NOT move @); non-@ SSH → explicit `jj edit`+fileWrite fallback that callers MUST surface as "working copy moved" (never silent). Resolution no longer auto-`jj edit`s in local mode; only editor-opening paths (startEdit, unparseable-conflict fallback) move @.
- **Tab-switch state preservation** — AppShell snapshots `{selectedId, revsetFilter, activeView, diffScrollTop}` via `appRef.getState()` BEFORE the `{#key activeTabId}` remount, feeds it as `initialState` prop to the new App instance. The cursor snapshot is the *identity* (`selectedId`), not an index — a backgrounded tab's log can shift before the user switches back. The `{#key}` remount is load-bearing (SSE lifecycle, `onStale` wiring stay correct); only cursor/scroll thread through. Inline modes are NOT preserved — half-complete rebase/squash across tabs is a footgun. `init = untrack(() => initialState)` silences Svelte's `state_referenced_locally` lint (prop never changes mid-lifetime inside `{#key}`). Scroll restore: one-shot `$effect` nulls `pendingScrollRestore` after first apply so later nav doesn't re-apply a stale offset.

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
3. Add a request struct in `internal/api/handlers.go` with `validate() error` and `build() (jj.CommandArgs, error)` methods. **Factory-first is the default**: a pure decode→validate→build→runMutation operation needs NO named handler function — the generic `mutation[Req]` factory (handlers.go) is the handler. Hand-roll only for extra behavior: stdin (describe), streaming (git push/fetch, alias), runner-backed validation (alias), non-400 guard statuses (workspace forget), server-state-dependent builds (workspace add), or post-mutation side effects (snapshot, file-write).
4. Register the route in `internal/api/server.go` → `routes()` — the route line IS the handler: `reg("POST /api/foo", mutation(s, fooRequest.validate, fooRequest.build))`. **Path must start with `/api/`** — `tabScoped()` in api.ts uses that prefix to route per-tab; anything else 404s in production (tests hit `srv.Mux` directly and won't catch it). Also add the endpoint to the table in `docs/ARCHITECTURE.md` — `TestArchitectureEndpointTableInSync` (architecture_doc_test.go) fails if the table and `routes()` drift.
5. Add handler tests in `internal/api/handlers_test.go`. Route families sharing one request shape use the thin adapter factories over `mutation()` — `opMutation`/`bookmarkMutation`/`bookmarkRevMutation`/`bookmarkRemoteMutation` (handlers.go) take a `func(...) jj.CommandArgs` and return `http.HandlerFunc`.
6. Add the API call to `frontend/src/lib/api.ts`
7. Wire it into the Svelte UI

### Adding a context-menu surface

1. The component emits the **domain object** it was right-clicked on — `oncontextmenu?: (domainObject, x, y) => void`. It reports *what* was clicked, not what the menu should contain.
2. App builds the `ContextMenuItem[]` in an `open<Surface>ContextMenu` handler. Item building almost always needs App-level handlers (`handleEdit`, `enterRebaseMode`, `handleBookmarkOp`) and App-level gates (`inlineMode`, `mutating`) that components can't see. This is how the flagship surfaces work: `RevisionGraph` (rows AND workspace badges → `openRevisionContextMenu` / `openWorkspaceContextMenu`) and `BookmarksPanel` (→ `showBookmarkContextMenu`).
3. The handler sets `contextMenu = { items, x, y }`, rendered by App's single `<ContextMenu>` instance.

**Exception — self-contained components**: a component whose menu items only need its own props/state (DiffPanel's copy-reference menu, Oplog/Evolog entries) builds `ContextMenuItem[]` itself and emits `(items, x, y)` → wired in App as `oncontextmenu={showContextMenu}`. Anything in those items that needs App-level state still goes through separate `onX` callback props called from inside item `action` closures.

## Svelte Frontend Performance

Performance and async-correctness rules, mostly distilled from profiling j/k keyboard navigation. **Full rationale, war stories, and exemplar files: [docs/design-notes/frontend-perf.md](docs/design-notes/frontend-perf.md)** (entries in the same order as this list) — read the relevant entry there before relaxing or working around any of these. A new lesson gets a one-line rule here AND a long-form entry there, never just one of the two.

- **No `:hover` on keyboard-navigable lists** — JS-tracked `hoveredIndex` via delegated `mousemove` (RevisionGraph pattern).
- **`untrack()` Svelte-4-store reads** in effects that write back to that store; better, avoid Svelte-4-store libs entirely.
- **Debounce expensive work, not selection state** — scheduling lives in `revision-navigator.svelte.ts` (double-rAF on cache hit, 50ms debounce on miss); rapid j/k renders only the destination.
- **Opportunistic prefetch only when the current revision is already cached.**
- **Scope expensive `$derived` to minimal dependencies.**
- **Session-cache stable data, op-id-bounded** (`api.remotes()`/`api.aliases()` promise-memoized; `notifyOpId` drops both memos on op-id change so external CLI changes propagate; `_info` deliberately exempt — feature gates must not flap; error path clears the memo).
- **Use `createLoader()`** for per-revision async fetches, not hand-rolled loading/error/generation state. (Not a fit for barrier-gens guarding per-key Map writes.)
- **Generation counters must cover writes, not just competing loads** — mutators bump gen before await AND check after.
- **Post-await identity guard is mandatory in inline-editor openers**; it can't catch synchronous staleness — don't trust loader state read in the same tick as `selectRevision`, fetch by commit_id instead.
- **`diffFrozen` (from `ModeBase.diffFollows`) is the per-mode nav gate** (a keyboard/UI gate — which keys do what — not a jj-capability gate) — never re-spell `squash.active || split.active`. Per-mode dispatch in App goes through `activeInlineMode.kind`-keyed lookups and the ModeBase fields (`sources`/`hasDestination`), never fresh `split.active ? … : squash.active ? …` chains.
- **Effect declaration order + untracked reads = permanent skip** — reach for `createLoader`, not hand-rolled dedup effects.
- **`{#key}` over manual reset effects**; key on what's DISPLAYED, not what's SELECTED (loader state, not cursor).
- **Guard `$derived` in hidden components** (`if (!open) return []`).
- **Split static and dynamic `$derived` arrays** (palette commands).
- **`createDiffDerivation()`** for per-file progressive computation; internal reads go through `readByFile()` (untracked).
- **Defer `highlights.run()` via `setTimeout(0)`** — but check `tryRestore` synchronously first.
- **Cache derived computations by commit_id**; highlight HTML uses `tok-*` classes so theme toggles never invalidate.
- **`user-select: none`** on interactive lists.
- **Svelte 5 effects run after DOM updates** — no rAF needed to query updated DOM.
- **Hoist instance-invariant `$effect` to `<script module>`** (GraphSvg palette pattern).
- **Store stable keys in `$derived` Maps; compute equality at render.**
- **Fire-and-forget async in effects is fine** when it has its own error handling + generation counter.
- **Skip word-diff for non-code files**; word diffs publish progressively per file.
- **Auto-collapse large diffs** (>500-line file, >20k-char file, >2000 total lines) — collapse ≠ compute-skip; highlight/word-diff have separate per-file line caps.
- **Collapse is decided pre-render (`isFileCollapsed`) and offscreen bodies defer their mount** — programmatic jumps to a file body must go through `revealFile()`, never just collapse-state writes.
- **`content-visibility: auto` on `.diff-file`** for offscreen layout/paint skip.
- **Diff parser uses the `b/` (destination) path** from `diff --git` headers.
- **Every diff load goes through the navigator** (`loadDiffAndFiles`/`applyCacheHit`/`loadMulti` — multi-check included); never call `diff.load()` directly — it desyncs the `loadedTarget`/`diffContentKey`/`diff.value` triple.
- **Tri-state `boolean | undefined` for UI gates derived from async-init state**; the `$derived` returns the fail-safe for the undefined window.
- **Model "data is stale" as derived state (reflected-op-id vs current-op-id), not as a droppable event** — `createOpSync` (op-sync.svelte.ts) owns this per resource; its effect re-fires when a suppressing gate clears; refresh-inside-the-callback loses the fact forever.
- **Staleness effects read their inputs RAW, never through a memoized boolean `$derived`** — a derived that recomputes true→true doesn't advance its write version, so dependent effects don't re-run; folding `stale` into a boolean silently drops op-ids that arrive while already stale (failed fetch never retries, mid-fetch op-id never re-fires). Inverse of the derived-boolean-gate rule, which is for effects that WANT fewer re-fires.
- **Key list selection by identity (`selectedId`), derive the index** — raw index `$state` re-binds to whatever row lands at that position after a refresh; selection writes stay synchronous so the debounce rule is unaffected.
