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
import type { ChangeBlock } from './merge-diff'

/** Commit refs parsed from a conflict-marker label. Present when jj emits
 *  `changeId commitId "description"` format; absent for the generic
 *  "Contents of side #N" / "Changes from base to side #N" forms. */
export interface SideRef { changeId: string; commitId: string }

export interface MergeSides {
  base: string
  ours: string
  theirs: string
  oursLabel: string
  theirsLabel: string
  oursRef?: SideRef
  theirsRef?: SideRef
  /** One block per jj conflict region — known at parse time (the `inRegion`
   *  state machine toggles at every <<<<<<< / >>>>>>>). MergePanel reads this
   *  instead of running LCS over the full file, which for a 1400-line file
   *  with three 20-line conflicts is ~2M cells of re-discovering that the
   *  out-of-region lines are identical. 1-indexed, half-open, matches
   *  ChangeBlock exactly so it drops into blocksToLineSets/planTake. */
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

// Marker pattern. Only M_START is a static regex — it discovers the marker
// LENGTH for this conflict region. jj escalates all markers to the same length
// (conflicts.rs:62-65: max(7, longest-content-lookalike + 1)), so once we know
// the <<<<<<< width we check all other markers for EXACTLY that width.
//
// {7,} matching would misfire on:
//   - diff-prefixed content: file line `------` deleted → `-` prefix + 6 dashes
//     = 7 dashes → false M_BASE match inside a %%%%%%% section
//   - snapshot content: file line `-------` (7 dashes, markdown HR) appears
//     verbatim in a +++++++ section; jj escalated to 8-char markers BECAUSE of
//     this line → {7,} matches the content and the real 8-char marker alike
const M_START = /^(<{7,})(?:\s+(.*))?$/

/** True if line is EXACTLY `len` repetitions of `ch` followed by nothing or
 *  whitespace+label. Returns the label (or '') on match, null otherwise.
 *  Exact-length check is what distinguishes a real 8-char `--------` marker
 *  from a 7-char `-------` content line under escalation. */
function matchMarker(line: string, ch: string, len: number): string | null {
  if (line.length < len) return null
  for (let i = 0; i < len; i++) if (line[i] !== ch) return null
  // After the run: must be end-of-line, OR whitespace (label follows).
  // A longer run of the SAME char is NOT a match — that would be file content
  // like `--------` (8 dashes) when markers are 7, or vice versa.
  if (line.length === len) return ''
  if (line[len] === ch) return null
  if (!/\s/.test(line[len])) return null
  return line.slice(len + 1).trimStart()
}

type Mode = 'out' | 'diff' | 'snap' | 'base'

/** Returns null if markers unparseable, >2 sides, or no jj-native markers found
 *  in a file that DOES contain conflict-looking `<<<<<<<` (likely git-style). */
export function reconstructSides(raw: string): MergeSides | null {
  // Normalize CRLF/CR → LF BEFORE split. Without this, any \r in content
  // (CRLF files, or a lone \r left by the backend's TrimRight on a CRLF-
  // terminated file) leaves \r on line tails after split('\n'). Then:
  //   - diffBlocks' a[i]===b[j] fails for visually-identical lines with
  //     mismatched \r → LCS finds spurious divergence → wrong arrow blocks
  //   - CM6 normalizes the same \r to \n in its doc → line-count disagrees
  //     with oursLines/theirsLines → takeBlock slices the wrong range
  // Observed on remote merge: → copied only the tail block because every
  // preceding "common" line differed by a trailing \r.
  const lines = raw.replace(/\r\n?/g, '\n').split('\n')
  const base: string[] = []
  const ours: string[] = []
  const theirs: string[] = []
  const blocks: ChangeBlock[] = []
  let blockStart = { a: 0, b: 0 }
  let oursLabel = ''
  let theirsLabel = ''
  let oursRef: SideRef | undefined
  let theirsRef: SideRef | undefined

  // Sets label + ref for the current side. Called from each marker handler.
  const setLabel = (lbl: string) => {
    const label = extractSideLabel(lbl)
    const ref = parseRef(lbl)
    if (sideNum === 1) { oursLabel = label; if (ref) oursRef = ref }
    else { theirsLabel = label; if (ref) theirsRef = ref }
  }

  let mode: Mode = 'out'
  let sideNum = 0 // 1 = ours, 2 = theirs. 0 = not yet in a side section.
  let inRegion = false
  // Marker length for the CURRENT region, discovered from <<<<<<< width.
  // All jj markers in one region use the same length (escalation is per-file).
  // 0 = not in a region (match nothing).
  let mLen = 0
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
    let lbl: string | null

    if ((m = line.match(M_START))) {
      if (inRegion) {
        // Shorter run = content. jj escalated mLen BECAUSE the file contains
        // <mLen-char runs; {7,} re-matching them here would false-null on
        // the line jj was protecting. ≥mLen = nested/malformed → bail.
        if (m[1].length >= mLen) return null
        // fall through to content routing (switch below)
      } else {
        inRegion = true
        mLen = m[1].length  // all markers in this region are this exact width
        mode = 'out'
        sideNum = 0
        baseDoneThisRegion = false
        blockStart = { a: ours.length + 1, b: theirs.length + 1 }
        continue
      }
    }
    // All subsequent markers use exact-length match against mLen. mLen=0
    // outside a region (matchMarker rejects len<7 via length check? No —
    // it'd accept a 0-length match. Guard with inRegion explicitly).
    if (inRegion && matchMarker(line, '>', mLen) !== null) {
      if (sideNum !== 2) return null // saw <2 sides — not a 2-way conflict
      blocks.push({
        aFrom: blockStart.a, aTo: ours.length + 1,
        bFrom: blockStart.b, bTo: theirs.length + 1,
      })
      inRegion = false
      mLen = 0
      mode = 'out'
      sideNum = 0
      baseDoneThisRegion = false
      continue
    }
    // Inner markers are ONLY checked while in a region and at EXACT mLen.
    // This is what prevents diff-prefixed content (`-` + `------` = 7 dashes)
    // from matching when real markers are 8 chars, AND prevents snapshot
    // content `-------` (7 chars, a markdown HR) from matching the 8-char
    // M_BASE that jj escalated BECAUSE of that content.
    if (inRegion && (lbl = matchMarker(line, '%', mLen)) !== null) {
      sideNum++
      if (sideNum > 2) return null
      mode = 'diff'
      // %%%%%%% label is "from: <base>" — provisional, overwritten by \\\\\\\
      // "to:" sub-marker below if present. Fallback is correct for the
      // "Changes from base to side #N" format (no sub-marker, names result).
      setLabel(lbl)
      continue
    }
    if (mode === 'diff' && (lbl = matchMarker(line, '\\', mLen)) !== null) {
      // \\\\\\\ "to:" names what this diff transforms INTO — the real side label.
      setLabel(lbl)
      continue
    }
    // The + marker CAN follow a %%%%%%% section (Diff-style: diff then snapshot).
    // But inside the diff, content lines get `+` prefix — an added line of
    // (mLen-1) '+' chars becomes a bare mLen-char run → false-positive. jj
    // always labels real markers, so in diff mode require a non-empty label.
    //
    // Known edge: content `++++++  foo` + `+` prefix = 7 plus + "foo" → passes
    // `lbl !== ''` → false marker. Rare (6-plus-chars followed by ws+text in
    // source) and non-catastrophic (sideNum>2 → null → raw-editor fallback).
    // Stem-checking jj's label format would couple to jj's output (commit-ref
    // labels vs "Contents of side #N" vary by version/config).
    if (inRegion && (lbl = matchMarker(line, '+', mLen)) !== null && (mode !== 'diff' || lbl !== '')) {
      sideNum++
      if (sideNum > 2) return null
      mode = 'snap'
      setLabel(lbl)
      continue
    }
    // M_BASE only appears in Snapshot style — NEVER after a %%%%%%% section
    // (diff mode encodes base via `-` prefixed lines, not a separate block).
    // Without the mode gate, a deleted dash-line (`-` prefix + `------` =
    // 7 dashes) inside a diff section would false-positive here even when
    // marker length happens to equal the content length.
    if (inRegion && mode !== 'diff' && matchMarker(line, '-', mLen) !== null) {
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
    oursRef,
    theirsRef,
    blocks,
  }
}
