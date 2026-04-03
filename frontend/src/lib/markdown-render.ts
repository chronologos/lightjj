import { marked, type Token, type Tokens } from 'marked'
import DOMPurify from 'dompurify'
import { escapeHtml, escapeAttr, highlightLines, EXTENSION_LANGUAGES } from './highlighter'
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

// ── Per-render state ───────────────────────────────────────────────────────
// marked.use() configures hooks ONCE at module load so they can't take
// call-time params directly — they read this single module slot instead.
// Bundled (vs N separate lets) so the per-render boundary is one variable:
// easier to reason about, and the first await someone adds to the pipeline
// breaks one obvious thing instead of seven scattered ones. renderMarkdown
// is sync today; rs is non-null exactly inside that call.
//
// pendingDiagrams: rendered mermaid SVG stash, re-injected after DOMPurify
// (sanitize would strip the SVG's internal <style> block that defines
// --_text-sec etc; the SVG is library-generated → trusted).
interface RenderState {
  pendingDiagrams: string[]
  imgCtx: { revision: string; baseDir: string } | null
  imgCount: number
  footnotes: Footnote[]
  fnLabelToIdx: Map<string, number>
  headingSlugs: Map<string, number>
  stamp: { src: string; cursor: number; line: number } | null
}
let rs: RenderState | null = null

// Cap proxied images per preview. Each is a jj subprocess (SSH mode: a full
// round trip). A malicious README with 1000 images would queue 1000 requests.
const MAX_PROXIED_IMAGES = 50

interface Footnote { html: string; srcLine?: number }
// fnScope is NOT per-render — it's a cross-render counter so multiple .md
// previews on one page (DiffPanel shows several) get distinct anchor ids.
let fnScope = 0

// ── Heading anchor IDs ─────────────────────────────────────────────────────
// GitHub-compatible slugify: spaces → '-' BEFORE stripping non-word chars,
// so `P3 — Advanced` → `p3-—-advanced` → `p3--advanced` (the actual link
// shape in CHANGELOG-ARCHIVE). Strip-then-collapse would merge to one hyphen.
// Not byte-exact for md formatting (`## _italic_` → `_italic_` vs GitHub's
// `italic`), but stable + linkable. Dedup with -N suffix per render.
function headingId(text: string): string {
  const slug = text.toLowerCase().replace(/\s/g, '-').replace(/[^\w-]/g, '')
  if (!slug) return ''
  const n = rs!.headingSlugs.get(slug) ?? 0
  rs!.headingSlugs.set(slug, n + 1)
  return ` id="${n ? `${slug}-${n}` : slug}"`
}

// ── GitHub-style alerts ────────────────────────────────────────────────────
// {0,3} — CommonMark allows up to 3 leading spaces before `>` and token.raw
// preserves them. Nested case (`> > [!NOTE]`) is fine — marked strips the
// outer `> ` before recursing, so the inner raw starts at `>`.
const ALERT_RE = /^ {0,3}>\s*\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]\s*(?:\n|$)/i
const ALERT_TITLES: Record<string, string> = {
  note: 'Note', tip: 'Tip', important: 'Important', warning: 'Warning', caution: 'Caution',
}

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
  if (!rs!.imgCtx || SCHEME_RE.test(href)) return href
  if (++rs!.imgCount > MAX_PROXIED_IMAGES) return ''
  // Strip ?query/#fragment — browser applies those client-side; server needs
  // bare file path. Decode before URLSearchParams re-encodes (avoids %20→%2520).
  const clean = tryDecode(href.replace(/[?#].*$/, ''))
  // Leading `/` = repo-root-relative (common in docs); strip it, skip baseDir.
  const path = clean.startsWith('/')
    ? clean.slice(1)
    : rs!.imgCtx.baseDir ? `${rs!.imgCtx.baseDir}/${clean}` : clean
  return api.fileRawUrl(rs!.imgCtx.revision, path)
}

// ── Source-line stamping for preview annotations ──────────────────────────
// Block tokens get _srcLine during walkTokens; renderer hooks emit it as
// data-src-line. Clicks on rendered blocks resolve back to {lineNum,
// lineContent} — identical anchor coordinates to diff-view annotations, so
// the store/reanchor/backend pipeline is untouched. When stampCtx is null
// (plain renderMarkdown), nothing stamps → srcAttr returns '' → hooks return
// false → default renderer runs. Zero cost for the non-annotated path.

type Stamped = Token & { _srcLine?: number }
const STAMPED = new Set(['heading', 'paragraph', 'list_item', 'blockquote', 'code', 'hr', 'table', 'footnoteDef'])
// Containers have STAMPED descendants whose .raw is a substring of the
// parent's — cursor must stay at pos+1 so the child is found. Leaf blocks
// advance past their full raw so a later block whose text appears verbatim
// inside an earlier code fence isn't matched there.
const CONTAINER = new Set(['list_item', 'blockquote'])

// Default table renderer — used below to wrap with srcAttr without
// reimplementing header/align/row logic. TableCell has no `raw`, so per-row
// stamping isn't possible; per-table is the best the data supports.
const defaultTable = new marked.Renderer().table

// walkTokens visits depth-first in document order. indexOf(raw, cursor) with
// a monotone cursor disambiguates duplicate raw slices (two identical list
// items resolve to their respective source positions). Cursor advances to
// pos+1 (not pos — that would re-find the same match; not pos+raw.length —
// a list_item's raw contains its child paragraph's raw, advancing past it
// would skip the child). Line count is incremental: pos ≥ cursor always
// (indexOf guarantee), so counting [cursor, pos) makes total work O(src)
// regardless of block count.
function stamp(token: Token) {
  const sc = rs?.stamp
  if (!sc || !STAMPED.has(token.type)) return
  const pos = sc.src.indexOf(token.raw, sc.cursor)
  if (pos < 0) return
  for (let i = sc.cursor; i < pos; i++) {
    if (sc.src.charCodeAt(i) === 10) sc.line++
  }
  ;(token as Stamped)._srcLine = sc.line
  const skip = CONTAINER.has(token.type) ? 1 : token.raw.length
  // Newlines inside the skipped span must be counted too, or the next
  // token's [cursor,pos) count starts from the wrong base.
  for (let i = pos; i < pos + skip; i++) {
    if (sc.src.charCodeAt(i) === 10) sc.line++
  }
  sc.cursor = pos + skip
}

const srcAttr = (t: Stamped) => t._srcLine ? ` data-src-line="${t._srcLine}"` : ''

marked.use({
  gfm: true,
  extensions: [
    {
      name: 'footnoteRef',
      level: 'inline',
      start: (src) => src.indexOf('[^'),
      // (?![(:]) — don't match [^x](url) (let link tokenizer have it) or
      // [^x]: at line start (def, not ref).
      tokenizer(src) {
        const m = /^\[\^([^\]\s]+)\](?![(:])/.exec(src)
        if (!m) return
        return { type: 'footnoteRef', raw: m[0], label: m[1] }
      },
      renderer(token: Tokens.Generic) {
        const label = token.label as string
        const isFirst = !rs!.fnLabelToIdx.has(label)
        let idx = rs!.fnLabelToIdx.get(label)
        if (idx === undefined) {
          idx = rs!.footnotes.push({ html: '' }) - 1
          rs!.fnLabelToIdx.set(label, idx)
        }
        // id only on first ref — dupes would be invalid HTML and the def's
        // back-link can only point to one anyway.
        const id = isFirst ? ` id="fnref${fnScope}-${idx}"` : ''
        return `<sup class="fn-ref"><a${id} href="#fn${fnScope}-${idx}">${idx + 1}</a></sup>`
      },
    },
    {
      name: 'footnoteDef',
      level: 'block',
      // m flag — ^ matches line-start anywhere in remaining src, so marked
      // can fast-forward past plain paragraphs to the next candidate.
      start: (src) => src.match(/^\[\^[^\]\s]+\]:/m)?.index,
      // \n[ \t]+[^\n]+ — indented continuation lines join into one body.
      // Trailing \n* consumed so they don't become an empty <p>.
      tokenizer(src) {
        const m = /^\[\^([^\]\s]+)\]:[ \t]*([^\n]*(?:\n[ \t]+[^\n]+)*)\n*/.exec(src)
        if (!m) return
        const body = m[2].replace(/\n[ \t]+/g, ' ').trim()
        return { type: 'footnoteDef', raw: m[0], label: m[1], tokens: this.lexer.inlineTokens(body) }
      },
      renderer(token: Tokens.Generic) {
        // Same create-if-missing as the ref renderer — defs at the top of a
        // doc render before refs and would otherwise be silently dropped.
        const label = token.label as string
        let idx = rs!.fnLabelToIdx.get(label)
        if (idx === undefined) {
          idx = rs!.footnotes.push({ html: '' }) - 1
          rs!.fnLabelToIdx.set(label, idx)
        }
        rs!.footnotes[idx].html = this.parser.parseInline(token.tokens!)
        rs!.footnotes[idx].srcLine = (token as Stamped)._srcLine
        return ''
      },
    },
  ],
  walkTokens: stamp,
  renderer: {
    code(token: Tokens.Code) {
      const { text, lang } = token
      if (lang === 'mermaid') {
        const svg = tryRenderDiagram(text)
        if (svg) {
          const idx = rs!.pendingDiagrams.push(svg) - 1
          return `<i data-mermaid="${idx}"${srcAttr(token)}></i>`
        }
        // Not-yet-loaded, unsupported type, parse error, or over-limit — raw
        // code block. If loading was the reason, the caller re-derives once
        // mermaidReady flips and this path re-tries.
        return `<pre class="mermaid-fallback"${srcAttr(token)}><code>${escapeHtml(text)}</code></pre>`
      }
      // Fence info string can be `js {1-3}` or `typescript:foo.ts` — take
      // the leading word. highlightLines falls through to escapeHtml on
      // unknown langs (and unloaded legacy langs — bash/toml on first paint).
      const key = lang?.split(/[^\w-]/)[0] ?? ''
      const hl = highlightLines(text.split('\n'), EXTENSION_LANGUAGES[key] ?? key).join('\n')
      return `<pre${srcAttr(token)}><code>${hl}</code></pre>\n`
    },
    image({ href, title, text }: Tokens.Image) {
      const src = resolveImgSrc(href)
      const t = title ? ` title="${escapeAttr(title)}"` : ''
      return `<img src="${escapeAttr(src)}" alt="${escapeAttr(text)}"${t}>`
    },
    heading(token: Tokens.Heading) {
      const d = token.depth
      return `<h${d}${headingId(token.text)}${srcAttr(token)}>${this.parser.parseInline(token.tokens)}</h${d}>\n`
    },
    paragraph(token: Tokens.Paragraph) {
      const a = srcAttr(token)
      if (!a) return false
      return `<p${a}>${this.parser.parseInline(token.tokens)}</p>\n`
    },
    blockquote(token: Tokens.Blockquote) {
      const a = srcAttr(token)
      const alert = ALERT_RE.exec(token.raw)
      if (alert) {
        const kind = alert[1].toLowerCase()
        // Strip the [!TYPE] marker from rendered inner HTML. Two-pass:
        // whole-paragraph case (`> [!NOTE]\n>\n> body` — marker is its own
        // <p>) then same-paragraph case (`> [!NOTE]\n> body` — marker is
        // first line of body's <p>). Only one matches per input.
        const inner = this.parser.parse(token.tokens)
          .replace(/^<p[^>]*>\[!\w+\]\s*<\/p>\s*/i, '')
          .replace(/^(<p[^>]*>)\[!\w+\]\s*/i, '$1')
        return `<div class="md-alert md-alert-${kind}"${a}><p class="md-alert-title">${ALERT_TITLES[kind]}</p>${inner}</div>\n`
      }
      if (!a) return false
      return `<blockquote${a}>${this.parser.parse(token.tokens)}</blockquote>\n`
    },
    hr(token: Tokens.Hr) {
      const a = srcAttr(token)
      if (!a) return false
      return `<hr${a}>\n`
    },
    listitem(token: Tokens.ListItem) {
      const a = srcAttr(token)
      if (!a) return false
      const check = token.task
        ? `<input type="checkbox" disabled${token.checked ? ' checked' : ''}> `
        : ''
      return `<li${a}>${check}${this.parser.parse(token.tokens)}</li>\n`
    },
    table(token: Tokens.Table) {
      const a = srcAttr(token)
      if (!a) return false
      return defaultTable.call(this, token).replace('<table>', `<table${a}>`)
    },
  },
})

// FORBID_TAGS: <style>/<link> in reviewed markdown create GLOBAL stylesheets
// (UI-breaker / phishing overlay). No svg profile — mermaid SVG bypasses
// sanitize via the placeholder above. Inline style attr is NOT forbidden;
// position:fixed is neutralized by `contain: layout` on .md-preview.
// SANITIZE_DOM:false — the default strips id values matching DOM property
// names (`## Content` → id="content" gone; common English words). The
// clobbering vector this guards against is form-input naming, which
// FORBID_TAGS:['form'] already closes. Heading-id authorship is the repo
// author — same trust level as the code under review.
const SANITIZE_CFG = {
  USE_PROFILES: { html: true },
  FORBID_TAGS: ['style', 'link', 'form'],
  SANITIZE_DOM: false,
}

export interface PreviewContext {
  revision: string
  // Directory of the markdown file (for resolving relative img src).
  // Empty string = repo root.
  baseDir: string
}

export function renderMarkdown(src: string, ctx?: PreviewContext, stampSrc = false): string {
  fnScope++
  rs = {
    pendingDiagrams: [], imgCtx: ctx ?? null, imgCount: 0,
    footnotes: [], fnLabelToIdx: new Map(), headingSlugs: new Map(),
    stamp: stampSrc ? { src, cursor: 0, line: 1 } : null,
  }
  try {
    const html = DOMPurify.sanitize(marked.parse(src) as string, SANITIZE_CFG)
    let result = html.replace(
      /<i data-mermaid="(\d+)"( data-src-line="\d+")?><\/i>/g,
      (_, i, srcLine) => `<div class="mermaid-block"${srcLine ?? ''}>${rs!.pendingDiagrams[+i]}</div>`,
    )
    if (rs.footnotes.length) {
      const items = rs.footnotes.map((f, i) => {
        const sl = f.srcLine ? ` data-src-line="${f.srcLine}"` : ''
        return `<li id="fn${fnScope}-${i}"${sl}>${f.html || '<em>(missing)</em>'} <a href="#fnref${fnScope}-${i}" class="fn-back" aria-label="back">\u21a9</a></li>`
      }).join('')
      // Separate sanitize pass — def body is parseInline of user content.
      result += DOMPurify.sanitize(`<section class="footnotes"><ol>${items}</ol></section>`, SANITIZE_CFG)
    }
    return result
  } finally {
    rs = null
  }
}

export const renderMarkdownAnnotated = (src: string, ctx?: PreviewContext) =>
  renderMarkdown(src, ctx, true)

// Iterate stamped blocks with their [start, end) source-line range. Nested
// blocks (loose-list <li> containing a same-line <p>) yield only the inner —
// the outer's range collapses to empty since [start, next) = [N, N).
export type StampedRange = { el: HTMLElement; start: number; end: number }

// Feeds MarkdownPreview's gutter-row measurement. distinct is sorted (NOT
// doc-order — footnote <li>s are appended at HTML end but carry their
// mid-document [^x]: srcLine), then nextOf is O(1).
export function stampedBlocks(container: HTMLElement, totalLines: number): StampedRange[] {
  const blocks = [...container.querySelectorAll<HTMLElement>('[data-src-line]')]
  const lines = blocks.map(el => +el.dataset.srcLine!)
  const distinct = [...new Set(lines)].sort((a, b) => a - b)
  const nextOf = new Map<number, number>()
  for (let i = 0; i < distinct.length; i++) nextOf.set(distinct[i], distinct[i + 1] ?? totalLines + 1)
  const out: StampedRange[] = []
  for (let i = 0; i < blocks.length; i++) {
    const start = lines[i]
    if (blocks[i].querySelector(`[data-src-line="${start}"]`)) continue
    out.push({ el: blocks[i], start, end: nextOf.get(start)! })
  }
  return out
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
