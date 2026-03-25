# lightjj

A fast, powerful, single-binary [Jujutsu](https://docs.jj-vcs.dev/latest/community_tools/#lightjj) client.

![lightjj screenshot](screenshot.png)

## Why

**Instant.** `j`/`k` through history with zero latency. Diffs syntax-highlight progressively, prefetch keeps the next revision warm. No spinners on the hot path.

**A real merge tool.** Press `3` for the dedicated Merge view: conflicted files in a navigable queue, 3-pane editor (`ours | result | theirs`), per-hunk take, block nav, minimap, and full editing in the center pane with source-aware undo. N-way conflicts get a "resolve at the earliest commit" hint since jj propagates.

**Divergence resolution.** Stack-aware analysis of `??/N` versions with keep/abandon/squash strategies, bookmark repointing, and immutable-sibling handling.

**Agent review loop.** Agent writes code into a revision. Review diffs with markdown preview, annotate lines with severity and comments, export to agent prompt, repeat. Annotations track across rewrites via jj's evolog. See [docs/ANNOTATIONS.md](docs/ANNOTATIONS.md).

**Works everywhere.** Local, SSH proxy, or port-forwarded — same UX. Auto-refresh watches for CLI changes with no remote dependencies.

**Multi-repo, multi-workspace.** Tabs for multiple repos, jj workspaces via the `◇` selector. State persists across restarts.

## Highlights

- **3-pane merge** — `ours | result | theirs`; arrow to take hunk, type to edit, undo restores source tag
- **Divergence resolver** — stack-aware `??/N` analysis with per-column keep/abandon/squash strategies and bookmark repointing
- **Inline rebase** — pick source (`-r`/`-s`/`-b`) and target (onto/after/before) modes, cursor to destination, Enter
- **Diff viewer** — unified/split, Lezer syntax highlighting, word-level diffs, context expansion, conflict A/B labels, open-in-$EDITOR
- **Revision graph** — SVG DAG, working-copy `@` indicator, immutable `◆` markers, bookmark badges with PR status
- **Bookmarks panel** (`2`) — sync state at a glance: ahead/behind/diverged/conflict, PR badges, staleness. `d`/`f`/`t` for delete/forget/track, per-remote visibility toggles
- **Multi-select** — batch abandon, squash, rebase across revisions with `Space`
- **Op log & evolog** — full operation history with undo/restore, per-revision evolution with inter-diffs
- **File history** — right-click any diff line, two-cursor compare (j/k + Space to pin), scoped to mutable for speed
- **Inline annotations** — per-line review comments keyed by `change_id`; auto-re-anchor on rewrite; export markdown/JSON
- **Stale-WC detection** — concurrent CLI op left the working copy stale? Warning bar with one-click recovery
- **Themes** — Catppuccin dark/light (`t` to toggle)

## Install & Usage

**One-line install** (macOS & Linux):

```bash
curl -fsSL https://raw.githubusercontent.com/chronologos/lightjj/main/install.sh | sh
```

Or `go install` (requires Go >= 1.21):

```bash
go install github.com/chronologos/lightjj/cmd/lightjj@latest
```

**Run:**

```bash
lightjj                            # serve current repo, open browser
lightjj -R /path/to/repo           # explicit repo path
lightjj --addr localhost:8080      # custom listen address
lightjj --no-browser               # don't auto-open browser
```

**Remote repos** — run on the remote and port-forward, or use SSH proxy mode:

```bash
# Port-forward
ssh -L 3001:localhost:3001 user@host \
  "lightjj -R /path/to/repo --addr localhost:3001 --no-browser"

# SSH proxy mode
lightjj --remote user@host:/path
```

SSH proxy mode adds ~400ms per command (reduce to ~20ms with ControlMaster). Auto-refresh polls on `--snapshot-interval` (default 5s), snapshotting the remote working copy automatically.

**Updating:** re-run the install command. Check your version with `lightjj --version`.

## Roadmap

| | Theme | |
|---|---|---|
| **1.0** | Ship-ready core | done |
| **2.0** | Code editing & review | Hunk-level accept/reject, mega-file virtualization, cross-revision search, LSP-in-FileEditor |
| **3.0** | Agentic | Annotations as a library, agent-writable API, MCP server mode |

## Requirements

- **jj >= 0.39**
- **Go >= 1.21** — only if building from source
- **gh** (optional) — for PR badges; must be authed wherever the repo lives

## Development

```bash
# Two terminals:
go run ./cmd/lightjj --addr localhost:3000 --no-browser   # backend
cd frontend && pnpm run dev                                # frontend (Vite HMR)

# Tests
go test ./...              # Go
cd frontend && pnpm test   # Vitest
```

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for system design and [docs/CONFIG.md](docs/CONFIG.md) for configuration.

## Upstream

Core command builder patterns ported from [jjui](https://github.com/idursun/jjui).
