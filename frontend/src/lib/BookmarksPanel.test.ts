import { describe, it, expect, vi } from 'vitest'
import { render, fireEvent } from '@testing-library/svelte'
import BookmarksPanel from './BookmarksPanel.svelte'
import type { Bookmark, BookmarkRemote, PullRequest } from './api'

const mkRemote = (over: Partial<BookmarkRemote> = {}): BookmarkRemote => ({
  remote: 'origin', commit_id: 'abc', description: 'test commit', ago: '2 days ago', tracked: true, ahead: 0, behind: 0, ...over,
})
const mkLocal = (): BookmarkRemote => mkRemote({ remote: '.', tracked: false })

const mkBm = (over: Partial<Bookmark> = {}): Bookmark => ({
  name: 'feat', conflict: false, synced: false, commit_id: 'abc12345', ...over,
})

function props(overrides: Record<string, unknown> = {}) {
  return {
    bookmarks: [] as Bookmark[],
    loading: false,
    error: '',
    defaultRemote: 'origin',
    allRemotes: ['origin'],
    prByBookmark: new Map<string, PullRequest>(),
    onjump: vi.fn(),
    onexecute: vi.fn(),
    onrefresh: vi.fn(),
    onclose: vi.fn(),
    ...overrides,
  }
}

function list(): HTMLElement {
  return document.querySelector('.bp-list') as HTMLElement
}
function rows(): NodeListOf<HTMLElement> {
  return document.querySelectorAll('.bp-row')
}
function activeName(): string {
  return document.querySelector('.bp-row-active .bp-name')?.textContent?.trim() ?? ''
}
function footer(): string {
  return document.querySelector('.bp-footer')?.textContent ?? ''
}

describe('BookmarksPanel — sort', () => {
  it('trouble-first: conflict → diverged → ahead → behind → local → remote → synced; alpha within tier', () => {
    const bookmarks = [
      mkBm({ name: 'zz-synced', local: mkLocal(), remotes: [mkRemote()], synced: true }),
      mkBm({ name: 'aa-local', local: mkLocal() }),
      mkBm({ name: 'conflict', conflict: true, added_targets: ['a', 'b'], commit_id: '' }),
      mkBm({ name: 'bb-ahead', local: mkLocal(), remotes: [mkRemote({ behind: 2 })] }),
      mkBm({ name: 'cc-behind', local: mkLocal(), remotes: [mkRemote({ ahead: 3 })] }),
      mkBm({ name: 'remote', remotes: [mkRemote({ tracked: false })] }),
      mkBm({ name: 'diverged', local: mkLocal(), remotes: [mkRemote({ ahead: 1, behind: 1 })] }),
    ]
    render(BookmarksPanel, { props: props({ bookmarks }) })
    const names = Array.from(rows()).map(r => r.querySelector('.bp-name')?.textContent?.trim())
    expect(names).toEqual(['conflict', 'diverged', 'bb-ahead', 'cc-behind', 'aa-local', 'remote', 'zz-synced'])
  })
})

describe('BookmarksPanel — navigation', () => {
  const three = [
    mkBm({ name: 'alpha', local: mkLocal() }),
    mkBm({ name: 'beta', local: mkLocal() }),
    mkBm({ name: 'gamma', local: mkLocal() }),
  ]

  it('j/k navigate, clamp at ends', async () => {
    render(BookmarksPanel, { props: props({ bookmarks: three }) })
    expect(activeName()).toBe('alpha')
    await fireEvent.keyDown(list(), { key: 'j' })
    expect(activeName()).toBe('beta')
    await fireEvent.keyDown(list(), { key: 'j' })
    await fireEvent.keyDown(list(), { key: 'j' }) // clamp
    expect(activeName()).toBe('gamma')
    await fireEvent.keyDown(list(), { key: 'k' })
    await fireEvent.keyDown(list(), { key: 'k' })
    await fireEvent.keyDown(list(), { key: 'k' }) // clamp
    expect(activeName()).toBe('alpha')
  })

  it('Enter calls onjump with selected bookmark', async () => {
    const onjump = vi.fn()
    render(BookmarksPanel, { props: props({ bookmarks: three, onjump }) })
    await fireEvent.keyDown(list(), { key: 'j' })
    await fireEvent.keyDown(list(), { key: 'Enter' })
    expect(onjump).toHaveBeenCalledWith(expect.objectContaining({ name: 'beta' }))
  })

  it('Enter is no-op on conflict (no commit_id)', async () => {
    const onjump = vi.fn()
    const bms = [mkBm({ name: 'broken', conflict: true, commit_id: '' })]
    render(BookmarksPanel, { props: props({ bookmarks: bms, onjump }) })
    await fireEvent.keyDown(list(), { key: 'Enter' })
    expect(onjump).not.toHaveBeenCalled()
  })

  it('Escape: tiered (disarm → clear filter → close)', async () => {
    const onclose = vi.fn()
    render(BookmarksPanel, { props: props({ bookmarks: [mkBm({ name: 'a', local: mkLocal() })], onclose }) })

    // Arm, then Escape disarms (no close)
    await fireEvent.keyDown(list(), { key: 'd' })
    expect(footer()).toContain('again to delete')
    await fireEvent.keyDown(list(), { key: 'Escape' })
    expect(footer()).not.toContain('again')
    expect(onclose).not.toHaveBeenCalled()

    // Escape with no arm, no filter → close
    await fireEvent.keyDown(list(), { key: 'Escape' })
    expect(onclose).toHaveBeenCalledTimes(1)
  })
})

describe('BookmarksPanel — actions', () => {
  const withLocal = [mkBm({ name: 'feat', local: mkLocal() })]

  it('d double-press deletes', async () => {
    const onexecute = vi.fn()
    render(BookmarksPanel, { props: props({ bookmarks: withLocal, onexecute }) })
    await fireEvent.keyDown(list(), { key: 'd' })
    expect(onexecute).not.toHaveBeenCalled()
    expect(footer()).toContain('again to delete')
    await fireEvent.keyDown(list(), { key: 'd' })
    expect(onexecute).toHaveBeenCalledWith({ action: 'delete', bookmark: 'feat' })
  })

  it('d is gated on local ref', async () => {
    const onexecute = vi.fn()
    const remoteOnly = [mkBm({ name: 'feat', remotes: [mkRemote({ tracked: false })] })]
    render(BookmarksPanel, { props: props({ bookmarks: remoteOnly, onexecute }) })
    await fireEvent.keyDown(list(), { key: 'd' })
    await fireEvent.keyDown(list(), { key: 'd' })
    expect(onexecute).not.toHaveBeenCalled()
  })

  it('f double-press forgets (any selection)', async () => {
    const onexecute = vi.fn()
    const remoteOnly = [mkBm({ name: 'feat', remotes: [mkRemote({ tracked: false })] })]
    render(BookmarksPanel, { props: props({ bookmarks: remoteOnly, onexecute }) })
    await fireEvent.keyDown(list(), { key: 'f' })
    await fireEvent.keyDown(list(), { key: 'f' })
    expect(onexecute).toHaveBeenCalledWith({ action: 'forget', bookmark: 'feat' })
  })

  it('t tracks on single press (non-destructive)', async () => {
    const onexecute = vi.fn()
    render(BookmarksPanel, { props: props({ bookmarks: withLocal, onexecute }) })
    await fireEvent.keyDown(list(), { key: 't' })
    expect(onexecute).toHaveBeenCalledWith({ action: 'track', bookmark: 'feat', remote: 'origin' })
  })

  it('t untracks on double press (destructive)', async () => {
    const onexecute = vi.fn()
    const tracked = [mkBm({ name: 'feat', local: mkLocal(), remotes: [mkRemote({ tracked: true })] })]
    render(BookmarksPanel, { props: props({ bookmarks: tracked, onexecute }) })
    await fireEvent.keyDown(list(), { key: 't' })
    expect(onexecute).not.toHaveBeenCalled()
    await fireEvent.keyDown(list(), { key: 't' })
    expect(onexecute).toHaveBeenCalledWith({ action: 'untrack', bookmark: 'feat', remote: 'origin' })
  })

  it('t with multiple remotes opens submenu instead of firing', async () => {
    const onexecute = vi.fn()
    const ontrackmenu = vi.fn()
    const bm = mkBm({ name: 'feat', local: mkLocal(), remotes: [mkRemote({ tracked: true })] })
    render(BookmarksPanel, { props: props({
      bookmarks: [bm], onexecute, ontrackmenu,
      allRemotes: ['origin', 'upstream'],
    }) })
    await fireEvent.keyDown(list(), { key: 't' })
    expect(onexecute).not.toHaveBeenCalled()
    expect(ontrackmenu).toHaveBeenCalledTimes(1)
    const [passedBm, opts] = ontrackmenu.mock.calls[0]
    expect(passedBm.name).toBe('feat')
    expect(opts).toEqual([
      { action: 'untrack', remote: 'origin' },
      { action: 'track', remote: 'upstream' },
    ])
  })

  it('nav disarms pending confirm', async () => {
    const onexecute = vi.fn()
    const two = [mkBm({ name: 'a', local: mkLocal() }), mkBm({ name: 'b', local: mkLocal() })]
    render(BookmarksPanel, { props: props({ bookmarks: two, onexecute }) })
    await fireEvent.keyDown(list(), { key: 'd' })
    expect(footer()).toContain('again to delete')
    await fireEvent.keyDown(list(), { key: 'j' })
    expect(footer()).not.toContain('again')
    await fireEvent.keyDown(list(), { key: 'd' }) // re-arms for 'b'
    expect(onexecute).not.toHaveBeenCalled()
  })

  it('r refreshes', async () => {
    const onrefresh = vi.fn()
    render(BookmarksPanel, { props: props({ bookmarks: withLocal, onrefresh }) })
    await fireEvent.keyDown(list(), { key: 'r' })
    expect(onrefresh).toHaveBeenCalledTimes(1)
  })
})

describe('BookmarksPanel — filter', () => {
  it('/ focuses input; fuzzy filter narrows rows; index resets', async () => {
    const bms = [mkBm({ name: 'main', local: mkLocal() }), mkBm({ name: 'feature-x', local: mkLocal() })]
    render(BookmarksPanel, { props: props({ bookmarks: bms }) })
    await fireEvent.keyDown(list(), { key: '/' })
    const input = document.querySelector('.bp-filter') as HTMLInputElement
    expect(document.activeElement).toBe(input)

    await fireEvent.input(input, { target: { value: 'ftx' } }) // fuzzy match feature-x
    expect(rows().length).toBe(1)
    expect(activeName()).toBe('feature-x')
  })
})

describe('BookmarksPanel — defaultPrevented contract (App.svelte gate relies on this)', () => {
  // App.svelte's window keydown checks e.defaultPrevented to skip panel-owned
  // keys. If the panel ever stops calling preventDefault on d/f/t/r/j/k,
  // they'd fall through to global handlers (t → toggleTheme).
  const bms = [mkBm({ name: 'a', local: mkLocal() })]

  it.each(['j', 'k', 'd', 'f', 't', 'r', '/', 'Enter', 'Escape'])('%s sets defaultPrevented', async (key) => {
    render(BookmarksPanel, { props: props({ bookmarks: bms }) })
    const ev = new KeyboardEvent('keydown', { key, cancelable: true, bubbles: true })
    list().dispatchEvent(ev)
    expect(ev.defaultPrevented).toBe(true)
  })

  it('unhandled key (u) does NOT set defaultPrevented → falls through to App globals', async () => {
    render(BookmarksPanel, { props: props({ bookmarks: bms }) })
    const ev = new KeyboardEvent('keydown', { key: 'u', cancelable: true, bubbles: true })
    list().dispatchEvent(ev)
    expect(ev.defaultPrevented).toBe(false)
  })
})

describe('BookmarksPanel — selection survives reload reorder', () => {
  it('tracks selected name across bookmarks prop update (sync state changed)', async () => {
    // Initial: 'stable' is synced (sorts last), 'mover' is ahead (sorts first)
    const initial = [
      mkBm({ name: 'stable', local: mkLocal(), remotes: [mkRemote()], synced: true }),
      mkBm({ name: 'mover', local: mkLocal(), remotes: [mkRemote({ behind: 1 })] }),
    ]
    const { rerender } = render(BookmarksPanel, { props: props({ bookmarks: initial }) })
    // Sort: mover (ahead) before stable (synced). Select mover (index 0, default).
    expect(activeName()).toBe('mover')
    // Reload: mover now synced → sorts after stable. Cursor should follow mover.
    const after = [
      mkBm({ name: 'stable', local: mkLocal(), remotes: [mkRemote()], synced: true }),
      mkBm({ name: 'mover', local: mkLocal(), remotes: [mkRemote()], synced: true }),
    ]
    await rerender(props({ bookmarks: after }))
    expect(activeName()).toBe('mover')
  })
})

describe('BookmarksPanel — empty/loading/error', () => {
  it('shows loading when loading and no data', () => {
    render(BookmarksPanel, { props: props({ loading: true }) })
    expect(document.querySelector('.bp-empty')?.textContent).toContain('Loading')
  })

  it('shows stale data while re-loading', () => {
    render(BookmarksPanel, { props: props({ loading: true, bookmarks: [mkBm({ name: 'stale' })] }) })
    expect(rows().length).toBe(1)
    expect(document.querySelector('.bp-empty')).toBeNull()
  })

  it('shows error', () => {
    render(BookmarksPanel, { props: props({ error: 'boom' }) })
    expect(document.querySelector('.bp-error')?.textContent).toBe('boom')
  })
})
