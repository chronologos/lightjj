// Shared test fixtures for divergence tests — imported by divergence.test.ts,
// divergence-refined.test.ts, divergence-strategy.test.ts, DivergencePanel.test.ts.
// DivergenceEntry has 11 required fields; every test redefining a builder
// violates DRY and makes field additions painful (miss one test file → type error).

import type { DivergenceEntry } from './api'
import type { DivergenceGroup } from './divergence'

/** Minimal DivergenceEntry builder. Defaults to a mutable divergent commit
 *  with empty parents/bookmarks. Tests override only the fields they assert on. */
export function entry(over: Partial<DivergenceEntry>): DivergenceEntry {
  return {
    change_id: '', commit_id: '', divergent: true,
    parent_commit_ids: [], parent_change_ids: [],
    wc_reachable: false, bookmarks: [], description: '', empty: false,
    is_working_copy: false,
    ...over,
  }
}

/** Minimal DivergenceGroup builder. Defaults to a 2-col same-parent single-
 *  change group. Used by buildKeepPlan tests and invariant sweeps. */
export function group(over: Partial<DivergenceGroup>): DivergenceGroup {
  return {
    rootChangeId: 'X', changeIds: ['X'],
    versions: [[entry({ commit_id: 'v0' }), entry({ commit_id: 'v1' })]],
    kind: 'same-parent', alignable: true, liveVersion: null,
    descendants: [], conflictedBookmarks: [],
    ...over,
  }
}
