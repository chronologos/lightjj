import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, fireEvent, waitFor } from '@testing-library/svelte'
import GitModal from './GitModal.svelte'

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
    currentChangeId: null as string | null,
    onexecute: vi.fn(),
    onclose: vi.fn(),
    ...overrides,
  }
}

// Waits for git command elements to render, then returns their text content.
// Accepts container from render() to scope queries and avoid cross-test contamination.
async function waitForCmds(container: HTMLElement): Promise<string[]> {
  await waitFor(() => {
    expect(container.querySelectorAll('.git-cmd').length).toBeGreaterThan(0)
  })
  return Array.from(container.querySelectorAll('.git-cmd')).map(c => c.textContent?.trim() ?? '')
}

describe('GitModal', () => {
  beforeEach(() => {
    mockBookmarks.mockReset()
    mockRemotes.mockReset()
  })

  describe('buildOps via rendered output', () => {
    it('no bookmarks, single remote → shows general push ops + fetch for that remote', async () => {
      mockBookmarks.mockResolvedValue([])
      mockRemotes.mockResolvedValue(['origin'])
      const { container } = render(GitModal, { props: defaultProps() })

      const cmds = await waitForCmds(container)
      expect(cmds).toContain('git push --remote origin')
      expect(cmds).toContain('git fetch --remote origin')
      expect(cmds).not.toContain('git fetch --all-remotes')
    })

    it('local bookmark → shows per-bookmark push op', async () => {
      mockBookmarks.mockResolvedValue([
        makeBookmark({ name: 'feat', local: { remote: 'origin', commit_id: 'aaa', tracked: true } }),
      ])
      mockRemotes.mockResolvedValue(['origin'])
      const { container } = render(GitModal, { props: defaultProps() })

      const cmds = await waitForCmds(container)
      expect(cmds).toContain('git push --bookmark feat --remote origin')
    })

    it('non-local bookmark → no per-bookmark push', async () => {
      mockBookmarks.mockResolvedValue([
        makeBookmark({ name: 'feat', local: undefined }),
      ])
      mockRemotes.mockResolvedValue(['origin'])
      const { container } = render(GitModal, { props: defaultProps() })

      const cmds = await waitForCmds(container)
      expect(cmds.every(c => !c.includes('--bookmark feat'))).toBe(true)
    })

    it('with changeId → shows --change push op', async () => {
      mockBookmarks.mockResolvedValue([])
      mockRemotes.mockResolvedValue(['origin'])
      const { container } = render(GitModal, { props: defaultProps({ currentChangeId: 'abcdefghijklmnop' }) })

      const cmds = await waitForCmds(container)
      expect(cmds).toContain('git push --change abcdefgh --remote origin')
    })

    it('without changeId → no --change push op', async () => {
      mockBookmarks.mockResolvedValue([])
      mockRemotes.mockResolvedValue(['origin'])
      const { container } = render(GitModal, { props: defaultProps({ currentChangeId: null }) })

      const cmds = await waitForCmds(container)
      expect(cmds.every(c => !c.includes('--change'))).toBe(true)
    })

    it('multiple remotes → shows fetch --all-remotes', async () => {
      mockBookmarks.mockResolvedValue([])
      mockRemotes.mockResolvedValue(['origin', 'upstream'])
      const { container } = render(GitModal, { props: defaultProps() })

      const cmds = await waitForCmds(container)
      expect(cmds).toContain('git fetch --all-remotes')
    })

    it('single remote → no fetch --all-remotes', async () => {
      mockBookmarks.mockResolvedValue([])
      mockRemotes.mockResolvedValue(['origin'])
      const { container } = render(GitModal, { props: defaultProps() })

      const cmds = await waitForCmds(container)
      expect(cmds).not.toContain('git fetch --all-remotes')
    })

    it('first remote used as default, not hardcoded origin', async () => {
      mockBookmarks.mockResolvedValue([])
      mockRemotes.mockResolvedValue(['github'])
      const { container } = render(GitModal, { props: defaultProps() })

      const cmds = await waitForCmds(container)
      expect(cmds).toContain('git push --remote github')
      expect(cmds).toContain('git fetch --remote github')
      expect(cmds.every(c => !c.includes('origin'))).toBe(true)
    })
  })

  describe('rendering states', () => {
    it('open=false → not rendered', () => {
      mockBookmarks.mockResolvedValue([])
      mockRemotes.mockResolvedValue([])

      const { container } = render(GitModal, { props: defaultProps({ open: false }) })
      expect(container.querySelector('.git-modal')).not.toBeInTheDocument()
    })

    it('loading state shows Loading...', () => {
      mockBookmarks.mockReturnValue(new Promise(() => {}))
      mockRemotes.mockReturnValue(new Promise(() => {}))

      const { container } = render(GitModal, { props: defaultProps() })
      expect(container.querySelector('.git-empty')?.textContent).toBe('Loading...')
    })

    it('error state shows error message', async () => {
      mockBookmarks.mockRejectedValue(new Error('Network error'))
      mockRemotes.mockRejectedValue(new Error('Network error'))

      const { container } = render(GitModal, { props: defaultProps() })

      await waitFor(() => {
        const empty = container.querySelector('.git-empty')
        expect(empty?.textContent).toBe('Network error')
      })
    })

    it('ops rendered with push/fetch CSS classes', async () => {
      mockBookmarks.mockResolvedValue([])
      mockRemotes.mockResolvedValue(['origin'])

      const { container } = render(GitModal, { props: defaultProps() })

      await waitFor(() => {
        expect(container.querySelectorAll('.git-cmd').length).toBeGreaterThan(0)
      })
      expect(container.querySelectorAll('.git-push').length).toBeGreaterThan(0)
      expect(container.querySelectorAll('.git-fetch').length).toBeGreaterThan(0)
    })
  })

  describe('keyboard navigation', () => {
    it('ArrowDown navigates down', async () => {
      mockBookmarks.mockResolvedValue([])
      mockRemotes.mockResolvedValue(['origin'])

      const { container } = render(GitModal, { props: defaultProps() })

      await waitFor(() => {
        expect(container.querySelectorAll('.git-item').length).toBeGreaterThan(1)
      })

      const modal = container.querySelector('.git-modal')!
      await fireEvent.keyDown(modal, { key: 'ArrowDown' })

      const items = container.querySelectorAll('.git-item')
      expect(items[1].classList.contains('git-item-active')).toBe(true)
    })

    it('ArrowUp navigates up', async () => {
      mockBookmarks.mockResolvedValue([])
      mockRemotes.mockResolvedValue(['origin'])

      const { container } = render(GitModal, { props: defaultProps() })

      await waitFor(() => {
        expect(container.querySelectorAll('.git-item').length).toBeGreaterThan(1)
      })

      const modal = container.querySelector('.git-modal')!
      await fireEvent.keyDown(modal, { key: 'ArrowDown' })
      await fireEvent.keyDown(modal, { key: 'ArrowDown' })
      await fireEvent.keyDown(modal, { key: 'ArrowUp' })

      const items = container.querySelectorAll('.git-item')
      expect(items[1].classList.contains('git-item-active')).toBe(true)
    })

    it('Enter executes selected op', async () => {
      const onexecute = vi.fn()
      mockBookmarks.mockResolvedValue([])
      mockRemotes.mockResolvedValue(['origin'])

      const { container } = render(GitModal, { props: defaultProps({ onexecute }) })

      await waitFor(() => {
        expect(container.querySelectorAll('.git-item').length).toBeGreaterThan(0)
      })

      const modal = container.querySelector('.git-modal')!
      await fireEvent.keyDown(modal, { key: 'Enter' })

      expect(onexecute).toHaveBeenCalledTimes(1)
      expect(onexecute.mock.calls[0][0]).toBe('push')
      expect(onexecute.mock.calls[0][1]).toEqual(['--remote', 'origin'])
    })

    it('Escape closes', async () => {
      const onclose = vi.fn()
      mockBookmarks.mockResolvedValue([])
      mockRemotes.mockResolvedValue(['origin'])

      const { container } = render(GitModal, { props: defaultProps({ onclose }) })

      await waitFor(() => {
        expect(container.querySelectorAll('.git-item').length).toBeGreaterThan(0)
      })

      const modal = container.querySelector('.git-modal')!
      await fireEvent.keyDown(modal, { key: 'Escape' })

      expect(onclose).toHaveBeenCalledTimes(1)
    })
  })
})
