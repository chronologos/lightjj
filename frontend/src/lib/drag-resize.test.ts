import { describe, it, expect, vi } from 'vitest'
import fc from 'fast-check'
import { resizeFromDelta, startResizeDrag } from './drag-resize'

describe('resizeFromDelta', () => {
  it('bottom drawer (sign -1): dragging up by d grows by d — no absolute-position term', () => {
    // Issue #43: the old math was innerHeight - clientY, which folded the
    // StatusBar (and Oplog drawer) height into the panel on the first move.
    // With a delta there is no first-move jump: pointer unchanged → size unchanged.
    expect(resizeFromDelta(360, 500, 500, -1, 120, 800)).toBe(360)
    expect(resizeFromDelta(360, 500, 450, -1, 120, 800)).toBe(410)
    expect(resizeFromDelta(360, 500, 560, -1, 120, 800)).toBe(300)
  })

  it('left panel (sign +1): dragging right by d grows by d, independent of grab offset', () => {
    // Grabbing the 4px handle 3px in used to snap width to clientX (+3px).
    expect(resizeFromDelta(420, 423, 423, 1, 280, 600)).toBe(420)
    expect(resizeFromDelta(420, 423, 473, 1, 280, 600)).toBe(470)
  })

  it('clamps to [min, max]; min wins when the space is smaller than min', () => {
    expect(resizeFromDelta(360, 500, 0, -1, 120, 500)).toBe(500)
    expect(resizeFromDelta(360, 500, 900, -1, 120, 500)).toBe(120)
    expect(resizeFromDelta(200, 0, 0, 1, 280, 100)).toBe(280)
  })

  it('property: inside the clamp the panel edge moves exactly with the pointer', () => {
    fc.assert(fc.property(
      fc.integer({ min: 120, max: 600 }), fc.integer({ min: 0, max: 1000 }),
      fc.integer({ min: -2000, max: 2000 }), fc.constantFrom(1 as const, -1 as const),
      (start, p0, delta, sign) => {
        const size = resizeFromDelta(start, p0, p0 + delta, sign, 0, 10_000)
        const expected = start + sign * delta
        if (expected >= 0 && expected <= 10_000) expect(size).toBe(expected)
      },
    ))
  })
})

describe('startResizeDrag', () => {
  const mouse = (type: string, x: number, y: number) =>
    new MouseEvent(type, { clientX: x, clientY: y, bubbles: true, cancelable: true })

  it('drives onResize from deltas, toggles dragging + body cursor, cleans up on mouseup', () => {
    const sizes: number[] = []
    const dragging = vi.fn()
    const down = mouse('mousedown', 10, 500)
    startResizeDrag(down, {
      axis: 'y', sign: -1, startSize: 360, min: 120, max: 400,
      onResize: s => sizes.push(s), setDragging: dragging,
    })
    expect(down.defaultPrevented).toBe(true)
    expect(dragging).toHaveBeenLastCalledWith(true)
    expect(document.body.style.cursor).toBe('row-resize')

    window.dispatchEvent(mouse('mousemove', 10, 500))  // no movement → no jump
    window.dispatchEvent(mouse('mousemove', 10, 480))
    window.dispatchEvent(mouse('mousemove', 10, 300))  // past max → clamped
    expect(sizes).toEqual([360, 380, 400])

    window.dispatchEvent(mouse('mouseup', 10, 300))
    expect(dragging).toHaveBeenLastCalledWith(false)
    expect(document.body.style.cursor).toBe('')
    expect(document.body.style.userSelect).toBe('')
    window.dispatchEvent(mouse('mousemove', 10, 200))  // listeners removed
    expect(sizes).toHaveLength(3)
  })

  it('x axis reads clientX and sets col-resize', () => {
    const sizes: number[] = []
    const stop = startResizeDrag(mouse('mousedown', 423, 50), {
      axis: 'x', sign: 1, startSize: 420, min: 280, max: 600, onResize: s => sizes.push(s),
    })
    expect(document.body.style.cursor).toBe('col-resize')
    window.dispatchEvent(mouse('mousemove', 453, 999))
    stop()
    expect(sizes).toEqual([450])
    expect(document.body.style.cursor).toBe('')
  })
})
