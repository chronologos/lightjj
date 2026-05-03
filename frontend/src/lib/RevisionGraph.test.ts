import { describe, it, expect, vi } from 'vitest'
import { render, fireEvent } from '@testing-library/svelte'
import { SvelteSet } from 'svelte/reactivity'
import RevisionGraph from './RevisionGraph.svelte'
import type { LogEntry, LocalRef } from './api'
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
  empty: boolean
  mine: boolean
  author_email: string
  working_copies: string[]
  parent_ids: string[]
  bookmarks: LocalRef[]
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
      empty: overrides.empty ?? false,
      mine: overrides.mine ?? true,
      author_email: overrides.author_email,
      working_copies: overrides.working_copies,
      parent_ids: overrides.parent_ids ?? [],
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
    mutating: false,
    viewLabel: null,
    lastCheckedIndex: -1,
    onselect: vi.fn(),
    ontogglecheck: vi.fn(),
    onrangecheck: vi.fn(),
    oncontextmenu: vi.fn(),
    onresolvedivergence: vi.fn(),
    onnewfromchecked: vi.fn(),
    onabandonchecked: vi.fn(),
    onclearchecks: vi.fn(),
    onbookmarkclick: vi.fn(),
    onworkspaceclick: vi.fn(),
    currentWorkspace: 'default',
    remoteVisibility: {},
    rebase: createRebaseMode(),
    squash: createSquashMode(),
    split: createSplitMode(),
    theme: 'dark',
    prByBookmark: new Map(),
    impliedCommitIds: new Set<string>(),
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
      const entry = makeEntry({ bookmarks: [{ name: 'main' }, { name: 'feature' }] })
      const { container } = render(RevisionGraph, { props: defaultProps({ revisions: [entry] }) })
      const badges = container.querySelectorAll('.bookmark-badge')
      expect(badges).toHaveLength(2)
      expect(badges[0].textContent).toBe('⑂ main')
      expect(badges[1].textContent).toBe('⑂ feature')
    })

    it('conflicted bookmark shows ?? marker and red styling', () => {
      const entry = makeEntry({ bookmarks: [{ name: 'feat', conflict: true }, { name: 'main' }] })
      const { container } = render(RevisionGraph, { props: defaultProps({ revisions: [entry] }) })
      const badges = container.querySelectorAll('.bookmark-badge')
      expect(badges[0].textContent).toBe('⑂ feat??')
      expect(badges[0].classList.contains('conflicted')).toBe(true)
      expect(badges[0].querySelector('.conflict-marker')).toBeInTheDocument()
      expect(badges[1].classList.contains('conflicted')).toBe(false)
    })

    it('clicking conflicted bookmark passes the NAME, not the decorated display', () => {
      const onbookmarkclick = vi.fn()
      const entry = makeEntry({ bookmarks: [{ name: 'feat', conflict: true }] })
      const { container } = render(RevisionGraph, { props: defaultProps({ revisions: [entry], onbookmarkclick }) })
      ;(container.querySelector('.bookmark-badge') as HTMLElement).click()
      expect(onbookmarkclick).toHaveBeenCalledWith('feat')
    })

    it('renders workspace badges: current dimmed span, others clickable', () => {
      const onworkspaceclick = vi.fn()
      const onselect = vi.fn()
      const entry = makeEntry({ working_copies: ['default', 'feature'] })
      const { container } = render(RevisionGraph, {
        props: defaultProps({ revisions: [entry], currentWorkspace: 'default', onworkspaceclick, onselect }),
      })
      const badges = container.querySelectorAll('.workspace-badge')
      expect(badges).toHaveLength(2)
      expect(badges[0].tagName).toBe('SPAN')
      expect(badges[0].classList.contains('ws-current')).toBe(true)
      expect(badges[0].textContent).toBe('◇ default@')
      expect(badges[1].tagName).toBe('BUTTON')
      ;(badges[1] as HTMLElement).click()
      expect(onworkspaceclick).toHaveBeenCalledWith('feature')
      // stopPropagation — row select must NOT also fire
      expect(onselect).not.toHaveBeenCalled()
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

    it('shows (no description) placeholder when not empty but undescribed', () => {
      const entry = makeEntry({ description: '', empty: false })
      const { container } = render(RevisionGraph, { props: defaultProps({ revisions: [entry] }) })
      expect(container.querySelector('.desc-placeholder')?.textContent).toBe('(no description)')
      expect(container.querySelector('.description-text')).toBeNull()
    })

    it('shows (empty) only — not "(empty) (no description)" — for empty undescribed revisions', () => {
      const entry = makeEntry({ description: '', empty: true })
      const { container } = render(RevisionGraph, { props: defaultProps({ revisions: [entry] }) })
      expect(container.querySelector('.empty-label')?.textContent).toBe('(empty)')
      expect(container.querySelector('.desc-placeholder')).toBeNull()
    })

    it('shows (empty) before description when both present (empty merge commit)', () => {
      // PR merge via rebase → empty commit with real title. jj log shows
      // "(empty)" as a prefix LABEL here, not a placeholder.
      const entry = makeEntry({ description: 'merge main', empty: true })
      const { container } = render(RevisionGraph, { props: defaultProps({ revisions: [entry] }) })
      expect(container.querySelector('.empty-label')?.textContent).toBe('(empty)')
      expect(container.querySelector('.description-text')?.textContent).toBe('merge main')
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
      const entry = makeEntry({ bookmarks: [{ name: 'main' }] })
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
      const badge = container.querySelector('.badge-source')
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
      const source = container.querySelector('.badge-source')
      const target = container.querySelector('.badge-target')
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
      const badge = container.querySelector('.badge-source')
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
      const target = container.querySelector('.badge-target')
      expect(target?.textContent).toContain('into')
    })
  })

  describe('view label badge', () => {
    it('no badge renders when viewLabel is null', () => {
      const { container } = render(RevisionGraph, { props: defaultProps({ viewLabel: null }) })
      expect(container.querySelectorAll('.view-btn')).toHaveLength(0)
    })

    it('renders the label string verbatim', () => {
      const { container } = render(RevisionGraph, { props: defaultProps({ viewLabel: 'My work' }) })
      const badge = container.querySelector('.view-btn')
      expect(badge).toHaveClass('view-btn-active')
      expect(badge).toHaveTextContent('My work')
    })
  })

  describe('stale-while-revalidate', () => {
    it('shows spinner on initial load (loading=true, no revisions)', () => {
      const { container } = render(RevisionGraph, {
        props: defaultProps({ loading: true, revisions: [] }),
      })
      expect(container.querySelector('.spinner')).toBeInTheDocument()
      expect(container.querySelector('.revision-list')).not.toBeInTheDocument()
      // Refresh bar always mounted (reserves 2px) but not active
      expect(container.querySelector('.refresh-bar')).not.toHaveClass('active')
    })

    it('keeps showing stale revisions during reload (loading=true, has revisions)', () => {
      const entry = makeEntry()
      const { container } = render(RevisionGraph, {
        props: defaultProps({ loading: true, revisions: [entry] }),
      })
      // List stays mounted — no spinner
      expect(container.querySelector('.spinner')).not.toBeInTheDocument()
      expect(container.querySelector('.revision-list')).toBeInTheDocument()
      // But dimmed + progress bar active
      expect(container.querySelector('.revision-list')).toHaveClass('refreshing')
      expect(container.querySelector('.refresh-bar')).toHaveClass('active')
    })

    it('shows refresh state during mutation (mutating=true, loading=false)', () => {
      // Covers the first phase of SSH mutations: await api.abandon() is in
      // flight but loadLog hasn't started yet
      const entry = makeEntry()
      const { container } = render(RevisionGraph, {
        props: defaultProps({ mutating: true, loading: false, revisions: [entry] }),
      })
      expect(container.querySelector('.revision-list')).toHaveClass('refreshing')
      expect(container.querySelector('.refresh-bar')).toHaveClass('active')
    })

    it('no refresh indicator when idle', () => {
      const entry = makeEntry()
      const { container } = render(RevisionGraph, {
        props: defaultProps({ loading: false, mutating: false, revisions: [entry] }),
      })
      expect(container.querySelector('.revision-list')).not.toHaveClass('refreshing')
      // Bar is present (no layout shift) but inactive
      expect(container.querySelector('.refresh-bar')).not.toHaveClass('active')
    })

    it('disables batch action buttons while mutating', () => {
      const checked = new SvelteSet<string>(['abcdef12'])
      const entry = makeEntry({ change_id: 'abcdef12' })
      const { container } = render(RevisionGraph, {
        props: defaultProps({ revisions: [entry], checkedRevisions: checked, mutating: true }),
      })
      const buttons = container.querySelectorAll('.batch-actions-bar .btn')
      // new + abandon disabled; clear stays enabled (non-mutating)
      expect(buttons[0]).toBeDisabled() // new
      expect(buttons[1]).toBeDisabled() // abandon
      expect(buttons[2]).not.toBeDisabled() // clear
    })

    it('blocks context menu during refresh', () => {
      const oncontextmenu = vi.fn()
      const entry = makeEntry()
      const { container } = render(RevisionGraph, {
        props: defaultProps({ revisions: [entry], mutating: true, oncontextmenu }),
      })
      const row = container.querySelector('.graph-row')!
      fireEvent.contextMenu(row)
      expect(oncontextmenu).not.toHaveBeenCalled()
    })

    it('shows stale count badge during refresh', () => {
      const entries = [makeEntry({ change_id: 'aaa' }), makeEntry({ change_id: 'bbb' })]
      const { container } = render(RevisionGraph, {
        props: defaultProps({ loading: true, revisions: entries }),
      })
      // Badge shows stale count (consistent with showing stale list)
      expect(container.querySelector('.panel-badge')?.textContent).toContain('2')
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

    it('shows hollow indicator for implied (gap-fill) revisions', () => {
      const entries = [
        makeEntry({ change_id: 'aaa', commit_id: 'a1', parent_ids: ['b2'] }),
        makeEntry({ change_id: 'bbb', commit_id: 'b2', parent_ids: ['c3'] }), // gap
        makeEntry({ change_id: 'ccc', commit_id: 'c3', parent_ids: [] }),
      ]
      const checked = new SvelteSet(['aaa', 'ccc']) // skip middle
      const implied = new Set(['b2']) // App would compute this
      const { container } = render(RevisionGraph, {
        props: defaultProps({ revisions: entries, checkedRevisions: checked, impliedCommitIds: implied }),
      })
      const rows = container.querySelectorAll('.graph-row.node-row')
      expect(rows[0]).toHaveClass('checked')
      expect(rows[0].querySelector('.check-gutter')?.textContent).toBe('✓')
      expect(rows[1]).toHaveClass('implied')
      expect(rows[1]).not.toHaveClass('checked')
      expect(rows[1].querySelector('.check-gutter')?.textContent).toBe('◌')
      expect(rows[2]).toHaveClass('checked')
      expect(rows[2].querySelector('.check-gutter')?.textContent).toBe('✓')
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

  describe('virtualization', () => {
    // These tests verify the THRESHOLD branch — below, eager full-render;
    // above, .virtual-list engages. Actual virtual-item rendering needs a
    // real layout engine (ResizeObserver, getBoundingClientRect) that jsdom
    // lacks; tanstack's observeElementRect never fires so getVirtualItems()
    // returns []. Verified manually in browser.

    it('below threshold: renders all rows eagerly (no .virtual-list)', () => {
      const entries = Array.from({ length: 10 }, (_, i) =>
        makeEntry({ change_id: `ch${i}`, commit_id: `co${i}` }))
      const { container } = render(RevisionGraph, { props: defaultProps({ revisions: entries }) })
      expect(container.querySelector('.virtual-list')).toBeNull()
      // 10 revs × (node + desc) = 20 rows, all in DOM
      expect(container.querySelectorAll('.graph-row')).toHaveLength(20)
    })

    it('above threshold: virtual-list branch engages, container sized to totalSize', async () => {
      // 200 revisions → 400 flatLines (node+desc) → above VIRTUALIZE_THRESHOLD(150)
      const entries = Array.from({ length: 200 }, (_, i) =>
        makeEntry({ change_id: `ch${i}`, commit_id: `co${i}` }))
      const { container } = render(RevisionGraph, { props: defaultProps({ revisions: entries }) })

      const list = container.querySelector('.revision-list') as HTMLElement
      expect(list.classList.contains('virtual-list')).toBe(true)

      // Let the setOptions $effect + store update settle
      await new Promise(r => setTimeout(r, 0))

      // totalSize = 400 lines × 18px = 7200px. Proves the virtualizer computes
      // correctly even though jsdom can't give it a viewport to render items.
      expect(list.style.height).toBe('7200px')
    })

    it('shrink above threshold: no crash when virtual items outlast flatLines', async () => {
      // Repro: flatLines shrinks but stays above threshold. Template re-renders
      // BEFORE setOptions $effect (post-effect in Svelte 5), so virtual items
      // hold the OLD count while flatLines is already shorter → item.index
      // out of bounds. The {#if line} guard + ?.key fallback prevents the crash.
      //
      // jsdom can't fully simulate scrolling to a stale index, but rerender()
      // with a smaller list exercises the transition path.
      const mk = (n: number) => Array.from({ length: n }, (_, i) =>
        makeEntry({ change_id: `ch${i}`, commit_id: `co${i}` }))

      const { container, rerender } = render(RevisionGraph, {
        props: defaultProps({ revisions: mk(200) }), // 400 lines, virtualized
      })
      await new Promise(r => setTimeout(r, 0))

      // Shrink to 100 revs = 200 lines — still above threshold (150).
      // Without the guard, this would throw TypeError on flatLines[item.index].eid
      await rerender(defaultProps({ revisions: mk(100) }))
      await new Promise(r => setTimeout(r, 0))

      // No crash + container resized to new totalSize (200 × 18 = 3600px)
      const list = container.querySelector('.revision-list') as HTMLElement
      expect(list.classList.contains('virtual-list')).toBe(true)
      expect(list.style.height).toBe('3600px')
    })
  })
})
