// Extract {base, ours, theirs} from jj-native conflict markers in raw file
// content (as returned by `jj file show`). Powers the 3-pane merge editor.
//
// jj-lib-0.39.0/src/conflicts.rs defines 4 marker styles; we handle Diff /
// DiffExperimental / Snapshot. Git style falls through (no %%%%%%% / +++++++
// markers → returns null → caller falls back to raw FileEditor).
//
// Marker chars are repeated ≥7 times (jj escalates if the file already
// contains 7-char marker-lookalikes — conflicts.rs:62-65), hence {7,} regex.
//
// This operates on RAW content, NOT diff-wrapped — unlike conflict-parser.ts
// which scans DiffLine[] where every line is prefixed with `+` (diff addition).

import { extractSideLabel } from './conflict-parser'

export interface MergeSides {
  base: string
  ours: string
  theirs: string
  oursLabel: string
  theirsLabel: string
}

// Marker patterns. Anchored at start; {7,} for escalated length; capture the
// label suffix after optional whitespace.
const M_START = /^<{7,}(?:\s+(.*))?$/
const M_DIFF  = /^%{7,}(?:\s+(.*))?$/
const M_SNAP  = /^\+{7,}(?:\s+(.*))?$/
const M_BASE  = /^-{7,}(?:\s+(.*))?$/
const M_END   = /^>{7,}(?:\s+(.*))?$/
// Sub-marker inside %%%%%%% sections. The %%%%%%% line has "from: <base>" but
// the \\\\\\\ line has "to: <side>" — that's what the user sees if they pick
// this side, so it becomes the pane-header label. See conflict-parser.ts:90.
const M_DIFF_TO = /^\\{7,}(?:\s+(.*))?$/

type Mode = 'out' | 'diff' | 'snap' | 'base'

/** Returns null if markers unparseable, >2 sides, or no jj-native markers found
 *  in a file that DOES contain conflict-looking `<<<<<<<` (likely git-style). */
export function reconstructSides(raw: string): MergeSides | null {
  const lines = raw.split('\n')
  const base: string[] = []
  const ours: string[] = []
  const theirs: string[] = []
  let oursLabel = ''
  let theirsLabel = ''

  let mode: Mode = 'out'
  let sideNum = 0 // 1 = ours, 2 = theirs. 0 = not yet in a side section.
  let inRegion = false
  // DiffExperimental style emits TWO %%%%%%% sections (one per side), both
  // diffing from the same base. Without this guard, context/delete lines from
  // the second section re-push to base[] → doubled base content.
  let baseDoneThisRegion = false

  // Append to the side indicated by current sideNum.
  const pushSide = (s: string) => {
    if (sideNum === 1) ours.push(s)
    else if (sideNum === 2) theirs.push(s)
  }

  for (const line of lines) {
    let m: RegExpMatchArray | null

    if ((m = line.match(M_START))) {
      if (inRegion) return null // nested / malformed
      inRegion = true
      mode = 'out'
      sideNum = 0
      baseDoneThisRegion = false
      continue
    }
    if ((m = line.match(M_END))) {
      if (!inRegion) return null // stray closer
      if (sideNum !== 2) return null // saw <2 sides — not a 2-way conflict
      inRegion = false
      mode = 'out'
      sideNum = 0
      baseDoneThisRegion = false
      continue
    }
    // M_DIFF / M_SNAP / M_BASE outside a region are NOT markers — they're
    // content (`-------` markdown rules, `+++++++` ASCII art, etc). Only
    // M_START / M_END are unambiguous region boundaries. Gating on inRegion
    // lets those lines fall through to the `case 'out'` content push below.
    if (inRegion && (m = line.match(M_DIFF))) {
      sideNum++
      if (sideNum > 2) return null
      mode = 'diff'
      // %%%%%%% label is "from: <base>" — provisional, overwritten by \\\\\\\
      // "to:" sub-marker below if present. Fallback is correct for the
      // "Changes from base to side #N" format (no sub-marker, names result).
      const label = extractSideLabel(m[1] ?? '')
      if (sideNum === 1) oursLabel = label
      else theirsLabel = label
      continue
    }
    if (mode === 'diff' && (m = line.match(M_DIFF_TO))) {
      // \\\\\\\ "to:" names what this diff transforms INTO — the real side label.
      const label = extractSideLabel(m[1] ?? '')
      if (sideNum === 1) oursLabel = label
      else theirsLabel = label
      continue
    }
    if (inRegion && (m = line.match(M_SNAP))) {
      sideNum++
      if (sideNum > 2) return null
      mode = 'snap'
      const label = extractSideLabel(m[1] ?? '')
      if (sideNum === 1) oursLabel = label
      else theirsLabel = label
      continue
    }
    if (inRegion && (m = line.match(M_BASE))) {
      mode = 'base'
      // base label not surfaced — the 3-pane view labels flanks, not the middle column
      continue
    }

    // Content line — route by mode.
    switch (mode) {
      case 'out':
        base.push(line); ours.push(line); theirs.push(line)
        break
      case 'diff': {
        // %%%%%%% section is a unified diff (base → this side).
        // jj's write_diff_hunks (conflicts.rs): ' ' = both, '-' = base, '+' = side.
        // For DiffExperimental (two %%%%%%% sections), only the FIRST section
        // pushes to base — the second diffs from the same base, pushing again
        // would double it. sideNum=1 is the authoritative base source.
        const c = line[0]
        const rest = line.slice(1)
        const pushBase = sideNum === 1 && !baseDoneThisRegion
        if (c === ' ') { if (pushBase) base.push(rest); pushSide(rest) }
        else if (c === '-') { if (pushBase) base.push(rest) }
        else if (c === '+') pushSide(rest)
        // else: non-prefixed line inside %%%%%%% — malformed but tolerate (skip)
        break
      }
      case 'snap':
        pushSide(line)
        // A snapshot section after a diff section means the diff section is
        // the authoritative base source → lock it out.
        baseDoneThisRegion = true
        break
      case 'base':
        base.push(line)
        baseDoneThisRegion = true
        break
    }
  }

  // Unterminated region at EOF.
  if (inRegion) return null

  // Git-style detection is implicit: git uses `=======` (not %%%/+++/---) as
  // its divider. `=======` doesn't match any marker regex → treated as content.
  // M_END then fails its sideNum===2 check → null. No explicit check needed.

  return {
    base: base.join('\n'),
    ours: ours.join('\n'),
    theirs: theirs.join('\n'),
    oursLabel,
    theirsLabel,
  }
}
