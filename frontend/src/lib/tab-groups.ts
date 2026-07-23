// PURE — tab grouping shared by TabBar (rendering), AppShell (per-repo workspace
// info + tab/workspace menu) and App (Cmd+K "Switch to repo" palette entries).
// Extracted from TabBar.svelte so the grouping is a single source of truth and
// unit-testable without a component render.

import type { TabInfo } from './api'
import { basename } from './paths'

export interface TabGroup {
  /** Grouping key: repoRoot when set, else the tab's own path (ungroupable
   *  tabs — SSH mode, tests — key on their path so they render solo). */
  key: string
  /** Display label: basename of the key. */
  label: string
  /** Stable --graph-{0..7} color index (hint only; the label is the identity). */
  colorIdx: number
  /** True if any tab in the group has a stale working copy. */
  stale: boolean
  tabs: TabInfo[]
}

// Stable non-negative hash → --graph-{0..7}. Collision-tolerant: color is a
// hint, chip text is the identity. >>> 0 keeps it unsigned so % is positive.
export function colorFor(s: string): number {
  let h = 0
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0
  return h % 8
}

/** Group key for a single tab: repoRoot when set, else its path. */
export function tabGroupKey(t: TabInfo): string {
  return t.repoRoot || t.path
}

// Group tabs by repoRoot. Ungroupable (repoRoot="") key on their own path so
// they render solo. Group order = first-seen in the tabs array (which is
// backend-sorted by open order).
export function groupTabs(tabs: TabInfo[]): TabGroup[] {
  const byKey = new Map<string, TabInfo[]>()
  const order: string[] = []
  for (const t of tabs) {
    const key = tabGroupKey(t)
    if (!byKey.has(key)) { byKey.set(key, []); order.push(key) }
    byKey.get(key)!.push(t)
  }
  return order.map(key => {
    const ts = byKey.get(key)!
    return {
      key,
      label: basename(key),
      colorIdx: colorFor(key),
      stale: ts.some(t => t.stale),
      tabs: ts,
    }
  })
}
