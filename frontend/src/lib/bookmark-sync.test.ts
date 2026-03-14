import { describe, it, expect } from 'vitest'
import { classifyBookmark, syncPriority, fmtCount, syncLabel, trackOptions } from './bookmark-sync'
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

  it('synced on first tracked remote but bm.synced=false → diverged(0,0) sentinel', () => {
    // origin is 0/0 (synced) but jj's all-remotes synced bool says no —
    // e.g. upstream is behind. Don't show green.
    const bm = mkBm({ local: mkRemote({ remote: '.' }), remotes: [mkRemote()], synced: false })
    expect(classifyBookmark(bm)).toEqual({ kind: 'diverged', ahead: 0, behind: 0 })
  })
})

// --- scopeRemote param (remote-group rows in BookmarksPanel) ---
// Regression suite for bughunt findings — per-remote row sync MUST scope to
// that remote, not the first-tracked one. Display and action must agree.
describe('classifyBookmark — scopeRemote', () => {
  it('scoped lookup selects named remote, not first-tracked', () => {
    // origin is the first-tracked (ahead), upstream is behind. Unscoped → ahead.
    // Scoped to upstream → behind.
    const bm = mkBm({
      local: mkRemote({ remote: '.' }),
      remotes: [
        mkRemote({ remote: 'origin', tracked: true, behind: 3 }),
        mkRemote({ remote: 'upstream', tracked: true, ahead: 5 }),
      ],
    })
    expect(classifyBookmark(bm)).toEqual({ kind: 'ahead', by: 3 })              // unscoped
    expect(classifyBookmark(bm, 'upstream')).toEqual({ kind: 'behind', by: 5 }) // scoped
  })

  it('scoped UNTRACKED remote → local-only (NOT synced from 0/0 sentinel)', () => {
    // THE BUG (bughunt round 2 #1): scoped lookup finds the remote, reads
    // ahead/behind = 0/0, falls through to { kind: 'synced' } — green dot for
    // an unknown relationship. The `if (!r.tracked)` gate prevents this: we
    // have a local ref but no tracking relationship with THIS remote → the
    // 0/0 is a sentinel, not real data. 'local-only' is accurate per-remote.
    const bm = mkBm({
      local: mkRemote({ remote: '.' }),
      remotes: [
        mkRemote({ remote: 'origin', tracked: true, behind: 2 }),
        mkRemote({ remote: 'upstream', tracked: false }),  // 0/0 sentinel
      ],
    })
    expect(classifyBookmark(bm, 'upstream')).toEqual({ kind: 'local-only' })
    // NOT this:
    expect(classifyBookmark(bm, 'upstream')).not.toEqual({ kind: 'synced' })
  })

  it('scoped tracked 0/0 → synced (genuine sync, sentinel check is on tracked)', () => {
    // Contrast with the untracked case above: tracked + 0/0 IS real.
    const bm = mkBm({
      local: mkRemote({ remote: '.' }),
      remotes: [
        mkRemote({ remote: 'origin', tracked: true, behind: 2 }),
        mkRemote({ remote: 'upstream', tracked: true }),  // tracked 0/0 = synced
      ],
      synced: false,  // all-remotes check would say diverged — scoped skips it
    })
    expect(classifyBookmark(bm, 'upstream')).toEqual({ kind: 'synced' })
  })

  it('scoped synced skips bm.synced all-remotes check (that is LOCAL-group concern)', () => {
    // Scoped classification reports THIS remote's state only. The unscoped
    // version downgrades 0/0 to diverged(0,0) when bm.synced=false (some
    // OTHER remote is out of sync). Scoped does not — an UPSTREAM row showing
    // "upstream: other remote out of sync" would be nonsense.
    const bm = mkBm({
      local: mkRemote({ remote: '.' }),
      remotes: [mkRemote({ remote: 'origin', tracked: true })],
      synced: false,
    })
    expect(classifyBookmark(bm)).toEqual({ kind: 'diverged', ahead: 0, behind: 0 })  // unscoped downgrades
    expect(classifyBookmark(bm, 'origin')).toEqual({ kind: 'synced' })               // scoped reports truth
  })

  it('scoped remote absent from bm.remotes → local-only (no r found)', () => {
    // UPSTREAM group row for a bookmark that was tracked only on origin.
    // Shouldn't happen in normal panelRows construction (filter excludes it),
    // but the function is defensive: `if (!r) return local-only`.
    const bm = mkBm({
      local: mkRemote({ remote: '.' }),
      remotes: [mkRemote({ remote: 'origin', tracked: true })],
    })
    expect(classifyBookmark(bm, 'upstream')).toEqual({ kind: 'local-only' })
  })

  it('scoped remote-only (no local) → uses scoped remote tracked state', () => {
    // No local ref. Scoped to origin (untracked) vs upstream (tracked) must
    // differ — the row represents that remote's relationship, not the first-
    // tracked one's. The unscoped case uses `r` (first-tracked or fallback
    // [0]), so with upstream tracked the unscoped case reports tracked=true
    // too — the scopeRemote distinction matters when scoping to the UNTRACKED
    // remote, not the tracked one.
    const bm = mkBm({
      remotes: [
        mkRemote({ remote: 'origin', tracked: false }),
        mkRemote({ remote: 'upstream', tracked: true }),
      ],
    })
    expect(classifyBookmark(bm, 'origin')).toEqual({ kind: 'remote-only', tracked: false })
    expect(classifyBookmark(bm, 'upstream')).toEqual({ kind: 'remote-only', tracked: true })
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
    [{ kind: 'diverged' as const, ahead: 0, behind: 0 }, 'origin', 'other remote out of sync'],
    [{ kind: 'local-only' as const }, 'origin', 'local only'],
    [{ kind: 'remote-only' as const, tracked: true }, 'origin', 'deleted @origin'],
    [{ kind: 'remote-only' as const, tracked: false }, 'origin', 'untracked @origin'],
    [{ kind: 'conflict' as const, sides: 3 }, 'origin', 'conflict (3 sides)'],
  ])('%j @ %s → %s', (state, remote, want) => {
    expect(syncLabel(state, remote)).toBe(want)
  })
})

describe('trackOptions', () => {
  it('toggles tracked state for each existing remote', () => {
    const bm = mkBm({
      local: mkRemote({ remote: '.' }),
      remotes: [mkRemote({ remote: 'origin', tracked: true }), mkRemote({ remote: 'upstream', tracked: false })],
    })
    expect(trackOptions(bm)).toEqual([
      { action: 'untrack', remote: 'origin' },
      { action: 'track', remote: 'upstream' },
    ])
  })

  it('does NOT offer track for remotes the bookmark is absent from', () => {
    // `jj bookmark track foo --remote upstream` when foo@upstream doesn't
    // exist is a no-op with "Warning: No matching remotes". Offering it would
    // be a lying menu entry — user clicks, warning appears, nothing changes.
    const bm = mkBm({
      local: mkRemote({ remote: '.' }),
      remotes: [mkRemote({ remote: 'origin', tracked: true })],
    })
    expect(trackOptions(bm)).toEqual([{ action: 'untrack', remote: 'origin' }])
  })

  it('remote-only bookmark: toggles the one remote it exists on', () => {
    const bm = mkBm({ remotes: [mkRemote({ remote: 'origin', tracked: false })] })
    expect(trackOptions(bm)).toEqual([{ action: 'track', remote: 'origin' }])
  })

  it('local-only bookmark (no remotes at all) → empty', () => {
    const bm = mkBm({ local: mkRemote({ remote: '.' }) })
    expect(trackOptions(bm)).toEqual([])
  })
})
