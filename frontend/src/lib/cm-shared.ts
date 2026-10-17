// Shared CodeMirror 6 helpers — extracted from FileEditor.svelte for reuse
// in MergePanel.svelte. CSS-var-driven theme so toggle is a pure CSS swap.

import { EditorView } from '@codemirror/view'
import { LanguageSupport, LRLanguage, syntaxHighlighting } from '@codemirror/language'
import { classHighlighter } from '@lezer/highlight'
import { javascript } from '@codemirror/lang-javascript'
import { python } from '@codemirror/lang-python'
import { go } from '@codemirror/lang-go'
import { rust } from '@codemirror/lang-rust'
import { detectLanguage, LANGUAGES, ensureLegacyParsers, streamLanguageFor } from './languages'

/** Scan leading whitespace to infer indentation style. Falls back to 2-space. */
export function detectIndent(src: string): { usesTabs: boolean; width: number } {
  const SAMPLE = 200
  let tabLines = 0
  let spaceLines = 0
  const widthCounts = new Map<number, number>()
  let scanned = 0
  for (const line of src.split('\n')) {
    if (scanned >= SAMPLE) break
    if (line.length === 0 || (line[0] !== ' ' && line[0] !== '\t')) continue
    scanned++
    if (line[0] === '\t') {
      tabLines++
    } else {
      spaceLines++
      let n = 0
      while (n < line.length && line[n] === ' ') n++
      if (n > 0 && n <= 8) widthCounts.set(n, (widthCounts.get(n) ?? 0) + 1)
    }
  }
  const usesTabs = tabLines > spaceLines
  // Most common leading-space count, preferring smaller widths (2 over 4 over 8)
  let width = 2
  let bestCount = 0
  for (const [w, c] of [...widthCounts.entries()].sort((a, b) => a[0] - b[0])) {
    if (c > bestCount) { bestCount = c; width = w }
  }
  return { usesTabs, width }
}

// Full @codemirror/lang-* packages add indent/fold/autocomplete on top of bare
// highlighting. Kept for the four already-installed packages (ts+js share
// lang-javascript); everything else falls through to a registry-derived
// bare-highlight LanguageSupport below.
const RICH_SUPPORT: Record<string, () => LanguageSupport> = {
  typescript: () => javascript({ typescript: true, jsx: true }),
  javascript: () => javascript({ jsx: true }),
  python,
  go,
  rust,
}

/**
 * Map file path → CM6 LanguageSupport. null = plain text.
 * Async because legacy-mode languages (swift, bash, …) lazy-load their
 * StreamParser; eager Lezer languages resolve synchronously.
 */
export async function getCmLanguage(filePath: string): Promise<LanguageSupport | null> {
  const lang = detectLanguage(filePath)
  const rich = RICH_SUPPORT[lang]
  if (rich) return rich()

  const spec = LANGUAGES[lang]
  if (!spec) return null
  if (spec.parser) {
    // @lezer/* exports are concretely LRParser; LANGUAGES types them as the
    // base Parser so PARSERS can also hold StreamLanguage parsers. Sound cast.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return new LanguageSupport(LRLanguage.define({ parser: spec.parser as any }))
  }
  if (spec.legacy) {
    await ensureLegacyParsers()
    const sl = streamLanguageFor(lang)
    return sl ? new LanguageSupport(sl) : null
  }
  return null
}

/**
 * Syntax highlighting for every CM6 surface (FileEditor, MergePanel, and
 * ConfigModal via FileEditor). classHighlighter emits the SAME `tok-*` classes
 * highlighter.ts puts in diff HTML, so theme.css's `.tok-* { color: var(--syn-*) }`
 * rules color the editor exactly like the diff beside it, and a theme switch
 * (`t`, Cmd+K → Theme, Ghostty palettes) is a pure CSS swap — no extension
 * reconfigure, no buffer loss.
 *
 * Do NOT use defaultHighlightStyle here: it bakes light-only inline colors
 * (#708 keywords, #a11 strings, #00f/#085 names) into generated classes, which
 * is issue #40 — dark-on-dark syntax in every dark theme.
 */
export const cmHighlight = syntaxHighlighting(classHighlighter)

// Our theme is registered without {dark: true}, so CM tags every editor with
// its LIGHT base-theme scope. Any base `&light …` rule we don't out-specify
// leaks light colors into dark themes. Rules below whose selectors look
// over-qualified exist to match/beat a specific base rule — keep them in sync
// with @codemirror/view's baseTheme if CM is bumped. Equal specificity is
// enough: our module mounts after the base theme, so ties go to us.
// Not covered (no extension enables them today): .cm-panels/.cm-tooltip/
// .cm-button/.cm-textfield (search, autocomplete, lint). Adding one of those
// extensions means adding var-driven overrides here too.
/** CSS-var-driven CM6 theme. 18px line height matches .diff-line / RevisionGraph rows. */
export const cmTheme = EditorView.theme({
  '&': { height: '100%', fontSize: 'var(--fs-md)', backgroundColor: 'var(--base)', color: 'var(--text)' },
  '.cm-scroller': { overflow: 'auto', fontFamily: 'var(--font-mono, monospace)' },
  '.cm-content': { padding: '0', caretColor: 'var(--text)' },
  '.cm-line': { padding: '0 4px', lineHeight: '18px' },
  '.cm-gutters': { minWidth: '3em', backgroundColor: 'var(--mantle)', color: 'var(--subtext0)', borderRight: '1px solid var(--surface0)' },
  '.cm-activeLineGutter': { backgroundColor: 'var(--surface0)' },
  '.cm-activeLine': { backgroundColor: 'var(--surface0)' },
  // Drawn-selection layer (only rendered if drawSelection() is ever added —
  // today the native ::selection from theme.css paints). Base focused rule is
  // `&light.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground`
  // (4 classes, #d7d4f0 lavender) — mirror it exactly so we tie and win.
  '.cm-selectionBackground, &.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground': {
    background: 'color-mix(in srgb, var(--amber) 25%, transparent)',
  },
  '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--text)' },
  '.cm-specialChar': { color: 'var(--red)' },
  // Base (@codemirror/language) rule is `&.cm-focused .cm-matchingBracket` — match it.
  '.cm-matchingBracket, &.cm-focused .cm-matchingBracket': {
    backgroundColor: 'var(--surface1)', outline: '1px solid var(--surface2)',
  },
  '.cm-nonmatchingBracket, &.cm-focused .cm-nonmatchingBracket': { backgroundColor: 'var(--bg-error)', outline: '1px solid var(--red)' },
  '.cm-foldPlaceholder': { backgroundColor: 'var(--surface0)', border: '1px solid var(--surface1)', color: 'var(--subtext0)' },
})
