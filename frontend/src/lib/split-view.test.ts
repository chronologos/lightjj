import { describe, it, expect } from 'vitest'
import { toSplitView } from './split-view'
import type { DiffHunk } from './diff-parser'

function makeHunk(lines: { type: 'add' | 'remove' | 'context'; content: string }[]): DiffHunk {
  return { header: '@@ -1 +1 @@', newStart: 1, newCount: 1, lines }
}

describe('toSplitView', () => {
  it('returns empty for no hunks', () => {
    expect(toSplitView([])).toEqual([])
  })

  it('starts each hunk with a header row on both sides', () => {
    const hunks = [makeHunk([])]
    const result = toSplitView(hunks)
    expect(result).toHaveLength(1) // just the header
    expect(result[0].left?.line.type).toBe('header')
    expect(result[0].right?.line.type).toBe('header')
  })

  it('puts context lines on both sides', () => {
    const hunks = [makeHunk([
      { type: 'context', content: ' same' },
    ])]
    const result = toSplitView(hunks)
    // header + 1 context line
    expect(result).toHaveLength(2)
    expect(result[1].left?.line.content).toBe(' same')
    expect(result[1].right?.line.content).toBe(' same')
  })

  it('puts removes on left, adds on right', () => {
    const hunks = [makeHunk([
      { type: 'remove', content: '-old' },
      { type: 'add', content: '+new' },
    ])]
    const result = toSplitView(hunks)
    // header + 1 paired row
    expect(result).toHaveLength(2)
    expect(result[1].left?.line.content).toBe('-old')
    expect(result[1].right?.line.content).toBe('+new')
  })

  it('pads with null when removes outnumber adds', () => {
    const hunks = [makeHunk([
      { type: 'remove', content: '-a' },
      { type: 'remove', content: '-b' },
      { type: 'add', content: '+c' },
    ])]
    const result = toSplitView(hunks)
    // header + 2 rows (padded)
    expect(result).toHaveLength(3)
    expect(result[1].left?.line.content).toBe('-a')
    expect(result[1].right?.line.content).toBe('+c')
    expect(result[2].left?.line.content).toBe('-b')
    expect(result[2].right).toBeNull()
  })

  it('pads with null when adds outnumber removes', () => {
    const hunks = [makeHunk([
      { type: 'remove', content: '-a' },
      { type: 'add', content: '+b' },
      { type: 'add', content: '+c' },
    ])]
    const result = toSplitView(hunks)
    expect(result).toHaveLength(3)
    expect(result[1].left?.line.content).toBe('-a')
    expect(result[1].right?.line.content).toBe('+b')
    expect(result[2].left).toBeNull()
    expect(result[2].right?.line.content).toBe('+c')
  })

  it('flushes pending removes/adds before context', () => {
    const hunks = [makeHunk([
      { type: 'remove', content: '-old' },
      { type: 'context', content: ' mid' },
      { type: 'add', content: '+new' },
    ])]
    const result = toSplitView(hunks)
    // header + remove(left-only) + context(both) + add(right-only)
    expect(result).toHaveLength(4)
    expect(result[1].left?.line.content).toBe('-old')
    expect(result[1].right).toBeNull()
    expect(result[2].left?.line.content).toBe(' mid')
    expect(result[2].right?.line.content).toBe(' mid')
    expect(result[3].left).toBeNull()
    expect(result[3].right?.line.content).toBe('+new')
  })

  it('handles multiple hunks with correct hunkIdx', () => {
    const hunks = [
      makeHunk([{ type: 'remove', content: '-a' }, { type: 'add', content: '+b' }]),
      makeHunk([{ type: 'context', content: ' c' }]),
    ]
    const result = toSplitView(hunks)
    // hunk0: header + 1 paired row = 2, hunk1: header + 1 context = 2
    expect(result).toHaveLength(4)
    // First hunk's content should have hunkIdx 0
    expect(result[1].left?.hunkIdx).toBe(0)
    expect(result[1].right?.hunkIdx).toBe(0)
    // Second hunk's content should have hunkIdx 1
    expect(result[3].left?.hunkIdx).toBe(1)
    expect(result[3].right?.hunkIdx).toBe(1)
  })

  it('handles all-adds hunk (everything on right)', () => {
    const hunks = [makeHunk([
      { type: 'add', content: '+line1' },
      { type: 'add', content: '+line2' },
    ])]
    const result = toSplitView(hunks)
    // header + 2 add rows
    expect(result).toHaveLength(3)
    expect(result[1].left).toBeNull()
    expect(result[1].right?.line.content).toBe('+line1')
    expect(result[2].left).toBeNull()
    expect(result[2].right?.line.content).toBe('+line2')
  })

  it('handles all-removes hunk (everything on left)', () => {
    const hunks = [makeHunk([
      { type: 'remove', content: '-line1' },
      { type: 'remove', content: '-line2' },
    ])]
    const result = toSplitView(hunks)
    // header + 2 remove rows
    expect(result).toHaveLength(3)
    expect(result[1].left?.line.content).toBe('-line1')
    expect(result[1].right).toBeNull()
    expect(result[2].left?.line.content).toBe('-line2')
    expect(result[2].right).toBeNull()
  })

  it('lineIdx values match original hunk line positions', () => {
    const hunks = [makeHunk([
      { type: 'remove', content: '-old' },     // lineIdx 0 in hunk
      { type: 'add', content: '+new' },         // lineIdx 1 in hunk
      { type: 'context', content: ' same' },    // lineIdx 2 in hunk
      { type: 'remove', content: '-another' },  // lineIdx 3 in hunk
    ])]
    const result = toSplitView(hunks)
    // header(0) + paired(1) + context(2) + unpaired-remove(3)
    expect(result).toHaveLength(4)

    // Paired remove/add: lineIdx should be 0 and 1
    expect(result[1].left?.lineIdx).toBe(0)
    expect(result[1].right?.lineIdx).toBe(1)

    // Context: lineIdx should be 2
    expect(result[2].left?.lineIdx).toBe(2)
    expect(result[2].right?.lineIdx).toBe(2) // same side object

    // Unpaired remove: lineIdx should be 3
    expect(result[3].left?.lineIdx).toBe(3)
    expect(result[3].right).toBeNull()
  })
})
