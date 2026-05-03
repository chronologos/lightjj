import { highlightCode, classHighlighter } from '@lezer/highlight'
import { PARSERS } from './languages'

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

  const src = lines.join('\n')
  const out: string[] = ['']
  try {
    highlightCode(src, parser.parse(src), classHighlighter,
      (text, cls) => {
        const esc = escapeHtml(text)
        out[out.length - 1] += cls ? `<span class="${cls}">${esc}</span>` : esc
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

export function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

// Attribute-value context needs quote escaping too — `alt="x" onerror=...`
// breakout. escapeHtml alone is a text-node escaper; using it for attr values
// leaves quotes as-is.
export function escapeAttr(s: string): string {
  return escapeHtml(s).replace(/"/g, '&quot;')
}
