import { highlightCode, classHighlighter } from '@lezer/highlight'
import { PARSERS } from './languages'
import type { WordSpan } from './word-diff'

// tok-* classes that name an identifier-ish token. Spans matching any of these
// get a presence-only `data-sym` marker so DiffFileView's delegated pointermove
// can recognize them without per-span listeners; the symbol name is read from
// textContent at hit time (no per-span data payload — keeps HTML bloat to one
// boolean attr per identifier).
const SYM_TOKENS = /\btok-(variableName|typeName|propertyName|className)\b/

// Highlight code lines → per-line HTML strings with tok-* spans.
// highlightCode is synchronous and ~30× faster than Shiki (500 lines ≈ 9ms vs
// ~250ms) — no chunking, no yield, no isStale. classHighlighter emits tok-*
// CSS class names (not inline styles), so theme toggle is a pure CSS swap:
// cached HTML stays valid across themes.
//
// Sync body; callers may wrap in async. highlightCode's break callback fires
// on newlines, so joining input + pushing on break naturally rebuilds the
// per-line array — no string surgery on wrapper markup.
export function highlightLines(lines: string[], lang: string): string[] {
  const parser = PARSERS[lang]
  if (!parser || lines.length === 0) return lines.map(escapeHtml)
  // Minified JS / source maps / lock files: a single 50k-char line makes the
  // parse + per-token callback dominate the frame. shouldSkipWordDiff catches
  // these per-FILE for word-diff but highlight ran regardless.
  if (lines.some((l) => l.length > 2000)) return lines.map(escapeHtml)

  const src = lines.join('\n')
  const out: string[] = ['']
  try {
    highlightCode(src, parser.parse(src), classHighlighter,
      (text, cls) => {
        const esc = escapeHtml(text)
        if (!cls) { out[out.length - 1] += esc; return }
        // Per-hunk highlighting can mis-tokenize comment bodies as code (the
        // opener is outside the hunk). Those error-recovery tokens often carry
        // trailing whitespace; real identifiers don't. Cheap noise filter.
        const sym = SYM_TOKENS.test(cls) && !/\s/.test(text) ? ' data-sym' : ''
        out[out.length - 1] += `<span class="${cls}"${sym}>${esc}</span>`
      },
      () => out.push(''),
    )
  } catch {
    // StreamLanguage parsers (legacy modes) wrap legacy tokenizers that can
    // throw on pathological input ("Stream parser failed to advance stream.",
    // @codemirror/language). First-party @lezer/* parsers don't throw.
    return lines.map(escapeHtml)
  }
  // highlightCode's break callback walks \n in the SOURCE STRING (not the
  // parse tree) so out.length === lines.length is invariant on today's Lezer —
  // but a length mismatch would render literal "undefined" via {@html}, so
  // assert cheaply.
  return out.length === lines.length ? out : lines.map(escapeHtml)
}

/** Overlay word-diff spans on highlightLines() HTML: changed text gets a
 *  `word-change` span, opened and closed inside each syntax span so tags nest.
 *  `skip` = leading characters of `html` the spans don't cover (the +/- prefix). */
export function markChanged(html: string, spans: readonly WordSpan[], skip: number): string {
  let out = '', i = 0, next = 0, left = skip, changed = false, open = false
  while (i < html.length) {
    if (html[i] === '<') {
      if (open) { out += '</span>'; open = false }
      const end = html.indexOf('>', i) + 1
      out += html.slice(i, end)
      i = end
      continue
    }
    while (left === 0) {
      changed = spans[next]?.changed ?? false
      left = spans[next++]?.text.length ?? Infinity
    }
    if (changed !== open) { out += changed ? '<span class="word-change">' : '</span>'; open = changed }
    const ch = html[i] === '&' ? html.slice(i, html.indexOf(';', i) + 1) : html[i] // an entity is one character
    out += ch
    i += ch.length
    left--
  }
  return open ? out + '</span>' : out
}

export function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

// Attribute-value context needs quote escaping too — `alt="x" onerror=...`
// breakout. escapeHtml alone is a text-node escaper; using it for attr values
// leaves quotes as-is.
export function escapeAttr(s: string): string {
  return escapeHtml(s).replace(/"/g, '&quot;')
}
