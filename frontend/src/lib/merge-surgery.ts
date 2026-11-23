// Pure position-surgery extracted from MergePanel.svelte — the thing that kept
// breaking in bughunter rounds. planTake() computes the change-spec + new
// tracked range; remapBlock() maps a tracked block through an arbitrary (user)
// doc change; blockCharRange() is the ONE line-range → char-offset conversion,
// done at the CodeMirror boundary.
//
// POSITION MODEL: tracked blocks are LINE ranges — 1-based, half-open
// [from, to), the same coordinate system as ChangeBlock (so seeding is the
// identity: a block's initial center range IS its bFrom/bTo). NOT character
// offsets. The char-offset model (pre-2026-08) picked leading-vs-trailing `\n`
// separators by inspecting characters around a zero-width offset, but a blank
// line is itself zero-width: "before the blank line", "the blank line", and
// "after the blank line" all aliased to ONE offset, so blank-line conflicts
// (the classic code-formatting merge) lost or misplaced lines — ~3.5% of
// random blank-inclusive shapes under fast-check. In the line model those are
// three distinct values ([n,n), [n,n+1), [n+1,n+1)) and the separator choice
// is pure arithmetic on (from, to, doc.lines): no character inspection, no
// oppEmpty disambiguation, no branch-order subtlety.
//
// The companion invariant lives in conflict-extract.ts: blocks index the
// split('\n') lines of each side, so a side is never zero lines ('' is ONE
// blank line) — the []-vs-[''] distinction that a joined string erases is
// carried by the block ranges instead.
//
// Pure over @codemirror/state types (Text, ChangeDesc) — no EditorView, no
// DOM, so testable in vitest without jsdom gymnastics.

import type { Text, ChangeDesc } from '@codemirror/state'
import type { ChangeBlock } from './merge-diff'

/** Which side the center content came from. Drives highlight color + idempotence. */
export type BlockSource = 'ours' | 'theirs' | 'mixed' | 'both'

/** A line range in the center doc: 1-based, half-open. from===to is a
 *  zero-line block sitting BEFORE line `from` (from === doc.lines+1 = after
 *  the last line). */
export interface LineRange {
  from: number
  to: number
}

export interface TrackedBlock extends LineRange {
  source: BlockSource
}

export interface TakePlan {
  /** The CM6 change spec to dispatch (char offsets — the boundary conversion). */
  change: { from: number; to: number; insert: string }
  /** New tracked LINE range in the post-change doc. Excludes any \n separator. */
  newTrack: LineRange
  /** Net line-count change. Blocks AFTER this one (higher index) shift by it;
   *  blocks before are untouched. Index order, not position comparison, is
   *  the tie-break — two zero-line blocks at the same line stay ordered. */
  delta: number
}

/** Line range → char range in `doc`. THE boundary conversion — CodeMirror
 *  wants offsets at dispatch/decoration/scroll time; everything upstream
 *  stays in lines. Non-empty: [start of first line, end of last line]
 *  (excludes the trailing \n). Zero-line: the offset where an insertion
 *  before line `from` would land (doc.length when past the last line).
 *  Clamped so a stale range can't throw inside a CM6 update. */
export function blockCharRange(doc: Text, b: LineRange): { from: number; to: number } {
  if (b.from >= b.to) {
    const off = b.from <= doc.lines ? doc.line(Math.max(1, b.from)).from : doc.length
    return { from: off, to: off }
  }
  const first = Math.min(Math.max(1, b.from), doc.lines)
  const last = Math.min(Math.max(first, b.to - 1), doc.lines)
  return { from: doc.line(first).from, to: doc.line(last).to }
}

/** Compute change-spec + new-track for "take `side` into center at `tracked`".
 *
 *  Four shapes, all decided by line arithmetic (K = source line count,
 *  N = tracked line count, L = doc.lines):
 *   - N>0, K>0  replace the tracked lines' text — separators untouched.
 *   - N>0, K=0  delete the tracked lines plus ONE separator: the trailing \n
 *               when a line follows (to <= L), else the leading \n (block is
 *               the doc's tail), else nothing (block is the whole doc).
 *   - N=0, K>0  insert before line `from`: content + trailing \n when that
 *               line exists (from <= L, pushes it down); leading \n +
 *               content when appending after the last line (from = L+1).
 *               There is no "empty doc, insert bare" case: '' is ONE blank
 *               line in the split model (shared, or owned by some block), so
 *               from=1 correctly pushes it down and from=2 appends after it.
 *   - N=0, K=0  nothing to do textually; still returns a plan so the source
 *               tag flips (an empty change is a valid dispatch).
 *  Each shape has dedicated tests in merge-surgery.test.ts plus the fast-check
 *  sweep over blank-inclusive content — these are the shapes that broke in
 *  90d818ca and again in the 2026-05 blank-line separator gap.
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
  // K===0 means the source side has ZERO lines for this block (pure
  // deletion). NOT `!insert` — a single empty line slices to [''] which
  // joins to '', falsy, but is valid content (a blank line the user wants
  // to keep). Blank-line conflicts are common in code formatting merges.
  const K = to1 - from1
  const content = srcLines.slice(from1 - 1, to1 - 1).join('\n')

  // Clamp into [1, L+1] so a corrupted/stale range can never make a click
  // throw a RangeError out of doc.line() — the tracker normalizes after every
  // hand-edit, this is the belt to that brace.
  const L = doc.lines
  const from = Math.min(Math.max(1, tracked.from), L + 1)
  const to = Math.min(Math.max(from, tracked.to), L + 1)
  const newTrack = { from, to: from + K }
  const delta = K - (to - from)

  if (to > from) {
    // Tracked block owns lines [from, to). A blank line owned by the block
    // is a real 1-line range here — the char model saw it as zero-width and
    // needed oppEmpty to tell it from a shared blank; the line model can't
    // confuse them.
    const r = blockCharRange(doc, { from, to })
    if (K > 0) return { change: { from: r.from, to: r.to, insert: content }, newTrack, delta }
    // Source side has zero lines. Delete the block's lines + one adjacent \n.
    // Prefer trailing; if the block is the doc's tail (no trailing \n),
    // consume leading — otherwise "a\nb\nBLOCK" deleting BLOCK leaves
    // "a\nb\n" with a phantom trailing newline the source side never had.
    if (to <= L) return { change: { from: r.from, to: doc.line(to).from, insert: '' }, newTrack, delta }
    if (from > 1) return { change: { from: doc.line(from - 1).to, to: r.to, insert: '' }, newTrack, delta }
    // Block spans the whole doc: nothing adjacent to consume. Only reachable
    // after hand-edits removed every shared line (a consistent seed never
    // pairs an all-lines block with a zero-line source — see the split-model
    // invariant in conflict-extract.ts).
    return { change: { from: 0, to: doc.length, insert: '' }, newTrack, delta }
  }

  // Zero-line tracked position: insertion point before line `from`.
  if (K === 0) { const at = blockCharRange(doc, { from, to }).from; return { change: { from: at, to: at, insert: '' }, newTrack, delta } }
  return { change: insertLinesBefore(doc, from, content), newTrack, delta }
}

/** Change spec inserting `content` (K ≥ 1 joined lines) as whole lines before
 *  line `at` of `doc` (at === doc.lines+1 appends after the last line). The
 *  one place the insertion separator is chosen — shared by planTake's and
 *  planTakeBoth's zero-line shapes. */
function insertLinesBefore(doc: Text, at: number, content: string): TakePlan['change'] {
  const off = blockCharRange(doc, { from: at, to: at }).from
  // A line exists at `at` (possibly blank, possibly the doc's only line):
  // content first, then a \n pushing that line down. The new block starts AT
  // `at` — the pushed line is not block content.
  if (at <= doc.lines) return { from: off, to: off, insert: content + '\n' }
  // at === L+1: append after the last line. Leading \n — a trailing one
  // would concatenate the doc's last line with content's first. The \n is a
  // separator, not block content: the new block is [L+1, L+1+K), which is why
  // the tracker takes explicit new positions instead of mapping old ones (a
  // mapped offset would sit ON the separator → sourceHighlight decorates the
  // preceding line and toggle-back deletion mis-computes).
  return { from: off, to: off, insert: '\n' + content }
}

/** Concatenate ours + theirs for additive conflicts (dueling imports, new list
 *  entries). Returns null if either side is empty (degenerates to regular
 *  planTake) or if already 'both' (idempotent). Both sides non-empty ⇒ the
 *  seeded/taken center block owns ≥1 line ⇒ plain text replace; the tracked
 *  range can still be ZERO lines after a hand-edit deleted the block's lines
 *  wholesale (remapBlock never annexes a neighbour to stay non-empty), in
 *  which case it is planTake's zero-line insertion with the joined content. */
export function planTakeBoth(
  doc: Text,
  tracked: TrackedBlock,
  oursLines: string[],
  theirsLines: string[],
  blk: ChangeBlock,
): TakePlan | null {
  if (tracked.source === 'both') return null
  if (blk.aFrom === blk.aTo || blk.bFrom === blk.bTo) return null
  const ours = oursLines.slice(blk.aFrom - 1, blk.aTo - 1).join('\n')
  const theirs = theirsLines.slice(blk.bFrom - 1, blk.bTo - 1).join('\n')
  const K = (blk.aTo - blk.aFrom) + (blk.bTo - blk.bFrom)
  const L = doc.lines
  const from = Math.min(Math.max(1, tracked.from), L + 1)
  const to = Math.min(Math.max(from, tracked.to), L + 1)
  const newTrack = { from, to: from + K }
  const delta = K - (to - from)
  if (to === from) return { change: insertLinesBefore(doc, from, ours + '\n' + theirs), newTrack, delta }
  const r = blockCharRange(doc, { from, to })
  return { change: { from: r.from, to: r.to, insert: ours + '\n' + theirs }, newTrack, delta }
}

/** Shift a block that sits AFTER a taken block by the take's line delta.
 *  "After" = higher block index — callers decide that, not this function
 *  (see TakePlan.delta). */
export function shiftBlock<B extends LineRange>(block: B, delta: number): B {
  return delta === 0 ? block : { ...block, from: block.from + delta, to: block.to + delta }
}

/** Map a tracked block through an ARBITRARY doc change (user typing, undo) —
 *  takes never come through here (they carry explicit positions + delta).
 *  Works on whole LINES, so a block can grow/shrink/move but never leaves an
 *  endpoint mid-line for the next take to trip over — and, the load-bearing
 *  rule, it NEVER annexes a neighbouring line whose untouched shared content
 *  survived the edit: the next arrow click replaces exactly the block's
 *  lines, so an annexed neighbour would be silently destroyed (adversarial
 *  review 2026-08: "A/CCC/D", triple-click "CCC\n", Backspace → the block
 *  claimed "D"; ← theirs saved "A\nCCC").
 *
 *  Line-survival model, computed from the change's deleted ranges (old
 *  coordinates) rather than from where two content offsets happen to land:
 *   - a line is ALIVE if any of its content chars survives (a blank line has
 *     none: never alive, but it can't be damaged either);
 *   - deleting the \n between two lines MERGES them into one group. Only the
 *     group holding the block's first line can contain outsider lines before
 *     it (the p-side), only the one holding its last line outsiders after
 *     (the q-side); groups made of block lines alone stay the block's,
 *     whatever was typed into them (select the block's TEXT, retype it: still
 *     owned).
 *  THE INVARIANT (literally true, oracle-checked in MergePanel.test.ts): a
 *  shared line whose content chars were never deleted or typed into is never
 *  inside any block's range — whatever happened to the newlines around it.
 *  So a group with outsiders is NEVER the block's if any SHARED outsider is
 *  alive. Not just "fully intact": lines are all we see, and a line joined by
 *  an EARLIER edit may hold an untouched shared line beside block remains, so
 *  damage to it proves nothing. (Another BLOCK's line holds no shared text, by
 *  this same invariant; it vetoes only while intact, so one edit across two
 *  blocks leaves its text owned by one of them, not by nobody.) Even a plain
 *  JOIN (Backspace at the block's
 *  column 0, Delete at the end of the line above, Delete at the block's end)
 *  drops ownership: the block goes zero-line beside the merged line, and a
 *  re-take inserts beside it (visible duplicate the user can delete) rather
 *  than overwriting the neighbour — join-then-Enter otherwise re-split the
 *  text into its original shape with the shared line silently annexed.
 *  Otherwise the group is the block's iff some block line in it is alive; else
 *  NOT if any outsider is alive; else (nothing alive: destroyed lines and blanks)
 *  iff the block had a blank line in it — "A/A/<blank block>", delete the middle
 *  "A\n": the block keeps its blank; "<blank>/CCC-block", delete "\nCCC":
 *  the shared blank stays shared. Blank outsiders carry no content a take
 *  could destroy, so they never veto.
 *  Owned groups map to new lines through mapPos with the asymmetric assoc
 *  (from=1: an Enter at the block's first column pushes the block down
 *  rather than absorbing the new line; to=-1: an Enter at its end leaves the
 *  new line outside) plus the zero-width inversion flip (typing INTO an owned
 *  blank line spans the insertion). No owned group ⇒ the block is now
 *  ZERO-line, a marker beside the merged line — on the far side from that
 *  line's survivor (alive p-side content → after it, alive q-side → before
 *  it, a plain join → after; among content-free lines an intact blank beats
 *  a destroyed line, so the marker never hops over a shared blank). Text typed
 *  as part of a wholesale line replacement ("CCC\n" → "X\n") is thus left as
 *  unowned shared text with the marker beside it: conservative — a later
 *  take re-inserts the side next to it instead of overwriting what the user
 *  typed.
 *
 *  Zero-line blocks are a marker behind the newline that ends line from-1:
 *  text typed at the end of the line above lands BEFORE the marker, text
 *  typed at column 0 of the line below lands AFTER it. If that newline
 *  survives, the marker stays right behind it; if it was deleted, the lines
 *  around the marker merged and the same survivor rule places it before or
 *  after the merged line. The two ends follow the same lean: from=1 is
 *  pinned to the top (everything typed lands after it), from=L+1 is pinned
 *  past the end (everything typed at EOF — even new lines — lands before it,
 *  exactly like typing at the end of the line above a mid-doc marker). They
 *  own nothing, so nothing can be annexed and merge-tracker never marks them
 *  'mixed'. */
export function remapBlock<B extends LineRange>(
  block: B,
  changes: ChangeDesc,
  oldDoc: Text,
  newDoc: Text,
  /** Is old line `ln`, outside this block, shared — i.e. no other block's? */
  isShared: (ln: number) => boolean = () => true,
): B {
  const L = oldDoc.lines
  const empty = block.from >= block.to
  const from = Math.min(Math.max(1, block.from), empty ? L + 1 : L)
  const to = empty ? from : Math.min(Math.max(from + 1, block.to), L + 1)

  // Deleted ranges in old coordinates (flat [from0, to0, from1, to1, …]).
  const dels: number[] = []
  changes.iterChangedRanges((fromA, toA) => { if (toA > fromA) dels.push(fromA, toA) })
  const covered = (a: number, b: number) => {
    let c = 0
    for (let i = 0; i < dels.length; i += 2) c += Math.max(0, Math.min(b, dels[i + 1]) - Math.max(a, dels[i]))
    return c
  }
  const alive = (ln: number) => { const l = oldDoc.line(ln); return covered(l.from, l.to) < l.length }
  const nlGone = (ln: number) => ln >= 1 && ln < L && covered(oldDoc.line(ln).to, oldDoc.line(ln).to + 1) > 0
  const lineNo = (pos: number, assoc: -1 | 1) => newDoc.lineAt(changes.mapPos(pos, assoc)).number
  const put = (at: number): B => ({ ...block, from: at, to: at })
  // When the block owns nothing after the edit it becomes a marker beside
  // the merged line `m`; which side is decided by where that line's
  // SURVIVOR came from: alive content wins (p-side before the block → marker
  // after m; q-side after it → before m; both = a plain join → after), and
  // among content-free lines an intact blank beats a destroyed line.
  const beside = (m: number, p0: number, p1: number, q0: number, q1: number): B => {
    let pAlive = false, pBlank = false, qAlive = false, qBlank = false
    for (let ln = p0; ln <= p1; ln++) { pAlive ||= alive(ln); pBlank ||= oldDoc.line(ln).length === 0 }
    for (let ln = q0; ln <= q1; ln++) { qAlive ||= alive(ln); qBlank ||= oldDoc.line(ln).length === 0 }
    const pWins = pAlive || (!qAlive && (pBlank || (!qBlank && p1 >= p0)))
    return put(pWins ? m + 1 : m)
  }

  // The run of old lines the change merged with the block's ends: p-side
  // [g0, from-1] before it, q-side [to, g1] after it.
  let g0 = from
  while (g0 > 1 && nlGone(g0 - 1)) g0--
  let g1 = Math.max(from, to - 1)
  if (empty && from > L) g1 = L; else while (g1 < L && nlGone(g1)) g1++

  if (empty) {
    if (from === 1) return put(1)
    if (from > L) return put(lineNo(oldDoc.length, 1) + 1)  // stays past the end, after anything typed there
    // Marker sits behind the \n ending line from-1.
    if (!nlGone(from - 1)) return put(newDoc.lineAt(changes.mapPos(oldDoc.line(from - 1).to, 1) + 1).number)
    return beside(lineNo(oldDoc.line(from - 1).to, -1), g0, from - 1, from, g1)
  }

  const owns = (a: number, b: number) => {
    let hasOut = false, blockAlive = false, outAlive = false, outKept = false, blockBlank = false
    for (let ln = a; ln <= b; ln++) {
      const l = oldDoc.line(ln)
      if (ln >= from && ln < to) { blockAlive ||= alive(ln); blockBlank ||= l.length === 0 }
      else {
        hasOut = true
        if (!alive(ln)) continue
        outAlive = true
        outKept ||= isShared(ln) || covered(l.from, l.to) === 0
      }
    }
    if (!hasOut) return true      // block lines only: the block's, whatever was typed
    if (outKept) return false     // surviving shared text is NEVER ownable — even after a join
    return blockAlive || (!outAlive && blockBlank)
  }
  let ownFirst = 0, ownLast = 0
  for (let ln = g0, gs = g0; ln <= g1; ln++) {
    if (ln < g1 && nlGone(ln)) continue  // group continues past ln
    if (owns(gs, ln)) { ownFirst ||= gs; ownLast = ln }
    gs = ln + 1
  }
  if (ownFirst) {
    const f0 = oldDoc.line(ownFirst).from, t0 = oldDoc.line(ownLast).to
    let f = changes.mapPos(f0, 1), t = changes.mapPos(t0, -1)
    if (f > t) { f = changes.mapPos(f0, -1); t = changes.mapPos(t0, 1) }
    return { ...block, from: newDoc.lineAt(f).number, to: newDoc.lineAt(t).number + 1 }
  }
  // Nothing owned survives: zero-line beside the merged line.
  return beside(lineNo(oldDoc.line(from).from, -1), g0, from - 1, to, g1)
}

/** Enforce the tracker invariant after a hand-edit remap: every block within
 *  [1, lines+1], index order == doc order, pairwise disjoint (b[j].from >=
 *  b[j-1].to). remapBlock maps blocks independently, so one edit spanning two
 *  blocks (select from inside block 0 into block 1, type) lands both on the
 *  same merged line; left overlapping, a later take's index-ordered delta
 *  shift would push the second block onto an untouched shared line and the
 *  next take would destroy it. Policy — the simplest correct one: the EARLIER
 *  block keeps the contested lines, the later block is clamped to start where
 *  the earlier ends (possibly becoming zero-line) and is tagged 'mixed' (its
 *  content is no longer what its tag claimed; the arrows still work and
 *  re-taking either side from the clamped state is exact). Exception: an
 *  earlier ZERO-line marker owns nothing, so it never wins contested lines —
 *  it is pulled back to the later block's start instead (source unchanged:
 *  still an untaken insertion point). Never widens a non-empty block.
 *  Returns the input array untouched when nothing needed fixing. */
export function normalizeBlocks<B extends TrackedBlock>(blocks: readonly B[], lines: number): readonly B[] {
  const out = blocks.slice()
  let changed = false
  for (let j = 0; j < out.length; j++) {
    const b = out[j]
    let from = Math.min(Math.max(b.from, 1), lines + 1)
    // Nearest predecessor that actually owns lines bounds us; zero-line
    // markers in between that drifted past our start are pulled back to it.
    let k = j - 1
    while (k >= 0 && out[k].from >= out[k].to && out[k].from > from) k--
    from = Math.max(from, k >= 0 ? out[k].to : 1)
    for (let m = k + 1; m < j; m++) if (out[m].from > from) { out[m] = { ...out[m], from, to: from }; changed = true }
    const to = Math.min(Math.max(b.to, from), lines + 1)
    if (from === b.from && to === b.to) continue
    changed = true
    out[j] = b.from >= b.to ? { ...b, from, to } : { ...b, from, to, source: 'mixed' as const }
  }
  return changed ? out : blocks
}

/** Initial tracker range for a block. Center doc seeds with `theirs`, and
 *  blocks are already 1-based half-open THEIRS line ranges — the identity.
 *  Kept as a named function so the seed rule has one home (and one test). */
export function initialTrackPos(blk: ChangeBlock): LineRange {
  return { from: blk.bFrom, to: blk.bTo }
}
