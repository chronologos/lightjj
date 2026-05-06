import { describe, it, expect } from 'vitest'
import fc from 'fast-check'
import { captureAnchor, refind, normalizeForMatch, type Anchor } from './reanchor'

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

  describe('normalized fallback (raw-md anchor vs PM-flattened text)', () => {
    it('normalizeForMatch strips md syntax + collapses whitespace', () => {
      expect(normalizeForMatch('see **bold** and\n\n`code`  here')).toBe('see bold and code here')
      expect(normalizeForMatch('  [link](url) | _x_ ')).toBe('linkurl x')
    })

    it('selection with leading block prefix matches PM-flattened heading', () => {
      // "# " strips to a leading space (syntax-skip then space-emit); refind
      // trims normSel so it still matches haystacks without that space.
      const a: Anchor = { selection: '# Architecture', contextBefore: '', contextAfter: '' }
      const hit = refind(a, 'ArchitectureThe system…')
      expect(hit).toEqual({ from: 0, to: 12 })
    })

    it('disambiguates multi-hit using normalized context', () => {
      // Anchor captured against raw markdown; haystack is PM-flattened (no **).
      // Exact contextScore fails (' *' vs ' d') but normalized 'see bold ' lands.
      const a: Anchor = { selection: 'text', contextBefore: 'see **bold** ', contextAfter: ' and' }
      const flattened = 'see bold text and more text here'
      expect(refind(a, flattened)).toEqual({ from: 9, to: 13 })
    })

    it('matches selection spanning a block break against single-line text', () => {
      const a: Anchor = { selection: 'first paragraph.\n\nSecond', contextBefore: '', contextAfter: ' paragraph' }
      const flattened = 'first paragraph. Second paragraph here.'
      expect(refind(a, flattened)).toEqual({ from: 0, to: 23 })
    })

    it('prefers exact match over normalized when both available', () => {
      const text = 'plain foo then literal _foo_ here'
      const a: Anchor = { selection: '_foo_', contextBefore: 'literal ', contextAfter: ' here' }
      expect(refind(a, text)).toEqual({ from: 23, to: 28 })
    })

    it('still orphans when normalized is also ambiguous', () => {
      const a: Anchor = { selection: '**foo**', contextBefore: '????', contextAfter: '????' }
      expect(refind(a, 'foo and foo and foo')).toBeNull()
    })
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
