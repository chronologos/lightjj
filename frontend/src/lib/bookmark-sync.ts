import type { Bookmark } from './api'

/**
 * Classified sync state of a bookmark vs. its default tracked remote.
 * Drives the BookmarksPanel sort order and sync-dot color.
 *
 * Note the "ahead"/"behind" inversion: BookmarkRemote.ahead = remote ahead of
 * us = WE are behind. The `SyncState` kinds use the USER perspective
 * ("ahead" = I have unpushed commits).
 */
export type SyncState =
  | { kind: 'synced' }                                  // local == tracked remote
  | { kind: 'ahead'; by: number }                       // unpushed commits (remote.behind > 0)
  | { kind: 'behind'; by: number }                      // remote moved (remote.ahead > 0)
  | { kind: 'diverged'; ahead: number; behind: number } // both
  | { kind: 'local-only' }                              // local ref, no tracked remote
  | { kind: 'remote-only'; tracked: boolean }           // no local (untracked remote OR delete-staged)
  | { kind: 'conflict'; sides: number }                 // multiple added_targets

export function classifyBookmark(bm: Bookmark): SyncState {
  if (bm.conflict) return { kind: 'conflict', sides: bm.added_targets?.length ?? 0 }
  if (!bm.local) return { kind: 'remote-only', tracked: bm.remotes?.[0]?.tracked ?? false }
  const r = bm.remotes?.find(r => r.tracked)
  if (!r) return { kind: 'local-only' }
  // Invert: r.ahead = remote ahead of local = WE are behind
  const weAhead = r.behind
  const weBehind = r.ahead
  if (weAhead > 0 && weBehind > 0) return { kind: 'diverged', ahead: weAhead, behind: weBehind }
  if (weAhead > 0) return { kind: 'ahead', by: weAhead }
  if (weBehind > 0) return { kind: 'behind', by: weBehind }
  return { kind: 'synced' }
}

/** Lower = sorts first. Trouble floats to top. */
const PRIORITY: Record<SyncState['kind'], number> = {
  'conflict': 0,
  'diverged': 1,
  'ahead': 2,
  'behind': 3,
  'local-only': 4,
  'remote-only': 5,
  'synced': 6,
}

export function syncPriority(s: SyncState): number {
  return PRIORITY[s.kind]
}

/** Compact count: 7392 → 7.4k, 130774 → 131k. Monorepo behind-counts are noise past ~1k. */
export function fmtCount(n: number): string {
  if (n < 1000) return String(n)
  if (n < 10000) return (n / 1000).toFixed(1) + 'k'
  return Math.round(n / 1000) + 'k'
}

/** Short human label for the sync-state column. */
export function syncLabel(s: SyncState, remote: string): string {
  switch (s.kind) {
    case 'synced':      return remote
    case 'ahead':       return `${remote} ↑${fmtCount(s.by)}`
    case 'behind':      return `${remote} ↓${fmtCount(s.by)}`
    case 'diverged':    return `${remote} ↑${fmtCount(s.ahead)} ↓${fmtCount(s.behind)}`
    case 'local-only':  return 'local only'
    case 'remote-only': return s.tracked ? `deleted @${remote}` : `untracked @${remote}`
    case 'conflict':    return `conflict (${s.sides} sides)`
  }
}
