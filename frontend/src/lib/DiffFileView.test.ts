import { describe, it, expect, vi } from 'vitest'
import { render, fireEvent } from '@testing-library/svelte'
import DiffFileView from './DiffFileView.svelte'
import type { DiffFile } from './diff-parser'
import type { FileChange } from './api'
import type { WordSpan } from './word-diff'

function makeFile(filePath: string, lines: { type: 'add' | 'remove' | 'context'; content: string }[] = []): DiffFile {
  return {
    header: `diff --git a/${filePath} b/${filePath}`,
    filePath,
    hunks: lines.length > 0
      ? [{ header: '@@ -1 +1 @@', newStart: 1, newCount: 1, lines }]
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
    wordDiffMap: new Map<string, Map<number, WordSpan[]>>(),
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
      expect(indicator?.textContent).toBe('1 conflict')
    })

    it('pluralizes conflict count', () => {
      const file: DiffFile = {
        header: 'diff',
        filePath: 'multi.go',
        hunks: [{
          header: '@@ -1 +1 @@', newStart: 1, newCount: 1,
          lines: [
            { type: 'add', content: '+<<<<<<< Conflict 1 of 2' },
            { type: 'add', content: '+%%%%%%% Changes' },
            { type: 'add', content: '+a' },
            { type: 'add', content: '+>>>>>>> Conflict 1 of 2 ends' },
            { type: 'add', content: '+<<<<<<< Conflict 2 of 2' },
            { type: 'add', content: '+%%%%%%% Changes' },
            { type: 'add', content: '+b' },
            { type: 'add', content: '+>>>>>>> Conflict 2 of 2 ends' },
          ],
        }],
      }
      const stats = makeStats('multi.go', { conflict: true })
      const { container } = render(DiffFileView, {
        props: defaultProps({ file, fileStats: stats }),
      })
      expect(container.querySelector('.conflict-indicator')?.textContent).toBe('2 conflicts')
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
  })

  describe('resolve buttons', () => {
    function conflictProps(onresolve?: (file: string, tool: ':ours' | ':theirs') => void) {
      const file = makeFile('conflict.go', [
        { type: 'add', content: '+<<<<<<< Conflict 1 of 1' },
        { type: 'add', content: '+%%%%%%% Changes' },
        { type: 'add', content: '+content' },
        { type: 'add', content: '+>>>>>>> Conflict 1 of 1 ends' },
      ])
      const stats = makeStats('conflict.go', { conflict: true })
      return defaultProps({ file, fileStats: stats, onresolve })
    }

    it('shows Accept Ours and Accept Theirs buttons when onresolve is provided', () => {
      const { container } = render(DiffFileView, {
        props: conflictProps(vi.fn()),
      })
      const buttons = container.querySelectorAll('.resolve-btn')
      expect(buttons).toHaveLength(2)
      expect(buttons[0].textContent).toBe('Accept Ours')
      expect(buttons[1].textContent).toBe('Accept Theirs')
    })

    it('does not show resolve buttons when onresolve is not provided', () => {
      const { container } = render(DiffFileView, {
        props: conflictProps(undefined),
      })
      expect(container.querySelectorAll('.resolve-btn')).toHaveLength(0)
    })

    it('clicking Accept Ours calls onresolve with :ours', async () => {
      const onresolve = vi.fn()
      const { container } = render(DiffFileView, {
        props: conflictProps(onresolve),
      })
      await fireEvent.click(container.querySelector('.resolve-ours')!)
      expect(onresolve).toHaveBeenCalledWith('conflict.go', ':ours')
    })

    it('clicking Accept Theirs calls onresolve with :theirs', async () => {
      const onresolve = vi.fn()
      const { container } = render(DiffFileView, {
        props: conflictProps(onresolve),
      })
      await fireEvent.click(container.querySelector('.resolve-theirs')!)
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

      // Content lines within sides
      expect(container.querySelectorAll('.conflict-diff-line').length).toBeGreaterThan(0)
      expect(container.querySelectorAll('.conflict-snap-line').length).toBeGreaterThan(0)
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
})
