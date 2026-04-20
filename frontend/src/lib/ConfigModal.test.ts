import { describe, it, expect } from 'vitest'
import { parse as parseJsonc } from 'jsonc-parser'

describe('jsonc-parser integration', () => {
  it('parses JSONC with comments and trailing commas', () => {
    const text = `{
      // my comment
      "theme": "dark",
      "splitView": true, // trailing
    }`
    const obj = parseJsonc(text)
    expect(obj.theme).toBe('dark')
    expect(obj.splitView).toBe(true)
  })

  it('surfaces errors via the errors array for malformed input', () => {
    // jsonc-parser 3.3.1's default parse swallows errors and returns `{}`
    // (not undefined) on a fundamentally broken document — the save path
    // therefore MUST pass an errors array and check errors.length > 0 to
    // distinguish "valid empty object" from "broken input".
    const errors: Array<{ error: number; offset: number; length: number }> = []
    const obj = parseJsonc('{not json', errors)
    expect(obj).toEqual({})
    expect(errors.length).toBeGreaterThan(0)
  })
})
