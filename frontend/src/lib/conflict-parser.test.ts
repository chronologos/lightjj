import { describe, it, expect } from 'vitest'
import { findConflicts } from './conflict-parser'
import type { DiffLine } from './diff-parser'

function addLine(content: string): DiffLine {
  return { type: 'add', content }
}

function ctxLine(content: string): DiffLine {
  return { type: 'context', content }
}

describe('findConflicts', () => {
  it('returns empty for no conflicts', () => {
    const lines: DiffLine[] = [
      addLine('+normal add line'),
      ctxLine(' context line'),
    ]
    expect(findConflicts(lines)).toEqual([])
  })

  it('detects a single conflict', () => {
    const lines: DiffLine[] = [
      ctxLine(' before'),
      addLine('+<<<<<<< Conflict 1 of 1'),
      addLine('+%%%%%%% Changes from base to side #1'),
      addLine('+-old line'),
      addLine('++side 1 line'),
      addLine('++++++++ Contents of side #2'),
      addLine('+side 2 line'),
      addLine('+>>>>>>> Conflict 1 of 1 ends'),
      ctxLine(' after'),
    ]
    const regions = findConflicts(lines)
    expect(regions).toHaveLength(1)
    expect(regions[0].startIdx).toBe(1)
    expect(regions[0].endIdx).toBe(7)
    expect(regions[0].label).toBe('Conflict 1 of 1')
    expect(regions[0].sides).toHaveLength(2)
    expect(regions[0].sides[0].type).toBe('diff')
    expect(regions[0].sides[0].startIdx).toBe(2)
    expect(regions[0].sides[0].endIdx).toBe(4)
    expect(regions[0].sides[1].type).toBe('snapshot')
    expect(regions[0].sides[1].startIdx).toBe(5)
    expect(regions[0].sides[1].endIdx).toBe(6)
  })

  it('detects multiple conflicts', () => {
    const lines: DiffLine[] = [
      addLine('+<<<<<<< Conflict 1 of 2'),
      addLine('+%%%%%%% Changes from base to side #1'),
      addLine('+line1'),
      addLine('++++++++ Contents of side #2'),
      addLine('+line2'),
      addLine('+>>>>>>> Conflict 1 of 2 ends'),
      ctxLine(' between'),
      addLine('+<<<<<<< Conflict 2 of 2'),
      addLine('+%%%%%%% Changes from base to side #1'),
      addLine('+line3'),
      addLine('++++++++ Contents of side #2'),
      addLine('+line4'),
      addLine('+>>>>>>> Conflict 2 of 2 ends'),
    ]
    const regions = findConflicts(lines)
    expect(regions).toHaveLength(2)
    expect(regions[0].label).toBe('Conflict 1 of 2')
    expect(regions[1].label).toBe('Conflict 2 of 2')
    expect(regions[1].startIdx).toBe(7)
    expect(regions[1].endIdx).toBe(12)
  })

  it('ignores context lines inside conflict regions', () => {
    const lines: DiffLine[] = [
      addLine('+<<<<<<< Conflict 1 of 1'),
      addLine('+%%%%%%% Changes'),
      ctxLine(' this is context, not part of conflict content'),
      addLine('+side 1'),
      addLine('++++++++ Side #2'),
      addLine('+side 2'),
      addLine('+>>>>>>> Conflict 1 of 1 ends'),
    ]
    const regions = findConflicts(lines)
    expect(regions).toHaveLength(1)
    // Context line at index 2 is skipped; diff side runs from marker at 1 to add at 3
    expect(regions[0].sides[0].startIdx).toBe(1)
    expect(regions[0].sides[0].endIdx).toBe(3)
  })

  it('handles unterminated conflict at EOF', () => {
    const lines: DiffLine[] = [
      addLine('+<<<<<<< Conflict 1 of 1'),
      addLine('+%%%%%%% side #1'),
      addLine('+content'),
      // no >>>>>>> line
    ]
    const regions = findConflicts(lines)
    expect(regions).toHaveLength(1)
    expect(regions[0].startIdx).toBe(0)
    expect(regions[0].endIdx).toBe(2) // last line
    expect(regions[0].sides).toHaveLength(1)
  })

  it('handles empty snapshot side', () => {
    const lines: DiffLine[] = [
      addLine('+<<<<<<< Conflict 1 of 1'),
      addLine('+%%%%%%% Changes from base to side #1'),
      addLine('+content'),
      addLine('++++++++ Contents of side #2'),
      addLine('+>>>>>>> Conflict 1 of 1 ends'),
    ]
    const regions = findConflicts(lines)
    expect(regions).toHaveLength(1)
    expect(regions[0].sides).toHaveLength(2)
    // Empty snapshot: startIdx === endIdx (marker only)
    expect(regions[0].sides[1].startIdx).toBe(3)
    expect(regions[0].sides[1].endIdx).toBe(3)
  })

  it('ignores conflict-like text in context lines', () => {
    const lines: DiffLine[] = [
      ctxLine(' <<<<<<< this is just content'),
      ctxLine(' >>>>>>> also content'),
    ]
    expect(findConflicts(lines)).toEqual([])
  })

  it('handles conflict with only diff section (no snapshot)', () => {
    // Edge case: only one side
    const lines: DiffLine[] = [
      addLine('+<<<<<<< Conflict 1 of 1'),
      addLine('+%%%%%%% Changes from base to side #1'),
      addLine('+content'),
      addLine('+>>>>>>> Conflict 1 of 1 ends'),
    ]
    const regions = findConflicts(lines)
    expect(regions).toHaveLength(1)
    expect(regions[0].sides).toHaveLength(1)
    expect(regions[0].sides[0].type).toBe('diff')
  })

  it('extracts commit description as side label (no \\ sub-marker)', () => {
    // Without a \\\\\\\ "to:" sub-marker, the %%%%%%% "from" label stays.
    const lines: DiffLine[] = [
      addLine('+<<<<<<< Conflict 1 of 1'),
      addLine('+%%%%%%% diff from: lpymxuwk 75ef1147 "Conflict resolution"'),
      addLine('+content'),
      addLine('++++++++ wlykovwr 562576c8 "side Y: modify existing file differently"'),
      addLine('+content2'),
      addLine('+>>>>>>> Conflict 1 of 1 ends'),
    ]
    const regions = findConflicts(lines)
    expect(regions[0].sides[0].label).toBe('Conflict resolution')
    expect(regions[0].sides[1].label).toBe('side Y: modify existing file differently')
  })

  it('diff side label is the "to" commit, not "from" (\\ sub-marker overwrites)', () => {
    // CRITICAL SEMANTICS: :ours/:theirs keeps the side's RESULT state.
    // For %%%%%%% diff sides, that's the "to" commit (\\\\\\\ marker),
    // NOT the "from" commit (%%%%%%% marker). The button must say
    // "Keep <to>" so users know what they're choosing.
    const lines: DiffLine[] = [
      addLine('+<<<<<<< Conflict 1 of 1'),
      addLine('+%%%%%%% diff from: aaaa1111 "the base state"'),
      addLine('+\\\\\\\\\\\\\\        to: bbbb2222 "the result state"'),
      addLine('+-removed'),
      addLine('++added'),
      addLine('++++++++ cccc3333 "other side"'),
      addLine('+snapshot content'),
      addLine('+>>>>>>> Conflict 1 of 1 ends'),
    ]
    const regions = findConflicts(lines)
    expect(regions[0].sides[0].type).toBe('diff')
    expect(regions[0].sides[0].label).toBe('the result state')  // what :ours KEEPS — NOT "the base state"
    expect(regions[0].sides[1].type).toBe('snapshot')
    expect(regions[0].sides[1].label).toBe('other side')         // what :theirs KEEPS
  })

  it('falls back to raw marker text when no quoted description', () => {
    const lines: DiffLine[] = [
      addLine('+<<<<<<< Conflict 1 of 1'),
      addLine('+%%%%%%% Changes from base to side #1'),
      addLine('+content'),
      addLine('++++++++ Contents of side #2'),
      addLine('+content2'),
      addLine('+>>>>>>> Conflict 1 of 1 ends'),
    ]
    const regions = findConflicts(lines)
    expect(regions[0].sides[0].label).toBe('Changes from base to side #1')
    expect(regions[0].sides[1].label).toBe('Contents of side #2')
  })

  it('parses 3-way conflict (2 diff + 1 snapshot)', () => {
    const lines = [
      addLine('+<<<<<<< Conflict 1 of 1'),
      addLine('+%%%%%%% diff from: "side A"'),
      addLine('+-old line A'),
      addLine('++new line A'),
      addLine('+%%%%%%% diff from: "side B"'),
      addLine('+-old line B'),
      addLine('++new line B'),
      addLine('++++++++ "side C"'),
      addLine('+content from C'),
      addLine('+>>>>>>> Conflict 1 of 1 ends'),
    ]
    const regions = findConflicts(lines)
    expect(regions).toHaveLength(1)
    expect(regions[0].sides).toHaveLength(3)
    expect(regions[0].sides[0].type).toBe('diff')
    expect(regions[0].sides[1].type).toBe('diff')
    expect(regions[0].sides[2].type).toBe('snapshot')
    // Side boundaries are correct
    expect(regions[0].sides[0].startIdx).toBe(1)
    expect(regions[0].sides[0].endIdx).toBe(3)
    expect(regions[0].sides[1].startIdx).toBe(4)
    expect(regions[0].sides[1].endIdx).toBe(6)
    expect(regions[0].sides[2].startIdx).toBe(7)
    expect(regions[0].sides[2].endIdx).toBe(8)
  })

  it('parses multiple conflict regions in one file', () => {
    const lines = [
      addLine('+<<<<<<< Conflict 1 of 2'),
      addLine('+%%%%%%% "first diff"'),
      addLine('+-a'),
      addLine('++++++++ "first snap"'),
      addLine('+b'),
      addLine('+>>>>>>> Conflict 1 of 2 ends'),
      { type: 'add' as const, content: '+normal line between conflicts' },
      addLine('+<<<<<<< Conflict 2 of 2'),
      addLine('+%%%%%%% "second diff"'),
      addLine('+-c'),
      addLine('++++++++ "second snap"'),
      addLine('+d'),
      addLine('+>>>>>>> Conflict 2 of 2 ends'),
    ]
    const regions = findConflicts(lines)
    expect(regions).toHaveLength(2)
    expect(regions[0].label).toBe('Conflict 1 of 2')
    expect(regions[1].label).toBe('Conflict 2 of 2')
    expect(regions[0].sides).toHaveLength(2)
    expect(regions[1].sides).toHaveLength(2)
  })
})
