// Divergence resolution strategy recommendations.
//
// Maps (structural kind, tree delta, live hint) → ranked strategy list.
// Pure — consumes only classify() output + the lazy cross-diff the panel
// fetches. Strategies are DATA (kind+target+reason), not closures; the panel
// maps kind → action handler. See docs/jj-divergence.md for the taxonomy.
//
// Strategies mirror jj's divergence guide (docs.jj-vcs.dev §Strategy 1-4):
//   keep           → jj abandon <losers>      (Strategy 1)
//   split-identity → jj metaedit --update-change-id <target>  (Strategy 2)
//   squash         → jj squash --from <loser> --into <keeper> (Strategy 3)
// Strategy 4 (accept) is the implicit null — no recommendation means we
// can't help; panel falls back to column buttons with no primary highlight.

import type { DivergenceGroup } from './divergence'
import type { RefinedKind } from './divergence-refined'

// Only strategies recommend() actually emits. split-identity is
// immutable-sibling-only and doesn't go through the Strategy[] path.
export type StrategyKind = 'keep' | 'squash'
export type Confidence = 'high' | 'medium' | 'low'

export interface Strategy {
  kind: StrategyKind
  // keep: column to keep. split-identity: column to re-id. squash: --into side.
  // Null → no preferred target; panel presents the action but lets user pick.
  targetIdx: number | null
  confidence: Confidence
  reason: string  // user-facing one-liner: WHY this strategy, not WHAT it does
}

// recommend returns a ranked list (highest confidence first). Empty list =
// "manual only" — panel shows no primary card, just the per-column Keep buttons
// with equal weight. Callers that want a single answer take [0].
//
// Deliberately conservative: confidence 'high' is reserved for cases where
// picking wrong would be a provable no-op or near-no-op (pure-rebase with
// identical trees). Everything content-at-risk caps at 'medium'.
export function recommend(
  g: DivergenceGroup,
  refined: RefinedKind,
): Strategy[] {
  // Non-alignable or compound: columns aren't clean descent chains. Any
  // strategy that takes a targetIdx would act on the wrong commits.
  if (!g.alignable || refined === 'compound') return []

  const n = g.versions[0].length
  // >2 copies with alignable columns: recommend() stays out. N-way squash
  // is path-dependent (squash A→B then C→B ≠ C→A then A→B when conflicts
  // arise), split-identity would leave N-1 copies still divergent. The per-
  // column Keep buttons + cross-diff selector are the right UX here.
  if (n !== 2) return []

  const live = g.liveVersion  // 0, 1, or null (tautological/ambiguous)
  const stale = live === null ? null : 1 - live
  // squash only resolves the tip level of a stack — losing column's
  // intermediate changes stay divergent. Gate squash on single-change groups.
  // keep works fine for stacks (buildPlan abandons the whole losing column).
  const canSquash = g.changeIds.length === 1

  const out: Strategy[] = []

  switch (refined) {
    case 'pure-rebase':
      // Identical trees modulo trunk churn. The ONLY risk is which trunk point
      // you sit on — no content loss either way. Live signal (when set) is the
      // cleanest we get: @ descends from that column, so the user's ongoing
      // work already assumes that parent.
      if (live !== null) {
        out.push({
          kind: 'keep', targetIdx: live, confidence: 'high',
          reason: `Trees are identical. Your working copy descends from /${live}.`,
        })
      } else {
        // No live hint. "Fresher trunk" heuristic needs ancestry distance
        // (which parent is closer to trunk()); not wired yet. Either is safe.
        out.push({
          kind: 'keep', targetIdx: null, confidence: 'medium',
          reason: 'Trees are identical — either copy is safe. The parent chips below show which trunk point each sits on.',
        })
      }
      break

    case 'metadata-only':
      // Same parent, same tree → only description/author differ. Can't tell
      // which metadata was intentional. Keep is low-risk (content identical)
      // but we genuinely don't know which side. Offer both at low confidence.
      // Live hint doesn't help — it's "which you clicked last", not "which
      // description you meant".
      out.push({
        kind: 'keep', targetIdx: null, confidence: 'low',
        reason: 'Content identical — only the description differs (highlighted below).',
      })
      break

    case 'edit-conflict':
      // Same base, both have real edits. The jj-guide's Strategy 3 (squash)
      // is the canonical answer: combine the content. Lead with that.
      // Keep is offered secondary (maybe one side is a strict superset —
      // the user can see that in the cross-diff).
      // Squash INTO the live side if we have that hint; else no preference.
      if (canSquash) {
        out.push({
          kind: 'squash', targetIdx: live, confidence: 'medium',
          reason: 'Both copies have unique edits from the same base. Squash combines them.',
        })
      }
      if (live !== null) {
        out.push({
          kind: 'keep', targetIdx: live, confidence: 'low',
          reason: `Keep /${live} if /${stale}'s edits are subsumed (check the diff).`,
        })
      }
      // Split-identity rarely makes sense here — both versions have the same
      // parent and presumably the same intent. Omit.
      break

    case 'rebase-edit':
      // One was rebased AND has content drift. Most dangerous case — keeping
      // the wrong side loses real work. Live is a hint but not authoritative
      // (the stale side might have the edit you care about).
      if (live !== null) {
        out.push({
          kind: 'keep', targetIdx: live, confidence: 'medium',
          reason: `Working copy descends from /${live}, but /${stale} has content differences. Check the diff first.`,
        })
        if (canSquash) out.push({
          kind: 'squash', targetIdx: live, confidence: 'low',
          reason: `Fold /${stale}'s edits into /${live} if you want both.`,
        })
      } else if (canSquash) {
        out.push({
          kind: 'squash', targetIdx: null, confidence: 'low',
          reason: 'Both copies have edits on different parents. Squash to combine, or keep the one with edits you want.',
        })
      }
      break

    case 'pending':
      // Tree delta not landed. No recommendation yet.
      break
  }

  return out
}

// Immutable-sibling case: the mutable() revset returns only one version;
// group.versions[0].length < 2. Two viable actions, both preserve the
// immutable (trunk) side:
//   split-identity: mutable gets new change_id → clears divergence, keeps work
//   abandon-mutable: discards the rewrite, accepts trunk's version
//
// NOT exposed as Strategy[] — forcing this through the ranked-recommendation
// abstraction overloaded 'keep' with inverted semantics ("abandon the only
// mutable" vs normal "keep this column"). The panel renders two hardcoded
// buttons for this case; copy lives here to keep the strategy catalog in
// one file.
export const immutableSiblingCopy = {
  splitReason: 'Your mutable copy gets a new change_id. Divergence clears; both commits survive as independent changes.',
  abandonReason: 'Abandon your mutable copy to accept trunk\'s version. Discards your edits.',
}

// Fresher-trunk heuristic for pure-rebase + no-live (v1.1): see
// docs/jj-divergence.md §"Strategy recommendations" / "Not implemented".
// Design: lazy `heads(P0|P1)` fetch → the column whose parent is the sole
// head is the freshly-rebased one. Not implemented; no prerequisite API.
