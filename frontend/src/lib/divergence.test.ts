import { describe, it, expect } from 'vitest'
import { classify, refineRebaseKind, buildKeepPlan, type DivergenceGroup } from './divergence'
import type { DivergenceEntry } from './api'
import { entry as e } from './divergence.fixtures'

// Hand-built DivergenceGroup builder — buildKeepPlan tests want empty-versions
// default (override per test), unlike the shared fixture's 2-col default.
// Shared between buildKeepPlan describe + invariant sweep describe below.
const mkGroup = (over: Partial<DivergenceGroup>): DivergenceGroup => ({
  rootChangeId: 'A', changeIds: ['A'], versions: [],
  kind: 'same-parent', alignable: true, liveVersion: null,
  descendants: [], conflictedBookmarks: [],
  ...over,
})

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

  it('descendants contains ONLY direct children of divergent commits (roots, not chains)', () => {
    // D1 hangs off the divergent tip; D2 hangs off D1. Both appear in the
    // revset ((divergent()&mutable())::) but only D1's parent is in the
    // divergent set — D2's parent is D1 which is itself a descendant.
    //
    // This is what makes `jj rebase -s <rebaseSources>` safe: -s D1 -s D2
    // would FLATTEN them (both reparent to dest as siblings, chain broken).
    // -s D1 alone pulls D2 along. The classifier filter gives us roots-only
    // by construction — this test pins that so a future "let's show the
    // whole chain in the UI" refactor can't silently reintroduce flattening.
    const groups = classify([
      e({ change_id: 'X', commit_id: 'x0', parent_commit_ids: ['t0'], parent_change_ids: ['T'] }),
      e({ change_id: 'X', commit_id: 'x1', parent_commit_ids: ['t1'], parent_change_ids: ['T'] }),
      e({ change_id: 'D1', commit_id: 'd1', parent_commit_ids: ['x1'], parent_change_ids: ['X'], divergent: false, empty: false }),
      e({ change_id: 'D2', commit_id: 'd2', parent_commit_ids: ['d1'], parent_change_ids: ['D1'], divergent: false, empty: false }),
    ])
    expect(groups[0].descendants.map(d => d.commit_id)).toEqual(['d1']) // d2 excluded
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

describe('classify — findRoot phantom-edge cycle guard', () => {
  // Real crash (large large repo with warm-merge train, 2026-03-05): 154-node
  // cycle → stack overflow.
  //
  // byChange is filtered by `& mutable()`. A change can be divergent with one
  // mutable copy + one immutable copy; only the mutable one enters byChange.
  // The mutable copy's parent can be the IMMUTABLE copy of another change
  // whose MUTABLE copy is also in byChange. byChange.has(parent_change_id)
  // returns true, but the actual parent commit isn't in the set → recursing
  // follows an edge that doesn't exist in our filtered view of the DAG. One
  // such phantom edge closed a 154-node cycle in a warm-merge chain.

  it('does not recurse through phantom edges (parent change in set, parent COMMIT not)', () => {
    // A's mutable copy has parent_commit=b_imm. B's mutable copy (b_mut) is
    // in byChange. byChange.has('B') is true but b_imm !== b_mut. Without
    // the commit-presence check, findRoot(A) → findRoot(B) via phantom edge.
    const groups = classify([
      e({ change_id: 'A', commit_id: 'a0', parent_commit_ids: ['b_imm'], parent_change_ids: ['B'] }),
      e({ change_id: 'A', commit_id: 'a1', parent_commit_ids: ['b_imm'], parent_change_ids: ['B'] }),
      // B's copy in byChange has a DIFFERENT commit_id than A's actual parent
      e({ change_id: 'B', commit_id: 'b_mut', parent_commit_ids: ['t'], parent_change_ids: ['T'] }),
      e({ change_id: 'B', commit_id: 'b_mut2', parent_commit_ids: ['t'], parent_change_ids: ['T'] }),
    ])
    // A and B are independent roots — NOT chained. The parent-change-id match
    // is a coincidence of change_id reuse across the mutable/immutable boundary.
    expect(groups).toHaveLength(2)
    expect(groups.find(g => g.rootChangeId === 'A')?.changeIds).toEqual(['A'])
    expect(groups.find(g => g.rootChangeId === 'B')?.changeIds).toEqual(['B'])
  })

  it('does not walk single-copy entries (immutable sibling filtered out)', () => {
    // vs.length === 1 → .every() trivially true. With 154 single-copy merges
    // whose parent_change_ids[0] form a phantom cycle, this blew the stack.
    // A single-copy change isn't stack-inherited (nothing to "all agree" on)
    // AND isn't panel-resolvable (can't abandon immutable sibling) — don't walk.
    const groups = classify([
      e({ change_id: 'A', commit_id: 'a', parent_commit_ids: ['pb'], parent_change_ids: ['B'] }),
      e({ change_id: 'B', commit_id: 'b', parent_commit_ids: ['pc'], parent_change_ids: ['C'] }),
      e({ change_id: 'C', commit_id: 'c', parent_commit_ids: ['pa'], parent_change_ids: ['A'] }), // cycle!
    ])
    // Previously: findRoot('A') → findRoot('B') → findRoot('C') → findRoot('A') → ∞
    // Now: each is its own root (vs.length < 2 bails immediately)
    expect(groups).toHaveLength(3)
    for (const g of groups) expect(g.changeIds).toHaveLength(1)
  })

  it('still walks when parent commits ARE in byChange (real stack preserved)', () => {
    // The original 4-change stack: each version's parent_commit_id IS the
    // commit_id of an entry in byChange. Real DAG edges → walk is safe.
    const groups = classify([
      e({ change_id: 'A', commit_id: 'a0', parent_commit_ids: ['t0'], parent_change_ids: ['T'] }),
      e({ change_id: 'A', commit_id: 'a1', parent_commit_ids: ['t1'], parent_change_ids: ['T'] }),
      e({ change_id: 'B', commit_id: 'b0', parent_commit_ids: ['a0'], parent_change_ids: ['A'] }),
      e({ change_id: 'B', commit_id: 'b1', parent_commit_ids: ['a1'], parent_change_ids: ['A'] }),
    ])
    expect(groups).toHaveLength(1)
    expect(groups[0].rootChangeId).toBe('A')
    expect(groups[0].changeIds).toEqual(['A', 'B'])
  })

  it('mixed: one version has in-set parent, other has phantom → NOT inherited', () => {
    // The .every() is what requires ALL versions. If b0's parent a0 is real
    // but b1's parent a_ghost is phantom, B is NOT stack-inherited — only
    // one descent chain exists, the other is into immutable land.
    // (Old code chained them — wrong output, not a crash. Pin both.)
    const groups = classify([
      e({ change_id: 'A', commit_id: 'a0', parent_commit_ids: ['t0'], parent_change_ids: ['T'] }),
      e({ change_id: 'A', commit_id: 'a1', parent_commit_ids: ['t1'], parent_change_ids: ['T'] }),
      e({ change_id: 'B', commit_id: 'b0', parent_commit_ids: ['a0'],      parent_change_ids: ['A'] }),
      e({ change_id: 'B', commit_id: 'b1', parent_commit_ids: ['a_ghost'], parent_change_ids: ['A'] }),
    ])
    expect(groups).toHaveLength(2)
  })

  it('1-copy parent + 2-copy child → child is its own root (parentCommits.size >= 2)', () => {
    // A is divergent-with-immutable-sibling (1 mutable copy). B is genuinely
    // 2-way divergent, both copies descending from A's single mutable commit.
    // With parentCommits.size > 0, findRoot chained B under A → root has
    // nVersions=1 → panel showed "immutable sibling, jj abandon {A's commit}"
    // — but the user clicked B, which IS resolvable. size >= 2 fixes: B's
    // divergence isn't inherited from A (nothing to inherit from a single
    // copy), it's B's own fork. B stays its own root.
    const groups = classify([
      e({ change_id: 'A', commit_id: 'a_only', parent_commit_ids: ['t'], parent_change_ids: ['T'] }),
      e({ change_id: 'B', commit_id: 'b0', parent_commit_ids: ['a_only'], parent_change_ids: ['A'] }),
      e({ change_id: 'B', commit_id: 'b1', parent_commit_ids: ['a_only'], parent_change_ids: ['A'] }),
    ])
    expect(groups).toHaveLength(2)
    const gB = groups.find(g => g.rootChangeId === 'B')!
    expect(gB.changeIds).toEqual(['B'])
    expect(gB.versions[0]).toHaveLength(2) // still 2-way resolvable
    expect(gB.kind).toBe('same-parent')    // both from a_only
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

// --- buildKeepPlan (extracted from DivergencePanel.svelte for testability) ---
// Wrong-column abandon = data loss. Every invariant here corresponds to a
// sentence in the buildKeepPlan comment block or docs/jj-divergence.md.
describe('buildKeepPlan', () => {
  it('abandons ALL levels of losing columns, keeps the keeper column', () => {
    // 3-level stack, 2 columns. Keeping column 1 → abandon {a0,b0,c0}.
    const g = mkGroup({
      changeIds: ['A', 'B', 'C'],
      versions: [
        [e({ commit_id: 'a0' }), e({ commit_id: 'a1' })],
        [e({ commit_id: 'b0' }), e({ commit_id: 'b1' })],
        [e({ commit_id: 'c0' }), e({ commit_id: 'c1' })],
      ],
    })
    const plan = buildKeepPlan(g, 1)
    expect(plan.keeperCommitId).toBe('c1')  // tip of keeper column
    // Set comparison — order is implementation detail (levels-then-cols vs
    // cols-then-levels), jj abandon doesn't care.
    expect(new Set(plan.abandonCommitIds)).toEqual(new Set(['a0', 'b0', 'c0']))
  })

  it('single-level (non-stack): abandons the N-1 losing versions', () => {
    const g = mkGroup({
      changeIds: ['X'],
      versions: [[e({ commit_id: 'v0' }), e({ commit_id: 'v1' }), e({ commit_id: 'v2' })]],
    })
    const plan = buildKeepPlan(g, 0)
    expect(plan.keeperCommitId).toBe('v0')
    // Set comparison — jj abandon takes a revset union, order is irrelevant.
    expect(new Set(plan.abandonCommitIds)).toEqual(new Set(['v1', 'v2']))
  })

  it('MIDDLE-column keeper: both sides abandoned (i !== keeperIdx, not i < or i >)', () => {
    // A bug of the form `i < keeperIdx` would abandon only the left side,
    // silently leaving v2 divergent. `i > keeperIdx` would do the opposite.
    // This is the highest-stakes invariant in buildKeepPlan — wrong-column
    // abandon = data loss OR silent non-resolution.
    const g = mkGroup({
      changeIds: ['X'],
      versions: [[e({ commit_id: 'v0' }), e({ commit_id: 'v1' }), e({ commit_id: 'v2' })]],
    })
    const plan = buildKeepPlan(g, 1)
    expect(plan.keeperCommitId).toBe('v1')
    expect(new Set(plan.abandonCommitIds)).toEqual(new Set(['v0', 'v2']))
    expect(plan.abandonCommitIds).not.toContain('v1')
  })

  it('bookmark repoints to SAME-LEVEL keeper, not the stack tip', () => {
    // Invariant from docs/jj-divergence.md §"Collateral" #2: a bookmark on
    // the MIDDLE of a stack repoints to that change_id's keeper — not jumping
    // forward to the tip. Jumping to tip would move a user's mid-stack
    // checkpoint ahead, breaking their mental model.
    //
    // buildKeepPlan scans v.bookmarks directly (not the pre-computed
    // conflictedBookmarks subset) — fixtures must populate them.
    const g = mkGroup({
      changeIds: ['A', 'B', 'C'],
      versions: [
        [e({ commit_id: 'a0' }), e({ commit_id: 'a1' })],
        [e({ commit_id: 'b0', bookmarks: ['mid-checkpoint'] }), e({ commit_id: 'b1', bookmarks: ['mid-checkpoint'] })],
        [e({ commit_id: 'c0', bookmarks: ['tip'] }), e({ commit_id: 'c1', bookmarks: ['tip'] })],
      ],
    })
    const plan = buildKeepPlan(g, 1)
    expect(plan.bookmarkRepoints).toEqual([
      { name: 'mid-checkpoint', targetCommitId: 'b1' },  // B's keeper, NOT c1
      { name: 'tip', targetCommitId: 'c1' },
    ])
  })

  it('NON-conflicted loser-column bookmark → repointed, not cascaded to trunk', () => {
    // Previously buildKeepPlan only processed conflictedBookmarks (count>1
    // across versions of a change_id). A bookmark on ONLY ONE version of a
    // loser commit (count=1) was skipped → `--retain-bookmarks` auto-moved
    // it to the abandoned commit's parent (trunk for a stack root). Silent
    // cascade-to-trunk. Now ALL loser-column bookmarks repoint.
    const g = mkGroup({
      changeIds: ['A'],
      versions: [[
        e({ commit_id: 'a0', bookmarks: ['only-on-loser'] }),  // bookmark on ONE version
        e({ commit_id: 'a1' }),                                 // keeper has no bookmark
      ]],
    })
    const plan = buildKeepPlan(g, 1)
    expect(plan.bookmarkRepoints).toEqual([
      { name: 'only-on-loser', targetCommitId: 'a1' },  // repointed to keeper
    ])
  })

  it('keeper-column bookmark → NOT repointed (it stays where it is)', () => {
    // Bookmarks on the keeper don't need repointing — the commit they point
    // to is being kept. Only loser columns are scanned.
    const g = mkGroup({
      changeIds: ['A'],
      versions: [[
        e({ commit_id: 'a0' }),
        e({ commit_id: 'a1', bookmarks: ['on-keeper'] }),  // keeper
      ]],
    })
    const plan = buildKeepPlan(g, 1)
    expect(plan.bookmarkRepoints).toEqual([])  // NOT repointed
  })

  it('descendant of KEEPER tip → excluded from collateral (stays valid)', () => {
    // c1 is the keeper tip. A descendant on c1 is still a valid ancestor chain
    // after the abandon — no reason to touch it.
    const g = mkGroup({
      changeIds: ['C'],
      versions: [[e({ commit_id: 'c0' }), e({ commit_id: 'c1' })]],
      descendants: [
        e({ commit_id: 'd_keeper', parent_commit_ids: ['c1'], divergent: false, empty: false }),
        e({ commit_id: 'd_loser', parent_commit_ids: ['c0'], divergent: false, empty: false }),
      ],
    })
    const plan = buildKeepPlan(g, 1)
    // d_keeper is NOT in abandonCommitIds NOR nonEmptyDescendants — excluded entirely.
    expect(plan.abandonCommitIds).toEqual(['c0'])  // only the loser column
    expect(plan.nonEmptyDescendants.map(d => d.commit_id)).toEqual(['d_loser'])
  })

  it('mid-stack descendant → rebaseTarget is keeper at SAME level, not tip', () => {
    // 3-level stack, 2 columns. D branches off level-0 of the loser column.
    // Old behavior: D rebased onto c1 (tip) — wrong, adds b+c's changes to D's base.
    // Correct: D rebases onto a1 (keeper's level 0).
    const g = mkGroup({
      changeIds: ['A', 'B', 'C'],
      versions: [
        [e({ change_id: 'A', commit_id: 'a0' }), e({ change_id: 'A', commit_id: 'a1' })],
        [e({ change_id: 'B', commit_id: 'b0' }), e({ change_id: 'B', commit_id: 'b1' })],
        [e({ change_id: 'C', commit_id: 'c0' }), e({ change_id: 'C', commit_id: 'c1' })],
      ],
      descendants: [
        e({ commit_id: 'd_root', parent_commit_ids: ['a0'], divergent: false, empty: false }),
        e({ commit_id: 'd_mid',  parent_commit_ids: ['b0'], divergent: false, empty: false }),
        e({ commit_id: 'd_tip',  parent_commit_ids: ['c0'], divergent: false, empty: false }),
      ],
    })
    const plan = buildKeepPlan(g, 1)
    const targets = Object.fromEntries(plan.nonEmptyDescendants.map(d => [d.commit_id, d.rebaseTarget]))
    expect(targets.d_root).toBe('a1')  // keeper's level 0
    expect(targets.d_mid).toBe('b1')   // keeper's level 1
    expect(targets.d_tip).toBe('c1')   // keeper's level 2 (= tip — old behavior was correct here)
  })

  it('merge descendant (parents at level 0 AND 2) → rebaseTarget is keeper at MAX level', () => {
    // D merges a0 (level 0) and c0 (level 2). Its base includes a+b+c's content.
    // Rebasing onto keeper[2] preserves that; keeper[0] would drop b+c from D's base.
    const g = mkGroup({
      changeIds: ['A', 'B', 'C'],
      versions: [
        [e({ change_id: 'A', commit_id: 'a0' }), e({ change_id: 'A', commit_id: 'a1' })],
        [e({ change_id: 'B', commit_id: 'b0' }), e({ change_id: 'B', commit_id: 'b1' })],
        [e({ change_id: 'C', commit_id: 'c0' }), e({ change_id: 'C', commit_id: 'c1' })],
      ],
      descendants: [
        e({ commit_id: 'd_merge', parent_commit_ids: ['a0', 'c0'], divergent: false, empty: false }),
      ],
    })
    const plan = buildKeepPlan(g, 1)
    expect(plan.nonEmptyDescendants[0].rebaseTarget).toBe('c1')  // MAX(0,2)=2 → keeper[2]
  })

  it('descendant of keeper ROOT (not tip) → ALSO excluded (multi-level stack)', () => {
    // 2-level stack [[a0,a1],[b0,b1]], keeperIdx=1 keeps a1+b1. A branch off
    // a1 (keeper's ROOT, not tip b1) has parent=a1 which is being KEPT — it
    // must not be abandoned. Tip-only filter would miss this (parent != b1).
    const g = mkGroup({
      changeIds: ['A', 'B'],
      versions: [
        [e({ commit_id: 'a0' }), e({ commit_id: 'a1' })],
        [e({ commit_id: 'b0' }), e({ commit_id: 'b1' })],
      ],
      descendants: [
        e({ commit_id: 'branch_off_keeper_root', parent_commit_ids: ['a1'], divergent: false, empty: true }),
        e({ commit_id: 'branch_off_loser_root', parent_commit_ids: ['a0'], divergent: false, empty: true }),
      ],
    })
    const plan = buildKeepPlan(g, 1)
    // branch_off_keeper_root must NOT be abandoned (a1 is kept).
    expect(plan.abandonCommitIds).not.toContain('branch_off_keeper_root')
    // branch_off_loser_root IS abandoned (a0 is being abandoned).
    expect(plan.abandonCommitIds).toContain('branch_off_loser_root')
  })

  it('empty descendant of loser → silent abandon (no confirm needed)', () => {
    // Empty descendants are likely auto-rebase leftovers. Abandon immediately;
    // only non-empty descendants need user confirmation.
    const g = mkGroup({
      changeIds: ['C'],
      versions: [[e({ commit_id: 'c0' }), e({ commit_id: 'c1' })]],
      descendants: [
        e({ commit_id: 'd_empty', parent_commit_ids: ['c0'], divergent: false, empty: true }),
        e({ commit_id: 'd_full', parent_commit_ids: ['c0'], divergent: false, empty: false }),
      ],
    })
    const plan = buildKeepPlan(g, 1)
    expect(new Set(plan.abandonCommitIds)).toEqual(new Set(['c0', 'd_empty']))
    expect(plan.nonEmptyDescendants.map(d => d.commit_id)).toEqual(['d_full'])
  })

  it('rebaseSources starts empty (populated by confirm resolution, not planning)', () => {
    // rebaseSources is post-confirm state — buildKeepPlan produces the
    // pre-confirm plan. Confirm either appends to abandonCommitIds (discard)
    // or to rebaseSources (keep) — never both.
    const g = mkGroup({
      changeIds: ['X'],
      versions: [[e({ commit_id: 'x0' }), e({ commit_id: 'x1' })]],
      descendants: [e({ commit_id: 'd', parent_commit_ids: ['x0'], divergent: false, empty: false })],
    })
    expect(buildKeepPlan(g, 1).rebaseSources).toEqual([])
  })
})

// --- buildKeepPlan — generative invariant sweep ---
// The hand-picked cases above document intent. This sweep proves the structural
// invariants hold for EVERY {levels, cols, descendants, keeperIdx} combination.
// Wrong-column abandon = data loss, so every invariant corresponds to "if this
// fails, a Keep click destroys user work".
describe('buildKeepPlan — invariant sweep (all shapes)', () => {
  // Generate a group with {levels}×{cols} structure. Commit IDs are
  // deterministic ("L{level}c{col}") so assertions can reference them.
  // Descendants are attached by (parentLevel, parentCol, empty).
  function genGroup(shape: {
    levels: number; cols: number
    descendants: Array<{ parentLevel: number; parentCol: number; empty: boolean }>
    // Bookmarks placed at {name, levelIdx} on ALL columns of that level —
    // buildKeepPlan scans v.bookmarks directly (not conflictedBookmarks), so
    // the fixture must populate them on the version entries too.
    bookmarksAtLevel?: Array<{ name: string; levelIdx: number }>
  }): DivergenceGroup {
    const changeIds = Array.from({ length: shape.levels }, (_, i) => `CH${i}`)
    const bookmarksFor = (L: number) =>
      (shape.bookmarksAtLevel ?? []).filter(b => b.levelIdx === L).map(b => b.name)
    const versions: DivergenceEntry[][] = []
    for (let L = 0; L < shape.levels; L++) {
      const level: DivergenceEntry[] = []
      for (let c = 0; c < shape.cols; c++) {
        level.push(e({
          change_id: changeIds[L],
          commit_id: `L${L}c${c}`,
          parent_commit_ids: L === 0 ? [`trunk${c}`] : [`L${L-1}c${c}`],
          parent_change_ids: L === 0 ? ['TRUNK'] : [changeIds[L-1]],
          bookmarks: bookmarksFor(L),
        }))
      }
      versions.push(level)
    }
    return mkGroup({
      changeIds,
      versions,
      descendants: shape.descendants.map((d, i) => e({
        change_id: `D${i}`, commit_id: `desc${i}`,
        parent_commit_ids: [`L${d.parentLevel}c${d.parentCol}`],
        parent_change_ids: [changeIds[d.parentLevel]],
        divergent: false, empty: d.empty,
      })),
    })
  }

  // Shapes to sweep. Covers: single-level, multi-level, 2-col, 3-col,
  // descendants at root/tip/mid, empty/non-empty, bookmarks at various levels.
  const shapes = [
    { name: '1L×2C', levels: 1, cols: 2, descendants: [] },
    { name: '1L×3C', levels: 1, cols: 3, descendants: [] },
    { name: '3L×2C', levels: 3, cols: 2, descendants: [] },
    { name: '4L×2C + empty desc on loser tip', levels: 4, cols: 2,
      descendants: [{ parentLevel: 3, parentCol: 0, empty: true }] },
    { name: '3L×2C + non-empty desc on loser ROOT', levels: 3, cols: 2,
      descendants: [{ parentLevel: 0, parentCol: 0, empty: false }] },
    // Descendant on the KEEPER's root (not tip). k=1 → parent L0c1 is in
    // keeperColumn → Invariant 4 must exclude it. The hand-picked test at
    // "descendant of keeper ROOT (not tip)" covers 2 levels; this extends to 3.
    { name: '3L×2C + desc on keeper ROOT (when k=1)', levels: 3, cols: 2,
      descendants: [{ parentLevel: 0, parentCol: 1, empty: false }] },
    { name: '2L×2C + desc on BOTH columns (one keeper one loser)', levels: 2, cols: 2,
      descendants: [
        { parentLevel: 1, parentCol: 0, empty: false },
        { parentLevel: 1, parentCol: 1, empty: false },
      ] },
    { name: '2L×3C + desc on middle col', levels: 2, cols: 3,
      descendants: [{ parentLevel: 1, parentCol: 1, empty: true }] },
    { name: '3L×2C + bookmark at mid-level', levels: 3, cols: 2, descendants: [],
      bookmarksAtLevel: [{ name: 'mid', levelIdx: 1 }] },
    { name: '4L×2C + bookmarks at root AND tip', levels: 4, cols: 2, descendants: [],
      bookmarksAtLevel: [{ name: 'r', levelIdx: 0 }, { name: 't', levelIdx: 3 }] },
  ]

  for (const shape of shapes) {
    for (let k = 0; k < shape.cols; k++) {
      it(`${shape.name}, keep col ${k}`, () => {
        const g = genGroup(shape)
        const plan = buildKeepPlan(g, k)
        const keeperColumn = new Set(g.versions.map(l => l[k].commit_id))

        // Invariant 1: keeperCommitId is the tip of column k.
        expect(plan.keeperCommitId).toBe(g.versions[g.versions.length - 1][k].commit_id)

        // Invariant 2: abandonCommitIds is DISJOINT with keeper column.
        for (const id of plan.abandonCommitIds) {
          expect(keeperColumn.has(id)).toBe(false)
        }

        // Invariant 3: every losing-column commit IS abandoned.
        for (const level of g.versions) {
          for (let i = 0; i < level.length; i++) {
            if (i !== k) expect(plan.abandonCommitIds).toContain(level[i].commit_id)
          }
        }

        // Invariant 4: keeper-column descendants appear NOWHERE in the plan.
        for (const d of g.descendants) {
          if (d.parent_commit_ids.some(p => keeperColumn.has(p))) {
            expect(plan.abandonCommitIds).not.toContain(d.commit_id)
            expect(plan.nonEmptyDescendants.map(n => n.commit_id)).not.toContain(d.commit_id)
          }
        }

        // Invariant 5: loser-column descendants are EITHER abandoned (empty)
        // OR in nonEmptyDescendants (confirm) — XOR, never both, never neither.
        for (const d of g.descendants) {
          if (!d.parent_commit_ids.some(p => keeperColumn.has(p))) {
            const abandoned = plan.abandonCommitIds.includes(d.commit_id)
            const pending = plan.nonEmptyDescendants.some(n => n.commit_id === d.commit_id)
            expect(abandoned !== pending).toBe(true)  // XOR
            expect(abandoned).toBe(d.empty)
          }
        }

        // Invariant 6: bookmark repoints target SAME-LEVEL keeper (not tip).
        // Every bookmark on a loser column must appear in bookmarkRepoints;
        // the target must be the keeper at the SAME level the bookmark was on.
        for (const bm of shape.bookmarksAtLevel ?? []) {
          const repoint = plan.bookmarkRepoints.find(r => r.name === bm.name)
          expect(repoint, `bookmark ${bm.name} must be repointed`).toBeDefined()
          expect(repoint!.targetCommitId).toBe(`L${bm.levelIdx}c${k}`)
        }

        // Invariant 7: rebaseSources starts empty (pre-confirm).
        expect(plan.rebaseSources).toEqual([])

        // Invariant 8: nonEmptyDescendants rebaseTarget is keeper at the
        // descendant's parent level (NOT always tip). This is what makes
        // mid-stack branch-offs land at the right height.
        for (let di = 0; di < shape.descendants.length; di++) {
          const sd = shape.descendants[di]
          if (sd.parentCol === k || sd.empty) continue  // keeper-col or empty → not in nonEmptyDescendants
          const d = plan.nonEmptyDescendants.find(n => n.commit_id === `desc${di}`)
          expect(d).toBeDefined()
          expect(d!.rebaseTarget).toBe(`L${sd.parentLevel}c${k}`)
        }
      })
    }
  }
})

// --- classify — merge-parent gap (docs/jj-divergence.md:87 pin tests) ---
// findRoot walks parents[0] only. Divergent merge commits are a documented
// gap. These tests pin CURRENT behavior so a fix is an intentional test change,
// not a silent regression.
describe('classify — merge-parent gap (pin current behavior)', () => {
  it('merge with divergence on SECOND parent only: classified correctly (diff-parent)', () => {
    // X is a merge: parents = [A, B]. X/0 and X/1 share first parent A but
    // differ on second parent (B vs B'). classifyKind compares the full
    // parents.join(',') → different → diff-parent. CORRECT despite the gap
    // in findRoot (which isn't exercised here — A isn't divergent).
    const groups = classify([
      e({ change_id: 'X', commit_id: 'x0', parent_commit_ids: ['a', 'b0'], parent_change_ids: ['A', 'B'] }),
      e({ change_id: 'X', commit_id: 'x1', parent_commit_ids: ['a', 'b1'], parent_change_ids: ['A', 'B'] }),
    ])
    expect(groups).toHaveLength(1)
    expect(groups[0].kind).toBe('diff-parent')
    expect(groups[0].rootChangeId).toBe('X')
  })

  it('merge with divergent FIRST parent: chains via parents[0] (gap — may over-chain)', () => {
    // A is 2-way divergent. X is a merge with A as FIRST parent; X diverged
    // because A did. Current findRoot chains X under A via parents[0].
    // CORRECT for this shape. The gap: if X's divergence were on its SECOND
    // parent only (unrelated to A), findRoot would STILL chain (walks [0]
    // only) — that case is the test above which happens to work because A
    // isn't divergent there. Pin the happy-path behavior.
    const groups = classify([
      e({ change_id: 'A', commit_id: 'a0', parent_commit_ids: ['t0'], parent_change_ids: ['T'] }),
      e({ change_id: 'A', commit_id: 'a1', parent_commit_ids: ['t1'], parent_change_ids: ['T'] }),
      e({ change_id: 'X', commit_id: 'x0', parent_commit_ids: ['a0', 'b'], parent_change_ids: ['A', 'B'] }),
      e({ change_id: 'X', commit_id: 'x1', parent_commit_ids: ['a1', 'b'], parent_change_ids: ['A', 'B'] }),
    ])
    expect(groups).toHaveLength(1)
    expect(groups[0].rootChangeId).toBe('A')
    expect(groups[0].changeIds).toEqual(['A', 'X'])
  })

  it('diamond (both B copies from same A-commit): findRoot chains but alignColumns rejects', () => {
    // B is independently resolvable as same-parent (both from a0), but the
    // chain→reject path shows "compound, manual only" for both. No data loss
    // (Keep is disabled), but the user can't one-click resolve B. Future fix:
    // findRoot could add "parent commits DISTINCT across versions" to the
    // inherits check; for now, pin the safe-but-suboptimal behavior.
    const groups = classify([
      e({ change_id: 'A', commit_id: 'a0', parent_commit_ids: ['t0'], parent_change_ids: ['T'] }),
      e({ change_id: 'A', commit_id: 'a1', parent_commit_ids: ['t1'], parent_change_ids: ['T'] }),
      e({ change_id: 'B', commit_id: 'b0', parent_commit_ids: ['a0'], parent_change_ids: ['A'] }),
      e({ change_id: 'B', commit_id: 'b1', parent_commit_ids: ['a0'], parent_change_ids: ['A'] }),
    ])
    expect(groups).toHaveLength(1)
    expect(groups[0].changeIds).toEqual(['A', 'B'])  // chained
    expect(groups[0].alignable).toBe(false)           // but safely rejected
  })
})
