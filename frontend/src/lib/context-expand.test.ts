import { describe, it, expect } from 'vitest'
import { expandGaps } from './context-expand'
import type { DiffFile, DiffLine } from './diff-parser'

const ctx = (s: string): DiffLine => ({ type: 'context', content: ` ${s}` })
const add = (s: string): DiffLine => ({ type: 'add', content: `+${s}` })

// 10-line file, hunks at lines 3 and 8.
const original: DiffFile = {
  header: '', filePath: 'f.txt',
  hunks: [
    { header: '@@', oldStart: 3, newStart: 3, newCount: 1, lines: [add('C')] },
    { header: '@@', oldStart: 8, newStart: 8, newCount: 1, lines: [add('H')] },
  ],
}

// Full-context: single hunk from line 1, all 10 lines.
const full: DiffFile = {
  header: '', filePath: 'f.txt',
  hunks: [{
    header: '@@', oldStart: 1, newStart: 1, newCount: 10,
    lines: [ctx('a'), ctx('b'), add('C'), ctx('d'), ctx('e'), ctx('f'), ctx('g'), add('H'), ctx('i'), ctx('j')],
  }],
}

describe('expandGaps', () => {
  it('empty set → original unchanged, identity gapMap', () => {
    const r = expandGaps(original, full, new Set())
    expect(r.file).toBe(original)
    expect(r.gapMap).toEqual([0, 1, 2])
  })

  it('gap 0 → prepends file-start context, hunk starts at line 1', () => {
    const r = expandGaps(original, full, new Set([0]))
    expect(r.file.hunks).toHaveLength(2)
    expect(r.file.hunks[0].newStart).toBe(1)
    expect(r.file.hunks[0].lines.map(l => l.content)).toEqual([' a', ' b', '+C'])
    expect(r.file.hunks[1]).toEqual(original.hunks[1])
    expect(r.gapMap).toEqual([0, 1, 2])  // still 2 hunks → same shape
  })

  it('gap 1 → merges hunk 0+1, gapMap skips merged index', () => {
    const r = expandGaps(original, full, new Set([1]))
    expect(r.file.hunks).toHaveLength(1)
    expect(r.file.hunks[0].newStart).toBe(3)
    expect(r.file.hunks[0].lines.map(l => l.content))
      .toEqual(['+C', ' d', ' e', ' f', ' g', '+H'])
    // 1 effective hunk → 2 effective gaps. Gap-before = orig 0, trailing = orig 2.
    expect(r.gapMap).toEqual([0, 2])
  })

  it('trailing gap → appends end-of-file context to last hunk', () => {
    const r = expandGaps(original, full, new Set([2]))
    expect(r.file.hunks).toHaveLength(2)
    expect(r.file.hunks[1].lines.map(l => l.content)).toEqual(['+H', ' i', ' j'])
    expect(r.gapMap).toEqual([0, 1, 2])
  })

  it('all gaps → single hunk equivalent to full', () => {
    const r = expandGaps(original, full, new Set([0, 1, 2]))
    expect(r.file.hunks).toHaveLength(1)
    expect(r.file.hunks[0].newStart).toBe(1)
    expect(r.file.hunks[0].lines).toHaveLength(10)
  })

  it('does not mutate inputs', () => {
    const origLen = original.hunks[0].lines.length
    expandGaps(original, full, new Set([0, 1, 2]))
    expect(original.hunks[0].lines).toHaveLength(origLen)
  })

  it('gap 0 → uses full.newStart, not 1, for the merged-hunk start (deep file)', () => {
    // Scale model: the production scenario is a ~30000-line file with its
    // first change at e.g. line 15005, where `--context 10000` clamps the
    // full hunk to start at line 5005. The fixture compresses to 5005/5000
    // so the slice is readable while still exercising `full.newStart > 1`.
    // Hardcoding 1 would build a merged hunk claiming newStart:1 whose first
    // gap line is actually full.newStart, shifting every gutter line number
    // and annotation key by full.newStart - 1.
    const orig: DiffFile = {
      header: '', filePath: 'big.go',
      hunks: [{ header: '@@', oldStart: 5005, newStart: 5005, newCount: 1, lines: [add('X')] }],
    }
    const fullDeep: DiffFile = {
      header: '', filePath: 'big.go',
      hunks: [{
        header: '@@', oldStart: 5000, newStart: 5000, newCount: 6,
        lines: [ctx('a'), ctx('b'), ctx('c'), ctx('d'), ctx('e'), add('X')],
      }],
    }
    const r = expandGaps(orig, fullDeep, new Set([0]))
    expect(r.file.hunks).toHaveLength(1)
    expect(r.file.hunks[0].newStart).toBe(5000)
    expect(r.file.hunks[0].oldStart).toBe(5000)
    expect(r.file.hunks[0].lines.map(l => l.content)).toEqual([' a', ' b', ' c', ' d', ' e', '+X'])
  })

  // Multi-hunk full: `--context 10000` collapses to one hunk only when changes
  // are <20001 lines apart. With a wider separation, full has 2 hunks and
  // sliceContext must walk past the first one.
  const origWide: DiffFile = {
    header: '', filePath: 'f.go',
    hunks: [
      { header: '@@', oldStart: 3, newStart: 3, newCount: 1, lines: [add('A')] },
      { header: '@@', oldStart: 30000, newStart: 30000, newCount: 1, lines: [add('B')] },
    ],
  }
  const fullWide: DiffFile = {
    header: '', filePath: 'f.go',
    hunks: [
      { header: '@@', oldStart: 1, newStart: 1, newCount: 5, lines: [ctx('a'), ctx('b'), add('A'), ctx('d'), ctx('e')] },
      { header: '@@', oldStart: 29998, newStart: 29998, newCount: 5, lines: [ctx('w'), ctx('x'), add('B'), ctx('y'), ctx('z')] },
    ],
  }

  it('trailing gap reads from later hunks of a multi-hunk full', () => {
    // Original last hunk (line 30000) is in fullWide.hunks[1]. Reading only
    // hunks[0] would return [] for the trailing gap → button vanishes silently.
    const r = expandGaps(origWide, fullWide, new Set([2]))
    expect(r.file.hunks).toHaveLength(2)
    expect(r.file.hunks[1].lines.map(l => l.content)).toEqual(['+B', ' y', ' z'])
    expect(r.file.hunks[1].newCount).toBe(3)
  })

  it('refuses to merge a gap that straddles a multi-hunk void (preserves line numbers)', () => {
    // Gap 1 spans [4, 30000) but fullWide only covers [1,6) and [29998,30003) —
    // the 29992 lines in between aren't in the fetch. Merging the partial slice
    // would assign sequential numbers across the void, shifting every gutter
    // number and annotation key after it. Leave the hunks unmerged instead.
    const r = expandGaps(origWide, fullWide, new Set([1]))
    expect(r.file.hunks).toHaveLength(2)
    expect(r.file.hunks[0].lines.map(l => l.content)).toEqual(['+A'])
    expect(r.file.hunks[1].lines.map(l => l.content)).toEqual(['+B'])
    expect(r.gapMap).toEqual([0, 1, 2])
  })

  it('gap 0 reads from hunks[0] of a multi-hunk full', () => {
    const r = expandGaps(origWide, fullWide, new Set([0]))
    expect(r.file.hunks).toHaveLength(2)
    expect(r.file.hunks[0].newStart).toBe(1)
    expect(r.file.hunks[0].lines.map(l => l.content)).toEqual([' a', ' b', '+A'])
  })

  it('zero-width gap 0 (full.newStart === orig.newStart) merges with no lines added', () => {
    // Locks the `===` boundary in the covered check: gap.length(0) === to-from(0)
    // → covered → merge fires with an empty gap. A future `>=` slip would
    // also pass here but break the straddle test above; this pins the lower edge.
    const orig: DiffFile = {
      header: '', filePath: 'f.txt',
      hunks: [{ header: '@@', oldStart: 5, newStart: 5, newCount: 1, lines: [add('X')] }],
    }
    const fullSame: DiffFile = {
      header: '', filePath: 'f.txt',
      hunks: [{ header: '@@', oldStart: 5, newStart: 5, newCount: 1, lines: [add('X')] }],
    }
    const r = expandGaps(orig, fullSame, new Set([0]))
    expect(r.file.hunks).toHaveLength(1)
    expect(r.file.hunks[0].newStart).toBe(5)
    expect(r.file.hunks[0].lines.map(l => l.content)).toEqual(['+X'])
  })
})
