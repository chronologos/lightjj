// Parses jj conflict markers from diff lines to identify conflict regions.
//
// In unified diff output, conflict markers appear as `+` lines since the file
// now contains them. We scan for patterns like:
//   +<<<<<<< Conflict 1 of 3
//   +%%%%%%% Changes from base to side #1
//   ++++++++  Contents of side #2
//   +>>>>>>> Conflict 1 of 3 ends

import type { DiffLine } from './diff-parser'

export interface ConflictSide {
  type: 'diff' | 'snapshot'
  label: string   // extracted from marker line, e.g. commit description
  startIdx: number
  endIdx: number  // inclusive
}

export interface ConflictRegion {
  startIdx: number    // index into hunk.lines (the <<<<<<< line)
  endIdx: number      // inclusive (the >>>>>>> line)
  label: string       // e.g. "Conflict 1 of 3"
  sides: ConflictSide[]
}

// Match conflict markers embedded in diff `+` lines.
// The `+` prefix is part of the diff format (line was added to the file).
const CONFLICT_START = /^\+<{7}\s*(.*)/
const CONFLICT_DIFF  = /^\+%{7}\s*(.*)/
const CONFLICT_SNAP  = /^\+\+{7}\s*(.*)/
const CONFLICT_END   = /^\+>{7}\s*(.*)/

// Extract a human-readable label from jj's conflict marker text.
// Marker text looks like:
//   diff from: lpymxuwk 75ef1147 "Conflict resolution"
//   wlykovwr 562576c8 "side Y: modify existing file differently"
//   Changes from base to side #1
// We prefer the quoted commit description, falling back to the raw text.
function extractSideLabel(markerText: string): string {
  const quoted = markerText.match(/"([^"]+)"/)
  if (quoted) return quoted[1]
  return markerText.trim()
}

export function findConflicts(lines: DiffLine[]): ConflictRegion[] {
  const regions: ConflictRegion[] = []
  let current: ConflictRegion | null = null
  let currentSide: ConflictSide | null = null

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (line.type !== 'add') continue
    const content = line.content

    let m: RegExpMatchArray | null

    if ((m = content.match(CONFLICT_START))) {
      // Flush any in-progress region (malformed/nested markers)
      if (current) {
        if (currentSide) currentSide.endIdx = i - 1
        current.endIdx = i - 1
        regions.push(current)
      }
      current = { startIdx: i, endIdx: i, label: m[1].trim(), sides: [] }
      currentSide = null
    } else if (current && (m = content.match(CONFLICT_DIFF))) {
      if (currentSide) currentSide.endIdx = i - 1
      currentSide = { type: 'diff', label: extractSideLabel(m[1]), startIdx: i, endIdx: i }
      current.sides.push(currentSide)
    } else if (current && (m = content.match(CONFLICT_SNAP))) {
      if (currentSide) currentSide.endIdx = i - 1
      currentSide = { type: 'snapshot', label: extractSideLabel(m[1]), startIdx: i, endIdx: i }
      current.sides.push(currentSide)
    } else if (current && content.match(CONFLICT_END)) {
      if (currentSide) currentSide.endIdx = i - 1
      current.endIdx = i
      regions.push(current)
      current = null
      currentSide = null
    } else if (currentSide) {
      currentSide.endIdx = i
    }
  }

  // Handle unterminated conflict at EOF (e.g., truncated diff output).
  // Push the partial region so the UI at least shows something.
  if (current) {
    if (currentSide) currentSide.endIdx = lines.length - 1
    current.endIdx = lines.length - 1
    regions.push(current)
  }

  return regions
}
