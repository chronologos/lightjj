import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, fireEvent, waitFor } from '@testing-library/svelte'
import BookmarkInput from './BookmarkInput.svelte'

vi.mock('./api', () => ({
  api: {
    bookmarks: vi.fn(),
  },
}))

import { api } from './api'
import type { Bookmark } from './api'

const mockBookmarks = api.bookmarks as ReturnType<typeof vi.fn>

function makeBookmark(name: string): Bookmark {
  return {
    name,
    conflict: false,
    synced: false,
    commit_id: 'aaa111',
  }
}

function defaultProps(overrides: Record<string, unknown> = {}) {
  return {
    open: true,
    onsave: vi.fn(),
    oncancel: vi.fn(),
    ...overrides,
  }
}

describe('BookmarkInput', () => {
  beforeEach(() => {
    mockBookmarks.mockReset()
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

    it('Escape calls oncancel', async () => {
      const oncancel = vi.fn()
      mockBookmarks.mockResolvedValue([])
      const { container } = render(BookmarkInput, { props: defaultProps({ oncancel }) })

      const input = container.querySelector('.bm-set-input') as HTMLInputElement
      await fireEvent.keyDown(input, { key: 'Escape' })

      expect(oncancel).toHaveBeenCalledTimes(1)
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
