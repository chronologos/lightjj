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

// Agents compute anchors against raw markdown (with **/`/#/\n) but doc-session
// re-finds against ProseMirror-flattened text (syntax stripped, no block
// separators). normalizeWithMap strips the inline-syntax noise and collapses
// whitespace while recording where each surviving char came from, so a match in
// normalized space can be mapped back to original-text positions.
const MD_SYNTAX = /[*_`~[\]()!#>|]/

// No leading/trailing trim — boundary whitespace is significant for context
// scoring (contextBefore typically ends in the space before the selection).
function normalizeWithMap(s: string): { norm: string; map: number[] } {
  const chars: string[] = []
  const map: number[] = []
  let lastWasSpace = false
  for (let i = 0; i < s.length; i++) {
    const c = s[i]
    if (MD_SYNTAX.test(c)) continue
    if (/\s/.test(c)) {
      if (lastWasSpace) continue
      chars.push(' ')
      map.push(i)
      lastWasSpace = true
    } else {
      chars.push(c)
      map.push(i)
      lastWasSpace = false
    }
  }
  return { norm: chars.join(''), map }
}

export function normalizeForMatch(s: string): string {
  return normalizeWithMap(s).norm.trim()
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

type FindResult = { from: number; to: number } | 'ambiguous' | null

function findIn(text: string, sel: string, before: string, after: string): FindResult {
  const hits = allIndicesOf(text, sel)
  if (hits.length === 0) return null
  if (hits.length === 1) return { from: hits[0], to: hits[0] + sel.length }
  let best = -1
  let bestScore = -1
  const a: Anchor = { selection: sel, contextBefore: before, contextAfter: after }
  for (const h of hits) {
    const s = contextScore(a, text, h, h + sel.length)
    if (s > bestScore) {
      bestScore = s
      best = h
    }
  }
  if (bestScore >= 0.7) return { from: best, to: best + sel.length }
  return 'ambiguous'
}

// Re-find an anchor in (possibly edited) text. Returns the char range, or a
// zero-width range if the selection itself was edited away but its context
// survives, or null (orphaned).
export function refind(anchor: Anchor, text: string): { from: number; to: number } | null {
  const { selection, contextBefore, contextAfter } = anchor

  // Stage 1: exact selection match, disambiguated by exact context.
  // Stage 2: normalized fallback — strip md syntax + collapse whitespace on
  // both sides so a raw-markdown anchor lands in PM-flattened text. Positions
  // are mapped back via normalizeWithMap's index map so the returned range
  // points into the original `text`.
  if (selection.length > 0) {
    const exact = findIn(text, selection, contextBefore, contextAfter)
    if (exact && exact !== 'ambiguous') return exact

    const { norm: normHay, map: hayMap } = normalizeWithMap(text)
    // Trim normSel: a leading "# "/"> "/"* " collapses to a leading space (the
    // syntax char is stripped but the following space survives), which won't be
    // present in PM-flat text. hayMap-back uses norm.from/to into normHay, so
    // trimming the needle doesn't perturb position mapping.
    const normSel = normalizeWithMap(selection).norm.trim()
    let norm: FindResult = null
    if (normSel.length > 0) {
      norm = findIn(normHay, normSel, normalizeWithMap(contextBefore).norm, normalizeWithMap(contextAfter).norm)
      if (norm && norm !== 'ambiguous') {
        return { from: hayMap[norm.from], to: hayMap[norm.to - 1] + 1 }
      }
    }
    // Selection text exists but neither pass could pick a winner — orphan
    // rather than guess; a comment on the wrong instance is worse than orphaned.
    if (exact === 'ambiguous' || norm === 'ambiguous') return null
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
