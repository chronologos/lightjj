import { api, type SymbolHit } from './api'

// Tier-1 symbol hover controller (rg-backed go-to-def). One instance per
// DiffPanel; DiffFileView wires a delegated pointermove to it. Patterns:
// element-ref dedup (no debounce — pointermove fires constantly but enter()
// no-ops while the same span is under the cursor), 200ms exit grace so the
// pointer can cross into the card, dismiss-on-scroll.

const GRACE_MS = 200

export type SymbolHover = ReturnType<typeof createSymbolHover>

export function createSymbolHover() {
  let anchor = $state<Element | null>(null)
  let symbol = $state('')
  let lang = $state('')
  let hits = $state<SymbolHit[] | null>(null) // null = loading
  let pinned = $state(false) // mouse is inside the card
  let leaveTimer: ReturnType<typeof setTimeout> | undefined
  let gen = 0

  function fetchSymbol() {
    const g = ++gen
    hits = null
    api.symbol(symbol, lang).then(
      (h) => { if (g === gen) hits = h },
      () => { if (g === gen) hits = [] },
    )
  }

  return {
    get anchor() { return anchor },
    get symbol() { return symbol },
    get hits() { return hits },
    get rect() { return anchor?.getBoundingClientRect() ?? null },

    /** Called from a delegated pointermove with the `[data-sym]` span under
     *  the cursor. No-op when the span hasn't changed (the dedup that makes
     *  per-move calls cheap without throttling). */
    enter(el: Element, langName: string) {
      clearTimeout(leaveTimer)
      if (el === anchor) return
      const name = el.textContent ?? ''
      // Single-char/empty tokens (operators that slipped through, lone `_`) —
      // not worth a backend round-trip.
      if (name.length < 2) { this.clear(); return }
      anchor = el
      symbol = name
      lang = langName
      fetchSymbol()
    },

    /** Pointer left the diff line area (or moved to a non-symbol span). Card
     *  stays for GRACE_MS so the user can move into it; pin() cancels the
     *  dismissal while inside. */
    leave() {
      clearTimeout(leaveTimer)
      leaveTimer = setTimeout(() => { if (!pinned) this.clear() }, GRACE_MS)
    },

    pin(on: boolean) {
      pinned = on
      if (!on) this.leave()
    },

    clear() {
      clearTimeout(leaveTimer)
      gen++
      anchor = null
      symbol = ''
      hits = null
      pinned = false
    },
  }
}

/** Walk composedPath() for the innermost `[data-sym]` span. Returns null if
 *  the pointer isn't over a hoverable token. */
export function symbolTarget(e: PointerEvent): Element | null {
  for (const n of e.composedPath()) {
    if (n instanceof Element && n.hasAttribute('data-sym')) return n
    // Stop at the line container — no point walking up to <body>.
    if (n instanceof Element && n.classList.contains('diff-line')) break
  }
  return null
}
