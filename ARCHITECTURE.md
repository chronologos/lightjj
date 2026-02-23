# Architecture

## Overview

lightjj is a browser-based UI for the Jujutsu (jj) version control system. It follows a two-process model: a Go backend that shells out to `jj` CLI, and a Svelte SPA frontend served as embedded static files.

```
┌──────────────────────────────────────────────────────────────────┐
│  Browser                                                         │
│  ┌────────────────────────────────────────────────────────────┐  │
│  │  Svelte SPA (frontend/)                                    │  │
│  │  ┌──────────────┐ ┌──────────────┐ ┌────────────────────┐ │  │
│  │  │ RevisionList │ │  DiffViewer  │ │  DescriptionEditor │ │  │
│  │  └──────┬───────┘ └──────┬───────┘ └─────────┬──────────┘ │  │
│  │         └────────────────┴───────────────────┘            │  │
│  │                     api.ts                                 │  │
│  └─────────────────────────┬──────────────────────────────────┘  │
│                            │ fetch() JSON                        │
└────────────────────────────┼────────────────────────────────────┘
                             │ http://localhost:PORT/api/*
┌────────────────────────────┼────────────────────────────────────┐
│  Go Backend (cmd/lightjj)   │                                     │
│  ┌─────────────────────────┴──────────────────────────────────┐ │
│  │  HTTP Server (net/http)                                     │ │
│  │  ┌──────────────────────────────────────────────────────┐  │ │
│  │  │  API Handlers (internal/api/)                         │  │ │
│  │  │  GET  /api/log, /api/diff, /api/bookmarks, ...       │  │ │
│  │  │  POST /api/rebase, /api/squash, /api/abandon, ...    │  │ │
│  │  └───────────────────────┬──────────────────────────────┘  │ │
│  │                          │                                  │ │
│  │  ┌───────────────────────┴──────────────────────────────┐  │ │
│  │  │  CommandRunner Interface (internal/runner/)           │  │ │
│  │  │  ┌─────────────────┐    ┌─────────────────────────┐  │  │ │
│  │  │  │  LocalRunner    │    │  SSHRunner               │  │  │ │
│  │  │  │  exec("jj",...) │    │  exec("ssh",host,cmd)    │  │  │ │
│  │  │  └────────┬────────┘    └────────────┬────────────┘  │  │ │
│  │  └───────────┼──────────────────────────┼───────────────┘  │ │
│  └──────────────┼──────────────────────────┼──────────────────┘ │
│                 │                          │                     │
└─────────────────┼──────────────────────────┼─────────────────────┘
                  │                          │
         ┌────────▼────────┐        ┌────────▼────────┐
         │   jj CLI        │        │   ssh → jj CLI  │
         │   (local repo)  │        │   (remote repo) │
         └─────────────────┘        └─────────────────┘
```

## Layer Responsibilities

### Command Builders (`internal/jj/`)

Pure functions with zero side effects. Each function takes parameters and returns a `[]string` of jj CLI arguments. No execution, no I/O.

```go
func Rebase(from SelectedRevisions, to string, ...) CommandArgs
// Returns: ["rebase", "-r", "abc", "-d", "def"]
```

This layer is trivially testable and directly ported from [jjui](https://github.com/idursun/jjui)'s `internal/jj/commands.go`. Also contains data models (`Commit`, `Bookmark`, `SelectedRevisions`) and parsers for jj's output formats.

The `Commit` model includes an `Immutable` bool field, populated by the graph parser when it encounters the `◆` glyph in `jj log` output.

### Command Runner (`internal/runner/`)

Interface with three methods:

```go
type CommandRunner interface {
    Run(ctx, args)            → ([]byte, error)       // synchronous
    RunWithInput(ctx, args, stdin) → ([]byte, error)   // with stdin
    Stream(ctx, args)         → (io.ReadCloser, error) // streaming
}
```

Two implementations:
- **LocalRunner** — executes `jj <args>` as a local subprocess with `Dir` set to the repo path
- **SSHRunner** — wraps jj commands as `ssh <host> "jj -R <path> <args>"`, delegates to LocalRunner with `Binary: "ssh"`

### API Layer (`internal/api/`)

Thin HTTP handlers. Each handler: parses request → calls command builder → executes via runner → returns JSON. No business logic here — just plumbing.

Handlers use `httptest.NewRecorder` + `testutil.MockRunner` for testing, so they never touch a real jj process in tests.

### Frontend (`frontend/`)

Svelte 5 SPA using runes (`$state`, `$derived`). Built with Vite, output goes to `cmd/lightjj/frontend-dist/`. In production, files are embedded in the Go binary via `//go:embed`. In development, Vite's dev server proxies `/api` to the Go backend.

`src/lib/api.ts` is a typed client that mirrors the Go API endpoints 1:1.

## Data Flow

### Read path (e.g., viewing log)

```
User opens app
  → Svelte calls api.log()
  → fetch GET /api/log?revset=...
  → Go handler calls jj.LogJSON(revset, limit) → ["log", "--no-graph", ...]
  → runner.Run(ctx, args) → exec jj subprocess
  → parse tab-delimited output into []LogEntry
  → JSON response → Svelte renders revision list
```

### Write path (e.g., rebase)

```
User triggers rebase
  → Svelte calls api.rebase({revisions, destination, source_mode, target_mode})
  → fetch POST /api/rebase with JSON body
  → Go handler decodes body, builds SelectedRevisions
  → calls jj.Rebase(...) → ["rebase", "-r"|"-s"|"-b", "abc", "-d"|"--insert-after"|"--insert-before", "def"]
  → runner.Run(ctx, args)
  → returns {output} → Svelte refreshes log
```

### Inline rebase UX

Rebase does not use a modal. Instead, pressing `R` activates an inline rebase mode directly in the revision graph. The source commit is marked with a badge; `j`/`k` move a destination cursor through the graph (also badged); Enter fires the API call. Source mode (`-r`/`-s`/`-b`) and target mode (`-d`/`--insert-after`/`--insert-before`) are toggled with keyboard shortcuts while in rebase mode. Escape cancels without any API call.

## Testing Strategy

```
┌─────────────────────────────────────────────────┐
│  Unit tests (no subprocess, no I/O)             │
│  ├── Command builders: args in → []string out   │
│  ├── Data model methods: IsRoot, GetChangeId    │
│  ├── Output parsers: string → structs           │
│  └── SSH arg wrapping: shellQuote               │
├─────────────────────────────────────────────────┤
│  API handler tests (MockRunner, httptest)        │
│  └── Request → expected jj args → mock output   │
│      → assert JSON response                     │
├─────────────────────────────────────────────────┤
│  Integration tests (real jj repo in tmpdir)     │
│  └── TODO: create repo, run commands, verify    │
├─────────────────────────────────────────────────┤
│  Frontend tests (Vitest + testing-library)      │
│  └── TODO: component tests with mocked fetch    │
└─────────────────────────────────────────────────┘
```

The `testutil.MockRunner` uses an expect/verify pattern ported from jjui:

```go
runner := testutil.NewMockRunner(t)
runner.Expect(jj.Abandon(revs, false)).SetOutput([]byte("ok"))
defer runner.Verify()  // asserts all expectations called
```

## Key Design Decisions

1. **Shell out to jj, don't link it** — jj is written in Rust with no stable library API. Shelling out is what jjui does too, and it works well. The CommandRunner interface makes this testable.

2. **Structured output over ANSI parsing** — jjui parses `jj log` terminal output including ANSI escape codes and graph characters. We skip this entirely and use `jj log --template` to get tab-delimited structured data. Graph rendering will be done in SVG on the frontend.

3. **Embed frontend in binary** — Single binary deployment via `//go:embed`. No Node runtime needed in production.

4. **Two runner implementations, one interface** — Local and SSH execution are swappable at startup. The API layer doesn't know or care which is active.

5. **`--tool :builtin` for diffs** — Users may have external diff tools configured (e.g., difftastic with `--color=always`). The web API forces jj's built-in diff formatter to get clean, parseable output.

6. **Immutable commit detection via graph glyphs** — The graph parser checks for `◆` vs `○` vs `@` when parsing node rows. `◆` sets `Immutable: true` on the `Commit` struct. The frontend uses this to dim immutable commits and color gutter symbols (`○` blue, `@` green) without needing a separate API call.

7. **Tracked view** — The revision panel supports a Log/Tracked toggle (`t` key). Tracked view issues a `jj log` request with the `tracked_remote_bookmarks()` revset, giving a focused view of remote branches without changing any global state.
