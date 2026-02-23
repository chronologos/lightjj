# jj-web

Browser-based UI for Jujutsu (jj) version control. Inspired by [jjui](https://github.com/idursun/jjui) TUI.

## Architecture

- **Go backend** — serves API + embedded static Svelte frontend
- **Svelte frontend** — Vite SPA, builds to `cmd/jj-web/frontend-dist/`
- **CommandRunner interface** — abstraction over jj CLI execution
  - `LocalRunner` — local subprocess (`jj <args>`)
  - `SSHRunner` — remote via SSH (`ssh host "jj -R path <args>"`)

### Key design: Command builder / runner separation

Command builders (`internal/jj/commands.go`) are pure functions that return `[]string`.
Runners (`internal/runner/`) execute them. Tests use `testutil.MockRunner`.

## Build & Test

```bash
# Backend
go test ./...          # Run all tests
go vet ./...           # Static analysis

# Frontend
cd frontend && pnpm install && pnpm run build

# Full binary (requires frontend build first)
go build ./cmd/jj-web

# Development (two terminals)
# Terminal 1: go run ./cmd/jj-web --addr localhost:3000 --no-browser
# Terminal 2: cd frontend && pnpm run dev
```

## Project Structure

```
cmd/jj-web/        — CLI entry point, embeds frontend-dist/
internal/
  api/             — HTTP handlers (log, diff, rebase, squash, etc.)
  jj/              — Command builders + data models (pure, no side effects)
  runner/          — CommandRunner interface + LocalRunner + SSHRunner
testutil/          — MockRunner with expect/verify pattern
frontend/          — Svelte SPA (Vite + TypeScript)
  src/lib/api.ts   — Typed API client matching Go endpoints
```

## Testing

- Use `testutil.NewMockRunner(t)` with `.Expect()` / `.Verify()` for unit tests
- API handler tests use `httptest.NewRecorder` + MockRunner
- Pattern ported from jjui's `test/test_command_runner.go`

## Usage

```bash
jj-web                          # serve current jj repo, open browser
jj-web -R /path/to/repo        # explicit repo path
jj-web --remote user@host:/path # SSH proxy mode
jj-web --no-browser             # don't auto-open browser
jj-web --addr localhost:8080    # specify port
```
