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
    bookmark.go            — Bookmark model + output parsers
    bookmark_test.go       — Bookmark parser tests
    file_change.go         — FileChange model, DiffStat/DiffSummary parsers, MergeStats
    file_change_test.go    — Parser edge case tests (binary, rename, suffix fallback, conflicts)
    selected_revisions.go  — Multi-revision selection helper
    workspace_store.go     — Protobuf parser for .jj/repo/workspace_store/index (name→path map)
    workspace_store_test.go — Parser tests with real binary data
  runner/                  — CommandRunner interface + implementations
    runner.go              — Interface definition (Run, RunWithInput, Stream)
    local.go               — LocalRunner: exec("jj", args) with configurable Binary
    ssh.go                 — SSHRunner: wraps jj args in ssh command
    ssh_test.go            — SSH arg escaping tests
  api/                     — HTTP handlers
    server.go              — Route registration, runMutation, op-id caching, workspace spawning, helpers
    handlers.go            — All endpoint implementations, flag validation
    handlers_test.go       — Handler tests with MockRunner
    integration_test.go    — Integration tests (build-tagged)
  parser/                  — Graph log parser
    graph.go               — Parses jj log graph output with _PREFIX: markers into GraphRow[]
    graph_test.go          — Graph parser tests
testutil/                  — Test infrastructure
  mock_runner.go           — MockRunner with Expect(args)/Verify() pattern
frontend/                  — Svelte 5 SPA (Vite + TypeScript + pnpm)
  src/App.svelte           — Main app shell: layout, keyboard handling, state management
  src/lib/
    api.ts                 — Typed API client, op-id tracking, two-tier cache (mutable + immutable)
    api.test.ts            — API client tests
    RevisionGraph.svelte   — Revision list with graph gutter rendering
    DiffPanel.svelte       — Diff viewer: unified/split toggle, syntax highlighting
    DiffFileView.svelte    — Individual file diff with collapsible sections, context expansion
    DescriptionEditor.svelte — Inline commit message editor
    CommandPalette.svelte  — Fuzzy-search command palette (Cmd+K)
    ContextMenu.svelte     — Reusable right-click context menu (positioned at cursor)
    StatusBar.svelte       — Bottom status bar with mode indicators and shortcuts
    BookmarkModal.svelte   — Bookmark management modal
    BookmarkInput.svelte   — Bookmark name input with autocomplete
    GitModal.svelte        — Git push/fetch modal
    EvologPanel.svelte     — Evolution log panel
    OplogPanel.svelte      — Operation log panel
    DivergencePanel.svelte — Divergent commit resolution panel (compare versions, keep/abandon)
    diff-parser.ts         — Unified diff parser
    conflict-parser.ts     — jj conflict marker parser (<<<, %%%, +++, >>>)
    split-view.ts          — Side-by-side diff alignment
    word-diff.ts           — Word-level inline diff computation
    highlighter.ts         — Shiki syntax highlighting integration
    fuzzy.ts               — Fuzzy string matching
    group-by.ts            — groupByWithIndex utility for per-file match scoping
    loader.svelte.ts       — createLoader() async factory with generation counter
    modes.svelte.ts        — Rebase/squash/split mode state factories
    config.svelte.ts       — Reactive config singleton synced to localStorage
    recent-actions.svelte.ts — localStorage-backed frequency counter for bookmarks
  vite.config.ts           — Dev proxy + build output to ../cmd/lightjj/frontend-dist/
```

## Code Conventions

### Go backend

- **Command builders are pure functions.** `internal/jj/commands.go` takes parameters, returns `[]string`. No execution, no config reads, no globals. If you need a new jj command, add a function here.
- **Never call `exec.Command` outside of `internal/runner/`.** All jj execution goes through the `CommandRunner` interface.
- **Test with MockRunner.** Use `testutil.NewMockRunner(t)` with `.Expect(args).SetOutput(output)` and `defer runner.Verify()`. See existing tests for the pattern. Also supports `SetExpectedStdin()`, `SetError()`, and `Allow()` for flexible matching.
- **API handlers are thin.** Parse request → call command builder → call runner → return JSON. No business logic in handlers.
- **Mutation handlers use `runMutation()`.** Centralizes run + async op-id refresh. Exception: `handleDescribe` uses `RunWithInput` directly.
- **Validate POST inputs.** All POST handlers check required fields and return 400 on empty values.
- **Validate flags.** `validateFlags()` whitelists allowed `--` and `-` flags for git push/fetch. Reject anything not in the allowed set.
- **Rebase API accepts `source_mode` and `target_mode` params.** `source_mode` maps to `-r`/`-s`/`-b`; `target_mode` maps to `-d`/`--insert-after`/`--insert-before`.
- **Use `--tool :git`** when requesting diff output for the web API. Users may have external diff formatters (difftastic) configured that output ANSI codes.
- **Use `--color never`** for any jj output the backend will parse. Use `--color always` only if passing through to a terminal.
- **Use `\x1F` (unit separator)** as the field delimiter in jj templates, not tabs. Tabs can appear in commit descriptions and break parsing.
- **Parsers return empty slices, not nil.** This ensures JSON serialization produces `[]` not `null`.
- **`NewServer(runner, repoDir)`** takes the resolved repo dir as second arg. Pass `""` for SSH mode or tests. The `RepoDir` enables workspace store reading and child process spawning.
- **Workspace store parser** (`internal/jj/workspace_store.go`) manually parses protobuf wire format — no protobuf dependency. The `.jj/repo/workspace_store/index` file has a simple schema: `repeated Entry { string name = 1; string path = 2; }`.
- **Child process spawning** (`spawnWorkspaceInstance`) validates paths (`filepath.IsAbs` + directory existence), deduplicates by workspace name, and reaps zombies via `go cmd.Wait()`. `Server.Shutdown()` kills all children on SIGINT/SIGTERM.

### Svelte frontend

- **Svelte 5 runes** — use `$state()`, `$derived()`, `$effect()`. No Svelte 4 stores.
- **api.ts is the single API boundary** — all backend calls go through the `api` object in `src/lib/api.ts`. Don't use raw `fetch()` in components.
- **pnpm, not npm** — the project uses pnpm for package management.
- **Graph rendering uses flattened lines.** Each graph line (node or connector) is its own DOM row at identical height. Node lines show commit content; description lines show the description; connector lines are just gutter characters. This ensures pixel-perfect continuous graph pipes. **Graph rows use a fixed `height: 18px`** to guarantee identical sizing across all modes (normal, rebase, squash, split). This prevents inline badges, buttons, or text from influencing row height. All inline elements (badges, `@` indicator, action buttons) must fit within 18px. Content is clipped by `overflow: hidden`. Never change this to `min-height` or remove the fixed height — it's the only way to prevent sub-pixel height differences between modes that break graph pipe continuity.
- **Change IDs show full short form with highlighted prefix.** `commit.change_prefix` determines how many characters to highlight. Same for `commit_prefix`.
- **Rebase mode is inline, not a modal.** Press `R` to enter rebase mode. `j`/`k` navigate the destination; Enter executes; Escape cancels. Source mode (`r`/`s`/`b`) and target mode (`o`/`a`/`i`) can be switched while in rebase mode. Source and destination commits are marked with inline badges directly in the revision graph.
- **Immutable commits** (`◆` in jj graph output) are dimmed in the UI. Mutable `○` nodes use graph palette colors; working-copy `@` is an amber concentric circle. Graph colors come from `--graph-N` CSS vars (Tier 3: muted, decorative) with opacity-based hover (lines 0.45→0.7, nodes 0.8→1.0).
- **View mode toggle** — The revision panel header has a Log/Tracked toggle (click or command palette). Tracked view uses the `tracked_remote_bookmarks()` revset to show remote work. `t` key toggles theme.
- **Divergent commit handling** — Commits with `divergent: true` share the same `change_id`. Use `effectiveId(commit)` (from `api.ts`) for all identity operations (keys, checks, mutations) — it falls back to `commit_id` for divergent/hidden commits, mirroring Go's `Commit.GetChangeId()`. Display of `change_id` itself is fine (shows the shared ID). The DivergencePanel uses `change_id(X)` revset (not `all:X` which doesn't exist in jj 0.38) to query all versions. Divergence offsets (`/0`, `/1`) are computed client-side by sorting commit IDs lexicographically, matching jj's convention.
- **Top toolbar (no sidebar)** — Navigation, workspace selector, search trigger, and action buttons live in a compact top toolbar in `App.svelte`. Nav tabs (`◉ Revisions`, `⑂ Branches`, `⟲ Operations`) switch views; keyboard shortcuts `1`/`2`/`3` still work. Workspace selector uses `◇` glyph with dropdown for multi-workspace repos (`w` key toggles). `GET /api/workspaces` returns `{ current, workspaces[] }` (enriched with paths from workspace store). `POST /api/workspace/open` spawns a child lightjj instance. SSH mode gracefully degrades (no paths, no spawning).

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
4. Register the route in `internal/api/server.go` → `routes()`
5. Add handler tests in `internal/api/handlers_test.go`
6. Add the API call to `frontend/src/lib/api.ts`
7. Wire it into the Svelte UI

## Svelte Frontend Performance

Patterns learned from profiling j/k keyboard navigation:

- **Scope `:hover` to exclude `.selected`.** Use `.row:hover:not(.selected)` to prevent visual artifacts when mouse hover and keyboard selection overlap.
- **Debounce expensive work, not the selection state.** Update `selectedIndex` synchronously for instant visual feedback. Debounce network fetches (~50ms). Skip debounce on cache hits — `isCached()` checks all three (diff, files, desc); returning true for a partial cache hit defeats the debounce.
- **`createLoader()` factory** (`loader.svelte.ts`) encapsulates the generation-counter race-safe async pattern. Its `loading` flag is deferred via `setTimeout(0)` so cache hits (microtask-fast) never flip it — zero reactive updates on cached j/k navigation. Use `loader.set()` for optimistic updates, `loader.reset()` to cancel + restore initial.
- **Guard `$derived` in hidden components.** `CommandPalette`'s `availableCommands` uses `if (!open) return []` to avoid recomputing when the palette is closed but its `commands` prop changes.
- **Defer Shiki highlighting.** `highlightDiff` is called via `setTimeout(fn, 0)` so the browser paints the selection highlight before Shiki runs. The diff renders immediately with plain text; syntax colors appear one frame later.
- **Progressive highlighting.** `highlightDiff` yields between files (`setTimeout(0)`) and updates `highlightsByFile` per-file. Already-highlighted files keep their inner Map reference, so only newly-highlighted `DiffFileView`s re-render.
- **`user-select: none`** on interactive lists prevents text selection artifacts during click/keyboard navigation.
- **Svelte 5 effects run after DOM updates** — no need for `requestAnimationFrame` to query updated DOM in `$effect`.
- **Fire-and-forget async in effects is fine** when the async function has its own error handling and generation counter for cancellation.
- **Skip word-diff for non-code files.** `shouldSkipWordDiff()` in DiffPanel skips LCS computation for SVG/XML/JSON/lock/map/minified files and any file with >1000 diff lines.
- **Progressive word diffs.** `computeAllWordDiffs` yields between files (`setTimeout(0)`) and publishes per-file `wordDiffsByFile` entries incrementally (same pattern as Shiki). Single-file context expansion only recomputes that file's word diffs.
- **Auto-collapse large files.** Files with >500 diff lines (`AUTO_COLLAPSE_LINE_LIMIT`) start collapsed to prevent DOM flooding. Collapse state is cached per revision; auto-collapse is suppressed when restoring from cache.
- **Diff parser uses `b/` (destination) path** from `diff --git a/source b/destination` headers. The `a/` path is the source and can appear in multiple entries for copies/renames, causing duplicate `{#each}` keys.
