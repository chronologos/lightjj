import { describe, it, expect } from 'vitest'
import { computeRefinedKind, findCrossColumnMerge, type RefinedKind } from './divergence-refined'
import type { DivergenceGroup } from './divergence'
import { entry as e, group as g } from './divergence.fixtures'

// Full decision-table — every cell. This IS the spec for computeRefinedKind.
// Rows mirror docs/jj-divergence.md §"Taxonomy" + the gating conditions.
describe('computeRefinedKind — decision table', () => {
  const table: Array<{
    name: string
    group: DivergenceGroup | null
    diffLoading: boolean
    crossDiffFiles: string[]
    fileUnion: Set<string>
    expect: RefinedKind
  }> = [
    // ── Gating conditions (override everything below) ─────────────────────
    {
      name: 'group=null → pending (initial mount state)',
      group: null, diffLoading: false, crossDiffFiles: [], fileUnion: new Set(),
      expect: 'pending',
    },
    {
      name: 'non-alignable → compound (overrides kind, overrides diffLoading)',
      group: g({ kind: 'diff-parent', alignable: false }), diffLoading: true,
      crossDiffFiles: ['f.go'], fileUnion: new Set(['f.go']),
      expect: 'compound',
    },
    {
      name: 'kind=compound → compound (overrides tree delta)',
      group: g({ kind: 'compound' }), diffLoading: false, crossDiffFiles: [], fileUnion: new Set(),
      expect: 'compound',
    },
    {
      name: 'diffLoading → pending (same-parent, tree delta not landed)',
      group: g({ kind: 'same-parent' }), diffLoading: true, crossDiffFiles: [], fileUnion: new Set(),
      expect: 'pending',
    },
    {
      name: 'diffLoading → pending (diff-parent too — fileUnion subtraction can\'t run without delta)',
      // diffLoading check fires before the kind branch. A diff-parent with
      // stale crossDiffFiles from a previous render would otherwise
      // misclassify until the new fetch lands.
      group: g({ kind: 'diff-parent' }), diffLoading: true,
      crossDiffFiles: ['stale.go'], fileUnion: new Set(['stale.go']),
      expect: 'pending',
    },

    // ── same-parent branch ───────────────────────────────────────────────
    {
      name: 'same-parent + empty delta → metadata-only',
      group: g({ kind: 'same-parent' }), diffLoading: false, crossDiffFiles: [], fileUnion: new Set(),
      expect: 'metadata-only',
    },
    {
      name: 'same-parent + non-empty delta → edit-conflict',
      group: g({ kind: 'same-parent' }), diffLoading: false,
      crossDiffFiles: ['f.go'], fileUnion: new Set(['f.go']),
      expect: 'edit-conflict',
    },
    {
      name: 'same-parent: fileUnion is IGNORED (no subtraction on same-parent)',
      // fileUnion is for diff-parent trunk-churn filtering. same-parent means
      // both versions came from the same commit — there IS no trunk churn.
      // Non-empty crossDiffFiles = real edit conflict regardless of fileUnion.
      group: g({ kind: 'same-parent' }), diffLoading: false,
      crossDiffFiles: ['f.go'], fileUnion: new Set(),  // empty fileUnion
      expect: 'edit-conflict',
    },

    // ── diff-parent branch (the fileUnion-subtraction row) ───────────────
    {
      name: 'diff-parent + empty delta → pure-rebase (identical trees)',
      group: g({ kind: 'diff-parent' }), diffLoading: false, crossDiffFiles: [], fileUnion: new Set(),
      expect: 'pure-rebase',
    },
    {
      name: 'diff-parent + delta all in fileUnion → rebase-edit (real content drift)',
      group: g({ kind: 'diff-parent' }), diffLoading: false,
      crossDiffFiles: ['f.go'], fileUnion: new Set(['f.go']),
      expect: 'rebase-edit',
    },
    {
      name: 'diff-parent + delta all OUTSIDE fileUnion → pure-rebase (trunk churn only)',
      // This is the subtraction: neither version touched trunk.go, but the
      // cross-diff shows it (trunk moved between the two parent commits).
      // Subtracting leaves nothing → trees are identical modulo trunk → pure.
      group: g({ kind: 'diff-parent' }), diffLoading: false,
      crossDiffFiles: ['trunk.go'], fileUnion: new Set(['f.go']),
      expect: 'pure-rebase',
    },
    {
      name: 'diff-parent + MIXED delta (1 in, 1 out) → rebase-edit (adversarial from docs)',
      // docs/jj-divergence.md §"Failed heuristics" row 3: f.go is real edit,
      // trunk.go is trunk churn. The old one-bit "any file outside fileUnion"
      // check would say "trunk noise, pure rebase" — WRONG, loses f.go edit.
      // Subtraction: remove trunk.go → f.go remains → rebase-edit.
      group: g({ kind: 'diff-parent' }), diffLoading: false,
      crossDiffFiles: ['f.go', 'trunk.go'], fileUnion: new Set(['f.go', 'bar.go']),
      expect: 'rebase-edit',
    },
    {
      name: 'diff-parent + delta present + EMPTY fileUnion → pure-rebase (everything subtracted)',
      // Degenerate: if fileUnion is empty (api.files returned nothing — both
      // versions are content-empty), every delta file subtracts away. This is
      // the danger path DivergencePanel.svelte:141-144 documents — which is why
      // api.files failure must BUBBLE to error, not silently leave fileUnion={}.
      // When fileUnion IS legitimately empty (rare), trunk churn is all there is.
      group: g({ kind: 'diff-parent' }), diffLoading: false,
      crossDiffFiles: ['trunk.go', 'other.go'], fileUnion: new Set(),
      expect: 'pure-rebase',
    },
  ]

  for (const row of table) {
    it(row.name, () => {
      expect(computeRefinedKind(row.group, row.diffLoading, row.crossDiffFiles, row.fileUnion))
        .toBe(row.expect)
    })
  }
})

describe('findCrossColumnMerge', () => {
  it('descendant merging both tip commits → returns it', () => {
    // `jj new tip0 tip1` — manual reconciliation. buildKeepPlan would exclude
    // this (keeper-tip parent match), then abandon the OTHER tip → merge's
    // other parent rewrites. Panel must surface this before Keep fires.
    const grp = g({
      versions: [[e({ commit_id: 'tip0' }), e({ commit_id: 'tip1' })]],
      descendants: [
        e({ commit_id: 'merge', parent_commit_ids: ['tip0', 'tip1'], divergent: false }),
      ],
    })
    expect(findCrossColumnMerge(grp)?.commit_id).toBe('merge')
  })

  it('descendant from one tip + one outside commit → NOT a cross-column merge', () => {
    // Ordinary `jj new tip0` with some unrelated second parent. Not reconciliation.
    const grp = g({
      versions: [[e({ commit_id: 'tip0' }), e({ commit_id: 'tip1' })]],
      descendants: [
        e({ commit_id: 'd', parent_commit_ids: ['tip0', 'outside'], divergent: false }),
      ],
    })
    expect(findCrossColumnMerge(grp)).toBeNull()
  })

  it('descendant from one tip only → null', () => {
    const grp = g({
      versions: [[e({ commit_id: 'tip0' }), e({ commit_id: 'tip1' })]],
      descendants: [
        e({ commit_id: 'd', parent_commit_ids: ['tip0'], divergent: false }),
      ],
    })
    expect(findCrossColumnMerge(grp)).toBeNull()
  })

  it('no descendants → null', () => {
    expect(findCrossColumnMerge(g({}))).toBeNull()
  })

  it('single-version group (immutable-sibling case) → null', () => {
    // versions[0].length < 2 guard — can't have a cross-column merge with one column.
    const grp = g({ versions: [[e({ commit_id: 'only' })]] })
    expect(findCrossColumnMerge(grp)).toBeNull()
  })

  it('3-column: merge of 2-of-3 tips → STILL returns it (>=2 not ===n)', () => {
    // Panel shows warning even for partial reconciliation. The non-merged
    // column (tip2) would still be abandoned by Keep → merge survives against
    // ONE rewritten parent (tip2) — warn on this too.
    // Pin current behavior; 3-column is rare enough that "any 2+ overlap = warn"
    // is the right conservative call.
    const grp = g({
      versions: [[e({ commit_id: 't0' }), e({ commit_id: 't1' }), e({ commit_id: 't2' })]],
      descendants: [
        e({ commit_id: 'merge', parent_commit_ids: ['t0', 't1'], divergent: false }),
      ],
    })
    expect(findCrossColumnMerge(grp)?.commit_id).toBe('merge')
  })

  it('stack: checks TIP level only (documented gap — root-level merge ignored)', () => {
    // Merge of ROOT commits, not tips. Current code only checks tips →
    // returns null. This is a documented gap: root-level reconciliation is
    // unusual (would need `jj new root0 root1` then DON'T build on it — if
    // built on, it'd be a descendant of the MERGE, not of root0/root1).
    const grp = g({
      changeIds: ['A', 'B'],
      versions: [
        [e({ commit_id: 'root0' }), e({ commit_id: 'root1' })],
        [e({ commit_id: 'tip0' }), e({ commit_id: 'tip1' })],
      ],
      descendants: [
        e({ commit_id: 'root_merge', parent_commit_ids: ['root0', 'root1'], divergent: false }),
      ],
    })
    expect(findCrossColumnMerge(grp)).toBeNull()  // pin current behavior
  })
})
