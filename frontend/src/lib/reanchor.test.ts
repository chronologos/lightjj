import { describe, it, expect } from 'vitest'
import fc from 'fast-check'
import { captureAnchor, refind, type Anchor } from './reanchor'

describe('captureAnchor', () => {
  it('captures selection + context', () => {
    const a = captureAnchor('hello world foo bar', 6, 11, 4)
    expect(a).toEqual({ selection: 'world', contextBefore: 'llo ', contextAfter: ' foo' })
  })

  it('clamps context at boundaries', () => {
    const a = captureAnchor('abc', 0, 3, 40)
    expect(a).toEqual({ selection: 'abc', contextBefore: '', contextAfter: '' })
  })
})

describe('refind', () => {
  it('single hit returns it', () => {
    const text = 'The quick brown fox jumps over the lazy dog.'
    const a = captureAnchor(text, 10, 19) // "brown fox"
    expect(refind(a, text)).toEqual({ from: 10, to: 19 })
  })

  it('multi-hit disambiguates by context', () => {
    const text = 'first foo here, second foo there, third foo end'
    // anchor the middle "foo"
    const a = captureAnchor(text, 23, 26)
    expect(a.selection).toBe('foo')
    expect(refind(a, text)).toEqual({ from: 23, to: 26 })
  })

  it('multi-hit with weak context orphans rather than guesses', () => {
    // Three "foo"s, anchor captured against text where context doesn't survive.
    const a: Anchor = { selection: 'foo', contextBefore: 'XXXXXXXXXXXXXXXXXXXX', contextAfter: 'YYYYYYYYYYYYYYYYYYYY' }
    expect(refind(a, 'foo and foo and foo')).toBeNull()
  })

  it('selection edited away → zero-width at context join', () => {
    const orig = 'The quick brown fox jumps over the lazy dog.'
    const a = captureAnchor(orig, 10, 19) // "brown fox"
    const edited = 'The quick red panda jumps over the lazy dog.'
    const r = refind(a, edited)
    // contextBefore="The quick " ends at 10; contextAfter=" jumps over..." starts later.
    expect(r).toEqual({ from: 10, to: 10 })
  })

  it('full miss returns null', () => {
    const a: Anchor = { selection: 'nonexistent phrase', contextBefore: 'aaaa bbbb ', contextAfter: ' cccc dddd' }
    expect(refind(a, 'completely different document content here')).toBeNull()
  })

  it('rejects too-short context for stage 3', () => {
    const a: Anchor = { selection: 'gone', contextBefore: 'ab', contextAfter: 'cd' }
    expect(refind(a, 'ab something cd')).toBeNull()
  })

  it('property: round-trip on unchanged text', () => {
    fc.assert(
      fc.property(
        // Restrict to non-degenerate inputs: enough text, non-empty selection.
        // Unicode-heavy strings exercise slice/indexOf consistency.
        fc.string({ minLength: 60, maxLength: 400 }),
        fc.nat(50),
        fc.integer({ min: 3, max: 30 }),
        (text, offset, len) => {
          const from = Math.min(offset, text.length - 1)
          const to = Math.min(from + len, text.length)
          if (from >= to) return true // degenerate after clamping; skip
          const a = captureAnchor(text, from, to)
          const r = refind(a, text)
          // On unchanged text, refind MUST return the original range.
          // (Single-hit path or perfect-context-score path both satisfy this.)
          return r !== null && r.from === from && r.to === to
        },
      ),
      { numRuns: 300 },
    )
  })

  it('property: survives unrelated prefix insertion', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 80, maxLength: 200 }),
        fc.nat(40),
        fc.integer({ min: 5, max: 20 }),
        fc.string({ minLength: 1, maxLength: 50 }),
        (text, offset, len, inserted) => {
          const from = Math.min(offset + 20, text.length - len)
          const to = from + len
          if (from < 0 || to > text.length) return true
          const a = captureAnchor(text, from, to)
          // Insert at start — well outside the 40-char context window.
          // Anchor should re-find, shifted by inserted.length.
          // Precondition: the selection+context must not also occur in `inserted`
          // (would create a spurious earlier hit). Reject those samples.
          fc.pre(!inserted.includes(a.selection))
          const edited = inserted + text
          const r = refind(a, edited)
          return r !== null && r.from === from + inserted.length && r.to === to + inserted.length
        },
      ),
      { numRuns: 200 },
    )
  })
})
