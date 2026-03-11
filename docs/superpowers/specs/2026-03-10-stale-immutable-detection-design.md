# Stale Immutable Detection

> **STATUS**: Shipped in `wnpsmqvw` → main `1291127a`.

Detects and resolves immutable divergence caused by force-pushes from other machines. Surfaces actionable cases via MessageBar with one-click cleanup.

## Problem

When a user force-pushes to a remote from a different machine, `jj git fetch` imports the rewritten commit alongside the local copy. Both share a change_id but have different commit_ids. If both are immutable (in trunk history), jj marks them divergent permanently — `jj util gc` won't prune either since both are ancestors of visible heads.

The existing DivergencePanel filters on `divergent() & mutable()`, so these pairs are invisible. A monorepo case study found 38 immutable divergent pairs vs 4 mutable — showing all immutable divergence would bury the signal.

## Design

### Detection heuristic

A divergent immutable pair is **actionable** when:
- Exactly 2 copies share a change_id (N>2 is too ambiguous)
- Bookmark asymmetry: one copy has bookmarks (local or remote-tracking), the other doesn't

The bookmarked copy is the **keeper** (it's the version the remote considers canonical). The un-bookmarked copy is **stale** (a leftover from before the force-push).

### Trigger

Detection runs **after git fetch/push completes** — the only time immutable divergence can appear. Not on every log refresh (zero overhead during normal editing). If the user fetches via CLI, the next SSE-triggered op-heads change will fire a log refresh, but stale-immutable detection only fires post-fetch/push within lightjj.

### Backend

**Command builder** (`internal/jj/divergence.go`):

`StaleImmutable()` builds args for:
```
jj log -r 'divergent() & immutable()' --no-graph --color never --ignore-working-copy -T <template>
```

Template fields (unit-separator delimited): `change_id.short()`, `commit_id.short()`, local bookmarks, remote-tracking bookmarks, `description.first_line()`.

`ParseStaleImmutable()` returns `[]StaleImmutableEntry`. `GroupStaleImmutable()` groups by change_id, applies the actionable heuristic, returns `[]StaleImmutableGroup` with keeper/stale labeled.

**`AbandonImmutable(commitIds []string)`** (`internal/jj/commands.go`): returns `["abandon", "--ignore-immutable", ids...]`. Takes raw commit_ids (not change_ids) because divergent copies share a change_id — the existing `Abandon()` path uses `SelectedRevisions.GetChangeId()` which can't disambiguate. This is a separate command builder, not a flag on `Abandon()`.

**Endpoints** (`internal/api/handlers.go`):

`GET /api/stale-immutable` — runs StaleImmutable(), groups, filters, returns:
```json
[{
  "change_id": "spzmpxnu",
  "stale": { "commit_id": "a4eecdf2", "description": "v0.8.0: …", "bookmarks": [] },
  "keeper": { "commit_id": "9d3d2a06", "description": "v0.8.0: …", "bookmarks": ["v0.8.0"] }
}]
```

Empty array = nothing to do.

`POST /api/abandon-immutable` — accepts `{ "commit_ids": ["a4eecdf2"] }`, runs `jj abandon --ignore-immutable <ids>` via `runMutation()`. Returns 400 if `commit_ids` is empty. No further server-side validation (the user could run the same command in a terminal).

### Frontend

**`api.ts`**: `api.staleImmutable()` and `api.abandonImmutable(ids)`.

**`App.svelte`**: `staleImmutableEntries` as `$state`. After git push/fetch completes (in the existing GitModal success path), fire `api.staleImmutable()`. If non-empty, populate the state.

**`MessageBar`** renders:
```
⚠ 1 stale immutable copy (force-pushed remotely)  [Details]  [Clean up]
```

- `details`: lists each stale commit — commit_id + description
- `action`: "Clean up" → calls `api.abandonImmutable(staleIds)`, clears state on success
- Non-dismissable (like stale-WC warning)

State is transient — not cached, not persisted. Cleared after cleanup or if the user resolves via CLI (next refresh shows no divergence).

## Files touched

| File | Change |
|---|---|
| `internal/jj/divergence.go` | `StaleImmutable()`, `StaleImmutableEntry`, `ParseStaleImmutable()`, `GroupStaleImmutable()` |
| `internal/jj/divergence_test.go` | Parser + grouping tests |
| `internal/jj/commands.go` | `AbandonImmutable(commitIds)` |
| `internal/jj/commands_test.go` | Command builder test |
| `internal/api/handlers.go` | `handleStaleImmutable` (GET), `handleAbandonImmutable` (POST) |
| `internal/api/server.go` | Route registration |
| `internal/api/handlers_test.go` | Handler tests with MockRunner |
| `frontend/src/lib/api.ts` | `api.staleImmutable()`, `api.abandonImmutable(ids)` |
| `frontend/src/App.svelte` | State, post-fetch trigger, MessageBar wiring, cleanup handler |

## Why commit_ids, not change_ids

The existing `POST /api/abandon` uses `SelectedRevisions` which emits change_ids via `GetChangeId()`. For divergent commits, both copies share the same change_id — passing it to `jj abandon` would be ambiguous (jj refuses to operate on divergent changes by change_id without `--allow-large-revsets`). The `POST /api/abandon-immutable` endpoint takes raw commit_ids to target specific copies.

## Why bookmark asymmetry works for force-push

After `jj git fetch`, jj moves remote-tracking bookmarks to the newly imported commit. The old local copy loses its remote bookmark — it's now an orphan with no bookmark references. Empirically verified: force-push of `v0.8.0` from another machine left the local copy (`a4eecdf2`) with zero bookmarks and the fetched copy (`9d3d2a06`) with the `v0.8.0` bookmark. This makes asymmetry the natural state after force-push, not a special case.

## Out of scope

- General-purpose immutable divergence viewer (38 noisy pairs in monorepo)
- Automatic cleanup without user action
- Detection outside post-fetch/push
- N>2 copies or symmetric-bookmark cases (rare — jj moves remote bookmarks to the new copy on fetch, so force-push naturally produces asymmetric bookmarks)
