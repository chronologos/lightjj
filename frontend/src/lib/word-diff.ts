// Word-level diff computation — LCS-based token diffing for inline highlighting

import type { DiffHunk } from './diff-parser'

export interface WordSpan {
  text: string
  changed: boolean
}

// Merge adjacent spans with the same changed status
function mergeSpans(spans: WordSpan[]): WordSpan[] {
  const merged: WordSpan[] = []
  for (const s of spans) {
    const last = merged[merged.length - 1]
    if (last && last.changed === s.changed) {
      last.text += s.text
    } else {
      merged.push({ text: s.text, changed: s.changed })
    }
  }
  return merged
}

// Compute word-level diff between two strings, returning spans for each side.
// Falls back to whole-line spans if either line has too many tokens (avoids
// O(m*n) blowup on minified or machine-generated lines).
const MAX_TOKENS_FOR_LCS = 200

function diffWords(oldStr: string, newStr: string): { oldSpans: WordSpan[]; newSpans: WordSpan[] } {
  const oldTokens = oldStr.match(/\S+|\s+/g) || []
  const newTokens = newStr.match(/\S+|\s+/g) || []

  // Bail out for very long lines -- LCS is O(m*n)
  if (oldTokens.length > MAX_TOKENS_FOR_LCS || newTokens.length > MAX_TOKENS_FOR_LCS) {
    return {
      oldSpans: [{ text: oldStr, changed: true }],
      newSpans: [{ text: newStr, changed: true }],
    }
  }

  // Build LCS table
  const m = oldTokens.length, n = newTokens.length
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0))
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = oldTokens[i - 1] === newTokens[j - 1]
        ? dp[i - 1][j - 1] + 1
        : Math.max(dp[i - 1][j], dp[i][j - 1])
    }
  }

  // Backtrack to produce per-token spans
  const oldResult: WordSpan[] = []
  const newResult: WordSpan[] = []
  let i = m, j = n

  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && oldTokens[i - 1] === newTokens[j - 1]) {
      oldResult.push({ text: oldTokens[i - 1], changed: false })
      newResult.push({ text: newTokens[j - 1], changed: false })
      i--; j--
    } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
      newResult.push({ text: newTokens[j - 1], changed: true })
      j--
    } else {
      oldResult.push({ text: oldTokens[i - 1], changed: true })
      i--
    }
  }

  oldResult.reverse()
  newResult.reverse()

  return { oldSpans: mergeSpans(oldResult), newSpans: mergeSpans(newResult) }
}

// For a hunk, pair up adjacent remove/add sequences and compute word diffs
// Returns a map: lineIndex -> WordSpan[]
export function computeWordDiffs(hunk: DiffHunk): Map<number, WordSpan[]> {
  const result = new Map<number, WordSpan[]>()
  let i = 0
  while (i < hunk.lines.length) {
    // Collect consecutive removes
    const removes: number[] = []
    while (i < hunk.lines.length && hunk.lines[i].type === 'remove') {
      removes.push(i)
      i++
    }
    // Collect consecutive adds
    const adds: number[] = []
    while (i < hunk.lines.length && hunk.lines[i].type === 'add') {
      adds.push(i)
      i++
    }
    // Pair them up for word-level diff
    const pairs = Math.min(removes.length, adds.length)
    for (let p = 0; p < pairs; p++) {
      const oldContent = hunk.lines[removes[p]].content.slice(1) // strip -/+ prefix
      const newContent = hunk.lines[adds[p]].content.slice(1)
      const { oldSpans, newSpans } = diffWords(oldContent, newContent)
      result.set(removes[p], oldSpans)
      result.set(adds[p], newSpans)
    }
    // Skip context lines
    if (removes.length === 0 && adds.length === 0) i++
  }
  return result
}
