// Keyboard-navigable list cursor. One factory for the skeleton that was
// previously hand-rolled per component (modals, panels, queues): cursor
// index + hovered index, bounds clamping, j/k/Arrow navigation with the
// filter-input guard, Enter/Escape/'/' hooks, delegated [data-idx] hover
// tracking (the no-:hover rule), and data-idx scroll-into-view.
//
// Two wiring shapes, both supported:
//   - self-focused list: the component's element onkeydown calls handleKey()
//     directly (OplogPanel, GitModal)
//   - delegated-key list: the component EXPORTS handleKeydown which App calls
//     regardless of DOM focus; handleKey()'s boolean return is the
//     "consumed" signal (ConflictQueue, BookmarksPanel)
//
// Domain keys (d/f/t, hotkeys, Space…) stay in the component: call
// handleKey(e) first, fall through to the component's own switch when it
// returns false.
//
// Must be created during component init (it registers a $effect for bounds
// clamping). In unit tests, wrap creation in $effect.root.

import { untrack } from 'svelte'
import { scrollIdxIntoView } from './scroll-into-view'

export interface ListCursorOptions {
  /** Live row count — a getter so the cursor tracks filtered/derived lists. */
  count: () => number
  /** Starting cursor. 0 (default) = first row selected; -1 = nothing selected
   *  until the first nav key lands on row 0 (Oplog/Evolog pattern). */
  initialIndex?: number
  /** Scroll container holding `[data-idx]` rows. When set, cursor moves scroll
   *  the active row into view via scrollIdxIntoView — a data-idx query, never
   *  a selected-class query (see scroll-into-view.ts). */
  container?: () => HTMLElement | undefined
  /** "The filter input has focus." While true, j/k fall through (handleKey
   *  returns false) so they type into the filter; ArrowDown/ArrowUp still
   *  navigate. Default: () => false. */
  inputFocused?: () => boolean
  /** ArrowDown pressed while the filter input is focused — conventionally
   *  refocuses the list/modal element so subsequent j/k navigate. (ArrowUp
   *  deliberately does not refocus — matches the pre-factory modals.) */
  onLeaveInput?: () => void
  /** Every consumed nav keystroke, BEFORE the move — fires even when the
   *  cursor is clamped at a boundary. Confirm-gate disarm lives here. */
  onNav?: () => void
  /** Cursor index changed via handleKey()/moveBy()/moveTo(). NOT called for
   *  hover tracking, direct index writes, or clamped (no-op) moves. */
  onMove?: (index: number) => void
  /** Enter. Absent → Enter falls through (handleKey returns false, no
   *  preventDefault — FileSelectionPanel needs Enter to bubble to App). The
   *  factory preventDefaults before calling; the hook adds stopPropagation
   *  itself if the key must not reach window-level handlers. */
  onEnter?: (e: KeyboardEvent) => void
  /** Escape. Absent → falls through, same contract as onEnter. */
  onEscape?: (e: KeyboardEvent) => void
  /** '/' — the focus-the-filter convention. Absent → falls through. Never
   *  called while the input is already focused (so '/' can be typed). */
  onSlash?: (e: KeyboardEvent) => void
  /** Delegated mousemove over a `[data-idx]` row moves the CURSOR (modal
   *  pattern: one highlight serves keyboard and mouse). Default false = track
   *  the separate `hovered` index (panel pattern: distinct .hovered class). */
  hoverMovesCursor?: boolean
  /** Cursor moved via hover (hoverMovesCursor mode only) — confirm-gate
   *  disarm parity with keyboard nav. */
  onHoverCursor?: () => void
}

export interface ListCursor {
  /** Cursor index. Writable for restore/reset effects; direct writes do NOT
   *  fire onMove or scroll — use moveTo() when those should happen. */
  index: number
  /** Hovered row index, -1 when the pointer is outside any [data-idx] row.
   *  Always -1 in hoverMovesCursor mode. */
  readonly hovered: number
  /** Route a keydown. Returns true when consumed (nav key, or a provided
   *  Enter/Escape/'/' hook fired). False = caller's domain keys may handle. */
  handleKey(e: KeyboardEvent): boolean
  /** Move the cursor by delta rows, clamped to bounds. From -1, any direction
   *  lands on row 0. */
  moveBy(delta: number): void
  /** Move the cursor to row i, clamped to bounds. No-op on an empty list or
   *  when already there (onMove is only called for actual moves). */
  moveTo(i: number): void
  /** Scroll the current row into view (data-idx query on `container`). */
  scrollIntoView(): void
  /** Delegated mousemove handler — attach to the rows container. */
  onRowsMouseMove(e: MouseEvent): void
  /** Delegated mouseleave handler — attach to the rows container. */
  onRowsMouseLeave(): void
}

export function createListCursor(opts: ListCursorOptions): ListCursor {
  let index = $state(opts.initialIndex ?? 0)
  let hovered = $state(-1)
  const inputFocused = () => opts.inputFocused?.() ?? false

  // Bounds clamp: when the list shrinks under the cursor (filter narrowed,
  // group collapsed, entries resolved away), snap to the new last row. Tracks
  // count() only — index is untracked so cursor moves don't re-fire it. An
  // empty list leaves index alone (len > 0 gate); the next non-empty count
  // change clamps it back into range.
  $effect(() => {
    const len = opts.count()
    if (len > 0 && untrack(() => index) >= len) index = len - 1
  })

  function scrollIntoView() {
    scrollIdxIntoView(opts.container?.(), index)
  }

  function moveTo(i: number) {
    const len = opts.count()
    if (len === 0) return
    const next = Math.max(0, Math.min(i, len - 1))
    if (next === index) return
    index = next
    opts.onMove?.(next)
    scrollIntoView()
  }

  function moveBy(delta: number) {
    // -1 sentinel (nothing selected): the first nav key in either direction
    // selects the first row.
    moveTo(index < 0 ? 0 : index + delta)
  }

  function handleKey(e: KeyboardEvent): boolean {
    switch (e.key) {
      case 'ArrowDown':
      case 'j':
        if (e.key === 'j' && inputFocused()) return false
        e.preventDefault()
        opts.onNav?.()
        if (inputFocused()) opts.onLeaveInput?.()
        moveBy(1)
        return true
      case 'ArrowUp':
      case 'k':
        if (e.key === 'k' && inputFocused()) return false
        e.preventDefault()
        opts.onNav?.()
        moveBy(-1)
        return true
      case 'Enter':
        if (!opts.onEnter) return false
        e.preventDefault()
        opts.onEnter(e)
        return true
      case 'Escape':
        if (!opts.onEscape) return false
        e.preventDefault()
        opts.onEscape(e)
        return true
      case '/':
        if (!opts.onSlash || inputFocused()) return false
        e.preventDefault()
        opts.onSlash(e)
        return true
    }
    return false
  }

  function onRowsMouseMove(e: MouseEvent) {
    const t = (e.target as Element).closest('[data-idx]')
    if (opts.hoverMovesCursor) {
      if (!t) return
      const i = Number(t.getAttribute('data-idx'))
      if (i !== index) {
        index = i
        opts.onHoverCursor?.()
      }
    } else {
      hovered = t ? Number(t.getAttribute('data-idx')) : -1
    }
  }

  function onRowsMouseLeave() {
    hovered = -1
  }

  return {
    get index() { return index },
    set index(i: number) { index = i },
    get hovered() { return hovered },
    handleKey,
    moveBy,
    moveTo,
    scrollIntoView,
    onRowsMouseMove,
    onRowsMouseLeave,
  }
}
