# lightjj

A browser-based UI for [Jujutsu (jj)](https://github.com/jj-vcs/jj) version control.

Jujutsu is a powerful VCS with a steep learning curve. lightjj gives you a visual interface to explore your repo's revision graph, view diffs, manage bookmarks, and perform operations like rebase, squash, and describe — all from your browser, driven by keyboard shortcuts.

## Features

- **Revision graph** — pixel-perfect DAG rendered from jj's graph output, with colored gutter symbols (`@` green for working copy, `○` blue for mutable, `◆` dimmed for immutable)
- **Diff viewer** — unified and split (side-by-side) modes, collapsible file sections, word-level inline diff highlighting, syntax highlighting via Shiki, context expansion at hunk boundaries
- **Keyboard-first** — `j`/`k` navigation, single-key operations (`n` new, `e` describe, `u` undo, `R` rebase, `S` squash), command palette (`Cmd+K`)
- **Inline rebase** — press `R` to enter rebase mode directly in the graph. Pick source mode (`-r`/`-s`/`-b`) and target mode (`-d`/`--insert-after`/`--insert-before`) with keyboard shortcuts. `j`/`k` to move the destination cursor, `Enter` to execute
- **Squash** — select files to squash between revisions, with keep-emptied and use-dest-message options
- **Bookmarks** — set, delete, move, forget, track, untrack
- **Git integration** — push and fetch with flag validation
- **Multi-select** — batch operations across multiple revisions
- **Operation log** — view jj's operation history
- **Evolution log** — per-revision evolution history
- **Workspace support** — detect and display jj workspaces with badges
- **Revset filter** — filter the revision graph with any jj revset expression
- **Log/Tracked toggle** — switch between full log and remote-tracked bookmarks view
- **Themes** — Catppuccin Mocha (dark) and Latte (light), toggle via command palette
- **SSH remote mode** — proxy jj commands over SSH to work with remote repositories
- **Single binary** — frontend is embedded in the Go binary, no Node.js runtime needed

## Requirements

- **jj >= 0.38** — older versions may lack template/CLI flags the backend depends on
- **Go >= 1.21** — for building from source
- **pnpm** — for frontend development

## Quick Start

```bash
# Install
go install github.com/iant/lightjj/cmd/lightjj@latest

# Or build from source
git clone https://github.com/iant/lightjj
cd lightjj
cd frontend && pnpm install && pnpm run build && cd ..
go build ./cmd/lightjj

# Run
cd /path/to/your/jj/repo
lightjj
```

## Usage

```bash
lightjj                            # serve current jj repo, open browser
lightjj -R /path/to/repo           # explicit repo path
lightjj --remote user@host:/path   # SSH proxy mode
lightjj --no-browser               # don't auto-open browser
lightjj --addr localhost:8080      # specify listen address
```

## Development

Two terminals:

```bash
# Terminal 1: Go backend
go run ./cmd/lightjj --addr localhost:3000 --no-browser

# Terminal 2: Svelte frontend (Vite dev server with hot reload)
cd frontend && pnpm run dev
```

Vite proxies `/api/*` requests to `localhost:3000`.

```bash
# Run tests
go test ./...                      # Go backend tests
cd frontend && pnpm test           # Frontend tests (Vitest)

# Static analysis
go vet ./...
```

## Architecture

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for system design, data flow diagrams, and key design decisions.

## Project Structure

```
cmd/lightjj/          CLI entry point, embeds frontend build
internal/
  jj/                 Command builders + data models (pure, no I/O)
  runner/             CommandRunner interface (local + SSH)
  api/                HTTP handlers
  parser/             Graph log parser
frontend/             Svelte 5 SPA (Vite + TypeScript + pnpm)
  src/App.svelte      Main application shell
  src/lib/            Components, API client, utilities
```

## Keyboard Shortcuts

| Key | Action |
|-----|--------|
| `j` / `k` | Navigate revisions |
| `Enter` | Select revision |
| `n` | New revision |
| `e` | Edit description |
| `u` | Undo |
| `R` | Enter rebase mode |
| `S` | Enter squash mode |
| `t` | Toggle Log/Tracked view |
| `/` | Focus revset filter |
| `Cmd+K` | Command palette |
| `Esc` | Cancel current mode |

## Upstream

Core command builder patterns ported from [jjui](https://github.com/idursun/jjui). Diff viewer patterns informed by internal code review tooling.
