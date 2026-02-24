import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/svelte'
import BookmarkModal from './BookmarkModal.svelte'

// Mock the api module
vi.mock('./api', () => ({
  api: {
    bookmarks: vi.fn(),
    remotes: vi.fn(),
  },
}))

import { api } from './api'
import type { Bookmark } from './api'

const mockBookmarks = api.bookmarks as ReturnType<typeof vi.fn>
const mockRemotes = api.remotes as ReturnType<typeof vi.fn>

function makeBookmark(overrides: Partial<Bookmark> = {}): Bookmark {
  return {
    name: overrides.name ?? 'main',
    local: overrides.local,
    remotes: overrides.remotes,
    conflict: overrides.conflict ?? false,
    backwards: overrides.backwards ?? false,
    commit_id: overrides.commit_id ?? 'aaa111',
  }
}

function defaultProps(overrides: Record<string, unknown> = {}) {
  return {
    open: true,
    currentCommitId: 'bbb222',
    filterBookmark: '',
    onexecute: vi.fn(),
    onclose: vi.fn(),
    ...overrides,
  }
}

describe('BookmarkModal', () => {
  beforeEach(() => {
    mockBookmarks.mockReset()
    mockRemotes.mockReset()
  })

  describe('buildOps pipeline via rendered output', () => {
    it('bookmark on different commit shows move op', async () => {
      mockBookmarks.mockResolvedValue([makeBookmark({ name: 'feat', commit_id: 'aaa111' })])
      mockRemotes.mockResolvedValue([])

      render(BookmarkModal, { props: defaultProps({ currentCommitId: 'bbb222' }) })

      await waitFor(() => {
        const actions = document.querySelectorAll('.bm-action')
        expect(actions.length).toBeGreaterThan(0)
      })
      const actions = document.querySelectorAll('.bm-action')
      const actionTexts = Array.from(actions).map(a => a.textContent?.trim())
      expect(actionTexts).toContain('move')
    })

    it('bookmark on same commit has no move op', async () => {
      mockBookmarks.mockResolvedValue([makeBookmark({ name: 'feat', commit_id: 'same' })])
      mockRemotes.mockResolvedValue([])

      render(BookmarkModal, { props: defaultProps({ currentCommitId: 'same' }) })

      await waitFor(() => {
        expect(screen.getByText('feat')).toBeInTheDocument()
      })
      const actions = document.querySelectorAll('.bm-action')
      const actionTexts = Array.from(actions).map(a => a.textContent?.trim())
      expect(actionTexts).not.toContain('move')
    })

    it('bookmark with local shows delete op', async () => {
      mockBookmarks.mockResolvedValue([
        makeBookmark({ name: 'local-bm', local: { remote: 'origin', commit_id: 'x', tracked: true } }),
      ])
      mockRemotes.mockResolvedValue([])

      render(BookmarkModal, { props: defaultProps() })

      await waitFor(() => {
        const actions = document.querySelectorAll('.bm-action')
        expect(actions.length).toBeGreaterThan(0)
      })
      const actions = document.querySelectorAll('.bm-action')
      const actionTexts = Array.from(actions).map(a => a.textContent?.trim())
      expect(actionTexts).toContain('delete')
    })

    it('every bookmark shows forget op', async () => {
      mockBookmarks.mockResolvedValue([makeBookmark({ name: 'any-bm' })])
      mockRemotes.mockResolvedValue([])

      render(BookmarkModal, { props: defaultProps() })

      await waitFor(() => {
        const actions = document.querySelectorAll('.bm-action')
        expect(actions.length).toBeGreaterThan(0)
      })
      const actions = document.querySelectorAll('.bm-action')
      const actionTexts = Array.from(actions).map(a => a.textContent?.trim())
      expect(actionTexts).toContain('forget')
    })

    it('bookmark with tracked remote shows untrack op', async () => {
      mockBookmarks.mockResolvedValue([
        makeBookmark({
          name: 'tracked-bm',
          remotes: [{ remote: 'origin', commit_id: 'x', tracked: true }],
        }),
      ])
      mockRemotes.mockResolvedValue([])

      render(BookmarkModal, { props: defaultProps() })

      await waitFor(() => {
        expect(screen.getByText('tracked-bm@origin')).toBeInTheDocument()
      })
      const actions = document.querySelectorAll('.bm-action')
      const actionTexts = Array.from(actions).map(a => a.textContent?.trim())
      expect(actionTexts).toContain('untrack')
    })

    it('bookmark with untracked remote shows track op', async () => {
      mockBookmarks.mockResolvedValue([
        makeBookmark({
          name: 'untracked-bm',
          remotes: [{ remote: 'origin', commit_id: 'x', tracked: false }],
        }),
      ])
      mockRemotes.mockResolvedValue([])

      render(BookmarkModal, { props: defaultProps() })

      await waitFor(() => {
        expect(screen.getByText('untracked-bm@origin')).toBeInTheDocument()
      })
      const actions = document.querySelectorAll('.bm-action')
      const actionTexts = Array.from(actions).map(a => a.textContent?.trim())
      expect(actionTexts).toContain('track')
    })

    it('local-only bookmark with available remotes shows track per remote', async () => {
      mockBookmarks.mockResolvedValue([
        makeBookmark({
          name: 'local-only',
          local: { remote: 'origin', commit_id: 'x', tracked: true },
        }),
      ])
      mockRemotes.mockResolvedValue(['origin', 'upstream'])

      render(BookmarkModal, { props: defaultProps() })

      await waitFor(() => {
        // Should show track ops for both remotes
        const labels = document.querySelectorAll('.bm-label')
        const labelTexts = Array.from(labels).map(l => l.textContent)
        expect(labelTexts).toContain('local-only@origin')
        expect(labelTexts).toContain('local-only@upstream')
      })
    })

    it('currentCommitId is null produces no move ops', async () => {
      mockBookmarks.mockResolvedValue([makeBookmark({ name: 'feat', commit_id: 'aaa111' })])
      mockRemotes.mockResolvedValue([])

      render(BookmarkModal, { props: defaultProps({ currentCommitId: null }) })

      await waitFor(() => {
        expect(screen.getByText('feat')).toBeInTheDocument()
      })
      const actions = document.querySelectorAll('.bm-action')
      const actionTexts = Array.from(actions).map(a => a.textContent?.trim())
      expect(actionTexts).not.toContain('move')
    })
  })

  describe('filtering', () => {
    it('typing in input filters ops by fuzzyMatch on label', async () => {
      mockBookmarks.mockResolvedValue([
        makeBookmark({ name: 'feature-auth' }),
        makeBookmark({ name: 'bugfix-login' }),
      ])
      mockRemotes.mockResolvedValue([])

      render(BookmarkModal, { props: defaultProps() })

      await waitFor(() => {
        const labels = document.querySelectorAll('.bm-label')
        expect(labels.length).toBeGreaterThan(0)
      })

      const input = screen.getByPlaceholderText('Filter bookmarks...')
      await fireEvent.input(input, { target: { value: 'auth' } })

      // Only feature-auth ops should remain
      await waitFor(() => {
        const labels = document.querySelectorAll('.bm-label')
        const labelTexts = Array.from(labels).map(l => l.textContent)
        expect(labelTexts.some(t => t?.includes('feature-auth'))).toBe(true)
        expect(labelTexts.some(t => t?.includes('bugfix-login'))).toBe(false)
      })
    })

    it('filterBookmark prop pre-filters to single bookmark ops', async () => {
      mockBookmarks.mockResolvedValue([
        makeBookmark({ name: 'alpha' }),
        makeBookmark({ name: 'beta' }),
      ])
      mockRemotes.mockResolvedValue([])

      render(BookmarkModal, { props: defaultProps({ filterBookmark: 'alpha' }) })

      await waitFor(() => {
        const labels = document.querySelectorAll('.bm-label')
        const labelTexts = Array.from(labels).map(l => l.textContent)
        expect(labelTexts.every(t => t === 'alpha')).toBe(true)
      })
    })
  })

  describe('interaction', () => {
    it('clicking op calls onexecute with correct BookmarkOp', async () => {
      const onexecute = vi.fn()
      mockBookmarks.mockResolvedValue([makeBookmark({ name: 'feat', commit_id: 'aaa111' })])
      mockRemotes.mockResolvedValue([])

      render(BookmarkModal, { props: defaultProps({ onexecute }) })

      await waitFor(() => {
        const items = document.querySelectorAll('.bm-item')
        expect(items.length).toBeGreaterThan(0)
      })

      const items = document.querySelectorAll('.bm-item')
      await fireEvent.click(items[0])
      expect(onexecute).toHaveBeenCalledTimes(1)
      const op = onexecute.mock.calls[0][0]
      expect(op.bookmark).toBe('feat')
    })
  })

  describe('states', () => {
    it('shows loading message while fetching', () => {
      // Never resolve the promises
      mockBookmarks.mockReturnValue(new Promise(() => {}))
      mockRemotes.mockReturnValue(new Promise(() => {}))

      render(BookmarkModal, { props: defaultProps() })
      expect(screen.getByText('Loading bookmarks...')).toBeInTheDocument()
    })

    it('shows error message on fetch failure', async () => {
      mockBookmarks.mockRejectedValue(new Error('Network error'))
      mockRemotes.mockRejectedValue(new Error('Network error'))

      render(BookmarkModal, { props: defaultProps() })

      await waitFor(() => {
        expect(screen.getByText('Network error')).toBeInTheDocument()
      })
    })

    it('shows "No matching operations" when filtered list is empty', async () => {
      mockBookmarks.mockResolvedValue([makeBookmark({ name: 'feat' })])
      mockRemotes.mockResolvedValue([])

      render(BookmarkModal, { props: defaultProps() })

      await waitFor(() => {
        const items = document.querySelectorAll('.bm-item')
        expect(items.length).toBeGreaterThan(0)
      })

      const input = screen.getByPlaceholderText('Filter bookmarks...')
      await fireEvent.input(input, { target: { value: 'zzzzz_no_match' } })

      await waitFor(() => {
        expect(screen.getByText('No matching operations')).toBeInTheDocument()
      })
    })
  })
})
