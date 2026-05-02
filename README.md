# lightjj

A fast, powerful, single-binary [Jujutsu](https://docs.jj-vcs.dev/latest/community_tools/#lightjj) client.

![lightjj screenshot](screenshot.png)

## Why

A fast, powerful UI for Jujutsu VCS didn't exist, so I built one! In addition to the things you might expect, lightjj has the following cool features:

- Includes a real merge tool with a 3-pane editor
- Smart divergence resolution
- File history
- Review diffs with markdown preview, annotate lines with severity and comments, export to agent prompt, repeat
- Works everywhere — locally, over SSH, or port-forwarded
- Multi-repo, multi-workspace support

## Core Features

- **Revision graph** — SVG DAG, working-copy `@` indicator, immutable `◆` markers, bookmark badges with PR status
- **Diff viewer** — unified/split, Lezer syntax highlighting, word-level diffs, context expansion, conflict A/B labels, open-in-$EDITOR
- **Bookmarks panel** (`2`) — sync state at a glance: ahead/behind/diverged/conflict, PR badges, staleness. `d`/`f`/`t` for delete/forget/track, per-remote visibility toggles
- **Inline rebase** — pick source (`-r`/`-s`/`-b`) and target (onto/after/before) modes, cursor to destination, Enter
- **Multi-select** — batch abandon, squash, rebase across revisions with `Space`
- **Op log & evolog** — full operation history with undo/restore, per-revision evolution with inter-diffs
- **File history** — right-click any diff line, two-cursor compare (j/k + Space to pin), scoped to mutable for speed
- **Inline annotations** — per-line review comments keyed by `change_id`; auto-re-anchor on rewrite; export markdown/JSON
- **Stale-WC detection** — concurrent CLI op left the working copy stale? Warning bar with one-click recovery
- **Themes** — 7 hand-tuned builtins + 486 derived from Ghostty's palette set; `t` toggles dark/light, full picker in Cmd+K

## Install & Usage

**One-line install** (macOS & Linux):

```bash
curl -fsSL https://raw.githubusercontent.com/chronologos/lightjj/main/install.sh | sh
```

Release binaries are signed via [SLSA build provenance](https://slsa.dev/) (Sigstore-backed, no personal keys) and built with `-trimpath` for reproducibility. Verify any download with:

```bash
gh attestation verify lightjj-macos-arm64 --repo chronologos/lightjj
```

**Building from source** (requires Go >= 1.21 and pnpm):

```bash
git clone https://github.com/chronologos/lightjj
cd lightjj/frontend && pnpm install && pnpm run build
cd .. && go build -tags embed ./cmd/lightjj
```

The `embed` build tag bundles the frontend into the binary. Bare `go install github.com/chronologos/lightjj/cmd/lightjj@latest` works but produces a binary without the frontend (it serves a help page pointing back here) — the Go module proxy has no `pnpm` to run the frontend build.

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

|         | Theme                 |                                                                                              |
| ------- | --------------------- | -------------------------------------------------------------------------------------------- |
| **1.0** | Ship-ready core       | done                                                                                         |
| **2.0** | Code editing & review | Mega-file virtualization, cross-revision search, N-way conflict resolution, LSP-in-FileEditor |
| **3.0** | Agentic               | Annotations as a library, agent-writable API, MCP server mode                                |

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
