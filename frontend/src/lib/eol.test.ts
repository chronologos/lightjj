import { describe, it, expect } from 'vitest'
import fc from 'fast-check'
import { detectEol, withEol } from './eol'
import { applyHunks } from './hunk-apply'
import { parseDiffContent } from './diff-parser'

describe('eol', () => {
  it.each([
    ['', '\n'], ['a', '\n'], ['a\nb\n', '\n'],
    ['a\r\nb\r\n', '\r\n'], ['a\r\nb', '\r\n'], ['\r\n\r\n', '\r\n'],
    ['a\r\nb\n', 'mixed'], ['\na\r\n', 'mixed'], ['\r\n\n', 'mixed'],
    ['a\rb', 'mixed'], ['a\r\r\n', 'mixed'], ['a\r\nb\r', 'mixed'],
  ])('detectEol(%j) = %j', (text, eol) => expect(detectEol(text)).toBe(eol))

  it('uniform text survives normalise → restore byte for byte', () => {
    fc.assert(fc.property(fc.string({ unit: fc.constantFrom('a', '\r', '\n') }), (s) => {
      const eol = detectEol(s)
      if (eol !== 'mixed') expect(withEol(s.replace(/\r\n/g, '\n'), eol)).toBe(s)
    }))
  })

  it('hunk review keeps CRLF in accepted and context lines', () => {
    const [f] = parseDiffContent('diff --git a/f b/f\n--- a/f\n+++ b/f\n@@ -1,3 +1,3 @@\n a\r\n-b\r\n+B\r\n c\r\n')
    expect(applyHunks('a\r\nb\r\nc\r\n', f.hunks)).toBe('a\r\nB\r\nc\r\n')
  })
})
