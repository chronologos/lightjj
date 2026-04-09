// Minimal Excalidraw → SVG renderer. Zero deps; clean geometric shapes (no
// rough.js wobble — that's the explicit trade-off vs the ~1MB official
// React-bound exportToSvg). Covers rectangle / ellipse / diamond / line /
// arrow / text / freedraw; everything else renders as a labeled placeholder
// box so the diagram layout stays legible.
//
// Schema reference: github.com/excalidraw/excalidraw — packages/element/src/types.ts.
// All coordinates are absolute scene units; `points` on linear/freedraw
// elements are LOCAL offsets from the element's own (x,y); `angle` is radians.

import { escapeHtml, escapeAttr } from './highlighter'

interface ExElement {
  id: string
  type: string
  x: number
  y: number
  width: number
  height: number
  angle: number
  strokeColor: string
  backgroundColor: string
  fillStyle: 'solid' | 'hachure' | 'cross-hatch' | 'zigzag'
  strokeWidth: number
  strokeStyle: 'solid' | 'dashed' | 'dotted'
  roundness: { type: number; value?: number } | null
  opacity: number
  isDeleted?: boolean
  // linear / freedraw
  points?: readonly (readonly [number, number])[]
  startArrowhead?: string | null
  endArrowhead?: string | null
  // text
  text?: string
  fontSize?: number
  fontFamily?: number
  textAlign?: 'left' | 'center' | 'right'
}

interface ExDoc {
  type: string
  elements: ExElement[]
  appState?: { viewBackgroundColor?: string }
}

const PAD = 20
const FALLBACK_BG = '#ffffff'

// Excalidraw stores fontFamily as a numeric enum. 5 (Excalifont) and the
// legacy 1 (Virgil) are hand-drawn faces we don't ship — degrade to the UI
// sans so glyph widths stay close to the saved bbox.
const FONT_FAMILY: Record<number, string> = {
  2: 'Inter, sans-serif',                       // Nunito → UI sans
  3: 'var(--font-mono, monospace)',             // Comic Shanns → mono
  6: 'var(--font-mono, monospace)',             // Cascadia
  7: 'Inter, sans-serif',                       // Liberation Sans
}
const DEFAULT_FONT = 'Inter, sans-serif'

const num = (v: unknown, d = 0): number => typeof v === 'number' && Number.isFinite(v) ? v : d

export function renderExcalidrawSVG(jsonText: string): string | null {
  let doc: ExDoc
  try {
    doc = JSON.parse(jsonText)
  } catch {
    return null
  }
  if (doc?.type !== 'excalidraw' || !Array.isArray(doc.elements)) return null

  const els = doc.elements.filter(e => e && !e.isDeleted)
  if (els.length === 0) {
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 60"><text x="100" y="35" text-anchor="middle" fill="var(--overlay0)" font-size="13">(empty diagram)</text></svg>`
  }

  // ── Bounding box ─────────────────────────────────────────────────────────
  // Axis-aligned over unrotated extents. Rotated elements may overhang; PAD
  // absorbs typical cases. Exact rotated-AABB math isn't worth it for a
  // preview (panzoom lets the user scroll if something clips).
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  const grow = (x: number, y: number) => {
    if (x < minX) minX = x; if (y < minY) minY = y
    if (x > maxX) maxX = x; if (y > maxY) maxY = y
  }
  for (const e of els) {
    const x = num(e.x), y = num(e.y)
    grow(x, y)
    grow(x + num(e.width), y + num(e.height))
    if (e.points) for (const [px, py] of e.points) grow(x + num(px), y + num(py))
  }
  const vb = `${minX - PAD} ${minY - PAD} ${maxX - minX + 2 * PAD} ${maxY - minY + 2 * PAD}`
  const bg = doc.appState?.viewBackgroundColor || FALLBACK_BG

  const body = els.map(renderElement).join('')
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${vb}" style="background:${escapeAttr(bg)}">` +
    `<defs>${ARROW_MARKER}</defs>${body}</svg>`
}

// context-stroke (SVG2) makes one marker def serve every stroke color.
// Supported in all evergreen browsers; degrades to black in legacy engines.
const ARROW_MARKER =
  `<marker id="ex-arrow-end" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="5" markerHeight="5" orient="auto-start-reverse">` +
  `<path d="M0,0 L10,5 L0,10 z" fill="context-stroke"/></marker>`

function renderElement(e: ExElement): string {
  const x = num(e.x), y = num(e.y), w = num(e.width), h = num(e.height)
  const attrs = strokeFill(e) + rotate(e, x + w / 2, y + h / 2)

  switch (e.type) {
    case 'rectangle': {
      const rx = e.roundness ? Math.min(w, h) * 0.25 : 0
      return `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${rx}"${attrs}/>`
    }
    case 'ellipse':
      return `<ellipse cx="${x + w / 2}" cy="${y + h / 2}" rx="${w / 2}" ry="${h / 2}"${attrs}/>`
    case 'diamond':
      return `<polygon points="${x + w / 2},${y} ${x + w},${y + h / 2} ${x + w / 2},${y + h} ${x},${y + h / 2}"${attrs}/>`
    case 'line':
    case 'arrow':
      return renderLinear(e, x, y)
    case 'freedraw':
      return renderFreedraw(e, x, y)
    case 'text':
      return renderText(e, x, y)
    default:
      // image, frame, embeddable, iframe — labeled placeholder so layout reads.
      return `<g${rotate(e, x + w / 2, y + h / 2)}>` +
        `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="none" stroke="var(--overlay0)" stroke-dasharray="4 4"/>` +
        `<text x="${x + w / 2}" y="${y + h / 2}" text-anchor="middle" dominant-baseline="central" fill="var(--overlay0)" font-size="11">${escapeHtml(e.type)}</text></g>`
  }
}

function renderLinear(e: ExElement, x: number, y: number): string {
  const pts = e.points ?? []
  if (pts.length < 2) return ''
  const d = 'M' + pts.map(([px, py]) => `${x + num(px)},${y + num(py)}`).join(' L')
  // Any non-null arrowhead → triangle. Excalidraw has bar/dot/circle variants;
  // collapsing to one shape keeps <defs> tiny and is visually unambiguous.
  const ms = e.startArrowhead ? ` marker-start="url(#ex-arrow-end)"` : ''
  const me = e.endArrowhead ? ` marker-end="url(#ex-arrow-end)"` : ''
  return `<path d="${d}" fill="none"${strokeOnly(e)}${ms}${me}${rotate(e, x + num(e.width) / 2, y + num(e.height) / 2)}/>`
}

function renderFreedraw(e: ExElement, x: number, y: number): string {
  const pts = e.points ?? []
  if (pts.length === 0) return ''
  const d = 'M' + pts.map(([px, py]) => `${x + num(px)},${y + num(py)}`).join(' L')
  return `<path d="${d}" fill="none" stroke="${color(e.strokeColor)}" stroke-width="${num(e.strokeWidth, 1) * 2}" stroke-linecap="round" stroke-linejoin="round"${opacity(e)}/>`
}

function renderText(e: ExElement, x: number, y: number): string {
  const fs = num(e.fontSize, 16)
  // Excalidraw line height is 1.25× fontSize; (x,y) is the box top-left.
  // hanging baseline lets us position by top edge without measuring ascent.
  const lh = fs * 1.25
  const lines = (e.text ?? '').split('\n')
  const align = e.textAlign ?? 'left'
  const anchor = align === 'center' ? 'middle' : align === 'right' ? 'end' : 'start'
  const tx = align === 'center' ? x + num(e.width) / 2 : align === 'right' ? x + num(e.width) : x
  const family = FONT_FAMILY[e.fontFamily ?? 0] ?? DEFAULT_FONT
  const spans = lines.map((ln, i) =>
    `<tspan x="${tx}" y="${y + i * lh}" dominant-baseline="hanging">${escapeHtml(ln)}</tspan>`
  ).join('')
  return `<text fill="${color(e.strokeColor)}" font-size="${fs}" font-family="${escapeAttr(family)}" text-anchor="${anchor}"${opacity(e)}${rotate(e, x + num(e.width) / 2, y + num(e.height) / 2)}>${spans}</text>`
}

// ── Attribute helpers ──────────────────────────────────────────────────────

function strokeFill(e: ExElement): string {
  // Non-solid fillStyles (hachure/cross-hatch/zigzag) are rough.js patterns —
  // we render them as unfilled. backgroundColor==='transparent' is the common
  // explicit-unfilled value.
  const bg = e.backgroundColor
  const fill = e.fillStyle === 'solid' && bg && bg !== 'transparent' ? color(bg) : 'none'
  return ` fill="${fill}"${strokeOnly(e)}`
}

function strokeOnly(e: ExElement): string {
  const sw = num(e.strokeWidth, 1)
  const dash = e.strokeStyle === 'dashed' ? ` stroke-dasharray="${sw * 4} ${sw * 4}"`
    : e.strokeStyle === 'dotted' ? ` stroke-dasharray="${sw} ${sw * 2}"` : ''
  return ` stroke="${color(e.strokeColor)}" stroke-width="${sw}"${dash}${opacity(e)}`
}

const opacity = (e: ExElement) => {
  const o = num(e.opacity, 100)
  return o < 100 ? ` opacity="${o / 100}"` : ''
}

const rotate = (e: ExElement, cx: number, cy: number) => {
  const a = num(e.angle)
  return a ? ` transform="rotate(${a * 180 / Math.PI} ${cx} ${cy})"` : ''
}

// Colors are author-chosen hex/named values stored in the file — render
// faithfully (the SVG sits on appState.viewBackgroundColor, so contrast is
// what the author saw). escapeAttr (not escapeHtml — `"` breaks out of the
// attribute and lands an event handler on the element) guards malformed input.
const color = (c: string | undefined) => escapeAttr(c || '#1e1e1e')
