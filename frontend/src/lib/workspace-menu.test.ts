import { describe, it, expect, vi } from 'vitest'
import { workspaceSectionItems, tabMenuItems, tabForWorkspace, type WorkspaceSectionOpts } from './workspace-menu'
import type { TabInfo, WorkspacesResponse } from './api'

const tab = (id: string, extra: Partial<TabInfo> = {}): TabInfo =>
  ({ id, kind: 'repo', name: 'x', path: '/p' + id, repoRoot: '/repo', ...extra })

const ws = (names: string[], current = 'default', withPath = true): WorkspacesResponse => ({
  current,
  workspaces: names.map(name => ({
    name, change_id: 'c' + name, commit_id: 'k' + name,
    ...(withPath ? { path: '/repo-' + name } : {}),
  })),
})

// Two workspaces: 'default' open as active tab 0, 'feature' not open.
function baseOpts(overrides: Partial<WorkspaceSectionOpts> = {}): WorkspaceSectionOpts {
  return {
    ws: ws(['default', 'feature']),
    groupKey: '/repo',
    tabs: [tab('0', { wsName: 'default' })],
    activeTabId: '0',
    sshMode: false,
    inlineMode: false,
    onSwitch: vi.fn(),
    onOpen: vi.fn(),
    onAdd: vi.fn(),
    onUpdateAll: vi.fn(),
    ...overrides,
  }
}

describe('tabForWorkspace', () => {
  it('matches by group key + normalized wsName (empty → default)', () => {
    const tabs = [tab('0', { wsName: '' }), tab('1', { wsName: 'feature' })]
    expect(tabForWorkspace(tabs, '/repo', 'default')?.id).toBe('0')
    expect(tabForWorkspace(tabs, '/repo', 'feature')?.id).toBe('1')
    expect(tabForWorkspace(tabs, '/repo', 'nope')).toBeUndefined()
  })
})

describe('workspaceSectionItems', () => {
  it('current workspace tab is marked and disabled', () => {
    const items = workspaceSectionItems(baseOpts())
    const cur = items.find(i => i.label === '◇ default')!
    expect(cur.disabled).toBe(true)
    expect(cur.shortcut).toBe('current')
  })

  it('a not-open workspace offers "open in new tab" → onOpen(path)', () => {
    const onOpen = vi.fn()
    const items = workspaceSectionItems(baseOpts({ onOpen }))
    const feat = items.find(i => i.label === '◇ feature')!
    expect(feat.disabled).toBe(false)
    expect(feat.shortcut).toBe('↗ new tab')
    feat.action!()
    expect(onOpen).toHaveBeenCalledWith('/repo-feature')
  })

  it('an OTHER open workspace offers "switch" → onSwitch(id)', () => {
    const onSwitch = vi.fn()
    const items = workspaceSectionItems(baseOpts({
      tabs: [tab('0', { wsName: 'default' }), tab('1', { wsName: 'feature' })],
      onSwitch,
    }))
    const feat = items.find(i => i.label === '◇ feature')!
    expect(feat.shortcut).toBe('switch')
    feat.action!()
    expect(onSwitch).toHaveBeenCalledWith('1')
  })

  it('appends a stale marker for open stale workspaces', () => {
    const items = workspaceSectionItems(baseOpts({
      tabs: [tab('0', { wsName: 'default', stale: true })],
    }))
    expect(items.some(i => i.label === '◇ default · stale')).toBe(true)
  })

  it('a closed workspace with no path is disabled (predates workspace store)', () => {
    const items = workspaceSectionItems(baseOpts({ ws: ws(['default', 'feature'], 'default', false) }))
    // feature has no path → unopenable
    expect(items.find(i => i.label === '◇ feature')!.disabled).toBe(true)
  })

  it('Add workspace is disabled in SSH mode, enabled locally', () => {
    const add = (m: boolean | undefined) =>
      workspaceSectionItems(baseOpts({ sshMode: m })).find(i => i.label === 'Add workspace…')!
    expect(add(false).disabled).toBe(false)
    expect(add(true).disabled).toBe(true)
    expect(add(undefined).disabled).toBe(true) // unknown → fail safe
  })

  it('inline mode disables opens, Add, and Update all', () => {
    const items = workspaceSectionItems(baseOpts({ inlineMode: true }))
    expect(items.find(i => i.label === '◇ feature')!.disabled).toBe(true)
    expect(items.find(i => i.label === 'Add workspace…')!.disabled).toBe(true)
    expect(items.find(i => i.label === 'Update all (recover stale)')!.disabled).toBe(true)
  })

  it('always includes Add + Update all after a separator', () => {
    const items = workspaceSectionItems(baseOpts())
    expect(items.some(i => i.separator)).toBe(true)
    expect(items.some(i => i.label === 'Add workspace…')).toBe(true)
    expect(items.some(i => i.label === 'Update all (recover stale)')).toBe(true)
  })
})

describe('tabMenuItems', () => {
  const onCloseTab = vi.fn()

  it('single-workspace tab: no workspace section, just Close tab', () => {
    const items = tabMenuItems({
      tab: tab('0'), tabCount: 2, groupTabCount: 1, onCloseTab,
    })
    expect(items.some(i => i.separator)).toBe(false)
    expect(items.map(i => i.label)).toEqual(['Close tab'])
  })

  it('prepends the workspace section when the repo has ≥2 workspaces', () => {
    const items = tabMenuItems({
      tab: tab('0', { wsName: 'default' }), tabCount: 2, groupTabCount: 1,
      section: baseOpts(), onCloseTab,
    })
    expect(items.some(i => i.label === '◇ feature')).toBe(true)
    expect(items.some(i => i.separator)).toBe(true)
    expect(items.some(i => i.label === 'Close tab')).toBe(true)
  })

  it('Close tab is disabled when it would close the last tab', () => {
    const items = tabMenuItems({ tab: tab('0'), tabCount: 1, groupTabCount: 1, onCloseTab })
    expect(items.find(i => i.label === 'Close tab')!.disabled).toBe(true)
  })

  it('Close group only appears for chips (groupTabCount > 1) and is danger', () => {
    const onCloseGroup = vi.fn()
    const grouped = tabMenuItems({
      tab: tab('0'), tabCount: 3, groupTabCount: 2, onCloseTab, onCloseGroup,
    })
    const cg = grouped.find(i => i.label === 'Close group (2 tabs)')!
    expect(cg.danger).toBe(true)
    cg.action!()
    expect(onCloseGroup).toHaveBeenCalled()

    const solo = tabMenuItems({ tab: tab('0'), tabCount: 3, groupTabCount: 1, onCloseTab, onCloseGroup })
    expect(solo.some(i => i.label?.startsWith('Close group'))).toBe(false)
  })
})
