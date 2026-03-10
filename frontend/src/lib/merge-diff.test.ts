import { describe, it, expect } from 'vitest'
import { diffLineSets, diffBlocks } from './merge-diff'

describe('diffLineSets', () => {
  it('identical → empty sets', () => {
    const a = ['foo', 'bar', 'baz']
    const r = diffLineSets(a, a)
    expect(r.aOnly.size).toBe(0)
    expect(r.bOnly.size).toBe(0)
  })

  it('single mid-line change', () => {
    const a = ['foo', 'bar', 'baz']
    const b = ['foo', 'BAR', 'baz']
    const r = diffLineSets(a, b)
    expect([...r.aOnly]).toEqual([2])
    expect([...r.bOnly]).toEqual([2])
  })

  it('insertion in b', () => {
    const a = ['a', 'c']
    const b = ['a', 'b', 'c']
    const r = diffLineSets(a, b)
    expect(r.aOnly.size).toBe(0)
    expect([...r.bOnly]).toEqual([2])
  })

  it('deletion from a', () => {
    const a = ['a', 'b', 'c']
    const b = ['a', 'c']
    const r = diffLineSets(a, b)
    expect([...r.aOnly]).toEqual([2])
    expect(r.bOnly.size).toBe(0)
  })

  it('totally different → all lines on both sides', () => {
    const a = ['x', 'y']
    const b = ['p', 'q', 'r']
    const r = diffLineSets(a, b)
    expect([...r.aOnly].sort()).toEqual([1, 2])
    expect([...r.bOnly].sort()).toEqual([1, 2, 3])
  })

  it('empty a → all of b is bOnly', () => {
    const r = diffLineSets([], ['x', 'y'])
    expect(r.aOnly.size).toBe(0)
    expect([...r.bOnly].sort()).toEqual([1, 2])
  })

  it('both empty', () => {
    const r = diffLineSets([], [])
    expect(r.aOnly.size).toBe(0)
    expect(r.bOnly.size).toBe(0)
  })

  it('repeated lines — LCS picks longest common subsequence', () => {
    const a = ['x', 'x', 'y']
    const b = ['x', 'y']
    const r = diffLineSets(a, b)
    // One of the 'x's in a is extra. LCS = ['x', 'y'] → aOnly has exactly 1.
    expect(r.aOnly.size).toBe(1)
    expect(r.bOnly.size).toBe(0)
  })
})

describe('diffBlocks', () => {
  it('identical → no blocks', () => {
    expect(diffBlocks(['a', 'b'], ['a', 'b'])).toEqual([])
  })

  it('single mid-line change → one block', () => {
    const r = diffBlocks(['foo', 'bar', 'baz'], ['foo', 'BAR', 'baz'])
    expect(r).toEqual([{ aFrom: 2, aTo: 3, bFrom: 2, bTo: 3 }])
  })

  it('insertion in b → block with empty a-range', () => {
    // a=['a','c'] b=['a','b','c'] → b added line 2
    const r = diffBlocks(['a', 'c'], ['a', 'b', 'c'])
    expect(r).toEqual([{ aFrom: 2, aTo: 2, bFrom: 2, bTo: 3 }])
  })

  it('deletion from a → block with empty b-range', () => {
    const r = diffBlocks(['a', 'b', 'c'], ['a', 'c'])
    expect(r).toEqual([{ aFrom: 2, aTo: 3, bFrom: 2, bTo: 2 }])
  })

  it('two separate conflict regions → two blocks', () => {
    const a = ['same', 'ours1', 'same', 'ours2', 'same']
    const b = ['same', 'theirs1', 'same', 'theirs2', 'same']
    const r = diffBlocks(a, b)
    expect(r).toEqual([
      { aFrom: 2, aTo: 3, bFrom: 2, bTo: 3 },
      { aFrom: 4, aTo: 5, bFrom: 4, bTo: 5 },
    ])
  })

  it('multi-line replacement block', () => {
    const a = ['head', 'x1', 'x2', 'tail']
    const b = ['head', 'y1', 'y2', 'y3', 'tail']
    const r = diffBlocks(a, b)
    expect(r).toEqual([{ aFrom: 2, aTo: 4, bFrom: 2, bTo: 5 }])
  })

  it('leading + trailing changes', () => {
    const a = ['A', 'mid', 'C']
    const b = ['X', 'mid', 'Z']
    const r = diffBlocks(a, b)
    expect(r).toEqual([
      { aFrom: 1, aTo: 2, bFrom: 1, bTo: 2 },
      { aFrom: 3, aTo: 4, bFrom: 3, bTo: 4 },
    ])
  })

  it('empty a → one block covering all of b', () => {
    const r = diffBlocks([], ['x', 'y'])
    expect(r).toEqual([{ aFrom: 1, aTo: 1, bFrom: 1, bTo: 3 }])
  })

  it('both empty → no blocks', () => {
    expect(diffBlocks([], [])).toEqual([])
  })

  it('merge semantics: applying ours-block to theirs produces ours', () => {
    // Round-trip check — the whole point of ChangeBlock.
    const ours = ['shared', 'OURS-A', 'OURS-B', 'mid', 'OURS-C', 'end']
    const theirs = ['shared', 'theirs-a', 'mid', 'theirs-c', 'theirs-d', 'end']
    const blocks = diffBlocks(ours, theirs)
    // Apply each block (replace theirs[bFrom..bTo) with ours[aFrom..aTo))
    // in reverse order so indices stay valid.
    let result = theirs.slice()
    for (const blk of [...blocks].reverse()) {
      const oursSlice = ours.slice(blk.aFrom - 1, blk.aTo - 1)
      result.splice(blk.bFrom - 1, blk.bTo - blk.bFrom, ...oursSlice)
    }
    expect(result).toEqual(ours)
  })
})
