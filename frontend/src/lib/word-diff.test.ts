import { describe, it, expect } from 'vitest'
import { computeWordDiffs } from './word-diff'
import type { DiffHunk } from './diff-parser'

function makeHunk(lines: { type: 'add' | 'remove' | 'context'; content: string }[]): DiffHunk {
  return { header: '@@ -1 +1 @@', oldStart: 1, newStart: 1, newCount: 1, lines }
}

describe('computeWordDiffs', () => {
  it('returns empty map for context-only hunk', () => {
    const hunk = makeHunk([
      { type: 'context', content: ' unchanged' },
    ])
    const result = computeWordDiffs(hunk)
    expect(result.size).toBe(0)
  })

  it('pairs adjacent remove/add lines', () => {
    const hunk = makeHunk([
      { type: 'remove', content: '-hello world' },
      { type: 'add', content: '+hello earth' },
    ])
    const result = computeWordDiffs(hunk)
    expect(result.has(0)).toBe(true) // remove line
    expect(result.has(1)).toBe(true) // add line
  })

  it('marks changed tokens', () => {
    const hunk = makeHunk([
      { type: 'remove', content: '-const x = 1' },
      { type: 'add', content: '+const x = 2' },
    ])
    const result = computeWordDiffs(hunk)
    const removeSpans = result.get(0)!
    const addSpans = result.get(1)!
    // "const x = " is unchanged, "1"/"2" is changed
    expect(removeSpans.some(s => s.changed && s.text.includes('1'))).toBe(true)
    expect(addSpans.some(s => s.changed && s.text.includes('2'))).toBe(true)
  })

  it('handles unpaired removes (more removes than adds)', () => {
    const hunk = makeHunk([
      { type: 'remove', content: '-line1' },
      { type: 'remove', content: '-line2' },
      { type: 'add', content: '+line3' },
    ])
    const result = computeWordDiffs(hunk)
    // First remove pairs with the add
    expect(result.has(0)).toBe(true)
    expect(result.has(2)).toBe(true)
    // Second remove has no pair
    expect(result.has(1)).toBe(false)
  })

  it('skips context lines between change groups', () => {
    const hunk = makeHunk([
      { type: 'remove', content: '-a' },
      { type: 'add', content: '+b' },
      { type: 'context', content: ' middle' },
      { type: 'remove', content: '-c' },
      { type: 'add', content: '+d' },
    ])
    const result = computeWordDiffs(hunk)
    expect(result.has(0)).toBe(true)
    expect(result.has(1)).toBe(true)
    expect(result.has(2)).toBe(false) // context
    expect(result.has(3)).toBe(true)
    expect(result.has(4)).toBe(true)
  })

  it('bails out with whole-line spans when token count exceeds MAX_TOKENS_FOR_LCS', () => {
    // 201 tokens (alternating word + space) exceeds the 200-token threshold
    const longLine = Array.from({ length: 201 }, (_, i) => `word${i}`).join(' ')
    const hunk = makeHunk([
      { type: 'remove', content: `-${longLine}` },
      { type: 'add', content: `+${longLine}x` },
    ])
    const result = computeWordDiffs(hunk)
    // Should still produce spans (the bailout produces whole-line changed spans)
    const removeSpans = result.get(0)!
    const addSpans = result.get(1)!
    expect(removeSpans).toHaveLength(1)
    expect(removeSpans[0].changed).toBe(true)
    expect(addSpans).toHaveLength(1)
    expect(addSpans[0].changed).toBe(true)
  })

  it('returns no changed spans for identical content', () => {
    const hunk = makeHunk([
      { type: 'remove', content: '-hello world' },
      { type: 'add', content: '+hello world' },
    ])
    const result = computeWordDiffs(hunk)
    const removeSpans = result.get(0)!
    const addSpans = result.get(1)!
    // All spans should be unchanged
    expect(removeSpans.every(s => !s.changed)).toBe(true)
    expect(addSpans.every(s => !s.changed)).toBe(true)
  })

  it('handles unpaired adds (more adds than removes)', () => {
    const hunk = makeHunk([
      { type: 'remove', content: '-line1' },
      { type: 'add', content: '+line2' },
      { type: 'add', content: '+line3' },
    ])
    const result = computeWordDiffs(hunk)
    // First remove pairs with first add
    expect(result.has(0)).toBe(true)
    expect(result.has(1)).toBe(true)
    // Second add has no pair
    expect(result.has(2)).toBe(false)
  })

  it('exactly MAX_TOKENS (200) does NOT bail out', () => {
    // 100 remove + 100 add lines, each with 1 token = 200 total tokens
    // This should produce word diffs (not bail out with whole-line spans)
    const removeLine = '-word'
    const addLine = '+different'
    const hunk = makeHunk([
      { type: 'remove', content: removeLine },
      { type: 'add', content: addLine },
    ])
    const result = computeWordDiffs(hunk)
    const removeSpans = result.get(0)!
    const addSpans = result.get(1)!
    // Should have word-level diffs (not whole-line bailout)
    // With only 1 token per line, both tokens differ, so changed=true
    expect(removeSpans[0].changed).toBe(true)
    expect(removeSpans[0].text).toBe('word')
    expect(addSpans[0].changed).toBe(true)
    expect(addSpans[0].text).toBe('different')
  })

  it('handles empty remove content with add content', () => {
    const hunk = makeHunk([
      { type: 'remove', content: '-' },
      { type: 'add', content: '+hello world' },
    ])
    const result = computeWordDiffs(hunk)
    const removeSpans = result.get(0)!
    const addSpans = result.get(1)!
    // Remove line has empty content (after stripping '-'), add has content
    expect(removeSpans).toEqual([])
    expect(addSpans.some(s => s.changed)).toBe(true)
  })
})
