import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { flushSync } from 'svelte'
import { createListCursor, type ListCursorOptions, type ListCursor } from './list-cursor.svelte'

// Runes need a reactive scope outside components — same pattern as
// virtual.svelte.test.ts. The cleanup fn tears down the clamp $effect.
let cleanups: (() => void)[] = []
function withRoot<T>(fn: () => T): T {
  let result!: T
  cleanups.push($effect.root(() => { result = fn() }))
  flushSync()
  return result
}
afterEach(() => {
  cleanups.forEach(c => c())
  cleanups = []
})

function key(k: string, opts: KeyboardEventInit = {}): KeyboardEvent {
  return new KeyboardEvent('keydown', { key: k, cancelable: true, ...opts })
}

function mkCursor(over: Partial<ListCursorOptions> = {}, count = { n: 3 }): ListCursor {
  return withRoot(() => createListCursor({ count: () => count.n, ...over }))
}

/** Container with [data-idx] rows, for hover + scroll tests. */
function mkRows(n: number): { container: HTMLElement; rows: HTMLElement[] } {
  const container = document.createElement('div')
  const rows = Array.from({ length: n }, (_, i) => {
    const row = document.createElement('div')
    row.setAttribute('data-idx', String(i))
    container.appendChild(row)
    return row
  })
  document.body.appendChild(container)
  return { container, rows }
}

beforeEach(() => {
  document.body.innerHTML = ''
})

describe('createListCursor — key routing', () => {
  it('j/ArrowDown move down, k/ArrowUp move up; consumed + preventDefault', () => {
    const c = mkCursor()
    const e1 = key('j')
    expect(c.handleKey(e1)).toBe(true)
    expect(e1.defaultPrevented).toBe(true)
    expect(c.index).toBe(1)

    expect(c.handleKey(key('ArrowDown'))).toBe(true)
    expect(c.index).toBe(2)

    const e2 = key('k')
    expect(c.handleKey(e2)).toBe(true)
    expect(e2.defaultPrevented).toBe(true)
    expect(c.index).toBe(1)

    expect(c.handleKey(key('ArrowUp'))).toBe(true)
    expect(c.index).toBe(0)
  })

  it('clamps at both ends; clamped keys are still consumed', () => {
    const c = mkCursor()
    expect(c.handleKey(key('k'))).toBe(true) // at 0, k clamps
    expect(c.index).toBe(0)
    c.handleKey(key('j'))
    c.handleKey(key('j'))
    expect(c.index).toBe(2)
    expect(c.handleKey(key('j'))).toBe(true) // at last, j clamps
    expect(c.index).toBe(2)
  })

  it('initialIndex -1: first nav key in either direction selects row 0', () => {
    const down = mkCursor({ initialIndex: -1 })
    expect(down.index).toBe(-1)
    down.handleKey(key('j'))
    expect(down.index).toBe(0)

    const up = mkCursor({ initialIndex: -1 })
    up.handleKey(key('k'))
    expect(up.index).toBe(0)
  })

  it('empty list: nav keys are consumed but the cursor does not move', () => {
    const onMove = vi.fn()
    const c = mkCursor({ onMove }, { n: 0 })
    expect(c.handleKey(key('j'))).toBe(true)
    expect(c.index).toBe(0)
    expect(onMove).not.toHaveBeenCalled()
  })

  it('unhandled keys return false without preventDefault', () => {
    const c = mkCursor()
    const e = key('d')
    expect(c.handleKey(e)).toBe(false)
    expect(e.defaultPrevented).toBe(false)
    expect(c.index).toBe(0)
  })
})

describe('createListCursor — Enter/Escape/slash hooks', () => {
  it('Enter with hook: preventDefault + hook + consumed', () => {
    const onEnter = vi.fn()
    const c = mkCursor({ onEnter })
    const e = key('Enter')
    expect(c.handleKey(e)).toBe(true)
    expect(e.defaultPrevented).toBe(true)
    expect(onEnter).toHaveBeenCalledWith(e)
  })

  it('Enter without hook falls through (no preventDefault) — bubbling contract', () => {
    // FileSelectionPanel relies on Enter/Escape reaching App's global handler.
    const c = mkCursor()
    const e = key('Enter')
    expect(c.handleKey(e)).toBe(false)
    expect(e.defaultPrevented).toBe(false)
  })

  it('Escape with hook fires; without hook falls through', () => {
    const onEscape = vi.fn()
    const c = mkCursor({ onEscape })
    expect(c.handleKey(key('Escape'))).toBe(true)
    expect(onEscape).toHaveBeenCalledOnce()

    const bare = mkCursor()
    const e = key('Escape')
    expect(bare.handleKey(e)).toBe(false)
    expect(e.defaultPrevented).toBe(false)
  })

  it('slash fires hook when input not focused; falls through when focused', () => {
    const onSlash = vi.fn()
    let focused = false
    const c = mkCursor({ onSlash, inputFocused: () => focused })
    expect(c.handleKey(key('/'))).toBe(true)
    expect(onSlash).toHaveBeenCalledOnce()

    focused = true
    const e = key('/')
    expect(c.handleKey(e)).toBe(false) // types into the filter
    expect(e.defaultPrevented).toBe(false)
    expect(onSlash).toHaveBeenCalledOnce() // not called again
  })
})

describe('createListCursor — inputFocused guard', () => {
  it('j/k fall through while input is focused (they type into the filter)', () => {
    let focused = true
    const c = mkCursor({ inputFocused: () => focused })
    const e = key('j')
    expect(c.handleKey(e)).toBe(false)
    expect(e.defaultPrevented).toBe(false)
    expect(c.index).toBe(0)

    focused = false
    expect(c.handleKey(key('j'))).toBe(true)
    expect(c.index).toBe(1)
  })

  it('ArrowDown while focused navigates AND calls onLeaveInput; ArrowUp navigates without it', () => {
    const onLeaveInput = vi.fn()
    const c = mkCursor({ inputFocused: () => true, onLeaveInput })

    expect(c.handleKey(key('ArrowDown'))).toBe(true)
    expect(c.index).toBe(1)
    expect(onLeaveInput).toHaveBeenCalledOnce()

    expect(c.handleKey(key('ArrowUp'))).toBe(true)
    expect(c.index).toBe(0)
    expect(onLeaveInput).toHaveBeenCalledOnce() // ArrowUp does not refocus
  })

  it('Enter still fires while input is focused (filter-then-Enter flow)', () => {
    const onEnter = vi.fn()
    const c = mkCursor({ inputFocused: () => true, onEnter })
    expect(c.handleKey(key('Enter'))).toBe(true)
    expect(onEnter).toHaveBeenCalledOnce()
  })
})

describe('createListCursor — onNav / onMove', () => {
  it('onNav fires on every consumed nav key, even when clamped; onMove only on actual change', () => {
    const onNav = vi.fn()
    const onMove = vi.fn()
    const c = mkCursor({ onNav, onMove }, { n: 2 })

    c.handleKey(key('j')) // 0 → 1
    expect(onNav).toHaveBeenCalledTimes(1)
    expect(onMove).toHaveBeenCalledTimes(1)
    expect(onMove).toHaveBeenLastCalledWith(1)

    c.handleKey(key('j')) // clamped at 1
    expect(onNav).toHaveBeenCalledTimes(2)
    expect(onMove).toHaveBeenCalledTimes(1) // no actual move

    c.handleKey(key('k')) // 1 → 0
    expect(onNav).toHaveBeenCalledTimes(3)
    expect(onMove).toHaveBeenCalledTimes(2)
    expect(onMove).toHaveBeenLastCalledWith(0)
  })

  it('onNav fires before the move (disarm-then-move ordering)', () => {
    const calls: string[] = []
    const c = mkCursor({
      onNav: () => calls.push('nav'),
      onMove: () => calls.push('move'),
    })
    c.handleKey(key('j'))
    expect(calls).toEqual(['nav', 'move'])
  })

  it('moveTo/moveBy clamp and report through onMove; direct index writes do not', () => {
    const onMove = vi.fn()
    const c = mkCursor({ onMove }, { n: 5 })

    c.moveTo(99)
    expect(c.index).toBe(4)
    expect(onMove).toHaveBeenLastCalledWith(4)

    c.moveTo(-7)
    expect(c.index).toBe(0)
    expect(onMove).toHaveBeenLastCalledWith(0)

    c.moveBy(3)
    expect(c.index).toBe(3)

    onMove.mockClear()
    c.moveTo(3) // already there
    expect(onMove).not.toHaveBeenCalled()

    c.index = 1 // direct write — restore/reset effects use this
    expect(onMove).not.toHaveBeenCalled()
    expect(c.index).toBe(1)
  })
})

describe('createListCursor — bounds clamping effect', () => {
  it('clamps the cursor when the list shrinks beneath it', () => {
    const counter = withRoot(() => {
      let n = $state(5)
      return { get n() { return n }, set n(v: number) { n = v } }
    })
    const c = withRoot(() => createListCursor({ count: () => counter.n }))

    c.moveTo(4)
    expect(c.index).toBe(4)

    counter.n = 2
    flushSync()
    expect(c.index).toBe(1)
  })

  it('does not touch the cursor when the list shrinks to empty', () => {
    const counter = withRoot(() => {
      let n = $state(3)
      return { get n() { return n }, set n(v: number) { n = v } }
    })
    const c = withRoot(() => createListCursor({ count: () => counter.n }))
    c.moveTo(2)

    counter.n = 0
    flushSync()
    expect(c.index).toBe(2) // left alone — clamped on next non-empty change

    counter.n = 1
    flushSync()
    expect(c.index).toBe(0)
  })
})

describe('createListCursor — hover tracking', () => {
  it('panel mode: mousemove over [data-idx] sets hovered; off-row clears; cursor untouched', () => {
    const { container, rows } = mkRows(3)
    const c = mkCursor({ container: () => container })

    c.onRowsMouseMove({ target: rows[2] } as unknown as MouseEvent)
    expect(c.hovered).toBe(2)
    expect(c.index).toBe(0) // cursor independent of hover

    c.onRowsMouseMove({ target: container } as unknown as MouseEvent)
    expect(c.hovered).toBe(-1)

    c.onRowsMouseMove({ target: rows[1] } as unknown as MouseEvent)
    c.onRowsMouseLeave()
    expect(c.hovered).toBe(-1)
  })

  it('hover targets resolve through closest() — child elements of a row count', () => {
    const { rows } = mkRows(2)
    const child = document.createElement('span')
    rows[1].appendChild(child)
    const c = mkCursor()
    c.onRowsMouseMove({ target: child } as unknown as MouseEvent)
    expect(c.hovered).toBe(1)
  })

  it('hoverMovesCursor mode: mousemove moves the cursor and fires onHoverCursor once per change', () => {
    const onHoverCursor = vi.fn()
    const { rows } = mkRows(3)
    const c = mkCursor({ hoverMovesCursor: true, onHoverCursor })

    c.onRowsMouseMove({ target: rows[2] } as unknown as MouseEvent)
    expect(c.index).toBe(2)
    expect(c.hovered).toBe(-1) // hovered unused in this mode
    expect(onHoverCursor).toHaveBeenCalledTimes(1)

    // Same row again — no re-fire (mousemove streams events continuously)
    c.onRowsMouseMove({ target: rows[2] } as unknown as MouseEvent)
    expect(onHoverCursor).toHaveBeenCalledTimes(1)

    // Off-row movement does nothing (cursor keeps its position)
    c.onRowsMouseMove({ target: document.body } as unknown as MouseEvent)
    expect(c.index).toBe(2)
  })
})

describe('createListCursor — scroll integration', () => {
  /** Per-row scrollIntoView recorder — which row indexes were scrolled to. */
  function recordScrolls(rows: HTMLElement[]): number[] {
    const scrolled: number[] = []
    rows.forEach((r, i) => { r.scrollIntoView = () => { scrolled.push(i) } })
    return scrolled
  }

  it('nav keys and moveTo scroll the active [data-idx] row into view', () => {
    const { container, rows } = mkRows(3)
    const scrolled = recordScrolls(rows)
    const c = mkCursor({ container: () => container })

    c.handleKey(key('j'))
    expect(scrolled).toEqual([1])

    c.moveTo(2)
    expect(scrolled).toEqual([1, 2])

    // Clamped move → no scroll
    c.handleKey(key('j'))
    expect(scrolled).toEqual([1, 2])
  })

  it('hover never scrolls', () => {
    const { container, rows } = mkRows(3)
    const scrolled = recordScrolls(rows)
    const c = mkCursor({ container: () => container })

    c.onRowsMouseMove({ target: rows[2] } as unknown as MouseEvent)
    expect(scrolled).toEqual([])
  })
})
