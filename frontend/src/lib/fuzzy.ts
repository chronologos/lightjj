// Fuzzy substring matching for command palette filtering

export function fuzzyMatch(query: string, text: string): boolean {
  const lq = query.toLowerCase()
  const lt = text.toLowerCase()
  let qi = 0
  for (let ti = 0; ti < lt.length && qi < lq.length; ti++) {
    if (lt[ti] === lq[qi]) qi++
  }
  return qi === lq.length
}
