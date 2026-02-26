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

// Highlight an array of code lines, returning HTML strings
export async function highlightLines(lines: string[], lang: string): Promise<string[]> {
  if (lang === 'text' || lines.length === 0) {
    return lines.map(l => escapeHtml(l))
  }

  const hl = await getHighlighter()

  // Check if the language is loaded (all supported langs are loaded at init)
  if (!hl.getLoadedLanguages().includes(lang)) {
    return lines.map(l => escapeHtml(l))
  }

  const theme = getShikiTheme()
  const code = lines.join('\n')
  try {
    const html = hl.codeToHtml(code, { lang, theme })
    // Shiki wraps each line in <span class="line">...tokens...</span>.
    // Split on the line boundary marker to extract per-line HTML.
    const marker = '<span class="line">'
    const parts = html.split(marker).slice(1) // skip the <pre><code> prefix
    if (parts.length === lines.length) {
      return parts.map(part => {
        // Each part ends with </span> (closing the line span), followed by
        // either a newline + next line, or </code></pre>. Strip the trailing
        // </span> that closes the outer line wrapper.
        const lastClose = part.lastIndexOf('</span>')
        return lastClose >= 0 ? part.slice(0, lastClose) : part
      })
    }
  } catch {
    // Language not supported or parse error, return escaped text
  }
  return lines.map(l => escapeHtml(l))
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}
