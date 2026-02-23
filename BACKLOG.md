# jj-web Backlog

## UI Inspirations

### Sublime Merge
- **Three-panel layout**: left sidebar (branches/remotes/tags), commit list (center), detail view (right/bottom)
- **Commit list with graph lines**: DAG visualization with colored lanes connecting commits
- **Summary tab per commit**: hash, tree, author, committer, date, parents, branches, signature, stats
- **File tabs in diff view**: click individual changed files to view their diffs
- **Collapsible file sections**: expand/collapse individual file diffs
- **Diff stats badges**: `-0 +150` per file, color-coded
- **Branch/HEAD badges** inline with commit messages: `HEAD`, `main`, styled distinctly
- **Location sidebar**: branches, remotes (expandable tree), tags, stashes

### jjui (TUI)
- **Graph view**: ASCII DAG with `@`, `○`, `◆`, `×` node symbols, lane tracking with `│`, `╭`, `╰`
- **Keyboard-first navigation**: j/k up/down, enter for details, r for rebase, S for squash, etc.
- **Status bar**: shows current mode + available shortcuts
- **Revset bar**: editable revset filter at the top
- **Working copy `@` indicator**: prominent, green-colored
- **Conflict markers**: `×` symbol, red-colored for conflicting revisions
- **Multi-select**: check multiple revisions for batch operations
- **Preview panel**: diff preview without leaving the revision list
- **Command palette**: fuzzy-search all available actions

### Antique (internal code review)
- **Split/unified toggle** with draggable divider for resize
- **Collapsible file diffs** with lazy rendering (IntersectionObserver)
- **Separate old/new highlighting** for accurate syntax highlighting
- **Context expansion** — on-demand "show more lines" at hunk boundaries
- **FileTable sidebar** with review checkboxes, type badges, +/- stats
- **FileTree** with directory grouping (collapsible tree)

## Features — Prioritized

### P0 — Core ✅
- [x] Revision list with change IDs
- [x] Diff viewer (unified, +/- colored)
- [x] Basic operations: new, abandon, undo
- [x] Keyboard navigation (j/k, enter, escape, e, n, u, r, /)
- [x] Status bar with shortcuts
- [x] Working copy `@` badge (detected from graph chars)

### P1 — Essential ✅
- [x] Graph view — pixel-perfect continuous DAG from jj's graph output
- [x] Full change IDs with highlighted unique prefix (like jjui)
- [x] Revset filter input (/ to focus, Escape to clear)
- [x] Describe (edit commit message inline, fetch current from API)
- [x] File list per revision (click to scroll to file diff)
- [x] Bookmark management (set, delete, move, forget endpoints)
- [x] Security: flag whitelist on git push/fetch, input validation, MaxBytesReader
- [x] `\x1F` unit separator for safe template parsing

### P2 — Polish ✅
- [x] Collapsible file diffs with sticky headers
- [x] Diff stats per file (`+N -N`, proportionally scaled from jj --stat)
- [x] Split view (side-by-side diff, unified/split toggle)
- [x] Change type badges (M blue, A green, D red)
- [x] Pinned file list + toolbar (outside scroll container)
- [x] Multi-select revisions for batch operations
- [x] Command palette (Cmd+K / Ctrl+K)
- [x] Inline diff (word-level highlighting)
- [x] Operation log viewer
- [x] Evolog viewer

### P3 — Advanced
- [ ] Retain collapse/expand state per revision (switching revisions should not reset which files are collapsed)
- [ ] Show total diff stats (aggregate +N -N across all files) in the file list header
- [ ] Branch/remote sidebar (like Sublime Merge left panel)
- [ ] Drag-and-drop rebase (drag revision onto destination)
- [ ] Rebase modal (pick source + destination)
- [ ] Squash modal
- [ ] Conflict resolution UI
- [ ] SSH remote mode performance — each jj command spawns a new SSH connection (~440ms via Coder ProxyCommand). Options: (a) batch endpoint combining diff+files+evolog into one SSH call, (b) persistent SSH session with stdin/stdout multiplexing, (c) run backend on remote with SSH port-forward (`ssh -L 3001:localhost:3001 host "jj-web -R /path"`). Option (c) sidesteps the problem entirely.
- [ ] SSH remote repo browser
- [ ] Live file watching (auto-refresh on working copy changes)
- [ ] Git push/fetch with progress indication
- [x] Diff syntax highlighting (language-aware, Shiki like antique)
- [ ] Context expansion at hunk boundaries (like antique)
- [ ] Search across revisions
- [x] Themes (light/dark) — Catppuccin Mocha (dark) + Latte (light), toggle via Cmd+K, persisted in localStorage
- [ ] Lazy rendering for large diffs (IntersectionObserver, like antique)
- [ ] Draggable split view divider (resize ratio)

## State Synchronization

The frontend can go stale if jj state changes outside the UI (CLI, other tools, file edits snapshotted by jj). We need staleness detection.

**jj operation IDs**: Every repo mutation creates a new operation. `jj op log --limit 1 --template id` returns the current op hash. We already have `OpLogId()` in commands.go.

**Approaches (ordered by implementation cost):**

1. **Op-ID header on every response** (cheapest): Backend includes `X-JJ-Op-Id` header in every API response. Frontend stores last seen op-id. If a response comes back with a different op-id than expected, auto-refresh the log. No polling needed — staleness is detected on next user action.

2. **Polling endpoint** (simple): `GET /api/op-id` returns current operation ID. Frontend polls every N seconds. Refresh if changed. Adds network traffic but works without SSE/WebSocket.

3. **File watch + SSE** (best UX): Backend watches `.jj/repo/op_heads/` directory using fsnotify. On change, push event via Server-Sent Events to connected frontends. Instant refresh on any repo mutation — including CLI usage in another terminal. This is the ideal end state.

4. **Snapshot on focus**: When the browser tab gains focus (`visibilitychange` event), call `jj debug snapshot` to capture working copy changes, then check op-id and refresh if needed.

**Recommended**: Start with option 1 (op-id header) since it's zero-cost. Add option 4 (snapshot on focus) for working copy freshness. Graduate to option 3 (SSE) for live updates.

## Graph View Notes

Current implementation uses option 4 (jj's graph output) with pixel-perfect rendering:
- Each graph line (node or connector) is its own DOM row at identical height
- Node lines show commit IDs + description on a second line
- Description lines get a continuation gutter (`│` extended from the node)
- Working copy `@` detected from graph characters, not template functions

Future: migrate to SVG-based rendering (option 1) for colored lanes, hover interactions, and smooth curves at merge/fork points.

1. **SVG-based**: Each lane is a vertical path, merge/fork points are curves. Interactive (hover, click). This is what Sublime Merge does.
2. **Canvas**: Better performance for large repos but harder to make interactive.
3. **HTML/CSS grid**: Each cell in the graph is a div with borders. Simple but limited.
4. **Use jj's graph output**: ✅ Implemented. Parse `jj log` with graph characters and render them as styled HTML.
