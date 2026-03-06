import { describe, it, expect } from 'vitest'
import { classifyBookmark, syncPriority, fmtCount, syncLabel } from './bookmark-sync'
import type { Bookmark, BookmarkRemote } from './api'

const mkRemote = (over: Partial<BookmarkRemote> = {}): BookmarkRemote => ({
  remote: 'origin', commit_id: 'abc', description: '', ago: '', tracked: true, ahead: 0, behind: 0, ...over,
})

const mkBm = (over: Partial<Bookmark> = {}): Bookmark => ({
  name: 'feat', conflict: false, synced: false, commit_id: 'abc', ...over,
})

describe('classifyBookmark', () => {
  it('synced: local + tracked remote, both zero', () => {
    const bm = mkBm({ local: mkRemote({ remote: '.' }), remotes: [mkRemote()], synced: true })
    expect(classifyBookmark(bm)).toEqual({ kind: 'synced' })
  })

  it('ahead: remote.behind > 0 (we have unpushed commits)', () => {
    const bm = mkBm({ local: mkRemote({ remote: '.' }), remotes: [mkRemote({ behind: 3 })] })
    expect(classifyBookmark(bm)).toEqual({ kind: 'ahead', by: 3 })
  })

  it('behind: remote.ahead > 0 (remote moved past us)', () => {
    const bm = mkBm({ local: mkRemote({ remote: '.' }), remotes: [mkRemote({ ahead: 5 })] })
    expect(classifyBookmark(bm)).toEqual({ kind: 'behind', by: 5 })
  })

  it('diverged: both nonzero', () => {
    const bm = mkBm({ local: mkRemote({ remote: '.' }), remotes: [mkRemote({ ahead: 7392, behind: 1 })] })
    expect(classifyBookmark(bm)).toEqual({ kind: 'diverged', ahead: 1, behind: 7392 })
  })

  it('local-only: local but no tracked remote', () => {
    const bm = mkBm({ local: mkRemote({ remote: '.' }) })
    expect(classifyBookmark(bm)).toEqual({ kind: 'local-only' })
  })

  it('local-only: remotes present but all untracked', () => {
    const bm = mkBm({ local: mkRemote({ remote: '.' }), remotes: [mkRemote({ tracked: false })] })
    expect(classifyBookmark(bm)).toEqual({ kind: 'local-only' })
  })

  it('remote-only untracked: no local, untracked remote', () => {
    const bm = mkBm({ remotes: [mkRemote({ tracked: false })] })
    expect(classifyBookmark(bm)).toEqual({ kind: 'remote-only', tracked: false })
  })

  it('remote-only tracked: no local, tracked remote (delete-staged)', () => {
    const bm = mkBm({ remotes: [mkRemote({ tracked: true })] })
    expect(classifyBookmark(bm)).toEqual({ kind: 'remote-only', tracked: true })
  })

  it('uses first TRACKED remote (skips untracked even if first)', () => {
    // origin sorted to front but untracked; upstream is tracked with ahead
    const bm = mkBm({
      local: mkRemote({ remote: '.' }),
      remotes: [
        mkRemote({ remote: 'origin', tracked: false }),
        mkRemote({ remote: 'upstream', tracked: true, ahead: 2 }),
      ],
    })
    expect(classifyBookmark(bm)).toEqual({ kind: 'behind', by: 2 })
  })

  it('conflict: wins over everything else', () => {
    const bm = mkBm({ conflict: true, added_targets: ['a', 'b', 'c'], local: mkRemote({ remote: '.' }), remotes: [mkRemote()] })
    expect(classifyBookmark(bm)).toEqual({ kind: 'conflict', sides: 3 })
  })
})

describe('syncPriority', () => {
  it('conflict < diverged < ahead < behind < local-only < remote-only < synced', () => {
    const states = [
      classifyBookmark(mkBm({ local: mkRemote({ remote: '.' }), remotes: [mkRemote()], synced: true })),
      classifyBookmark(mkBm({ remotes: [mkRemote({ tracked: false })] })),
      classifyBookmark(mkBm({ local: mkRemote({ remote: '.' }) })),
      classifyBookmark(mkBm({ local: mkRemote({ remote: '.' }), remotes: [mkRemote({ ahead: 1 })] })),
      classifyBookmark(mkBm({ local: mkRemote({ remote: '.' }), remotes: [mkRemote({ behind: 1 })] })),
      classifyBookmark(mkBm({ local: mkRemote({ remote: '.' }), remotes: [mkRemote({ ahead: 1, behind: 1 })] })),
      classifyBookmark(mkBm({ conflict: true, added_targets: ['a', 'b'] })),
    ]
    const sorted = [...states].sort((a, b) => syncPriority(a) - syncPriority(b))
    expect(sorted.map(s => s.kind)).toEqual([
      'conflict', 'diverged', 'ahead', 'behind', 'local-only', 'remote-only', 'synced',
    ])
  })
})

describe('fmtCount', () => {
  it.each([
    [0, '0'], [1, '1'], [999, '999'],
    [1000, '1.0k'], [7392, '7.4k'], [9999, '10.0k'],
    [10000, '10k'], [130774, '131k'],
  ])('%d → %s', (n, want) => {
    expect(fmtCount(n)).toBe(want)
  })
})

describe('syncLabel', () => {
  it.each([
    [{ kind: 'synced' as const }, 'origin', 'origin'],
    [{ kind: 'ahead' as const, by: 3 }, 'origin', 'origin ↑3'],
    [{ kind: 'behind' as const, by: 7392 }, 'origin', 'origin ↓7.4k'],
    [{ kind: 'diverged' as const, ahead: 1, behind: 130774 }, 'origin', 'origin ↑1 ↓131k'],
    [{ kind: 'local-only' as const }, 'origin', 'local only'],
    [{ kind: 'remote-only' as const, tracked: true }, 'origin', 'deleted @origin'],
    [{ kind: 'remote-only' as const, tracked: false }, 'origin', 'untracked @origin'],
    [{ kind: 'conflict' as const, sides: 3 }, 'origin', 'conflict (3 sides)'],
  ])('%j @ %s → %s', (state, remote, want) => {
    expect(syncLabel(state, remote)).toBe(want)
  })
})
