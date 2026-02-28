import { createHighlighterCore, type HighlighterCore } from 'shiki/core'
import { createJavaScriptRegexEngine } from 'shiki/engine/javascript'

// Only the 2 themes used
import catppuccinMocha from 'shiki/themes/catppuccin-mocha.mjs'
import catppuccinLatte from 'shiki/themes/catppuccin-latte.mjs'

// Only the languages referenced in EXTENSION_LANGUAGES
import langTypescript from 'shiki/langs/typescript.mjs'
import langJavascript from 'shiki/langs/javascript.mjs'
import langGo from 'shiki/langs/go.mjs'
import langPython from 'shiki/langs/python.mjs'
import langRust from 'shiki/langs/rust.mjs'
import langCss from 'shiki/langs/css.mjs'
import langHtml from 'shiki/langs/html.mjs'
import langSvelte from 'shiki/langs/svelte.mjs'
import langJson from 'shiki/langs/json.mjs'
import langYaml from 'shiki/langs/yaml.mjs'
import langBash from 'shiki/langs/bash.mjs'
import langToml from 'shiki/langs/toml.mjs'

let highlighterPromise: Promise<HighlighterCore> | null = null

export async function getHighlighter(): Promise<HighlighterCore> {
  if (!highlighterPromise) {
    highlighterPromise = createHighlighterCore({
      themes: [catppuccinMocha, catppuccinLatte],
      langs: [
        langTypescript, langJavascript, langGo, langPython, langRust,
        langCss, langHtml, langSvelte, langJson, langYaml,
        langBash, langToml,
      ],
      engine: createJavaScriptRegexEngine(),
    })
  }
  return highlighterPromise
}

export function getShikiTheme(): string {
  return document.documentElement.classList.contains('light') ? 'catppuccin-latte' : 'catppuccin-mocha'
}

const EXTENSION_LANGUAGES: Record<string, string> = {
  ts: 'typescript', tsx: 'typescript', js: 'javascript', jsx: 'javascript',
  go: 'go', py: 'python', rs: 'rust',
  css: 'css', html: 'html', svelte: 'svelte',
  json: 'json', yaml: 'yaml', yml: 'yaml',
  sh: 'bash', bash: 'bash',
  toml: 'toml', mod: 'go', sum: 'go',
}

// Detect language from file extension
export function detectLanguage(filePath: string): string {
  const ext = filePath.split('.').pop()?.toLowerCase() ?? ''
  return EXTENSION_LANGUAGES[ext] ?? 'text'
}

// Chunk size for yielding during highlighting. codeToHtml is synchronous and
// blocks the main thread — a 200-line file takes ~100-200ms. Yielding every
// 30 lines caps max block time at ~15-30ms, keeping j/k navigation responsive
// even when a previous revision's highlight is still running.
const HIGHLIGHT_CHUNK_LINES = 30

// Skip highlighting entirely for pathologically large inputs. A single 50KB
// line (minified bundle without .min suffix) routes to the non-chunked path
// and blocks for ~200-500ms with no isStale escape. At ~1MB/s Shiki throughput,
// 20KB ≈ 20ms max block — acceptable ceiling.
const HIGHLIGHT_MAX_CHARS = 20_000

// Parse Shiki's codeToHtml output into per-line HTML strings.
// Shiki wraps each line in <span class="line">...tokens...</span>.
function extractLineHtml(html: string, expectedCount: number): string[] | null {
  const marker = '<span class="line">'
  const parts = html.split(marker).slice(1) // skip the <pre><code> prefix
  if (parts.length !== expectedCount) return null
  return parts.map(part => {
    // Each part ends with </span> (closing the line span), followed by
    // either a newline + next line, or </code></pre>. Strip the trailing
    // </span> that closes the outer line wrapper.
    const lastClose = part.lastIndexOf('</span>')
    return lastClose >= 0 ? part.slice(0, lastClose) : part
  })
}

// Highlight an array of code lines, returning HTML strings.
// For large inputs, yields every HIGHLIGHT_CHUNK_LINES so the main thread
// stays responsive. The optional `isStale` callback lets callers abort early
// (e.g., when the user navigates mid-highlight).
export async function highlightLines(
  lines: string[],
  lang: string,
  isStale?: () => boolean,
): Promise<string[]> {
  if (lang === 'text' || lines.length === 0) {
    return lines.map(l => escapeHtml(l))
  }

  const hl = await getHighlighter()

  // Check if the language is loaded (all supported langs are loaded at init)
  if (!hl.getLoadedLanguages().includes(lang)) {
    return lines.map(l => escapeHtml(l))
  }

  const theme = getShikiTheme()

  // Skip Shiki for pathological inputs (minified bundles, generated files).
  // Chunking by line count doesn't help if one line is 50KB.
  let totalChars = 0
  for (const l of lines) totalChars += l.length
  if (totalChars > HIGHLIGHT_MAX_CHARS) {
    return lines.map(l => escapeHtml(l))
  }

  // Small input: single call, no chunking overhead.
  if (lines.length <= HIGHLIGHT_CHUNK_LINES) {
    try {
      const html = hl.codeToHtml(lines.join('\n'), { lang, theme })
      return extractLineHtml(html, lines.length) ?? lines.map(l => escapeHtml(l))
    } catch {
      return lines.map(l => escapeHtml(l))
    }
  }

  // Large input: chunk with yields. Each chunk is tokenized independently —
  // this sacrifices cross-chunk grammar state (e.g., a multi-line comment
  // spanning a chunk boundary may color wrong for one line). Acceptable
  // trade-off for interactive responsiveness; the visual glitch is rare and
  // subtle, the frozen UI is frequent and jarring.
  const result: string[] = []
  for (let i = 0; i < lines.length; i += HIGHLIGHT_CHUNK_LINES) {
    if (i > 0) {
      await new Promise<void>(r => setTimeout(r, 0))
      if (isStale?.()) return lines.map(l => escapeHtml(l))
    }
    const chunk = lines.slice(i, i + HIGHLIGHT_CHUNK_LINES)
    try {
      const html = hl.codeToHtml(chunk.join('\n'), { lang, theme })
      const parsed = extractLineHtml(html, chunk.length)
      if (parsed) {
        result.push(...parsed)
      } else {
        result.push(...chunk.map(l => escapeHtml(l)))
      }
    } catch {
      result.push(...chunk.map(l => escapeHtml(l)))
    }
  }
  return result
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}
