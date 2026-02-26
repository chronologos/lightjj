import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/svelte'
import { SvelteSet } from 'svelte/reactivity'
import RevisionGraph from './RevisionGraph.svelte'
import type { LogEntry } from './api'
import { createRebaseMode, createSquashMode, createSplitMode } from './modes.svelte'

function activeRebase(sources: string[], sourceKey?: string, targetKey?: string) {
  const m = createRebaseMode()
  m.enter(sources)
  if (sourceKey) m.handleKey(sourceKey)
  if (targetKey) m.handleKey(targetKey)
  return m
}

function activeSquash(sources: string[]) {
  const m = createSquashMode()
  m.enter(sources)
  return m
}

function makeEntry(overrides: Partial<{
  change_id: string
  commit_id: string
  change_prefix: number
  commit_prefix: number
  is_working_copy: boolean
  hidden: boolean
  immutable: boolean
  conflicted: boolean
  divergent: boolean
  working_copies: string[]
  bookmarks: string[]
  description: string
  gutter: string
}> = {}): LogEntry {
  return {
    commit: {
      change_id: overrides.change_id ?? 'abcdef12',
      commit_id: overrides.commit_id ?? 'deadbeef',
      change_prefix: overrides.change_prefix ?? 4,
      commit_prefix: overrides.commit_prefix ?? 4,
      is_working_copy: overrides.is_working_copy ?? false,
      hidden: overrides.hidden ?? false,
      immutable: overrides.immutable ?? false,
      conflicted: overrides.conflicted ?? false,
      divergent: overrides.divergent ?? false,
      working_copies: overrides.working_copies,
    },
    description: overrides.description ?? 'test commit',
    bookmarks: overrides.bookmarks,
    graph_lines: [{ gutter: overrides.gutter ?? '○ ', is_node: true }],
  }
}

function defaultProps(overrides: Record<string, unknown> = {}) {
  return {
    revisions: [],
    selectedIndex: -1,
    checkedRevisions: new SvelteSet<string>(),
    loading: false,
    revsetFilter: '',
    viewMode: 'log' as const,
    lastCheckedIndex: -1,
    onselect: vi.fn(),
    oncheck: vi.fn(),
    onrangecheck: vi.fn(),
    oncontextmenu: vi.fn(),
    onnewfromchecked: vi.fn(),
    onabandonchecked: vi.fn(),
    onclearchecks: vi.fn(),
    onrevsetsubmit: vi.fn(),
    onrevsetclear: vi.fn(),
    onrevsetchange: vi.fn(),
    onrevsetescaped: vi.fn(),
    onviewmodechange: vi.fn(),
    onbookmarkclick: vi.fn(),
    rebase: createRebaseMode(),
    squash: createSquashMode(),
    split: createSplitMode(),
    isDark: true,
    prByBookmark: new Map(),
    ...overrides,
  }
}

describe('RevisionGraph', () => {
  describe('rendering', () => {
    it('renders node rows with SVG graph gutter', () => {
      const entry = makeEntry({ gutter: '○ ' })
      const { container } = render(RevisionGraph, { props: defaultProps({ revisions: [entry] }) })
      const svgs = container.querySelectorAll('.graph-svg')
      expect(svgs.length).toBeGreaterThan(0)
      // Node row should have an SVG element for the graph gutter
      const nodeRow = container.querySelector('.graph-row.node-row')
      expect(nodeRow?.querySelector('.graph-svg')).toBeInTheDocument()
    })

    it('renders description line for each revision', () => {
      const entry = makeEntry({ description: 'my change' })
      const { container } = render(RevisionGraph, { props: defaultProps({ revisions: [entry] }) })
      expect(container.querySelector('.description-text')?.textContent).toBe('my change')
    })

    it('renders bookmark labels when present', () => {
      const entry = makeEntry({ bookmarks: ['main', 'feature'] })
      const { container } = render(RevisionGraph, { props: defaultProps({ revisions: [entry] }) })
      const badges = container.querySelectorAll('.bookmark-badge')
      expect(badges).toHaveLength(2)
      expect(badges[0].textContent).toBe('⑂ main')
      expect(badges[1].textContent).toBe('⑂ feature')
    })

    it('renders working copy labels when present', () => {
      const entry = makeEntry({ working_copies: ['default'] })
      const { container } = render(RevisionGraph, { props: defaultProps({ revisions: [entry] }) })
      const ws = container.querySelector('.workspace-badge')
      expect(ws?.textContent).toBe('◇ default@')
    })

    it('shows revision count in header badge', () => {
      const entries = [makeEntry({ change_id: 'aaa' }), makeEntry({ change_id: 'bbb' })]
      const { container } = render(RevisionGraph, { props: defaultProps({ revisions: entries }) })
      const badge = container.querySelector('.panel-badge')
      expect(badge?.textContent).toContain('2')
    })

    it('dims immutable commits', () => {
      const entry = makeEntry({ immutable: true, gutter: '◆ ' })
      const { container } = render(RevisionGraph, { props: defaultProps({ revisions: [entry] }) })
      const immutableRows = container.querySelectorAll('.graph-row.immutable')
      expect(immutableRows.length).toBeGreaterThan(0)
    })

    it('marks working copy rows with wc class', () => {
      const entry = makeEntry({ is_working_copy: true, gutter: '@ ' })
      const { container } = render(RevisionGraph, { props: defaultProps({ revisions: [entry] }) })
      const wcRows = container.querySelectorAll('.graph-row.wc')
      expect(wcRows.length).toBeGreaterThan(0)
    })

    it('hides revisions with hidden-rev class', () => {
      const entry = makeEntry({ hidden: true })
      const { container } = render(RevisionGraph, { props: defaultProps({ revisions: [entry] }) })
      const hiddenRows = container.querySelectorAll('.graph-row.hidden-rev')
      expect(hiddenRows.length).toBeGreaterThan(0)
    })

    it('shows (no description) for empty description', () => {
      const entry = makeEntry({ description: '' })
      const { container } = render(RevisionGraph, { props: defaultProps({ revisions: [entry] }) })
      expect(container.querySelector('.description-text')?.textContent).toBe('(no description)')
    })
  })

  describe('flatLines computation via DOM', () => {
    it('produces 2 DOM rows per entry without bookmarks (node + desc)', () => {
      const entry = makeEntry()
      const { container } = render(RevisionGraph, { props: defaultProps({ revisions: [entry] }) })
      const rows = container.querySelectorAll('.graph-row')
      expect(rows).toHaveLength(2) // node-row + desc-row
    })

    it('produces 3 DOM rows per entry with bookmarks (node + bookmark + desc)', () => {
      const entry = makeEntry({ bookmarks: ['main'] })
      const { container } = render(RevisionGraph, { props: defaultProps({ revisions: [entry] }) })
      const rows = container.querySelectorAll('.graph-row')
      expect(rows).toHaveLength(3) // node-row + bookmark-row + desc-row
    })

    it('continuation gutter renders SVG on both node and desc rows', () => {
      const entry = makeEntry({ gutter: '@ ─╮', is_working_copy: true })
      const { container } = render(RevisionGraph, { props: defaultProps({ revisions: [entry] }) })
      // Both node row and desc row should have an SVG graph gutter
      const nodeRow = container.querySelector('.graph-row.node-row')
      const descRow = container.querySelector('.graph-row.desc-row')
      expect(nodeRow?.querySelector('.graph-svg')).toBeInTheDocument()
      expect(descRow?.querySelector('.graph-svg')).toBeInTheDocument()
    })
  })

  describe('interaction', () => {
    it('clicking a node row calls onselect with correct index', async () => {
      const onselect = vi.fn()
      const entries = [makeEntry({ change_id: 'aaa' }), makeEntry({ change_id: 'bbb' })]
      const { container } = render(RevisionGraph, { props: defaultProps({ revisions: entries, onselect }) })
      const nodeRows = container.querySelectorAll('.graph-row.node-row')
      await fireEvent.click(nodeRows[1])
      expect(onselect).toHaveBeenCalledWith(1)
    })

    it('shift-click calls onrangecheck', async () => {
      const onrangecheck = vi.fn()
      const entries = [makeEntry({ change_id: 'aaa' }), makeEntry({ change_id: 'bbb' })]
      const { container } = render(RevisionGraph, {
        props: defaultProps({ revisions: entries, onrangecheck, lastCheckedIndex: 0 }),
      })
      const nodeRows = container.querySelectorAll('.graph-row.node-row')
      await fireEvent.click(nodeRows[1], { shiftKey: true })
      expect(onrangecheck).toHaveBeenCalledWith(0, 1)
    })

    it('checked revision shows checkmark in check gutter', () => {
      const checked = new SvelteSet<string>(['abcdef12'])
      const entry = makeEntry({ change_id: 'abcdef12' })
      const { container } = render(RevisionGraph, {
        props: defaultProps({ revisions: [entry], checkedRevisions: checked }),
      })
      const checkGutter = container.querySelector('.check-gutter')
      expect(checkGutter?.textContent?.trim()).toBe('✓')
    })
  })

  describe('rebase mode', () => {
    it('shows source badge on source revisions', () => {
      const entry = makeEntry({ change_id: 'src1' })
      const { container } = render(RevisionGraph, {
        props: defaultProps({
          revisions: [entry],
          rebase: activeRebase(['src1']),
        }),
      })
      const badge = container.querySelector('.rebase-source')
      expect(badge).toBeInTheDocument()
      expect(badge?.textContent).toContain('move')
    })

    it('shows rebase mode indicator with source/target mode labels', () => {
      const entries = [makeEntry({ change_id: 'src1' }), makeEntry({ change_id: 'tgt1' })]
      const { container } = render(RevisionGraph, {
        props: defaultProps({
          revisions: entries,
          selectedIndex: 1,
          rebase: activeRebase(['src1'], 's', 'a'),
        }),
      })
      const source = container.querySelector('.rebase-source')
      const target = container.querySelector('.rebase-target')
      expect(source?.textContent).toContain('source')
      expect(target?.textContent).toContain('after')
    })
  })

  describe('squash mode', () => {
    it('shows squash source badge', () => {
      const entry = makeEntry({ change_id: 'sq1' })
      const { container } = render(RevisionGraph, {
        props: defaultProps({
          revisions: [entry],
          squash: activeSquash(['sq1']),
        }),
      })
      const badge = container.querySelector('.rebase-source')
      expect(badge).toBeInTheDocument()
      expect(badge?.textContent).toContain('from')
    })

    it('shows squash mode indicator', () => {
      const entries = [makeEntry({ change_id: 'sq1' }), makeEntry({ change_id: 'tgt1' })]
      const { container } = render(RevisionGraph, {
        props: defaultProps({
          revisions: entries,
          selectedIndex: 1,
          squash: activeSquash(['sq1']),
        }),
      })
      const target = container.querySelector('.rebase-target')
      expect(target?.textContent).toContain('into')
    })
  })

  describe('revset filter', () => {
    it('input renders with placeholder', () => {
      render(RevisionGraph, { props: defaultProps() })
      expect(screen.getByPlaceholderText('revset filter (press / to focus)')).toBeInTheDocument()
    })

    it('Enter in input calls onrevsetsubmit', async () => {
      const onrevsetsubmit = vi.fn()
      render(RevisionGraph, { props: defaultProps({ onrevsetsubmit }) })
      const input = screen.getByPlaceholderText('revset filter (press / to focus)')
      await fireEvent.keyDown(input, { key: 'Enter' })
      expect(onrevsetsubmit).toHaveBeenCalledTimes(1)
    })

    it('Escape in input calls onrevsetescaped', async () => {
      const onrevsetescaped = vi.fn()
      render(RevisionGraph, { props: defaultProps({ onrevsetescaped }) })
      const input = screen.getByPlaceholderText('revset filter (press / to focus)')
      await fireEvent.keyDown(input, { key: 'Escape' })
      expect(onrevsetescaped).toHaveBeenCalledTimes(1)
    })

    it('clear button calls onrevsetclear when filter text present', async () => {
      const onrevsetclear = vi.fn()
      const { container } = render(RevisionGraph, {
        props: defaultProps({ revsetFilter: 'trunk()', onrevsetclear }),
      })
      const clearBtn = container.querySelector('.revset-clear')
      expect(clearBtn).toBeInTheDocument()
      await fireEvent.click(clearBtn!)
      expect(onrevsetclear).toHaveBeenCalledTimes(1)
    })
  })

  describe('view mode toggle', () => {
    it('Log button active when viewMode=log', () => {
      const { container } = render(RevisionGraph, { props: defaultProps({ viewMode: 'log' }) })
      const buttons = container.querySelectorAll('.view-btn')
      expect(buttons[0]).toHaveClass('view-btn-active')
      expect(buttons[1]).not.toHaveClass('view-btn-active')
    })

    it('Tracked button active when viewMode=tracked', () => {
      const { container } = render(RevisionGraph, { props: defaultProps({ viewMode: 'tracked' }) })
      const buttons = container.querySelectorAll('.view-btn')
      expect(buttons[0]).not.toHaveClass('view-btn-active')
      expect(buttons[1]).toHaveClass('view-btn-active')
    })

    it('clicking toggle calls onviewmodechange', async () => {
      const onviewmodechange = vi.fn()
      const { container } = render(RevisionGraph, {
        props: defaultProps({ viewMode: 'log', onviewmodechange }),
      })
      const buttons = container.querySelectorAll('.view-btn')
      // Click the non-active "Tracked" button
      await fireEvent.click(buttons[1])
      expect(onviewmodechange).toHaveBeenCalledTimes(1)
    })
  })

  describe('conflicted commits', () => {
    it('renders SVG graph for conflicted node rows', () => {
      const entry = makeEntry({ conflicted: true, gutter: '× ' })
      const { container } = render(RevisionGraph, {
        props: defaultProps({ revisions: [entry] }),
      })
      // Conflicted node row should have an SVG graph element
      const nodeRow = container.querySelector('.graph-row.node-row')
      expect(nodeRow?.querySelector('.graph-svg')).toBeInTheDocument()
    })

    it('renders SVG graph for non-conflicted commits too', () => {
      const entry = makeEntry({ conflicted: false, gutter: '○ ' })
      const { container } = render(RevisionGraph, {
        props: defaultProps({ revisions: [entry] }),
      })
      // Non-conflicted node row also has SVG graph
      const nodeRow = container.querySelector('.graph-row.node-row')
      expect(nodeRow?.querySelector('.graph-svg')).toBeInTheDocument()
    })

    it('conflicted and non-conflicted node rows both render with SVG', () => {
      const conflicted = makeEntry({ change_id: 'ccc', conflicted: true, gutter: '× ' })
      const normal = makeEntry({ change_id: 'nnn', conflicted: false, gutter: '○ ' })
      const { container } = render(RevisionGraph, {
        props: defaultProps({ revisions: [conflicted, normal] }),
      })
      const nodeRows = container.querySelectorAll('.graph-row.node-row')
      expect(nodeRows).toHaveLength(2)
      // Both should have SVG elements
      expect(nodeRows[0].querySelector('.graph-svg')).toBeInTheDocument()
      expect(nodeRows[1].querySelector('.graph-svg')).toBeInTheDocument()
    })
  })
})
