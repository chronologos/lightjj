# Multi-Remote Visibility

> **STATUS**: Shipped. Design stack `uztwstuz..knlrkrrz` → main `cc496038` (feat) + `e610eeb3` (fixes + tests).

Per-remote and per-bookmark visibility toggles for the revision graph. Designed for fork workflows (origin + upstream) but general-purpose.

## Problem

lightjj is invisible to non-default remote bookmarks in three places:

1. **Revision graph** — log template uses `local_bookmarks`, so `main@upstream` has no badge.
2. **View toggle** — "Tracked" uses `tracked_remote_bookmarks()` which excludes untracked upstream refs. Most fork users never `jj bookmark track` upstream branches.
3. **BookmarksPanel** — shows one remote per bookmark row (`shownRemote`). Extra remotes at different commits were invisible (partly fixed: extra remote lines now render when commit_ids differ).

A monorepo fork (qmd) has 14 upstream branches and 1 local — none of upstream's positions are visible in the revision graph.

## Design

### Data: expanded log template

Change the log template from `local_bookmarks.map(|b| b.name())` to `bookmarks.map(|b| if(b.remote(), b.name() ++ "@" ++ b.remote(), b.name()))`.

This emits both local (`main`) and remote (`main@origin`, `main@upstream`) bookmark names per commit. `.name()` is load-bearing — the raw `bookmarks` keyword includes a `*` suffix for bookmarks ahead of their remote; `.name()` strips it (see `commands.go:62-63`).

The `@` delimiter is jj's canonical `name@remote` format. jj prohibits `@` in bookmark names (`lib/src/ref_name.rs` validation), so the frontend can safely split on the last `@` to separate name from remote. If jj ever relaxes this constraint, the template's explicit `b.name() ++ "@" ++ b.remote()` concatenation would still be correct — the split logic would need updating, but the data source wouldn't.

The graph parser (`graph.go`) needs no structural change — the bookmark field is already the last `\x1F`-joined segment. Only the string contents change.

Frontend splits `GraphRow.bookmarks` into local (no `@`) and remote (has `@`), filters remote by visibility config, renders each type with distinct badge styles.

### Visibility config

Stored in `config.json` via `mergeAndWriteConfig()`. This is a **top-level config key** — `mergeAndWriteConfig` does key-level merge (not deep-merge), so `remoteVisibility` survives writes to other config keys (theme, panels, etc.).

The `Config` interface in `config.svelte.ts` must add `remoteVisibility` to its type and `defaults` (default: `{}`) so the hydration loop (`for (const k of Object.keys(defaults))`) doesn't drop it.

```json
{
  "remoteVisibility": {
    "upstream": {
      "visible": true,
      "hidden": ["copilot/add-github-actions-workflow"]
    }
  }
}
```

Rules:
- **Absent remote = hidden.** New remotes don't appear in the log until explicitly enabled. Prevents surprise when fetching a remote with many branches.
- `visible: true` + empty/absent `hidden` = all bookmarks in that remote visible.
- `visible: true` + `hidden: [...]` = remote visible except listed bookmarks.
- `visible: false` = entire remote hidden (per-bookmark overrides ignored).
- Local bookmarks are always visible — no toggle.
- `origin` remote bookmarks default hidden (redundant with local bookmarks in the common case).
- **Stale remotes:** if a remote is removed from jj config but still exists in `remoteVisibility`, the config entry is inert (no bookmarks to show). No active cleanup — stale entries are harmless dead config. The BookmarksPanel simply won't render a group for a remote that `api.remotes()` doesn't return.

No new API endpoint needed. The existing `POST /api/config` + `mergeAndWriteConfig` handles `remoteVisibility` as a top-level key. The `handlers.go` entry in the files table below refers only to verifying the merge behavior works with nested objects, not new handler code.

### BookmarksPanel grouped view

The flat bookmark list becomes a two-level tree: remote groups → bookmarks.

**Groups:**
- **Local** — bookmarks with a `.local` field. Always first, no eye toggle.
- **Per-remote** — one group per remote from `api.remotes()`. Collapsible (▼/▶). Remote-level eye toggle on the header.
- Bookmarks with both local and remote presence appear in Local (primary) and in their remote group (for eye toggle control). The eye toggle in the remote group controls only the `name@remote` badge in the revision graph — it does NOT affect the local bookmark's visibility. Example: hiding `main` in the upstream group hides the `upstream/main` badge but `⑂ main` (local) still renders.

**Eye icon behavior:**
- Remote header eye — toggles `remoteVisibility[remote].visible`.
- Per-bookmark eye — toggles membership in `remoteVisibility[remote].hidden[]`. Only actionable when remote is visible.
- Visual: full opacity = visible in log, dimmed = hidden.
- Writes to config on click.

**Keyboard:**
- `j`/`k` navigate across group headers and bookmark rows (flat index).
- `e` on group header = toggle remote eye. `e` on bookmark row = toggle bookmark eye.
- Enter on bookmark = jump (existing). Enter on group header = expand/collapse.
- `d`/`f`/`t`/`r` work on bookmark rows, no-op on group headers.

**Collapse state:** UI-only, not persisted. Groups start expanded.

### Revision graph badges

Local bookmarks render exactly as today (`⑂ main` — filled badge).

Visible remote bookmarks render as compact, subdued pills:
- Smaller font size (9px vs 10px)
- Outline border, muted color (`--overlay0`)
- Format: `remote/name` (slash convention, not `@`) — e.g., `upstream/main`
- Positioned after local badges on the same line

### Revset construction

When any remotes have visible bookmarks, the Log view's revset is dynamically constructed:

```
// No bookmarks hidden in remote → remote-level revset (simple, efficient)
"ancestors(remote_bookmarks(\"upstream\"), 2)"

// Some bookmarks hidden → enumerate visible ones
"ancestors(\"main@upstream\" | \"feat/structured-search@upstream\", 2)"
```

The decision to enumerate vs use `remote_bookmarks()` is based on the `hidden[]` array: empty = use `remote_bookmarks("remote")`; non-empty = enumerate all bookmarks NOT in `hidden[]`. The enumeration source is the bookmark data already fetched by `api.bookmarks()` — no separate count needed. Bookmark names containing `/` or special chars are quoted in the revset (`"name@remote"` — jj revset string syntax).

The revset is built client-side and sent as `revsetFilter`. When no remotes are visible, filter stays empty (plain Log).

### View toggle simplification

- **Log** (default) — base revset + visible remote bookmarks.
- **Tracked** is removed. Its purpose is now served precisely by visibility toggles.
- **Custom** — appears when the user types a manual revset. Unchanged.

Removing "Tracked" also removes `TRACKED_REVSET` from `App.svelte`, the `'tracked'` variant from `viewMode` type in both `App.svelte` and `RevisionGraph.svelte`, and the `onviewmodechange` callback (simplified to just detect custom vs log based on whether `revsetFilter` is empty or matches the constructed visibility revset).

## Files touched

| File | Change |
|---|---|
| `internal/jj/commands.go` | Log template: `local_bookmarks` → `bookmarks` with remote format |
| `internal/jj/commands_test.go` | Template change verification |
| `internal/parser/graph.go` | No structural change (bookmark field already last) |
| `internal/parser/graph_test.go` | Update expected bookmark strings |
| `frontend/src/lib/api.ts` | `RemoteVisibility` type |
| `frontend/src/lib/config.svelte.ts` | `remoteVisibility` in `Config` interface + defaults |
| `frontend/src/lib/BookmarksPanel.svelte` | Grouped view with remote headers, eye toggles, expand/collapse |
| `frontend/src/lib/bookmark-sync.ts` | No change (sync classification is per-bookmark, unaffected) |
| `frontend/src/lib/RevisionGraph.svelte` | Split bookmarks into local/remote, render remote badges, remove `'tracked'` from `viewMode` type |
| `frontend/src/App.svelte` | Revset construction from visibility config, remove `TRACKED_REVSET`, simplify view toggle |

## Out of scope

- Side-by-side pane layout (BookmarksPanel stays a full view)
- Auto-tracking jj bookmarks (lightjj visibility ≠ `jj bookmark track`)
- Tag visibility
- Revision list username display (separate task)
- localStorage audit (separate backlog item)
