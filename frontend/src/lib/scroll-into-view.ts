/** Scroll the list row at `idx` into view. Queries by `data-idx` attribute,
 *  NOT by a `.selected`/`.active` class — a $state write followed by a
 *  synchronous querySelector for the class would find the OLD row (the
 *  re-render hasn't happened yet). Static attrs are valid immediately.
 *
 *  Callers must set `data-idx={i}` on each row. */
export function scrollIdxIntoView(container: HTMLElement | undefined, idx: number) {
  container?.querySelector(`[data-idx="${idx}"]`)?.scrollIntoView({ block: 'nearest' })
}
