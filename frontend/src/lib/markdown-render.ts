import { marked, type Tokens } from 'marked'
import DOMPurify from 'dompurify'
import { escapeHtml, escapeAttr } from './highlighter'
import { api } from './api'

// beautiful-mermaid lazy-loaded — ~300KB chunk (mostly elkjs), only fetched
// on first preview. Subsequent previews hit module cache. Promise-memoized
// so concurrent callers share one import.
type Renderer = typeof import('beautiful-mermaid').renderMermaidSVG
let loadP: Promise<void> | null = null
let renderer: Renderer | null = null

export const ensureMermaidLoaded = () =>
  loadP ??= import('beautiful-mermaid')
    .then(m => { renderer = m.renderMermaidSVG })
    .catch(() => { loadP = null })  // clear memo on reject → next preview retries

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

// Strip mermaid %%{...}%% directive blocks (typically %%{init: {...}}%% for
// theme overrides). beautiful-mermaid's parser expects the diagram-type
// header on line 1; a multi-line init block pushes it down → "Invalid
// mermaid header" throw → silent fallback to <pre>. The directive is for
// mermaid.js's native theming which THEME below already replaces, so
// dropping it is semantically correct.
const DIRECTIVE_RE = /%%\{[\s\S]*?\}%%\s*\n?/g

function tryRenderDiagram(src: string): string | null {
  if (!renderer) return null
  const stripped = src.replace(DIRECTIVE_RE, '')
  if (stripped.split('\n').length > DIAGRAM_LINE_LIMIT) return null
  try {
    return renderer(stripped, THEME)
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

// Per-call context for the image renderer hook. Module-level (same pattern
// as pendingDiagrams) — marked.use is configured once at module load so hooks
// can't receive call-time params directly. Set in renderMarkdown, read in
// the image hook, never read outside the sync parse call.
let imgCtx: { revision: string, baseDir: string } | null = null
let imgCount = 0

// Cap proxied images per preview. Each is a jj subprocess (SSH mode: a full
// round trip). A malicious README with 1000 images would queue 1000 requests.
const MAX_PROXIED_IMAGES = 50

// Allowlisted schemes pass through. Relative paths resolve against baseDir
// then route through /api/file-raw so SSH-mode images load. DOMPurify's
// ALLOWED_URI_REGEXP is the actual filter for dangerous schemes (javascript:,
// vbscript:); this allowlist is belt-and-suspenders so resolveImgSrc is
// self-contained if the sanitize step ever moves.
const SCHEME_RE = /^(https?:|data:image\/|\/\/|#)/i

// Safe decode — malformed %-sequences (e.g., `%ZZ`) throw; falling back to
// the raw href means a harmless 404 rather than crashing the render.
const tryDecode = (s: string) => { try { return decodeURIComponent(s) } catch { return s } }

function resolveImgSrc(href: string): string {
  if (!imgCtx || SCHEME_RE.test(href)) return href
  if (++imgCount > MAX_PROXIED_IMAGES) return ''
  // Strip ?query/#fragment — browser applies those client-side; server needs
  // bare file path. Decode before URLSearchParams re-encodes (avoids %20→%2520).
  const clean = tryDecode(href.replace(/[?#].*$/, ''))
  // Leading `/` = repo-root-relative (common in docs); strip it, skip baseDir.
  const path = clean.startsWith('/')
    ? clean.slice(1)
    : imgCtx.baseDir ? `${imgCtx.baseDir}/${clean}` : clean
  return api.fileRawUrl(imgCtx.revision, path)
}

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
    image({ href, title, text }: Tokens.Image) {
      const src = resolveImgSrc(href)
      const t = title ? ` title="${escapeAttr(title)}"` : ''
      return `<img src="${escapeAttr(src)}" alt="${escapeAttr(text)}"${t}>`
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

export interface PreviewContext {
  revision: string
  // Directory of the markdown file (for resolving relative img src).
  // Empty string = repo root.
  baseDir: string
}

export function renderMarkdown(src: string, ctx?: PreviewContext): string {
  pendingDiagrams = []
  imgCtx = ctx ?? null
  imgCount = 0
  const html = DOMPurify.sanitize(marked.parse(src) as string, SANITIZE_CFG)
  imgCtx = null
  return html.replace(
    /<i data-mermaid="(\d+)"><\/i>/g,
    (_, i) => `<div class="mermaid-block">${pendingDiagrams[+i]}</div>`,
  )
}

const MIN_SCALE = 0.3
const MAX_SCALE = 5
const WHEEL_STEP = 0.0015
// deltaMode 1 (DOM_DELTA_LINE) = Firefox w/ mouse wheel; 2 (PAGE) = some a11y
// configs. Normalize to pixel-equivalent so WHEEL_STEP is calibrated once.
const DELTA_MODE_SCALE = [1, 40, 800]

// Zoom-to-cursor: CSS `translate(tx,ty) scale(s)` maps SVG-local P to screen
// point (P·s + t). Cursor at screen (cx,cy) → local point ((cx-tx)/s, ...).
// To keep that local point at (cx,cy) after scaling by factor f, solve for t':
//   ((cx-tx)/s)·(s·f) + tx' = cx  ⇒  tx' = cx − (cx−tx)·f
function wireSvg(svg: SVGSVGElement, canvas: HTMLElement): () => void {
  let tx = 0, ty = 0, s = 1
  const apply = () => svg.style.transform = `translate(${tx}px,${ty}px) scale(${s})`
  svg.style.transformOrigin = '0 0'

  const onWheel = (e: WheelEvent) => {
    e.preventDefault()
    const dy = e.deltaY * (DELTA_MODE_SCALE[e.deltaMode] ?? 1)
    const f = Math.min(MAX_SCALE, Math.max(MIN_SCALE, s * (1 - dy * WHEEL_STEP))) / s
    const r = canvas.getBoundingClientRect()
    const cx = e.clientX - r.left, cy = e.clientY - r.top
    tx = cx - (cx - tx) * f
    ty = cy - (cy - ty) * f
    s *= f
    apply()
  }

  let dragStart: { x: number, y: number, tx: number, ty: number } | null = null
  const onDown = (e: PointerEvent) => {
    if (e.button !== 0) return
    dragStart = { x: e.clientX, y: e.clientY, tx, ty }
    canvas.setPointerCapture(e.pointerId)
  }
  const onMove = (e: PointerEvent) => {
    if (!dragStart) return
    tx = dragStart.tx + (e.clientX - dragStart.x)
    ty = dragStart.ty + (e.clientY - dragStart.y)
    apply()
  }
  const onUp = (e: PointerEvent) => {
    dragStart = null
    canvas.releasePointerCapture(e.pointerId)
  }
  const onReset = () => { tx = 0; ty = 0; s = 1; apply() }

  canvas.addEventListener('wheel', onWheel, { passive: false })
  canvas.addEventListener('pointerdown', onDown)
  canvas.addEventListener('pointermove', onMove)
  canvas.addEventListener('pointerup', onUp)
  // pointercancel (touch gesture stolen, system dialog mid-drag) does NOT
  // fire pointerup — without this, stale dragStart makes the next move jump.
  canvas.addEventListener('pointercancel', onUp)
  canvas.addEventListener('dblclick', onReset)

  return () => {
    canvas.removeEventListener('wheel', onWheel)
    canvas.removeEventListener('pointerdown', onDown)
    canvas.removeEventListener('pointermove', onMove)
    canvas.removeEventListener('pointerup', onUp)
    canvas.removeEventListener('pointercancel', onUp)
    canvas.removeEventListener('dblclick', onReset)
  }
}

// Called post-mount from MarkdownPreview's $effect. Wires wheel-zoom +
// drag-pan + dblclick-reset on each rendered SVG. Returns cleanup —
// setPointerCapture keeps move/up on the canvas itself (not document), so
// {@html} subtree replacement would orphan them without explicit removal.
export function wirePanzoom(container: HTMLElement): () => void {
  const cleanups: Array<() => void> = []
  for (const svg of container.querySelectorAll<SVGSVGElement>('.mermaid-block > svg')) {
    cleanups.push(wireSvg(svg, svg.parentElement!))
  }
  return () => cleanups.forEach(fn => fn())
}
