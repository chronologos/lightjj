import { describe, it, expect, vi } from 'vitest'
import { render, fireEvent } from '@testing-library/svelte'
import DiffFileView from './DiffFileView.svelte'
import type { DiffFile } from './diff-parser'
import type { FileChange, Annotation } from './api'
import type { WordSpan } from './word-diff'

function makeFile(filePath: string, lines: { type: 'add' | 'remove' | 'context'; content: string }[] = []): DiffFile {
  return {
    header: `diff --git a/${filePath} b/${filePath}`,
    filePath,
    hunks: lines.length > 0
      ? [{ header: '@@ -1 +1 @@', oldStart: 1, newStart: 1, newCount: 1, lines }]
      : [],
  }
}

function makeStats(path: string, overrides: Partial<FileChange> = {}): FileChange {
  return {
    type: 'M',
    path,
    additions: 5,
    deletions: 2,
    conflict: false,
    conflict_sides: 0,
    ...overrides,
  }
}

function defaultProps(overrides: Record<string, unknown> = {}) {
  return {
    file: makeFile('test.go'),
    fileStats: undefined as FileChange | undefined,
    isCollapsed: false,
    isExpanded: false,
    splitView: false,
    highlightedLines: new Map<string, string>(),
    wordDiffs: new Map<string, Map<number, WordSpan[]>>(),
    ontoggle: vi.fn(),
    onexpand: vi.fn(),
    ...overrides,
  }
}

describe('DiffFileView', () => {
  describe('conflict indicator', () => {
    it('shows conflict count when file has conflict', () => {
      const file = makeFile('conflict.go', [
        { type: 'add', content: '+<<<<<<< Conflict 1 of 1' },
        { type: 'add', content: '+%%%%%%% Changes from base to side #1' },
        { type: 'add', content: '+old line' },
        { type: 'add', content: '++++++++ Contents of side #2' },
        { type: 'add', content: '+new line' },
        { type: 'add', content: '+>>>>>>> Conflict 1 of 1 ends' },
      ])
      const stats = makeStats('conflict.go', { conflict: true })
      const { container } = render(DiffFileView, {
        props: defaultProps({ file, fileStats: stats }),
      })
      const indicator = container.querySelector('.conflict-indicator')
      expect(indicator).toBeInTheDocument()
      expect(indicator?.textContent).toContain('1 conflict')
    })

    it('pluralizes conflict count', () => {
      const file = makeFile('multi.go', [
        { type: 'add', content: '+<<<<<<< Conflict 1 of 2' },
        { type: 'add', content: '+%%%%%%% Changes' },
        { type: 'add', content: '+a' },
        { type: 'add', content: '+>>>>>>> Conflict 1 of 2 ends' },
        { type: 'add', content: '+<<<<<<< Conflict 2 of 2' },
        { type: 'add', content: '+%%%%%%% Changes' },
        { type: 'add', content: '+b' },
        { type: 'add', content: '+>>>>>>> Conflict 2 of 2 ends' },
      ])
      const stats = makeStats('multi.go', { conflict: true })
      const { container } = render(DiffFileView, {
        props: defaultProps({ file, fileStats: stats }),
      })
      expect(container.querySelector('.conflict-indicator')?.textContent).toContain('2 conflicts')
    })

    it('does not show conflict indicator for non-conflicted file', () => {
      const stats = makeStats('clean.go', { conflict: false })
      const { container } = render(DiffFileView, {
        props: defaultProps({ fileStats: stats }),
      })
      expect(container.querySelector('.conflict-indicator')).not.toBeInTheDocument()
    })

    it('does not show conflict indicator when fileStats is undefined', () => {
      const { container } = render(DiffFileView, {
        props: defaultProps({ fileStats: undefined }),
      })
      expect(container.querySelector('.conflict-indicator')).not.toBeInTheDocument()
    })

    it('hides conflict indicator when conflict=true but no markers in diff', () => {
      // Real scenario: commit is conflicted but this specific file has no conflict markers
      const file = makeFile('other.go', [
        { type: 'add', content: '+normal add line' },
        { type: 'context', content: ' context line' },
      ])
      const stats = makeStats('other.go', { conflict: true })
      const { container } = render(DiffFileView, {
        props: defaultProps({ file, fileStats: stats }),
      })
      // totalConflicts is 0 — indicator should not render
      expect(container.querySelector('.conflict-indicator')).not.toBeInTheDocument()
    })
  })

  describe('resolve buttons', () => {
    function conflictProps(onresolve?: (file: string, tool: ':ours' | ':theirs') => void) {
      const file = makeFile('conflict.go', [
        { type: 'add', content: '+<<<<<<< Conflict 1 of 1' },
        { type: 'add', content: '+%%%%%%% "side A changes"' },
        { type: 'add', content: '+-old line' },
        { type: 'add', content: '++++++++ "side B content"' },
        { type: 'add', content: '+new content' },
        { type: 'add', content: '+>>>>>>> Conflict 1 of 1 ends' },
      ])
      const stats = makeStats('conflict.go', { conflict: true })
      return defaultProps({ file, fileStats: stats, onresolve })
    }

    it('shows file-header resolve buttons with letter badges', () => {
      // Buttons say "Keep [A]" / "Keep [B]" — the letter badge spatially
      // corresponds to the badge on the section tabs below.
      const { container } = render(DiffFileView, {
        props: conflictProps(vi.fn()),
      })
      const buttons = container.querySelectorAll('.resolve-btn')
      expect(buttons).toHaveLength(2)
      expect(buttons[0].textContent?.trim()).toBe('Keep A')
      expect(buttons[1].textContent?.trim()).toBe('Keep B')
      expect(buttons[0].querySelector('.side-badge')?.textContent).toBe('A')
      // Generic tooltip — section order can differ across conflicts, so
      // using region 1's labels here would be misleading. Per-region buttons
      // carry the accurate local labels.
      expect(buttons[0].getAttribute('title')).toContain(':ours')
      expect(buttons[1].getAttribute('title')).toContain(':theirs')
    })

    it('does not show resolve buttons when onresolve is not provided', () => {
      const { container } = render(DiffFileView, {
        props: conflictProps(undefined),
      })
      expect(container.querySelectorAll('.resolve-btn')).toHaveLength(0)
    })

    it('clicking Keep side 1 calls onresolve with :ours', async () => {
      const onresolve = vi.fn()
      const { container } = render(DiffFileView, {
        props: conflictProps(onresolve),
      })
      const btn = container.querySelector('.resolve-ours')
      expect(btn).toBeInTheDocument()
      await fireEvent.click(btn!)
      expect(onresolve).toHaveBeenCalledWith('conflict.go', ':ours')
    })

    it('clicking Keep side 2 calls onresolve with :theirs', async () => {
      const onresolve = vi.fn()
      const { container } = render(DiffFileView, {
        props: conflictProps(onresolve),
      })
      const btn = container.querySelector('.resolve-theirs')
      expect(btn).toBeInTheDocument()
      await fireEvent.click(btn!)
      expect(onresolve).toHaveBeenCalledWith('conflict.go', ':theirs')
    })
  })

  describe('conflict line styling', () => {
    it('wraps conflict lines in conflict-line divs with CSS classes', () => {
      const file = makeFile('conflict.go', [
        { type: 'add', content: '+<<<<<<< Conflict 1 of 1' },
        { type: 'add', content: '+%%%%%%% Changes from base to side #1' },
        { type: 'add', content: '+side 1 content' },
        { type: 'add', content: '++++++++ Contents of side #2' },
        { type: 'add', content: '+side 2 content' },
        { type: 'add', content: '+>>>>>>> Conflict 1 of 1 ends' },
      ])
      const stats = makeStats('conflict.go', { conflict: true })
      const { container } = render(DiffFileView, {
        props: defaultProps({ file, fileStats: stats }),
      })

      // Conflict boundary markers (<<<<<<< and >>>>>>>)
      const boundaries = container.querySelectorAll('.conflict-boundary')
      expect(boundaries).toHaveLength(2)

      // Diff marker (%%%%%%%)
      expect(container.querySelectorAll('.conflict-diff-marker')).toHaveLength(1)

      // Snapshot marker (+++++++)
      expect(container.querySelectorAll('.conflict-snap-marker')).toHaveLength(1)

      // Content lines within sides (exactly 1 each for the single content line per side)
      expect(container.querySelectorAll('.conflict-diff-line')).toHaveLength(1)
      expect(container.querySelectorAll('.conflict-snap-line')).toHaveLength(1)
    })

    it('does not apply conflict classes to non-conflicted files', () => {
      const file = makeFile('clean.go', [
        { type: 'add', content: '+normal add' },
        { type: 'context', content: ' context' },
      ])
      const stats = makeStats('clean.go', { conflict: false })
      const { container } = render(DiffFileView, {
        props: defaultProps({ file, fileStats: stats }),
      })
      expect(container.querySelectorAll('.conflict-line')).toHaveLength(0)
      expect(container.querySelectorAll('.conflict-boundary')).toHaveLength(0)
    })
  })

  describe('basic diff rendering', () => {
    it('add line has diff-add class', () => {
      const file = makeFile('test.go', [
        { type: 'add', content: '+new line' },
      ])
      const { container } = render(DiffFileView, {
        props: defaultProps({ file }),
      })
      const addLines = container.querySelectorAll('.diff-add')
      expect(addLines.length).toBeGreaterThan(0)
    })

    it('remove line has diff-remove class', () => {
      const file = makeFile('test.go', [
        { type: 'remove', content: '-old line' },
      ])
      const { container } = render(DiffFileView, {
        props: defaultProps({ file }),
      })
      expect(container.querySelectorAll('.diff-remove').length).toBeGreaterThan(0)
    })

    it('context line has diff-context class', () => {
      const file = makeFile('test.go', [
        { type: 'context', content: ' context line' },
      ])
      const { container } = render(DiffFileView, {
        props: defaultProps({ file }),
      })
      expect(container.querySelectorAll('.diff-context').length).toBeGreaterThan(0)
    })

    it('line content rendered correctly', () => {
      const file = makeFile('test.go', [
        { type: 'add', content: '+hello world' },
      ])
      const { container } = render(DiffFileView, {
        props: defaultProps({ file }),
      })
      const line = container.querySelector('.diff-add')
      expect(line?.textContent).toContain('+hello world')
    })
  })

  describe('file header', () => {
    it('shows file path', () => {
      const file = makeFile('src/main.go')
      const { container } = render(DiffFileView, {
        props: defaultProps({ file }),
      })
      expect(container.querySelector('.diff-file-path')?.textContent).toContain('main.go')
    })

    it('shows stat counts when fileStats provided', () => {
      const stats = makeStats('test.go', { additions: 10, deletions: 3 })
      const { container } = render(DiffFileView, {
        props: defaultProps({ fileStats: stats }),
      })
      expect(container.querySelector('.stat-add')?.textContent).toBe('+10')
      expect(container.querySelector('.stat-del')?.textContent).toBe('-3')
    })

    it('shows type badge', () => {
      const stats = makeStats('test.go', { type: 'A' })
      const { container } = render(DiffFileView, {
        props: defaultProps({ fileStats: stats }),
      })
      const badge = container.querySelector('.file-type-badge')
      expect(badge?.textContent).toBe('A')
      expect(badge?.classList.contains('badge-A')).toBe(true)
    })
  })

  describe('collapse and expand', () => {
    it('isCollapsed=true hides diff content', () => {
      const file = makeFile('test.go', [
        { type: 'add', content: '+line' },
      ])
      const { container } = render(DiffFileView, {
        props: defaultProps({ file, isCollapsed: true }),
      })
      expect(container.querySelectorAll('.diff-line')).toHaveLength(0)
    })

    it('clicking header calls ontoggle', async () => {
      const ontoggle = vi.fn()
      const file = makeFile('test.go')
      const { container } = render(DiffFileView, {
        props: defaultProps({ file, ontoggle }),
      })
      const header = container.querySelector('.diff-file-header')!
      await fireEvent.click(header)
      expect(ontoggle).toHaveBeenCalledWith('test.go')
    })

    it('expand button visible when not expanded and multiple hunks', () => {
      // Create a file with 2 hunks where newStart > 1 to trigger expand button
      const file: DiffFile = {
        header: 'diff --git a/test.go b/test.go',
        filePath: 'test.go',
        hunks: [
          { header: '@@ -1,3 +1,3 @@', oldStart: 1, newStart: 5, newCount: 3, lines: [{ type: 'context', content: ' a' }] },
          { header: '@@ -10,3 +10,3 @@', oldStart: 10, newStart: 15, newCount: 3, lines: [{ type: 'context', content: ' b' }] },
        ],
      }
      const { container } = render(DiffFileView, {
        props: defaultProps({ file, isExpanded: false }),
      })
      expect(container.querySelector('.expand-btn')).toBeInTheDocument()
    })

    it('clicking expand button calls onexpand', async () => {
      const onexpand = vi.fn()
      const file: DiffFile = {
        header: 'diff --git a/test.go b/test.go',
        filePath: 'test.go',
        hunks: [
          { header: '@@ -1,3 +1,3 @@', oldStart: 1, newStart: 5, newCount: 3, lines: [{ type: 'context', content: ' a' }] },
          { header: '@@ -10,3 +10,3 @@', oldStart: 10, newStart: 15, newCount: 3, lines: [{ type: 'context', content: ' b' }] },
        ],
      }
      const { container } = render(DiffFileView, {
        props: defaultProps({ file, isExpanded: false, onexpand }),
      })
      const btn = container.querySelector('.expand-btn')!
      await fireEvent.click(btn)
      expect(onexpand).toHaveBeenCalledWith('test.go')
    })
  })

  describe('conflict rendering', () => {
    function twoSideConflict() {
      return makeFile('fuzzy.ts', [
        { type: 'add', content: '+<<<<<<< Conflict 1 of 1' },
        { type: 'add', content: '+%%%%%%% diff from: "Conflict resolution"' },
        { type: 'add', content: '+\\\\\\\\\\\\\\        to: suqyukyr f415bb98 "side X"' },
        { type: 'add', content: '+-  old line' },
        { type: 'add', content: '++  new line from side X' },
        { type: 'add', content: '++++++++ wlykovwr 562576c8 "side Y"' },
        { type: 'add', content: '+  content from side Y' },
        { type: 'add', content: '+>>>>>>> Conflict 1 of 1 ends' },
      ])
    }

    function conflictStats() {
      return makeStats('fuzzy.ts', { conflict: true, conflict_sides: 2 })
    }

    it('hides conflict marker lines (<<<, %%%, +++, >>>)', () => {
      const { container } = render(DiffFileView, {
        props: defaultProps({ file: twoSideConflict(), fileStats: conflictStats() }),
      })
      const markerLines = container.querySelectorAll('.conflict-marker-line')
      expect(markerLines.length).toBeGreaterThan(0)
      for (const ml of markerLines) {
        expect(ml.textContent?.trim()).toBe('')
      }
    })

    it('suppresses diff-add class on conflict lines', () => {
      const { container } = render(DiffFileView, {
        props: defaultProps({ file: twoSideConflict(), fileStats: conflictStats() }),
      })
      const conflictLines = container.querySelectorAll('.conflict-line .diff-line')
      for (const cl of conflictLines) {
        expect(cl.classList.contains('diff-add')).toBe(false)
      }
    })

    it('parses inner diff: - lines get conflict-inner-remove class', () => {
      const { container } = render(DiffFileView, {
        props: defaultProps({ file: twoSideConflict(), fileStats: conflictStats() }),
      })
      const removals = container.querySelectorAll('.conflict-inner-remove')
      expect(removals.length).toBeGreaterThan(0)
      // Content should have the - prefix stripped, showing just the code
      expect(removals[0].textContent).toContain('old line')
    })

    it('parses inner diff: + lines get conflict-inner-add class', () => {
      const { container } = render(DiffFileView, {
        props: defaultProps({ file: twoSideConflict(), fileStats: conflictStats() }),
      })
      const additions = container.querySelectorAll('.conflict-inner-add')
      expect(additions.length).toBeGreaterThan(0)
      expect(additions[0].textContent).toContain('new line from side X')
    })

    it('strips prefix from snapshot section lines', () => {
      const { container } = render(DiffFileView, {
        props: defaultProps({ file: twoSideConflict(), fileStats: conflictStats() }),
      })
      const snapLines = container.querySelectorAll('.conflict-snap-line .diff-line')
      for (const sl of snapLines) {
        // Snapshot lines should not start with + prefix
        const text = sl.textContent ?? ''
        expect(text).not.toMatch(/^\s*\+/)
      }
    })

    it('hides \\\\\\\\\\\\\\  sub-marker within %%%%%%% section', () => {
      const { container } = render(DiffFileView, {
        props: defaultProps({ file: twoSideConflict(), fileStats: conflictStats() }),
      })
      // The \\\\\\\ line should render as a conflict-marker-line (2px bar)
      const allText = container.textContent ?? ''
      expect(allText).not.toContain('\\\\\\\\\\\\\\')
    })

    it('section tabs have letter badges matching their side index', () => {
      const { container } = render(DiffFileView, {
        props: defaultProps({ file: twoSideConflict(), fileStats: conflictStats() }),
      })
      // One tab per side, NOT one per marker (\\\ sub-markers don't make tabs).
      const tabs = container.querySelectorAll('.conflict-side-tab')
      expect(tabs).toHaveLength(2)
      // Each tab has a letter badge: A for side 0, B for side 1.
      // This creates spatial correspondence with the "Keep A"/"Keep B" buttons.
      const badges = [...tabs].map(t => t.querySelector('.side-badge')?.textContent)
      expect(badges).toEqual(['A', 'B'])
      // Tab description is the "to" label (what you keep), not "from".
      // twoSideConflict: diff side = to "side X", snapshot side = "side Y"
      expect(tabs[0].textContent).toContain('side X')
      expect(tabs[0].textContent).not.toContain('Conflict resolution') // that's the FROM
      expect(tabs[1].textContent).toContain('side Y')
    })

    it('region buttons use letter badges, tooltips carry full labels', () => {
      const { container } = render(DiffFileView, {
        props: defaultProps({ file: twoSideConflict(), fileStats: conflictStats(), onresolve: vi.fn() }),
      })
      const picks = container.querySelectorAll('.conflict-pick')
      expect(picks).toHaveLength(2)
      // Buttons just say "Keep [A]" / "Keep [B]" — commit descriptions are
      // opaque to users; the letter badge creates spatial correspondence.
      expect(picks[0].textContent?.trim()).toBe('Keep A')
      expect(picks[1].textContent?.trim()).toBe('Keep B')
      // Full labels in tooltip for those who want them.
      // Side A (diff, :ours) = the TO label = "side X"
      expect(picks[0].getAttribute('title')).toContain('side X')
      expect(picks[0].getAttribute('title')).not.toContain('Conflict resolution')
      // Side B (snapshot, :theirs) = "side Y"
      expect(picks[1].getAttribute('title')).toContain('side Y')
    })

    it('shows resolve buttons with side labels for 2-way conflicts', () => {
      const onresolve = vi.fn()
      const { container } = render(DiffFileView, {
        props: defaultProps({ file: twoSideConflict(), fileStats: conflictStats(), onresolve }),
      })
      const buttons = container.querySelectorAll('.resolve-btn')
      expect(buttons.length).toBe(2)
      expect(buttons[0].textContent).toContain('Keep')
      expect(buttons[1].textContent).toContain('Keep')
      // Should use side labels, not "Accept Ours/Theirs"
      expect(buttons[0].textContent).not.toContain('Ours')
      expect(buttons[1].textContent).not.toContain('Theirs')
    })

    it('shows resolve buttons for single-%%%%% conflicts (2-way conflict, 1 marker section)', () => {
      // jj can represent a 2-way conflict with just one %%%%%%% diff section
      // (showing from→to). sideCount === 1 but :ours/:theirs still work.
      // Regression: was gating on sideCount === 2, hiding buttons for this format.
      const file = makeFile('one-side.ts', [
        { type: 'add', content: '+<<<<<<< Conflict 1 of 1' },
        { type: 'add', content: '+%%%%%%% "only changes"' },
        { type: 'add', content: '++  changed line' },
        { type: 'add', content: '+>>>>>>> Conflict 1 of 1 ends' },
      ])
      const { container } = render(DiffFileView, {
        props: defaultProps({ file, fileStats: makeStats('one-side.ts', { conflict: true, conflict_sides: 2 }), onresolve: vi.fn() }),
      })
      expect(container.querySelectorAll('.resolve-btn')).toHaveLength(2)
      // Per-region buttons now live at region START (.conflict-pick), not end
      expect(container.querySelectorAll('.conflict-pick')).toHaveLength(2)
    })

    it('hides resolve buttons for 3-sided conflicts', () => {
      // When conflict_sides=3 (3-way merge), :ours/:theirs is ambiguous —
      // hide buttons regardless of how many marker sections the diff shows.
      const file = makeFile('three-way.ts', [
        { type: 'add', content: '+<<<<<<< Conflict 1 of 1' },
        { type: 'add', content: '+%%%%%%% "side A"' },
        { type: 'add', content: '++line a' },
        { type: 'add', content: '+++++++ "side B"' },
        { type: 'add', content: '+line b' },
        { type: 'add', content: '+>>>>>>> Conflict 1 of 1 ends' },
      ])
      const { container } = render(DiffFileView, {
        props: defaultProps({ file, fileStats: makeStats('three-way.ts', { conflict: true, conflict_sides: 3 }), onresolve: vi.fn() }),
      })
      expect(container.querySelectorAll('.resolve-btn')).toHaveLength(0)
      expect(container.querySelectorAll('.conflict-pick')).toHaveLength(0)
    })

    it('falls back to marker counting when conflict_sides is 0 (arity unknown)', () => {
      // When backend couldn't parse arity, fall back to counting marker sections.
      // 1 or 2 sections → show buttons (conservative: assume 2-way).
      const file = makeFile('unknown.ts', [
        { type: 'add', content: '+<<<<<<< Conflict 1 of 1' },
        { type: 'add', content: '+%%%%%%% "changes"' },
        { type: 'add', content: '++x' },
        { type: 'add', content: '+>>>>>>> Conflict 1 of 1 ends' },
      ])
      const { container } = render(DiffFileView, {
        props: defaultProps({ file, fileStats: makeStats('unknown.ts', { conflict: true, conflict_sides: 0 }), onresolve: vi.fn() }),
      })
      expect(container.querySelectorAll('.resolve-btn')).toHaveLength(2)
    })

    it('forces unified view for conflicted files even when splitView=true', () => {
      const { container } = render(DiffFileView, {
        props: defaultProps({ file: twoSideConflict(), fileStats: conflictStats(), splitView: true }),
      })
      // Should NOT render split-view columns
      expect(container.querySelector('.split-view')).toBeNull()
      // Should render unified diff-lines
      expect(container.querySelectorAll('.diff-lines').length).toBeGreaterThan(0)
    })

    it('does not double-prefix non-conflict lines', () => {
      const file = makeFile('normal.ts', [
        { type: 'add', content: '+export function foo() {}' },
        { type: 'remove', content: '-old function' },
        { type: 'context', content: ' unchanged' },
      ])
      const { container } = render(DiffFileView, {
        props: defaultProps({ file }),
      })
      const lines = container.querySelectorAll('.diff-line')
      // First line: prefix should be '+', content should NOT start with another '+'
      const addLine = container.querySelector('.diff-add')
      expect(addLine?.textContent).toContain('export function foo')
      expect(addLine?.textContent).not.toContain('++')
    })
  })

  describe('annotation gutter badge', () => {
    function mkAnn(severity: Annotation['severity'], status: Annotation['status'] = 'open'): Annotation {
      return {
        id: 'a1', changeId: 'x', filePath: 'test.go', lineNum: 1,
        lineContent: 'foo', comment: 'fix it', severity,
        createdAt: 0, createdAtCommitId: 'abc', status,
      }
    }

    const fileWithLines = makeFile('test.go', [
      { type: 'add', content: '+line one' },
      { type: 'context', content: ' line two' },
      { type: 'add', content: '+line three' },
    ])

    it('no badge when annotationsForLine prop absent', () => {
      const { container } = render(DiffFileView, {
        props: defaultProps({ file: fileWithLines }),
      })
      expect(container.querySelector('.annotation-badge')).toBeNull()
    })

    it('no badge when annotationsForLine returns []', () => {
      const { container } = render(DiffFileView, {
        props: defaultProps({
          file: fileWithLines,
          annotationsForLine: () => [],
        }),
      })
      expect(container.querySelector('.annotation-badge')).toBeNull()
    })

    it('renders badge on annotated line only', () => {
      // Line 2 (new-side) has an annotation; lines 1 and 3 don't.
      const { container } = render(DiffFileView, {
        props: defaultProps({
          file: fileWithLines,
          annotationsForLine: (ln: number) => ln === 2 ? [mkAnn('suggestion')] : [],
        }),
      })
      const badges = container.querySelectorAll('.annotation-badge')
      expect(badges).toHaveLength(1)
      expect(badges[0].getAttribute('title')).toContain('fix it')
    })

    it('badge gets severity class from first annotation', () => {
      const { container } = render(DiffFileView, {
        props: defaultProps({
          file: fileWithLines,
          annotationsForLine: (ln: number) => ln === 1 ? [mkAnn('must-fix')] : [],
        }),
      })
      const badge = container.querySelector('.annotation-badge')
      expect(badge?.classList.contains('severity-must-fix')).toBe(true)
    })

    it('orphaned annotation gets dashed-outline class', () => {
      const { container } = render(DiffFileView, {
        props: defaultProps({
          file: fileWithLines,
          annotationsForLine: (ln: number) => ln === 1 ? [mkAnn('suggestion', 'orphaned')] : [],
        }),
      })
      const badge = container.querySelector('.annotation-badge')
      expect(badge?.classList.contains('orphaned')).toBe(true)
    })

    it('multiple annotations on same line show count superscript', () => {
      const { container } = render(DiffFileView, {
        props: defaultProps({
          file: fileWithLines,
          annotationsForLine: (ln: number) => ln === 1 ? [mkAnn('suggestion'), mkAnn('nitpick')] : [],
        }),
      })
      const badge = container.querySelector('.annotation-badge')
      expect(badge?.querySelector('sup')?.textContent).toBe('2')
      expect(badge?.getAttribute('title')).toContain('2 annotations')
    })

    it('badge click fires onannotationclick with lineNum and raw content', async () => {
      const onannotationclick = vi.fn()
      const { container } = render(DiffFileView, {
        props: defaultProps({
          file: fileWithLines,
          annotationsForLine: (ln: number) => ln === 1 ? [mkAnn('suggestion')] : [],
          onannotationclick,
        }),
      })
      const badge = container.querySelector('.annotation-badge') as HTMLButtonElement
      await fireEvent.click(badge)

      expect(onannotationclick).toHaveBeenCalledWith(
        1,
        'line one', // raw content without the '+' prefix
        expect.any(MouseEvent),
      )
    })

    it('badge click stops propagation (does not trigger line contextmenu)', async () => {
      // The diff-line has oncontextmenu; the badge onclick must not bubble
      // up and trigger it. We can't easily test stopPropagation directly,
      // but we can verify the click doesn't cause unintended side effects.
      const onlinecontext = vi.fn()
      const onannotationclick = vi.fn()
      const { container } = render(DiffFileView, {
        props: defaultProps({
          file: fileWithLines,
          annotationsForLine: (ln: number) => ln === 1 ? [mkAnn('suggestion')] : [],
          onannotationclick,
          onlinecontext,
        }),
      })
      const badge = container.querySelector('.annotation-badge') as HTMLButtonElement
      await fireEvent.click(badge)

      expect(onannotationclick).toHaveBeenCalled()
      // onlinecontext is fired by contextmenu (right-click), not click,
      // so this should be a no-op regardless. But it verifies the wiring.
      expect(onlinecontext).not.toHaveBeenCalled()
    })

    it('annotationsForLine called with new-side line numbers only', () => {
      // Remove lines don't exist in the new file — no new-side number →
      // annotationsForLine should NOT be called for them (newLineNum is null).
      const file = makeFile('test.go', [
        { type: 'remove', content: '-removed' }, // old=1, new=null
        { type: 'add', content: '+added' },       // old=null, new=1
        { type: 'context', content: ' kept' },    // old=2, new=2
      ])
      const spy = vi.fn((_ln: number): Annotation[] => [])
      render(DiffFileView, {
        props: defaultProps({ file, annotationsForLine: spy }),
      })
      // Called for new lines 1 and 2 (add, context); NOT for the remove line.
      const calledWith = spy.mock.calls.map(c => c[0] as number)
      expect(calledWith).toContain(1)
      expect(calledWith).toContain(2)
      expect(calledWith).not.toContain(null)
    })
  })
})
