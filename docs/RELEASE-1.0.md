# lightjj 1.0.0 Release Plan

Status: **assets done — pending version bump + tag** · Current version: `0.9.0`

## Marquee features (README pitch)

1. **Instant** — commit-id-keyed caching + opportunistic prefetch; j/k with zero network waits
2. **Works everywhere** — local / SSH proxy / port-forward; same UX
3. **Multi-repo/workspace** — tabs with shared diff cache, persisted across restarts
4. **Complete jj coverage** — revision graph, branches, oplog, evolog, divergence, inline rebase/squash/split
5. **Real merge tool** — 3-pane conflict editor, per-hunk arrows, undo restores source tag

## Roadmap

| | Theme | What ships |
|---|---|---|
| **1.0** | Ship-ready core | Everything above, stable |
| **2.0** | Code editing/review | Hunk-level accept/reject (`jj split --tool` protocol), mega-file virtualization, cross-revision search, maybe LSP-in-FileEditor |
| **3.0** | Agentic | Annotations as a library, agent-writable API, auto-re-anchor, maybe MCP server mode |

---

## Ship-blockers

### SB-1: Cross-repo `remoteVisibility` bleed

**Bug:** `remoteVisibility` stored flat in `config.json` — hiding `origin` in repo A hides it in repo B. Visible correctness bug in marquee #3.

**Fix:** Repo-key the config: `remoteVisibility: {[repoKey]: {[remote]: {visible, hidden?}}}`. Use `RepoDir` (or SSH `user@host:/path`) as the key — already available per-tab.

**Files:** `frontend/src/lib/config.svelte.ts`, `frontend/src/App.svelte`, `internal/api/config.go` (migration only)

**Migration:** Existing flat map either wrapped under a `"__legacy"` key (ugly) or dropped (acceptable — feature is ~1 week old, 0 external users on it yet).

### SB-2: Bookmark jump → isolated single-commit graph

**Bug:** `jumpToBookmark` at `App.svelte:800` sets `revsetFilter = commitId` when bookmark isn't in current view. Graph shows one lonely commit.

**Fix:** Use context-preserving revset: `ancestors(commitId, 20) | @-..` — bookmark in context of recent work.

**Files:** `frontend/src/App.svelte:800`

### SB-3: OplogPanel keyboard nav

**Bug:** RevisionGraph and EvologPanel have j/k; OplogPanel doesn't. Inconsistent.

**Fix:** Copy EvologPanel's keydown pattern. Add `selectedIndex`, j/k/ArrowUp/ArrowDown handling, scrollIntoView.

**Files:** `frontend/src/lib/OplogPanel.svelte`

---

## Asset work

- [x] **README rewrite** — restructure around 5 marquee points + roadmap section
- [ ] **Screenshot retake** — hero shot of MergePanel or branches-side-by-side (manual)
- [x] **tutorial-content.ts** — add 1.0.0 entries (7 entries added)
- [ ] **version.txt** → `1.0.0` (do last — gates the WelcomeModal)

### Missing tutorial entries for 1.0.0

| Feature | Shortcut |
|---|---|
| 3-pane merge editor | — (click Resolve on conflict file) |
| Divergence strategy recommendations | — |
| Stale working-copy auto-detect | — |
| Stale immutable (force-push) detection | — |
| Branches side-by-side | `2` |
| Revset help popover | `?` in filter bar |
| Remote-bookmark visibility toggles | `e` in branches panel |

---

## Punted to 1.x

| Item | Why |
|---|---|
| `recent-actions` localStorage port loss | Soft degrade (alphabetical instead of recent-first in BookmarkModal). Config already server-side. |
| `selectedFiles` scratchpad / revset input ownership / `RepoDir == ""` sentinel | Internal debt, zero user impact |
| `storage` event listener | Two tabs same port is rare; random-port default makes it rarer |

---

## Execution order

1. Fix SB-1, SB-2, SB-3
2. tutorial-content.ts entries
3. README rewrite
4. Screenshot (manual)
5. version.txt bump
6. `/bughunt-lite` on the fixes
7. Ship
