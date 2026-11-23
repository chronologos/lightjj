// The merge editor's CENTER BLOCK TRACKER — the CodeMirror-state half of
// MergePanel: the StateField holding each conflict block's position in the
// editable result pane, its undo/redo inverses, the hand-edit → 'mixed'
// extender, and the transaction shapes for a take / an All-ours batch. Lives
// in a .ts module (not MergePanel's <script module>) so MergePanel.test.ts can
// mount it on a bare EditorState + real CM6 history — no view, no DOM — and
// drive random hand-edits ⨉ takes ⨉ undo/redo under fast-check with exactly
// the production transaction semantics. Position ARITHMETIC (planTake,
// remapBlock, …) stays in merge-surgery.ts, which is pure over CM types;
// this file is where CM runtime (StateField/StateEffect/history) is allowed.
//
import { EditorState, StateField, StateEffect, ChangeSet, type Extension, type TransactionSpec } from '@codemirror/state'
import { history, invertedEffects, isolateHistory } from '@codemirror/commands'
import { planTake, planTakeBoth, remapBlock, shiftBlock, normalizeBlocks, blockCharRange, type TrackedBlock } from './merge-surgery'
import type { ChangeBlock } from './merge-diff'

// Positions are LINE ranges (1-based half-open, merge-surgery.ts's model) —
// never char offsets, which alias "before / on / after a blank line" to one
// value and lost lines in blank-line conflicts. `source` tracks which side
// the center content came from — 'theirs' initially (seed), 'ours' after →,
// 'mixed' after user hand-edits inside the block.
// newFrom/newTo are NEW-doc line ranges computed by planTake — it knows
// the exact surgery (leading/trailing separator, deletion extent) so it can
// place the block range precisely; `delta` is the take's net line change,
// applied to every block AFTER idx (index order is the tie-break that keeps
// two zero-line blocks at the same line correctly ordered — a position
// comparison can't). Takes therefore never go through mapPos at all.
/** Line range (1-based half-open) + source — see merge-surgery.ts. */
export type CenterBlock = TrackedBlock
interface ApplyBlockEffect { idx: number; side: 'ours' | 'theirs' | 'both'; newFrom: number; newTo: number; delta: number }
const applyBlock = StateEffect.define<ApplyBlockEffect>()
const editInside = StateEffect.define<number>()  // block index → mark mixed
// Undo/redo inverse: the WHOLE tracker array as it was before the
// transaction. EVERY doc-changing (or tracker-effect-carrying) transaction
// records one via invertedEffects — takes AND hand-edits alike. Why a full
// snapshot and not a per-block patch: (1) a take moves its target and
// shifts every later block; (2) line ranges cannot be mapped through a
// ChangeDesc, and CM6 history JOINS adjacent edits made within 500ms into
// one event, mapping the newer event's inverse effects through the older
// changes — a per-block snapshot taken mid-group would be applied, un-
// mappable, to the pre-group doc (highlight lands on the neighbouring
// shared line; the next arrow destroys it). With whole snapshots the join
// is harmless: CM6 concatenates joined inverses newest→oldest and the
// tracker applies them in order, so the OLDEST (= pre-group, = the doc undo
// actually restores) snapshot wins. Redo gets the pre-undo snapshot the same
// way (the undo transaction carries restoreAll → its inverse is another
// restoreAll). Undo/redo are therefore exact regardless of how precisely
// remapBlock tracked the intermediate hand-edits. Without this, Cmd+Z
// restores the TEXT but blocks keep stale ranges/sources (arrow dimmed,
// highlight wrong, counter wrong — or worse, on the wrong line).
const restoreAll = StateEffect.define<readonly CenterBlock[]>()
export const isTrackerEffect = (e: StateEffect<unknown>): boolean =>
  e.is(applyBlock) || e.is(editInside) || e.is(restoreAll)

// A take: explicit target range + arithmetic shift of later blocks.
// Critical: non-target blocks MUST move with the change or they retain
// stale pre-transaction lines (old code once skipped the remap when
// applyBlock's .map() created a fresh array — block 1 kept block-0's old
// positions).
const applyTake = (blocks: readonly CenterBlock[], t: ApplyBlockEffect): readonly CenterBlock[] =>
  blocks.map((b, i) => i === t.idx
    ? { from: t.newFrom, to: t.newTo, source: t.side }
    : i > t.idx ? shiftBlock(b, t.delta) : b)

export function blockTracker(initial: readonly CenterBlock[]) {
  return StateField.define<readonly CenterBlock[]>({
    create() { return initial },
    update(blocks, tr) {
      let result = blocks
      let took = false
      for (const e of tr.effects) if (e.is(applyBlock)) { result = applyTake(result, e.value); took = true }
      if (took) {
        // One take, or an All-ours/theirs batch composed into a single
        // transaction (several applyBlock effects, applied in order — each
        // is relative to the state the previous one produced).
      } else if (!tr.changes.empty) {
        // Hand-edit / undo / redo: map every block through the change.
        // remapBlock() rounds to whole lines without annexing neighbours
        // and handles the whole-block-replace inversion; normalizeBlocks()
        // then re-establishes in-bounds / index-ordered / disjoint (one edit
        // spanning two blocks lands both on the merged line — the later one
        // is clamped + tagged mixed). See merge-surgery.ts + tests. A
        // restoreAll below (undo/redo) overrides all of it.
        result = normalizeBlocks(
          blocks.map(b => remapBlock(b, tr.changes, tr.startState.doc, tr.newDoc,
            ln => !blocks.some(o => o !== b && ln >= o.from && ln < o.to))),
          tr.newDoc.lines)
      }
      for (const e of tr.effects) {
        if (e.is(editInside)) {
          result = result.map((b, i) => i === e.value
            ? { ...b, source: 'mixed' as const }
            : b)
        } else if (e.is(restoreAll)) {
          result = e.value
        }
      }
      return result
    },
  })
}

/** history() + the tracker's undo inverses + the hand-edit → 'mixed'
 *  extender. One bundle so the component and the property tests run the
 *  exact same transaction semantics. */
export function trackerHistory(tracker: StateField<readonly CenterBlock[]>): Extension {
  return [
    history(),
    invertedEffects.of(tr =>
      tr.docChanged || tr.effects.some(isTrackerEffect)
        ? [restoreAll.of(tr.startState.field(tracker))]
        : []),
    // editInside as transactionExtender (NOT updateListener dispatch) so
    // it bundles with the text change — single transaction → in history →
    // refreshArrows sees the fresh 'mixed' source on the SAME listener
    // tick (no 1-keystroke lag) → Cmd+Z of the edit also restores source
    // via the restoreAll snapshot above.
    //
    // Exclude transactions carrying tracker effects — applyBlock (arrow
    // click) and restoreAll (undo/redo) set sources themselves; the
    // extender running on undo would otherwise re-mark 'mixed' and
    // immediately clobber what restoreAll just restored.
    EditorState.transactionExtender.of(tr => {
      if (!tr.docChanged) return null
      if (tr.effects.some(isTrackerEffect)) return null
      // iterChanges yields OLD-doc coords; startState.field = OLD block
      // positions, converted to chars against the OLD doc. Same coord
      // system (unlike tr.state.field which is post-mapping).
      const oldDoc = tr.startState.doc
      const tracked = tr.startState.field(tracker)
      const effects: StateEffect<number>[] = []
      tr.changes.iterChanges((fromA, toA, _fromB, _toB, inserted) => {
        for (let i = 0; i < tracked.length; i++) {
          const t = tracked[i]
          // A zero-line block owns nothing, so nothing of it can be
          // 'mixed': typing on the adjacent SHARED line (or extending the
          // last line under a past-the-end marker) must not flip the
          // counter to resolved. remapBlock keeps the marker placed.
          if (t.source === 'mixed' || t.from >= t.to) continue
          const b = blockCharRange(oldDoc, t)
          // Non-strict overlap: boundary-touching DELETES affect the
          // block even though [b.from-1,b.from) doesn't strictly overlap
          // [b.from,b.to). Backspace at block start joins with the
          // preceding line → remapBlock lets go of the merged line (block
          // goes zero-line beside it) → the block no longer holds what its
          // tag claims. Marking 'mixed' makes takeBlock's idempotent-source
          // check irrelevant (user can still arrow-toggle, but at least
          // the source indicator is honest). Pure insertions AT a boundary
          // (fromA===toA at b.from / b.to) match with <= too — typed TEXT
          // there lands on the block's first/last line — except the two
          // that leave the block's lines untouched: an insert at column 0
          // ending in a line break (Enter there just pushes the block down;
          // remapBlock's from-assoc keeps the new line outside) and an insert
          // at the block's end starting with one (the new line lands after
          // it; to-assoc). A block owning a single BLANK line (b.from ===
          // b.to) is the exception to the exception: an Enter on it does
          // grow it.
          if (!(fromA <= b.to && toA >= b.from)) continue
          if (fromA === toA && inserted.lines > 1 && b.from < b.to) {
            if (fromA === b.from && inserted.line(inserted.lines).length === 0) continue
            if (fromA === b.to && inserted.line(1).length === 0) continue
          }
          effects.push(editInside.of(i))
        }
      })
      return effects.length ? { effects } : null
    }),
  ]
}

/** Transaction spec for "take `side` into center for block `idx`", or null
 *  when idempotent (center already holds that side / takeBoth on a one-
 *  sided block). History-isolated ('full'): a take is its OWN undo step,
 *  never composed with adjacent typing before or after it — the one
 *  exception CM6 hard-codes is an IME composition continuing right after,
 *  which joins unconditionally (undo then reverts both; the oldest-wins
 *  snapshot keeps the tracker exact). */
export function takeSpec(
  state: EditorState,
  tracker: StateField<readonly CenterBlock[]>,
  blocks: readonly ChangeBlock[],
  oursLines: string[],
  theirsLines: string[],
  idx: number,
  side: 'ours' | 'theirs' | 'both',
): TransactionSpec | null {
  const pos = state.field(tracker)[idx]
  const blk = blocks[idx]
  if (!pos || !blk) return null
  const plan = side === 'both'
    ? planTakeBoth(state.doc, pos, oursLines, theirsLines, blk)
    : planTake(state.doc, pos, side, side === 'ours' ? oursLines : theirsLines, blk)
  if (!plan) return null
  return {
    changes: plan.change,
    effects: applyBlock.of({ idx, side, newFrom: plan.newTrack.from, newTo: plan.newTrack.to, delta: plan.delta }),
    annotations: isolateHistory.of('full'),
    scrollIntoView: true,
  }
}

/** ONE transaction taking `side` for every block: the per-block plans are
 *  computed against the running intermediate doc/tracker (pure — planTake
 *  + applyTake, exactly what N sequential dispatches would see), their
 *  ChangeSets composed, their applyBlock effects listed in order. One
 *  dispatch ⇒ one history event ⇒ "All ours" is ONE Cmd+Z whatever the
 *  block shapes (sequential dispatches could not guarantee that: CM6 won't
 *  join onto a textually empty take, nor non-adjacent ones without extra
 *  config). Order is irrelevant to correctness (each take shifts every
 *  later-INDEX block by its line delta — merge-surgery's sweep takes blocks
 *  in random order); forward is just the natural one. Empty-source blocks
 *  included — "take ours" when ours has nothing means delete center content
 *  there (planTake's K=0 shape), the correct semantics for "give me
 *  everything from the ours side". null = nothing to do. */
export function takeAllSpec(
  state: EditorState,
  tracker: StateField<readonly CenterBlock[]>,
  blocks: readonly ChangeBlock[],
  oursLines: string[],
  theirsLines: string[],
  side: 'ours' | 'theirs',
): TransactionSpec | null {
  let doc = state.doc
  let track = state.field(tracker)
  let changes: ChangeSet | null = null
  const effects: StateEffect<ApplyBlockEffect>[] = []
  for (let idx = 0; idx < blocks.length; idx++) {
    const pos = track[idx]
    if (!pos) break
    const plan = planTake(doc, pos, side, side === 'ours' ? oursLines : theirsLines, blocks[idx])
    if (!plan) continue
    const cs = ChangeSet.of(plan.change, doc.length)
    doc = cs.apply(doc)
    changes = changes ? changes.compose(cs) : cs
    const t = { idx, side, newFrom: plan.newTrack.from, newTo: plan.newTrack.to, delta: plan.delta }
    track = applyTake(track, t)
    effects.push(applyBlock.of(t))
  }
  if (!effects.length) return null
  return { changes: changes ?? undefined, effects, annotations: isolateHistory.of('full'), scrollIntoView: true }
}
