import { describe, it, expect } from 'vitest'
import fc from 'fast-check'
import { Text, ChangeSet } from '@codemirror/state'
import {
  planTake, planTakeBoth, remapBlock, shiftBlock, normalizeBlocks, blockCharRange, initialTrackPos,
  type TrackedBlock,
} from './merge-surgery'
import { diffBlocks } from './merge-diff'
import { reconstructSides } from './conflict-extract'
import type { ChangeBlock } from './merge-diff'

// Text.of takes a line array — CM6's internal representation. Convenience.
const doc = (s: string) => Text.of(s.split('\n'))

// Apply a planTake change to a doc string — what centerView.dispatch would do.
const apply = (docStr: string, change: { from: number; to: number; insert: string }) =>
  docStr.slice(0, change.from) + change.insert + docStr.slice(change.to)

// Minimal block builder — most tests only care about one side's range.
const blk = (aFrom: number, aTo: number, bFrom: number, bTo: number): ChangeBlock =>
  ({ aFrom, aTo, bFrom, bTo })

// Tracked block builder — LINE range, 1-based half-open (merge-surgery's model).
const T = (from: number, to: number, source: TrackedBlock['source'] = 'theirs'): TrackedBlock =>
  ({ from, to, source })

// One simulated MergePanel: center doc string + the tracker array. `take`
// mirrors blockTracker.update()'s applyBlock branch EXACTLY — target gets the
// plan's explicit newTrack, every LATER block (higher index) shifts by delta,
// earlier blocks are untouched. If this composition reproduces ours/theirs
// for every shape, MergePanel's does.
interface Sim { docStr: string; track: TrackedBlock[] }
const seed = (theirsLines: string[], blocks: ChangeBlock[]): Sim => ({
  docStr: theirsLines.join('\n'),
  track: blocks.map(b => ({ ...initialTrackPos(b), source: 'theirs' as const })),
})
const take = (s: Sim, i: number, side: 'ours' | 'theirs', srcLines: string[], blocks: ChangeBlock[]): Sim => {
  const plan = planTake(doc(s.docStr), s.track[i], side, srcLines, blocks[i])
  if (!plan) return s  // idempotent skip (already this side)
  return {
    docStr: apply(s.docStr, plan.change),
    track: s.track.map((t, j) => j === i
      ? { ...plan.newTrack, source: side }
      : j > i ? shiftBlock(t, plan.delta) : t),
  }
}
const takeAll = (s: Sim, side: 'ours' | 'theirs', srcLines: string[], blocks: ChangeBlock[], order?: number[]): Sim =>
  (order ?? blocks.map((_, i) => i)).reduce((acc, i) => take(acc, i, side, srcLines, blocks), s)

describe('planTake — idempotence', () => {
  it('returns null when tracked.source already matches side', () => {
    expect(planTake(doc('abc'), T(1, 2, 'ours'), 'ours', ['abc'], blk(1, 2, 1, 2))).toBeNull()
  })

  it('does NOT null-return on source=mixed even if content happens to match', () => {
    // User hand-edited center to exactly ours' content. source=mixed means
    // "we don't know", so arrow should still fire (it'll be a no-op textually
    // but WILL flip the highlight back to ours, which is desirable feedback).
    expect(planTake(doc('abc'), T(1, 2, 'mixed'), 'ours', ['abc'], blk(1, 2, 1, 2))).not.toBeNull()
  })

  it('source=mixed after a hand-edit grew the line: replaces the WHOLE line', () => {
    // Realistic sequence: user types INSIDE a block → transactionExtender marks
    // it 'mixed' → remapBlock re-rounds to whole lines → user clicks → arrow.
    // In the line model a tracked range can never sit mid-line, so the take is
    // always a clean whole-line replace — the typed 'y' goes with the line.
    // (The char model kept a drifted [2,6) here and had to prove the change
    // stayed in bounds; that failure mode no longer exists.)
    const d = doc('A\nXXyX\nC')
    const plan = planTake(d, T(2, 3, 'mixed'), 'ours', ['A', 'OURS', 'C'], blk(2, 3, 2, 3))!
    expect(plan.change).toEqual({ from: 2, to: 6, insert: 'OURS' })
    expect(apply('A\nXXyX\nC', plan.change)).toBe('A\nOURS\nC')
    expect(plan.newTrack).toEqual({ from: 2, to: 3 })
    expect(plan.delta).toBe(0)
  })
})

describe('planTake — zero-line tracked position (from === to)', () => {
  // These are the 90d818ca fix shapes. Center already had something deleted
  // (prior take of the empty side), now taking back non-empty content.

  it('before a mid-doc line: trailing \\n separator pushes that line down', () => {
    // Doc: "AAA\nCCC", zero-line block before line 2 ("CCC").
    // Taking ours="BBB" should produce "AAA\nBBB\nCCC".
    const plan = planTake(doc('AAA\nCCC'), T(2, 2), 'ours', ['AAA', 'BBB', 'CCC'], blk(2, 3, 2, 2))!
    expect(plan.change.insert).toBe('BBB\n')  // trailing \n separator
    expect(apply('AAA\nCCC', plan.change)).toBe('AAA\nBBB\nCCC')
    // newTrack: line 2 is now "BBB" → [2,3). The pushed-down "CCC" is not
    // block content. One line added → later blocks shift by +1.
    expect(plan.newTrack).toEqual({ from: 2, to: 3 })
    expect(plan.delta).toBe(1)
  })

  it('after the last line (from === lines+1): LEADING \\n separator, track starts on the new line', () => {
    // Doc: "AAA\nBBB", zero-line block at line 3 (past the 2-line doc).
    // Taking ours="CCC" should produce "AAA\nBBB\nCCC".
    const plan = planTake(doc('AAA\nBBB'), T(3, 3), 'ours', ['AAA', 'BBB', 'CCC'], blk(3, 4, 3, 3))!
    expect(plan.change).toEqual({ from: 7, to: 7, insert: '\nCCC' })  // leading \n separator
    expect(apply('AAA\nBBB', plan.change)).toBe('AAA\nBBB\nCCC')
    // newTrack is line 3 — the leading \n belongs to nobody.
    expect(plan.newTrack).toEqual({ from: 3, to: 4 })
  })

  it('block OWNS a blank line mid-doc (tracked [2,3), not zero-line): plain replace', () => {
    // theirs=['AAA','','CCC'] (blank middle), ours=['AAA','BBB','CCC']. Center
    // seeded theirs → "AAA\n\nCCC". Block bFrom=2,bTo=3: theirs HAS a line
    // (the empty string), so the tracked range is the 1-line [2,3) — the
    // blank IS block content and gets replaced. No separator, no extension.
    //
    // The char model saw this blank as a zero-width offset identical to
    // "before line 2" and needed an oppEmpty flag to tell them apart;
    // 90d818ca's fix#9 (to+=1) ate the next line's separator ("AAA\nBBBCCC")
    // and a trailing-\n variant left a phantom blank ("AAA\nBBB\n\nCCC").
    // In lines the two cases are different VALUES: [2,3) here vs [2,2) below.
    const plan = planTake(doc('AAA\n\nCCC'), T(2, 3), 'ours', ['AAA', 'BBB', 'CCC'], blk(2, 3, 2, 3))!
    expect(plan.change).toEqual({ from: 4, to: 4, insert: 'BBB' })  // NO extension
    expect(apply('AAA\n\nCCC', plan.change)).toBe('AAA\nBBB\nCCC')
    expect(plan.newTrack).toEqual({ from: 2, to: 3 })
  })

  it('zero-line block BEFORE a shared blank line: trailing \\n — do NOT replace the blank', () => {
    // theirs=['AAA','','CCC'] (shared blank at line 2). ours=['AAA','X','','CCC']
    // (extra 'X' at line 2, pushes blank to line 3). Block: ours[2]='X' vs
    // theirs[nothing] at bFrom=2 → tracked [2,2) = before the SHARED blank.
    // Insert must go BEFORE it with trailing \n → "AAA\nX\n\nCCC". The char
    // model's empty-line branch once replaced the shared blank → "AAA\nX\nCCC"
    // (lost the blank).
    const plan = planTake(doc('AAA\n\nCCC'), T(2, 2), 'ours', ['AAA', 'X', '', 'CCC'], blk(2, 3, 2, 2))!
    expect(plan.change).toEqual({ from: 4, to: 4, insert: 'X\n' })  // trailing \n
    expect(apply('AAA\n\nCCC', plan.change)).toBe('AAA\nX\n\nCCC')
    expect(plan.newTrack).toEqual({ from: 2, to: 3 })
  })

  it('zero-line block AFTER a shared blank that is the whole doc: leading \\n (the 2026-05 pinned gap)', () => {
    // Base had a blank line; ours appended 'A' after it; theirs kept just the
    // blank. Center seeds to "" — which is ONE shared blank line, not zero
    // lines — and the block sits at line 2 (past it). The char model saw
    // doc.length===0 and inserted bare 'A', DROPPING the shared blank. Line
    // model: from=2 === lines+1 → append with a leading \n → "\nA".
    const plan = planTake(doc(''), T(2, 2), 'ours', ['', 'A'], blk(2, 3, 2, 2))!
    expect(plan.change).toEqual({ from: 0, to: 0, insert: '\nA' })
    expect(apply('', plan.change)).toBe('\nA')
    expect(plan.newTrack).toEqual({ from: 2, to: 3 })
  })

  it('zero-line block BEFORE a shared blank that is the whole doc: trailing \\n', () => {
    // Mirror of the above: ours=['X',''], theirs=[''] — 'X' goes before the
    // shared blank → "X\n". Same doc "", same one-line insert as the empty-
    // FILE case below; only the tracked line (1 vs the block owning line 1)
    // tells them apart — the []-vs-[''] distinction the char model erased.
    const plan = planTake(doc(''), T(1, 1), 'ours', ['X', ''], blk(1, 2, 1, 1))!
    expect(plan.change).toEqual({ from: 0, to: 0, insert: 'X\n' })
    expect(apply('', plan.change)).toBe('X\n')
    expect(plan.newTrack).toEqual({ from: 1, to: 2 })
  })

  it('empty FILE (theirs owns the blank as block content, [1,2)): plain replace, no separator', () => {
    // ours=['X'] vs a theirs that is the empty file. In the split model '' is
    // one blank line and conflict-extract hands it to the block ([1,2)), so
    // this is an ordinary 1-line replace → "X". No \n either side.
    const plan = planTake(doc(''), T(1, 2), 'ours', ['X'], blk(1, 2, 1, 2))!
    expect(plan.change).toEqual({ from: 0, to: 0, insert: 'X' })
    expect(apply('', plan.change)).toBe('X')
    expect(plan.newTrack).toEqual({ from: 1, to: 2 })
  })

  it('zero-line block + zero-line source: empty change, plan still returned (source flips)', () => {
    // Nothing to insert, nothing to delete — but the arrow click must still
    // dispatch so the tracker's source tag (and the counter) update.
    const plan = planTake(doc('A\nB'), T(2, 2), 'ours', ['A', 'B'], blk(2, 2, 2, 2))!
    expect(plan.change).toEqual({ from: 2, to: 2, insert: '' })
    expect(plan.newTrack).toEqual({ from: 2, to: 2 })
    expect(plan.delta).toBe(0)
  })
})

describe('planTake — K=0 (source side empty: delete the tracked lines)', () => {
  // Source side has zero lines for this block (aFrom===aTo). Center still has
  // content from the other side. Delete it, consuming ONE adjacent \n.

  it('consumes trailing \\n when a line follows', () => {
    // Doc: "AAA\nBBB\nCCC", tracked [2,3) (line 2 "BBB"). Ours is empty.
    // Should produce "AAA\nCCC" — delete "BBB" AND its trailing \n.
    const plan = planTake(doc('AAA\nBBB\nCCC'), T(2, 3), 'ours', ['AAA', 'CCC'], blk(2, 2, 2, 3))!
    expect(plan.change).toEqual({ from: 4, to: 8, insert: '' })  // through line 3's start
    expect(apply('AAA\nBBB\nCCC', plan.change)).toBe('AAA\nCCC')
    expect(plan.newTrack).toEqual({ from: 2, to: 2 })  // zero-line, before "CCC"
    expect(plan.delta).toBe(-1)
  })

  it('consumes LEADING \\n when the block is the doc tail (no trailing \\n)', () => {
    // Doc: "AAA\nBBB", tracked [2,3) (line 2). Ours is empty.
    // No line 3 → consume the leading \n instead. Otherwise: "AAA\n"
    // (phantom trailing \n the source side never had).
    const plan = planTake(doc('AAA\nBBB'), T(2, 3), 'ours', ['AAA'], blk(2, 2, 2, 3))!
    expect(plan.change).toEqual({ from: 3, to: 7, insert: '' })  // from line 1's end
    expect(apply('AAA\nBBB', plan.change)).toBe('AAA')
    expect(plan.newTrack).toEqual({ from: 2, to: 2 })  // = lines+1: after "AAA"
  })

  it('block OWNS a blank line mid-doc: deletes it (trailing \\n) — the 2026-03-18 no-op bug', () => {
    // theirs = ['A', '', 'B'] (blank middle). ours = ['A', 'B'] (deleted).
    // Center seeded theirs → "A\n\nB". The blank is line 2 → tracked [2,3).
    // Take ours: delete the empty line → "A\nB". (Char model: the blank
    // tracked as zero-width, an early from===to gate swallowed it before the
    // deletion branch → arrow click silently did nothing. In lines a block
    // that owns a blank line is not zero-anything.)
    const plan = planTake(doc('A\n\nB'), T(2, 3), 'ours', ['A', 'B'], blk(2, 2, 2, 3))!
    expect(plan.change).toEqual({ from: 2, to: 3, insert: '' })
    expect(apply('A\n\nB', plan.change)).toBe('A\nB')
    expect(plan.newTrack).toEqual({ from: 2, to: 2 })
  })

  it('block OWNS a trailing blank line: consumes LEADING \\n', () => {
    // theirs = ['A', ''] (trailing blank). ours = ['A']. Center "A\n".
    // Line 2 is the blank, tracked [2,3), it's the tail → eat the \n before it.
    const plan = planTake(doc('A\n'), T(2, 3), 'ours', ['A'], blk(2, 2, 2, 3))!
    expect(apply('A\n', plan.change)).toBe('A')
    expect(plan.newTrack).toEqual({ from: 2, to: 2 })
  })

  it('block spans the WHOLE doc (only after hand-edits): deletes everything, consumes nothing', () => {
    // A consistent seed never pairs an all-lines block with an empty source
    // (that side would be the empty file = one blank line owned by the block).
    // Reachable only once the user deleted every shared line. Must not throw
    // or reach outside the doc.
    const plan = planTake(doc('AAA\nBBB'), T(1, 3), 'ours', [''], blk(1, 1, 1, 3))!
    expect(plan.change).toEqual({ from: 0, to: 7, insert: '' })
    expect(apply('AAA\nBBB', plan.change)).toBe('')
    expect(plan.newTrack).toEqual({ from: 1, to: 1 })
  })
})

describe('planTake — content correctness', () => {
  it('blank-line content is preserved (K=1 with content "" is NOT K=0)', () => {
    // The original `!insert` bug: [''].join('\n') === '' (falsy), but the
    // source has one line so K=1 — this IS content (one blank line). Must be
    // preserved. Ours = ['AAA', '', 'CCC'] (blank middle). Block covers line 2.
    const plan = planTake(doc('AAA\nXXX\nCCC'), T(2, 3), 'ours', ['AAA', '', 'CCC'], blk(2, 3, 2, 3))!
    expect(plan.change.insert).toBe('')  // single blank line's content is ''
    expect(apply('AAA\nXXX\nCCC', plan.change)).toBe('AAA\n\nCCC')
    // newTrack still OWNS line 2 (now blank) — [2,3), not zero-line. This is
    // exactly the bit the char model lost (its newTrack was the zero-width
    // [4,4], indistinguishable from "before line 2").
    expect(plan.newTrack).toEqual({ from: 2, to: 3 })
    expect(plan.delta).toBe(0)
  })

  it('multi-line insert joined with \\n; newTrack spans K lines; delta = K - N', () => {
    const plan = planTake(doc('A\nX\nD'), T(2, 3), 'ours', ['A', 'B', 'C', 'D'], blk(2, 4, 2, 3))!
    expect(plan.change.insert).toBe('B\nC')
    expect(apply('A\nX\nD', plan.change)).toBe('A\nB\nC\nD')
    expect(plan.newTrack).toEqual({ from: 2, to: 4 })
    expect(plan.delta).toBe(1)
  })

  it('takes from `theirs` side when side=theirs (reads bFrom/bTo)', () => {
    // Previously took ours. Now take theirs back. Block.bFrom/bTo index theirs.
    const theirsLines = ['A', 'THEIRS', 'D']
    const plan = planTake(doc('A\nOURS\nD'), T(2, 3, 'ours'), 'theirs', theirsLines, blk(2, 3, 2, 3))!
    expect(plan.change.insert).toBe('THEIRS')
    expect(apply('A\nOURS\nD', plan.change)).toBe('A\nTHEIRS\nD')
  })

  it('newTrack excludes the leading \\n separator (sourceHighlight boundary)', () => {
    // This is the sourceHighlight bug: if the tracked range began at the
    // leading \n's position, the highlight would decorate the PRECEDING line.
    // In lines: the appended content is line 3, and line 3 only.
    const plan = planTake(doc('AAA\nBBB'), T(3, 3), 'ours', ['AAA', 'BBB', 'CCC'], blk(3, 4, 3, 3))!
    expect(plan.change.from).toBe(7)   // the \n goes in at the old doc end…
    expect(plan.newTrack).toEqual({ from: 3, to: 4 })  // …but the block is line 3
    const newDoc = doc(apply('AAA\nBBB', plan.change))
    const r = blockCharRange(newDoc, plan.newTrack)
    expect(newDoc.sliceString(r.from, r.to)).toBe('CCC')
    expect(newDoc.lineAt(r.from).text).toBe('CCC')  // NOT "BBB"
  })
})

describe('planTake — round-trip (take-ours → take-theirs = identity)', () => {
  // Semantic property: for any block, starting from theirs (seed), take ours,
  // then take theirs back → should produce theirs again EXACTLY. This composes
  // planTake + apply + the tracker's newTrack and proves the surgery is
  // reversible.
  const roundTrip = (oursLines: string[], theirsLines: string[], b: ChangeBlock) => {
    const s0 = seed(theirsLines, [b])
    const s1 = take(s0, 0, 'ours', oursLines, [b])
    expect(s1.docStr).toBe(oursLines.join('\n'))  // midpoint = ours
    return take(s1, 0, 'theirs', theirsLines, [b]).docStr
  }

  it('simple mid-doc replacement: round-trip is identity', () => {
    expect(roundTrip(['A', 'OURS', 'C'], ['A', 'THEIRS', 'C'], blk(2, 3, 2, 3))).toBe('A\nTHEIRS\nC')
  })

  it('ours-empty (deletion) → theirs-back (restoration): round-trip identity', () => {
    // Ours deleted line 2. Theirs has it. Take-ours removes, take-theirs-back
    // restores.
    expect(roundTrip(['A', 'C'], ['A', 'B', 'C'], blk(2, 2, 2, 3))).toBe('A\nB\nC')
  })

  it('theirs-empty → ours inserts → theirs-back deletes: identity', () => {
    expect(roundTrip(['A', 'B', 'C'], ['A', 'C'], blk(2, 3, 2, 2))).toBe('A\nC')
  })

  it('end-of-doc block: identity through leading-\\n separator branch', () => {
    expect(roundTrip(['A', 'B', 'OURS'], ['A', 'B'], blk(3, 4, 3, 3))).toBe('A\nB')
  })

  it('blank-line content: identity (the K=1-with-"" case)', () => {
    // Ours line 2 is blank. Theirs line 2 is "X". Round-trip.
    expect(roundTrip(['A', '', 'C'], ['A', 'X', 'C'], blk(2, 3, 2, 3))).toBe('A\nX\nC')
  })

  it('empty-line DELETE → restore: identity', () => {
    // Theirs has blank middle. Ours deleted it. Take-ours removes the blank
    // line; take-theirs-back restores it. Previously step 1 was a no-op
    // (from===to gate swallowed the deletion) so step 2's idempotence check
    // returned null — the arrow click did nothing, silently.
    expect(roundTrip(['A', 'C'], ['A', '', 'C'], blk(2, 2, 2, 3))).toBe('A\n\nC')
  })

  it('whole-file delete → restore: identity (empty file is a block-owned blank line)', () => {
    // theirs=['X'], ours = the empty file. In the split model ours is ['']
    // and the block is a 1↔1 replace ([1,2) both sides — conflict-extract's
    // invariant), so the center goes 'X' → '' → 'X'. Modeled as a 0-line ours
    // ([1,1)) the take-back would see "" as a shared blank and produce "X\n".
    expect(roundTrip([''], ['X'], blk(1, 2, 1, 2))).toBe('X')
  })
})

// Multi-block round-trip through diffBlocks → planTake. Covers shapes the
// single-block roundTrip above misses (adjacent blocks, crossing diffs,
// empty-line runs). NOT the MergePanel pipeline (that uses sides.blocks from
// reconstructSides — see the fixture-driven describe below); diffBlocks here
// is just a fixture generator for arbitrary ChangeBlock[] shapes.
describe('planTake — diffBlocks multi-block round-trip (every block ours→theirs = identity)', () => {
  // Apply ALL blocks take-ours, then ALL blocks take-theirs-back, threading
  // the tracker through every take (shift of later blocks by delta). This is
  // what MergePanel does when the user clicks every → arrow then every ← arrow.
  const fullRoundTrip = (oursLines: string[], theirsLines: string[]) => {
    const blocks = diffBlocks(oursLines, theirsLines)
    const s1 = takeAll(seed(theirsLines, blocks), 'ours', oursLines, blocks)
    expect(s1.docStr).toBe(oursLines.join('\n'))
    return takeAll(s1, 'theirs', theirsLines, blocks).docStr
  }

  it.each([
    // Simple replace
    [['A', 'OURS', 'C'], ['A', 'THEIRS', 'C']],
    // Adjacent non-overlapping blocks (common: import reorder)
    [['A', 'X', 'B', 'Y', 'C'], ['A', 'P', 'B', 'Q', 'C']],
    // Empty-line: ours deleted, theirs keeps
    [['A', 'C'], ['A', '', 'C']],
    // Mirror: theirs deleted, ours keeps
    [['A', '', 'C'], ['A', 'C']],
    // Trailing empty line
    [['A'], ['A', '']],
    [['A', ''], ['A']],
    // Multiple adjacent empty-line operations
    [['A', '', '', 'C'], ['A', '', 'C']],
    // Blank-line reshuffles + leading/trailing blanks — the shapes the 2026-05
    // fast-check sweep found broken under the char model.
    [['', 'A'], ['A', '']],
    [['A', ''], ['', 'A']],
    [['', ''], ['']],
    [[''], ['', '']],
    [['', 'A', ''], ['']],
    [['X', ''], ['']],
    [[''], ['A']],
  ])('ours=%j theirs=%j → round-trip identity', (oursLines, theirsLines) => {
    expect(fullRoundTrip(oursLines, theirsLines)).toBe(theirsLines.join('\n'))
  })
})

describe('blockCharRange — the line→char boundary conversion', () => {
  it('non-empty block: [start of first line, end of last line] — excludes trailing \\n', () => {
    const d = doc('A\nBB\nCCC\nD')
    const r = blockCharRange(d, T(2, 4))  // lines 2-3
    expect(r).toEqual({ from: 2, to: 8 })
    expect(d.sliceString(r.from, r.to)).toBe('BB\nCCC')
  })

  it('block owning one blank line: equal offsets, but that is a 1-line block, not zero-line', () => {
    const d = doc('A\n\nC')
    expect(blockCharRange(d, T(2, 3))).toEqual({ from: 2, to: 2 })
  })

  it('zero-line block before line n: that line\'s start', () => {
    expect(blockCharRange(doc('A\nB\nC'), T(2, 2))).toEqual({ from: 2, to: 2 })
  })

  it('zero-line block past the last line: doc.length', () => {
    expect(blockCharRange(doc('A\nB'), T(3, 3))).toEqual({ from: 3, to: 3 })
  })

  it('clamps a stale out-of-range block instead of throwing', () => {
    // A CM6 decoration/scroll computed from a momentarily stale range must
    // not throw inside the view update.
    expect(() => blockCharRange(doc('A'), T(5, 9))).not.toThrow()
    expect(() => blockCharRange(doc('A'), T(0, 0))).not.toThrow()
  })
})

describe('shiftBlock', () => {
  it('moves both endpoints by delta, keeps everything else', () => {
    expect(shiftBlock(T(4, 6, 'ours'), -2)).toEqual(T(2, 4, 'ours'))
  })
  it('delta 0 returns the same object (cheap no-op for the tracker map)', () => {
    const b = T(4, 6)
    expect(shiftBlock(b, 0)).toBe(b)
  })
})

describe('normalizeBlocks — re-establish in-bounds / ordered / disjoint after a hand-edit remap', () => {
  it('returns the SAME array when the invariant already holds (cheap common path)', () => {
    const bs = [T(1, 2), T(3, 3), T(4, 6, 'ours')]
    expect(normalizeBlocks(bs, 5)).toBe(bs)
  })
  it('overlap from a cross-block edit: earlier block keeps the lines, later is clamped to its end + tagged mixed', () => {
    // "A/CCC/D/EEE/F", replace "CC\nD\nEE" with "z" → both blocks remap onto
    // line 2 ("CzE"). Left overlapping, All-ours' index-ordered delta shift
    // would push block 1 onto shared line 1 and its take would destroy "A".
    expect(normalizeBlocks([T(2, 3, 'mixed'), T(2, 3, 'mixed')], 3)).toEqual([T(2, 3, 'mixed'), T(3, 3, 'mixed')])
    expect(normalizeBlocks([T(2, 4), T(3, 5, 'ours')], 6)).toEqual([T(2, 4), T(4, 5, 'mixed')])
  })
  it('clamps out-of-range blocks into [1, lines+1] and tags them mixed', () => {
    expect(normalizeBlocks([T(0, 2), T(7, 9, 'ours')], 4)).toEqual([T(1, 2, 'mixed'), T(5, 5, 'mixed')])
  })
  it('an earlier ZERO-line marker never wins contested lines: it is pulled back to the later block\'s start, source kept', () => {
    expect(normalizeBlocks([T(3, 3), T(2, 4, 'mixed')], 5)).toEqual([T(2, 2), T(2, 4, 'mixed')])
    // chain of markers, then a non-empty earlier block still wins
    expect(normalizeBlocks([T(1, 3, 'ours'), T(4, 4), T(4, 4), T(2, 5, 'mixed')], 6))
      .toEqual([T(1, 3, 'ours'), T(3, 3), T(3, 3), T(3, 5, 'mixed')])
  })
  it('untouched blocks keep their identity and source', () => {
    const a = T(1, 2, 'ours')
    const out = normalizeBlocks([a, T(1, 3)], 4)
    expect(out[0]).toBe(a)
    expect(out[1]).toEqual(T(2, 3, 'mixed'))
  })
})

describe('planTake / planTakeBoth — defensive shapes reachable only via hand-edits', () => {
  it('planTake clamps a corrupted out-of-range tracked block instead of throwing RangeError', () => {
    expect(() => planTake(doc('A\nB'), T(5, 9), 'ours', ['A', 'X', 'B'], blk(2, 3, 2, 3))).not.toThrow()
    expect(() => planTake(doc('A\nB'), T(0, 0), 'ours', ['A', 'X', 'B'], blk(2, 3, 2, 2))).not.toThrow()
    const plan = planTake(doc('A\nB'), T(5, 9), 'ours', ['A', 'B'], blk(2, 2, 2, 3))!
    expect(plan.change.from).toBeGreaterThanOrEqual(0)
    expect(plan.change.to).toBeLessThanOrEqual(3)
  })

  it('planTakeBoth on a block the user emptied (zero-line): inserts ours\\ntheirs as whole lines', () => {
    // User deleted "THEIRS\n" wholesale → remapBlock leaves [2,2) (no
    // annexing). ⇄ must still work: same insertion rule as planTake's N=0.
    const mid = planTakeBoth(doc('A\nC'), T(2, 2, 'mixed'), ['A', 'OURS', 'C'], ['A', 'THEIRS', 'C'], blk(2, 3, 2, 3))!
    expect(apply('A\nC', mid.change)).toBe('A\nOURS\nTHEIRS\nC')
    expect(mid.newTrack).toEqual({ from: 2, to: 4 })
    expect(mid.delta).toBe(2)
    const tail = planTakeBoth(doc('A'), T(2, 2, 'mixed'), ['A', 'O'], ['A', 'T'], blk(2, 3, 2, 3))!
    expect(apply('A', tail.change)).toBe('A\nO\nT')
    expect(tail.newTrack).toEqual({ from: 2, to: 4 })
  })
})

describe('remapBlock — hand-edits map through CM6 changes and re-round to whole lines', () => {
  // ChangeSet.of({from, to, insert}, docLength) — CM6's pure change spec.
  // No EditorView needed. remapBlock is ONLY for arbitrary (user/undo) edits;
  // takes carry explicit positions and never come through here.
  const remap = (docStr: string, b: TrackedBlock, from: number, to: number, insert: string) => {
    const oldDoc = doc(docStr)
    const cs = ChangeSet.of({ from, to, insert }, oldDoc.length)
    return remapBlock(b, cs, oldDoc, cs.apply(oldDoc))
  }

  it('edit on a line BEFORE the block: block shifts by the inserted line count', () => {
    // Enter in the middle of line 1 → block on line 3 moves to line 4.
    expect(remap('AAAA\nB\nCCC\nD', T(3, 4), 2, 2, '\n')).toEqual(T(4, 5))
  })

  it('typing (no newline) before / after the block: line range unchanged', () => {
    expect(remap('A\nB\nCCC\nD', T(3, 4), 0, 0, 'xx')).toEqual(T(3, 4))
    expect(remap('A\nB\nCCC\nD', T(3, 4), 9, 9, 'xx')).toEqual(T(3, 4))
  })

  it('typing INSIDE the block: still the same whole line(s)', () => {
    expect(remap('A\nCCC\nD', T(2, 3), 3, 3, 'y')).toEqual(T(2, 3))
  })

  it('Enter INSIDE the block: block grows by a line', () => {
    expect(remap('A\nCCC\nD', T(2, 3), 3, 3, '\n')).toEqual(T(2, 4))
  })

  it('Enter at the block\'s first column: block is pushed down, new blank line is NOT absorbed (from assoc=1)', () => {
    expect(remap('A\nCCC\nD', T(2, 3), 2, 2, '\n')).toEqual(T(3, 4))
  })

  it('Enter at the block\'s last column: new line after is NOT absorbed (to assoc=-1)', () => {
    expect(remap('A\nCCC\nD', T(2, 3), 5, 5, '\n')).toEqual(T(2, 3))
  })

  it('whole-block select-and-type: inversion → re-map with flipped assoc → SPANS the replacement', () => {
    // 90d818ca fix #6. Replace exactly the block's text with "NEW": normal
    // assoc puts from past the insert and to before it (from>to) — flip so
    // the block keeps owning its (rewritten) line.
    expect(remap('A\nCCC\nD', T(2, 3), 2, 5, 'NEW')).toEqual(T(2, 3))
    expect(remap('A\nCCC\nD', T(2, 3), 2, 5, 'N\nEW')).toEqual(T(2, 4))
  })

  it('block owning a BLANK line survives an unrelated edit as a 1-line block (emptiness is decided by lines, not offsets)', () => {
    // The blank line maps to equal offsets; a mapped-offsets-are-equal test
    // would wrongly collapse it to zero-line and the next take would insert
    // beside the blank instead of replacing it.
    expect(remap('A\n\nC', T(2, 3), 0, 0, 'x')).toEqual(T(2, 3))
    expect(remap('A\n\nC', T(2, 3), 4, 4, 'x')).toEqual(T(2, 3))
  })

  it('backspace joining the block\'s first line with the previous (intact, shared) one: block lets go — zero-line after the merged line', () => {
    // "A\nCCC\nD" delete the \n at 1 → "ACCC\nD". "A" is untouched shared
    // content ⇒ never ownable ⇒ the block owns nothing; marker before "D".
    expect(remap('A\nCCC\nD', T(2, 3), 1, 2, '')).toEqual(T(2, 2))
    // …and the same when the user ALSO damaged it: what's left of it may be another
    // line's untouched text, joined there by an earlier edit.
    expect(remap('AA\nCCC\nD', T(2, 3), 1, 3, '')).toEqual(T(2, 2))   // "AA"→"A" + join
    // A neighbour deleted entirely leaves nothing to protect: still the block's.
    expect(remap('A\nCCC\nD', T(2, 3), 0, 2, '')).toEqual(T(1, 2))
  })

  it('user deletes exactly the block\'s text: block still owns the now-blank line', () => {
    expect(remap('A\nCCC\nD', T(2, 3), 2, 5, '')).toEqual(T(2, 3))
  })

  // ── Wholesale line deletion must NOT annex the neighbouring shared line ──
  // (adversarial review, 2026-08). Deleting a block line TOGETHER with its
  // newline collapses the content offsets onto the following (or, for a tail
  // block, preceding) shared line; lineAt() alone then claimed that line and
  // the next arrow click destroyed it ("A/CCC/D": select "CCC\n", Backspace,
  // ← theirs → saved "A\nCCC", D lost). remapBlock maps the block's separator
  // boundaries too and fences from/to with them.
  describe('whole-line deletes shrink the block, never annex a neighbour', () => {
    it('single-line block deleted with its \\n → zero-line before the next line', () => {
      expect(remap('A\nCCC\nD', T(2, 3), 2, 6, '')).toEqual(T(2, 2))
    })
    it('last line of a multi-line block deleted with its \\n → block keeps only its own lines', () => {
      expect(remap('A\nB\nC\nD', T(2, 4), 4, 6, '')).toEqual(T(2, 3))     // "C\n" gone → [B]
      expect(remap('A\nB\nC\nD', T(2, 4), 2, 4, '')).toEqual(T(2, 3))     // "B\n" gone → [C]
    })
    it('tail block deleted with its LEADING \\n → zero-line past the end (does not claim the line before)', () => {
      expect(remap('A\nCCC', T(2, 3), 1, 5, '')).toEqual(T(2, 2))
    })
    it('block owning the trailing blank: deleting that \\n → zero-line past the end', () => {
      expect(remap('A\n', T(2, 3), 1, 2, '')).toEqual(T(2, 2))
    })
    it('block owning a mid-doc blank: deleting either adjacent \\n → zero-line, neighbours untouched', () => {
      expect(remap('A\n\nC', T(2, 3), 2, 3, '')).toEqual(T(2, 2))
      expect(remap('A\n\nC', T(2, 3), 1, 2, '')).toEqual(T(2, 2))
    })
    it('"\\nCCC\\n" replaced by "\\n" (line removed, separators re-typed) → zero-line', () => {
      expect(remap('A\nCCC\nD', T(2, 3), 1, 6, '\n')).toEqual(T(2, 2))
    })
    it('"CCC\\n" replaced by "X\\n" (retyped WITH its newline): conservative — zero-line BEFORE the typed line, which stays unowned', () => {
      // Nothing of the block survived and "D" is alive in the merge ⇒ the
      // block owns nothing; a later take re-inserts beside "X" rather than
      // overwriting the user's text. (Retyping the TEXT without the newline
      // keeps ownership — see below.)
      expect(remap('A\nCCC\nD', T(2, 3), 2, 6, 'X\n')).toEqual(T(2, 2))
      // …and a follow-up Enter after X must not let the marker wander onto D.
      const d1 = doc('A\nX\nD')
      const cs2 = ChangeSet.of({ from: 3, to: 3, insert: '\n' }, d1.length)
      expect(remapBlock(T(2, 2), cs2, d1, cs2.apply(d1))).toEqual(T(2, 2))
    })
    it('retyping the block\'s TEXT (newline untouched) keeps ownership, incl. multi-line replacements', () => {
      expect(remap('A\nCCC\nD', T(2, 3), 2, 5, 'X')).toEqual(T(2, 3))
      expect(remap('A\nCCC\nD', T(2, 3), 2, 5, 'X\nY')).toEqual(T(2, 4))
    })
    it('a plain JOIN with an intact neighbour (only the separator deleted) also lets go: zero-line beside the merged line', () => {
      // The neighbour's content is 100% intact ⇒ never ownable, even though
      // block content is alive on the same line (review MED-2: join, then
      // Enter re-splits the text into its original shape — had the block
      // owned the merged line it would now own the neighbour too).
      expect(remap('A\nCCC\nD', T(2, 3), 5, 6, '')).toEqual(T(2, 2))   // "CCCD": marker before it
      expect(remap('A\nCCC\nD', T(2, 3), 1, 2, '')).toEqual(T(2, 2))   // "ACCC": marker after it (before D)
      expect(remap('A\nB\nC\nD', T(2, 4), 5, 6, '')).toEqual(T(2, 3))  // multi-line: keeps B, lets go of the "CD" line
    })

    it('PROPERTY: deleting exactly one whole line (+ its separator) anywhere changes only the block that owned it', () => {
      const line = fc.constantFrom('A', 'B', 'C', 'X', '')
      const lines = fc.array(line, { minLength: 1, maxLength: 7 })
      fc.assert(fc.property(lines, lines, fc.nat({ max: 20 }), fc.boolean(), (ours, theirs, pick, leading) => {
        const blocks = diffBlocks(ours, theirs)
        const s0 = seed(theirs, blocks)
        const d0 = doc(s0.docStr)
        fc.pre(d0.lines >= 2)
        const ln = (pick % d0.lines) + 1
        const l = d0.line(ln)
        // Delete line ln with its trailing \n, or (leading=true / last line)
        // with its leading \n — both are "remove exactly this line".
        const useLeading = ln === d0.lines || (leading && ln > 1)
        // Two ADJACENT blank lines, one deleted: "\n\n"→"\n" is the same
        // change whichever you meant, so "which blank survived" has no
        // textual answer (remapBlock lets a block keep its blank). Only
        // assert the unambiguous shapes.
        fc.pre(!(l.length === 0 && d0.line(useLeading ? ln - 1 : ln + 1).length === 0))
        const [from, to] = useLeading ? [d0.line(ln - 1).to, l.to] : [l.from, d0.line(ln + 1).from]
        const cs = ChangeSet.of({ from, to, insert: '' }, d0.length)
        const d1 = cs.apply(d0)
        expect(d1.lines).toBe(d0.lines - 1)
        const t1 = s0.track.map(t => remapBlock(t, cs, d0, d1))
        s0.track.forEach((t, i) => {
          const owned = ln >= t.from && ln < t.to
          const n0 = t.to - t.from, n1 = t1[i].to - t1[i].from
          expect(n1).toBe(owned ? n0 - 1 : n0)                 // size: only the owner shrinks
          expect(t1[i].from).toBe(ln < t.from ? t.from - 1 : t.from)  // position: shifts iff the line was above
        })
        for (let j = 1; j < t1.length; j++) expect(t1[j].from).toBeGreaterThanOrEqual(t1[j - 1].to)
      }), { numRuns: 400 })
    })
  })

  describe('zero-line blocks (insertion markers)', () => {
    it('typing at column 0 of the line it precedes: stays BEFORE that line (left-lean)', () => {
      expect(remap('A\nB', T(2, 2), 2, 2, 'x')).toEqual(T(2, 2))
      expect(remap('A\nB', T(1, 1), 0, 0, 'x')).toEqual(T(1, 1))
    })

    it('past-the-end marker stays past the end while the user extends the last line', () => {
      // theirs=['A'], ours=['A','B'] → marker at line 2 of a 1-line doc. User
      // types at the end of 'A'. A naive lineAt(doc.length) would pull the
      // marker back to "before line 1" and the take would PREPEND 'B'.
      expect(remap('A', T(2, 2), 1, 1, 'xyz')).toEqual(T(2, 2))
      // Same lean as a mid-doc marker (text typed at the end of the line
      // ABOVE lands before it): everything typed at EOF — even a new line —
      // lands before a past-the-end marker, which stays past the end.
      expect(remap('A', T(2, 2), 1, 1, '\nZ')).toEqual(T(3, 3))
      // Mid-doc counterpart: '\nZ' typed at the end of A, marker before B stays before B.
      expect(remap('A\nB', T(2, 2), 1, 1, '\nZ')).toEqual(T(3, 3))
    })

    it('lines inserted before it push it down; edits after it leave it', () => {
      expect(remap('A\nB\nC', T(3, 3), 1, 1, '\n\n')).toEqual(T(5, 5))
      expect(remap('A\nB\nC', T(2, 2), 4, 4, '\nZ')).toEqual(T(2, 2))
    })

    it('no changes: identity', () => {
      const d = doc('A\nB\nC')
      expect(remapBlock(T(2, 2), ChangeSet.empty(d.length), d, d)).toEqual(T(2, 2))
      expect(remapBlock(T(2, 4), ChangeSet.empty(d.length), d, d)).toEqual(T(2, 4))
    })
  })

  it('undo of a take (inverse ChangeSet) maps NON-target blocks back exactly', () => {
    // MergePanel restores the whole tracker snapshot on take-undo (restoreAll),
    // but redo/undo of hand-edits and any effect-less inverse go through
    // remapBlock — check the common take inverses land later blocks back on
    // their original lines, blank lines included.
    const cases: [string[], string[]][] = [
      [['A', 'X', 'B', 'Y', 'C'], ['A', 'B', 'C']],       // two insertions
      [['A', 'C', ''], ['A', 'B', 'C', 'D', '']],         // two deletions
      [['', 'A', ''], ['', '', 'B']],                     // blanks everywhere
      [['A', 'B', 'OURS'], ['A', '', 'B']],               // append after last line
    ]
    for (const [ours, theirs] of cases) {
      const blocks = diffBlocks(ours, theirs)
      const s0 = seed(theirs, blocks)
      const plan = planTake(doc(s0.docStr), s0.track[0], 'ours', ours, blocks[0])!
      const s1 = take(s0, 0, 'ours', ours, blocks)
      const d0 = doc(s0.docStr), d1 = doc(s1.docStr)
      const inverse = ChangeSet.of(plan.change, d0.length).invert(d0)
      for (let j = 1; j < blocks.length; j++) {
        expect(remapBlock(s1.track[j], inverse, d1, d0)).toEqual(s0.track[j])
      }
    }
  })
})

// --- End-to-end: conflict-extract (sides.blocks) → planTake → apply ---
// The MergePanel pipeline. Blocks come from the parser's region-boundary
// tracking, NOT from re-running LCS over the reconstructed sides.
// The pipeline that powers MergePanel, tested from jj-format conflict markers
// through to final doc strings. This is the SEMANTIC test: "does clicking the
// → arrow actually produce ours?" — proved by pure-function composition.
describe('merge pipeline — conflict → diff → take → result', () => {
  // Realistic jj-format conflict fixtures. Each exercises a different parser
  // path (Diff / Snapshot / multi-region / escalated) then flows through the
  // full merge machinery.
  const fixtures = [
    {
      name: 'Diff-style single region',
      raw: [
        'header',
        '<<<<<<< Conflict 1 of 1',
        '%%%%%%% Changes from base to side #1',
        ' ctx',
        '-old',
        '+new',
        '+++++++ Contents of side #2',
        'theirs-side',
        '>>>>>>>',
        'footer',
      ].join('\n'),
    },
    {
      name: 'Snapshot-style single region',
      raw: [
        '<<<<<<<',
        '+++++++ s1',
        'ours-a',
        'ours-b',
        '------- base',
        'base-a',
        '+++++++ s2',
        'theirs-a',
        'theirs-b',
        'theirs-c',
        '>>>>>>>',
      ].join('\n'),
    },
    {
      name: 'Multi-region with shared span between',
      raw: [
        'A',
        '<<<<<<<',
        '+++++++ s1',
        'ours1',
        '+++++++ s2',
        'theirs1',
        '>>>>>>>',
        'B',
        '<<<<<<<',
        '+++++++ s1',
        'ours2',
        '+++++++ s2',
        'theirs2',
        '>>>>>>>',
        'C',
      ].join('\n'),
    },
    {
      name: 'Ours-side is deletion (empty in ours)',
      raw: [
        'pre',
        '<<<<<<<',
        '+++++++ s1',      // ours section is EMPTY — zero lines
        '+++++++ s2',
        'theirs-only',
        '>>>>>>>',
        'post',
      ].join('\n'),
    },
    {
      name: 'Theirs-side is deletion (triggers zero-line round-trip path)',
      raw: [
        'pre',
        '<<<<<<<',
        '+++++++ s1',
        'ours-only',
        '+++++++ s2',      // theirs section is EMPTY
        '>>>>>>>',
        'post',
      ].join('\n'),
    },
    {
      name: 'Blank-line content (the K=1-with-"" case, via parser)',
      raw: [
        'A',
        '<<<<<<<',
        '+++++++ s1',
        '',                 // ours is a single blank line
        '+++++++ s2',
        'X',                // theirs is non-blank
        '>>>>>>>',
        'C',
      ].join('\n'),
    },
    {
      // The 2026-05 blank-line separator gap, as jj would materialize it
      // (\n-terminated marker lines → shared trailing ''): a blank context
      // line, then ours adds 'A', theirs deletes — two blank-adjacent regions.
      name: 'Blank shared context around an insertion and a deletion',
      raw: [
        '',
        '<<<<<<<',
        '+++++++ s1',
        'A',
        '------- base',
        '+++++++ s2',
        '>>>>>>>',
        '',
        '<<<<<<<',
        '+++++++ s1',
        '------- base',
        'gone',
        '+++++++ s2',
        '',
        '>>>>>>>',
        '',
      ].join('\n'),
    },
  ]

  for (const { name, raw } of fixtures) {
    describe(name, () => {
      const sides = reconstructSides(raw)!
      const oursLines = sides.ours.split('\n')
      const theirsLines = sides.theirs.split('\n')
      const blocks = sides.blocks

      it('take-all-ours produces exactly ours', () => {
        expect(takeAll(seed(theirsLines, blocks), 'ours', oursLines, blocks).docStr).toBe(sides.ours)
      })

      it('blocks index the split lines of both sides (initial tracker ranges are in bounds)', () => {
        // Every block's seed range is a valid line range of the theirs doc and
        // its ours range a valid slice of oursLines. This is what MergePanel
        // relies on at seed time — an out-of-range line here would paint /
        // scroll the wrong place at mount.
        for (const b of blocks) {
          const { from, to } = initialTrackPos(b)
          expect(from).toBeGreaterThanOrEqual(1)
          expect(from).toBeLessThanOrEqual(to)
          expect(to).toBeLessThanOrEqual(theirsLines.length + 1)
          expect(b.aFrom).toBeGreaterThanOrEqual(1)
          expect(b.aTo).toBeLessThanOrEqual(oursLines.length + 1)
        }
      })

      if (blocks.length > 0) {
        it('take-ours → take-theirs-back on first block → center unchanged', () => {
          // Round-trip on a single block within a multi-block context.
          // Proves the delta shift keeps other blocks' positions stable.
          const s1 = take(seed(theirsLines, blocks), 0, 'ours', oursLines, blocks)
          expect(take(s1, 0, 'theirs', theirsLines, blocks).docStr).toBe(sides.theirs)
        })
      }
    })
  }
})

describe('initialTrackPos', () => {
  it('is the block\'s theirs line range — the center seeds with theirs', () => {
    expect(initialTrackPos(blk(0, 0, 2, 3))).toEqual({ from: 2, to: 3 })
    expect(initialTrackPos(blk(0, 0, 2, 4))).toEqual({ from: 2, to: 4 })
  })

  it('pure-insertion block (bFrom===bTo): zero-line marker before that line', () => {
    expect(initialTrackPos(blk(2, 3, 2, 2))).toEqual({ from: 2, to: 2 })
  })

  it('block past the last theirs line stays past it (lines+1), no clamping', () => {
    // bFrom beyond the doc happens when theirs is shorter than ours; the
    // marker must mean "append after the last line", not "before it".
    expect(initialTrackPos(blk(3, 4, 3, 3))).toEqual({ from: 3, to: 3 })
  })
})

describe('planTakeBoth — concatenate additive conflicts', () => {
  // Center seeded with theirs. Block at line 2: ours='OURS', theirs='THEIRS'.
  const ours = ['A', 'OURS', 'C']
  const theirs = ['A', 'THEIRS', 'C']
  const centerDoc = 'A\nTHEIRS\nC'
  const tracked = T(2, 3)  // 'THEIRS'
  const block = blk(2, 3, 2, 3)

  it('concatenates ours\\ntheirs, replacing center content', () => {
    const plan = planTakeBoth(doc(centerDoc), tracked, ours, theirs, block)!
    expect(apply(centerDoc, plan.change)).toBe('A\nOURS\nTHEIRS\nC')
    // newTrack covers both lines; one line gained.
    expect(plan.newTrack).toEqual({ from: 2, to: 4 })
    expect(plan.delta).toBe(1)
  })

  it('returns null when already both (idempotent)', () => {
    expect(planTakeBoth(doc(centerDoc), { ...tracked, source: 'both' }, ours, theirs, block)).toBeNull()
  })

  it.each([
    ['ours empty',   blk(2, 2, 2, 3)],
    ['theirs empty', blk(2, 3, 2, 2)],
  ])('returns null when %s — degenerates to regular take', (_, b) => {
    expect(planTakeBoth(doc(centerDoc), tracked, ours, theirs, b)).toBeNull()
  })

  it('multi-line blocks: preserves line order within each side', () => {
    const o = ['A', 'O1', 'O2', 'D']
    const t = ['A', 'T1', 'T2', 'D']
    const plan = planTakeBoth(doc('A\nT1\nT2\nD'), T(2, 4), o, t, blk(2, 4, 2, 4))!
    expect(apply('A\nT1\nT2\nD', plan.change)).toBe('A\nO1\nO2\nT1\nT2\nD')
    expect(plan.newTrack).toEqual({ from: 2, to: 6 })
  })

  it('after take-ours (center owns ours\' lines): still a clean replace', () => {
    const s1 = take(seed(theirs, [block]), 0, 'ours', ours, [block])
    const plan = planTakeBoth(doc(s1.docStr), s1.track[0], ours, theirs, block)!
    expect(apply(s1.docStr, plan.change)).toBe('A\nOURS\nTHEIRS\nC')
  })
})

// ── Property tests (fast-check) ──────────────────────────────────────────────
// Generalize the hand-picked it.each shapes above to hundreds of generated
// ours/theirs pairs. This is the DATA-LOSS path: a separator-math bug in
// planTake silently corrupts the file being resolved, and a parser bug in
// reconstructSides drops a side. Pure functions over strings + @codemirror/state
// — orthogonal to the Bombadil E2E tier, which can't efficiently reach this
// math (it would have to navigate into merge mode, click the exact arrow on the
// exact conflict shape, then visually diff the result). fast-check hits the
// shape in microseconds.
describe('merge-surgery — property sweep (fast-check)', () => {
  // BLANK-INCLUSIVE alphabet. Under the char-offset model this sweep had to be
  // scoped to non-blank content — a blank line was zero-width, so "at a blank
  // line" and "just past it" aliased to one offset and ~3.5% of blank-inclusive
  // shapes lost or misplaced a line (the 2026-05 "planTake blank-line separator
  // gap"). The line-range model makes those distinct values; the sweep now
  // covers blanks anywhere — leading, trailing, runs, blank-only sides.
  //
  // Small alphabet (not fc.string) so LCS finds real common subsequences →
  // diffBlocks emits MULTI-block shapes, not one giant replace. minLength 1
  // mirrors String.split: a side is never a zero-length array in the pipeline
  // ('' is [''] — one blank line; the empty FILE is generated as ['']). The
  // []-vs-[''] distinction lives in conflict REGIONS, exercised by the
  // reconstructSides sweep below where region arrays may be [].
  const line = fc.constantFrom('A', 'B', 'C', 'D', 'X', 'Y', '')
  const lines = fc.array(line, { minLength: 1, maxLength: 8 })
  // A take order: sort keys for up to 8 blocks → a permutation of block indices.
  const orderKeys = fc.array(fc.nat({ max: 99 }), { minLength: 8, maxLength: 8 })
  const orderOf = (n: number, keys: number[]) =>
    Array.from({ length: n }, (_, i) => i).sort((a, b) => keys[a] - keys[b] || a - b)
  // Arbitrary interleaved clicking before the final sweep: (block, side) pairs.
  const clicks = fc.array(fc.tuple(fc.nat({ max: 7 }), fc.constantFrom('ours' as const, 'theirs' as const)), { maxLength: 12 })

  it('take-all-ours on theirs-seed produces EXACTLY ours (diffBlocks blocks, blanks included)', () => {
    fc.assert(fc.property(lines, lines, (ours, theirs) => {
      const blocks = diffBlocks(ours, theirs)
      expect(takeAll(seed(theirs, blocks), 'ours', ours, blocks).docStr).toBe(ours.join('\n'))
    }), { numRuns: 500 })
  })

  it('ours→theirs round-trip is identity — no data loss across a full toggle', () => {
    fc.assert(fc.property(lines, lines, (ours, theirs) => {
      const blocks = diffBlocks(ours, theirs)
      const r1 = takeAll(seed(theirs, blocks), 'ours', ours, blocks)
      expect(r1.docStr).toBe(ours.join('\n'))                                // midpoint = ours
      expect(takeAll(r1, 'theirs', theirs, blocks).docStr).toBe(theirs.join('\n'))  // endpoint = theirs
    }), { numRuns: 500 })
  })

  it('ANY click sequence, then every block taken in ANY order → exactly that side (block 1, then 3, then 2…)', () => {
    // The multi-block tangle: under the char model, blank/empty centers
    // collapsed distinct insert points to one offset and after the first take
    // remap could not separate them. Here: random prior clicks (both sides,
    // repeats, any block), then take-ours over a random PERMUTATION of blocks
    // must give ours; then take-theirs over another permutation gives theirs.
    // Every tracked range must stay a valid line range throughout.
    fc.assert(fc.property(lines, lines, clicks, orderKeys, orderKeys, (ours, theirs, pre, k1, k2) => {
      const blocks = diffBlocks(ours, theirs)
      const n = blocks.length
      let s = seed(theirs, blocks)
      const check = (st: Sim) => {
        const L = doc(st.docStr).lines
        for (const t of st.track) {
          expect(t.from).toBeGreaterThanOrEqual(1)
          expect(t.from).toBeLessThanOrEqual(t.to)
          expect(t.to).toBeLessThanOrEqual(L + 1)
        }
        for (let j = 1; j < st.track.length; j++)  // doc order == index order
          expect(st.track[j].from).toBeGreaterThanOrEqual(st.track[j - 1].to)
      }
      if (n > 0) for (const [i, side] of pre) {
        s = take(s, i % n, side, side === 'ours' ? ours : theirs, blocks)
        check(s)
      }
      s = takeAll(s, 'ours', ours, blocks, orderOf(n, k1))
      check(s)
      expect(s.docStr).toBe(ours.join('\n'))
      s = takeAll(s, 'theirs', theirs, blocks, orderOf(n, k2))
      check(s)
      expect(s.docStr).toBe(theirs.join('\n'))
    }), { numRuns: 500 })
  })

  it('tracked ranges always slice back to exactly the lines they claim to own', () => {
    // After any click sequence, each block's center text == the source lines
    // its tag says it holds — the highlight/counter can't lie about content.
    fc.assert(fc.property(lines, lines, clicks, (ours, theirs, pre) => {
      const blocks = diffBlocks(ours, theirs)
      const n = blocks.length
      let s = seed(theirs, blocks)
      if (n > 0) for (const [i, side] of pre) s = take(s, i % n, side, side === 'ours' ? ours : theirs, blocks)
      const center = s.docStr.split('\n')
      s.track.forEach((t, i) => {
        const b = blocks[i]
        const want = t.source === 'ours' ? ours.slice(b.aFrom - 1, b.aTo - 1) : theirs.slice(b.bFrom - 1, b.bTo - 1)
        expect(center.slice(t.from - 1, t.to - 1)).toEqual(want)
      })
    }), { numRuns: 300 })
  })

  // planTakeBoth inserts a LITERAL '\n' between sides — no positional
  // separator inference at all.
  it('planTakeBoth concatenates ours\\ntheirs for any two non-empty blocks', () => {
    const blkArb = fc.array(line, { minLength: 1, maxLength: 5 })
    fc.assert(fc.property(blkArb, blkArb, (oursBlk, theirsBlk) => {
      const theirsStr = theirsBlk.join('\n')
      const block = blk(1, oursBlk.length + 1, 1, theirsBlk.length + 1)
      const plan = planTakeBoth(doc(theirsStr), T(1, theirsBlk.length + 1), oursBlk, theirsBlk, block)!
      expect(apply(theirsStr, plan.change)).toBe(oursBlk.join('\n') + '\n' + theirsStr)
      // newTrack owns exactly the concatenated lines.
      expect(plan.newTrack).toEqual({ from: 1, to: oursBlk.length + theirsBlk.length + 1 })
    }), { numRuns: 200 })
  })
})

// ── reconstructSides round-trip (fast-check) ─────────────────────────────────
// The prerequisite the backlog flagged: a `serializeJjConflict` inverse so the
// parser can be round-tripped. Builds jj Snapshot-style markers (the simplest
// of jj's styles — explicit ours / base / theirs sections) and asserts the
// parser recovers each side, the base, and one well-formed block. Markers are
// exactly 7 chars and the alphabet has no 7-run lookalikes, so jj's escalation
// path isn't exercised here (that has dedicated example tests above).
describe('reconstructSides — serialize→parse round-trip (fast-check)', () => {
  // Blank-inclusive everywhere, and region arrays may be [] (no minLength):
  // an empty ours REGION next to a blank shared line vs a blank ours REGION
  // with no shared lines is exactly the []-vs-[''] pair that joins to the
  // same string. The end-to-end test below runs planTake over all of it.
  const lineArb = fc.constantFrom('A', 'B', 'C', 'D', 'X', 'Y', '')
  const seqArb = (max: number) => fc.array(lineArb, { maxLength: max })

  // The inverse of reconstructSides for Snapshot style:
  //   <<<<<<<
  //   +++++++ side1   ← ours
  //   ------- base
  //   +++++++ side2   ← theirs
  //   >>>>>>>
  // pre/post are shared context (out-of-region → pushed to all three sides).
  const serialize = (pre: string[], ours: string[], base: string[], theirs: string[], post: string[]) => [
    ...pre,
    '<'.repeat(7),
    '+'.repeat(7) + ' side1',
    ...ours,
    '-'.repeat(7) + ' base',
    ...base,
    '+'.repeat(7) + ' side2',
    ...theirs,
    '>'.repeat(7),
    ...post,
  ].join('\n')

  it('recovers exact ours/theirs/base and one block for any side shapes', () => {
    fc.assert(fc.property(
      seqArb(3), seqArb(4), seqArb(4), seqArb(4), seqArb(3),
      (pre, ours, base, theirs, post) => {
        const sides = reconstructSides(serialize(pre, ours, base, theirs, post))
        expect(sides).not.toBeNull()
        expect(sides!.ours).toBe([...pre, ...ours, ...post].join('\n'))
        expect(sides!.theirs).toBe([...pre, ...theirs, ...post].join('\n'))
        expect(sides!.base).toBe([...pre, ...base, ...post].join('\n'))
        // Split-model invariant: the block indexes side.split('\n'). That is
        // pre.length + region.length + 1 — except a side with ZERO total lines
        // (pre, region, post all empty) is the empty file = [''], one blank
        // line, which the block must own ([1,2)) or nobody does.
        const end = (region: string[]) =>
          pre.length + region.length + post.length === 0 ? 2 : pre.length + region.length + 1
        expect(sides!.blocks).toEqual([{
          aFrom: pre.length + 1, aTo: end(ours),
          bFrom: pre.length + 1, bTo: end(theirs),
        }])
        expect(sides!.blocks[0].aTo).toBeLessThanOrEqual(sides!.ours.split('\n').length + 1)
        expect(sides!.blocks[0].bTo).toBeLessThanOrEqual(sides!.theirs.split('\n').length + 1)
      },
    ), { numRuns: 300 })
  })

  it('end-to-end: serialize → reconstruct → take-all-ours = ours → take-all-theirs = theirs (MergePanel pipeline, blanks + empty regions)', () => {
    const eq = (a: string[], b: string[]) => JSON.stringify(a) === JSON.stringify(b)
    fc.assert(fc.property(
      seqArb(3), seqArb(4), seqArb(4), seqArb(4), seqArb(3),
      (pre, ours, base, theirs, post) => {
        // jj only emits a conflict region when both sides diverge from base AND
        // from each other — identical or unchanged sides auto-resolve, so those
        // marker shapes never reach the parser. Restricting to real conflicts.
        fc.pre(!eq(ours, base) && !eq(theirs, base) && !eq(ours, theirs))
        const sides = reconstructSides(serialize(pre, ours, base, theirs, post))!
        const oursLines = sides.ours.split('\n')
        const theirsLines = sides.theirs.split('\n')
        // Replay every ours-arrow over the theirs-seed using the PARSER's blocks
        // (region boundaries, not LCS) — must reproduce ours exactly; then
        // every theirs-arrow must bring theirs back.
        const s1 = takeAll(seed(theirsLines, sides.blocks), 'ours', oursLines, sides.blocks)
        expect(s1.docStr).toBe(sides.ours)
        expect(takeAll(s1, 'theirs', theirsLines, sides.blocks).docStr).toBe(sides.theirs)
      },
    ), { numRuns: 500 })
  })

  // The MINIMAL repro of the 2026-05 blank-line separator gap, kept as a named
  // regression now that it holds (it was pinned as KNOWN-WRONG under the char
  // model — the divergence.test.ts "merge-parent gap" pattern). A real
  // modify/delete conflict with a leading blank context line — base has a
  // blank, ours changes it to 'A', theirs deletes it. The center seeds to ""
  // (ONE shared blank line) and take-ours must KEEP that blank: "\nA". The
  // char model produced "A" — "".length===0 read as "zero lines".
  it('blank-line separator regression: take-ours keeps the shared blank line ("\\nA", not "A")', () => {
    const sides = reconstructSides(serialize([''], ['A'], [''], [], []))!
    expect(sides.ours).toBe('\nA')   // the CORRECT take-all-ours result
    expect(sides.theirs).toBe('')    // center = one shared blank line
    expect(sides.blocks).toEqual([{ aFrom: 2, aTo: 3, bFrom: 2, bTo: 2 }])

    const oursLines = sides.ours.split('\n')
    const theirsLines = sides.theirs.split('\n')
    const s0 = seed(theirsLines, sides.blocks)
    const plan = planTake(doc(s0.docStr), s0.track[0], 'ours', oursLines, sides.blocks[0])!
    expect(plan.change).toEqual({ from: 0, to: 0, insert: '\nA' })
    const s1 = take(s0, 0, 'ours', oursLines, sides.blocks)
    expect(s1.docStr).toBe(sides.ours)
    // …and toggles back without leaving the separator behind.
    expect(take(s1, 0, 'theirs', theirsLines, sides.blocks).docStr).toBe(sides.theirs)
  })

  it('its []-vs-[\'\'] twin: same strings, different REGION → block owns the blank → bare "A"', () => {
    // ours REGION ['A'] vs theirs REGION [] with NO shared lines: theirs is
    // the empty file. Identical sides.theirs ("") and identical one-line
    // insert as above — only the block range differs ([1,2)×[1,2): the blank
    // is theirs' block content, per conflict-extract's split-model rule), and
    // that is what selects replace ("A") over append ("\nA").
    const sides = reconstructSides(serialize([], ['A'], ['B'], [], []))!
    expect(sides.theirs).toBe('')
    expect(sides.ours).toBe('A')
    expect(sides.blocks).toEqual([{ aFrom: 1, aTo: 2, bFrom: 1, bTo: 2 }])
    const s1 = take(seed([''], sides.blocks), 0, 'ours', ['A'], sides.blocks)
    expect(s1.docStr).toBe('A')
    expect(take(s1, 0, 'theirs', [''], sides.blocks).docStr).toBe('')
  })
})
