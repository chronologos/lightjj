// Extract {base, ours, theirs} from jj-native conflict markers in raw file
// content (as returned by `jj file show`). Powers the 3-pane merge editor.
//
// jj-lib-0.39.0/src/conflicts.rs defines 4 marker styles; we handle Diff /
// DiffExperimental / Snapshot. Git style falls through (no %%%%%%% / +++++++
// markers → returns null → caller falls back to raw FileEditor).
//
// Marker recognition (escalation-aware width discovery, exact-width matching,
// false-match defenses) lives in the shared scanner — conflict-markers.ts —
// the same core conflict-parser.ts runs on diff-wrapped lines. This file owns
// reconstruction policy: routing content lines into base/ours/theirs, side
// labels/refs, and parse-time blocks.

import { createConflictScanner, extractSideLabel } from './conflict-markers'
import type { ChangeBlock } from './merge-diff'
import { detectEol } from './eol'

/** Commit refs parsed from a conflict-marker label. Present when jj emits
 *  `changeId commitId "description"` format; absent for the generic
 *  "Contents of side #N" / "Changes from base to side #N" forms. */
export interface SideRef { changeId: string; commitId: string }

export interface MergeSides {
  /** The file's line ending. base/ours/theirs are '\n'-separated; whatever writes
   *  a resolution back restores this (withEol). */
  eol: '\n' | '\r\n'
  base: string
  ours: string
  theirs: string
  oursLabel: string
  theirsLabel: string
  oursRef?: SideRef
  theirsRef?: SideRef
  /** One block per jj conflict region — known at parse time (the scanner's
   *  region tracking toggles at every <<<<<<< / >>>>>>>). MergePanel reads
   *  this instead of running LCS over the full file, which for a 1400-line
   *  file with three 20-line conflicts is ~2M cells of re-discovering that
   *  the out-of-region lines are identical. 1-indexed, half-open, matches
   *  ChangeBlock exactly so it drops into blocksToLineSets/planTake.
   *  SPLIT-MODEL INVARIANT: ranges index `ours.split('\n')` /
   *  `theirs.split('\n')` — '' is ONE blank line, a side is never zero
   *  lines, and every line is either out-of-region (shared) or owned by
   *  exactly one block. merge-surgery's line-range position model relies on
   *  this to keep []-vs-[''] distinct after the join to a string. */
  blocks: ChangeBlock[]
}

// jj's label format after optional "diff from:"/"diff to:" prefix:
//   wlykovwr 562576c8 "commit description"
// change_id is [k-z] (jj uses k-z to disambiguate from hex commit_id),
// commit_id is [0-9a-f]. Both ≥8 chars (short form).
const REF_RE = /(?:diff (?:from|to):\s*)?([k-z]{8,})\s+([0-9a-f]{8,})\s+"(.+)"/

function parseRef(lbl: string): SideRef | undefined {
  const m = lbl.match(REF_RE)
  return m ? { changeId: m[1], commitId: m[2] } : undefined
}

// Content routing mode within a region. Mirrors the scanner's internal section
// tracking, but kept here because routing (where content lines GO) is
// reconstruction policy, not marker grammar.
type Mode = 'out' | 'diff' | 'snap' | 'base'

/** Returns null if markers unparseable, >2 sides, or no jj-native markers found
 *  in a file that DOES contain conflict-looking `<<<<<<<` (likely git-style). */
export function reconstructSides(raw: string): MergeSides | null {
  // No single ending reproduces a mixed file (e.g. one side converted to LF) →
  // raw FileEditor, which preserves it byte for byte. jj writes its markers with the
  // file's own ending, so a uniform CRLF file stays uniform.
  const eol = detectEol(raw)
  if (eol === 'mixed') return null
  // Normalize CRLF/CR → LF BEFORE split. Without this, any \r in content
  // (CRLF files, or a lone \r left by the backend's TrimRight on a CRLF-
  // terminated file) leaves \r on line tails after split('\n'). Then:
  //   - diffBlocks' a[i]===b[j] fails for visually-identical lines with
  //     mismatched \r → LCS finds spurious divergence → wrong arrow blocks
  //   - CM6 normalizes the same \r to \n in its doc → line-count disagrees
  //     with oursLines/theirsLines → takeBlock slices the wrong range
  // Observed on remote merge: → copied only the tail block because every
  // preceding "common" line differed by a trailing \r.
  const lines = raw.replace(/\r\n/g, '\n').split('\n')
  const base: string[] = []
  const ours: string[] = []
  const theirs: string[] = []
  const blocks: ChangeBlock[] = []
  let blockStart = { a: 0, b: 0 }
  let oursLabel = ''
  let theirsLabel = ''
  let oursRef: SideRef | undefined
  let theirsRef: SideRef | undefined

  // Sets label + ref for the current side. Called from each side-marker event.
  const setLabel = (lbl: string) => {
    const label = extractSideLabel(lbl)
    const ref = parseRef(lbl)
    if (sideNum === 1) { oursLabel = label; if (ref) oursRef = ref }
    else { theirsLabel = label; if (ref) theirsRef = ref }
  }

  let mode: Mode = 'out'
  let sideNum = 0 // 1 = ours, 2 = theirs. 0 = not yet in a side section.
  // DiffExperimental style emits TWO %%%%%%% sections (one per side), both
  // diffing from the same base. Without this guard, context/delete lines from
  // the second section re-push to base[] → doubled base content.
  let baseDoneThisRegion = false

  // Append to the side indicated by current sideNum.
  const pushSide = (s: string) => {
    if (sideNum === 1) ours.push(s)
    else if (sideNum === 2) theirs.push(s)
  }

  const scanner = createConflictScanner()

  for (const line of lines) {
    const ev = scanner.next(line)

    if (ev) {
      switch (ev.kind) {
        case 'start':
          mode = 'out'
          sideNum = 0
          baseDoneThisRegion = false
          blockStart = { a: ours.length + 1, b: theirs.length + 1 }
          continue
        case 'restart':
          // Nested/malformed marker inside a region → bail; caller falls back
          // to the raw FileEditor.
          return null
        case 'end':
          if (sideNum !== 2) return null // saw <2 sides — not a 2-way conflict
          blocks.push({
            aFrom: blockStart.a, aTo: ours.length + 1,
            bFrom: blockStart.b, bTo: theirs.length + 1,
          })
          mode = 'out'
          sideNum = 0
          baseDoneThisRegion = false
          continue
        case 'diff':
          sideNum++
          if (sideNum > 2) return null
          mode = 'diff'
          // %%%%%%% label is "from: <base>" — provisional, overwritten by the
          // \\\\\\\ "to:" sub-marker below if present. Fallback is correct for
          // the "Changes from base to side #N" format (no sub-marker, names
          // result).
          setLabel(ev.label)
          continue
        case 'diffTo':
          // \\\\\\\ "to:" names what this diff transforms INTO — the real side label.
          setLabel(ev.label)
          continue
        case 'snapshot':
          sideNum++
          if (sideNum > 2) return null
          mode = 'snap'
          setLabel(ev.label)
          continue
        case 'base':
          mode = 'base'
          // base label not surfaced — the 3-pane view labels flanks, not the middle column
          continue
      }
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
  if (scanner.inRegion) return null

  // Git-style detection is implicit: git uses `=======` (not %%%/+++/---) as
  // its divider. `=======` doesn't match any marker → treated as content.
  // The end event then fails its sideNum===2 check → null. No explicit check
  // needed.

  // Split-model invariant (see MergeSides.blocks). A side that collected ZERO
  // lines — the whole file is conflict region(s), this side empty in each, no
  // trailing newline — joins to '' which consumers split back to [''] (one
  // blank line) while every block claims 0 lines of it: a phantom line owned
  // by nobody, so take → take-back gains a line ('X' comes back as 'X\n').
  // Hand the phantom to the last block (≥1 exists: zero out-of-region lines
  // ⇒ ≥1 region; all its ranges on this side are [1,1) → last becomes [1,2)).
  // jj never emits this shape (marker lines are \n-terminated, so a shared
  // trailing '' always exists); generated fixtures do, and honoring it here is
  // what lets planTake drop its unfixable doc.length===0 special case.
  if (blocks.length > 0) {
    const last = blocks[blocks.length - 1]
    if (ours.length === 0) last.aTo = 2
    if (theirs.length === 0) last.bTo = 2
  }

  return {
    eol,
    base: base.join('\n'),
    ours: ours.join('\n'),
    theirs: theirs.join('\n'),
    oursLabel,
    theirsLabel,
    oursRef,
    theirsRef,
    blocks,
  }
}
