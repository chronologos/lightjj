import { describe, it, expect, vi } from 'vitest'
import { render, fireEvent } from '@testing-library/svelte'
import TabBar from './TabBar.svelte'
import type { TabInfo } from './api'

const tabs: TabInfo[] = [
  { id: '0', kind: 'repo', name: 'lightjj', path: '/Users/x/lightjj' },
  { id: '1', kind: 'repo', name: 'other', path: '/Users/x/other' },
]

const noop = () => {}

describe('TabBar', () => {
  it('renders tabs with active highlighted', () => {
    const { container } = render(TabBar, { tabs, activeId: '1', onswitch: noop, onopen: noop, onclose: noop })
    const btns = container.querySelectorAll('.tab')
    expect(btns).toHaveLength(2)
    expect(btns[0]).not.toHaveClass('active')
    expect(btns[1]).toHaveClass('active')
    expect(btns[0]).toHaveTextContent('lightjj')
  })

  it('clicking inactive tab fires onswitch; clicking active does not', async () => {
    const onswitch = vi.fn()
    const { container } = render(TabBar, { tabs, activeId: '0', onswitch, onopen: noop, onclose: noop })
    const btns = container.querySelectorAll('.tab')
    await fireEvent.click(btns[0]) // active
    expect(onswitch).not.toHaveBeenCalled()
    await fireEvent.click(btns[1])
    expect(onswitch).toHaveBeenCalledWith('1')
  })

  it('close × fires onclose and stops propagation (does not also switch)', async () => {
    const onswitch = vi.fn()
    const onclose = vi.fn()
    const { container } = render(TabBar, { tabs, activeId: '0', onswitch, onopen: noop, onclose })
    const close = container.querySelectorAll('.tab-close')[1]
    await fireEvent.click(close)
    expect(onclose).toHaveBeenCalledWith('1')
    expect(onswitch).not.toHaveBeenCalled()
  })

  it('hides close × when only one tab (cannot close last)', () => {
    const { container } = render(TabBar, { tabs: [tabs[0]], activeId: '0', onswitch: noop, onopen: noop, onclose: noop })
    expect(container.querySelector('.tab-close')).toBeNull()
  })

  it('+ button reveals path input; Enter submits, Escape cancels', async () => {
    const onopen = vi.fn()
    const { container } = render(TabBar, { tabs, activeId: '0', onswitch: noop, onopen, onclose: noop })
    await fireEvent.click(container.querySelector('.tab-new')!)
    const input = container.querySelector('.tab-path-input') as HTMLInputElement
    expect(input).not.toBeNull()

    input.value = '  ~/repo  '
    await fireEvent.input(input)
    await fireEvent.keyDown(input, { key: 'Enter' })
    expect(onopen).toHaveBeenCalledWith('~/repo') // trimmed

    // Escape path
    await fireEvent.click(container.querySelector('.tab-new')!)
    await fireEvent.keyDown(container.querySelector('.tab-path-input')!, { key: 'Escape' })
    expect(container.querySelector('.tab-path-input')).toBeNull()
  })

  it('Enter with only whitespace does not fire onopen', async () => {
    const onopen = vi.fn()
    const { container } = render(TabBar, { tabs, activeId: '0', onswitch: noop, onopen, onclose: noop })
    await fireEvent.click(container.querySelector('.tab-new')!)
    const input = container.querySelector('.tab-path-input') as HTMLInputElement
    input.value = '   '
    await fireEvent.input(input)
    await fireEvent.keyDown(input, { key: 'Enter' })
    expect(onopen).not.toHaveBeenCalled()
  })
})

describe('TabBar grouping', () => {
  const props = { activeId: '0', onswitch: noop, onopen: noop, onclose: noop }

  it('two tabs sharing repoRoot render as one group with a chip', () => {
    const grouped: TabInfo[] = [
      { id: '0', kind: 'repo', name: 'proj', path: '/x/proj', repoRoot: '/x/proj', wsName: 'default' },
      { id: '1', kind: 'repo', name: 'proj-ws', path: '/x/proj-ws', repoRoot: '/x/proj', wsName: 'feature' },
    ]
    const { container } = render(TabBar, { ...props, tabs: grouped })
    expect(container.querySelectorAll('.tab-group')).toHaveLength(1)
    expect(container.querySelector('.repo-chip')).toHaveTextContent('proj')
    const btns = container.querySelectorAll('.tab')
    // Primary label = repo name (not "default"); secondary = workspace name.
    expect(btns[0]).toHaveTextContent('proj')
    expect(btns[1]).toHaveTextContent('feature')
    expect(btns[0].querySelector('.tab-glyph')).toHaveTextContent('◇')
  })

  it('solo secondary workspace shows repo + ◇ workspace suffix', () => {
    const solo: TabInfo[] = [
      { id: '0', kind: 'repo', name: 'proj-ws', path: '/x/proj-ws', repoRoot: '/x/proj', wsName: 'feature' },
    ]
    const { container } = render(TabBar, { ...props, tabs: solo })
    expect(container.querySelector('.tab-group')).toBeNull()
    // Regression guard: v1 spec would have shown just "proj", hiding that
    // you're in a secondary workspace.
    expect(container.querySelector('.tab')).toHaveTextContent('proj ◇ feature')
  })

  it('solo default workspace collapses to repo name only (no chrome)', () => {
    const solo: TabInfo[] = [
      { id: '0', kind: 'repo', name: 'proj', path: '/x/proj', repoRoot: '/x/proj', wsName: 'default' },
    ]
    const { container } = render(TabBar, { ...props, tabs: solo })
    expect(container.querySelector('.repo-chip')).toBeNull()
    expect(container.querySelector('.tab-name')).toHaveTextContent(/^proj$/)
  })

  it('missing repoRoot falls back to path — each tab is its own group', () => {
    const { container } = render(TabBar, { ...props, tabs })
    // Original fixture has no repoRoot → two solo tabs, no chips.
    expect(container.querySelectorAll('.tab')).toHaveLength(2)
    expect(container.querySelector('.tab-group')).toBeNull()
  })

  it('stale dot renders on tab and on group chip', () => {
    const grouped: TabInfo[] = [
      { id: '0', kind: 'repo', name: 'a', path: '/x/a', repoRoot: '/x/a', wsName: 'default' },
      { id: '1', kind: 'repo', name: 'b', path: '/x/b', repoRoot: '/x/a', wsName: 'ws', stale: true },
    ]
    const { container } = render(TabBar, { ...props, tabs: grouped })
    expect(container.querySelector('.repo-chip .stale-dot')).not.toBeNull()
    const tabDots = container.querySelectorAll('.tab .stale-dot')
    expect(tabDots).toHaveLength(1)
  })

  it('interleaved tabs [A, B, A] group by repoRoot in first-seen order', () => {
    const inter: TabInfo[] = [
      { id: '0', kind: 'repo', name: 'a', path: '/a', repoRoot: '/rA', wsName: 'default' },
      { id: '1', kind: 'repo', name: 'b', path: '/b', repoRoot: '/rB', wsName: 'default' },
      { id: '2', kind: 'repo', name: 'c', path: '/c', repoRoot: '/rA', wsName: 'ws2' },
    ]
    const { container } = render(TabBar, { ...props, tabs: inter })
    const chips = container.querySelectorAll('.repo-chip')
    // rA (2 tabs) grouped; rB solo → 1 chip; group A comes first (first-seen)
    expect(chips).toHaveLength(1)
    expect(chips[0]).toHaveTextContent('rA')
    expect(container.querySelectorAll('.tab-group .tab')).toHaveLength(2)
  })

  it('group color is stable across identical repoRoot values', () => {
    const t = (id: string, root: string): TabInfo =>
      ({ id, kind: 'repo', name: 'x', path: '/p' + id, repoRoot: root, wsName: 'w' + id })
    const a = render(TabBar, { ...props, tabs: [t('0', '/r'), t('1', '/r')] })
    const b = render(TabBar, { ...props, tabs: [t('5', '/r'), t('6', '/r')] })
    const colorA = (a.container.querySelector('.tab-group') as HTMLElement).style.getPropertyValue('--gcolor')
    const colorB = (b.container.querySelector('.tab-group') as HTMLElement).style.getPropertyValue('--gcolor')
    expect(colorA).toBe(colorB)
    expect(colorA).toMatch(/^var\(--graph-[0-7]\)$/)
  })
})

describe('TabBar ◇N workspace icon', () => {
  const props = { activeId: '0', onswitch: noop, onopen: noop, onclose: noop }
  const solo: TabInfo[] = [
    { id: '0', kind: 'repo', name: 'proj', path: '/x/proj', repoRoot: '/x/proj', wsName: 'default' },
  ]

  it('shows ◇N on a solo tab when its repo has ≥2 workspaces', () => {
    const { container } = render(TabBar, { ...props, tabs: solo, wsCounts: new Map([['/x/proj', 2]]) })
    const icon = container.querySelector('.ws-tab-icon')
    expect(icon).not.toBeNull()
    expect(icon).toHaveTextContent('◇2')
  })

  it('hides ◇N when the repo has a single workspace', () => {
    const { container } = render(TabBar, { ...props, tabs: solo, wsCounts: new Map([['/x/proj', 1]]) })
    expect(container.querySelector('.ws-tab-icon')).toBeNull()
  })

  it('hides ◇N when no workspace info is present at all', () => {
    const { container } = render(TabBar, { ...props, tabs: solo })
    expect(container.querySelector('.ws-tab-icon')).toBeNull()
  })

  it('renders ◇N on the repo chip for grouped tabs', () => {
    const grouped: TabInfo[] = [
      { id: '0', kind: 'repo', name: 'proj', path: '/x/proj', repoRoot: '/x/proj', wsName: 'default' },
      { id: '1', kind: 'repo', name: 'ws', path: '/x/ws', repoRoot: '/x/proj', wsName: 'feature' },
    ]
    const { container } = render(TabBar, { ...props, tabs: grouped, wsCounts: new Map([['/x/proj', 3]]) })
    expect(container.querySelector('.repo-chip .ws-tab-icon')).toHaveTextContent('◇3')
  })

  it('left-clicking the icon emits onWorkspaceIcon(key) and does NOT switch/close', async () => {
    const onWorkspaceIcon = vi.fn()
    const onswitch = vi.fn()
    const other: TabInfo = { id: '1', kind: 'repo', name: 'proj', path: '/x/proj', repoRoot: '/x/proj', wsName: 'default' }
    const { container } = render(TabBar, {
      ...props, activeId: '0', tabs: [{ ...solo[0], id: '0' }, other],
      wsCounts: new Map([['/x/proj', 2], ['/p1', 0]]),
      onWorkspaceIcon, onswitch,
    })
    const icon = container.querySelector('.ws-tab-icon')!
    await fireEvent.click(icon)
    expect(onWorkspaceIcon).toHaveBeenCalledWith('/x/proj', expect.any(Number), expect.any(Number))
    expect(onswitch).not.toHaveBeenCalled()
  })

  it('right-clicking a tab emits onTabMenu(tab) and suppresses the native menu', async () => {
    const onTabMenu = vi.fn()
    const { container } = render(TabBar, { ...props, tabs: solo, wsCounts: new Map(), onTabMenu })
    const evt = await fireEvent.contextMenu(container.querySelector('.tab')!)
    expect(evt).toBe(false) // preventDefault called
    expect(onTabMenu).toHaveBeenCalledWith(
      expect.objectContaining({ id: '0' }), expect.any(Number), expect.any(Number),
    )
  })
})
