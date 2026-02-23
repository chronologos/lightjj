import { describe, it, expect } from 'vitest'
import { fuzzyMatch } from './fuzzy'

describe('fuzzyMatch', () => {
  it('matches exact string', () => {
    expect(fuzzyMatch('hello', 'hello')).toBe(true)
  })

  it('matches subsequence', () => {
    expect(fuzzyMatch('gf', 'Git fetch')).toBe(true)
  })

  it('is case insensitive', () => {
    expect(fuzzyMatch('GF', 'git fetch')).toBe(true)
  })

  it('rejects non-matching', () => {
    expect(fuzzyMatch('xyz', 'Git fetch')).toBe(false)
  })

  it('matches empty query', () => {
    expect(fuzzyMatch('', 'anything')).toBe(true)
  })

  it('rejects query longer than text', () => {
    expect(fuzzyMatch('abcdef', 'abc')).toBe(false)
  })

  it('matches scattered characters', () => {
    expect(fuzzyMatch('rvs', 'Refresh revisions')).toBe(true)
  })
})
