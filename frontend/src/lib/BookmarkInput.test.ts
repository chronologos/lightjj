import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, fireEvent, waitFor } from '@testing-library/svelte'
import BookmarkInput from './BookmarkInput.svelte'

vi.mock('./api', () => ({
  api: {
    bookmarks: vi.fn(),
  },
}))

// jsdom's localStorage is unreliable in this env (`--localstorage-file` warning
// → methods throw). Mock recentActions so the recency-tier sort and the
// submit→record call are testable with controlled data.
const mockRecord = vi.fn()
const mockSnapshot = vi.fn<() => Record<string, number>>().mockReturnValue({})
vi.mock('./recent-actions.svelte', () => ({
  recentActions: () => ({
    record: mockRecord,
    count: (k: string) => mockSnapshot()[k] ?? 0,
    snapshot: mockSnapshot,
    clear: vi.fn(),
  }),
}))

import { api } from './api'
import type { Bookmark } from './api'

const mockBookmarks = api.bookmarks as ReturnType<typeof vi.fn>

function makeBookmark(name: string, overrides: Partial<Bookmark> = {}): Bookmark {
  return {
    name,
    conflict: false,
    synced: false,
    commit_id: 'aaa111',
    ...overrides,
  }
}

function defaultProps(overrides: Record<string, unknown> = {}) {
  return {
    open: true,
    onsave: vi.fn(),
    ...overrides,
  }
}

describe('BookmarkInput', () => {
  beforeEach(() => {
    mockBookmarks.mockReset()
    mockRecord.mockReset()
    mockSnapshot.mockReset().mockReturnValue({})
  })

  describe('rendering', () => {
    it('open=false → not rendered', () => {
      mockBookmarks.mockResolvedValue([])
      const { container } = render(BookmarkInput, { props: defaultProps({ open: false }) })
      expect(container.querySelector('.bm-set-modal')).not.toBeInTheDocument()
    })

    it('open=true → shows modal with input and header', async () => {
      mockBookmarks.mockResolvedValue([])
      const { container } = render(BookmarkInput, { props: defaultProps() })
      expect(container.querySelector('.bm-set-modal')).toBeInTheDocument()
      expect(container.querySelector('.bm-set-header')?.textContent).toBe('Set Bookmark')
      expect(container.querySelector('.bm-set-input')).toBeInTheDocument()
    })
  })

  describe('autocomplete', () => {
    it('typing filters suggestions via fuzzyMatch', async () => {
      mockBookmarks.mockResolvedValue([
        makeBookmark('main'),
        makeBookmark('feature'),
        makeBookmark('fix-bug'),
      ])
      const { container } = render(BookmarkInput, { props: defaultProps() })

      // Wait for bookmarks to load
      await waitFor(() => { expect(mockBookmarks).toHaveBeenCalled() })

      const input = container.querySelector('.bm-set-input') as HTMLInputElement
      await fireEvent.input(input, { target: { value: 'fe' } })

      await waitFor(() => {
        const suggestions = container.querySelectorAll('.bm-set-suggestion')
        expect(suggestions.length).toBeGreaterThan(0)
        const texts = Array.from(suggestions).map(s => s.textContent)
        expect(texts.some(t => t?.includes('feature'))).toBe(true)
      })
    })

    it('suggestions capped at 8', async () => {
      const bookmarks = Array.from({ length: 12 }, (_, i) => makeBookmark(`a${i}`))
      mockBookmarks.mockResolvedValue(bookmarks)
      const { container } = render(BookmarkInput, { props: defaultProps() })

      await waitFor(() => { expect(mockBookmarks).toHaveBeenCalled() })

      const input = container.querySelector('.bm-set-input') as HTMLInputElement
      await fireEvent.input(input, { target: { value: 'a' } })

      await waitFor(() => {
        const suggestions = container.querySelectorAll('.bm-set-suggestion')
        expect(suggestions.length).toBeLessThanOrEqual(8)
      })
    })

    it('each suggestion shows move hint', async () => {
      mockBookmarks.mockResolvedValue([makeBookmark('feature')])
      const { container } = render(BookmarkInput, { props: defaultProps() })

      await waitFor(() => { expect(mockBookmarks).toHaveBeenCalled() })

      const input = container.querySelector('.bm-set-input') as HTMLInputElement
      await fireEvent.input(input, { target: { value: 'fe' } })

      await waitFor(() => {
        const suggestions = container.querySelectorAll('.bm-set-suggestion')
        expect(suggestions.length).toBeGreaterThan(0)
        const text = suggestions[0].textContent ?? ''
        expect(text).toContain('move')
        // The arrow entity renders as → in text
        expect(text).toContain('here')
      })
    })

    it('shows inline error when bookmarks fetch fails', async () => {
      // Regression: was silently swallowing fetch errors → empty suggestions
      // with no explanation. Now surfaces the error so user knows what happened.
      mockBookmarks.mockRejectedValue(new Error('connection refused'))
      const { container } = render(BookmarkInput, { props: defaultProps() })

      await waitFor(() => {
        const errorEl = container.querySelector('.bm-set-error')
        expect(errorEl).toBeInTheDocument()
        expect(errorEl?.textContent).toContain('connection refused')
      })
      // Suggestions list should not render when there's an error
      expect(container.querySelector('.bm-set-suggestions')).toBeNull()
    })

    it('allows typing and submitting even when bookmarks fetch fails', async () => {
      // Error affects autocomplete only — user can still create a new bookmark
      mockBookmarks.mockRejectedValue(new Error('timeout'))
      const onsave = vi.fn()
      const { container } = render(BookmarkInput, { props: defaultProps({ onsave }) })

      await waitFor(() => expect(container.querySelector('.bm-set-error')).toBeInTheDocument())

      const input = container.querySelector('.bm-set-input') as HTMLInputElement
      await fireEvent.input(input, { target: { value: 'new-bookmark' } })
      await fireEvent.keyDown(input, { key: 'Enter' })
      expect(onsave).toHaveBeenCalledWith('new-bookmark')
    })
  })

  describe('keyboard', () => {
    it('Enter submits typed value', async () => {
      const onsave = vi.fn()
      mockBookmarks.mockResolvedValue([])
      const { container } = render(BookmarkInput, { props: defaultProps({ onsave }) })

      const input = container.querySelector('.bm-set-input') as HTMLInputElement
      await fireEvent.input(input, { target: { value: 'new-branch' } })
      await fireEvent.keyDown(input, { key: 'Enter' })

      expect(onsave).toHaveBeenCalledWith('new-branch')
    })

    it('Escape closes', async () => {
      mockBookmarks.mockResolvedValue([])
      const { container } = render(BookmarkInput, { props: defaultProps() })

      const input = container.querySelector('.bm-set-input') as HTMLInputElement
      await fireEvent.keyDown(input, { key: 'Escape' })

      expect(container.querySelector('.bm-set-input')).toBeNull()
    })

    it('ArrowDown selects next suggestion', async () => {
      mockBookmarks.mockResolvedValue([
        makeBookmark('feature'),
        makeBookmark('fix-bug'),
      ])
      const { container } = render(BookmarkInput, { props: defaultProps() })

      await waitFor(() => { expect(mockBookmarks).toHaveBeenCalled() })

      const input = container.querySelector('.bm-set-input') as HTMLInputElement
      await fireEvent.input(input, { target: { value: 'f' } })

      await waitFor(() => {
        expect(container.querySelectorAll('.bm-set-suggestion').length).toBeGreaterThan(0)
      })

      await fireEvent.keyDown(input, { key: 'ArrowDown' })

      await waitFor(() => {
        const suggestions = container.querySelectorAll('.bm-set-suggestion')
        expect(suggestions[0].classList.contains('active')).toBe(true)
      })
    })

    it('ArrowUp selects previous suggestion', async () => {
      mockBookmarks.mockResolvedValue([
        makeBookmark('feature'),
        makeBookmark('fix-bug'),
      ])
      const { container } = render(BookmarkInput, { props: defaultProps() })

      await waitFor(() => { expect(mockBookmarks).toHaveBeenCalled() })

      const input = container.querySelector('.bm-set-input') as HTMLInputElement
      await fireEvent.input(input, { target: { value: 'f' } })

      await waitFor(() => {
        expect(container.querySelectorAll('.bm-set-suggestion').length).toBeGreaterThan(1)
      })

      await fireEvent.keyDown(input, { key: 'ArrowDown' })
      await fireEvent.keyDown(input, { key: 'ArrowDown' })
      await fireEvent.keyDown(input, { key: 'ArrowUp' })

      await waitFor(() => {
        const suggestions = container.querySelectorAll('.bm-set-suggestion')
        expect(suggestions[0].classList.contains('active')).toBe(true)
      })
    })

    it('Enter with selected suggestion submits suggestion name', async () => {
      const onsave = vi.fn()
      mockBookmarks.mockResolvedValue([
        makeBookmark('feature'),
        makeBookmark('fix-bug'),
      ])
      const { container } = render(BookmarkInput, { props: defaultProps({ onsave }) })

      await waitFor(() => { expect(mockBookmarks).toHaveBeenCalled() })

      const input = container.querySelector('.bm-set-input') as HTMLInputElement
      await fireEvent.input(input, { target: { value: 'f' } })

      await waitFor(() => {
        expect(container.querySelectorAll('.bm-set-suggestion').length).toBeGreaterThan(0)
      })

      await fireEvent.keyDown(input, { key: 'ArrowDown' })
      await fireEvent.keyDown(input, { key: 'Enter' })

      expect(onsave).toHaveBeenCalledTimes(1)
      // Should be the first matching suggestion
      const calledWith = onsave.mock.calls[0][0]
      expect(calledWith).toBe('feature')
    })
  })

  describe('empty-input defaults', () => {
    // Previously filtered returned [] when !value — nothing shown until you
    // typed. Now it surfaces conflict > trunk > rest so the common cases
    // (resolve a conflict, advance trunk) are one ↓ + Enter away.
    const names = (c: HTMLElement) =>
      [...c.querySelectorAll('.bm-set-suggestion')].map(s =>
        s.textContent?.replace(/\s+/g, ' ').trim()
      )

    it('empty input shows suggestions (was: nothing)', async () => {
      mockBookmarks.mockResolvedValue([makeBookmark('feature')])
      const { container } = render(BookmarkInput, { props: defaultProps() })
      await waitFor(() => {
        expect(container.querySelectorAll('.bm-set-suggestion').length).toBe(1)
      })
    })

    it('conflicted bookmarks sort first with resolve verb + ?? badge', async () => {
      mockBookmarks.mockResolvedValue([
        makeBookmark('feature'),
        makeBookmark('staging', { conflict: true, commit_id: '' }),
        makeBookmark('other'),
      ])
      const { container } = render(BookmarkInput, { props: defaultProps() })
      await waitFor(() => {
        const rows = names(container)
        expect(rows[0]).toContain('resolve')
        expect(rows[0]).toContain('staging')
        expect(rows[0]).toContain('??')
        // Non-conflict rows still say "move"
        expect(rows[1]).toContain('move')
        expect(rows[1]).not.toContain('??')
      })
    })

    it('trunk-pattern names (main/master/trunk) sort above arbitrary names', async () => {
      mockBookmarks.mockResolvedValue([
        makeBookmark('zzz-feature'),
        makeBookmark('aaa-feature'),
        makeBookmark('master'),
      ])
      const { container } = render(BookmarkInput, { props: defaultProps() })
      await waitFor(() => {
        const rows = names(container)
        expect(rows[0]).toContain('master')
      })
    })

    it('conflict outranks trunk', async () => {
      mockBookmarks.mockResolvedValue([
        makeBookmark('main'),
        makeBookmark('staging', { conflict: true, commit_id: '' }),
      ])
      const { container } = render(BookmarkInput, { props: defaultProps() })
      await waitFor(() => {
        const rows = names(container)
        expect(rows[0]).toContain('staging')
        expect(rows[1]).toContain('main')
      })
    })

    it('capped at 5 when empty (8 when typing)', async () => {
      mockBookmarks.mockResolvedValue(
        Array.from({ length: 10 }, (_, i) => makeBookmark(`bm-${i}`))
      )
      const { container } = render(BookmarkInput, { props: defaultProps() })
      await waitFor(() => {
        expect(container.querySelectorAll('.bm-set-suggestion').length).toBe(5)
      })
      const input = container.querySelector('.bm-set-input') as HTMLInputElement
      await fireEvent.input(input, { target: { value: 'bm' } })
      await waitFor(() => {
        expect(container.querySelectorAll('.bm-set-suggestion').length).toBe(8)
      })
    })

    it('↓↓ reaches second default without collapsing list (arrow does NOT write value)', async () => {
      // Regression: arrow used to write value = filtered[i].name, which flipped
      // filtered from default-sort to fuzzy-filter mode. fuzzyMatch('staging',
      // 'main') is false → list collapsed to [staging] → second ↓ clamped at 0.
      mockBookmarks.mockResolvedValue([
        makeBookmark('staging', { conflict: true, commit_id: '' }),
        makeBookmark('main'),
      ])
      const onsave = vi.fn()
      const { container } = render(BookmarkInput, { props: defaultProps({ onsave }) })
      await waitFor(() => {
        expect(container.querySelectorAll('.bm-set-suggestion').length).toBe(2)
      })
      const input = container.querySelector('.bm-set-input') as HTMLInputElement
      const rows = () => container.querySelectorAll('.bm-set-suggestion')

      await fireEvent.keyDown(input, { key: 'ArrowDown' })
      expect(input.value).toBe('') // highlight-only, value stays empty
      expect(rows()[0].classList.contains('active')).toBe(true)
      expect(rows().length).toBe(2) // list did NOT collapse

      await fireEvent.keyDown(input, { key: 'ArrowDown' })
      expect(rows()[1].classList.contains('active')).toBe(true) // reached main

      await fireEvent.keyDown(input, { key: 'Enter' })
      expect(onsave).toHaveBeenCalledWith('main')
    })

    it('recency tier: higher frequency sorts above lower (both non-conflict non-trunk)', async () => {
      mockSnapshot.mockReturnValue({ 'used-often': 5, 'used-once': 1 })
      mockBookmarks.mockResolvedValue([
        makeBookmark('used-once'),
        makeBookmark('used-often'),
        makeBookmark('never-used'),
      ])
      const { container } = render(BookmarkInput, { props: defaultProps() })
      await waitFor(() => {
        const rows = names(container)
        expect(rows[0]).toContain('used-often')
        expect(rows[1]).toContain('used-once')
        expect(rows[2]).toContain('never-used')
      })
    })

    it('submit() records the resolved name before onsave', async () => {
      mockBookmarks.mockResolvedValue([makeBookmark('feat')])
      const onsave = vi.fn()
      const { container } = render(BookmarkInput, { props: defaultProps({ onsave }) })
      const input = container.querySelector('.bm-set-input') as HTMLInputElement
      await fireEvent.input(input, { target: { value: 'feat' } })
      await fireEvent.keyDown(input, { key: 'Enter' })
      // record() fires before onsave — if onsave throws, frequency still updates.
      expect(mockRecord).toHaveBeenCalledWith('feat')
      expect(mockRecord.mock.invocationCallOrder[0])
        .toBeLessThan(onsave.mock.invocationCallOrder[0])
    })
  })

  describe('submit logic', () => {
    it('empty value does not call onsave', async () => {
      const onsave = vi.fn()
      mockBookmarks.mockResolvedValue([])
      const { container } = render(BookmarkInput, { props: defaultProps({ onsave }) })

      const input = container.querySelector('.bm-set-input') as HTMLInputElement
      await fireEvent.keyDown(input, { key: 'Enter' })

      expect(onsave).not.toHaveBeenCalled()
    })
  })
})
