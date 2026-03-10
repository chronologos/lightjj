// Line-level LCS diff for merge-pane highlighting. Same LCS backbone as
// word-diff.ts but operates on whole lines (one token = one line). Returns
// 1-indexed line numbers (CM6's Decoration.line convention).
//
// O(m*n) DP — bails on oversized inputs. Practical limit: a 1000-line file
// vs a 1000-line file = 1M cells × 4 bytes = 4MB, still fine. Threshold set
// higher than word-diff's MAX_TOKENS (lines are the unit, not words).

const MAX_CELLS = 2_000_000

export interface LineDiff {
  /** 1-indexed line numbers in `a` that are NOT in the LCS (changed/deleted). */
  aOnly: Set<number>
  /** 1-indexed line numbers in `b` that are NOT in the LCS (changed/added). */
  bOnly: Set<number>
}

/** A maximal aligned change region. "Take a" = replace b's [bFrom,bTo) with
 *  a's [aFrom,aTo) content. Half-open, 1-indexed; aFrom===aTo means pure
 *  insertion in b (nothing to take from a — still valid as a delete-in-b). */
export interface ChangeBlock {
  aFrom: number; aTo: number
  bFrom: number; bTo: number
}

/** Groups non-LCS runs into aligned blocks. Each block is one "merge arrow". */
export function diffBlocks(a: string[], b: string[]): ChangeBlock[] {
  const m = a.length, n = b.length
  if (m === 0 && n === 0) return []
  if (m === 0) return [{ aFrom: 1, aTo: 1, bFrom: 1, bTo: n + 1 }]
  if (n === 0) return [{ aFrom: 1, aTo: m + 1, bFrom: 1, bTo: 1 }]
  if (m * n > MAX_CELLS) {
    // Degrade to one all-encompassing block — coarse but functional.
    return [{ aFrom: 1, aTo: m + 1, bFrom: 1, bTo: n + 1 }]
  }

  // LCS table. Flat Int32Array for cache locality.
  const dp = new Int32Array((m + 1) * (n + 1))
  const idx = (i: number, j: number) => i * (n + 1) + j
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[idx(i, j)] = a[i - 1] === b[j - 1]
        ? dp[idx(i - 1, j - 1)] + 1
        : Math.max(dp[idx(i - 1, j)], dp[idx(i, j - 1)])
    }
  }

  // Backtrace: a block opens on the first mismatch step, closes on the next
  // LCS diagonal (or table edge). Walking reverse → reverse() at end.
  const blocks: ChangeBlock[] = []
  let i = m, j = n
  let aHi = 0, bHi = 0, open = false
  const flush = (aLo: number, bLo: number) => {
    if (!open) return
    if (aLo !== aHi || bLo !== bHi) {
      blocks.push({ aFrom: aLo, aTo: aHi, bFrom: bLo, bTo: bHi })
    }
    open = false
  }
  while (i > 0 && j > 0) {
    if (a[i - 1] === b[j - 1]) {
      flush(i + 1, j + 1)
      i--; j--
    } else {
      if (!open) { aHi = i + 1; bHi = j + 1; open = true }
      if (dp[idx(i - 1, j)] >= dp[idx(i, j - 1)]) i--
      else j--
    }
  }
  if (i > 0 || j > 0) {
    if (!open) { aHi = i + 1; bHi = j + 1; open = true }
  }
  flush(1, 1)

  return blocks.reverse()
}

/** Expand blocks into line-number sets. Derives from diffBlocks() — no second
 *  LCS pass. Callers needing both should call diffBlocks once, then this. */
export function blocksToLineSets(blocks: ChangeBlock[]): LineDiff {
  const aOnly = new Set<number>()
  const bOnly = new Set<number>()
  for (const b of blocks) {
    for (let i = b.aFrom; i < b.aTo; i++) aOnly.add(i)
    for (let i = b.bFrom; i < b.bTo; i++) bOnly.add(i)
  }
  return { aOnly, bOnly }
}

/** Convenience — single call when blocks aren't needed separately. */
export function diffLineSets(a: string[], b: string[]): LineDiff {
  return blocksToLineSets(diffBlocks(a, b))
}
