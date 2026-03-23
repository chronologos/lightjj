import { highlightCode, classHighlighter } from '@lezer/highlight'
import type { Parser } from '@lezer/common'
import { parser as jsParser } from '@lezer/javascript'
import { parser as goParser } from '@lezer/go'
import { parser as pyParser } from '@lezer/python'
import { parser as rustParser } from '@lezer/rust'
import { parser as cssParser } from '@lezer/css'
import { parser as htmlParser } from '@lezer/html'
import { parser as jsonParser } from '@lezer/json'
import { parser as yamlParser } from '@lezer/yaml'

// Lezer parser registry. highlightCode is synchronous and ~30× faster than
// Shiki (500 lines ≈ 9ms vs ~250ms) — no chunking, no yield, no isStale.
// classHighlighter emits tok-* CSS class names (not inline styles), so theme
// toggle is a pure CSS swap: cached HTML stays valid across themes.
const PARSERS: Record<string, Parser> = {
  typescript: jsParser.configure({ dialect: 'ts' }),
  javascript: jsParser,
  go: goParser,
  python: pyParser,
  rust: rustParser,
  css: cssParser,
  html: htmlParser,
  json: jsonParser,
  yaml: yamlParser,
  // No @lezer/svelte. HTML parser handles tags/attrs/strings; {interpolations}
  // and <script> bodies stay plain. Good enough for a diff view.
  svelte: htmlParser,
  // bash/toml registered lazily via ensureLegacyParsers() — StreamLanguage
  // pulls in @codemirror/language (~100K) that the main bundle doesn't need.
}

// No first-party @lezer grammars for bash/toml — StreamLanguage wraps the
// legacy-mode tokenizer in a Parser that emits a Lezer Tree. Lazy-loaded so
// @codemirror/language stays out of the main bundle. Callers that need
// .sh/.toml highlighting await this before highlightLines; unhighlighted
// (escaped-plain) output is returned in the interim.
const LEGACY_LANGS = new Set(['bash', 'toml'])
export const needsLegacyParser = (lang: string) => LEGACY_LANGS.has(lang) && !(lang in PARSERS)

let legacyPromise: Promise<void> | undefined
export function ensureLegacyParsers(): Promise<void> {
  return legacyPromise ??= (async () => {
    const [{ StreamLanguage }, { shell }, { toml }] = await Promise.all([
      import('@codemirror/language'),
      import('@codemirror/legacy-modes/mode/shell'),
      import('@codemirror/legacy-modes/mode/toml'),
    ])
    PARSERS.bash = StreamLanguage.define(shell).parser
    PARSERS.toml = StreamLanguage.define(toml).parser
  })().catch(e => { legacyPromise = undefined; throw e })
}

const EXTENSION_LANGUAGES: Record<string, string> = {
  ts: 'typescript', tsx: 'typescript', js: 'javascript', jsx: 'javascript',
  go: 'go', py: 'python', rs: 'rust',
  css: 'css', html: 'html', svelte: 'svelte',
  json: 'json', yaml: 'yaml', yml: 'yaml',
  sh: 'bash', bash: 'bash',
  toml: 'toml', mod: 'go', sum: 'go',
}

// Detect language from file extension. Also imported by FileEditor for its
// own (CM6 LanguageSupport) mapping — keep the return strings stable.
export function detectLanguage(filePath: string): string {
  const ext = filePath.split('.').pop()?.toLowerCase() ?? ''
  return EXTENSION_LANGUAGES[ext] ?? 'text'
}

// Highlight code lines → per-line HTML strings with tok-* spans.
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
    // StreamLanguage parsers (bash, toml) wrap legacy tokenizers that can
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
