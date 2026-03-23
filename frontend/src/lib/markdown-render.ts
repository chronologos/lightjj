import { marked, type Tokens } from 'marked'
import DOMPurify from 'dompurify'
import { escapeHtml } from './highlighter'

// beautiful-mermaid + panzoom lazy-loaded together — ~300KB chunk (mostly
// elkjs), only fetched on first preview. Subsequent previews hit module cache.
// Promise-memoized so concurrent callers share one import.
type Renderer = typeof import('beautiful-mermaid').renderMermaidSVG
type Panzoom = typeof import('@panzoom/panzoom').default
let loadP: Promise<void> | null = null
let renderer: Renderer | null = null
let panzoom: Panzoom | null = null

export const ensureMermaidLoaded = () =>
  loadP ??= Promise.all([
    import('beautiful-mermaid').then(m => renderer = m.renderMermaidSVG),
    import('@panzoom/panzoom').then(m => panzoom = m.default),
  ]).then(() => {}, () => { loadP = null })  // clear memo on reject → next preview retries

// Sync render blocks the main thread via elkjs FakeWorker. README-scale
// diagrams (<200 lines) are sub-frame; huge architecture diagrams fall through
// to raw <pre>.
const DIAGRAM_LINE_LIMIT = 200

// Direct CSS-var references — SVG contains `fill="var(--base)"` which resolves
// against whichever :root theme is active. Theme toggle is a pure CSS cascade,
// zero re-render. Same principle as tok-* syntax highlighting.
const THEME = {
  bg: 'var(--base)',
  fg: 'var(--text)',
  accent: 'var(--blue)',
  transparent: true,
} as const

function tryRenderDiagram(src: string): string | null {
  if (!renderer || src.split('\n').length > DIAGRAM_LINE_LIMIT) return null
  try {
    return renderer(src, THEME)
  } catch {
    return null
  }
}

// Rendered SVGs are stashed here during marked.parse(), re-injected after
// DOMPurify. The SVG is TRUSTED (library-generated; user input is the
// mermaid syntax, which the library parses — no raw-HTML passthrough).
// Sanitizing it would strip the internal <style> block that defines the
// derived-color vars (--_text-sec, --_node-fill, etc) — the reason for the
// placeholder indirection. renderMarkdown is sync so module-level is safe.
let pendingDiagrams: string[] = []

marked.use({
  gfm: true,
  renderer: {
    code({ text, lang }: Tokens.Code) {
      if (lang !== 'mermaid') return false
      const svg = tryRenderDiagram(text)
      if (svg) {
        const idx = pendingDiagrams.push(svg) - 1
        return `<i data-mermaid="${idx}"></i>`
      }
      // Not-yet-loaded, unsupported type, parse error, or over-limit — raw
      // code block. If loading was the reason, the caller re-derives once
      // mermaidReady flips and this path re-tries.
      return `<pre class="mermaid-fallback"><code>${escapeHtml(text)}</code></pre>`
    },
  },
})

// FORBID_TAGS: <style>/<link> in reviewed markdown create GLOBAL stylesheets
// (UI-breaker / phishing overlay). No svg profile — mermaid SVG bypasses
// sanitize via the placeholder above. Inline style attr is NOT forbidden;
// position:fixed is neutralized by `contain: layout` on .md-preview.
const SANITIZE_CFG = {
  USE_PROFILES: { html: true },
  FORBID_TAGS: ['style', 'link', 'form'],
}

export function renderMarkdown(src: string): string {
  pendingDiagrams = []
  const html = DOMPurify.sanitize(marked.parse(src) as string, SANITIZE_CFG)
  return html.replace(
    /<i data-mermaid="(\d+)"><\/i>/g,
    (_, i) => `<div class="mermaid-block">${pendingDiagrams[+i]}</div>`,
  )
}

// Called post-mount from MarkdownPreview's $effect. Wires wheel-zoom +
// drag-pan + dblclick-reset on each rendered SVG. Returns cleanup that calls
// pz.destroy() — panzoom attaches pointermove/pointerup at DOCUMENT level
// (panzoom.es.js bind()), so {@html} subtree replacement alone doesn't release
// them. No-op cleanup if not loaded yet (first-render raw-fallback path).
export function wirePanzoom(container: HTMLElement): () => void {
  if (!panzoom) return () => {}
  const instances: ReturnType<Panzoom>[] = []
  for (const svg of container.querySelectorAll<SVGSVGElement>('.mermaid-block > svg')) {
    const pz = panzoom(svg, { maxScale: 5, minScale: 0.3, canvas: true })
    svg.parentElement!.addEventListener('wheel', pz.zoomWithWheel, { passive: false })
    svg.addEventListener('dblclick', () => pz.reset())
    instances.push(pz)
  }
  return () => instances.forEach(pz => pz.destroy())
}
