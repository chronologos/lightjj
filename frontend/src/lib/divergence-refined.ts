// RefinedKind derivation + cross-column-merge detection — extracted from
// DivergencePanel.svelte's $derived.by blocks so the decision tree is unit-
// testable. The panel's reactive chain shrinks to one-liners that call these.
//
// See docs/jj-divergence.md for the taxonomy. RefinedKind is the post-tree-
// delta classification (structural kind + "did trees actually differ?").

import type { DivergenceGroup } from './divergence'
import type { DivergenceEntry } from './api'
import { refineRebaseKind } from './divergence'

/** Structural kind after the tree-delta fetch lands.
 *  'pending' = diff still loading (panel shows ..., recommend() suppresses).
 *  See the decision table in docs/jj-divergence.md §"Taxonomy". */
export type RefinedKind =
  | 'pending'
  | 'metadata-only'  // same-parent + empty tree delta → only description/author differ
  | 'edit-conflict'  // same-parent + non-empty delta
  | 'pure-rebase'    // diff-parent + empty delta (after fileUnion subtraction)
  | 'rebase-edit'    // diff-parent + non-empty delta
  | 'compound'       // 3+ mixed parents, or non-alignable stack

/** Compute RefinedKind from structural classification + diff state.
 *
 *  The fileUnion-subtraction step (refineRebaseKind) is what prevents trunk
 *  churn from being miscounted as edit-drift: a diff-parent group with ONLY
 *  trunk-touched files in its cross-diff is still pure-rebase. See
 *  docs/jj-divergence.md §"Failed heuristics" for why a one-bit "any file
 *  outside fileUnion?" check is wrong. */
export function computeRefinedKind(
  group: DivergenceGroup | null,
  diffLoading: boolean,
  crossDiffFiles: string[],  // parsed file paths; empty = identical trees
  fileUnion: Set<string>,    // files touched by at least one version
): RefinedKind {
  if (!group) return 'pending'
  if (!group.alignable || group.kind === 'compound') return 'compound'
  if (diffLoading) return 'pending'
  const treeEmpty = crossDiffFiles.length === 0
  if (group.kind === 'same-parent') return treeEmpty ? 'metadata-only' : 'edit-conflict'
  // diff-parent: subtract trunk churn. Empty remainder → pure rebase.
  if (treeEmpty) return 'pure-rebase'
  return refineRebaseKind(crossDiffFiles, fileUnion)
}

/** A descendant merging 2+ column tips is likely the user's manual
 *  reconciliation (`jj new keeper loser`). buildKeepPlan would silently
 *  exclude it (keeper-parent match) then abandon its OTHER parent — the merge
 *  survives but against a rewritten parent. Surface it so the panel can warn.
 *
 *  Checks TIPS only, not intermediate stack levels — a merge of root commits
 *  is unusual enough that we don't special-case it (documented gap). */
export function findCrossColumnMerge(g: DivergenceGroup): DivergenceEntry | null {
  if (g.versions[0].length < 2) return null
  const tips = g.versions[g.versions.length - 1].map(v => v.commit_id)
  return g.descendants.find(d => {
    const hits = tips.filter(t => d.parent_commit_ids.includes(t))
    return hits.length >= 2
  }) ?? null
}
