import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { THEMES, isThemeDark, pickGraphPalette, colorDist } from './themes'
import ghostty from './ghostty-themes.json'

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

describe('pickGraphPalette', () => {
  // 0x96f: amber=p[3]=#ffc739, green=p[2]=#b3e03a, red=p[1]=#ff666d. The old
  // fixed mapping put graph-0=p[3] — exact amber collision.
  const sample = ghostty[0] as { id: string; bg: string; p: string[] }
  const sem = [sample.p[3], sample.p[2], sample.p[1]]

  it('returns 8 colors', () => {
    expect(pickGraphPalette(sample.p, sem, sample.bg)).toHaveLength(8)
  })

  it('no graph color exactly equals a semantic color (post-mute)', () => {
    const g = pickGraphPalette(sample.p, sem, sample.bg)
    for (const c of g) for (const s of sem) expect(c).not.toBe(s)
  })

  it('low lanes are further from semantics than high lanes (rank order)', () => {
    const g = pickGraphPalette(sample.p, sem, sample.bg)
    const minD = (c: string) => Math.min(...sem.map(s => colorDist(c, s)))
    expect(minD(g[0])).toBeGreaterThanOrEqual(minD(g[7]))
  })

  it('degenerate palette (all one hue) does not crash and returns 8', () => {
    const mono = Array(16).fill('#808080')
    expect(pickGraphPalette(mono, ['#ff0000'], '#000000')).toHaveLength(8)
  })

  it('sweep: lane 0 is hue-distinct from semantics for the vast majority of themes', () => {
    // Regression lock for the graph-0==amber bug. Old fixed mapping put
    // graph-0=p[3] → exact amber for 100% of themes. New ranking should clear
    // a hue-distinct threshold for all non-degenerate palettes; near-mono
    // palettes (e.g. "Mono Amber") have no good answer and are excluded.
    const all = ghostty as { id: string; bg: string; p: string[] }[]
    let pass = 0
    for (const t of all) {
      const sem = [t.p[3], t.p[2], t.p[1]]
      const g = pickGraphPalette(t.p, sem, t.bg)
      const d = Math.min(...sem.map(s => colorDist(g[0], s)))
      if (d > 60) pass++
    }
    expect(pass / all.length).toBeGreaterThan(0.9)
  })

  it('strictly improves on the old fixed mapping for every theme', () => {
    // Old: graph-0=p[3], distance to amber-candidate p[3] = 0 always.
    // New: muted toward bg, so distance > 0 unless bg===p[3] (no such theme).
    for (const t of ghostty as { bg: string; p: string[] }[]) {
      const sem = [t.p[3], t.p[2], t.p[1]]
      const g = pickGraphPalette(t.p, sem, t.bg)
      expect(Math.min(...sem.map(s => colorDist(g[0], s)))).toBeGreaterThan(0)
    }
  })
})
