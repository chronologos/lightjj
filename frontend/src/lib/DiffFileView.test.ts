import { describe, it, expect, vi } from 'vitest'
import { render, fireEvent } from '@testing-library/svelte'
import DiffFileView from './DiffFileView.svelte'
import { parseDiffContent, type DiffFile } from './diff-parser'
import { api, type FileChange } from './api'
import { fromAnnotation, type PlacedReview, type Severity } from './review'
import type { WordSpan } from './word-diff'

function makeFile(filePath: string, lines: { type: 'add' | 'remove' | 'context'; content: string }[] = []): DiffFile {
  return {
    header: `diff --git a/${filePath} b/${filePath}`,
    filePath,
    hunks: lines.length > 0
      ? [{ header: '@@ -1 +1 @@', oldStart: 1, newStart: 1, newCount: 1, lines }]
      : [],
    isBinary: false,
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

    it('shows conflict indicator when conflict=true but markers are context lines', () => {
      // fileStats.conflict is per-FILE (backend conflicted_files.map). Markers
      // unchanged from parent appear as context → findConflicts finds 0 → the
      // old gate (totalConflicts > 0) hid the indicator despite the file being
      // conflicted. Backend is the source of truth here, not the diff parser.
      const file = makeFile('other.go', [
        { type: 'add', content: '+normal add line' },
        { type: 'context', content: ' context line' },
      ])
      const stats = makeStats('other.go', { conflict: true })
      const { container } = render(DiffFileView, {
        props: defaultProps({ file, fileStats: stats }),
      })
      const indicator = container.querySelector('.conflict-indicator')
      expect(indicator).toBeInTheDocument()
      expect(indicator?.textContent).toContain('conflicted')
    })
  })

  describe('merge button', () => {
    it('shows Merge button for conflicted files when onmerge provided', () => {
      const onmerge = vi.fn()
      const file = makeFile('conflict.go', [
        { type: 'add', content: '+<<<<<<< Conflict 1 of 1' },
        { type: 'add', content: '+%%%%%%% "side A changes"' },
        { type: 'add', content: '+-old line' },
        { type: 'add', content: '++++++++ "side B content"' },
        { type: 'add', content: '+new content' },
        { type: 'add', content: '+>>>>>>> Conflict 1 of 1 ends' },
      ])
      const stats = makeStats('conflict.go', { conflict: true, conflict_sides: 2 })
      const { container } = render(DiffFileView, {
        props: defaultProps({ file, fileStats: stats, onmerge }),
      })
      const btn = container.querySelector('.resolve-btn')
      expect(btn?.textContent).toContain('Merge')
    })

    it('does not show Merge button when onmerge is undefined', () => {
      const file = makeFile('conflict.go', [
        { type: 'add', content: '+<<<<<<< Conflict 1 of 1' },
        { type: 'add', content: '+%%%%%%% x' },
        { type: 'add', content: '+>>>>>>> end' },
      ])
      const { container } = render(DiffFileView, {
        props: defaultProps({ file, fileStats: makeStats('conflict.go', { conflict: true }) }),
      })
      expect(container.querySelectorAll('.resolve-btn')).toHaveLength(0)
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

    it('rename (issue #44): shows `old → new` with the old path in a tooltip; new path stays the identity', () => {
      // Real jj 0.45 rename-with-edits shape: rename lines AND a hunk.
      const [file] = parseDiffContent([
        'diff --git a/src/old name.go b/pkg/deep/new.go',
        'rename from src/old name.go',
        'rename to pkg/deep/new.go',
        'index 1111111..2222222 100644',
        '--- a/src/old name.go',
        '+++ b/pkg/deep/new.go',
        '@@ -1 +1 @@',
        '-a',
        '+b',
        '',
      ].join('\n'))
      const ondiscard = vi.fn()
      const { container } = render(DiffFileView, {
        props: defaultProps({ file, fileStats: makeStats('pkg/deep/new.go', { type: 'R' }), ondiscard }),
      })
      const from = container.querySelector('.diff-file-path .rename-from')!
      expect(from.textContent).toBe('src/old name.go')
      expect(from.getAttribute('title')).toBe('Renamed from src/old name.go')
      expect(container.querySelector('.rename-arrow')?.textContent).toBe('→')
      expect(container.querySelector('.path-to')?.textContent?.trim()).toBe('pkg/deep/new.go')
      // Reading order: old path, arrow, new path.
      expect(container.querySelector('.diff-file-path')?.textContent?.replace(/\s+/g, ''))
        .toBe('src/oldname.go→pkg/deep/new.go')
      // Identity unchanged: data attribute + aria label use the destination.
      expect(container.querySelector('.diff-file')?.getAttribute('data-file-path')).toBe('pkg/deep/new.go')
      expect(container.querySelector('.diff-file-header')?.getAttribute('aria-label')).toBe('Collapse pkg/deep/new.go')
      // Undo-rename still receives both paths.
      const discard = Array.from(container.querySelectorAll('.diff-file-header .btn')).find(b => b.textContent === 'Discard')!
      ;(discard as HTMLButtonElement).click()
      expect(ondiscard).toHaveBeenCalledWith('pkg/deep/new.go', 'src/old name.go')
    })

    it('non-rename: no rename-from / arrow in the header', () => {
      const { container } = render(DiffFileView, { props: defaultProps({ file: makeFile('src/main.go') }) })
      expect(container.querySelector('.rename-from')).toBeNull()
      expect(container.querySelector('.rename-arrow')).toBeNull()
      expect(container.querySelector('.path-to')?.textContent?.trim()).toBe('src/main.go')
    })
  })

  describe('split view rows (issue #41)', () => {
    // Two hunks: replace-block with unequal sides (2 removes vs 1 add → one
    // pair with an empty right side), context, then a pure add.
    const twoHunks = (): DiffFile => ({
      header: 'diff --git a/s.ts b/s.ts',
      filePath: 's.ts',
      isBinary: false,
      hunks: [
        { header: '@@ -1,3 +1,2 @@', oldStart: 1, newStart: 1, newCount: 2, lines: [
          { type: 'remove', content: '-old one' },
          { type: 'remove', content: '-old two' },
          { type: 'add', content: '+new one' },
          { type: 'context', content: ' same' },
        ] },
        { header: '@@ -10 +9,2 @@', oldStart: 10, newStart: 9, newCount: 2, lines: [
          { type: 'context', content: ' ctx' },
          { type: 'add', content: '+added' },
        ] },
      ],
    })

    it('renders ONE grid whose children are spanning hunk headers or old/new cell PAIRS', () => {
      const { container } = render(DiffFileView, { props: defaultProps({ file: twoHunks(), splitView: true }) })
      const grids = container.querySelectorAll('.split-grid')
      expect(grids).toHaveLength(1)
      // No per-side column stacks (the structure that drifted on soft-wrap).
      expect(container.querySelector('.split-col')).toBeNull()
      const kids = Array.from(grids[0].children)
      const shape = kids.map(k =>
        k.classList.contains('split-span') ? 'H' : k.classList.contains('split-left') ? 'L' : k.classList.contains('split-right') ? 'R' : '?')
      // H, 3 pairs (old two↔∅ included), H, 2 pairs.
      expect(shape.join('')).toBe('HLRLRLRHLRLR')
      // Pair invariant: every L is immediately followed by its R — so each
      // pair occupies exactly one grid row (columns 1 and 2).
      for (let i = 0; i < kids.length; i++) {
        if (shape[i] === 'L') expect(shape[i + 1]).toBe('R')
      }
      // Headers carry data-hunk (scrollToHunk / hunk nav target) once each.
      expect(Array.from(grids[0].querySelectorAll('[data-hunk]')).map(h => h.getAttribute('data-hunk'))).toEqual(['0', '1'])
      // Line numbers stay per side: old 1,2,3 / new 1,_,2 for hunk 0.
      const cellText = (sel: string) => Array.from(grids[0].querySelectorAll(sel)).map(c => c.querySelector('.line-num')?.textContent ?? '∅')
      expect(cellText('.split-left')).toEqual(['1', '2', '3', '10', '∅'])
      expect(cellText('.split-right')).toEqual(['1', '∅', '2', '9', '10'])
      expect(grids[0].querySelectorAll('.split-right.diff-empty')).toHaveLength(1)
      expect(grids[0].querySelectorAll('.split-left.diff-empty')).toHaveLength(1)
    })

    it('expanded (full context) view omits hunk headers but keeps the pairs', () => {
      const { container } = render(DiffFileView, { props: defaultProps({ file: twoHunks(), splitView: true, isExpanded: true }) })
      const shape = Array.from(container.querySelector('.split-grid')!.children)
        .map(k => k.classList.contains('split-left') ? 'L' : k.classList.contains('split-right') ? 'R' : '?')
      expect(shape.join('')).toBe('LRLRLRLRLR')
    })

    it('mousedown latches the selection side (other side becomes unselectable via CSS)', async () => {
      const { container } = render(DiffFileView, { props: defaultProps({ file: twoHunks(), splitView: true }) })
      const grid = container.querySelector('.split-grid')!
      expect(grid.getAttribute('data-select-side')).toBeNull()
      await fireEvent.mouseDown(grid.querySelector('.split-right .line-num')!)
      expect(grid.getAttribute('data-select-side')).toBe('right')
      await fireEvent.mouseDown(grid.querySelector('.split-left')!)
      expect(grid.getAttribute('data-select-side')).toBe('left')
    })

    it('Copy-reference selection keeps only the side the selection started on', async () => {
      const onlinecontext = vi.fn()
      const { container } = render(DiffFileView, { props: defaultProps({ file: twoHunks(), splitView: true, onlinecontext }) })
      const lefts = container.querySelectorAll('.split-grid > .split-left')
      // Drag from old line 1 to old line 3: in pair-order DOM the range also
      // spans the right cells of rows 1–2, which must NOT be reported.
      const range = document.createRange()
      range.setStart(lefts[0].lastChild!, 0)
      range.setEnd(lefts[2].lastChild!, 1)
      const sel = window.getSelection()!
      sel.removeAllRanges()
      sel.addRange(range)
      await fireEvent.contextMenu(lefts[1])
      sel.removeAllRanges()
      expect(onlinecontext).toHaveBeenCalledTimes(1)
      const info = onlinecontext.mock.calls[0][1]
      expect(info.lines).toEqual([
        { lineNum: 1, content: 'old one', side: 'old' },
        { lineNum: 2, content: 'old two', side: 'old' },
        { lineNum: 3, content: 'same', side: 'old' },
      ])
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
        isBinary: false,
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
        isBinary: false,
      }
      const { container } = render(DiffFileView, {
        props: defaultProps({ file, isExpanded: false, onexpand }),
      })
      const btn = container.querySelector('.expand-btn')!
      await fireEvent.click(btn)
      // First button = gap before hunk 0. Second arg is the gap index.
      expect(onexpand).toHaveBeenCalledWith('test.go', 0)
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

  describe('review gutter bubble', () => {
    function mkAnn(severity: Severity, orphaned = false): PlacedReview {
      return {
        ...fromAnnotation({
          id: 'a1', changeId: 'x', filePath: 'test.go', lineNum: 1,
          lineContent: 'foo', comment: 'fix it', severity,
          createdAt: 0, createdAtCommitId: 'abc', status: orphaned ? 'orphaned' : 'open',
        }),
        orphaned, line: 1,
      }
    }

    const fileWithLines = makeFile('test.go', [
      { type: 'add', content: '+line one' },
      { type: 'context', content: ' line two' },
      { type: 'add', content: '+line three' },
    ])

    it('no bubble when annotationsForLine prop absent', () => {
      const { container } = render(DiffFileView, {
        props: defaultProps({ file: fileWithLines }),
      })
      expect(container.querySelector('.review-bubble')).toBeNull()
    })

    it('no bubble when annotationsForLine returns []', () => {
      const { container } = render(DiffFileView, {
        props: defaultProps({
          file: fileWithLines,
          annotationsForLine: () => [],
        }),
      })
      expect(container.querySelector('.review-bubble')).toBeNull()
    })

    it('renders bubble on annotated line only', () => {
      // Line 2 (new-side) has an annotation; lines 1 and 3 don't.
      const { container } = render(DiffFileView, {
        props: defaultProps({
          file: fileWithLines,
          annotationsForLine: (_fp: string, ln: number) => ln === 2 ? [mkAnn('suggestion')] : [],
        }),
      })
      const bubbles = container.querySelectorAll('.review-bubble')
      expect(bubbles).toHaveLength(1)
      expect(bubbles[0].getAttribute('title')).toContain('fix it')
    })

    it('bubble gets worst-open severity class', () => {
      const { container } = render(DiffFileView, {
        props: defaultProps({
          file: fileWithLines,
          annotationsForLine: (_fp: string, ln: number) =>
            ln === 1 ? [mkAnn('nitpick'), mkAnn('must-fix')] : [],
        }),
      })
      const bubble = container.querySelector('.review-bubble')
      expect(bubble?.classList.contains('severity-must-fix')).toBe(true)
    })

    it('orphaned review gets dashed-outline class', () => {
      const { container } = render(DiffFileView, {
        props: defaultProps({
          file: fileWithLines,
          annotationsForLine: (_fp: string, ln: number) => ln === 1 ? [mkAnn('suggestion', true)] : [],
        }),
      })
      const bubble = container.querySelector('.review-bubble')
      expect(bubble?.classList.contains('orphaned')).toBe(true)
    })

    it('multiple reviews on same line show count digit', () => {
      const { container } = render(DiffFileView, {
        props: defaultProps({
          file: fileWithLines,
          annotationsForLine: (_fp: string, ln: number) => ln === 1 ? [mkAnn('suggestion'), mkAnn('nitpick')] : [],
        }),
      })
      const bubble = container.querySelector('.review-bubble')
      expect(bubble?.textContent).toBe('2')
      expect(bubble?.getAttribute('title')).toContain('2 comments')
    })

    it('bubble click fires onannotationclick with id (no vis)', async () => {
      const onannotationclick = vi.fn()
      const { container } = render(DiffFileView, {
        props: defaultProps({
          file: fileWithLines,
          annotationsForLine: (_fp: string, ln: number) => ln === 1 ? [mkAnn('suggestion')] : [],
          onannotationclick,
        }),
      })
      const bubble = container.querySelector('.review-bubble') as HTMLButtonElement
      await fireEvent.click(bubble)

      expect(onannotationclick).toHaveBeenCalledWith(
        1,
        'line one', // raw content without the '+' prefix
        expect.any(MouseEvent),
        'a1', // editingId
        'new',
      )
    })

    it("Alt+click on remove line creates with side='old'", async () => {
      // Unified [old,new]: remove → annNew=null, annOld=oldStart. handleAltClick
      // should fall back to (annOld, 'old') instead of bailing.
      const onannotationclick = vi.fn()
      const file = makeFile('test.go', [{ type: 'remove', content: '-gone' }])
      const { container } = render(DiffFileView, {
        props: defaultProps({ file, onannotationclick }),
      })
      const line = container.querySelector('.diff-line.diff-remove')!
      await fireEvent.click(line, { altKey: true })
      expect(onannotationclick).toHaveBeenCalledWith(
        1, 'gone', expect.any(MouseEvent), undefined, 'old',
      )
    })

    it('annotationCount prop renders header count chip', () => {
      const { container } = render(DiffFileView, {
        props: defaultProps({ file: fileWithLines, annotationCount: 3 }),
      })
      const chip = container.querySelector('.ann-count-chip')
      expect(chip).not.toBeNull()
      expect(chip?.getAttribute('title')).toContain('3 line annotations')
    })

    it('bubble click stops propagation', async () => {
      const onlinecontext = vi.fn()
      const onannotationclick = vi.fn()
      const { container } = render(DiffFileView, {
        props: defaultProps({
          file: fileWithLines,
          annotationsForLine: (_fp: string, ln: number) => ln === 1 ? [mkAnn('suggestion')] : [],
          onannotationclick,
          onlinecontext,
        }),
      })
      const bubble = container.querySelector('.review-bubble') as HTMLButtonElement
      await fireEvent.click(bubble)

      expect(onannotationclick).toHaveBeenCalled()
      expect(onlinecontext).not.toHaveBeenCalled()
    })

    it('annotationsForLine never called with null line number', () => {
      // Remove lines have annOld set, annNew=null; add lines vice versa.
      // reviewsAt() guards on truthiness so null never reaches the callback.
      const file = makeFile('test.go', [
        { type: 'remove', content: '-removed' }, // old=1, new=null
        { type: 'add', content: '+added' },       // old=null, new=1
        { type: 'context', content: ' kept' },    // old=2, new=2
      ])
      const spy = vi.fn((_fp: string, _ln: number): PlacedReview[] => [])
      render(DiffFileView, {
        props: defaultProps({ file, annotationsForLine: spy }),
      })
      const calledWith = spy.mock.calls.map(c => c[1])
      expect(calledWith).toContain(1)
      expect(calledWith).toContain(2)
      expect(calledWith).not.toContain(null)
    })
  })

  describe('binary image diff', () => {
    // jj `--tool :git` emits a git-style binary marker and no hunks; the
    // parser sets isBinary. Path has a dir + space so URL-encoding is visible.
    function binaryFile(filePath: string): DiffFile {
      return {
        header: `diff --git a/${filePath} b/${filePath}\nBinary files a/${filePath} and b/${filePath} differ`,
        filePath,
        hunks: [],
        isBinary: true,
      }
    }
    const IMG = 'assets/logo v2.png'
    // api.fileRawUrl is the single URL builder (tab-scoped prefix included).
    const rawUrl = (revision: string, path = IMG) => api.fileRawUrl(revision, path)
    const imgSrcs = (c: HTMLElement) =>
      Array.from(c.querySelectorAll('.image-diff img')).map(i => i.getAttribute('src'))

    it('Modified in split view → Before (parent revset) and After images side by side', () => {
      const { container } = render(DiffFileView, {
        props: defaultProps({
          file: binaryFile(IMG),
          fileStats: makeStats(IMG, { type: 'M', additions: 0, deletions: 0 }),
          splitView: true,
          imageRevision: 'abc123',
          imageBaseRevision: 'abc123-',
        }),
      })
      expect(container.querySelector('.binary-placeholder')).not.toBeInTheDocument()
      expect(imgSrcs(container)).toEqual([rawUrl('abc123-'), rawUrl('abc123')])
      // `-` is URL-safe (stays literal); the path's `/` and space are encoded.
      expect(imgSrcs(container)[0]).toMatch(/\/api\/file-raw\?revision=abc123-&path=assets%2Flogo\+v2\.png$/)
      const labels = Array.from(container.querySelectorAll('.img-label')).map(l => l.textContent)
      expect(labels).toEqual(['Before', 'After'])
      expect(container.querySelector('input[type="range"]')).not.toBeInTheDocument()
    })

    it('Modified in unified view → swipe slider over both images', () => {
      const { container } = render(DiffFileView, {
        props: defaultProps({
          file: binaryFile(IMG),
          fileStats: makeStats(IMG, { type: 'M' }),
          splitView: false,
          imageRevision: 'abc123',
          imageBaseRevision: 'abc123-',
        }),
      })
      expect(imgSrcs(container)).toEqual([rawUrl('abc123-'), rawUrl('abc123')])
      expect(container.querySelector('.ic-stage')).toBeInTheDocument()
      expect(container.querySelector('input[type="range"]')).toBeInTheDocument()
    })

    it('Added → only the After image, labelled Added', () => {
      const { container } = render(DiffFileView, {
        props: defaultProps({
          file: binaryFile(IMG),
          fileStats: makeStats(IMG, { type: 'A' }),
          splitView: true,
          imageRevision: 'abc123',
          imageBaseRevision: 'abc123-',
        }),
      })
      expect(imgSrcs(container)).toEqual([rawUrl('abc123')])
      expect(container.querySelector('.img-label')?.textContent).toBe('Added')
    })

    it('Deleted → only the Before image from the parent, labelled Deleted', () => {
      const { container } = render(DiffFileView, {
        props: defaultProps({
          file: binaryFile(IMG),
          fileStats: makeStats(IMG, { type: 'D' }),
          splitView: true,
          imageRevision: 'abc123',
          imageBaseRevision: 'abc123-',
        }),
      })
      expect(imgSrcs(container)).toEqual([rawUrl('abc123-')])
      expect(container.querySelector('.img-label')?.textContent).toBe('Deleted')
    })

    it('before image load error (merge parent) → drops to After-only with a note', async () => {
      const { container } = render(DiffFileView, {
        props: defaultProps({
          file: binaryFile(IMG),
          fileStats: makeStats(IMG, { type: 'M' }),
          splitView: true,
          imageRevision: 'abc123',
          imageBaseRevision: 'abc123-',
        }),
      })
      const before = container.querySelector('.img-pane-before img')!
      await fireEvent.error(before)
      expect(imgSrcs(container)).toEqual([rawUrl('abc123')])
      expect(container.querySelector('.img-label')?.textContent).toBe('After')
      expect(container.querySelector('.img-note')?.textContent).toContain('previous version unavailable')
    })

    it('multi-revision diff (no base) → After image only for Modified', () => {
      const { container } = render(DiffFileView, {
        props: defaultProps({
          file: binaryFile(IMG),
          fileStats: makeStats(IMG, { type: 'M' }),
          splitView: false,
          imageRevision: 'abc123',
        }),
      })
      expect(imgSrcs(container)).toEqual([rawUrl('abc123')])
      expect(container.querySelector('.img-label')?.textContent).toBe('After')
      expect(container.querySelector('input[type="range"]')).not.toBeInTheDocument()
    })

    it('non-image binary → placeholder text, no images', () => {
      const { container } = render(DiffFileView, {
        props: defaultProps({
          file: binaryFile('bin/tool.wasm'),
          fileStats: makeStats('bin/tool.wasm', { type: 'M' }),
          imageRevision: 'abc123',
          imageBaseRevision: 'abc123-',
        }),
      })
      expect(container.querySelector('.binary-placeholder')?.textContent).toContain('Binary file')
      expect(container.querySelector('.image-diff')).not.toBeInTheDocument()
    })

    it('no imageRevision (and no base) → placeholder', () => {
      const { container } = render(DiffFileView, {
        props: defaultProps({
          file: binaryFile(IMG),
          fileStats: makeStats(IMG, { type: 'M' }),
        }),
      })
      expect(container.querySelector('.binary-placeholder')).toBeInTheDocument()
      expect(container.querySelector('.image-diff img')).not.toBeInTheDocument()
    })

    it('collapsed binary image renders no body at all', () => {
      const { container } = render(DiffFileView, {
        props: defaultProps({
          file: binaryFile(IMG),
          fileStats: makeStats(IMG, { type: 'M' }),
          isCollapsed: true,
          imageRevision: 'abc123',
          imageBaseRevision: 'abc123-',
        }),
      })
      expect(container.querySelector('.image-diff')).not.toBeInTheDocument()
      expect(container.querySelector('.binary-placeholder')).not.toBeInTheDocument()
    })

    it('hides Preview (auto view supersedes it) and Edit (text editor) for binary files', () => {
      const { container } = render(DiffFileView, {
        props: defaultProps({
          file: binaryFile(IMG),
          fileStats: makeStats(IMG, { type: 'M' }),
          onpreview: vi.fn(),
          onedit: vi.fn(),
          onfilehistory: vi.fn(),
          imageRevision: 'abc123',
          imageBaseRevision: 'abc123-',
        }),
      })
      const btns = Array.from(container.querySelectorAll('.diff-file-header .btn')).map(b => b.textContent)
      expect(btns).not.toContain('Preview')
      expect(btns).not.toContain('Edit')
      expect(btns).toContain('History')
    })

    it('pure rename: real `jj diff --git` shape (rename from/to, NO Binary line) → image body via sourcePath, no Edit/Preview', () => {
      // What the parser actually produces for a pure-renamed PNG: isBinary
      // stays false (no "Binary files … differ" marker), hunks [], sourcePath
      // from `rename from`.
      const [file] = parseDiffContent(
        'diff --git a/img/old.png b/img/new.png\nrename from img/old.png\nrename to img/new.png\n')
      expect(file.isBinary).toBe(false)
      expect(file.sourcePath).toBe('img/old.png')
      expect(file.hunks).toEqual([])
      const { container } = render(DiffFileView, {
        props: defaultProps({
          file,
          fileStats: makeStats('img/new.png', { type: 'R', additions: 0, deletions: 0 }),
          splitView: true,
          onedit: vi.fn(),
          onpreview: vi.fn(),
          imageRevision: 'abc123',
          imageBaseRevision: 'ppp999',
        }),
      })
      expect(imgSrcs(container)).toEqual([rawUrl('ppp999', 'img/old.png'), rawUrl('abc123', 'img/new.png')])
      const btns = Array.from(container.querySelectorAll('.diff-file-header .btn')).map(b => b.textContent)
      expect(btns).not.toContain('Edit')
      expect(btns).not.toContain('Preview')
      expect(container.querySelector('.binary-placeholder')).not.toBeInTheDocument()
    })

    it('fileStats not yet loaded → no <img> requested and no placeholder flash', () => {
      // diff and file-list load independently; guessing both sides in the
      // undefined window would fire a doomed parent fetch for an Added image.
      const { container } = render(DiffFileView, {
        props: defaultProps({
          file: binaryFile(IMG),
          fileStats: undefined,
          imageRevision: 'abc123',
          imageBaseRevision: 'ppp999',
        }),
      })
      expect(container.querySelector('img')).not.toBeInTheDocument()
      expect(container.querySelector('.binary-placeholder')).not.toBeInTheDocument()
    })

    it('merge commit (no base, baseNote) → After only + up-front note; Added gets no note', () => {
      const note = 'merge commit — no single previous version'
      const { container } = render(DiffFileView, {
        props: defaultProps({
          file: binaryFile(IMG),
          fileStats: makeStats(IMG, { type: 'M' }),
          imageRevision: 'abc123',
          imageBaseNote: note,
        }),
      })
      expect(imgSrcs(container)).toEqual([rawUrl('abc123')])
      expect(container.querySelector('.img-label')?.textContent).toBe('After')
      expect(container.querySelector('.img-note')?.textContent).toBe(`(${note})`)

      const added = render(DiffFileView, {
        props: defaultProps({
          file: binaryFile(IMG),
          fileStats: makeStats(IMG, { type: 'A' }),
          imageRevision: 'abc123',
          imageBaseNote: note,
        }),
      })
      expect(added.container.querySelector('.img-label')?.textContent).toBe('Added')
      expect(added.container.querySelector('.img-note')).not.toBeInTheDocument()
    })

    it('range slider blurs on pointer release so global j/k keys are not swallowed', async () => {
      const { container } = render(DiffFileView, {
        props: defaultProps({
          file: binaryFile(IMG),
          fileStats: makeStats(IMG, { type: 'M' }),
          splitView: false,
          imageRevision: 'abc123',
          imageBaseRevision: 'ppp999',
        }),
      })
      const range = container.querySelector<HTMLInputElement>('input[type="range"]')!
      range.focus()
      expect(document.activeElement).toBe(range)
      await fireEvent.pointerUp(range)
      expect(document.activeElement).not.toBe(range)
    })
  })
})
