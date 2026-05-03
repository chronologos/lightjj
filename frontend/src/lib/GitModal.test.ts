import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, fireEvent, waitFor } from '@testing-library/svelte'
import GitModal from './GitModal.svelte'

vi.mock('./api', async (importActual) => ({
  ...(await importActual<typeof import('./api')>()),
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
    synced: overrides.synced ?? false,
    commit_id: overrides.commit_id ?? 'aaa111',
  }
}

function defaultProps(overrides: Record<string, unknown> = {}) {
  return {
    open: true,
    currentChangeId: null as string | null,
    currentBookmarks: [] as string[],
    onexecute: vi.fn(),
    ...overrides,
  }
}

function localBm(name: string): Bookmark {
  return makeBookmark({ name, local: { remote: '.', commit_id: 'aaa', description: '', ago: '', tracked: false, ahead: 0, behind: 0 } })
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
    it('no bookmarks, single remote → general push ops + flagless fetch (respects git.fetch)', async () => {
      mockBookmarks.mockResolvedValue([])
      mockRemotes.mockResolvedValue(['origin'])
      const { container } = render(GitModal, { props: defaultProps() })

      const cmds = await waitForCmds(container)
      expect(cmds).toContain('git push --remote origin')
      // Flagless: jj applies git.fetch config (or origin default). Single-remote
      // = behaviorally identical to --remote origin, so no explicit entry.
      expect(cmds).toContain('git fetch')
      expect(cmds).not.toContain('git fetch --remote origin')
      expect(cmds).not.toContain('git fetch --all-remotes')
    })

    it('local bookmark → shows per-bookmark push op', async () => {
      mockBookmarks.mockResolvedValue([
        localBm('feat'),
      ])
      mockRemotes.mockResolvedValue(['origin'])
      const { container } = render(GitModal, { props: defaultProps() })

      const cmds = await waitForCmds(container)
      expect(cmds).toContain('git push --bookmark exact:feat --remote origin')
    })

    it('currentBookmarks → those push ops sort first, hotkey 1 fires it', async () => {
      const onexecute = vi.fn()
      mockBookmarks.mockResolvedValue([localBm('aaa'), localBm('bbb'), localBm('ccc')])
      mockRemotes.mockResolvedValue(['origin'])
      const { container } = render(GitModal, { props: defaultProps({ currentBookmarks: ['bbb'], onexecute }) })

      const cmds = await waitForCmds(container)
      const bmCmds = cmds.filter(c => c.includes('--bookmark'))
      expect(bmCmds[0]).toBe('git push --bookmark exact:bbb --remote origin')
      expect(bmCmds[1]).toBe('git push --bookmark exact:aaa --remote origin')
      expect(bmCmds[2]).toBe('git push --bookmark exact:ccc --remote origin')

      const here = container.querySelectorAll('.git-here')
      expect(here.length).toBe(1)
      expect(here[0].closest('.git-item')?.querySelector('.git-bm-badge')?.textContent).toContain('bbb')

      await fireEvent.keyDown(container.querySelector('.modal')!, { key: '1' })
      expect(onexecute).toHaveBeenCalledWith('push', ['--bookmark', 'exact:bbb', '--remote', 'origin'])
    })

    it('multiple currentBookmarks → api order preserved within here-group', async () => {
      mockBookmarks.mockResolvedValue([localBm('aaa'), localBm('bbb'), localBm('ccc')])
      mockRemotes.mockResolvedValue(['origin'])
      const { container } = render(GitModal, { props: defaultProps({ currentBookmarks: ['ccc', 'aaa'] }) })

      const cmds = await waitForCmds(container)
      const bmCmds = cmds.filter(c => c.includes('--bookmark'))
      expect(bmCmds).toEqual([
        'git push --bookmark exact:aaa --remote origin',
        'git push --bookmark exact:ccc --remote origin',
        'git push --bookmark exact:bbb --remote origin',
      ])
      expect(container.querySelectorAll('.git-here').length).toBe(2)
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
      // Raw command uses full changeId (what actually executes); short form is in the chip
      expect(cmds).toContain('git push --change abcdefghijklmnop --remote origin')
      expect(container.querySelector('.git-change-chip')?.textContent).toBe('abcdefgh')
    })

    it('without changeId → no --change push op', async () => {
      mockBookmarks.mockResolvedValue([])
      mockRemotes.mockResolvedValue(['origin'])
      const { container } = render(GitModal, { props: defaultProps({ currentChangeId: null }) })

      const cmds = await waitForCmds(container)
      expect(cmds.every(c => !c.includes('--change'))).toBe(true)
    })

    it('multiple remotes → flagless fetch + explicit-remote fetch + all-remotes', async () => {
      // Fork workflow: git.fetch=["upstream","origin"]. `f` (flagless) honors
      // it. Explicit entry covers "just this one" (pill selector scopes it).
      mockBookmarks.mockResolvedValue([])
      mockRemotes.mockResolvedValue(['origin', 'upstream'])
      const { container } = render(GitModal, { props: defaultProps() })

      const cmds = await waitForCmds(container)
      expect(cmds).toContain('git fetch')
      expect(cmds).toContain('git fetch --remote origin')
      expect(cmds).toContain('git fetch --all-remotes')
    })

    it('single remote → flagless fetch only (no explicit, no all-remotes)', async () => {
      mockBookmarks.mockResolvedValue([])
      mockRemotes.mockResolvedValue(['origin'])
      const { container } = render(GitModal, { props: defaultProps() })

      const cmds = await waitForCmds(container)
      const fetches = cmds.filter(c => c.startsWith('git fetch'))
      expect(fetches).toEqual(['git fetch'])
    })

    it('first remote used as default, not hardcoded origin', async () => {
      mockBookmarks.mockResolvedValue([])
      mockRemotes.mockResolvedValue(['github'])
      const { container } = render(GitModal, { props: defaultProps() })

      const cmds = await waitForCmds(container)
      expect(cmds).toContain('git push --remote github')
      expect(cmds.every(c => !c.includes('origin'))).toBe(true)
    })
  })

  describe('rendering states', () => {
    it('open=false → not rendered', () => {
      mockBookmarks.mockResolvedValue([])
      mockRemotes.mockResolvedValue([])

      const { container } = render(GitModal, { props: defaultProps({ open: false }) })
      expect(container.querySelector('.modal')).not.toBeInTheDocument()
    })

    it('loading state shows Loading...', async () => {
      mockBookmarks.mockReturnValue(new Promise(() => {}))
      mockRemotes.mockReturnValue(new Promise(() => {}))

      const { container } = render(GitModal, { props: defaultProps() })
      // createLoader defers loading=true via setTimeout(0)
      await new Promise(res => setTimeout(res, 0))
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
      expect(container.querySelectorAll('.is-push').length).toBeGreaterThan(0)
      expect(container.querySelectorAll('.is-fetch').length).toBeGreaterThan(0)
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

      const modal = container.querySelector('.modal')!
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

      const modal = container.querySelector('.modal')!
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

      const modal = container.querySelector('.modal')!
      await fireEvent.keyDown(modal, { key: 'Enter' })

      expect(onexecute).toHaveBeenCalledTimes(1)
      expect(onexecute.mock.calls[0][0]).toBe('push')
      expect(onexecute.mock.calls[0][1]).toEqual(['--remote', 'origin'])
    })

    it('hotkey fires op directly', async () => {
      const onexecute = vi.fn()
      mockBookmarks.mockResolvedValue([localBm('feat')])
      mockRemotes.mockResolvedValue(['origin'])

      const { container } = render(GitModal, { props: defaultProps({ onexecute }) })
      await waitFor(() => expect(container.querySelectorAll('.git-item').length).toBeGreaterThan(0))
      const modal = container.querySelector('.modal')!

      // '1' → first bookmark push
      await fireEvent.keyDown(modal, { key: '1' })
      expect(onexecute).toHaveBeenLastCalledWith('push', ['--bookmark', 'exact:feat', '--remote', 'origin'])
    })

    it('scope hotkeys (a/d/f) fire matching ops', async () => {
      const onexecute = vi.fn()
      mockBookmarks.mockResolvedValue([])
      mockRemotes.mockResolvedValue(['origin'])

      const { container } = render(GitModal, { props: defaultProps({ onexecute }) })
      await waitFor(() => expect(container.querySelectorAll('.git-item').length).toBeGreaterThan(0))
      const modal = container.querySelector('.modal')!

      await fireEvent.keyDown(modal, { key: 'a' })
      expect(onexecute).toHaveBeenLastCalledWith('push', ['--all', '--remote', 'origin'])
    })

    it('modifier keys bypass hotkey dispatch', async () => {
      const onexecute = vi.fn()
      mockBookmarks.mockResolvedValue([])
      mockRemotes.mockResolvedValue(['origin'])

      const { container } = render(GitModal, { props: defaultProps({ onexecute }) })
      await waitFor(() => expect(container.querySelectorAll('.git-item').length).toBeGreaterThan(0))
      const modal = container.querySelector('.modal')!

      await fireEvent.keyDown(modal, { key: 'a', metaKey: true })
      expect(onexecute).not.toHaveBeenCalled()
    })

    it('Escape closes', async () => {
      mockBookmarks.mockResolvedValue([])
      mockRemotes.mockResolvedValue(['origin'])

      const { container } = render(GitModal, { props: defaultProps() })

      await waitFor(() => {
        expect(container.querySelectorAll('.git-item').length).toBeGreaterThan(0)
      })

      const modal = container.querySelector('.modal')!
      await fireEvent.keyDown(modal, { key: 'Escape' })

      expect(container.querySelector('.modal')).toBeNull()
    })
  })
})
