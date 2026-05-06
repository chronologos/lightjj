// Content-addressed anchor: capture a text range as {selection, contextBefore,
// contextAfter} so it can be re-found in a later (possibly edited) version of
// the text. Used by doc-mode comments (char-granular) and intended to be
// shareable with annotations.svelte.ts's line-granular reanchor.

export type Anchor = {
  selection: string
  contextBefore: string
  contextAfter: string
}

export const DEFAULT_CTX_LEN = 40

export function captureAnchor(text: string, from: number, to: number, ctxLen = DEFAULT_CTX_LEN): Anchor {
  return {
    selection: text.slice(from, to),
    contextBefore: text.slice(Math.max(0, from - ctxLen), from),
    contextAfter: text.slice(to, to + ctxLen),
  }
}

// Score how well a candidate position's surroundings match the stored context.
// Compares from the selection boundary OUTWARD — chars adjacent to the
// selection matter most (an edit 35 chars away shouldn't sink the match).
// Returns [0,1]; 1 = both contexts match fully.
function contextScore(anchor: Anchor, text: string, from: number, to: number): number {
  const { contextBefore: before, contextAfter: after } = anchor
  let match = 0
  for (let i = 1; i <= before.length; i++) {
    if (text[from - i] !== before[before.length - i]) break
    match++
  }
  for (let i = 0; i < after.length; i++) {
    if (text[to + i] !== after[i]) break
    match++
  }
  const total = before.length + after.length
  return total === 0 ? 1 : match / total
}

function allIndicesOf(haystack: string, needle: string): number[] {
  const out: number[] = []
  let i = haystack.indexOf(needle)
  while (i !== -1) {
    out.push(i)
    i = haystack.indexOf(needle, i + 1)
  }
  return out
}

// Re-find an anchor in (possibly edited) text. Returns the char range, or a
// zero-width range if the selection itself was edited away but its context
// survives, or null (orphaned).
export function refind(anchor: Anchor, text: string): { from: number; to: number } | null {
  const { selection, contextBefore, contextAfter } = anchor

  // Stage 1/2: exact selection match, disambiguated by context.
  if (selection.length > 0) {
    const hits = allIndicesOf(text, selection)
    if (hits.length === 1) {
      return { from: hits[0], to: hits[0] + selection.length }
    }
    if (hits.length > 1) {
      let best = -1
      let bestScore = -1
      for (const h of hits) {
        const s = contextScore(anchor, text, h, h + selection.length)
        if (s > bestScore) {
          bestScore = s
          best = h
        }
      }
      if (bestScore >= 0.7) return { from: best, to: best + selection.length }
      // Ambiguous: many hits, none with strong context. Orphan rather than
      // guess — a comment landing on the wrong instance is worse than orphaned.
      return null
    }
  }

  // Stage 3: selection gone (or was empty). Find contextBefore followed
  // within 200 chars by contextAfter; return zero-width at the join.
  // Require enough context to be meaningful — a 2-char context matches noise.
  if (contextBefore.length + contextAfter.length < 10) return null
  if (contextBefore.length === 0) {
    const j = text.indexOf(contextAfter)
    return j === -1 ? null : { from: j, to: j }
  }
  if (contextAfter.length === 0) {
    const j = text.indexOf(contextBefore)
    return j === -1 ? null : { from: j + contextBefore.length, to: j + contextBefore.length }
  }
  for (const i of allIndicesOf(text, contextBefore)) {
    const joinPoint = i + contextBefore.length
    const j = text.indexOf(contextAfter, joinPoint)
    if (j !== -1 && j - joinPoint <= 200) {
      return { from: joinPoint, to: joinPoint }
    }
  }
  return null
}
