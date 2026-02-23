# lightjj

Browser-based UI for Jujutsu (jj) version control. See [ARCHITECTURE.md](ARCHITECTURE.md) for system design and diagrams, [BACKLOG.md](BACKLOG.md) for planned features.

## Build & Test

```bash
# Run all Go tests
go test ./...

# Static analysis
go vet ./...

# Build frontend (requires pnpm)
cd frontend && pnpm install && pnpm run build

# Build binary (requires frontend build first — output embeds static files)
go build ./cmd/lightjj

# Development mode (two terminals):
#   Terminal 1: go run ./cmd/lightjj --addr localhost:3000 --no-browser
#   Terminal 2: cd frontend && pnpm run dev
# Vite proxies /api/* to localhost:3000
```

## Project Structure

```
cmd/lightjj/main.go     — CLI entry point, flag parsing, embeds frontend-dist/
internal/
  jj/                  — Command builders + data models (PURE — no I/O, no side effects)
    commands.go        — Functions that return []string args for jj subcommands
    commit.go          — Commit model with ChangePrefix/CommitPrefix for highlighted IDs
    bookmark.go        — Bookmark model + output parsers
    file_change.go     — FileChange model, DiffStat/DiffSummary parsers, MergeStats
    selected_revisions.go — Multi-revision selection helper
  runner/              — CommandRunner interface + implementations
    runner.go          — Interface definition (Run, RunWithInput, Stream)
    local.go           — LocalRunner: exec("jj", args) with configurable Binary
    ssh.go             — SSHRunner: wraps jj args in ssh command
  api/                 — HTTP handlers
    server.go          — Route registration, MaxBytesReader, helper functions
    handlers.go        — All endpoint implementations, flag validation
  parser/              — Graph log parser
    graph.go           — Parses jj log graph output with _PREFIX: markers into GraphRow[]
testutil/              — Test infrastructure
  mock_runner.go       — MockRunner with Expect(args)/Verify() pattern
frontend/              — Svelte 5 SPA (Vite + TypeScript + pnpm)
  src/App.svelte       — Main UI: graph view, diff viewer (unified+split), collapsible files
  src/lib/api.ts       — Typed API client (mirrors Go endpoints 1:1)
  vite.config.ts       — Dev proxy + build output to ../cmd/lightjj/frontend-dist/
```

## Code Conventions

### Go backend

- **Command builders are pure functions.** `internal/jj/commands.go` takes parameters, returns `[]string`. No execution, no config reads, no globals. If you need a new jj command, add a function here.
- **Never call `exec.Command` outside of `internal/runner/`.** All jj execution goes through the `CommandRunner` interface.
- **Test with MockRunner.** Use `testutil.NewMockRunner(t)` with `.Expect(args).SetOutput(output)` and `defer runner.Verify()`. See existing tests for the pattern.
- **API handlers are thin.** Parse request → call command builder → call runner → return JSON. No business logic in handlers.
- **Validate POST inputs.** All POST handlers check required fields and return 400 on empty values.
- **Validate flags.** `validateFlags()` whitelists allowed `--` and `-` flags for git push/fetch. Reject anything not in the allowed set.
- **Use `--tool :git`** when requesting diff output for the web API. Users may have external diff formatters (difftastic) configured that output ANSI codes.
- **Use `--color never`** for any jj output the backend will parse. Use `--color always` only if passing through to a terminal.
- **Use `\x1F` (unit separator)** as the field delimiter in jj templates, not tabs. Tabs can appear in commit descriptions and break parsing.
- **Parsers return empty slices, not nil.** This ensures JSON serialization produces `[]` not `null`.

### Svelte frontend

- **Svelte 5 runes** — use `$state()`, `$derived()`, `$effect()`. No Svelte 4 stores.
- **api.ts is the single API boundary** — all backend calls go through the `api` object in `src/lib/api.ts`. Don't use raw `fetch()` in components.
- **pnpm, not npm** — the project uses pnpm for package management.
- **Graph rendering uses flattened lines.** Each graph line (node or connector) is its own DOM row at identical height. Node lines show commit content; description lines show the description; connector lines are just gutter characters. This ensures pixel-perfect continuous graph pipes.
- **Change IDs show full short form with highlighted prefix.** `commit.change_prefix` determines how many characters to highlight. Same for `commit_prefix`.

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

    srv := api.NewServer(runner)
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

## Requirements

- **jj ≥ 0.38** — older versions may lack template/CLI flags the backend depends on.

## Usage

```bash
lightjj                          # serve current jj repo, open browser
lightjj -R /path/to/repo        # explicit repo path
lightjj --remote user@host:/path # SSH proxy mode
lightjj --no-browser             # don't auto-open browser
lightjj --addr localhost:8080    # specify port
```

## Svelte Frontend Performance

Patterns learned from profiling j/k keyboard navigation:

- **No CSS transitions on keyboard-navigated lists.** `transition: background 0.1s ease` on list rows makes selection feel sluggish. Instant background changes feel responsive.
- **Scope `:hover` to exclude `.selected`.** Use `.row:hover:not(.selected)` to prevent visual artifacts when mouse hover and keyboard selection overlap.
- **Debounce expensive work, not the selection state.** Update `selectedIndex` synchronously for instant visual feedback. Debounce network fetches and derived computations (diff loading, file loading) with a short timer (~50ms). Skip debounce on cache hits.
- **Guard state assignments with equality checks.** `if (diffContent !== result.diff) diffContent = result.diff` prevents the entire `$derived` chain (`parsedDiff` → `wordDiffMap` → `highlightDiff`) from re-running when the value hasn't changed (e.g., cache hits returning the same reference).
- **Guard `$derived` in hidden components.** `CommandPalette`'s `filteredCommands` uses `if (!open) return []` to avoid recomputing when the palette is closed but its `commands` prop changes.
- **Defer Shiki highlighting.** `highlightDiff` is called via `setTimeout(fn, 150)` so syntax highlighting doesn't block the keydown → paint path. The diff renders immediately with plain text + word-diff spans; syntax colors appear progressively ~150ms later.
- **Progressive highlighting.** `highlightDiff` yields between files (`setTimeout(0)`) and updates `highlightedLines` after each file. This prevents Shiki from blocking the main thread for large diffs (5000+ lines) and lets colors appear incrementally.
- **`user-select: none`** on interactive lists prevents text selection artifacts during click/keyboard navigation.
- **Svelte 5 effects run after DOM updates** — no need for `requestAnimationFrame` to query updated DOM in `$effect`.
- **Fire-and-forget async in effects is fine** when the async function has its own error handling and generation counter for cancellation.

## Upstream Reference

Core command builder and test patterns were ported from [jjui](https://github.com/idursun/jjui) (`internal/jj/commands.go`, `test/test_command_runner.go`). The ANSI parser and BubbleTea UI layers were intentionally not ported — we use structured jj output and a browser frontend instead.

Diff viewer patterns (split view, collapsible files, diff stats) were informed by [antique](~/src/large-repo/antique), an internal code review tool.
