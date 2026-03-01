# lightjj

A fast, keyboard-driven browser UI for [Jujutsu (jj)](https://github.com/jj-vcs/jj). Single binary, no Node.js runtime — just `go install` and open your repo.

jj is powerful but its CLI has a learning curve. lightjj gives you a visual revision graph, inline diffs with syntax highlighting, and single-key operations so you can rebase, squash, and manage bookmarks without memorizing flags.

![lightjj screenshot](docs/screenshot.png)

## Quick Start

```bash
go install github.com/chronologos/lightjj/cmd/lightjj@latest
cd /path/to/your/jj/repo
lightjj
```

## Highlights

- **Revision graph** — SVG DAG with working copy indicator, immutable markers, bookmark badges
- **Diff viewer** — unified/split modes, Shiki syntax highlighting, word-level diffs, context expansion
- **Keyboard-first** — `j`/`k` navigate, `R` rebase, `S` squash, `n` new, `e` describe, `Cmd+K` command palette
- **Inline rebase** — pick source (`-r`/`-s`/`-b`) and target mode, move cursor to destination, Enter to execute
- **Bookmarks & git** — set/move/delete/track bookmarks, push/fetch with flag validation
- **Multi-select** — batch operations across revisions
- **Op log & evolog** — operation history and per-revision evolution
- **Workspaces** — detect and switch between jj workspaces
- **SSH remote** — proxy jj commands over SSH, or port-forward for local-quality performance
- **Themes** — Catppuccin dark/light (`t` to toggle)

## Usage

```bash
lightjj                            # serve current repo, open browser
lightjj -R /path/to/repo           # explicit repo path
lightjj --remote user@host:/path   # SSH proxy mode
lightjj --no-browser               # don't auto-open browser
lightjj --addr localhost:8080      # custom listen address
```

### Remote repos

**Recommended:** run lightjj on the remote and port-forward — local-quality performance with full auto-refresh:

```bash
ssh -L 3001:localhost:3001 user@host \
  "lightjj -R /path/to/repo --addr localhost:3001 --no-browser"
# open http://localhost:3001 locally
```

`--remote user@host:/path` works but is slower (~400ms per command). Enable SSH ControlMaster to reduce this to ~20ms.

## Requirements

- **jj >= 0.38**
- **Go >= 1.21** (build from source)

## Development

```bash
# Two terminals:
go run ./cmd/lightjj --addr localhost:3000 --no-browser   # backend
cd frontend && pnpm run dev                                # frontend (Vite HMR)

# Tests
go test ./...              # Go
cd frontend && pnpm test   # Vitest
```

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for system design.

## Upstream

Core command builder patterns ported from [jjui](https://github.com/idursun/jjui).
