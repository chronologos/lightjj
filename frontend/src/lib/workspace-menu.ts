// PURE — builders for the tab/workspace context menu (the `◇N` icon menu and the
// right-click tab menu). Kept out of AppShell.svelte so the item shapes, gating,
// and open-vs-switch branching are unit-testable without a component render
// (mirrors workspace-recovery.ts). AppShell injects the action callbacks and the
// live gates (sshMode, inlineMode); this module owns only the item wiring.

import type { ContextMenuItem } from './ContextMenu.svelte'
import type { TabInfo, WorkspacesResponse } from './api'
import { tabGroupKey } from './tab-groups'

/** Normalize a tab's workspace name — an unresolved wsName reads as "default"
 *  so it matches the workspace list's canonical default entry. */
function tabWsName(t: TabInfo): string {
  return t.wsName || 'default'
}

/** The open tab (if any) showing workspace `wsName` of the repo `groupKey`. */
export function tabForWorkspace(
  tabs: TabInfo[],
  groupKey: string,
  wsName: string,
): TabInfo | undefined {
  return tabs.find(t => tabGroupKey(t) === groupKey && tabWsName(t) === wsName)
}

export interface WorkspaceSectionOpts {
  ws: WorkspacesResponse
  groupKey: string
  tabs: TabInfo[]
  activeTabId: string
  /** Session mode — Add-workspace is local-fs only. undefined = not yet known
   *  (fail safe: disable Add until we learn it's local). */
  sshMode: boolean | undefined
  /** Active App is mid rebase/squash/split/megamerge — opening/switching a tab
   *  would silently drop it, so those + mutations are disabled. */
  inlineMode: boolean
  onSwitch: (id: string) => void
  onOpen: (path: string) => void
  onAdd: () => void
  onUpdateAll: () => void
}

/** Per-workspace rows + Add + Update-all. Assumes the repo has ≥ 2 workspaces
 *  (the icon gate) — callers building a tab menu check that before including it. */
export function workspaceSectionItems(o: WorkspaceSectionOpts): ContextMenuItem[] {
  const items: ContextMenuItem[] = []
  for (const w of o.ws.workspaces) {
    const open = tabForWorkspace(o.tabs, o.groupKey, w.name)
    const staleMark = open?.stale ? ' · stale' : ''
    if (open) {
      const isCurrent = open.id === o.activeTabId
      items.push({
        label: `◇ ${w.name}${staleMark}`,
        // Current tab: nothing to do (disabled, marked). Other open workspace:
        // switch to its existing tab rather than opening a duplicate.
        shortcut: isCurrent ? 'current' : 'switch',
        disabled: isCurrent,
        action: isCurrent ? undefined : () => o.onSwitch(open.id),
      })
    } else {
      // Not open. Path absent → predates jj's workspace_store index → unopenable.
      items.push({
        label: `◇ ${w.name}`,
        shortcut: '↗ new tab',
        disabled: !w.path || o.inlineMode,
        action: () => { if (w.path) o.onOpen(w.path) },
      })
    }
  }
  items.push(
    { separator: true },
    // Local-fs only (backend handleWorkspaceAdd needs the workspace store path).
    { label: 'Add workspace…', disabled: o.sshMode !== false || o.inlineMode, action: o.onAdd },
    // Recover every workspace's working copy after a cross-workspace rewrite.
    { label: 'Update all (recover stale)', disabled: o.inlineMode, action: o.onUpdateAll },
  )
  return items
}

export interface TabMenuOpts {
  tab: TabInfo
  /** Total open tabs — Close tab is disabled when it would close the last one. */
  tabCount: number
  /** Tabs in this tab's group — Close group only shows for chips (> 1). */
  groupTabCount: number
  /** Workspace section to prepend (omit → no section, e.g. single-workspace
   *  repo). Included only when the repo has ≥ 2 workspaces. */
  section?: WorkspaceSectionOpts
  onCloseTab: (id: string) => void
  onCloseGroup?: () => void
}

/** Right-click tab menu: workspace section (when present) + tab operations. */
export function tabMenuItems(o: TabMenuOpts): ContextMenuItem[] {
  const items: ContextMenuItem[] = []
  if (o.section && o.section.ws.workspaces.length >= 2) {
    items.push(...workspaceSectionItems(o.section), { separator: true })
  }
  items.push({
    label: 'Close tab',
    disabled: o.tabCount <= 1,
    action: () => o.onCloseTab(o.tab.id),
  })
  if (o.groupTabCount > 1 && o.onCloseGroup) {
    items.push({
      label: `Close group (${o.groupTabCount} tabs)`,
      danger: true,
      action: o.onCloseGroup,
    })
  }
  return items
}
