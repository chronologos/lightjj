// Execution side of divergence resolution. Fourth member of the family:
//   divergence.ts         — classify() + buildKeepPlan()  (plan, pure)
//   divergence-refined.ts — computeRefinedKind()          (analyze, pure)
//   divergence-strategy.ts— recommend()                   (recommend, pure)
//   divergence-actions.ts — executeKeepPlan() etc         (execute, api.*)
//
// These are the inner bodies that App.svelte's runDivergenceResolution wraps.
// Zero App-state reads — just api calls and the plan they operate on. The
// wrapper stays in App (it owns withMutation/setMessage/loadLog closures).
import { api, type MutationResult } from './api'
import type { KeepPlan } from './divergence'

export interface DivergenceActionResult {
  text: string
  results: MutationResult[]
}

// Keep (Strategy 1): abandon the losing columns, rebase their descendants
// onto the keeper. buildKeepPlan() computed what goes where; this does it.
//
// ORDER is load-bearing:
//   1. Rebase — moves non-empty descendants to the keeper tip first.
//      If abandon ran first, jj would auto-rebase D onto the loser-stack's
//      parent (trunk); our explicit rebase would then hit a twice-rebased
//      tree. -s (not -r) so D's descendants follow.
//   2. Abandon — losing columns + empty descendants. Stale stack now has
//      no children pinning it visible.
//   3. Bookmarks — per-change_id repoint, not stack tip.
// Serial throughout: concurrent jj mutations → divergent op history.
//
// Accumulate warnings from each step — divergence rebase is MORE likely
// than average to conflict (moving commits between stacks).
export async function executeKeepPlan(plan: KeepPlan): Promise<DivergenceActionResult> {
  const results: MutationResult[] = []
  // Group by dest — one rebase per distinct target. Common case (tip-only
  // descendants) degenerates to one rebase; mid-stack branches get their own.
  const byDest = new Map<string, string[]>()
  for (const { source, dest } of plan.rebaseSources) {
    const sources = byDest.get(dest)
    if (sources) sources.push(source)
    else byDest.set(dest, [source])
  }
  for (const [dest, sources] of byDest) {
    results.push(await api.rebase(sources, dest, '-s', '-d'))
  }
  results.push(await api.abandon(plan.abandonCommitIds))
  for (const { name, targetCommitId } of plan.bookmarkRepoints) {
    results.push(await api.bookmarkSet(targetCommitId, name))
  }
  const parts = [`kept ${plan.keeperCommitId.slice(0, 8)}`]
  if (plan.rebaseSources.length > 0) parts.push(`rebased ${plan.rebaseSources.length}`)
  if (plan.abandonCommitIds.length > 1) parts.push(`abandoned ${plan.abandonCommitIds.length}`)
  return { text: `Resolved divergence — ${parts.join(', ')}`, results }
}

// Split-identity (Strategy 2): reroll one commit's change_id. Single-command
// resolution — no abandons, no bookmark repoint. The re-id'd commit's
// descendants auto-rebase (metaedit is a rewrite).
export async function splitIdentity(commitId: string): Promise<DivergenceActionResult> {
  const result = await api.metaeditChangeId(commitId)
  return {
    text: `Split identity — ${commitId.slice(0, 8)} now has a new change_id`,
    results: [result],
  }
}

// Squash (Strategy 3): fold one version's content into the other. jj handles
// the conflict markers if trees clash; the user resolves those in the normal
// diff/merge flow. from-side is left emptied → abandoned automatically
// (not --keep-emptied).
export async function squashDivergent(from: string, into: string): Promise<DivergenceActionResult> {
  const result = await api.squash([from], into)
  return {
    text: `Squashed ${from.slice(0, 8)} → ${into.slice(0, 8)}`,
    results: [result],
  }
}

// Immutable-sibling "accept trunk" — abandon the mutable copy.
// --retain-bookmarks (baked into jj.Abandon) moves any bookmarks to parent.
export async function abandonMutable(commitId: string): Promise<DivergenceActionResult> {
  const result = await api.abandon([commitId])
  return {
    text: `Abandoned mutable ${commitId.slice(0, 8)} — accepting trunk's version`,
    results: [result],
  }
}
