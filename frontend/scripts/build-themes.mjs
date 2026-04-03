#!/usr/bin/env node
// Build-time: read Ghostty's bundled themes → emit RAW palettes only.
// Derivation (ANSI→lightjj primaries, lum/hue guards) lives client-side in
// themes.ts so improving it is a code change, not a 400KB JSON regen.
//
// JSON shape: [{id, label, bg, fg, p: [16 hexes]}]. ~60KB vs 410KB pre-derived.
import { readdirSync, readFileSync, writeFileSync } from 'node:fs'

const DIR = process.env.GHOSTTY_THEMES ??
  '/Applications/Ghostty.app/Contents/Resources/ghostty/themes'

const HEX = /#?([0-9a-fA-F]{6}|[0-9a-fA-F]{3})\b/
const norm = s => { const m = HEX.exec(s); if (!m) return null
  const h = m[1]; return '#' + (h.length === 3 ? [...h].map(c=>c+c).join('') : h).toLowerCase() }

function parse(text) {
  const p = Array(16).fill(null); let bg = null, fg = null
  for (const line of text.split('\n')) {
    let m
    if ((m = /^palette\s*=\s*(\d+)\s*=\s*(.+)/.exec(line))) p[+m[1]] = norm(m[2])
    else if ((m = /^background\s*=\s*(.+)/.exec(line))) bg = norm(m[1])
    else if ((m = /^foreground\s*=\s*(.+)/.exec(line))) fg = norm(m[1])
  }
  if (!bg || !fg || p.some(x => !x)) throw new Error('incomplete palette')
  return { p, bg, fg }
}

const slug = s => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')

let names
try { names = readdirSync(DIR).sort() }
catch (e) {
  console.error(`\n${DIR} not found. Set GHOSTTY_THEMES=/path/to/themes (e.g. clone github.com/ghostty-org/ghostty/themes).\n`)
  process.exit(1)
}

const out = []
const seen = new Set()
for (const name of names) {
  try {
    let id = slug(name)
    // "Dracula" and "Dracula+" both slug to "dracula" — suffix on collision.
    while (seen.has(id)) id += '-2'
    seen.add(id)
    out.push({ id, label: name, ...parse(readFileSync(`${DIR}/${name}`, 'utf8')) })
  } catch (e) { console.error(`skip ${name}: ${e.message}`) }
}
// One theme per line — readable diffs without full pretty-print bloat.
writeFileSync('src/lib/ghostty-themes.json',
  '[\n' + out.map(t => JSON.stringify(t)).join(',\n') + '\n]\n')
console.error(`${out.length} themes → src/lib/ghostty-themes.json`)
