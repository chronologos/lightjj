# Architecture

## Overview

lightjj is a browser-based UI for the Jujutsu (jj) version control system. It follows a two-process model: a Go backend that shells out to `jj` CLI, and a Svelte SPA frontend served as embedded static files.

```
┌──────────────────────────────────────────────────────────────────┐
│  Browser                                                         │
│  ┌────────────────────────────────────────────────────────────┐  │
│  │  Svelte SPA (frontend/)                                    │  │
│  │  ┌──────────────────┐ ┌──────────┐ ┌────────────────────┐ │  │
│  │  │  RevisionGraph   │ │ DiffPanel│ │ DescriptionEditor  │ │  │
│  │  └────────┬─────────┘ └─────┬────┘ └─────────┬──────────┘ │  │
│  │           └─────────────────┴────────────────┘            │  │
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
│  │  │  GET  /api/log, /api/diff, /api/files, /api/status   │  │ │
│  │  │       /api/bookmarks, /api/description, /api/remotes  │  │ │
│  │  │       /api/oplog, /api/evolog, /api/workspaces        │  │ │
│  │  │  POST /api/new, /api/edit, /api/abandon, /api/undo   │  │ │
│  │  │       /api/rebase, /api/squash, /api/describe         │  │ │
│  │  │       /api/bookmark/{set,delete,move,forget,track,    │  │ │
│  │  │                      untrack}                         │  │ │
│  │  │       /api/git/push, /api/git/fetch                   │  │ │
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

Also contains data models and parsers:
- `Commit` — includes `ChangePrefix`/`CommitPrefix` for highlighted IDs, `Immutable` bool (from `◆` glyph), `WorkingCopies []string` (for multi-workspace display)
- `Bookmark` — bookmark model + output parsers
- `FileChange` — file change model, `DiffStat`/`DiffSummary` parsers
- `SelectedRevisions` — multi-revision selection helper
- `Workspace` — workspace model + parser

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

Thin HTTP handlers. Each handler: parses request → calls command builder → executes via runner → returns JSON. No business logic — just plumbing.

The server includes an operation ID cache (`cachedOp`) that tracks jj's current operation. Every JSON response includes an `X-JJ-Op-Id` header. Mutation endpoints refresh the cache asynchronously via `runMutation()`, which centralizes the post-mutation pattern (run command → refresh op ID → return output).

Handlers use `httptest.NewRecorder` + `testutil.MockRunner` for testing, so they never touch a real jj process in tests.

### Graph Parser (`internal/parser/`)

Parses `jj log` graph output (with `_PREFIX:` field markers and `\x1F` field delimiters) into `[]GraphRow` structs. Each row contains the graph gutter characters and parsed commit data. The parser detects node glyphs (`◆` immutable, `○` mutable, `@` working copy, `×` conflicted, `◌` hidden) and sets the corresponding flags on the `Commit` struct.

### Frontend (`frontend/`)

Svelte 5 SPA using runes (`$state`, `$derived`). Built with Vite, output goes to `cmd/lightjj/frontend-dist/`. In production, files are embedded in the Go binary via `//go:embed`. In development, Vite's dev server proxies `/api` to the Go backend.

`src/lib/api.ts` is a typed client that mirrors the Go API endpoints 1:1. It tracks the `X-JJ-Op-Id` header from responses and fires stale callbacks when the operation ID changes, triggering automatic cache invalidation and log refresh.

## Data Flow

### Read path (e.g., viewing log)

```
User opens app
  → Svelte calls api.log()
  → fetch GET /api/log?revset=...
  → Go handler calls jj.LogGraph(revset) → ["log", "--template", ..., "\x1F"-delimited]
  → runner.Run(ctx, args) → exec jj subprocess
  → parser.ParseGraphLog(output) → []GraphRow with parsed Commits
  → JSON response with X-JJ-Op-Id header → Svelte renders revision graph
```

### Write path (e.g., rebase)

```
User triggers rebase (inline mode, Enter key)
  → Svelte calls api.rebase({revisions, destination, source_mode, target_mode})
  → fetch POST /api/rebase with JSON body
  → Go handler decodes body, builds SelectedRevisions
  → calls jj.Rebase(...) → ["rebase", "-r"|"-s"|"-b", "abc", "-d"|"--insert-after"|"--insert-before", "def"]
  → runMutation(ctx, args) → Run + async refreshOpId
  → returns {output} with new X-JJ-Op-Id → Svelte detects op change, refreshes log
```

### State synchronization

Every API response carries an `X-JJ-Op-Id` header with jj's current operation ID. The frontend tracks this value; when it changes (due to mutations from the UI or external CLI usage detected on next request), the API client clears its cache and fires stale callbacks that trigger a log refresh.

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
│  Frontend unit tests (Vitest)                   │
│  ├── API client: fetch mocking, error handling, │
│  │   op-id tracking, cache invalidation         │
│  ├── Diff parser: unified diff parsing          │
│  ├── Split view: side-by-side alignment         │
│  ├── Word diff: inline diff computation         │
│  └── Fuzzy search: command palette matching     │
├─────────────────────────────────────────────────┤
│  Integration tests (real jj repo in tmpdir)     │
│  └── TODO                                       │
└─────────────────────────────────────────────────┘
```

The `testutil.MockRunner` uses an expect/verify pattern:

```go
runner := testutil.NewMockRunner(t)
runner.Expect(jj.Abandon(revs, false)).SetOutput([]byte("ok"))
defer runner.Verify()  // asserts all expectations called
```

## Key Design Decisions

1. **Shell out to jj, don't link it** — jj is written in Rust with no stable library API. Shelling out is what jjui does too, and it works well. The CommandRunner interface makes this testable.

2. **Structured output with graph parsing** — The backend uses `jj log` with a custom `--template` that outputs `\x1F`-delimited fields. The graph parser (`internal/parser/`) parses both the graph gutter characters and the structured field data from each line. This gives us the full DAG visualization from jj's own graph renderer, combined with structured commit data.

3. **Embed frontend in binary** — Single binary deployment via `//go:embed`. No Node runtime needed in production.

4. **Two runner implementations, one interface** — Local and SSH execution are swappable at startup. The API layer doesn't know or care which is active.

5. **`--tool :git` for diffs** — Users may have external diff tools configured (e.g., difftastic with `--color=always`). The web API forces jj's git-format diff output to get clean, parseable output.

6. **Immutable commit detection via graph glyphs** — The graph parser checks for `◆` vs `○` vs `@` when parsing node rows. `◆` sets `Immutable: true` on the `Commit` struct. The frontend uses this to dim immutable commits and color gutter symbols (`○` blue, `@` green) without needing a separate API call.

7. **Tracked view** — The revision panel supports a Log/Tracked toggle (`t` key). Tracked view issues a `jj log` request with the `tracked_remote_bookmarks()` revset, giving a focused view of remote branches without changing any global state.

8. **Op-ID staleness detection** — Every response carries `X-JJ-Op-Id`. The frontend detects operation changes and auto-refreshes. Mutation endpoints refresh the cached op-id asynchronously to avoid adding latency.

## Graph View

The graph view uses jj's own graph output, parsed into DOM rows:

- Each graph line (node or connector) is its own DOM row at identical height
- Node lines show commit IDs + description on a second line
- Description lines get a continuation gutter (`│` extended from the node)
- Working copy `@` detected from graph characters, not template functions
- Connector lines are just gutter characters maintaining visual continuity

This approach gives pixel-perfect graph rendering by leveraging jj's graph layout algorithm directly, rather than reimplementing DAG layout in the frontend.
