// Delta-based panel-resize drags (issue #43).
//
// A resize divider must stay under the pointer for the whole drag. The only
// layout-independent way to guarantee that is to work in DELTAS: remember the
// panel's rendered size and the pointer coordinate at mousedown, then
// size = startSize + sign * (pointer - startPointer). Deriving the size from an
// absolute pointer coordinate (`innerHeight - clientY`, raw `clientX`) silently
// assumes the panel's far edge sits on the viewport edge — false as soon as
// anything sits beyond it (StatusBar, Oplog drawer), and off by the grab offset
// inside the handle even when it's true.
//
// The 1:1 tracking also requires that the layout gives every resized pixel to
// ONE flexible sibling (the panel's neighbour shrinks by exactly what the panel
// grows). If a second flex-grow sibling shares the free space, the divider
// moves at a fraction of the pointer speed — see the Oplog drawer note in
// App.svelte's style block.

/** Pure: next panel size for a pointer position. `sign` is +1 when moving the
 *  pointer toward +axis grows the panel (a divider on the panel's right/bottom
 *  edge), -1 when it shrinks it (divider on the left/top edge — dragging up
 *  grows a bottom drawer). Clamps to [min, max]; when the space is too small
 *  for both (max < min) min wins, matching CSS min-size precedence. */
export function resizeFromDelta(
  startSize: number, startPointer: number, pointer: number,
  sign: 1 | -1, min: number, max: number,
): number {
  const raw = startSize + sign * (pointer - startPointer)
  return Math.max(min, Math.min(max, Math.round(raw)))
}

export interface ResizeDragOptions {
  axis: 'x' | 'y'
  /** See resizeFromDelta. */
  sign: 1 | -1
  /** The panel's RENDERED size at mousedown (measure it — the stored config
   *  value can differ when CSS clamps/shrinks the panel). */
  startSize: number
  min: number
  /** Computed once at mousedown from the space actually available. */
  max: number
  onResize: (size: number) => void
  setDragging?: (v: boolean) => void
}

/** Start a delta-based resize drag from a mousedown event. Owns listener
 *  cleanup and the body cursor/user-select overrides. Returns a cancel fn
 *  (unused by App today; handy for tests and unmount paths). */
export function startResizeDrag(e: MouseEvent, opts: ResizeDragOptions): () => void {
  e.preventDefault()
  const { axis, sign, startSize, min, max, onResize, setDragging } = opts
  const startPointer = axis === 'x' ? e.clientX : e.clientY
  setDragging?.(true)
  const body = document.body.style
  body.userSelect = 'none'
  body.cursor = axis === 'x' ? 'col-resize' : 'row-resize'
  function onMove(ev: MouseEvent) {
    onResize(resizeFromDelta(startSize, startPointer, axis === 'x' ? ev.clientX : ev.clientY, sign, min, max))
  }
  function stop() {
    setDragging?.(false)
    body.userSelect = ''
    body.cursor = ''
    window.removeEventListener('mousemove', onMove)
    window.removeEventListener('mouseup', stop)
  }
  window.addEventListener('mousemove', onMove)
  window.addEventListener('mouseup', stop)
  return stop
}
