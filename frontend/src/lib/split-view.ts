// Split (side-by-side) view transformation for diff hunks

import type { DiffLine, DiffHunk } from './diff-parser'

export interface SplitSide {
  line: DiffLine
  hunkIdx: number
  lineIdx: number
}

export interface SplitLine {
  left: SplitSide | null
  right: SplitSide | null
}

export function toSplitView(hunks: DiffHunk[]): SplitLine[] {
  const result: SplitLine[] = []
  for (let hunkIdx = 0; hunkIdx < hunks.length; hunkIdx++) {
    const hunk = hunks[hunkIdx]
    result.push({
      left: { line: { type: 'header', content: hunk.header }, hunkIdx, lineIdx: -1 },
      right: { line: { type: 'header', content: hunk.header }, hunkIdx, lineIdx: -1 },
    })
    let dels: SplitSide[] = []
    let adds: SplitSide[] = []
    const flush = () => {
      const max = Math.max(dels.length, adds.length)
      for (let i = 0; i < max; i++) {
        result.push({ left: dels[i] ?? null, right: adds[i] ?? null })
      }
      dels = []
      adds = []
    }
    hunk.lines.forEach((line, lineIdx) => {
      const side: SplitSide = { line, hunkIdx, lineIdx }
      if (line.type === 'remove') {
        dels.push(side)
      } else if (line.type === 'add') {
        adds.push(side)
      } else {
        flush()
        result.push({ left: side, right: side })
      }
    })
    flush()
  }
  return result
}
