# lightjj

A fast, keyboard-driven browser UI for [Jujutsu (jj)](https://github.com/jj-vcs/jj). Single static binary — `go install` and open your repo.

![lightjj screenshot](screenshot.png)

## Why

**Instant.** Navigation is tuned end-to-end: `commit_id`-keyed caching means `j`/`k` through history hits no network, diffs syntax-highlight progressively so the UI never blocks, and opportunistic prefetch keeps the next revision warm. No spinners on the hot path.

**Works everywhere.** Run it locally, port-forward it from a remote dev box, or proxy it over SSH. Same UX. Auto-refresh watches `.jj/repo/op_heads` for instant reaction to CLI changes — polling fallback in SSH mode with no remote dependencies.

**Multi-repo, multi-workspace.** Tabs. Open additional repos with `+`, jj workspaces open one-click via the `◇` selector. Tab state persists across restarts; diff cache is shared across same-repo workspaces.

**Complete jj coverage.** Revision graph, bookmarks panel with full sync state, op log, evolog, divergence resolution, inline rebase/squash/split with source/target mode cycling. Right-click menus everywhere. Revset filter with `?` help popover.

**A real merge tool.** Conflicted files open in a 3-pane editor — `ours ← result → theirs` — with per-hunk arrow-click, arbitrary editing in the center, and undo that restores the source tag. Falls back to raw editor for >2-side or git-style conflicts.

## Quick Start

```bash
go install github.com/chronologos/lightjj/cmd/lightjj@latest
cd /path/to/your/jj/repo
lightjj
```

## Highlights

- **Revision graph** — SVG DAG, working-copy `@` indicator, immutable `◆` markers, bookmark badges with PR status, conflicted-bookmark `??` markers
- **Diff viewer** — unified/split, Lezer syntax highlighting, word-level diffs, context expansion, conflict A/B labels, open-in-$EDITOR
- **3-pane merge** — `ours ← result → theirs`; arrow to take hunk, type to edit, undo restores source tag
- **Divergence resolver** — stack-aware `??/N` analysis with per-column keep/abandon/squash strategies and bookmark repointing
- **Inline rebase** — pick source (`-r`/`-s`/`-b`) and target (onto/after/before) modes, cursor to destination, Enter
- **Bookmarks panel** (`2`) — sync state at a glance: ahead/behind/diverged/conflict, PR badges, staleness. `d`/`f`/`t` for delete/forget/track, per-remote visibility toggles
- **Multi-select** — batch abandon, squash, rebase across revisions with `Space`
- **Op log & evolog** — full operation history with undo/restore, per-revision evolution with inter-diffs
- **Inline annotations** — per-line review comments keyed by `change_id`; auto-re-anchor on rewrite; export markdown/JSON
- **Stale-WC detection** — concurrent CLI op left the working copy stale? Warning bar with one-click recovery
- **Themes** — Catppuccin dark/light (`t` to toggle)

## Agent review loop

1. Agent writes code into a jj revision
2. You review in lightjj — right-click any diff line → **Annotate** → pick severity, leave comment
3. `Cmd+K` → **Export annotations (markdown)** → paste into agent prompt
4. Agent iterates on the same `change_id` (jj's evolog captures every step)
5. lightjj auto-refreshes; annotations re-anchor via inter-diff delta — unchanged lines track, deleted lines surface as "possibly addressed"
6. Repeat until the revision is clean

See [docs/ANNOTATIONS.md](docs/ANNOTATIONS.md) for re-anchor mechanics and storage model.

## Usage

```bash
lightjj                            # serve current repo, open browser
lightjj -R /path/to/repo           # explicit repo path
lightjj --remote user@host:/path   # SSH proxy mode
lightjj --no-browser               # don't auto-open browser
lightjj --addr localhost:8080      # custom listen address
```

### Remote repos

**Recommended:** run lightjj on the remote and port-forward — local-quality latency with full auto-refresh:

```bash
ssh -L 3001:localhost:3001 user@host \
  "lightjj -R /path/to/repo --addr localhost:3001 --no-browser"
# open http://localhost:3001 locally
```

`--remote user@host:/path` also works but adds ~400ms per command. Enable SSH ControlMaster to reduce this to ~20ms. Auto-refresh polls every `--snapshot-interval` (default 5s) — the poll snapshots the remote working copy, so editor saves on the remote host appear in the diff without running `jj` there. No remote dependencies.

In `--remote` mode, `gh pr list` is also run over SSH — install and `gh auth login` on the remote host if you want PR badges on bookmarks.

## Roadmap

| | Theme | |
|---|---|---|
| **1.0** | Ship-ready core | ✓ |
| **2.0** | Code editing & review | Hunk-level accept/reject (`jj split --tool` protocol), mega-file virtualization, cross-revision search, LSP-in-FileEditor |
| **3.0** | Agentic | Annotations as a library, agent-writable API, auto-re-anchor, MCP server mode |

## Requirements

- **jj >= 0.39**
- **Go >= 1.21** (build from source)
- **gh** (optional) — for PR badges. Must be installed and authed wherever the repo lives (remote host when using `--remote`)

## Development

```bash
# Two terminals:
go run ./cmd/lightjj --addr localhost:3000 --no-browser   # backend
cd frontend && pnpm run dev                                # frontend (Vite HMR)

# Tests
go test ./...              # Go
cd frontend && pnpm test   # Vitest
```

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for system design and [docs/CONFIG.md](docs/CONFIG.md) for config fields and open-in-editor setup.

## Upstream

Core command builder patterns ported from [jjui](https://github.com/idursun/jjui).
