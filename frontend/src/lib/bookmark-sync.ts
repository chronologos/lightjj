import type { Bookmark, BookmarkRemote } from './api'

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
  // Default remote is synced but a SECONDARY tracked remote is off. Carries
  // that remote + user-perspective counts so the label can name it (e.g.
  // `upstream ↑107`) instead of the old "other remote out of sync" sentinel.
  // Less severe than `diverged` — dot renders amber, not red.
  // Only fires when the default tracked remote is exactly 0/0 — if default has
  // any delta, ahead/behind/diverged wins and secondaries are not inspected.
  // remote='?' is the defensive fallback (bm.synced=false but no offender found).
  | { kind: 'secondary'; remote: string; ahead: number; behind: number }
  | { kind: 'local-only' }                              // local ref, no tracked remote
  | { kind: 'remote-only'; tracked: boolean }           // no local (untracked remote OR delete-staged)
  | { kind: 'conflict'; sides: number }                 // multiple added_targets

// scopeRemote: classify vs. THAT remote only. Without it, picks the first
// tracked remote (the original behavior — correct for the LOCAL group where
// the row represents the bookmark's primary sync). Remote-group rows MUST
// pass scopeRemote so the sync state matches the remote they display —
// otherwise an UPSTREAM > main row could pair upstream's commit_id with
// origin's ahead/behind counts (half-fix: the scoped-commit-display change
// was made before this param existed, producing false `upstream ↑N` labels).
export function classifyBookmark(bm: Bookmark, scopeRemote?: string): SyncState {
  if (bm.conflict) return { kind: 'conflict', sides: bm.added_targets?.length ?? 0 }
  const r = scopeRemote
    ? bm.remotes?.find(r => r.remote === scopeRemote)
    : bm.remotes?.find(r => r.tracked)
  if (!bm.local) {
    // No local ref. Scoped case: describe THAT remote's trackedness.
    // Unscoped: first remote's trackedness (pre-existing behavior).
    return { kind: 'remote-only', tracked: (r ?? bm.remotes?.[0])?.tracked ?? false }
  }
  if (!r) return { kind: 'local-only' }
  // Untracked remote refs have ahead/behind = 0/0 sentinel (api.ts: "only
  // meaningful when tracked"). Scoped lookup doesn't filter by trackedness
  // (the row SHOWS this remote regardless), so without this gate the sentinel
  // falls through to { kind: 'synced' } — green dot for an unknown relationship.
  // local-only is accurate: local exists and is not tracked against this remote.
  if (!r.tracked) return { kind: 'local-only' }
  // Invert: r.ahead = remote ahead of local = WE are behind
  const weAhead = r.behind
  const weBehind = r.ahead
  if (weAhead > 0 && weBehind > 0) return { kind: 'diverged', ahead: weAhead, behind: weBehind }
  if (weAhead > 0) return { kind: 'ahead', by: weAhead }
  if (weBehind > 0) return { kind: 'behind', by: weBehind }
  if (scopeRemote) {
    // Scoped classification reports THIS remote's state only — the
    // all-remotes-synced check is the LOCAL group's concern.
    return { kind: 'synced' }
  }
  // Synced on the first tracked remote — but jj's all-remotes `synced` bool
  // knows about the others. Don't lie: if any tracked remote is out of sync,
  // pick the WORST offender so a 3+ remote setup surfaces the most urgent one
  // (diverged > behind > ahead, ties by total magnitude).
  if (!bm.synced) {
    let worst: BookmarkRemote | undefined
    let worstRank = -1, worstMag = -1
    for (const rr of bm.remotes ?? []) {
      if (rr === r || !rr.tracked || (rr.ahead === 0 && rr.behind === 0)) continue
      const rank = rr.ahead > 0 && rr.behind > 0 ? 2 : rr.ahead > 0 ? 1 : 0
      const mag = rr.ahead + rr.behind
      if (rank > worstRank || (rank === worstRank && mag > worstMag)) {
        worst = rr; worstRank = rank; worstMag = mag
      }
    }
    if (worst) {
      // Invert like above: worst.ahead = remote ahead of us = WE are behind.
      return { kind: 'secondary', remote: worst.remote, ahead: worst.behind, behind: worst.ahead }
    }
    // Defensive: backend-unreachable per bookmark.go (synced considers only
    // tracked remotes, so !synced ⇒ some tracked remote has nonzero counts).
    // Render as secondary anyway so it gets amber/priority-4, not red/priority-1.
    return { kind: 'secondary', remote: '?', ahead: 0, behind: 0 }
  }
  return { kind: 'synced' }
}

/** Lower = sorts first. Trouble floats to top. */
const PRIORITY: Record<SyncState['kind'], number> = {
  'conflict': 0,
  'diverged': 1,
  'ahead': 2,
  'behind': 3,
  // Secondary remote out of sync — default is fine, so this is less urgent
  // than direct ahead/behind on default. Still floats above the healthy states.
  'secondary': 4,
  'local-only': 5,
  'remote-only': 6,
  'synced': 7,
}

export function syncPriority(s: SyncState): number {
  return PRIORITY[s.kind]
}

/** Compact count: 7392 → 7.4k, 130774 → 131k. Large-repo behind-counts are noise past ~1k. */
export function fmtCount(n: number): string {
  if (n < 1000) return String(n)
  if (n < 10000) return (n / 1000).toFixed(1) + 'k'
  return Math.round(n / 1000) + 'k'
}

export type SyncLabelAction =
  | { kind: 'fast-forward'; remote: string }
  | { kind: 'push'; remote: string }

/**
 * Action to dispatch when the sync label is clicked, or null if no single
 * obvious action exists. The label is the affordance: "click ↓N to pull,
 * click ↑N to push, click nothing when diverged/conflicted".
 *
 * `shownRemote` is the remote whose state classifyBookmark used — for
 * `behind`/`ahead` the SyncState doesn't carry it (caller's first-tracked /
 * scoped), so it's threaded through. `secondary` carries its own remote.
 *
 * Deliberately excludes diverged + secondary-with-both-nonzero: those have
 * commits on both sides and "fix" is ambiguous (push --force vs rebase vs
 * fast-forward-then-push). Conflict resolution stays on the explicit
 * "Set to <remote>" context-menu action.
 */
export function syncLabelAction(s: SyncState, shownRemote: string | undefined): SyncLabelAction | null {
  if (s.kind === 'behind') return shownRemote ? { kind: 'fast-forward', remote: shownRemote } : null
  if (s.kind === 'ahead') return shownRemote ? { kind: 'push', remote: shownRemote } : null
  if (s.kind === 'secondary' && s.remote !== '?') {
    if (s.ahead === 0 && s.behind > 0) return { kind: 'fast-forward', remote: s.remote }
    if (s.behind === 0 && s.ahead > 0) return { kind: 'push', remote: s.remote }
  }
  return null
}

/** Short human label for the sync-state column. */
export function syncLabel(s: SyncState, remote: string): string {
  switch (s.kind) {
    case 'synced':      return remote
    case 'ahead':       return `${remote} ↑${fmtCount(s.by)}`
    case 'behind':      return `${remote} ↓${fmtCount(s.by)}`
    case 'diverged':
      return `${remote} ↑${fmtCount(s.ahead)} ↓${fmtCount(s.behind)}`
    case 'secondary':
      if (s.remote === '?') return 'other remote out of sync'
      if (s.ahead > 0 && s.behind > 0) return `${s.remote} ↑${fmtCount(s.ahead)} ↓${fmtCount(s.behind)}`
      if (s.ahead > 0) return `${s.remote} ↑${fmtCount(s.ahead)}`
      return `${s.remote} ↓${fmtCount(s.behind)}`
    case 'local-only':  return 'local only'
    case 'remote-only': return s.tracked ? `deleted @${remote}` : `untracked @${remote}`
    case 'conflict':    return `conflict (${s.sides} sides)`
  }
}

export interface TrackOption {
  action: 'track' | 'untrack'
  remote: string
}

/** Per-remote track/untrack toggles for this bookmark — one per remote the
 *  bookmark actually exists on. `jj bookmark track foo --remote bar` when
 *  foo@bar doesn't exist is a no-op with a warning ("No matching remotes");
 *  offering it would be a lying menu entry. Default remote sorts first
 *  (backend sorts bm.remotes). */
export function trackOptions(bm: Bookmark): TrackOption[] {
  return (bm.remotes ?? []).map(r => ({
    action: r.tracked ? 'untrack' : 'track',
    remote: r.remote,
  }))
}
