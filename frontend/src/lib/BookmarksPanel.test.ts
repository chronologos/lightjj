import { describe, it, expect, vi } from 'vitest'
import { render, fireEvent } from '@testing-library/svelte'
import BookmarksPanel from './BookmarksPanel.svelte'
import type { Bookmark, BookmarkRemote, PullRequest, RemoteVisibility } from './api'

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
    remoteVisibility: { origin: { visible: false } } as RemoteVisibility,
    prByBookmark: new Map<string, PullRequest>(),
    onjump: vi.fn(),
    onexecute: vi.fn(),
    onrefresh: vi.fn(),
    onclose: vi.fn(),
    onvisibilitychange: vi.fn(),
    ...overrides,
  }
}

function list(): HTMLElement {
  return document.querySelector('.bp-list') as HTMLElement
}
/** Returns bookmark rows (not group headers) */
function rows(): NodeListOf<HTMLElement> {
  return document.querySelectorAll('.bp-row')
}
/** Returns the name of the active bookmark row, or '' if a group header is active */
function activeName(): string {
  return document.querySelector('.bp-row-active .bp-name')?.textContent?.trim() ?? ''
}
function footer(): string {
  return document.querySelector('.bp-footer')?.textContent ?? ''
}

describe('BookmarksPanel — sort', () => {
  it('trouble-first: conflict → diverged → ahead → behind → local → remote → synced; alpha within tier', () => {
    // All bookmarks have local refs so they appear in the LOCAL group (expanded by default).
    // Bookmarks with remotes also appear in the ORIGIN group (auto-expanded via allRemotes effect).
    // We test local-group sorting here by filtering to only LOCAL group rows (remote === '.').
    const bookmarks = [
      mkBm({ name: 'zz-synced', local: mkLocal(), remotes: [mkRemote()], synced: true }),
      mkBm({ name: 'aa-local', local: mkLocal() }),
      mkBm({ name: 'conflict', conflict: true, added_targets: ['a', 'b'], commit_id: '', local: mkLocal() }),
      mkBm({ name: 'bb-ahead', local: mkLocal(), remotes: [mkRemote({ behind: 2 })] }),
      mkBm({ name: 'cc-behind', local: mkLocal(), remotes: [mkRemote({ ahead: 3 })] }),
      mkBm({ name: 'diverged', local: mkLocal(), remotes: [mkRemote({ ahead: 1, behind: 1 })] }),
    ]
    render(BookmarksPanel, { props: props({ bookmarks }) })
    // rows() returns all .bp-row elements across all groups; filter to LOCAL group rows
    // by finding rows before the first .bp-group-row that follows the LOCAL header.
    // Simpler: LOCAL group rows come before the ORIGIN group header in DOM order.
    const allRows = Array.from(document.querySelectorAll('.bp-row, .bp-group-row'))
    const originHeaderIdx = allRows.findIndex(el => el.classList.contains('bp-group-row') && el.textContent?.includes('ORIGIN'))
    const localRowEls = allRows.slice(0, originHeaderIdx).filter(el => el.classList.contains('bp-row'))
    const names = localRowEls.map(r => r.querySelector('.bp-name')?.textContent?.trim())
    expect(names).toEqual(['conflict', 'diverged', 'bb-ahead', 'cc-behind', 'aa-local', 'zz-synced'])
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
    // index 0 = LOCAL group header (no .bp-name)
    // index 1 = alpha, 2 = beta, 3 = gamma
    // Then index 4 = ORIGIN group header (collapsed, no bookmarks under it)
    // j to move to first bookmark
    await fireEvent.keyDown(list(), { key: 'j' })
    expect(activeName()).toBe('alpha')
    await fireEvent.keyDown(list(), { key: 'j' })
    expect(activeName()).toBe('beta')
    await fireEvent.keyDown(list(), { key: 'j' })
    expect(activeName()).toBe('gamma')
    // j past gamma → ORIGIN group header
    await fireEvent.keyDown(list(), { key: 'j' })
    await fireEvent.keyDown(list(), { key: 'j' }) // clamp at end
    expect(activeName()).toBe('') // group header, no .bp-name
    // k back to gamma
    await fireEvent.keyDown(list(), { key: 'k' })
    expect(activeName()).toBe('gamma')
    await fireEvent.keyDown(list(), { key: 'k' })
    expect(activeName()).toBe('beta')
    await fireEvent.keyDown(list(), { key: 'k' })
    expect(activeName()).toBe('alpha')
    await fireEvent.keyDown(list(), { key: 'k' })
    // At LOCAL group header
    await fireEvent.keyDown(list(), { key: 'k' }) // clamp
    expect(activeName()).toBe('') // LOCAL group header
  })

  it('Enter calls onjump with selected bookmark', async () => {
    const onjump = vi.fn()
    render(BookmarksPanel, { props: props({ bookmarks: three, onjump }) })
    // Navigate past group header to first bookmark, then to second
    await fireEvent.keyDown(list(), { key: 'j' }) // alpha
    await fireEvent.keyDown(list(), { key: 'j' }) // beta
    await fireEvent.keyDown(list(), { key: 'Enter' })
    // Second arg is jumpTarget (scoped remote's commit_id for remote-group
    // rows); undefined for LOCAL group rows → jumpToBookmark uses bm.commit_id.
    expect(onjump).toHaveBeenCalledWith(expect.objectContaining({ name: 'beta' }), undefined)
  })

  it('Enter toggles group expand/collapse on group row', async () => {
    render(BookmarksPanel, { props: props({ bookmarks: three }) })
    // index 0 = LOCAL group header (expanded)
    expect(rows().length).toBe(3) // 3 bookmarks visible
    await fireEvent.keyDown(list(), { key: 'Enter' }) // collapse LOCAL
    expect(rows().length).toBe(0) // bookmarks hidden
    await fireEvent.keyDown(list(), { key: 'Enter' }) // expand LOCAL
    expect(rows().length).toBe(3) // bookmarks back
  })

  it('Enter is no-op on conflict (no commit_id)', async () => {
    const onjump = vi.fn()
    const bms = [mkBm({ name: 'broken', conflict: true, commit_id: '', local: mkLocal() })]
    render(BookmarksPanel, { props: props({ bookmarks: bms, onjump }) })
    await fireEvent.keyDown(list(), { key: 'j' }) // move to bookmark row
    await fireEvent.keyDown(list(), { key: 'Enter' })
    expect(onjump).not.toHaveBeenCalled()
  })

  it('Escape: tiered (disarm → clear filter → close)', async () => {
    const onclose = vi.fn()
    render(BookmarksPanel, { props: props({ bookmarks: [mkBm({ name: 'a', local: mkLocal() })], onclose }) })

    // Move to bookmark row first
    await fireEvent.keyDown(list(), { key: 'j' })

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
    await fireEvent.keyDown(list(), { key: 'j' }) // move to bookmark
    await fireEvent.keyDown(list(), { key: 'd' })
    expect(onexecute).not.toHaveBeenCalled()
    expect(footer()).toContain('again to delete')
    await fireEvent.keyDown(list(), { key: 'd' })
    expect(onexecute).toHaveBeenCalledWith({ action: 'delete', bookmark: 'feat' })
  })

  it('d is gated on local ref', async () => {
    const onexecute = vi.fn()
    const remoteOnly = [mkBm({ name: 'feat', remotes: [mkRemote({ tracked: false })] })]
    render(BookmarksPanel, { props: props({ bookmarks: remoteOnly }) })
    // Remote-only bookmark is NOT in LOCAL group (no local ref).
    // It's in ORIGIN group which is collapsed by default.
    // So d on group header should be no-op.
    await fireEvent.keyDown(list(), { key: 'd' })
    await fireEvent.keyDown(list(), { key: 'd' })
    expect(onexecute).not.toHaveBeenCalled()
  })

  it('d on delete-staged (remote-only TRACKED) → push-delete, not delete', async () => {
    // No local ref + tracked remote = jj already knows it's deleted locally;
    // `d` pushes the deletion rather than running `jj bookmark delete` (which
    // would no-op: already no local ref).
    // This is the skzqozmm commit's new code path; untested until now.
    const onexecute = vi.fn()
    const deleteStaged = [mkBm({ name: 'old-feat', remotes: [mkRemote({ tracked: true })], commit_id: '' })]
    render(BookmarksPanel, { props: props({ bookmarks: deleteStaged, onexecute }) })
    // panelRows: LOCAL header (0, empty), ORIGIN header (1, auto-expanded),
    // old-feat (2 — the target).
    await fireEvent.keyDown(list(), { key: 'j' })
    await fireEvent.keyDown(list(), { key: 'j' })
    await fireEvent.keyDown(list(), { key: 'd' })
    expect(footer()).toContain('again')  // still double-press — destructive
    await fireEvent.keyDown(list(), { key: 'd' })
    expect(onexecute).toHaveBeenCalledWith({ action: 'push-delete', bookmark: 'old-feat', remote: 'origin' })
  })

  it('d on delete-staged with multiple tracked remotes → pushes [0] (single-remote jj constraint)', async () => {
    // jj git push is single-remote. computeActions puts the default remote at [0]
    // (backend sorts bm.remotes). User presses `d` again for the rest — not batched.
    const onexecute = vi.fn()
    const deleteStaged = [mkBm({
      name: 'old',
      remotes: [mkRemote({ remote: 'origin', tracked: true }), mkRemote({ remote: 'upstream', tracked: true })],
      commit_id: '',
    })]
    render(BookmarksPanel, { props: props({
      bookmarks: deleteStaged, onexecute,
      allRemotes: ['origin', 'upstream'],
    }) })
    // Navigate to the bookmark row under ORIGIN (index varies — two groups).
    // panelRows: LOCAL(0,empty), ORIGIN(1), old(2), UPSTREAM(3), old(4).
    await fireEvent.keyDown(list(), { key: 'j' })
    await fireEvent.keyDown(list(), { key: 'j' })
    await fireEvent.keyDown(list(), { key: 'd' })
    await fireEvent.keyDown(list(), { key: 'd' })
    expect(onexecute).toHaveBeenCalledWith({ action: 'push-delete', bookmark: 'old', remote: 'origin' })
  })

  it('d on untracked remote-only is gated off (pushDelete empty)', async () => {
    // Untracked remote-only: pushing `-b <name>` would implicitly TRACK it,
    // not delete. computeActions filters to tracked-only for pushDelete.
    const onexecute = vi.fn()
    const untracked = [mkBm({ name: 'foreign', remotes: [mkRemote({ tracked: false })], commit_id: '' })]
    render(BookmarksPanel, { props: props({ bookmarks: untracked, onexecute }) })
    await fireEvent.keyDown(list(), { key: 'j' })  // ORIGIN header
    await fireEvent.keyDown(list(), { key: 'j' })  // foreign row
    await fireEvent.keyDown(list(), { key: 'd' })
    await fireEvent.keyDown(list(), { key: 'd' })
    expect(onexecute).not.toHaveBeenCalled()
  })

  it('f double-press forgets (any bookmark selection)', async () => {
    const onexecute = vi.fn()
    // Need a bookmark with local so it shows in expanded LOCAL group
    const bms = [mkBm({ name: 'feat', local: mkLocal(), remotes: [mkRemote({ tracked: false })] })]
    render(BookmarksPanel, { props: props({ bookmarks: bms, onexecute }) })
    await fireEvent.keyDown(list(), { key: 'j' }) // move to bookmark
    await fireEvent.keyDown(list(), { key: 'f' })
    await fireEvent.keyDown(list(), { key: 'f' })
    expect(onexecute).toHaveBeenCalledWith({ action: 'forget', bookmark: 'feat' })
  })

  it('t tracks on single press (non-destructive)', async () => {
    const onexecute = vi.fn()
    render(BookmarksPanel, { props: props({ bookmarks: withLocal, onexecute }) })
    await fireEvent.keyDown(list(), { key: 'j' }) // move to bookmark
    await fireEvent.keyDown(list(), { key: 't' })
    expect(onexecute).toHaveBeenCalledWith({ action: 'track', bookmark: 'feat', remote: 'origin' })
  })

  it('t untracks on double press (destructive)', async () => {
    const onexecute = vi.fn()
    const tracked = [mkBm({ name: 'feat', local: mkLocal(), remotes: [mkRemote({ tracked: true })] })]
    render(BookmarksPanel, { props: props({ bookmarks: tracked, onexecute }) })
    await fireEvent.keyDown(list(), { key: 'j' }) // move to bookmark
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
    await fireEvent.keyDown(list(), { key: 'j' }) // move to bookmark
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
    await fireEvent.keyDown(list(), { key: 'j' }) // move to bookmark 'a'
    await fireEvent.keyDown(list(), { key: 'd' })
    expect(footer()).toContain('again to delete')
    await fireEvent.keyDown(list(), { key: 'j' }) // move to 'b'
    expect(footer()).not.toContain('again')
    await fireEvent.keyDown(list(), { key: 'd' }) // re-arms for 'b'
    expect(onexecute).not.toHaveBeenCalled()
  })

  it('r refreshes', async () => {
    const onrefresh = vi.fn()
    render(BookmarksPanel, { props: props({ bookmarks: withLocal, onrefresh }) })
    await fireEvent.keyDown(list(), { key: 'j' }) // move to bookmark
    await fireEvent.keyDown(list(), { key: 'r' })
    expect(onrefresh).toHaveBeenCalledTimes(1)
  })

  it('r refreshes from group row too', async () => {
    const onrefresh = vi.fn()
    render(BookmarksPanel, { props: props({ bookmarks: withLocal, onrefresh }) })
    // index 0 = group header
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
    expect(activeName()).toBe('') // index reset to 0 = group header
  })
})

describe('BookmarksPanel — defaultPrevented contract (App.svelte gate relies on this)', () => {
  // App.svelte's window keydown checks e.defaultPrevented to skip panel-owned
  // keys. If the panel ever stops calling preventDefault on d/f/t/r/j/k,
  // they'd fall through to global handlers (t → toggleTheme).
  const bms = [mkBm({ name: 'a', local: mkLocal() })]

  it.each(['j', 'k', 'd', 'f', 't', 'r', '/', 'Enter', 'Escape', 'e'])('%s sets defaultPrevented', async (key) => {
    render(BookmarksPanel, { props: props({ bookmarks: bms }) })
    // Move to bookmark first for d/f/t to be meaningful
    if (['d', 'f', 't'].includes(key)) {
      await fireEvent.keyDown(list(), { key: 'j' })
    }
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
    // index 0 = LOCAL group header. Navigate to first bookmark.
    await fireEvent.keyDown(list(), { key: 'j' })
    // Sort: mover (ahead) before stable (synced). First bookmark = mover.
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
    render(BookmarksPanel, { props: props({ loading: true, bookmarks: [mkBm({ name: 'stale', local: mkLocal() })] }) })
    expect(rows().length).toBe(1)
    expect(document.querySelector('.bp-empty')).toBeNull()
  })

  it('shows error', () => {
    render(BookmarksPanel, { props: props({ error: 'boom' }) })
    expect(document.querySelector('.bp-error')?.textContent).toBe('boom')
  })
})

describe('BookmarksPanel — eye visibility toggle', () => {
  it('e on remote group header toggles visibility', async () => {
    const onvisibilitychange = vi.fn()
    const bms = [mkBm({ name: 'feat', local: mkLocal(), remotes: [mkRemote()] })]
    render(BookmarksPanel, { props: props({
      bookmarks: bms,
      remoteVisibility: { origin: { visible: false } },
      onvisibilitychange,
    }) })
    // panelRows layout (ORIGIN auto-expanded via allRemotes effect):
    //   0: LOCAL group header
    //   1: feat (LOCAL bookmark)
    //   2: ORIGIN group header  ← target
    //   3: feat (ORIGIN bookmark)
    await fireEvent.keyDown(list(), { key: 'j' }) // index 0→1: feat (LOCAL)
    await fireEvent.keyDown(list(), { key: 'j' }) // index 1→2: ORIGIN group header
    await fireEvent.keyDown(list(), { key: 'e' })
    expect(onvisibilitychange).toHaveBeenCalledTimes(1)
    const vis = onvisibilitychange.mock.calls[0][0]
    expect(vis.origin.visible).toBe(true)
  })

  it('e on remote bookmark row hides bookmark in origin.hidden', async () => {
    const onvisibilitychange = vi.fn()
    const bms = [mkBm({ name: 'feat', remotes: [mkRemote({ tracked: false })] })]
    render(BookmarksPanel, { props: props({
      bookmarks: bms,
      remoteVisibility: { origin: { visible: true, hidden: [] } },
      onvisibilitychange,
    }) })
    // panelRows layout (ORIGIN auto-expanded via allRemotes effect):
    //   0: LOCAL group header (no bookmarks — this bm has no local ref)
    //   1: ORIGIN group header (auto-expanded)
    //   2: feat (ORIGIN bookmark)  ← target
    await fireEvent.keyDown(list(), { key: 'j' }) // index 0→1: ORIGIN group header
    await fireEvent.keyDown(list(), { key: 'j' }) // index 1→2: 'feat' bookmark row under ORIGIN
    await fireEvent.keyDown(list(), { key: 'e' })
    expect(onvisibilitychange).toHaveBeenCalledTimes(1)
    const vis = onvisibilitychange.mock.calls[0][0]
    expect(vis.origin.hidden).toContain('feat')
  })

  it('e on LOCAL group header is no-op (no visibility toggle)', async () => {
    const onvisibilitychange = vi.fn()
    const bms = [mkBm({ name: 'feat', local: mkLocal() })]
    render(BookmarksPanel, { props: props({
      bookmarks: bms,
      onvisibilitychange,
    }) })
    // index 0 = LOCAL group header
    await fireEvent.keyDown(list(), { key: 'e' })
    expect(onvisibilitychange).not.toHaveBeenCalled()
  })

  it('e on bookmark row when remote is HIDDEN → auto-enable with hidden=[others]', async () => {
    // toggleBookmarkVisibility case 1: flip on JUST this bookmark without
    // flooding the log. Remote was off; now on with every OTHER bookmark
    // on this remote in the hidden list. The original design required
    // enabling the whole remote first, then hiding N-1 — two clicks + flood.
    const onvisibilitychange = vi.fn()
    const bms = [
      mkBm({ name: 'want', remotes: [mkRemote()] }),
      mkBm({ name: 'noise-a', remotes: [mkRemote()] }),
      mkBm({ name: 'noise-b', remotes: [mkRemote()] }),
    ]
    render(BookmarksPanel, { props: props({
      bookmarks: bms,
      remoteVisibility: { origin: { visible: false } },  // remote hidden
      onvisibilitychange,
    }) })
    // panelRows: LOCAL(0,empty), ORIGIN(1,auto-expanded), noise-a(2), noise-b(3), want(4).
    // Remote-group rows sort alphabetically. Navigate to 'want'.
    await fireEvent.keyDown(list(), { key: 'j' })  // → ORIGIN header
    await fireEvent.keyDown(list(), { key: 'j' })  // → noise-a
    await fireEvent.keyDown(list(), { key: 'j' })  // → noise-b
    await fireEvent.keyDown(list(), { key: 'j' })  // → want
    await fireEvent.keyDown(list(), { key: 'e' })
    const vis = onvisibilitychange.mock.calls[0][0]
    expect(vis.origin.visible).toBe(true)
    // Set equality — order is implementation detail (bookmarks[] iteration),
    // not part of the contract (jj revset is order-independent).
    expect(new Set(vis.origin.hidden)).toEqual(new Set(['noise-a', 'noise-b']))
    expect(vis.origin.hidden).toHaveLength(2)  // no duplicates
  })

  it('e on group header OFF→ON clears hidden (big toggle = show all)', async () => {
    // toggleGroupVisibility: the intent of the GROUP eye is "show all of this
    // remote". Preserving a per-bookmark hidden list through an off→on cycle
    // would leave the user wondering why half the bookmarks still don't appear.
    const onvisibilitychange = vi.fn()
    const bms = [mkBm({ name: 'feat', remotes: [mkRemote()] })]
    render(BookmarksPanel, { props: props({
      bookmarks: bms,
      remoteVisibility: { origin: { visible: false, hidden: ['a', 'b', 'c'] } },
      onvisibilitychange,
    }) })
    // LOCAL(0,empty), ORIGIN(1) ← target
    await fireEvent.keyDown(list(), { key: 'j' })
    await fireEvent.keyDown(list(), { key: 'e' })
    const vis = onvisibilitychange.mock.calls[0][0]
    expect(vis.origin).toEqual({ visible: true, hidden: [] })
  })

  it('e on group header ON→OFF preserves hidden (re-enable remembers selection)', async () => {
    // Counterpart: turning OFF does NOT clear — so the next ON cycle can
    // restore per-bookmark state (but only if toggled at the bookmark level,
    // not group level — see the OFF→ON test above which DOES clear).
    const onvisibilitychange = vi.fn()
    const bms = [mkBm({ name: 'feat', remotes: [mkRemote()] })]
    render(BookmarksPanel, { props: props({
      bookmarks: bms,
      remoteVisibility: { origin: { visible: true, hidden: ['a', 'b'] } },
      onvisibilitychange,
    }) })
    await fireEvent.keyDown(list(), { key: 'j' })  // ORIGIN header
    await fireEvent.keyDown(list(), { key: 'e' })
    const vis = onvisibilitychange.mock.calls[0][0]
    expect(vis.origin).toEqual({ visible: false, hidden: ['a', 'b'] })
  })
})

// --- Per-remote row scoping invariant: display and action must agree ---
describe('BookmarksPanel — scoped remote-group rows', () => {
  it('remote-group row jump uses scoped remote commit_id, not bm.commit_id', async () => {
    // bm.commit_id = local commit; but the UPSTREAM row shows upstream's
    // commit_id. Click/Enter must jump to what's DISPLAYED, not the bookmark's
    // "primary" commit. Without jumpTarget, clicking the upstream row jumped
    // to the local commit — confusing and wrong.
    const onjump = vi.fn()
    const bms = [mkBm({
      name: 'main', local: mkLocal(), commit_id: 'local-abc',
      remotes: [mkRemote({ remote: 'upstream', commit_id: 'upstream-xyz', tracked: true })],
    })]
    render(BookmarksPanel, { props: props({
      bookmarks: bms, allRemotes: ['upstream'],
      remoteVisibility: { upstream: { visible: false } },
      onjump,
    }) })
    // panelRows: LOCAL(0), main-local(1), UPSTREAM(2), main-upstream(3 ← target)
    await fireEvent.keyDown(list(), { key: 'j' })
    await fireEvent.keyDown(list(), { key: 'j' })
    await fireEvent.keyDown(list(), { key: 'j' })
    await fireEvent.keyDown(list(), { key: 'Enter' })
    // Second arg = jumpTarget = scoped remote's commit_id
    expect(onjump).toHaveBeenCalledWith(expect.objectContaining({ name: 'main' }), 'upstream-xyz')
  })

  it('LOCAL-group row jump passes undefined jumpTarget (bm.commit_id default)', async () => {
    // LOCAL rows have no jumpTarget — App's jumpToBookmark falls back to
    // bm.commit_id. This asserts the existing contract (already tested by
    // 'Enter calls onjump' but not explicitly about the undefined arg).
    const onjump = vi.fn()
    const bms = [mkBm({ name: 'feat', local: mkLocal(), commit_id: 'local-abc' })]
    render(BookmarksPanel, { props: props({ bookmarks: bms, onjump }) })
    await fireEvent.keyDown(list(), { key: 'j' })
    await fireEvent.keyDown(list(), { key: 'Enter' })
    expect(onjump).toHaveBeenCalledWith(expect.objectContaining({ name: 'feat' }), undefined)
  })
})
