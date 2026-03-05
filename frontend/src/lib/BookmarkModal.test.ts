import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/svelte'
import BookmarkModal from './BookmarkModal.svelte'

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
    name: 'main',
    local: undefined,
    remotes: undefined,
    conflict: false,
    backwards: false,
    commit_id: 'aaa111',
    ...overrides,
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

// Waits for any terminal state (items rendered OR empty/error message).
// Previous version waited for .bm-item.length > 0, which timed out on
// empty/error cases.
async function renderSettled(props: ReturnType<typeof defaultProps>) {
  const r = render(BookmarkModal, { props })
  await waitFor(() => expect(screen.queryByText('Loading...')).toBeNull())
  return r
}

function modal(): HTMLElement {
  return document.querySelector('.bm-modal')!
}

function items(): NodeListOf<Element> {
  return document.querySelectorAll('.bm-item')
}

function footer(): string {
  return document.querySelector('.bm-footer')!.textContent ?? ''
}

describe('BookmarkModal', () => {
  beforeEach(() => {
    mockBookmarks.mockReset()
    mockRemotes.mockReset()
    mockRemotes.mockResolvedValue(['origin'])
  })

  describe('rendering — one row per bookmark', () => {
    it('renders N rows for N bookmarks, not N × actions', async () => {
      mockBookmarks.mockResolvedValue([
        makeBookmark({ name: 'alpha' }),
        makeBookmark({ name: 'beta' }),
        makeBookmark({ name: 'gamma' }),
      ])
      await renderSettled(defaultProps())
      expect(items()).toHaveLength(3)
    })

    it('bookmark at current commit shows "→ here" and dims move hint', async () => {
      mockBookmarks.mockResolvedValue([makeBookmark({ name: 'feat', commit_id: 'same' })])
      await renderSettled(defaultProps({ currentCommitId: 'same' }))
      expect(screen.getByText('→ here')).toBeInTheDocument()
      const moveHint = screen.getByText('move here').closest('span')
      expect(moveHint).toHaveClass('dim')
    })

    it('bookmark elsewhere shows short commit id', async () => {
      mockBookmarks.mockResolvedValue([makeBookmark({ name: 'feat', commit_id: 'deadbeef1234' })])
      await renderSettled(defaultProps({ currentCommitId: 'other' }))
      expect(screen.getByText('deadbeef')).toBeInTheDocument()
    })

    it('tracked remote bookmark shows tracked badge', async () => {
      mockBookmarks.mockResolvedValue([
        makeBookmark({ name: 'feat', remotes: [{ remote: 'origin', commit_id: 'x', tracked: true }] }),
      ])
      await renderSettled(defaultProps())
      expect(screen.getByText('⊙ origin')).toBeInTheDocument()
    })

    it('conflict bookmark shows conflict badge', async () => {
      mockBookmarks.mockResolvedValue([makeBookmark({ name: 'feat', conflict: true })])
      await renderSettled(defaultProps())
      expect(screen.getByText('conflict')).toBeInTheDocument()
    })

    it('footer shows which remote t operates on', async () => {
      mockBookmarks.mockResolvedValue([
        makeBookmark({ name: 'feat', remotes: [{ remote: 'upstream', commit_id: 'x', tracked: true }] }),
      ])
      await renderSettled(defaultProps())
      expect(footer()).toContain('untrack')
      expect(footer()).toContain('(upstream)')
    })
  })

  describe('focus on open', () => {
    it('focuses the modal (not the input) after mount', async () => {
      // Regression guard: modalEl?.focus() in the effect body runs before
      // {#if open} mounts → modalEl is undefined → optional chaining eats it
      // → action keys dead. tick() wrapper fixes this.
      mockBookmarks.mockResolvedValue([makeBookmark({ name: 'feat' })])
      await renderSettled(defaultProps())
      expect(document.activeElement).toBe(modal())
    })
  })

  describe('double-press confirmation for destructive ops', () => {
    it('first d arms, second d fires delete', async () => {
      const onexecute = vi.fn()
      mockBookmarks.mockResolvedValue([
        makeBookmark({ name: 'feat', local: { remote: 'origin', commit_id: 'x', tracked: true } }),
      ])
      await renderSettled(defaultProps({ onexecute }))

      await fireEvent.keyDown(modal(), { key: 'd' })
      expect(onexecute).not.toHaveBeenCalled()
      expect(footer()).toContain('again to delete')
      expect(footer()).toContain('feat')

      await fireEvent.keyDown(modal(), { key: 'd' })
      expect(onexecute).toHaveBeenCalledWith({ action: 'delete', bookmark: 'feat' })
    })

    it('first f arms, second f fires forget', async () => {
      const onexecute = vi.fn()
      mockBookmarks.mockResolvedValue([makeBookmark({ name: 'feat' })])
      await renderSettled(defaultProps({ onexecute }))

      await fireEvent.keyDown(modal(), { key: 'f' })
      expect(onexecute).not.toHaveBeenCalled()
      expect(footer()).toContain('again to forget')

      await fireEvent.keyDown(modal(), { key: 'f' })
      expect(onexecute).toHaveBeenCalledWith({ action: 'forget', bookmark: 'feat' })
    })

    it('untrack requires confirmation', async () => {
      const onexecute = vi.fn()
      mockBookmarks.mockResolvedValue([
        makeBookmark({ name: 'feat', remotes: [{ remote: 'origin', commit_id: 'x', tracked: true }] }),
      ])
      await renderSettled(defaultProps({ onexecute }))

      await fireEvent.keyDown(modal(), { key: 't' })
      expect(onexecute).not.toHaveBeenCalled()
      expect(footer()).toContain('again to untrack')
      expect(footer()).toContain('feat@origin')

      await fireEvent.keyDown(modal(), { key: 't' })
      expect(onexecute).toHaveBeenCalledWith({ action: 'untrack', bookmark: 'feat', remote: 'origin' })
    })

    it('track does NOT require confirmation (non-destructive)', async () => {
      const onexecute = vi.fn()
      mockBookmarks.mockResolvedValue([
        makeBookmark({ name: 'feat', remotes: [{ remote: 'origin', commit_id: 'x', tracked: false }] }),
      ])
      await renderSettled(defaultProps({ onexecute }))

      await fireEvent.keyDown(modal(), { key: 't' })
      expect(onexecute).toHaveBeenCalledWith({ action: 'track', bookmark: 'feat', remote: 'origin' })
    })

    it('j/k disarms', async () => {
      const onexecute = vi.fn()
      mockBookmarks.mockResolvedValue([
        makeBookmark({ name: 'alpha', local: { remote: 'origin', commit_id: 'x', tracked: true } }),
        makeBookmark({ name: 'beta', local: { remote: 'origin', commit_id: 'x', tracked: true } }),
      ])
      await renderSettled(defaultProps({ onexecute }))

      await fireEvent.keyDown(modal(), { key: 'd' }) // arm on alpha
      await fireEvent.keyDown(modal(), { key: 'j' }) // move to beta — disarms
      await fireEvent.keyDown(modal(), { key: 'd' }) // re-arms on beta, doesn't fire
      expect(onexecute).not.toHaveBeenCalled()
      expect(footer()).toContain('beta') // confirmation is for beta, not alpha
    })

    it('Escape disarms without closing', async () => {
      const onclose = vi.fn()
      mockBookmarks.mockResolvedValue([
        makeBookmark({ name: 'feat', local: { remote: 'origin', commit_id: 'x', tracked: true } }),
      ])
      await renderSettled(defaultProps({ onclose }))

      await fireEvent.keyDown(modal(), { key: 'd' })
      expect(footer()).toContain('again to delete')

      await fireEvent.keyDown(modal(), { key: 'Escape' })
      expect(onclose).not.toHaveBeenCalled()
      expect(footer()).not.toContain('again')
    })

    it('pressing a different action key disarms and re-arms', async () => {
      const onexecute = vi.fn()
      mockBookmarks.mockResolvedValue([
        makeBookmark({ name: 'feat', local: { remote: 'origin', commit_id: 'x', tracked: true } }),
      ])
      await renderSettled(defaultProps({ onexecute }))

      await fireEvent.keyDown(modal(), { key: 'd' })
      expect(footer()).toContain('again to delete')

      await fireEvent.keyDown(modal(), { key: 'f' }) // different key → disarm d, arm f
      expect(onexecute).not.toHaveBeenCalled()
      expect(footer()).toContain('again to forget')
    })

    it('mousemove to a different row disarms', async () => {
      const onexecute = vi.fn()
      mockBookmarks.mockResolvedValue([
        makeBookmark({ name: 'alpha', local: { remote: 'origin', commit_id: 'x', tracked: true } }),
        makeBookmark({ name: 'beta' }),
      ])
      await renderSettled(defaultProps({ onexecute }))

      await fireEvent.keyDown(modal(), { key: 'd' })
      await fireEvent.mouseMove(items()[1])
      expect(footer()).not.toContain('again')
    })

    it('Enter (move) does NOT require confirmation', async () => {
      const onexecute = vi.fn()
      mockBookmarks.mockResolvedValue([makeBookmark({ name: 'feat', commit_id: 'aaa' })])
      await renderSettled(defaultProps({ currentCommitId: 'bbb', onexecute }))

      await fireEvent.keyDown(modal(), { key: 'Enter' })
      expect(onexecute).toHaveBeenCalledWith({ action: 'move', bookmark: 'feat' })
    })

    it('a (advance) fires on single press — jj refuses backwards, so no gate needed', async () => {
      const onexecute = vi.fn()
      mockBookmarks.mockResolvedValue([makeBookmark({ name: 'feat', commit_id: 'aaa' })])
      await renderSettled(defaultProps({ currentCommitId: 'bbb', onexecute }))

      await fireEvent.keyDown(modal(), { key: 'a' })
      expect(onexecute).toHaveBeenCalledWith({ action: 'advance', bookmark: 'feat' })
    })

    it('a disarms a pending destructive confirmation', async () => {
      const onexecute = vi.fn()
      mockBookmarks.mockResolvedValue([makeBookmark({ name: 'feat', local: { remote: 'origin', commit_id: 'x', tracked: true }, commit_id: 'aaa' })])
      await renderSettled(defaultProps({ currentCommitId: 'bbb', onexecute }))

      await fireEvent.keyDown(modal(), { key: 'd' }) // arm delete
      expect(footer()).toContain('again to delete')
      await fireEvent.keyDown(modal(), { key: 'a' }) // disarms + fires advance
      expect(onexecute).toHaveBeenCalledWith({ action: 'advance', bookmark: 'feat' })
      expect(onexecute).toHaveBeenCalledTimes(1)
    })
  })

  describe('action availability guards', () => {
    it('Enter is no-op when bookmark already at current commit', async () => {
      const onexecute = vi.fn()
      mockBookmarks.mockResolvedValue([makeBookmark({ name: 'feat', commit_id: 'same' })])
      await renderSettled(defaultProps({ currentCommitId: 'same', onexecute }))

      await fireEvent.keyDown(modal(), { key: 'Enter' })
      expect(onexecute).not.toHaveBeenCalled()
    })

    it('a is no-op when bookmark already at current commit (same gate as move)', async () => {
      const onexecute = vi.fn()
      mockBookmarks.mockResolvedValue([makeBookmark({ name: 'feat', commit_id: 'same' })])
      await renderSettled(defaultProps({ currentCommitId: 'same', onexecute }))

      await fireEvent.keyDown(modal(), { key: 'a' })
      expect(onexecute).not.toHaveBeenCalled()
    })

    it('d is no-op for remote-only bookmark', async () => {
      const onexecute = vi.fn()
      mockBookmarks.mockResolvedValue([makeBookmark({ name: 'feat', local: undefined })])
      await renderSettled(defaultProps({ onexecute }))

      await fireEvent.keyDown(modal(), { key: 'd' })
      await fireEvent.keyDown(modal(), { key: 'd' })
      expect(onexecute).not.toHaveBeenCalled()
      expect(footer()).not.toContain('again') // never even armed
    })

    it('t is no-op when no remotes exist', async () => {
      const onexecute = vi.fn()
      mockBookmarks.mockResolvedValue([makeBookmark({ name: 'feat' })])
      mockRemotes.mockResolvedValue([])
      await renderSettled(defaultProps({ onexecute }))

      await fireEvent.keyDown(modal(), { key: 't' })
      await fireEvent.keyDown(modal(), { key: 't' })
      expect(onexecute).not.toHaveBeenCalled()
    })

    it('t fires track against default remote for local-only bookmark', async () => {
      const onexecute = vi.fn()
      mockBookmarks.mockResolvedValue([
        makeBookmark({ name: 'feat', local: { remote: 'origin', commit_id: 'x', tracked: true } }),
      ])
      mockRemotes.mockResolvedValue(['upstream', 'origin']) // [0] is default
      await renderSettled(defaultProps({ onexecute }))

      await fireEvent.keyDown(modal(), { key: 't' }) // track, non-destructive, fires immediately
      expect(onexecute).toHaveBeenCalledWith({ action: 'track', bookmark: 'feat', remote: 'upstream' })
    })
  })

  describe('mouse interaction', () => {
    it('mousemove changes selection', async () => {
      mockBookmarks.mockResolvedValue([
        makeBookmark({ name: 'alpha' }),
        makeBookmark({ name: 'beta' }),
      ])
      await renderSettled(defaultProps())

      expect(items()[0]).toHaveClass('bm-item-active')
      await fireEvent.mouseMove(items()[1])
      expect(items()[1]).toHaveClass('bm-item-active')
    })

    it('click fires move', async () => {
      const onexecute = vi.fn()
      mockBookmarks.mockResolvedValue([makeBookmark({ name: 'feat', commit_id: 'aaa' })])
      await renderSettled(defaultProps({ currentCommitId: 'bbb', onexecute }))

      await fireEvent.click(items()[0])
      expect(onexecute).toHaveBeenCalledWith({ action: 'move', bookmark: 'feat' })
    })

    it('click is no-op when bookmark already here', async () => {
      const onexecute = vi.fn()
      mockBookmarks.mockResolvedValue([makeBookmark({ name: 'feat', commit_id: 'same' })])
      await renderSettled(defaultProps({ currentCommitId: 'same', onexecute }))

      await fireEvent.click(items()[0])
      expect(onexecute).not.toHaveBeenCalled()
    })
  })

  describe('navigation + filter', () => {
    it('j/k move selection', async () => {
      mockBookmarks.mockResolvedValue([
        makeBookmark({ name: 'alpha' }),
        makeBookmark({ name: 'beta' }),
      ])
      await renderSettled(defaultProps())

      expect(items()[0]).toHaveClass('bm-item-active')
      await fireEvent.keyDown(modal(), { key: 'j' })
      expect(items()[1]).toHaveClass('bm-item-active')
      await fireEvent.keyDown(modal(), { key: 'k' })
      expect(items()[0]).toHaveClass('bm-item-active')
    })

    it('action keys are inert while typing in filter', async () => {
      const onexecute = vi.fn()
      mockBookmarks.mockResolvedValue([makeBookmark({ name: 'feat' })])
      await renderSettled(defaultProps({ onexecute }))

      const input = screen.getByPlaceholderText('Filter...')
      await fireEvent.focus(input)
      await fireEvent.keyDown(modal(), { key: 'f' })
      await fireEvent.keyDown(modal(), { key: 'f' })
      expect(onexecute).not.toHaveBeenCalled()
    })

    it('Enter fires move even while input is focused', async () => {
      // Pin: filter-then-Enter is a natural flow. Enter is above the
      // inputFocused gate deliberately.
      const onexecute = vi.fn()
      mockBookmarks.mockResolvedValue([makeBookmark({ name: 'feat', commit_id: 'aaa' })])
      await renderSettled(defaultProps({ currentCommitId: 'bbb', onexecute }))

      await fireEvent.focus(screen.getByPlaceholderText('Filter...'))
      await fireEvent.keyDown(modal(), { key: 'Enter' })
      expect(onexecute).toHaveBeenCalledWith({ action: 'move', bookmark: 'feat' })
    })

    it('/ focuses the filter input', async () => {
      mockBookmarks.mockResolvedValue([makeBookmark({ name: 'feat' })])
      await renderSettled(defaultProps())

      const input = screen.getByPlaceholderText('Filter...') as HTMLInputElement
      expect(document.activeElement).not.toBe(input)

      await fireEvent.keyDown(modal(), { key: '/' })
      expect(document.activeElement).toBe(input)
    })

    it('ArrowDown from focused input blurs it and moves selection', async () => {
      mockBookmarks.mockResolvedValue([
        makeBookmark({ name: 'alpha' }),
        makeBookmark({ name: 'beta' }),
      ])
      await renderSettled(defaultProps())

      const input = screen.getByPlaceholderText('Filter...') as HTMLInputElement
      input.focus() // real focus, not fireEvent.focus — we need activeElement to move
      expect(document.activeElement).toBe(input)

      await fireEvent.keyDown(modal(), { key: 'ArrowDown' })
      expect(document.activeElement).toBe(modal())
      expect(items()[1]).toHaveClass('bm-item-active')
    })

    it('filter narrows by bookmark name', async () => {
      mockBookmarks.mockResolvedValue([
        makeBookmark({ name: 'feature-auth' }),
        makeBookmark({ name: 'bugfix-login' }),
      ])
      await renderSettled(defaultProps())

      const input = screen.getByPlaceholderText('Filter...')
      await fireEvent.input(input, { target: { value: 'auth' } })

      await waitFor(() => {
        expect(items()).toHaveLength(1)
        expect(screen.getByText('feature-auth')).toBeInTheDocument()
      })
    })

    it('filterBookmark prop pre-filters to one bookmark; action keys work', async () => {
      // Badge-click flow: click bookmark in RevisionHeader → modal opens
      // pre-filtered → press f to forget.
      const onexecute = vi.fn()
      mockBookmarks.mockResolvedValue([
        makeBookmark({ name: 'alpha' }),
        makeBookmark({ name: 'beta' }),
      ])
      await renderSettled(defaultProps({ filterBookmark: 'alpha', onexecute }))

      expect(items()).toHaveLength(1)
      await fireEvent.keyDown(modal(), { key: 'f' })
      await fireEvent.keyDown(modal(), { key: 'f' })
      expect(onexecute).toHaveBeenCalledWith({ action: 'forget', bookmark: 'alpha' })
    })

    it('Escape with non-empty query clears it — regardless of input focus', async () => {
      // Regression guard: old code checked `inInput && query`, so typing
      // then ArrowDown then Escape closed immediately with filter lost.
      const onclose = vi.fn()
      mockBookmarks.mockResolvedValue([makeBookmark({ name: 'feat' })])
      await renderSettled(defaultProps({ onclose }))

      const input = screen.getByPlaceholderText('Filter...') as HTMLInputElement
      await fireEvent.focus(input)
      await fireEvent.input(input, { target: { value: 'x' } })
      await fireEvent.keyDown(modal(), { key: 'ArrowDown' }) // leave input
      await fireEvent.keyDown(modal(), { key: 'Escape' })

      expect(input.value).toBe('')
      expect(onclose).not.toHaveBeenCalled()
    })

    it('Escape with empty query and no armed key closes', async () => {
      const onclose = vi.fn()
      mockBookmarks.mockResolvedValue([makeBookmark({ name: 'feat' })])
      await renderSettled(defaultProps({ onclose }))

      await fireEvent.keyDown(modal(), { key: 'Escape' })
      expect(onclose).toHaveBeenCalled()
    })
  })

  describe('footer hints react to selection', () => {
    it('track hint label flips between track/untrack per selected bookmark', async () => {
      mockBookmarks.mockResolvedValue([
        makeBookmark({ name: 'alpha', remotes: [{ remote: 'origin', commit_id: 'x', tracked: true }] }),
        makeBookmark({ name: 'beta', remotes: [{ remote: 'origin', commit_id: 'x', tracked: false }] }),
      ])
      await renderSettled(defaultProps())

      expect(footer()).toContain('untrack')
      await fireEvent.keyDown(modal(), { key: 'j' })
      expect(footer()).toContain('track')
      expect(footer()).not.toContain('untrack')
    })
  })

  describe('states', () => {
    it('shows loading while fetching', () => {
      mockBookmarks.mockReturnValue(new Promise(() => {}))
      render(BookmarkModal, { props: defaultProps() })
      expect(screen.getByText('Loading...')).toBeInTheDocument()
    })

    it('shows error on fetch failure', async () => {
      mockBookmarks.mockRejectedValue(new Error('Network error'))
      render(BookmarkModal, { props: defaultProps() })
      await waitFor(() => expect(screen.getByText('Network error')).toBeInTheDocument())
    })

    it('shows empty message when api returns zero bookmarks', async () => {
      mockBookmarks.mockResolvedValue([])
      await renderSettled(defaultProps())
      expect(screen.getByText('No matching bookmarks')).toBeInTheDocument()
    })

    it('shows empty message when filter matches nothing', async () => {
      mockBookmarks.mockResolvedValue([makeBookmark({ name: 'feat' })])
      await renderSettled(defaultProps())

      const input = screen.getByPlaceholderText('Filter...')
      await fireEvent.input(input, { target: { value: 'zzz' } })
      await waitFor(() => expect(screen.getByText('No matching bookmarks')).toBeInTheDocument())
    })

    it('remotes fetch failure does not break the modal', async () => {
      mockBookmarks.mockResolvedValue([makeBookmark({ name: 'feat' })])
      mockRemotes.mockRejectedValue(new Error('boom'))
      await renderSettled(defaultProps())

      expect(items()).toHaveLength(1)
      // t is dimmed (no trackInfo → can.track null) but modal is otherwise fine
      const tHint = [...document.querySelectorAll('.bm-footer > span')].find(s => s.textContent?.includes('track'))
      expect(tHint).toHaveClass('dim')
    })
  })

  describe('a11y', () => {
    it('modal has aria-modal and dialog role', async () => {
      mockBookmarks.mockResolvedValue([makeBookmark({ name: 'feat' })])
      await renderSettled(defaultProps())
      const m = modal()
      expect(m.getAttribute('role')).toBe('dialog')
      expect(m.getAttribute('aria-modal')).toBe('true')
    })

    it('listbox has aria-activedescendant pointing at selected option', async () => {
      mockBookmarks.mockResolvedValue([
        makeBookmark({ name: 'alpha' }),
        makeBookmark({ name: 'beta' }),
      ])
      await renderSettled(defaultProps())

      const listbox = document.querySelector('[role="listbox"]')!
      expect(listbox.getAttribute('aria-activedescendant')).toBe('bm-opt-0')
      await fireEvent.keyDown(modal(), { key: 'j' })
      expect(listbox.getAttribute('aria-activedescendant')).toBe('bm-opt-1')
    })

    it('collapsed input is out of the tab order', async () => {
      mockBookmarks.mockResolvedValue([makeBookmark({ name: 'feat' })])
      await renderSettled(defaultProps())

      const input = screen.getByPlaceholderText('Filter...') as HTMLInputElement
      expect(input.tabIndex).toBe(-1)
      expect(input.getAttribute('aria-hidden')).toBe('true')
    })
  })
})
