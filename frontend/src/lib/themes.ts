// Theme system: 7 builtins (CSS-baked, zero-FOUC) + Ghostty-derived (lazy).
// theme.css holds ~50 DERIVED vars (color-mix from primaries) + 7 builtin
// :root[data-theme] blocks. Ghostty themes ship as RAW palettes (bg/fg/p[16],
// ~60KB JSON) — deriveVars() below maps ANSI→primaries at selection time.
// Single source of truth for the mapping (was duplicated in build-themes.mjs
// + a theme.css comment that had already drifted).

export interface Theme {
  id: string
  label: string
  dark: boolean
  /** [base, accent, green, red] — palette-swatch preview in the picker.
   *  Includes diff colors so the swatch predicts how diffs will look. */
  swatch: readonly [string, string, string, string]
}

export const THEMES: readonly Theme[] = [
  { id: 'dark',         label: 'Default Dark',  dark: true,  swatch: ['#0f0f13', '#ffa726', '#66bb6a', '#ef5350'] },
  { id: 'light',        label: 'Default Light', dark: false, swatch: ['#f8f8f6', '#e68a00', '#2e7d32', '#c62828'] },
  { id: 'nord',         label: 'Nord',          dark: true,  swatch: ['#2e3440', '#ebcb8b', '#a3be8c', '#bf616a'] },
  { id: 'gruvbox-dark', label: 'Gruvbox Dark',  dark: true,  swatch: ['#282828', '#fabd2f', '#b8bb26', '#fb4934'] },
  { id: 'dracula',      label: 'Dracula',       dark: true,  swatch: ['#282a36', '#ffb86c', '#50fa7b', '#ff5555'] },
  { id: 'tokyo-night',  label: 'Tokyo Night',   dark: true,  swatch: ['#1a1b26', '#e0af68', '#9ece6a', '#f7768e'] },
  { id: 'rose-pine',    label: 'Rosé Pine',     dark: true,  swatch: ['#191724', '#f6c177', '#31748f', '#eb6f92'] },
] as const

const BUILTIN_IDS = new Set(THEMES.map(t => t.id))
// Ghostty's "TokyoNight" → slug "tokyonight"; our builtin is "tokyo-night".
// Label-match catches these so we don't show two near-identical entries.
const BUILTIN_LABELS = new Set(THEMES.map(t => t.label.toLowerCase().replace(/[^a-z]/g, '')))

export function isThemeDark(id: string): boolean {
  const t = THEMES.find(t => t.id === id) ?? ghosttyLoaded?.find(t => t.id === id)
  return t?.dark ?? true
}

// ───── Ghostty raw palettes (lazy-loaded) ─────

interface GhosttyRaw { id: string; label: string; bg: string; fg: string; p: string[] }
export interface GhosttyTheme extends Theme { vars: Record<string, string> }

let ghosttyLoaded: GhosttyTheme[] | null = null
let ghosttyP: Promise<GhosttyTheme[]> | null = null

export function loadGhosttyThemes(): Promise<GhosttyTheme[]> {
  if (ghosttyP) return ghosttyP
  ghosttyP = import('./ghostty-themes.json')
    .then(m => {
      ghosttyLoaded = (m.default as GhosttyRaw[])
        .filter(t => !BUILTIN_IDS.has(t.id) &&
          !BUILTIN_LABELS.has(t.label.toLowerCase().replace(/[^a-z]/g, '')))
        .map(deriveTheme)
      return ghosttyLoaded
    })
    .catch(e => {
      // Clear memo so a retry (next submenu open) re-attempts. Permanent
      // memoization of a rejection = the CLAUDE.md sync.Once anti-pattern.
      ghosttyP = null
      console.warn('ghostty themes load failed:', e)
      return []
    })
  return ghosttyP
}

// ───── ANSI → lightjj primary derivation ─────

const hex2rgb = (h: string) => [1,3,5].map(i => parseInt(h.slice(i,i+2), 16)) as [number,number,number]
const lum = (h: string) => { const [r,g,b]=hex2rgb(h); return 0.2126*r+0.7152*g+0.0722*b }
const mix = (a: string, b: string, t: number) => '#' + hex2rgb(a).map((x,i) =>
  Math.round(x*(1-t)+hex2rgb(b)[i]*t).toString(16).padStart(2,'0')).join('')

/** Pick the candidate with best luminance contrast against bg, falling back
 *  to a hardcoded default if none clear the threshold. Guards mono/grayscale
 *  palettes where p[3] (amber) or p[2] (green) is a mid-gray → invisible
 *  selection tint / unreadable .btn-primary. */
function pickAccent(bg: string, candidates: string[], fallback: string): string {
  for (const c of candidates) if (Math.abs(lum(c) - lum(bg)) > 40) return c
  return fallback
}

function deriveTheme(raw: GhosttyRaw): GhosttyTheme {
  const { id, label, bg, fg, p } = raw
  const dark = lum(bg) < lum(fg)
  const tone = dark ? '#000000' : '#ffffff'
  // p[8] (bright-black) is the theme author's tuned mid-gray — better surface
  // anchor than pure mix(bg,fg) which collapses on low-contrast palettes.
  const amber = pickAccent(bg, [p[3], p[11]], dark ? '#ffa726' : '#e68a00')
  const green = pickAccent(bg, [p[2], p[10]], dark ? '#66bb6a' : '#2e7d32')
  const red   = pickAccent(bg, [p[1], p[9]],  dark ? '#ef5350' : '#c62828')
  const vars: Record<string, string> = {
    base: bg, mantle: bg, crust: mix(bg, tone, 0.08),
    surface2: p[8], overlay0: mix(p[8], fg, 0.3), overlay1: mix(p[8], fg, 0.4),
    subtext0: mix(p[8], fg, 0.55), subtext1: fg, text: fg,
    amber, green, red, blue: p[4], mauve: p[5], lavender: p[6],
    'graph-0': p[3], 'graph-1': p[9], 'graph-2': p[1], 'graph-3': p[5],
    'graph-4': p[4], 'graph-5': p[6], 'graph-6': p[2], 'graph-7': p[11],
    'syn-keyword': p[13], 'syn-string': p[10], 'syn-number': p[9],
    'syn-comment': p[8], 'syn-type': p[11], 'syn-property': p[12],
    'syn-operator': p[7], 'syn-punct': p[8], 'syn-atom': p[9],
    backdrop: dark ? 'rgba(0,0,0,0.5)' : 'rgba(0,0,0,0.3)',
    'shadow-heavy': dark ? '0 20px 60px rgba(0,0,0,0.3)' : '0 20px 60px rgba(0,0,0,0.15)',
  }
  return { id, label, dark, swatch: [bg, amber, green, red], vars }
}

const STYLE_ID = 'ghostty-theme-vars'

/** Inject (or replace) the :root[data-theme] block for a ghostty theme.
 *  textContent (NOT innerHTML) is load-bearing: the string goes through the
 *  CSS parser only, so a malicious vars value can't break out into HTML. */
export function applyGhosttyTheme(id: string): void {
  const t = ghosttyLoaded?.find(t => t.id === id)
  let el = document.getElementById(STYLE_ID)
  if (!t) { el?.remove(); return }
  if (!el) {
    el = document.createElement('style')
    el.id = STYLE_ID
    document.head.appendChild(el)
  }
  el.textContent = `:root[data-theme="${id}"]{${
    Object.entries(t.vars).map(([k, v]) => `--${k}:${v}`).join(';')
  }}`
}
