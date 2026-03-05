import { describe, it, expect } from 'vitest'
import { classify, refineRebaseKind, type DivergenceGroup } from './divergence'
import type { DivergenceEntry } from './api'

// Minimal entry builder — only fields the classifier reads.
function e(over: Partial<DivergenceEntry>): DivergenceEntry {
  return {
    change_id: '', commit_id: '', divergent: true,
    parent_commit_ids: [], parent_change_ids: [],
    wc_reachable: false, bookmarks: [], description: '', empty: false,
    is_working_copy: false,
    ...over,
  }
}

describe('classify — single change', () => {
  it('same-parent: concurrent edit (--at-op case)', () => {
    // Two versions, same parent commit_id — both rewrote from same base.
    const groups = classify([
      e({ change_id: 'X', commit_id: 'a', parent_commit_ids: ['p'], parent_change_ids: ['pc'] }),
      e({ change_id: 'X', commit_id: 'b', parent_commit_ids: ['p'], parent_change_ids: ['pc'] }),
    ])
    expect(groups).toHaveLength(1)
    expect(groups[0].kind).toBe('same-parent')
    expect(groups[0].changeIds).toEqual(['X'])
  })

  it('diff-parent: rebase (fetch-after-rebase stack root)', () => {
    // Different parent commit_ids — one was rebased.
    const groups = classify([
      e({ change_id: 'X', commit_id: 'a', parent_commit_ids: ['p1'], parent_change_ids: ['pc'] }),
      e({ change_id: 'X', commit_id: 'b', parent_commit_ids: ['p2'], parent_change_ids: ['pc'] }),
    ])
    expect(groups[0].kind).toBe('diff-parent')
  })

  it('compound: 3-way with mixed parents (concurrent-edit-then-rebase shape)', () => {
    const groups = classify([
      e({ change_id: 'X', commit_id: 'a', parent_commit_ids: ['p1'], parent_change_ids: ['pc1'] }),
      e({ change_id: 'X', commit_id: 'b', parent_commit_ids: ['p1'], parent_change_ids: ['pc1'] }),
      e({ change_id: 'X', commit_id: 'c', parent_commit_ids: ['p2'], parent_change_ids: ['pc2'] }),
    ])
    expect(groups[0].kind).toBe('compound')
  })

  it('3-way all same parent → same-parent, not compound', () => {
    const groups = classify([
      e({ change_id: 'X', commit_id: 'a', parent_commit_ids: ['p'], parent_change_ids: ['pc'] }),
      e({ change_id: 'X', commit_id: 'b', parent_commit_ids: ['p'], parent_change_ids: ['pc'] }),
      e({ change_id: 'X', commit_id: 'c', parent_commit_ids: ['p'], parent_change_ids: ['pc'] }),
    ])
    expect(groups[0].kind).toBe('same-parent')
  })
})

describe('classify — stack detection', () => {
  // A→B→C→D, 2 copies each (fetch-after-rebase shape). Parent change_ids
  // chain, parent commit_ids differ per copy.
  const fourLevelStack = [
    // /0 chain (wc-reachable)
    e({ change_id: 'A', commit_id: 'a0', parent_commit_ids: ['trunk0'], parent_change_ids: ['TRUNK'], wc_reachable: true }),
    e({ change_id: 'B', commit_id: 'b0', parent_commit_ids: ['a0'],     parent_change_ids: ['A'],     wc_reachable: true }),
    e({ change_id: 'C', commit_id: 'c0', parent_commit_ids: ['b0'],     parent_change_ids: ['B'],     wc_reachable: true }),
    e({ change_id: 'D', commit_id: 'd0', parent_commit_ids: ['c0'],     parent_change_ids: ['C'],     wc_reachable: true, bookmarks: ['my/feature'] }),
    // /1 chain (stale)
    e({ change_id: 'A', commit_id: 'a1', parent_commit_ids: ['trunk1'], parent_change_ids: ['TRUNK'] }),
    e({ change_id: 'B', commit_id: 'b1', parent_commit_ids: ['a1'],     parent_change_ids: ['A'] }),
    e({ change_id: 'C', commit_id: 'c1', parent_commit_ids: ['b1'],     parent_change_ids: ['B'] }),
    e({ change_id: 'D', commit_id: 'd1', parent_commit_ids: ['c1'],     parent_change_ids: ['C'],     bookmarks: ['my/feature'] }),
    // pinning child (automated warm-merge on the stale tip)
    e({ change_id: 'WARM', commit_id: 'warm', parent_commit_ids: ['d1'], parent_change_ids: ['D'], divergent: false, empty: true }),
  ]

  it('groups 4-change stack into one group with root A', () => {
    const groups = classify(fourLevelStack)
    expect(groups).toHaveLength(1)
    expect(groups[0].rootChangeId).toBe('A')
    expect(groups[0].changeIds).toEqual(['A', 'B', 'C', 'D']) // root→tip order
  })

  it('kind comes from the root, not inherited links', () => {
    // A's parents are trunk0/trunk1 (different) → diff-parent.
    // B/C/D's parents share change_ids (A/B/C) — but that's stack inheritance,
    // not same-parent classification.
    const groups = classify(fourLevelStack)
    expect(groups[0].kind).toBe('diff-parent')
  })

  it('versions[i] preserves /N index order', () => {
    // Input order: a0,b0,c0,d0 then a1,b1,c1,d1. For change A: [a0, a1].
    const groups = classify(fourLevelStack)
    expect(groups[0].versions[0].map(v => v.commit_id)).toEqual(['a0', 'a1'])
    expect(groups[0].versions[3].map(v => v.commit_id)).toEqual(['d0', 'd1'])
  })

  it('detects live version when wc_reachable is consistent through stack', () => {
    const groups = classify(fourLevelStack)
    expect(groups[0].liveVersion).toBe(0) // /0 is wc_reachable at every level
  })

  it('attaches pinning descendant (warm-merge on stale tip)', () => {
    const groups = classify(fourLevelStack)
    expect(groups[0].descendants).toHaveLength(1)
    expect(groups[0].descendants[0].commit_id).toBe('warm')
    expect(groups[0].descendants[0].empty).toBe(true)
  })

  it('detects conflicted bookmark at its change_id (not tip)', () => {
    // Bookmark on D in both /0 and /1 → conflict at D, not at stack tip.
    // Repoint should target D's keeper, not blindly the tip.
    const groups = classify(fourLevelStack)
    expect(groups[0].conflictedBookmarks).toEqual([{ name: 'my/feature', changeId: 'D' }])
  })

  it('two independent stacks → two groups', () => {
    const groups = classify([
      ...fourLevelStack,
      e({ change_id: 'Z', commit_id: 'z0', parent_commit_ids: ['other0'], parent_change_ids: ['OTHER'] }),
      e({ change_id: 'Z', commit_id: 'z1', parent_commit_ids: ['other1'], parent_change_ids: ['OTHER'] }),
    ])
    expect(groups).toHaveLength(2)
    const roots = groups.map(g => g.rootChangeId).sort()
    expect(roots).toEqual(['A', 'Z'])
  })
})

describe('classify — column alignment', () => {
  // Agent-found bug: findRoot checks parent CHANGE_IDs match, but /N emission
  // order is per-commit index position. Crossed columns → buildPlan abandons
  // the wrong commits. alignColumns() permutes by parent COMMIT_ID.

  it('permutes crossed columns so versions[L][i] descends from versions[L-1][i]', () => {
    // Scenario from review: A/0=A₂, A/1=A₁, B/0=B₃(parent A₁), B/1=B₂(parent A₂).
    // Emission order for B is [B₃, B₂] (index order), but B₃'s parent is A₁
    // which is column 1. Without alignment: keep(0) → keep {A₂, B₃} but B₃'s
    // parent A₁ gets abandoned → jj auto-rebases B₃ onto trunk, silently wrong.
    const groups = classify([
      e({ change_id: 'A', commit_id: 'a2', parent_commit_ids: ['t2'], parent_change_ids: ['T'] }),
      e({ change_id: 'A', commit_id: 'a1', parent_commit_ids: ['t1'], parent_change_ids: ['T'] }),
      e({ change_id: 'B', commit_id: 'b3', parent_commit_ids: ['a1'], parent_change_ids: ['A'] }), // crosses to col 1
      e({ change_id: 'B', commit_id: 'b2', parent_commit_ids: ['a2'], parent_change_ids: ['A'] }), // crosses to col 0
    ])
    expect(groups).toHaveLength(1)
    // After alignment: col 0 = [a2, b2], col 1 = [a1, b3]
    expect(groups[0].versions[0].map(v => v.commit_id)).toEqual(['a2', 'a1']) // root keeps /N order
    expect(groups[0].versions[1].map(v => v.commit_id)).toEqual(['b2', 'b3']) // permuted
    expect(groups[0].versions[1][0].parent_commit_ids).toContain('a2')         // col 0 chains
  })

  it('bails to compound + alignable=false on arity mismatch (A 2-way, B 3-way)', () => {
    // B diverged twice more than A. Columns don't align 1:1. Panel MUST
    // disable Keep — buildPlan would index versions[1][2] = undefined, or
    // worse, silently never abandon b2.
    const groups = classify([
      e({ change_id: 'A', commit_id: 'a0', parent_commit_ids: ['t0'], parent_change_ids: ['T'] }),
      e({ change_id: 'A', commit_id: 'a1', parent_commit_ids: ['t1'], parent_change_ids: ['T'] }),
      e({ change_id: 'B', commit_id: 'b0', parent_commit_ids: ['a0'], parent_change_ids: ['A'] }),
      e({ change_id: 'B', commit_id: 'b1', parent_commit_ids: ['a1'], parent_change_ids: ['A'] }),
      e({ change_id: 'B', commit_id: 'b2', parent_commit_ids: ['a0'], parent_change_ids: ['A'] }),
    ])
    expect(groups[0].kind).toBe('compound')
    expect(groups[0].alignable).toBe(false)
    expect(groups[0].liveVersion).toBeNull()
  })

  it('bails to compound + alignable=false when a parent has no child at next level', () => {
    // Both B versions descend from a0; a1 has no B child → non-bijective.
    const groups = classify([
      e({ change_id: 'A', commit_id: 'a0', parent_commit_ids: ['t0'], parent_change_ids: ['T'] }),
      e({ change_id: 'A', commit_id: 'a1', parent_commit_ids: ['t1'], parent_change_ids: ['T'] }),
      e({ change_id: 'B', commit_id: 'b0', parent_commit_ids: ['a0'], parent_change_ids: ['A'] }),
      e({ change_id: 'B', commit_id: 'b1', parent_commit_ids: ['a0'], parent_change_ids: ['A'] }),
    ])
    expect(groups[0].kind).toBe('compound')
    expect(groups[0].alignable).toBe(false)
  })

  it('compound via classifyKind (3+ mixed-parent root) is STILL alignable', () => {
    // Single-level, 3 versions, mixed parents. alignColumns trivially succeeds
    // (1 level = nothing to align). Keep is safe — each column is one commit.
    const groups = classify([
      e({ change_id: 'X', commit_id: 'a', parent_commit_ids: ['p1'], parent_change_ids: ['pc1'] }),
      e({ change_id: 'X', commit_id: 'b', parent_commit_ids: ['p1'], parent_change_ids: ['pc1'] }),
      e({ change_id: 'X', commit_id: 'c', parent_commit_ids: ['p2'], parent_change_ids: ['pc2'] }),
    ])
    expect(groups[0].kind).toBe('compound')
    expect(groups[0].alignable).toBe(true) // distinct from alignment-failure compound
  })

  it('leaves already-aligned columns untouched (emission order matches descent)', () => {
    // /N emission happens to match descent chains — no permutation needed.
    const groups = classify([
      e({ change_id: 'A', commit_id: 'a0', parent_commit_ids: ['t0'], parent_change_ids: ['T'] }),
      e({ change_id: 'A', commit_id: 'a1', parent_commit_ids: ['t1'], parent_change_ids: ['T'] }),
      e({ change_id: 'B', commit_id: 'b0', parent_commit_ids: ['a0'], parent_change_ids: ['A'] }),
      e({ change_id: 'B', commit_id: 'b1', parent_commit_ids: ['a1'], parent_change_ids: ['A'] }),
    ])
    expect(groups[0].versions[1].map(v => v.commit_id)).toEqual(['b0', 'b1'])
    expect(groups[0].kind).toBe('diff-parent')
    expect(groups[0].alignable).toBe(true)
  })
})

describe('classify — liveVersion tautology guard', () => {
  it('returns null when @ IS a divergent commit (jj edit inversion)', () => {
    // User saw divergence, jj edit'd into b1 to inspect. Physics of ::@:
    // b1 ∈ ::@ (trivially), a1 ∈ ::@ (b1's parent). a0,b0 ∉ ::@ (different
    // ancestry). So /1 is CONSISTENTLY wc_reachable — geometrically correct,
    // semantically the stale stack. is_working_copy on b1 is the trip wire.
    const groups = classify([
      e({ change_id: 'A', commit_id: 'a0', parent_commit_ids: ['t0'], parent_change_ids: ['T'] }),
      e({ change_id: 'B', commit_id: 'b0', parent_commit_ids: ['a0'], parent_change_ids: ['A'] }),
      e({ change_id: 'A', commit_id: 'a1', parent_commit_ids: ['t1'], parent_change_ids: ['T'], wc_reachable: true }),
      e({ change_id: 'B', commit_id: 'b1', parent_commit_ids: ['a1'], parent_change_ids: ['A'], wc_reachable: true, is_working_copy: true }),
    ])
    expect(groups[0].liveVersion).toBeNull()
  })

  it('returns the live index when @ is on a non-divergent DESCENDANT', () => {
    // @ is on a child of d0 (outside the divergent set). d0's column is
    // wc_reachable by ancestry, d1's is not. is_working_copy is false
    // everywhere in the set → guard doesn't fire → hint is trustworthy.
    const groups = classify([
      e({ change_id: 'D', commit_id: 'd0', parent_commit_ids: ['t0'], parent_change_ids: ['T'], wc_reachable: true }),
      e({ change_id: 'D', commit_id: 'd1', parent_commit_ids: ['t1'], parent_change_ids: ['T'] }),
    ])
    expect(groups[0].liveVersion).toBe(0)
  })

  it('returns null when both versions wc_reachable (two workspaces each on one)', () => {
    // ws1@ descends from a, ws2@ descends from b. Both legitimately live.
    const groups = classify([
      e({ change_id: 'X', commit_id: 'a', parent_commit_ids: ['p'], parent_change_ids: ['pc'], wc_reachable: true }),
      e({ change_id: 'X', commit_id: 'b', parent_commit_ids: ['p'], parent_change_ids: ['pc'], wc_reachable: true }),
    ])
    expect(groups[0].liveVersion).toBeNull()
  })

  it('returns null when neither version wc_reachable', () => {
    // @ moved away entirely — no hint available.
    const groups = classify([
      e({ change_id: 'X', commit_id: 'a', parent_commit_ids: ['p'], parent_change_ids: ['pc'] }),
      e({ change_id: 'X', commit_id: 'b', parent_commit_ids: ['p'], parent_change_ids: ['pc'] }),
    ])
    expect(groups[0].liveVersion).toBeNull()
  })

  it('returns null when @ is on a divergent commit in another group', () => {
    // Guard is per-group: @ on Y/0 doesn't poison X's hint.
    // (versions.flat() scopes to THIS group, not all entries.)
    const groups = classify([
      e({ change_id: 'X', commit_id: 'x0', parent_commit_ids: ['p'], parent_change_ids: ['pc'], wc_reachable: true }),
      e({ change_id: 'X', commit_id: 'x1', parent_commit_ids: ['p'], parent_change_ids: ['pc'] }),
      e({ change_id: 'Y', commit_id: 'y0', parent_commit_ids: ['q'], parent_change_ids: ['qc'], wc_reachable: true, is_working_copy: true }),
      e({ change_id: 'Y', commit_id: 'y1', parent_commit_ids: ['q'], parent_change_ids: ['qc'] }),
    ])
    const gX = groups.find(g => g.rootChangeId === 'X')!
    const gY = groups.find(g => g.rootChangeId === 'Y')!
    expect(gX.liveVersion).toBe(0)   // unaffected
    expect(gY.liveVersion).toBeNull() // guard fires
  })
})

describe('refineRebaseKind — fileUnion subtraction', () => {
  it('all delta files in fileUnion → rebase-edit (real changes)', () => {
    expect(refineRebaseKind(
      ['foo.py', 'bar.py'],
      new Set(['foo.py', 'bar.py']),
    )).toBe('rebase-edit')
  })

  it('no delta files in fileUnion → pure-rebase (all trunk noise)', () => {
    expect(refineRebaseKind(
      ['qux.py', 'unrelated.go'],
      new Set(['foo.py']),
    )).toBe('pure-rebase')
  })

  it('subtraction not one-bit: mixed delta still rebase-edit if any file remains', () => {
    // The adversarial case from docs/jj-divergence.md §"Failed heuristics":
    // foo.py = edit delta, qux.py = trunk churn. Old one-bit heuristic saw
    // qux.py outside fileUnion → "trunk noise, pure rebase" → WRONG, would
    // lose foo.py edit. Subtraction: remove qux.py, foo.py remains → rebase-edit.
    expect(refineRebaseKind(
      ['foo.py', 'qux.py'],
      new Set(['foo.py', 'bar.py']),
    )).toBe('rebase-edit')
  })

  it('empty tree delta → pure-rebase', () => {
    expect(refineRebaseKind([], new Set(['foo.py']))).toBe('pure-rebase')
  })
})

describe('classify — edge cases', () => {
  it('empty input → empty output', () => {
    expect(classify([])).toEqual([])
  })

  it('only non-divergent descendants (shouldn\'t happen, defensive)', () => {
    // Revset guarantees at least one divergent if descendants exist, but.
    expect(classify([
      e({ change_id: 'X', commit_id: 'a', divergent: false }),
    ])).toEqual([])
  })

  it('bookmark on only one version → not conflicted', () => {
    const groups = classify([
      e({ change_id: 'X', commit_id: 'a', parent_commit_ids: ['p'], parent_change_ids: ['pc'], bookmarks: ['feat'] }),
      e({ change_id: 'X', commit_id: 'b', parent_commit_ids: ['p'], parent_change_ids: ['pc'] }),
    ])
    expect(groups[0].conflictedBookmarks).toEqual([])
  })

  it('descendant attaches to correct group when multiple groups exist', () => {
    const groups = classify([
      e({ change_id: 'X', commit_id: 'x0', parent_commit_ids: ['p'], parent_change_ids: ['pc'] }),
      e({ change_id: 'X', commit_id: 'x1', parent_commit_ids: ['p'], parent_change_ids: ['pc'] }),
      e({ change_id: 'Y', commit_id: 'y0', parent_commit_ids: ['q'], parent_change_ids: ['qc'] }),
      e({ change_id: 'Y', commit_id: 'y1', parent_commit_ids: ['q'], parent_change_ids: ['qc'] }),
      e({ change_id: 'Kx', commit_id: 'kx', parent_commit_ids: ['x1'], parent_change_ids: ['X'], divergent: false }),
      e({ change_id: 'Ky', commit_id: 'ky', parent_commit_ids: ['y0'], parent_change_ids: ['Y'], divergent: false }),
    ])
    const gX = groups.find(g => g.rootChangeId === 'X')!
    const gY = groups.find(g => g.rootChangeId === 'Y')!
    expect(gX.descendants.map(d => d.commit_id)).toEqual(['kx'])
    expect(gY.descendants.map(d => d.commit_id)).toEqual(['ky'])
  })
})
