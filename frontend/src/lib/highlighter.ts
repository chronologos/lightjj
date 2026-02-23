import { createHighlighter, type Highlighter } from 'shiki'

let highlighterPromise: Promise<Highlighter> | null = null

export async function getHighlighter(): Promise<Highlighter> {
  if (!highlighterPromise) {
    highlighterPromise = createHighlighter({
      themes: ['github-dark', 'github-light'],
      langs: [],  // load on demand
    })
  }
  return highlighterPromise
}

export function getShikiTheme(): string {
  return document.documentElement.classList.contains('light') ? 'github-light' : 'github-dark'
}

// Detect language from file extension
export function detectLanguage(filePath: string): string {
  const ext = filePath.split('.').pop()?.toLowerCase() ?? ''
  const map: Record<string, string> = {
    ts: 'typescript', tsx: 'typescript', js: 'javascript', jsx: 'javascript',
    go: 'go', py: 'python', rs: 'rust',
    css: 'css', html: 'html', svelte: 'svelte',
    json: 'json', yaml: 'yaml', yml: 'yaml',
    md: 'markdown', sh: 'bash', bash: 'bash',
    toml: 'toml', mod: 'go', sum: 'go',
  }
  return map[ext] ?? 'text'
}

const loadedLangs = new Set<string>()

// Highlight an array of code lines, returning HTML strings
export async function highlightLines(lines: string[], lang: string): Promise<string[]> {
  if (lang === 'text' || lines.length === 0) {
    return lines.map(l => escapeHtml(l))
  }

  const hl = await getHighlighter()
  const theme = getShikiTheme()

  if (!loadedLangs.has(lang)) {
    try {
      await hl.loadLanguage(lang as any)
      loadedLangs.add(lang)
    } catch {
      return lines.map(l => escapeHtml(l))
    }
  }

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
