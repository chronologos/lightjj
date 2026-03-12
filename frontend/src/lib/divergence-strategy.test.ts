import { describe, it, expect } from 'vitest'
import { recommend } from './divergence-strategy'
import { entry, group as g } from './divergence.fixtures'

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
        entry({ commit_id: 'a' }), entry({ commit_id: 'b' }), entry({ commit_id: 'c' }),
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

// Full decision-table sweep — fills the gaps between the hand-picked cases
// above. Each row is one cell of (refined × live × isStack). Existing tests
// above document INTENT; this table proves TOTALITY (no unhandled combinations).
describe('recommend — decision table sweep', () => {
  type Row = {
    refined: Parameters<typeof recommend>[1]
    live: number | null
    isStack: boolean
    expectLen: number
    primary?: { kind: 'keep' | 'squash'; targetIdx: number | null; conf: 'high' | 'medium' | 'low' }
  }

  const table: Row[] = [
    // ── pure-rebase ──────────────────────────────────────────────────────
    { refined: 'pure-rebase', live: 0,    isStack: false, expectLen: 1, primary: { kind: 'keep', targetIdx: 0,    conf: 'high' } },
    { refined: 'pure-rebase', live: null, isStack: false, expectLen: 1, primary: { kind: 'keep', targetIdx: null, conf: 'medium' } },
    { refined: 'pure-rebase', live: 0,    isStack: true,  expectLen: 1, primary: { kind: 'keep', targetIdx: 0,    conf: 'high' } },
    { refined: 'pure-rebase', live: null, isStack: true,  expectLen: 1, primary: { kind: 'keep', targetIdx: null, conf: 'medium' } },

    // ── metadata-only ────────────────────────────────────────────────────
    { refined: 'metadata-only', live: 0,    isStack: false, expectLen: 1, primary: { kind: 'keep', targetIdx: null, conf: 'low' } },
    { refined: 'metadata-only', live: null, isStack: false, expectLen: 1, primary: { kind: 'keep', targetIdx: null, conf: 'low' } },
    { refined: 'metadata-only', live: 0,    isStack: true,  expectLen: 1, primary: { kind: 'keep', targetIdx: null, conf: 'low' } },

    // ── edit-conflict ────────────────────────────────────────────────────
    { refined: 'edit-conflict', live: 0,    isStack: false, expectLen: 2, primary: { kind: 'squash', targetIdx: 0,    conf: 'medium' } },
    { refined: 'edit-conflict', live: null, isStack: false, expectLen: 1, primary: { kind: 'squash', targetIdx: null, conf: 'medium' } },
    { refined: 'edit-conflict', live: 0,    isStack: true,  expectLen: 1, primary: { kind: 'keep',   targetIdx: 0,    conf: 'low' } },
    { refined: 'edit-conflict', live: null, isStack: true,  expectLen: 0 },

    // ── rebase-edit ──────────────────────────────────────────────────────
    { refined: 'rebase-edit', live: 1,    isStack: false, expectLen: 2, primary: { kind: 'keep',   targetIdx: 1,    conf: 'medium' } },
    { refined: 'rebase-edit', live: null, isStack: false, expectLen: 1, primary: { kind: 'squash', targetIdx: null, conf: 'low' } },
    { refined: 'rebase-edit', live: 1,    isStack: true,  expectLen: 1, primary: { kind: 'keep',   targetIdx: 1,    conf: 'medium' } },
    { refined: 'rebase-edit', live: null, isStack: true,  expectLen: 0 },

    // ── compound / pending (always empty) ────────────────────────────────
    { refined: 'compound', live: 0,    isStack: false, expectLen: 0 },
    { refined: 'compound', live: null, isStack: true,  expectLen: 0 },
    { refined: 'pending',  live: 0,    isStack: false, expectLen: 0 },
    { refined: 'pending',  live: null, isStack: true,  expectLen: 0 },
  ]

  for (const row of table) {
    const stackTag = row.isStack ? 'stack' : 'single'
    const liveTag = row.live === null ? 'no-live' : `live=${row.live}`
    it(`${row.refined} × ${liveTag} × ${stackTag}`, () => {
      const grp = g({ liveVersion: row.live, changeIds: row.isStack ? ['A', 'B'] : ['X'] })
      const out = recommend(grp, row.refined)
      expect(out).toHaveLength(row.expectLen)
      if (row.primary) {
        expect(out[0]).toMatchObject({
          kind: row.primary.kind,
          targetIdx: row.primary.targetIdx,
          confidence: row.primary.conf,
        })
      }
    })
  }
})
