# jj-web

Browser-based UI for Jujutsu (jj) version control. Inspired by [jjui](https://github.com/idursun/jjui) TUI.

## Architecture

- **Go backend** — serves API + embedded static frontend
- **Svelte frontend** — SPA, built to static files
- **CommandRunner interface** — abstraction over jj CLI execution
  - `LocalRunner` — local subprocess (`jj <args>`)
  - `SSHRunner` — remote via SSH (`ssh host "jj -R path <args>"`)

### Key design: Command builder / runner separation

Command builders (`internal/jj/commands.go`) are pure functions that return `[]string`.
Runners (`internal/runner/`) execute them. Tests use `testutil.MockRunner`.

This pattern is ported from jjui's `internal/jj/commands.go` + `internal/ui/context/command_runner.go`.

## Build & Test

```bash
go test ./...          # Run all tests
go vet ./...           # Static analysis
go build ./cmd/jj-web  # Build binary (once cmd exists)
```

## Project Structure

```
internal/
  jj/       — Command builders + data models (pure, no side effects)
  runner/   — CommandRunner interface + LocalRunner + SSHRunner
testutil/   — MockRunner with expect/verify pattern
frontend/   — Svelte SPA (TODO)
cmd/        — CLI entry point (TODO)
```

## Testing

- Use `testutil.NewMockRunner(t)` with `.Expect()` / `.Verify()` for unit tests
- Integration tests use real jj repos in temp dirs
- Pattern ported from jjui's `test/test_command_runner.go`
