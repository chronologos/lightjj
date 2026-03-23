// Pure position-surgery extracted from MergePanel.svelte — the thing that kept
// breaking in bughunter rounds. planTake() computes the change-spec + new
// tracked range; remapBlock() handles CM6 ChangeDesc position mapping with
// whole-block-replace inversion; initialTrackPos() is the 1-indexed-line →
// 0-indexed-char conversion at seed time.
//
// Pure over @codemirror/state types (Text, ChangeDesc) — no EditorView, no
// DOM, so testable in vitest without jsdom gymnastics.

import type { Text, ChangeDesc } from '@codemirror/state'
import type { ChangeBlock } from './merge-diff'

/** Which side the center content came from. Drives highlight color + idempotence. */
export type BlockSource = 'ours' | 'theirs' | 'mixed' | 'both'

export interface TrackedBlock {
  /** 0-based char offset of block start in center doc. */
  from: number
  /** 0-based char offset of block end. */
  to: number
  source: BlockSource
}

export interface TakePlan {
  /** The CM6 change spec to dispatch. */
  change: { from: number; to: number; insert: string }
  /** New tracked range in post-change doc. Excludes any \n separator added. */
  newTrack: { from: number; to: number }
}

/** Compute change-spec + new-track for "take `side` into center at `tracked`".
 *
 *  Handles the full separator-math matrix: zero-width tracked position (at
 *  line-start / line-end / empty-line / empty-doc), srcEmpty (pure deletion),
 *  and boundary \n consumption. Each case has a dedicated test in
 *  merge-surgery.test.ts — these are the shapes that broke in 90d818ca.
 *
 *  null = idempotent (center already has this side). */
export function planTake(
  doc: Text,
  tracked: TrackedBlock,
  side: 'ours' | 'theirs',
  srcLines: string[],
  blk: ChangeBlock,
): TakePlan | null {
  if (tracked.source === side) return null

  const from1 = side === 'ours' ? blk.aFrom : blk.bFrom
  const to1 = side === 'ours' ? blk.aTo : blk.bTo
  // from1===to1 means the source side has ZERO lines for this block (pure
  // deletion). NOT `!insert` — a single empty line slices to [''] which
  // joins to '', falsy, but is valid content (a blank line the user wants
  // to keep). Blank-line conflicts are common in code formatting merges.
  const srcEmpty = from1 === to1
  // oppEmpty: the OPPOSITE side's block range. Disambiguates the empty-line
  // zero-width case: if theirs has '' at this position (oppEmpty=false), the
  // empty line IS block content — insert-as-is replaces it. If theirs has
  // nothing (oppEmpty=true, pure insertion), the empty line at the tracked
  // position is SHARED LCS content — insert needs a trailing \n to go BEFORE
  // it, not replace it. Positionally both are from===to at the same place.
  const oppEmpty = side === 'ours' ? blk.bFrom === blk.bTo : blk.aFrom === blk.aTo
  let insert = srcLines.slice(from1 - 1, to1 - 1).join('\n')

  let { from, to } = tracked
  // contentOff: where insert's CONTENT starts relative to `from` in the new
  // doc. 0 normally; 1 if we prepend a \n separator (that \n is NOT block
  // content — the tracked range must exclude it or sourceHighlight decorates
  // the preceding line and toggle-back deletion mis-computes).
  let contentOff = 0
  const contentLen = insert.length

  if (srcEmpty) {
    // Source side has zero lines. Delete center content + one adjacent \n.
    // Prefer trailing; if end-of-doc (no trailing \n), consume leading —
    // otherwise "a\nb\nBLOCK" deleting BLOCK leaves "a\nb\n" with a phantom
    // trailing newline the source side never had.
    //
    // from===to included: an EMPTY LINE tracks as zero-width (line.from ===
    // line.to). Previously the from===to gate above swallowed this before
    // srcEmpty could fire → zero-width no-op → arrow click silently did
    // nothing. Common trigger: base has a blank line, one side deletes it —
    // the classic code-formatting merge.
    //
    // The \n verification guards against user hand-edits that moved tracked
    // `to` off a line boundary (e.g. typing at exact end-of-block: mapPos(-1)
    // sticks left of insert, `to` now sits mid-line). Consuming a non-\n char
    // would corrupt content.
    if (to < doc.length && doc.sliceString(to, to + 1) === '\n') to += 1
    else if (from > 0 && doc.sliceString(from - 1, from) === '\n') from -= 1
  } else if (from === to) {
    // Zero-width position, non-empty source: pure insertion.
    const line = doc.lineAt(from)
    if (line.from === from && line.to === from && !oppEmpty) {
      // Empty line IS block content (opposite side has '' at this position,
      // not nothing). The tracked zero-width sits between the two framing
      // \n's — insert as-is replaces the empty line. Trailing \n would leave
      // a phantom blank; `to += 1` (90d818ca's first attempt) consumes the
      // next-line's separator, joining lines.
    } else if (doc.length > 0 && line.from === from) {
      // Line-start mid-doc (or shared empty line, oppEmpty=true): trailing \n
      // pushes the following line down. Previously the empty-line check above
      // swallowed the pure-insertion case (initialTrackPos for bFrom===bTo
      // lands AT the next LCS line's start, which may BE empty) → insert-as-is
      // = silent no-op for blank content. Trigger: ours=['A','','','C'] vs
      // theirs=['A','','C'] — ours' extra blank must go BEFORE theirs' shared
      // blank, not replace it.
      insert += '\n'
    } else if (doc.length > 0) {
      // Line-end (including end-of-doc with no trailing \n): trailing \n
      // would concatenate the doc's last line with insert's first. Leading
      // \n instead.
      insert = '\n' + insert
      contentOff = 1
    }
    // doc.length === 0: empty doc, insert as-is — nothing to separate from.
  }

  // newFrom skips a leading \n separator; newTo ends at last content byte,
  // excluding any trailing \n separator. mapPos() can't derive these — it
  // doesn't know separator semantics.
  const newFrom = from + contentOff
  return {
    change: { from, to, insert },
    newTrack: { from: newFrom, to: newFrom + contentLen },
  }
}

/** Concatenate ours + theirs for additive conflicts (dueling imports, new list
 *  entries). Returns null if either side is empty (degenerates to regular
 *  planTake) or if already 'both' (idempotent). No separator-math needed: both
 *  sides non-empty ⇒ center has content ⇒ tracked range is non-zero-width. */
export function planTakeBoth(
  tracked: TrackedBlock,
  oursLines: string[],
  theirsLines: string[],
  blk: ChangeBlock,
): TakePlan | null {
  if (tracked.source === 'both') return null
  if (blk.aFrom === blk.aTo || blk.bFrom === blk.bTo) return null
  const ours = oursLines.slice(blk.aFrom - 1, blk.aTo - 1).join('\n')
  const theirs = theirsLines.slice(blk.bFrom - 1, blk.bTo - 1).join('\n')
  const insert = ours + '\n' + theirs
  return {
    change: { from: tracked.from, to: tracked.to, insert },
    newTrack: { from: tracked.from, to: tracked.from + insert.length },
  }
}

/** Map a tracked block's position through a doc change. Handles whole-block-
 *  replace inversion: asymmetric assoc (from=1 right-lean, to=-1 left-lean)
 *  keeps the range anchored OUTSIDE mid-block edits, but select-all-and-type
 *  inverts (from jumps past insert, to lands before → from>to). When that
 *  happens the tracked range should SPAN the insertion, not collapse beside
 *  it — re-map with flipped assoc. */
export function remapBlock(
  block: { from: number; to: number },
  changes: ChangeDesc,
): { from: number; to: number } {
  const from = changes.mapPos(block.from, 1)
  const to = changes.mapPos(block.to, -1)
  if (from <= to) return { from, to }
  return {
    from: changes.mapPos(block.from, -1),
    to: changes.mapPos(block.to, 1),
  }
}

/** Compute initial tracker position for a block. Center doc seeds with `theirs`,
 *  so bFrom/bTo map directly. Pure-insertion blocks (bFrom===bTo) become
 *  zero-width markers at the insertion point's line start (or doc end if past
 *  last line). */
export function initialTrackPos(doc: Text, blk: ChangeBlock): { from: number; to: number } {
  const from = blk.bFrom <= doc.lines ? doc.line(blk.bFrom).from : doc.length
  const to = blk.bTo - 1 <= doc.lines && blk.bTo > blk.bFrom
    ? doc.line(blk.bTo - 1).to
    : from
  return { from, to }
}
