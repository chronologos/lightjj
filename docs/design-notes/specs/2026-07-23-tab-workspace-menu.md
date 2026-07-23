# Tab Workspace Menu — Design Plan

> **STATUS**: Implementation in progress (issue #30 follow-up). Moves workspace
> selection off the global toolbar dropdown and onto the tabs themselves.

**Inspired by:** browser tab affordances (VS Code / Zed workspace switchers) —
the workspace you're in *is* the tab, so its siblings belong on the tab, not in a
disconnected toolbar control.

## Problem Statement

Workspace selection today lives in a single global toolbar dropdown (`◇ {current}`
in `App.svelte`). That control only knows about the **active tab's** repo — it
fetches `GET /api/workspaces` for whichever tab is focused. With multi-repo tabs
(issue #30) this is doubly wrong:

1. The dropdown shows one repo's workspaces regardless of which tab group you're
   looking at — there's no way to see repo B's workspaces without switching to a
   B tab first.
2. Workspace identity is spatially divorced from the tab it belongs to. You open
   a workspace "as a tab" from a toolbar 200px away from where the tab appears.

The tabs already group by `repoRoot` and already show secondary-workspace names
(`proj ◇ feature`). The workspace list belongs *there*.

## What we already have (don't rebuild)

| Piece | Location | Reuse |
|---|---|---|
| Tab grouping by `repoRoot` | inline in `TabBar.svelte` | ⚠️ extract to `tab-groups.ts` (shared by TabBar + AppShell + App palette) |
| `ContextMenu.svelte` (anchored, keyboard-nav, edge-flip) | `lib/ContextMenu.svelte` | ✅ AppShell gets its own single instance (mirrors App's) |
| Per-tab servers at `/tab/{id}/` | `internal/api/tabs.go` | ✅ `/tab/{id}/api/workspaces` fetches any open tab's repo |
| `GET /api/workspaces` → `{current, workspaces[]}` | `handlers.go` | ✅ unchanged |
| `planRecoverAll` / `recoverAllMessage` | `workspace-recovery.ts` (pure, tested) | ✅ "Update all" reuses both |
| `openWorkspaceTab` / `openWorkspaceContextMenu` (RevisionGraph badge) | `App.svelte` | ✅ **stays** — the graph `◇ ws@` badge is untouched |
| Cmd+K workspace commands (New / Rename / Update all) | `App.svelte` | ✅ **stay** — act on the active tab's repo |

## The data-loading wrinkle (resolved)

**Problem:** The `◇N` icon must render on every repo group's chip/solo tab *up
front* — including background tabs whose repo has no App instance and no
`api.workspaces()` data. `api.workspaces()` is tab-scoped to the active tab.

**Resolution:** `TabManager` mounts a full `Server` per tab at `/tab/{id}/`, so
`/tab/{id}/api/workspaces` is fetchable for **any** open tab. `AppShell` (which
owns the tab list) lazily fetches workspace info **once per distinct repoRoot**,
addressing each group via its first tab's id:

- New API helpers `workspacesForTab(id)` / `workspaceAddForTab(id, …)` /
  `updateStaleWorkspaceForTab(id, …)` / `workspaceUpdateStaleForTab(id)` build
  `/tab/{id}/api/…` URLs directly (they don't start with `/api/`, so `tabScoped`
  leaves the explicit prefix alone rather than re-prefixing with the *active*
  tab's `basePath`).
- `wsByRepo: SvelteMap<groupKey, WorkspacesResponse>` in AppShell. An effect
  fetches any group key not yet present whenever the tab list changes
  (`fetch-on-tab-list-change`). Opening a menu re-fetches that one repo
  (`fetch-on-menu-open`) so contents are current when it matters.

**Why not op-sync?** `createOpSync` compares a resource's reflected op-id against
the *latest reported* op-id — a per-tab SSE signal that only the **active** tab's
App subscribes to. AppShell has no op-id stream for background tabs (a
manager-level tabs-changed SSE is the eventual fix, already tracked in BACKLOG for
the stale-dot gap). So workspace-*count* staleness is handled the cheap way the
task sanctions: refetch on tab-list change + refetch on menu-open. A workspace
added/removed via external CLI in a background repo shows up on the next
tab-list refetch (which `onStaleWC` already triggers) or the next menu-open —
never staler than the tab's own stale-dot, which has the identical bound.

**Per-workspace staleness** is shown only for workspaces that are **open as
tabs** (their `TabInfo.stale` is already enriched by `handleList`). Closed
workspaces don't show staleness — probing each would need a per-workspace
`jj log`/snapshot round trip, which is not "cheaply available." Documented in the
menu as the absence of a marker, not a false "fresh."

## Architecture

### Ownership: AppShell hosts the tab/workspace menu

The icon and right-click surfaces live on `TabBar`, whose component instance is
owned by **AppShell** (it lives outside the `{#key activeTabId}` remount).
Everything the menu needs — the tab list, `wsByRepo`, `switchTab`, `handleOpen`,
`handleClose` — is AppShell state. So AppShell gets its **own single
`<ContextMenu>` instance** for tab/workspace surfaces, distinct from App's single
instance for in-app surfaces (revision/bookmark menus). This is the
"App/AppShell single-instance convention": **one ContextMenu per host, each host
owning the surfaces whose state it holds.** It is not a second scattered instance
inside one host.

Following CLAUDE.md "Adding a context-menu surface": `TabBar` emits the **domain
object** (`onWorkspaceIcon(groupKey, x, y)` for the icon; `onTabMenu(tab, x, y)`
for right-click). AppShell builds the `ContextMenuItem[]`.

### Pure item builders (`workspace-menu.ts`)

Menu-item construction is a pure function of data + injected callbacks — extracted
so it is unit-testable without mounting AppShell (mirrors `workspace-recovery.ts`):

- `workspaceSectionItems(opts)` → per-workspace rows (open→switch / closed→"open
  in new tab") + `Add workspace…` (disabled unless `sshMode === false`) + `Update
  all (recover stale)`.
- `tabMenuItems(opts)` → optional workspace section (when the repo has ≥2
  workspaces) + separator + `Close tab` + `Close group (N tabs)` for chips.

Gating rules preserved from the old dropdown:
- **SSH mode** disables `Add workspace…` (backend `handleWorkspaceAdd` is
  local-fs only). Session mode is process-wide (`TabManager.Host` — all tabs
  share it), so App reports `sshMode` up to AppShell once via `onSshMode`.
- **Active inline mode** (rebase/squash/split/megamerge in the focused App)
  disables tab-opening/switching + mutations: opening/switching a tab remounts
  App and silently drops a half-configured mode. AppShell reads it at menu-build
  time via `appRef.inInlineMode()` (a new App export). Same rationale as the old
  `openWorkspaceContextMenu`'s `inlineMode` gate.

### `◇N` icon (`TabBar.svelte`)

- Renders on a repo chip (grouped tabs) and on a solo tab **iff** that repo's
  workspace count ≥ 2. `N` = count. Class `.ws-tab-icon` (stable for tests +
  Bombadil). Count comes from a `wsCounts: Map<groupKey, number>` prop AppShell
  derives from `wsByRepo`.
- Left-click → `onWorkspaceIcon(groupKey, clientX, clientY)` (stops propagation so
  it neither switches nor closes the tab). Must fit inside the 26px tab bar; it's
  a small inline glyph like the existing `.tab-glyph`.
- Right-click on any tab button → `onTabMenu(tab, clientX, clientY)`.

### `w` key retarget & toolbar removal (`App.svelte`)

- The toolbar `◇` dropdown (`.toolbar-workspace`, `wsDropdownOpen`,
  `wsSelectorEl`, the outside-click `<svelte:window onclick>`, and the
  `.toolbar-ws-*` CSS) is deleted.
- `w` now calls `onOpenWorkspaceMenu?.()` (App→AppShell). AppShell opens the
  **active tab's** workspace menu, anchored at the active tab's `.ws-tab-icon`
  (or the `.tab.active` element if the repo is single-workspace → no-op, matching
  the old `workspaceList.length > 1` guard).
- App's workspace *handlers* (`openWorkspaceTab`, `openWorkspaceContextMenu`,
  `handleWorkspaceAdd`, `updateAllStaleWorkspaces`, `renameWorkspace`,
  `forgetWorkspace`, `recoverWorkspace`) and `currentWorkspace`/`workspaceList`
  state **stay** — the RevisionGraph `◇ ws@` badge and the Cmd+K workspace
  commands still use them. Only the toolbar UI + the dropdown-toggle behavior of
  `w` are removed. (This leaves a small, deliberate duplication: App owns the
  active-repo workspace actions for its own surfaces; AppShell owns the
  any-repo tab-triggered surface.)

### Cmd+K "Switch to repo: <name>" (`App.svelte`)

One palette entry per distinct open repo group (`groupTabs(tabs)`), switching to
that group's first tab via a new `onSwitchTab` prop. Gives fuzzy repo switching
without inverting the tab hierarchy into a dropdown. Gated `!inlineMode`
(switching remounts → drops the mode).

## Non-goals

- No repo→dropdown inversion; no tab drag-sorting; no repo fuzzy-search box in a
  dropdown (the palette entries cover it); no `tutorial-content.ts` entry (added
  at release time).

## Files touched

| File | Change |
|---|---|
| `lib/tab-groups.ts` | **new** — `groupTabs(tabs)` pure helper (extracted from TabBar) |
| `lib/workspace-menu.ts` | **new** — pure `workspaceSectionItems` / `tabMenuItems` builders |
| `lib/api.ts` | tab-targeted `workspacesForTab` / `workspaceAddForTab` / `updateStaleWorkspaceForTab` / `workspaceUpdateStaleForTab` |
| `lib/TabBar.svelte` | `◇N` icon, `onWorkspaceIcon`/`onTabMenu` emitters, `wsCounts` prop, use `groupTabs` |
| `AppShell.svelte` | `wsByRepo` fetch, `wsCounts`, own `<ContextMenu>`, menu builders wiring, `w`-key + `onSshMode` |
| `App.svelte` | remove toolbar dropdown; retarget `w`; `Switch to repo` palette; `tabs`/`onSwitchTab`/`onOpenWorkspaceMenu`/`onSshMode` props; `inInlineMode` export |

Backend untouched (all four workspace endpoints already exist and are per-tab).

## Testing strategy

- **`tab-groups.test.ts`** — grouping, first-seen order, label derivation.
- **`workspace-menu.test.ts`** — icon-agnostic item building: open→switch vs
  closed→open-in-new-tab, current-tab marked/disabled, SSH disables Add, inline
  disables opens/mutations, stale marker on open stale workspaces, `Close group`
  only for chips.
- **`TabBar.test.ts`** (extend) — `◇N` shows at count ≥ 2 / hides at 1; icon
  left-click emits `onWorkspaceIcon(key)` (and does not switch/close); right-click
  a tab emits `onTabMenu(tab)`.
- **`App.interactions.test.ts`** (extend) — `w` calls `onOpenWorkspaceMenu` (and
  no `.toolbar-ws-dropdown` exists); Cmd+K "Switch to repo" entries build from the
  `tabs` prop and fire `onSwitchTab`.

### Bombadil

The fuzz fixture is a **single-workspace** repo, so `fixture.sh` gains a second
workspace (`jj workspace add`, deterministic sibling dir) — otherwise the `◇N`
icon never renders and the new surface is untested. `spec.ts` gains:

- a `clickWsIcon` generator clicking `.ws-tab-icon` (left-click — in vocabulary),
- a `clickWsMenuItem` generator clicking `.ctx-item` (drives the menu's actions),
- an extractor proving the menu actually opened (a `.ctx-menu` snapshot), and
- the menu inherits `noModalTraps` via `.ctx-menu` (already in `modalOpen`'s
  selector) — the added property verifies **tab count never decreases from a
  workspace-menu-open action** (opening/reading the menu must not close tabs).

**Known harness limit:** Bombadil cannot right-click (antithesishq/bombadil#251),
so the **left-click icon path** is the fuzzable one; the right-click tab menu is
covered only by vitest. Documented here and in `spec.ts`.

Required evidence: `DURATION=120 HEADED=1 ./run.sh` → zero violations + a trace
snapshot showing `.ctx-menu` rendered (menu genuinely opened), via filtered `jaq`
only (never read `trace.jsonl` raw — it embeds screenshots).
