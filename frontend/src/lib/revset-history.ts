export const REVSET_HISTORY_LIMIT = 8

export const REVSET_OPERATORS = [
  { label: 'f(x)', token: '()', description: 'Function call or grouping parentheses' },
  { label: 'x-', token: '-', description: 'Parents of x' },
  { label: 'x+', token: '+', description: 'Children of x' },
  { label: 'p:x', token: ':', description: 'String/date pattern or pattern alias p' },
  { label: 'x::', token: '::', description: 'Descendants of x, including x' },
  { label: 'x..', token: '..', description: 'Revisions that are not ancestors of x' },
  { label: '::x', token: '::', description: 'Ancestors of x, including x' },
  { label: '..x', token: '..', description: 'Ancestors of x, excluding root' },
  { label: 'x::y', token: '::', description: 'Descendants of x that are ancestors of y' },
  { label: 'x..y', token: '..', description: 'Ancestors of y that are not ancestors of x' },
  { label: '::', token: '::', description: 'All visible commits' },
  { label: '..', token: '..', description: 'All visible commits except root' },
  { label: '~x', token: '~', description: 'Revisions that are not in x' },
  { label: 'x & y', token: ' & ', description: 'Revisions that are in both x and y' },
  { label: 'x ~ y', token: ' ~ ', description: 'Revisions that are in x but not y' },
  { label: 'x | y', token: ' | ', description: 'Revisions that are in either x or y' },
] as const

export function normalizeRevset(revset: string): string {
  return revset.trim()
}

export function revsetHistoryItems(
  entries: Record<string, number>,
  query = '',
  limit = REVSET_HISTORY_LIMIT,
): string[] {
  const needle = normalizeRevset(query).toLowerCase()
  return Object.entries(entries)
    .filter(([revset, ts]) =>
      normalizeRevset(revset) !== '' &&
      Number.isFinite(ts) &&
      (needle === '' || revset.toLowerCase().includes(needle)) &&
      revset.toLowerCase() !== needle
    )
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([revset]) => revset)
}

export function moveHistoryIndex(current: number, delta: -1 | 1, count: number): number {
  if (count <= 0) return -1
  if (current < 0) return delta > 0 ? 0 : count - 1
  return (current + delta + count) % count
}

function clampTextIndex(index: number | null | undefined, fallback: number, length: number): number {
  if (index === null || index === undefined || !Number.isFinite(index)) return fallback
  return Math.max(0, Math.min(length, index))
}

export function insertRevsetOperator(
  value: string,
  token: string,
  selectionStart: number | null | undefined = value.length,
  selectionEnd: number | null | undefined = selectionStart,
): { value: string; selectionStart: number; selectionEnd: number } {
  const start = clampTextIndex(selectionStart, value.length, value.length)
  const end = clampTextIndex(selectionEnd, start, value.length)
  const from = Math.min(start, end)
  const to = Math.max(start, end)

  if (token === '()') {
    const next = `${value.slice(0, from)}(${value.slice(from, to)})${value.slice(to)}`
    const cursor = to > from ? to + 2 : from + 1
    return { value: next, selectionStart: cursor, selectionEnd: cursor }
  }

  const next = `${value.slice(0, from)}${token}${value.slice(to)}`
  const cursor = from + token.length
  return { value: next, selectionStart: cursor, selectionEnd: cursor }
}
