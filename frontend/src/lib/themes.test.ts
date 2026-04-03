import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { THEMES, isThemeDark } from './themes'

describe('themes', () => {
  it('every THEMES id has a matching :root[data-theme] block in theme.css', () => {
    // Guards against adding a THEMES entry without the CSS — the theme would
    // silently fall through to the dark default with no error.
    const css = readFileSync('src/theme.css', 'utf8')
    for (const t of THEMES) {
      if (t.id === 'dark') continue // dark is the unattributed :root default
      expect(css, `theme.css missing block for '${t.id}'`)
        .toMatch(`:root[data-theme="${t.id}"]`)
    }
  })

  it('isThemeDark falls back to true for unknown ids (optimistic — dark is default)', () => {
    expect(isThemeDark('nord')).toBe(true)
    expect(isThemeDark('light')).toBe(false)
    expect(isThemeDark('garbage')).toBe(true)
  })

  it('ids are unique', () => {
    const ids = THEMES.map(t => t.id)
    expect(new Set(ids).size).toBe(ids.length)
  })
})
