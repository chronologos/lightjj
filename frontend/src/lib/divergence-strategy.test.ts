import { describe, it, expect } from 'vitest'
import { recommend } from './divergence-strategy'
import type { DivergenceGroup } from './divergence'

// Minimal group builder — only fields recommend() reads.
function g(over: Partial<DivergenceGroup>): DivergenceGroup {
  return {
    rootChangeId: 'X',
    changeIds: ['X'],
    versions: [[
      { change_id: 'X', commit_id: 'a', divergent: true, parent_commit_ids: ['p'], parent_change_ids: ['pc'], wc_reachable: false, bookmarks: [], description: '', empty: false, is_working_copy: false },
      { change_id: 'X', commit_id: 'b', divergent: true, parent_commit_ids: ['p'], parent_change_ids: ['pc'], wc_reachable: false, bookmarks: [], description: '', empty: false, is_working_copy: false },
    ]],
    kind: 'same-parent',
    alignable: true,
    liveVersion: null,
    descendants: [],
    conflictedBookmarks: [],
    ...over,
  }
}

describe('recommend — pure-rebase', () => {
  it('high confidence keep-live when liveVersion set', () => {
    const strategies = recommend(g({ liveVersion: 0 }), 'pure-rebase')
    expect(strategies[0]).toMatchObject({ kind: 'keep', targetIdx: 0, confidence: 'high' })
    expect(strategies[0].reason).toContain('/0')
  })

  it('medium/no-target when liveVersion null (tautology guard fired)', () => {
    const strategies = recommend(g({ liveVersion: null }), 'pure-rebase')
    expect(strategies[0]).toMatchObject({ kind: 'keep', targetIdx: null, confidence: 'medium' })
  })
})

describe('recommend — metadata-only', () => {
  it('low confidence, no target — can\'t pick the "right" description', () => {
    const strategies = recommend(g({ liveVersion: 1 }), 'metadata-only')
    // Live hint ignored — it's "which you clicked last", not intent.
    expect(strategies[0]).toMatchObject({ kind: 'keep', targetIdx: null, confidence: 'low' })
  })
})

describe('recommend — edit-conflict', () => {
  it('leads with squash (jj-guide Strategy 3)', () => {
    const strategies = recommend(g({ liveVersion: 0 }), 'edit-conflict')
    expect(strategies[0].kind).toBe('squash')
    expect(strategies[0].targetIdx).toBe(0) // into live
  })

  it('offers keep-live as secondary (for subset case)', () => {
    const strategies = recommend(g({ liveVersion: 1 }), 'edit-conflict')
    expect(strategies[1]).toMatchObject({ kind: 'keep', targetIdx: 1 })
  })

  it('no secondary keep when live null', () => {
    const strategies = recommend(g({ liveVersion: null }), 'edit-conflict')
    expect(strategies).toHaveLength(1)
    expect(strategies[0].kind).toBe('squash')
  })
})

describe('recommend — rebase-edit', () => {
  it('medium keep-live + low squash when live set', () => {
    const strategies = recommend(g({ liveVersion: 1 }), 'rebase-edit')
    expect(strategies[0]).toMatchObject({ kind: 'keep', targetIdx: 1, confidence: 'medium' })
    expect(strategies[1]).toMatchObject({ kind: 'squash', targetIdx: 1, confidence: 'low' })
  })

  it('low squash only when live null', () => {
    const strategies = recommend(g({ liveVersion: null }), 'rebase-edit')
    expect(strategies).toHaveLength(1)
    expect(strategies[0].kind).toBe('squash')
  })
})

describe('recommend — guards', () => {
  it('empty for compound', () => {
    expect(recommend(g({}), 'compound')).toEqual([])
  })

  it('empty for non-alignable', () => {
    expect(recommend(g({ alignable: false }), 'pure-rebase')).toEqual([])
  })

  it('empty for 3+ copies (N-way squash is path-dependent)', () => {
    const threeWay = g({
      versions: [[
        { change_id: 'X', commit_id: 'a', divergent: true, parent_commit_ids: ['p'], parent_change_ids: ['pc'], wc_reachable: false, bookmarks: [], description: '', empty: false, is_working_copy: false },
        { change_id: 'X', commit_id: 'b', divergent: true, parent_commit_ids: ['p'], parent_change_ids: ['pc'], wc_reachable: false, bookmarks: [], description: '', empty: false, is_working_copy: false },
        { change_id: 'X', commit_id: 'c', divergent: true, parent_commit_ids: ['p'], parent_change_ids: ['pc'], wc_reachable: false, bookmarks: [], description: '', empty: false, is_working_copy: false },
      ]],
    })
    expect(recommend(threeWay, 'edit-conflict')).toEqual([])
  })

  it('empty for pending (tree delta not landed)', () => {
    expect(recommend(g({}), 'pending')).toEqual([])
  })

  it('stack: no squash (tip-only resolution leaves intermediates divergent)', () => {
    // 2-level stack, edit-conflict at root. Squash would only resolve tip.
    const stack = g({
      changeIds: ['A', 'B'],
      liveVersion: 0,
    })
    const strategies = recommend(stack, 'edit-conflict')
    // keep-live still offered; squash suppressed
    expect(strategies.some(s => s.kind === 'squash')).toBe(false)
    expect(strategies.some(s => s.kind === 'keep')).toBe(true)
  })

  it('stack: rebase-edit with null live → empty (no squash, no keep without live)', () => {
    const stack = g({ changeIds: ['A', 'B'], liveVersion: null })
    expect(recommend(stack, 'rebase-edit')).toEqual([])
  })
})
