// Hand-rolled wheel-zoom + drag-pan + dblclick-reset for an inline <svg>.
// Shared by mermaid (markdown-render) and excalidraw previews — extracted so
// the .excalidraw lazy chunk doesn't pull marked/dompurify just for this.

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
export function wireSvg(svg: SVGSVGElement, canvas: HTMLElement): () => void {
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
