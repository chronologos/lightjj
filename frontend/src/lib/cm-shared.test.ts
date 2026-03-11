import { describe, it, expect } from 'vitest'
import { detectIndent } from './cm-shared'

describe('detectIndent', () => {
  it('empty file → default (2-space)', () => {
    expect(detectIndent('')).toEqual({ usesTabs: false, width: 2 })
  })

  it('no indented lines → default', () => {
    // Lines starting with neither ' ' nor '\t' are skipped.
    expect(detectIndent('function f() {\nreturn 1\n}')).toEqual({ usesTabs: false, width: 2 })
  })

  it('detects tabs', () => {
    const src = 'func main() {\n\tfmt.Println()\n\treturn\n}'
    expect(detectIndent(src)).toEqual({ usesTabs: true, width: 2 })
  })

  it('detects 4-space indent', () => {
    const src = 'def f():\n    return 1\n    pass\n'
    expect(detectIndent(src)).toEqual({ usesTabs: false, width: 4 })
  })

  it('detects 2-space indent', () => {
    const src = 'if (x) {\n  a()\n  b()\n}'
    expect(detectIndent(src)).toEqual({ usesTabs: false, width: 2 })
  })

  it('prefers majority style (tabs vs spaces)', () => {
    // 3 tab lines, 1 space line → tabs win.
    const src = '\ta\n\tb\n\tc\n  d\n'
    expect(detectIndent(src).usesTabs).toBe(true)
  })

  it('width tiebreak prefers smaller (2 over 4 over 8)', () => {
    // Equal counts of 2-space and 4-space → smaller wins.
    // This is the "sorted ascending + strictly-greater check" behavior:
    // 2 is visited first, sets bestCount=N; 4 at N does not beat it.
    const src = '  a\n  b\n    c\n    d\n'
    expect(detectIndent(src)).toEqual({ usesTabs: false, width: 2 })
  })

  it('ignores indent widths > 8 (likely alignment, not indentation)', () => {
    // 12-space continuation (wrapped arg lists etc.) shouldn't count as
    // a width candidate. Only the 4-space lines are considered.
    const src = '    foo(\n            aligned_arg,\n    )\n    bar()\n'
    expect(detectIndent(src)).toEqual({ usesTabs: false, width: 4 })
  })

  it('scans at most SAMPLE=200 indented lines', () => {
    // 200 lines of 4-space, then 1000 lines of 2-space.
    // If the SAMPLE cap works, 4-space wins (it saturated the sample).
    // Without the cap, 2-space would win by majority.
    const head = '    x\n'.repeat(200)
    const tail = '  y\n'.repeat(1000)
    expect(detectIndent(head + tail)).toEqual({ usesTabs: false, width: 4 })
  })
})
