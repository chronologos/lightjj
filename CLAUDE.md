# jj-web

Browser-based UI for Jujutsu (jj) version control. See [ARCHITECTURE.md](ARCHITECTURE.md) for system design and diagrams.

## Build & Test

```bash
# Run all Go tests
go test ./...

# Static analysis
go vet ./...

# Build frontend (requires pnpm)
cd frontend && pnpm install && pnpm run build

# Build binary (requires frontend build first — output embeds static files)
go build ./cmd/jj-web

# Development mode (two terminals):
#   Terminal 1: go run ./cmd/jj-web --addr localhost:3000 --no-browser
#   Terminal 2: cd frontend && pnpm run dev
# Vite proxies /api/* to localhost:3000
```

## Project Structure

```
cmd/jj-web/main.go     — CLI entry point, flag parsing, embeds frontend-dist/
internal/
  jj/                  — Command builders + data models (PURE — no I/O, no side effects)
    commands.go        — Functions that return []string args for jj subcommands
    commit.go          — Commit data model
    bookmark.go        — Bookmark model + output parsers
    selected_revisions.go — Multi-revision selection helper
  runner/              — CommandRunner interface + implementations
    runner.go          — Interface definition (Run, RunWithInput, Stream)
    local.go           — LocalRunner: exec("jj", args) with configurable Binary
    ssh.go             — SSHRunner: wraps jj args in ssh command
  api/                 — HTTP handlers
    server.go          — Route registration, helper functions
    handlers.go        — All endpoint implementations + LogEntry parser
testutil/              — Test infrastructure
  mock_runner.go       — MockRunner with Expect(args)/Verify() pattern
frontend/              — Svelte 5 SPA (Vite + TypeScript + pnpm)
  src/App.svelte       — Main UI component
  src/lib/api.ts       — Typed API client (mirrors Go endpoints 1:1)
  vite.config.ts       — Dev proxy + build output to ../cmd/jj-web/frontend-dist/
```

## Code Conventions

### Go backend

- **Command builders are pure functions.** `internal/jj/commands.go` takes parameters, returns `[]string`. No execution, no config reads, no globals. If you need a new jj command, add a function here.
- **Never call `exec.Command` outside of `internal/runner/`.** All jj execution goes through the `CommandRunner` interface.
- **Test with MockRunner.** Use `testutil.NewMockRunner(t)` with `.Expect(args).SetOutput(output)` and `defer runner.Verify()`. See existing tests for the pattern.
- **API handlers are thin.** Parse request → call command builder → call runner → return JSON. No business logic in handlers.
- **Use `--tool :builtin`** when requesting diff output for the web API. Users may have external diff formatters (difftastic) configured that output ANSI codes.
- **Use `--color never`** for any jj output the backend will parse. Use `--color always` only if passing through to a terminal.

### Svelte frontend

- **Svelte 5 runes** — use `$state()`, `$derived()`, `$effect()`. No Svelte 4 stores.
- **api.ts is the single API boundary** — all backend calls go through the `api` object in `src/lib/api.ts`. Don't use raw `fetch()` in components.
- **pnpm, not npm** — the project uses pnpm for package management.

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

## Usage

```bash
jj-web                          # serve current jj repo, open browser
jj-web -R /path/to/repo        # explicit repo path
jj-web --remote user@host:/path # SSH proxy mode
jj-web --no-browser             # don't auto-open browser
jj-web --addr localhost:8080    # specify port
```

## Upstream Reference

Core command builder and test patterns were ported from [jjui](https://github.com/idursun/jjui) (`internal/jj/commands.go`, `test/test_command_runner.go`). The ANSI parser and BubbleTea UI layers were intentionally not ported — we use structured jj output and a browser frontend instead.
