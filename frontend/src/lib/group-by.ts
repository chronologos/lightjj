// Group items by a key function, also recording the item's global index.
// Useful when the global position matters (e.g., "is this the current match?").
export function groupByWithIndex<T, K>(
  items: readonly T[],
  keyFn: (item: T) => K,
): Map<K, { item: T; index: number }[]> {
  const map = new Map<K, { item: T; index: number }[]>()
  for (let i = 0; i < items.length; i++) {
    const item = items[i]
    const key = keyFn(item)
    const list = map.get(key)
    if (list) {
      list.push({ item, index: i })
    } else {
      map.set(key, [{ item, index: i }])
    }
  }
  return map
}
