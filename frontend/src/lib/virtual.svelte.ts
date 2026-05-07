// Fixed-row-height windowing. Tanstack-virtual's complexity (per-item
// measurement, running-offset index, resize observation per row) exists to
// support variable heights — we don't have that problem (18px locked by CSS
// for graph-pipe continuity), so virtualization collapses to arithmetic.
//
// count and scrollEl are passed as getters so the factory picks up $state
// changes without the caller needing $effect glue. Returned fields are
// getters too — reading .items inside an $effect registers the right deps.

export interface VirtualItem {
  index: number
  start: number
}

export function createWindower(opts: {
  count: () => number
  scrollEl: () => HTMLElement | undefined
  rowHeight: number
  overscan?: number
}) {
  const { rowHeight, overscan = 10 } = opts

  let scrollTop = $state(0)
  let viewportH = $state(0)

  $effect(() => {
    const el = opts.scrollEl()
    if (!el) return
    const onScroll = () => scrollTop = el.scrollTop
    const ro = new ResizeObserver(() => viewportH = el.clientHeight)
    el.addEventListener('scroll', onScroll, { passive: true })
    ro.observe(el)
    viewportH = el.clientHeight
    scrollTop = el.scrollTop
    return () => {
      el.removeEventListener('scroll', onScroll)
      ro.disconnect()
    }
  })

  const items = $derived.by((): VirtualItem[] => {
    const n = opts.count()
    if (n === 0 || viewportH === 0) return []
    const first = Math.max(0, Math.floor(scrollTop / rowHeight) - overscan)
    const last = Math.min(n - 1, Math.ceil((scrollTop + viewportH) / rowHeight) + overscan)
    const out: VirtualItem[] = []
    for (let i = first; i <= last; i++) out.push({ index: i, start: i * rowHeight })
    return out
  })

  // align:'auto' semantics — scroll the minimum distance to bring the row
  // fully into view; no-op if already visible.
  function scrollToIndex(idx: number) {
    const el = opts.scrollEl()
    if (!el) return
    const top = idx * rowHeight
    const bottom = top + rowHeight
    if (top < el.scrollTop) el.scrollTop = top
    else if (bottom > el.scrollTop + el.clientHeight) el.scrollTop = bottom - el.clientHeight
  }

  return {
    get items() { return items },
    get totalHeight() { return opts.count() * rowHeight },
    scrollToIndex,
  }
}

/** Run `fn` (a layout-shifting state mutation) without the line under the
 *  user's eye moving. Captures the first `anchorSel` match inside `scrollEl`
 *  whose top ≥ the container's top, flushes Svelte's DOM updates, then
 *  corrects scrollTop by the delta. `tick()` is the right barrier (microtask,
 *  post-DOM-flush, pre-paint) — rAF would let the shifted frame paint before
 *  correcting. `gen()` lets a concurrent scrollToHunk/scrollTo win.
 *
 *  `anchorSel` MUST select per-row elements (e.g. `.diff-file`), not a
 *  wrapper — a single wrapper's top doesn't move when its contents reflow. */
export async function holdViewport(
  scrollEl: HTMLElement,
  anchorSel: string,
  fn: () => void,
  gen?: () => number,
): Promise<void> {
  const { tick } = await import('svelte')
  const g0 = gen?.()
  const containerTop = scrollEl.getBoundingClientRect().top
  let anchor: Element | undefined
  for (const el of scrollEl.querySelectorAll(anchorSel)) {
    if (el.getBoundingClientRect().top >= containerTop) { anchor = el; break }
  }
  const before = anchor?.getBoundingClientRect().top
  fn()
  await tick()
  if (gen && gen() !== g0) return
  if (anchor && before !== undefined && anchor.isConnected) {
    scrollEl.scrollTop += anchor.getBoundingClientRect().top - before
  }
}
