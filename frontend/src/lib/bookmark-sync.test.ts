import { describe, it, expect } from 'vitest'
import { classifyBookmark, syncPriority, fmtCount, syncLabel, syncLabelAction, trackOptions } from './bookmark-sync'
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

  it('synced on default remote + secondary out of sync → secondary with remote + counts', () => {
    // origin (default) is 0/0 (synced) but upstream has behind=107 — we're
    // 107 ahead of upstream. Label should name upstream instead of the old
    // generic "other remote out of sync" sentinel.
    const bm = mkBm({
      local: mkRemote({ remote: '.' }),
      remotes: [
        mkRemote({ remote: 'origin', tracked: true }),
        mkRemote({ remote: 'upstream', tracked: true, behind: 107 }),
      ],
      synced: false,
    })
    // user-perspective: r.behind (= 107) → weAhead
    expect(classifyBookmark(bm)).toEqual({ kind: 'secondary', remote: 'upstream', ahead: 107, behind: 0 })
    // Scoped to origin reports ONLY origin's state — `secondary` is a
    // cross-remote signal, never emitted from the per-remote-group path.
    expect(classifyBookmark(bm, 'origin')).toEqual({ kind: 'synced' })
  })

  it('multiple secondaries → picks worst offender (diverged > behind > ahead, ties by magnitude)', () => {
    // origin synced; upstream behind=5 (we ahead 5, rank 0); fork ahead=2
    // behind=3 (we ahead 3 + behind 2, diverged, rank 2). fork wins despite
    // upstream's higher single count because diverged outranks ahead.
    const bm = mkBm({
      local: mkRemote({ remote: '.' }),
      remotes: [
        mkRemote({ remote: 'origin', tracked: true }),
        mkRemote({ remote: 'upstream', tracked: true, behind: 5 }),
        mkRemote({ remote: 'fork', tracked: true, ahead: 2, behind: 3 }),
      ],
      synced: false,
    })
    expect(classifyBookmark(bm)).toEqual({ kind: 'secondary', remote: 'fork', ahead: 3, behind: 2 })
  })

  it('multiple secondaries same rank → ties broken by magnitude', () => {
    const bm = mkBm({
      local: mkRemote({ remote: '.' }),
      remotes: [
        mkRemote({ remote: 'origin', tracked: true }),
        mkRemote({ remote: 'a', tracked: true, behind: 3 }),
        mkRemote({ remote: 'b', tracked: true, behind: 10 }),
      ],
      synced: false,
    })
    expect(classifyBookmark(bm)).toEqual({ kind: 'secondary', remote: 'b', ahead: 10, behind: 0 })
  })

  it('secondary diverged (both ahead and behind) reports both', () => {
    const bm = mkBm({
      local: mkRemote({ remote: '.' }),
      remotes: [
        mkRemote({ remote: 'origin', tracked: true }),
        mkRemote({ remote: 'upstream', tracked: true, ahead: 3, behind: 5 }),
      ],
      synced: false,
    })
    expect(classifyBookmark(bm)).toEqual({ kind: 'secondary', remote: 'upstream', ahead: 5, behind: 3 })
  })

  it('synced=false but no tracked offender → defensive secondary("?") fallback', () => {
    // Defensive: backend cannot emit synced:false with only untracked
    // secondaries off (synced ignores untracked per bookmark.go); covers the
    // inconsistent-data fallback. Amber/priority-4, not red/priority-1.
    const bm = mkBm({
      local: mkRemote({ remote: '.' }),
      remotes: [
        mkRemote({ remote: 'origin', tracked: true }),
        mkRemote({ remote: 'upstream', tracked: false }),
      ],
      synced: false,
    })
    expect(classifyBookmark(bm)).toEqual({ kind: 'secondary', remote: '?', ahead: 0, behind: 0 })
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
    // version downgrades 0/0 to secondary("?") when bm.synced=false (some
    // OTHER remote is out of sync). Scoped does not — an UPSTREAM row showing
    // "upstream: other remote out of sync" would be nonsense.
    const bm = mkBm({
      local: mkRemote({ remote: '.' }),
      remotes: [mkRemote({ remote: 'origin', tracked: true })],
      synced: false,
    })
    expect(classifyBookmark(bm)).toEqual({ kind: 'secondary', remote: '?', ahead: 0, behind: 0 })  // unscoped downgrades
    expect(classifyBookmark(bm, 'origin')).toEqual({ kind: 'synced' })                             // scoped reports truth
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
  it('conflict < diverged < ahead < behind < secondary < local-only < remote-only < synced', () => {
    const states = [
      classifyBookmark(mkBm({ local: mkRemote({ remote: '.' }), remotes: [mkRemote()], synced: true })),
      classifyBookmark(mkBm({ remotes: [mkRemote({ tracked: false })] })),
      classifyBookmark(mkBm({ local: mkRemote({ remote: '.' }) })),
      // secondary: origin synced, upstream behind
      classifyBookmark(mkBm({
        local: mkRemote({ remote: '.' }),
        remotes: [
          mkRemote({ remote: 'origin', tracked: true }),
          mkRemote({ remote: 'upstream', tracked: true, behind: 1 }),
        ],
        synced: false,
      })),
      classifyBookmark(mkBm({ local: mkRemote({ remote: '.' }), remotes: [mkRemote({ ahead: 1 })] })),
      classifyBookmark(mkBm({ local: mkRemote({ remote: '.' }), remotes: [mkRemote({ behind: 1 })] })),
      classifyBookmark(mkBm({ local: mkRemote({ remote: '.' }), remotes: [mkRemote({ ahead: 1, behind: 1 })] })),
      classifyBookmark(mkBm({ conflict: true, added_targets: ['a', 'b'] })),
    ]
    const sorted = [...states].sort((a, b) => syncPriority(a) - syncPriority(b))
    expect(sorted.map(s => s.kind)).toEqual([
      'conflict', 'diverged', 'ahead', 'behind', 'secondary', 'local-only', 'remote-only', 'synced',
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
    [{ kind: 'secondary' as const, remote: '?', ahead: 0, behind: 0 }, 'origin', 'other remote out of sync'],
    [{ kind: 'secondary' as const, remote: 'upstream', ahead: 107, behind: 0 }, 'origin', 'upstream ↑107'],
    [{ kind: 'secondary' as const, remote: 'upstream', ahead: 0, behind: 7392 }, 'origin', 'upstream ↓7.4k'],
    [{ kind: 'secondary' as const, remote: 'upstream', ahead: 3, behind: 5 }, 'origin', 'upstream ↑3 ↓5'],
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

describe('syncLabelAction', () => {
  it('behind → fast-forward to shownRemote (the canonical "fork lagging upstream" case)', () => {
    expect(syncLabelAction({ kind: 'behind', by: 118 }, 'upstream'))
      .toEqual({ kind: 'fast-forward', remote: 'upstream' })
  })

  it('ahead → push to shownRemote (the "local main ahead of fork origin" case)', () => {
    expect(syncLabelAction({ kind: 'ahead', by: 118 }, 'origin'))
      .toEqual({ kind: 'push', remote: 'origin' })
  })

  it('behind/ahead with no shownRemote (defensive) → null', () => {
    expect(syncLabelAction({ kind: 'behind', by: 5 }, undefined)).toBeNull()
    expect(syncLabelAction({ kind: 'ahead', by: 5 }, undefined)).toBeNull()
  })

  it('secondary behind-only → fast-forward to that secondary remote', () => {
    // origin synced, upstream behind 118 → secondary carries upstream.
    expect(syncLabelAction(
      { kind: 'secondary', remote: 'upstream', ahead: 0, behind: 118 }, 'origin',
    )).toEqual({ kind: 'fast-forward', remote: 'upstream' })
  })

  it('secondary ahead-only → push to that secondary remote', () => {
    // The "local synced to upstream, fork-origin behind" mirror — local is
    // AHEAD of the secondary, so push.
    expect(syncLabelAction(
      { kind: 'secondary', remote: 'origin', ahead: 118, behind: 0 }, 'upstream',
    )).toEqual({ kind: 'push', remote: 'origin' })
  })

  it('secondary diverged (both nonzero) → null — no single obvious action', () => {
    expect(syncLabelAction(
      { kind: 'secondary', remote: 'upstream', ahead: 3, behind: 118 }, 'origin',
    )).toBeNull()
  })

  it('secondary with sentinel remote "?" → null (defensive — no real remote)', () => {
    expect(syncLabelAction(
      { kind: 'secondary', remote: '?', ahead: 0, behind: 5 }, 'origin',
    )).toBeNull()
  })

  it('no-action states → null', () => {
    expect(syncLabelAction({ kind: 'synced' }, 'origin')).toBeNull()
    expect(syncLabelAction({ kind: 'diverged', ahead: 2, behind: 5 }, 'origin')).toBeNull()
    expect(syncLabelAction({ kind: 'conflict', sides: 2 }, 'origin')).toBeNull()
    expect(syncLabelAction({ kind: 'local-only' }, 'origin')).toBeNull()
    expect(syncLabelAction({ kind: 'remote-only', tracked: true }, 'origin')).toBeNull()
  })
})
