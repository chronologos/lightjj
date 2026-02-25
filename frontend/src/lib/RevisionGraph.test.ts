import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/svelte'
import { SvelteSet } from 'svelte/reactivity'
import RevisionGraph from './RevisionGraph.svelte'
import type { LogEntry } from './api'

function makeEntry(overrides: Partial<{
  change_id: string
  commit_id: string
  change_prefix: number
  commit_prefix: number
  is_working_copy: boolean
  hidden: boolean
  immutable: boolean
  conflicted: boolean
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
    rebaseMode: false,
    rebaseSources: [],
    rebaseSourceMode: '-r',
    rebaseTargetMode: '-d',
    squashMode: false,
    squashSources: [],
    squashKeepEmptied: false,
    squashUseDestMsg: false,
    splitMode: false,
    splitRevision: '',
    splitParallel: false,
    ...overrides,
  }
}

describe('RevisionGraph', () => {
  describe('rendering', () => {
    it('renders node rows with gutter characters', () => {
      const entry = makeEntry({ gutter: '○ ' })
      const { container } = render(RevisionGraph, { props: defaultProps({ revisions: [entry] }) })
      const gutters = container.querySelectorAll('.gutter')
      expect(gutters.length).toBeGreaterThan(0)
      // Node row gutter should contain the gutter text
      expect(gutters[0].textContent).toBe('○ ')
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
      expect(badges[0].textContent).toBe('main')
      expect(badges[1].textContent).toBe('feature')
    })

    it('renders working copy labels when present', () => {
      const entry = makeEntry({ working_copies: ['default'] })
      const { container } = render(RevisionGraph, { props: defaultProps({ revisions: [entry] }) })
      const ws = container.querySelector('.workspace-badge')
      expect(ws?.textContent).toBe('default@')
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

    it('continuation gutter replaces @ with │ and branch chars with space', () => {
      const entry = makeEntry({ gutter: '@ ─╮', is_working_copy: true })
      const { container } = render(RevisionGraph, { props: defaultProps({ revisions: [entry] }) })
      const gutters = container.querySelectorAll('.gutter')
      // First gutter is the node row (original), second is the desc row (continuation)
      expect(gutters[0].textContent).toBe('@ ─╮')
      expect(gutters[1].textContent).toBe('│   ')
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
          rebaseMode: true,
          rebaseSources: ['src1'],
          rebaseSourceMode: '-r',
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
          rebaseMode: true,
          rebaseSources: ['src1'],
          rebaseSourceMode: '-s',
          rebaseTargetMode: '--insert-after',
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
          squashMode: true,
          squashSources: ['sq1'],
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
          squashMode: true,
          squashSources: ['sq1'],
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
    it('applies conflict-gutter class to conflicted node rows', () => {
      const entry = makeEntry({ conflicted: true, gutter: '× ' })
      const { container } = render(RevisionGraph, {
        props: defaultProps({ revisions: [entry] }),
      })
      // Only the node row gutter gets conflict-gutter, not the desc row
      const conflictGutters = container.querySelectorAll('.gutter.conflict-gutter')
      expect(conflictGutters).toHaveLength(1)
    })

    it('does not apply conflict-gutter to non-conflicted commits', () => {
      const entry = makeEntry({ conflicted: false, gutter: '○ ' })
      const { container } = render(RevisionGraph, {
        props: defaultProps({ revisions: [entry] }),
      })
      expect(container.querySelectorAll('.gutter.conflict-gutter')).toHaveLength(0)
    })

    it('conflict-gutter excludes mutable-gutter class', () => {
      const entry = makeEntry({ conflicted: true, gutter: '× ' })
      const { container } = render(RevisionGraph, {
        props: defaultProps({ revisions: [entry] }),
      })
      // The node row gutter should have conflict-gutter but NOT mutable-gutter
      const nodeGutter = container.querySelector('.graph-row.node-row .gutter')
      expect(nodeGutter).toHaveClass('conflict-gutter')
      expect(nodeGutter).not.toHaveClass('mutable-gutter')
    })
  })
})
