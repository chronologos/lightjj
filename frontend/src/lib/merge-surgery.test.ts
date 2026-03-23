import { describe, it, expect } from 'vitest'
import { Text, ChangeSet } from '@codemirror/state'
import { planTake, planTakeBoth, remapBlock, initialTrackPos, type TrackedBlock } from './merge-surgery'
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

describe('planTake — idempotence', () => {
  it('returns null when tracked.source already matches side', () => {
    const tracked: TrackedBlock = { from: 0, to: 3, source: 'ours' }
    expect(planTake(doc('abc'), tracked, 'ours', ['abc'], blk(1, 2, 1, 2))).toBeNull()
  })

  it('does NOT null-return on source=mixed even if content happens to match', () => {
    // User hand-edited center to exactly ours' content. source=mixed means
    // "we don't know", so arrow should still fire (it'll be a no-op textually
    // but WILL flip the highlight back to ours, which is desirable feedback).
    const tracked: TrackedBlock = { from: 0, to: 3, source: 'mixed' }
    expect(planTake(doc('abc'), tracked, 'ours', ['abc'], blk(1, 2, 1, 2))).not.toBeNull()
  })

  it('source=mixed with drifted positions: produces valid change within doc bounds', () => {
    // Realistic sequence: user types INSIDE a block → transactionExtender marks
    // it 'mixed' → remapBlock shifts from/to → user clicks → arrow. planTake
    // must produce a valid change even when the tracked range no longer aligns
    // to line boundaries (the normal ours/theirs take paths assume clean
    // line positions from initialTrackPos, but mixed can have arbitrary drift).
    //
    // Seed: tracked was [2,5] ("XXX") in "A\nXXX\nC". User types "y" at pos 4
    // → doc="A\nXXyX\nC", remapBlock gives [2,6] (to shifted by +1).
    // Now take ours="OURS": replaces [2,6] (drifted, crosses the 'y') with
    // "OURS". Not a clean line anymore but the change spec must be valid.
    const d = doc('A\nXXyX\nC')
    const tracked: TrackedBlock = { from: 2, to: 6, source: 'mixed' }
    const plan = planTake(d, tracked, 'ours', ['A', 'OURS', 'C'], blk(2, 3, 2, 3))!
    // from!==to and srcEmpty=false → neither separator branch fires →
    // straight replace of [2,6] with "OURS". The drifted range is replaced
    // wholesale. newTrack correctly covers the inserted content.
    expect(plan.change).toEqual({ from: 2, to: 6, insert: 'OURS' })
    expect(apply('A\nXXyX\nC', plan.change)).toBe('A\nOURS\nC')
    expect(plan.newTrack).toEqual({ from: 2, to: 6 })
    // Bounds: change stays within doc, newTrack within new-doc.
    expect(plan.change.from).toBeGreaterThanOrEqual(0)
    expect(plan.change.to).toBeLessThanOrEqual(d.length)
  })
})

describe('planTake — zero-width position (from === to)', () => {
  // These are the 90d818ca fix shapes. Center already had something deleted
  // (prior take of the empty side), now taking back non-empty content.

  it('at line-start mid-doc: trailing \\n separator pushes following line down', () => {
    // Doc: "AAA\nCCC", zero-width at pos 4 (start of line 2 "CCC").
    // Taking ours="BBB" should produce "AAA\nBBB\nCCC".
    const d = doc('AAA\nCCC')
    const tracked: TrackedBlock = { from: 4, to: 4, source: 'theirs' }
    const plan = planTake(d, tracked, 'ours', ['AAA', 'BBB', 'CCC'], blk(2, 3, 2, 2))!
    expect(plan.change.insert).toBe('BBB\n')  // trailing \n separator
    expect(apply('AAA\nCCC', plan.change)).toBe('AAA\nBBB\nCCC')
    // newTrack: the content is "BBB" (3 chars) starting at 4 → [4, 7).
    // The trailing \n separator is excluded.
    expect(plan.newTrack).toEqual({ from: 4, to: 7 })
  })

  it('at end-of-doc (no trailing \\n): LEADING \\n separator, contentOff=1', () => {
    // Doc: "AAA\nBBB", zero-width at pos 7 (after "BBB", end of doc).
    // Taking ours="CCC" should produce "AAA\nBBB\nCCC".
    const d = doc('AAA\nBBB')
    const tracked: TrackedBlock = { from: 7, to: 7, source: 'theirs' }
    const plan = planTake(d, tracked, 'ours', ['AAA', 'BBB', 'CCC'], blk(3, 4, 3, 3))!
    expect(plan.change.insert).toBe('\nCCC')  // leading \n separator
    expect(apply('AAA\nBBB', plan.change)).toBe('AAA\nBBB\nCCC')
    // newTrack excludes the leading \n: content starts at change.from + 1.
    expect(plan.newTrack).toEqual({ from: 8, to: 11 })
  })

  it('on empty line mid-doc (theirs IS empty string): insert AS-IS replaces it', () => {
    // theirs=['AAA','','CCC'] (blank middle), ours=['AAA','BBB','CCC']. Center
    // seeded theirs → "AAA\n\nCCC". Block bFrom=2,bTo=3 (theirs HAS a line,
    // the empty string) — oppEmpty=false → the empty line IS block content.
    // Insert as-is fills it: "AAA\nBBB\nCCC". No separator, no extension.
    //
    // 90d818ca's fix#9 (to+=1) over-corrected (ate the next-line's separator
    // → "AAA\nBBBCCC"). Trailing-\n would leave a phantom blank
    // ("AAA\nBBB\n\nCCC"). The !oppEmpty gate prevents the latter; the
    // insert-as-is prevents the former.
    const d = doc('AAA\n\nCCC')
    const tracked: TrackedBlock = { from: 4, to: 4, source: 'theirs' }
    const plan = planTake(d, tracked, 'ours', ['AAA', 'BBB', 'CCC'], blk(2, 3, 2, 3))!
    expect(plan.change).toEqual({ from: 4, to: 4, insert: 'BBB' })  // NO extension
    expect(apply('AAA\n\nCCC', plan.change)).toBe('AAA\nBBB\nCCC')
    expect(plan.newTrack).toEqual({ from: 4, to: 7 })
  })

  it('at empty line when oppEmpty=true (pure insertion): trailing \\n — shared content, do NOT replace', () => {
    // theirs=['AAA','','CCC'] (shared blank at line 2). ours=['AAA','X','','CCC']
    // (extra 'X' at line 2, pushes blank to line 3). Block: ours[2]='X' vs
    // theirs[nothing] at bFrom=2 → bFrom===bTo=2 → oppEmpty=true. Center seeded
    // theirs → "AAA\n\nCCC". initialTrackPos lands at bFrom=2 → line(2).from=4
    // = the SHARED blank's position. Insert must go BEFORE it with trailing \n
    // → "AAA\nX\n\nCCC". Previously the empty-line branch replaced the shared
    // blank → "AAA\nX\nCCC" (lost the blank).
    const d = doc('AAA\n\nCCC')
    const tracked: TrackedBlock = { from: 4, to: 4, source: 'theirs' }
    const plan = planTake(d, tracked, 'ours', ['AAA', 'X', '', 'CCC'], blk(2, 3, 2, 2))!
    expect(plan.change).toEqual({ from: 4, to: 4, insert: 'X\n' })  // trailing \n
    expect(apply('AAA\n\nCCC', plan.change)).toBe('AAA\nX\n\nCCC')
    expect(plan.newTrack).toEqual({ from: 4, to: 5 })
  })

  it('on empty doc: insert as-is, no separator, no \\n consumption', () => {
    // Doc: "" (0 length). Zero-width at pos 0. Taking ours="X".
    // line.from===line.to===0, but from < doc.length is FALSE (0 < 0) so
    // no to-extension. Insert as-is.
    const d = doc('')
    const tracked: TrackedBlock = { from: 0, to: 0, source: 'theirs' }
    const plan = planTake(d, tracked, 'ours', ['X'], blk(1, 2, 1, 1))!
    expect(plan.change).toEqual({ from: 0, to: 0, insert: 'X' })
    expect(apply('', plan.change)).toBe('X')
    expect(plan.newTrack).toEqual({ from: 0, to: 1 })
  })

  // An empty line tracks as zero-width (line.from === line.to). Previously the
  // from===to gate swallowed srcEmpty before the \n-consumption branch could
  // fire → zero-width no-op → arrow click silently did nothing. The reorder
  // (srcEmpty checked first) makes this reach the \n consumer.
  it('srcEmpty + tracked empty-line (from===to): consumes adjacent \\n — the 2026-03-18 no-op bug', () => {
    // theirs = ['A', '', 'B'] (blank middle). ours = ['A', 'B'] (deleted).
    // Center seeded theirs → "A\n\nB". Line 2 empty → tracked {from:2, to:2}.
    // Take ours: delete the empty line → "A\nB".
    const d = doc('A\n\nB')
    const tracked: TrackedBlock = { from: 2, to: 2, source: 'theirs' }
    const plan = planTake(d, tracked, 'ours', ['A', 'B'], blk(2, 2, 2, 3))!
    expect(plan.change.insert).toBe('')
    expect(apply('A\n\nB', plan.change)).toBe('A\nB')
    expect(plan.newTrack.from).toBe(plan.newTrack.to)  // zero-width after delete
  })

  it('srcEmpty + tracked empty-line at end-of-doc: consumes LEADING \\n', () => {
    // theirs = ['A', ''] (trailing blank). ours = ['A']. Center "A\n".
    // Line 2 empty at pos 2 (from=to=2). No trailing \n (end of doc) →
    // consume leading \n at pos 1 → "A".
    const d = doc('A\n')
    const tracked: TrackedBlock = { from: 2, to: 2, source: 'theirs' }
    const plan = planTake(d, tracked, 'ours', ['A'], blk(2, 2, 2, 3))!
    expect(apply('A\n', plan.change)).toBe('A')
  })
})

describe('planTake — srcEmpty (deletion of non-empty center region)', () => {
  // Source side has zero lines for this block (aFrom===aTo). Center still has
  // content from the other side. Delete it, consuming adjacent \n.

  it('consumes trailing \\n when available', () => {
    // Doc: "AAA\nBBB\nCCC", tracked [4,7] (line 2 "BBB"). Ours is empty.
    // Should produce "AAA\nCCC" — delete "BBB" AND its trailing \n.
    const d = doc('AAA\nBBB\nCCC')
    const tracked: TrackedBlock = { from: 4, to: 7, source: 'theirs' }
    const plan = planTake(d, tracked, 'ours', ['AAA', 'CCC'], blk(2, 2, 2, 3))!
    expect(plan.change).toEqual({ from: 4, to: 8, insert: '' })  // to extended 7→8
    expect(apply('AAA\nBBB\nCCC', plan.change)).toBe('AAA\nCCC')
    expect(plan.newTrack).toEqual({ from: 4, to: 4 })  // zero-width after delete
  })

  it('consumes LEADING \\n when at end-of-doc (no trailing \\n)', () => {
    // Doc: "AAA\nBBB", tracked [4,7] (line 2). Ours is empty.
    // No trailing \n at pos 7 (end of doc). Consume leading \n at pos 3 instead.
    // Otherwise: "AAA\n" (phantom trailing \n).
    const d = doc('AAA\nBBB')
    const tracked: TrackedBlock = { from: 4, to: 7, source: 'theirs' }
    const plan = planTake(d, tracked, 'ours', ['AAA'], blk(2, 2, 2, 3))!
    expect(plan.change).toEqual({ from: 3, to: 7, insert: '' })  // from extended 4→3
    expect(apply('AAA\nBBB', plan.change)).toBe('AAA')
    expect(plan.newTrack).toEqual({ from: 3, to: 3 })
  })

  it('`to` drifted mid-line: trailing-\\n check fails, leading-\\n fallback fires', () => {
    // User typed at exact end-of-block → mapPos(to, -1) stuck left of insert
    // → `to` sits mid-line. doc[to]='X' ≠ '\n' → trailing extension skipped.
    // doc[from-1]='\n' → leading consumed. Result is degraded (the 'X' orphans
    // onto the previous line) but not corrupting — nothing outside [from-1, to)
    // is touched. In practice the transactionExtender already marked this
    // block 'mixed' so the user has visual feedback it's hand-edited.
    const d = doc('AAA\nBBBX\nCCC')
    const tracked: TrackedBlock = { from: 4, to: 7, source: 'theirs' }
    const plan = planTake(d, tracked, 'ours', ['AAA', 'CCC'], blk(2, 2, 2, 3))!
    expect(plan.change.from).toBe(3)  // leading \n consumed (trailing check failed)
    expect(plan.change.to).toBe(7)    // NOT extended (doc[7]='X' not '\n')
    expect(apply('AAA\nBBBX\nCCC', plan.change)).toBe('AAAX\nCCC')
  })

  it('consumes nothing when neither adjacent char is \\n', () => {
    // Both `from` and `to` drifted mid-line (extreme hand-editing). No
    // extension. The deletion leaves a mess but doesn't corrupt BEYOND
    // the tracked range.
    const d = doc('AAABBBCCC')
    const tracked: TrackedBlock = { from: 3, to: 6, source: 'theirs' }  // "BBB"
    const plan = planTake(d, tracked, 'ours', [], blk(1, 1, 1, 2))!
    expect(plan.change).toEqual({ from: 3, to: 6, insert: '' })  // no extension
    expect(apply('AAABBBCCC', plan.change)).toBe('AAACCC')
  })
})

describe('planTake — content correctness', () => {
  it('blank-line content is preserved (srcEmpty vs !insert distinction)', () => {
    // The original `!insert` bug: [''].join('\n') === '' (falsy), but from1!==to1
    // so srcEmpty is FALSE — this IS content (one blank line). Must be preserved.
    // Ours = ['AAA', '', 'CCC'] (blank middle). Block covers line 2.
    const d = doc('AAA\nXXX\nCCC')
    const tracked: TrackedBlock = { from: 4, to: 7, source: 'theirs' }
    const plan = planTake(d, tracked, 'ours', ['AAA', '', 'CCC'], blk(2, 3, 2, 3))!
    expect(plan.change.insert).toBe('')  // single blank line's content is ''
    expect(apply('AAA\nXXX\nCCC', plan.change)).toBe('AAA\n\nCCC')
    // newTrack is [4,4] — zero-width, correct for a blank line. NOT [4,7].
    expect(plan.newTrack).toEqual({ from: 4, to: 4 })
  })

  it('multi-line insert joined with \\n', () => {
    const d = doc('A\nX\nD')
    const tracked: TrackedBlock = { from: 2, to: 3, source: 'theirs' }
    const plan = planTake(d, tracked, 'ours', ['A', 'B', 'C', 'D'], blk(2, 4, 2, 3))!
    expect(plan.change.insert).toBe('B\nC')
    expect(apply('A\nX\nD', plan.change)).toBe('A\nB\nC\nD')
    expect(plan.newTrack).toEqual({ from: 2, to: 5 })  // "B\nC" is 3 chars
  })

  it('takes from `theirs` side when side=theirs (reads bFrom/bTo)', () => {
    // Previously took ours. Now take theirs back. Block.bFrom/bTo index theirs.
    const theirsLines = ['A', 'THEIRS', 'D']
    const d = doc('A\nOURS\nD')
    const tracked: TrackedBlock = { from: 2, to: 6, source: 'ours' }
    const plan = planTake(d, tracked, 'theirs', theirsLines, blk(2, 3, 2, 3))!
    expect(plan.change.insert).toBe('THEIRS')
    expect(apply('A\nOURS\nD', plan.change)).toBe('A\nTHEIRS\nD')
  })

  it('newTrack.from excludes leading \\n separator (sourceHighlight boundary)', () => {
    // This is the sourceHighlight bug: if newFrom included the leading \n,
    // the highlight would decorate the PRECEDING line (lineAt(newFrom) when
    // newFrom sits at end of previous line).
    const d = doc('AAA\nBBB')
    const tracked: TrackedBlock = { from: 7, to: 7, source: 'theirs' }
    const plan = planTake(d, tracked, 'ours', ['AAA', 'BBB', 'CCC'], blk(3, 4, 3, 3))!
    // insert is "\nCCC", change.from=7. But content starts at 8.
    expect(plan.change.from).toBe(7)
    expect(plan.newTrack.from).toBe(8)  // NOT 7
    // Verify: in the new doc, lineAt(8) is "CCC", lineAt(7) would be "BBB".
    const newDoc = doc(apply('AAA\nBBB', plan.change))
    expect(newDoc.lineAt(plan.newTrack.from).text).toBe('CCC')
  })
})

describe('planTake — round-trip (take-ours → take-theirs = identity)', () => {
  // Semantic property: for any block, starting from theirs (seed), take ours,
  // then take theirs back → should produce theirs again EXACTLY. This composes
  // planTake + apply + manual remap and proves the surgery is reversible.

  const roundTrip = (theirsStr: string, oursLines: string[], theirsLines: string[], b: ChangeBlock) => {
    // Step 1: seed = theirs, tracked at initial position
    let docStr = theirsStr
    let d = doc(docStr)
    const initPos = initialTrackPos(d, b)
    let tracked: TrackedBlock = { ...initPos, source: 'theirs' }

    // Step 2: take ours
    const plan1 = planTake(d, tracked, 'ours', oursLines, b)!
    docStr = apply(docStr, plan1.change)
    d = doc(docStr)
    tracked = { ...plan1.newTrack, source: 'ours' }

    // Step 3: take theirs back
    const plan2 = planTake(d, tracked, 'theirs', theirsLines, b)!
    docStr = apply(docStr, plan2.change)

    return { docStr, newTrack: plan2.newTrack }
  }

  it('simple mid-doc replacement: round-trip is identity', () => {
    const ours = ['A', 'OURS', 'C']
    const theirs = ['A', 'THEIRS', 'C']
    const { docStr } = roundTrip('A\nTHEIRS\nC', ours, theirs, blk(2, 3, 2, 3))
    expect(docStr).toBe('A\nTHEIRS\nC')
  })

  it('ours-empty (deletion) → theirs-back (restoration): round-trip identity', () => {
    // Ours deleted line 2. Theirs has it. Take-ours removes, take-theirs-back
    // restores.
    const ours = ['A', 'C']
    const theirs = ['A', 'B', 'C']
    const { docStr } = roundTrip('A\nB\nC', ours, theirs, blk(2, 2, 2, 3))
    expect(docStr).toBe('A\nB\nC')
  })

  it('theirs-empty → ours inserts → theirs-back deletes: identity', () => {
    const ours = ['A', 'B', 'C']
    const theirs = ['A', 'C']
    const { docStr } = roundTrip('A\nC', ours, theirs, blk(2, 3, 2, 2))
    expect(docStr).toBe('A\nC')
  })

  it('end-of-doc block: identity through leading-\\n separator branch', () => {
    const ours = ['A', 'B', 'OURS']
    const theirs = ['A', 'B']
    const { docStr } = roundTrip('A\nB', ours, theirs, blk(3, 4, 3, 3))
    expect(docStr).toBe('A\nB')
  })

  it('blank-line content: identity (the srcEmpty vs !insert case)', () => {
    // Ours line 2 is blank. Theirs line 2 is "X". Round-trip.
    const ours = ['A', '', 'C']
    const theirs = ['A', 'X', 'C']
    const { docStr } = roundTrip('A\nX\nC', ours, theirs, blk(2, 3, 2, 3))
    expect(docStr).toBe('A\nX\nC')
  })

  it('empty-line DELETE → restore: identity (the srcEmpty+zero-width reorder)', () => {
    // Theirs has blank middle. Ours deleted it. Take-ours removes the blank
    // line; take-theirs-back restores it. Previously step 1 was a no-op
    // (from===to gate swallowed srcEmpty) so step 2's idempotence check
    // returned null — the arrow click did nothing, silently.
    const ours = ['A', 'C']
    const theirs = ['A', '', 'C']
    const { docStr } = roundTrip('A\n\nC', ours, theirs, blk(2, 2, 2, 3))
    expect(docStr).toBe('A\n\nC')
  })
})

// Full-pipeline round-trip: reconstructSides → diffBlocks → planTake × all
// blocks → take-ours-then-theirs-back = identity. This composes every layer
// the 3-pane merge editor depends on. Covers shapes the single-block
// roundTrip above misses (adjacent blocks, crossing diffs, empty-line runs).
describe('planTake — full-pipeline round-trip (every block ours→theirs = identity)', () => {
  // Apply ALL blocks take-ours, then ALL blocks take-theirs-back. Position
  // remapping via remapBlock between each dispatch. This is what MergePanel
  // does when the user clicks every ← arrow then every → arrow.
  const fullRoundTrip = (oursLines: string[], theirsLines: string[]) => {
    const blocks = diffBlocks(oursLines, theirsLines)
    let docStr = theirsLines.join('\n')
    let d = doc(docStr)
    type Tracked = { from: number; to: number; source: 'ours' | 'theirs' }
    let tracked: Tracked[] = blocks.map(b => ({ ...initialTrackPos(d, b), source: 'theirs' }))

    const takeAll = (side: 'ours' | 'theirs', srcLines: string[]) => {
      for (let i = 0; i < blocks.length; i++) {
        const plan = planTake(d, tracked[i], side, srcLines, blocks[i])
        if (!plan) continue  // idempotent skip
        docStr = apply(docStr, plan.change)
        d = doc(docStr)
        // Remap all OTHER tracked positions through this change (blockTracker's
        // update() does this via remapBlock). The just-applied block gets the
        // explicit newTrack from planTake.
        const changes = ChangeSet.of(plan.change, d.length - plan.change.insert.length + (plan.change.to - plan.change.from))
        tracked = tracked.map((t, j) => j === i
          ? { ...plan.newTrack, source: side }
          : { ...remapBlock(t, changes), source: t.source })
      }
    }

    takeAll('ours', oursLines)
    takeAll('theirs', theirsLines)
    return docStr
  }

  it.each([
    // Simple replace
    [['A', 'OURS', 'C'], ['A', 'THEIRS', 'C']],
    // Adjacent non-overlapping blocks (common: import reorder)
    [['A', 'X', 'B', 'Y', 'C'], ['A', 'P', 'B', 'Q', 'C']],
    // Empty-line: ours deleted, theirs keeps (the srcEmpty+zero-width case)
    [['A', 'C'], ['A', '', 'C']],
    // Mirror: theirs deleted, ours keeps
    [['A', '', 'C'], ['A', 'C']],
    // Trailing empty line
    [['A'], ['A', '']],
    [['A', ''], ['A']],
    // Multiple adjacent empty-line operations
    [['A', '', '', 'C'], ['A', '', 'C']],
  ])('ours=%j theirs=%j → round-trip identity', (oursLines, theirsLines) => {
    expect(fullRoundTrip(oursLines, theirsLines)).toBe(theirsLines.join('\n'))
  })
})

describe('remapBlock', () => {
  // ChangeSet.of({from, to, insert}, docLength) — CM6's pure change spec.
  // No EditorView needed.

  const cs = (from: number, to: number, insert: string, docLen: number) =>
    ChangeSet.of({ from, to, insert }, docLen)

  it('edit BEFORE block: both endpoints shift by delta', () => {
    // Insert 2 chars at pos 0. Block at [10,20) shifts to [12,22).
    const r = remapBlock({ from: 10, to: 20 }, cs(0, 0, 'XX', 30))
    expect(r).toEqual({ from: 12, to: 22 })
  })

  it('edit AFTER block: unchanged', () => {
    const r = remapBlock({ from: 10, to: 20 }, cs(25, 25, 'XX', 30))
    expect(r).toEqual({ from: 10, to: 20 })
  })

  it('edit INSIDE block: from anchors left (assoc=1 outside edit), to shifts', () => {
    // Replace [12,15) with "X" (net -2). from=10 is before → unchanged.
    // to=20 is after → shifts by -2 to 18.
    const r = remapBlock({ from: 10, to: 20 }, cs(12, 15, 'X', 30))
    expect(r).toEqual({ from: 10, to: 18 })
  })

  it('whole-block select-and-type: inversion → re-map with flipped assoc → SPANS insert', () => {
    // 90d818ca fix #6. Block at [10,20). Replace [10,20) with "NEW" (3 chars).
    // Normal mapPos: from(assoc=1) → 13 (past insert), to(assoc=-1) → 10 (before).
    // from > to → inversion → re-map: from(assoc=-1) → 10, to(assoc=1) → 13.
    // Range SPANS the inserted text.
    const r = remapBlock({ from: 10, to: 20 }, cs(10, 20, 'NEW', 30))
    expect(r).toEqual({ from: 10, to: 13 })
  })

  it('partial-overlap replace at from: no inversion (assoc=1 handles it)', () => {
    // Replace [8,12) with "X". block.from=10 is inside change range.
    // mapPos(10, assoc=1): 10 is inside deleted [8,12) → maps to end of insert = 9.
    // mapPos(20, assoc=-1): 20 is after → shifts by 1-4=-3 → 17.
    // 9 <= 17 → no inversion.
    const r = remapBlock({ from: 10, to: 20 }, cs(8, 12, 'X', 30))
    expect(r).toEqual({ from: 9, to: 17 })
  })

  it('zero-width block (prior deletion): insert at exactly that position', () => {
    // block.from === block.to === 10. Insert "XX" at 10.
    // from(assoc=1) → 12 (past insert). to(assoc=-1) → 10 (before).
    // 12 > 10 → inversion → flip: from(assoc=-1) → 10, to(assoc=1) → 12.
    // The zero-width marker now spans the insertion — correct, it's "grown"
    // to cover what the user typed into it.
    const r = remapBlock({ from: 10, to: 10 }, cs(10, 10, 'XX', 30))
    expect(r).toEqual({ from: 10, to: 12 })
  })

  it('no changes: identity', () => {
    const empty = ChangeSet.empty(30)
    expect(remapBlock({ from: 10, to: 20 }, empty)).toEqual({ from: 10, to: 20 })
  })
})

// --- End-to-end: conflict-extract → diffBlocks → planTake → apply ---
// The pipeline that powers MergePanel, tested from jj-format conflict markers
// through to final doc strings. This is the SEMANTIC test: "does clicking the
// → arrow actually produce ours?" — proved by pure-function composition.
describe('merge pipeline — conflict → diff → take → result', () => {
  // Take ALL ours-arrows in forward order. Uses remapBlock to update later
  // block positions after each take — the same mechanism blockTracker uses.
  function takeAllOurs(theirsStr: string, oursLines: string[], blocks: ChangeBlock[]): string {
    let docStr = theirsStr
    let track: TrackedBlock[] = blocks.map(b => ({
      ...initialTrackPos(doc(docStr), b),
      source: 'theirs',
    }))
    for (let i = 0; i < blocks.length; i++) {
      const plan = planTake(doc(docStr), track[i], 'ours', oursLines, blocks[i])!
      const cs = ChangeSet.of(plan.change, docStr.length)
      docStr = apply(docStr, plan.change)
      // Update this block from the plan's newTrack; remap later blocks.
      track[i] = { ...plan.newTrack, source: 'ours' }
      for (let j = i + 1; j < track.length; j++) {
        track[j] = { ...track[j], ...remapBlock(track[j], cs) }
      }
    }
    return docStr
  }

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
      name: 'Theirs-side is deletion (triggers zero-width round-trip path)',
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
      name: 'Blank-line content (the srcEmpty vs !insert case, via parser)',
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
  ]

  for (const { name, raw } of fixtures) {
    describe(name, () => {
      const sides = reconstructSides(raw)!
      const oursLines = sides.ours.split('\n')
      const theirsLines = sides.theirs.split('\n')
      const blocks = diffBlocks(oursLines, theirsLines)

      it('take-all-ours produces exactly ours', () => {
        const result = takeAllOurs(sides.theirs, oursLines, blocks)
        expect(result).toBe(sides.ours)
      })

      it('initialTrackPos yields valid bounds for all blocks', () => {
        // Every block's tracked position is within doc bounds and non-inverted.
        // This is what MergePanel relies on at seed time — an out-of-bounds
        // position here would crash sourceHighlight's lineAt() at mount.
        const d = doc(sides.theirs)
        for (const b of blocks) {
          const { from, to } = initialTrackPos(d, b)
          expect(from).toBeGreaterThanOrEqual(0)
          expect(to).toBeLessThanOrEqual(d.length)
          expect(from).toBeLessThanOrEqual(to)
        }
      })

      if (blocks.length > 0) {
        it('take-ours → take-theirs-back on first block → center unchanged', () => {
          // Round-trip on a single block within a multi-block context.
          // Proves remapBlock keeps other blocks' positions stable.
          let docStr = sides.theirs
          let track: TrackedBlock[] = blocks.map(b => ({
            ...initialTrackPos(doc(docStr), b),
            source: 'theirs' as const,
          }))

          // Take ours for block 0
          let plan = planTake(doc(docStr), track[0], 'ours', oursLines, blocks[0])!
          let cs = ChangeSet.of(plan.change, docStr.length)
          docStr = apply(docStr, plan.change)
          track[0] = { ...plan.newTrack, source: 'ours' }
          for (let j = 1; j < track.length; j++) {
            track[j] = { ...track[j], ...remapBlock(track[j], cs) }
          }

          // Take theirs back for block 0
          plan = planTake(doc(docStr), track[0], 'theirs', theirsLines, blocks[0])!
          docStr = apply(docStr, plan.change)

          expect(docStr).toBe(sides.theirs)
        })
      }
    })
  }
})

describe('initialTrackPos', () => {
  it('mid-doc block: from=line-start, to=line-end', () => {
    const d = doc('A\nBB\nCCC')
    // Block covers line 2 (bFrom=2, bTo=3 half-open). Line 2 is "BB", pos [2,4).
    const r = initialTrackPos(d, blk(0, 0, 2, 3))
    expect(r).toEqual({ from: 2, to: 4 })
    expect(d.sliceString(r.from, r.to)).toBe('BB')
  })

  it('multi-line block: from=first-line-start, to=last-line-end', () => {
    const d = doc('A\nBB\nCCC\nD')
    const r = initialTrackPos(d, blk(0, 0, 2, 4))  // lines 2-3
    expect(r).toEqual({ from: 2, to: 8 })
    expect(d.sliceString(r.from, r.to)).toBe('BB\nCCC')
  })

  it('pure-insertion block (bFrom===bTo): zero-width at line-start', () => {
    // Block where theirs has nothing (ours-only insertion). Zero-width marker
    // at where the insertion WOULD go (bFrom's line-start).
    const d = doc('A\nB\nC')
    const r = initialTrackPos(d, blk(2, 3, 2, 2))
    expect(r).toEqual({ from: 2, to: 2 })  // zero-width at line 2's start
  })

  it('block past last line: zero-width at doc.length', () => {
    // bFrom beyond doc.lines. Happens if theirs is shorter than ours.
    const d = doc('A\nB')
    const r = initialTrackPos(d, blk(3, 4, 3, 3))  // line 3 doesn't exist
    expect(r).toEqual({ from: 3, to: 3 })  // doc.length = 3 ("A\nB")
  })

  it('first-line block: from=0', () => {
    const d = doc('AAA\nBBB')
    const r = initialTrackPos(d, blk(0, 0, 1, 2))
    expect(r).toEqual({ from: 0, to: 3 })
  })
})

describe('planTakeBoth — concatenate additive conflicts', () => {
  // Center seeded with theirs. Block at line 2: ours='OURS', theirs='THEIRS'.
  const ours = ['A', 'OURS', 'C']
  const theirs = ['A', 'THEIRS', 'C']
  const centerDoc = 'A\nTHEIRS\nC'
  const tracked: TrackedBlock = { from: 2, to: 8, source: 'theirs' }  // 'THEIRS'
  const block = blk(2, 3, 2, 3)

  it('concatenates ours\\ntheirs, replacing center content', () => {
    const plan = planTakeBoth(tracked, ours, theirs, block)!
    expect(apply(centerDoc, plan.change)).toBe('A\nOURS\nTHEIRS\nC')
    // newTrack covers the full concatenation.
    expect(plan.newTrack).toEqual({ from: 2, to: 13 })  // 'OURS\nTHEIRS'.length = 11
  })

  it('returns null when already both (idempotent)', () => {
    expect(planTakeBoth({ ...tracked, source: 'both' }, ours, theirs, block)).toBeNull()
  })

  it.each([
    ['ours empty',   blk(2, 2, 2, 3)],
    ['theirs empty', blk(2, 3, 2, 2)],
  ])('returns null when %s — degenerates to regular take', (_, b) => {
    expect(planTakeBoth(tracked, ours, theirs, b)).toBeNull()
  })

  it('multi-line blocks: preserves line order within each side', () => {
    const o = ['A', 'O1', 'O2', 'D']
    const t = ['A', 'T1', 'T2', 'D']
    const tr: TrackedBlock = { from: 2, to: 7, source: 'theirs' }  // 'T1\nT2'
    const plan = planTakeBoth(tr, o, t, blk(2, 4, 2, 4))!
    expect(apply('A\nT1\nT2\nD', plan.change)).toBe('A\nO1\nO2\nT1\nT2\nD')
  })
})
