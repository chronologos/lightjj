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

## Features — Prioritized

### P0 — Core (current sprint)
- [x] Revision list with change IDs
- [x] Diff viewer
- [x] Basic operations: new, abandon, undo
- [ ] Clean diff rendering (syntax-highlighted, +/- colored)
- [ ] Keyboard navigation (j/k, enter, escape)
- [ ] Status bar with shortcuts
- [ ] Working copy `@` badge

### P1 — Essential
- [ ] Graph view (DAG lines connecting revisions)
- [ ] Revset filter input
- [ ] Describe (edit commit message inline)
- [ ] Rebase via drag-and-drop or modal
- [ ] Squash UI
- [ ] File list per revision (click to view individual file diff)
- [ ] Bookmark management panel

### P2 — Polish
- [ ] Collapsible file diffs (like Sublime Merge)
- [ ] Diff stats per file (`-3 +15`)
- [ ] Multi-select revisions for batch operations
- [ ] Command palette (Cmd+K / Ctrl+K)
- [ ] Split view (side-by-side diff)
- [ ] Inline diff (word-level highlighting)
- [ ] Operation log viewer
- [ ] Evolog viewer

### P3 — Advanced
- [ ] Branch/remote sidebar (like Sublime Merge left panel)
- [ ] Drag-and-drop rebase (drag revision onto destination)
- [ ] Conflict resolution UI
- [ ] SSH remote repo browser
- [ ] Live file watching (auto-refresh on working copy changes)
- [ ] Git push/fetch with progress indication
- [ ] Diff syntax highlighting (language-aware)
- [ ] Search across revisions
- [ ] Themes (light/dark)

## Graph View Notes

The DAG visualization is the hardest and most impactful feature. Approaches:

1. **SVG-based**: Each lane is a vertical path, merge/fork points are curves. Interactive (hover, click). This is what Sublime Merge does.
2. **Canvas**: Better performance for large repos but harder to make interactive.
3. **HTML/CSS grid**: Each cell in the graph is a div with borders. Simple but limited.
4. **Use jj's graph output**: Parse `jj log` with graph characters and render them as styled HTML. Fastest to implement but least flexible.

Recommended: Start with option 4 (parse jj's graph output) for quick wins, then migrate to SVG for the full experience.
