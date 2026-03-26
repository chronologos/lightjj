<script module lang="ts">
  import { EditorView, keymap, lineNumbers, Decoration, type DecorationSet } from '@codemirror/view'
  import { EditorState, StateField, StateEffect, type Extension } from '@codemirror/state'
  import { remapBlock, type BlockSource } from './merge-surgery'

  // Flank highlight — static set, computed once at mount. Read-only panes never
  // change, so a StateField with no update recomputation is fine.
  function flankHighlight(lines: Set<number>, cls: string): Extension {
    return StateField.define<DecorationSet>({
      create(state) {
        const ranges = []
        for (const ln of lines) {
          if (ln > state.doc.lines) continue
          ranges.push(Decoration.line({ class: cls }).range(state.doc.line(ln).from))
        }
        return Decoration.set(ranges, true)
      },
      update(deco) { return deco },  // read-only — no changes to map
      provide: f => EditorView.decorations.from(f),
    })
  }

  // Block center-position tracker. CM6 change-mapping keeps positions valid as
  // the user edits around (not inside) a block. `source` tracks which side the
  // center content came from — 'theirs' initially (seed), 'ours' after →,
  // 'mixed' after user hand-edits inside the block.
  // newFrom/newTo are NEW-doc positions computed by takeBlock — it knows the
  // exact surgery (leading/trailing separator, deletion extent) so it can
  // place the block range precisely. mapPos() in the tracker can't: it only
  // knows old positions and change deltas, not semantics like "the leading
  // \n is a separator, not block content".
  interface ApplyBlockEffect { idx: number; side: 'ours' | 'theirs' | 'both'; newFrom: number; newTo: number }
  const applyBlock = StateEffect.define<ApplyBlockEffect>()
  const editInside = StateEffect.define<number>()  // block index → mark mixed
  // Undo inverse: restores {source, from, to} snapshot captured pre-apply.
  // Without this, Cmd+Z restores the TEXT but the block stays marked as the
  // new source (arrow stays dimmed, highlight wrong, counter wrong).
  //
  // `map` REQUIRED: CM6 history groups ops within ~75ms. When two takeBlock
  // calls on DIFFERENT blocks land in the same group, the inverse effect for
  // block A must be mapped through block B's changes. Without map, identity
  // mapping leaves stale absolute positions → undo restores wrong range.
  const restoreBlock = StateEffect.define<{ idx: number; from: number; to: number; source: BlockSource }>({
    map: (val, mapping) => ({
      ...val,
      from: mapping.mapPos(val.from, 1),
      to: mapping.mapPos(val.to, -1),
    }),
  })
  interface CenterBlock {
    /** doc position (0-based char offset) of block start. */
    from: number
    /** doc position of block end. */
    to: number
    /** Which side the center content came from. Drives highlight color. */
    source: BlockSource
  }
  function blockTracker(initial: CenterBlock[]) {
    return StateField.define<CenterBlock[]>({
      create() { return initial },
      update(blocks, tr) {
        // Position mapping ALWAYS runs first on doc change — applyBlock's target
        // overrides below. Critical: non-target blocks MUST be mapped through
        // the change or they retain stale pre-transaction offsets. (Old code
        // gated mapPos on `result === blocks`, skipping it when applyBlock's
        // .map() created a fresh array — block 1 kept block-0's old positions.)
        // remapBlock() handles the whole-block-replace inversion (select-all-
        // and-type flips assoc) — see merge-surgery.ts + tests.
        let result: CenterBlock[] = tr.changes.empty
          ? blocks
          : blocks.map(b => ({ ...b, ...remapBlock(b, tr.changes) }))
        // Effects override mapped positions for the target block. applyBlock
        // carries BOTH newFrom and newTo as explicit new-doc positions —
        // mapPos() cannot derive these correctly: for a leading-\n insert at
        // end-of-doc, mapPos(origFrom, -1) stays at the \n separator position,
        // making the block range include the separator → sourceHighlight
        // decorates the preceding line, and toggle-back deletion corrupts.
        for (const e of tr.effects) {
          if (e.is(applyBlock)) {
            const { idx, side, newFrom, newTo } = e.value
            result = result.map((b, i) => i === idx
              ? { from: newFrom, to: newTo, source: side }
              : b)
          } else if (e.is(editInside)) {
            result = result.map((b, i) => i === e.value
              ? { ...b, source: 'mixed' as const }
              : b)
          } else if (e.is(restoreBlock)) {
            const { idx, from, to, source } = e.value
            result = result.map((b, i) => i === idx ? { from, to, source } : b)
          }
        }
        return result
      },
    })
  }

  // Center highlight — now driven by the blockTracker StateField directly.
  // Each block's `source` determines its class. Replaces the old static
  // centerHighlight(initial) that drifted as user edited.
  function sourceHighlight(tracker: StateField<CenterBlock[]>): Extension {
    return EditorView.decorations.compute([tracker], state => {
      const blocks = state.field(tracker)
      const ranges = []
      for (const b of blocks) {
        if (b.from >= b.to) continue  // empty/collapsed
        const cls = b.source === 'ours' ? 'merge-from-ours'
                  : b.source === 'theirs' ? 'merge-from-theirs'
                  : b.source === 'both' ? 'merge-from-both'
                  : 'merge-from-mixed'
        // Decorate each line in the range
        const startLine = state.doc.lineAt(b.from).number
        const endLine = state.doc.lineAt(Math.min(b.to, state.doc.length)).number
        for (let ln = startLine; ln <= endLine; ln++) {
          ranges.push(Decoration.line({ class: cls }).range(state.doc.line(ln).from))
        }
      }
      return Decoration.set(ranges, true)
    })
  }
</script>

<script lang="ts">
  import { untrack } from 'svelte'
  import { defaultKeymap, indentWithTab, history, historyKeymap, invertedEffects } from '@codemirror/commands'
  import { syntaxHighlighting, defaultHighlightStyle, indentUnit } from '@codemirror/language'
  import { highlightActiveLine, highlightActiveLineGutter } from '@codemirror/view'
  import { detectIndent, getCmLanguage, cmTheme } from './cm-shared'
  import { blocksToLineSets, type ChangeBlock } from './merge-diff'
  import { planTake, planTakeBoth, initialTrackPos } from './merge-surgery'
  import type { MergeSides } from './conflict-extract'

  interface Props {
    sides: MergeSides
    filePath: string
    busy?: boolean     // save in progress — disable buttons
    error?: string     // saveMerge error — shown in toolbar (bug_027: not visible behind {#if mergeSides})
    onsave: (content: string) => void
    oncancel: () => void
  }
  let { sides, filePath, busy = false, error = '', onsave, oncancel }: Props = $props()

  let oursEl: HTMLDivElement | undefined = $state(undefined)
  let centerEl: HTMLDivElement | undefined = $state(undefined)
  let theirsEl: HTMLDivElement | undefined = $state(undefined)

  let centerView: EditorView | undefined
  let oursView: EditorView | undefined
  let theirsView: EditorView | undefined

  let hiddenFlank: 'ours' | 'theirs' | null = $state(null)
  // Tracks USER edits for Escape confirm. Save is always enabled (see below).
  let dirty = $state(false)

  // Per-block arrow state — mirrors the blockTracker StateField but in Svelte
  // $state so the gutter arrows can react. Updated on every center transaction
  // via updateListener. Dual-tracking is intentional: CM6 owns position mapping
  // through edits (its ChangeSet.mapPos is the authoritative algorithm), Svelte
  // owns the arrow DOM.
  interface ArrowSlot {
    /** pixel y-offset within the scroll area (0 = top of line 1) */
    y: number
    /** Block height in pixels on the flank side. */
    h: number
    /** Center pane block position (from trackerField doc positions). */
    cy: number
    /** Center pane block height. */
    ch: number
    /** Which side the center currently has. Arrow dims when it matches THIS side. */
    source: BlockSource
    /** true for pure insertions on the flank side (no content to pull) */
    empty: boolean
  }
  let oursArrows: ArrowSlot[] = $state([])
  let theirsArrows: ArrowSlot[] = $state([])
  let scrollTop = $state(0)

  // Keyboard nav cursor. Updated by [/] keys and arrow clicks; drives the
  // "Block N of M" pill and the .merge-arrow-current ring. Not derived from
  // scrollTop — explicit nav is more predictable than viewport-nearest when
  // multiple blocks fit on screen.
  let currentBlockIdx = $state(0)
  // Hover index lights up the corresponding ribbon so the connection reads
  // on mouseover. -1 = no hover. Driven by arrow + minimap-chip mouseenter.
  let hoveredBlockIdx = $state(-1)

  // Immutable at mount (parent uses {#key mergingPath}). Flank content never
  // changes; only center edits matter and those are tracked via StateField.
  // untrack silences state_referenced_locally — prop IS mount-invariant here.
  const oursLines = untrack(() => sides.ours).split('\n')
  const theirsLines = untrack(() => sides.theirs).split('\n')
  const totalLines = theirsLines.length  // center seeds with theirs → minimap scale

  // blocks[i] is the merge unit for arrow i. aFrom/aTo = ours lines,
  // bFrom/bTo = theirs (= initial center) lines. Both 1-indexed half-open.
  // Emitted by conflict-extract at parse time (one block per jj conflict
  // region) — no LCS needed. Parse already knows where <<<<<<< / >>>>>>>
  // bound each conflict; re-deriving via diffBlocks was O(fileLines²) of
  // re-discovering that out-of-region lines are identical.
  const blocks: ChangeBlock[] = untrack(() => sides.blocks)

  // StateField instance — retained so we can read .state.field(trackerField).
  let trackerField: StateField<CenterBlock[]> | undefined

  const ROW_H = 18  // matches cmTheme .cm-line lineHeight
  // 40px gives bezier ribbons enough horizontal span to read as curves.
  // 22px compressed them into unreadable vertical smudges.
  const GUTTER_W = 40

  /** SVG path for a Kaleidoscope-style ribbon: bezier-smoothed quad connecting
   *  flank-block-region (one edge) → center-block-region (other edge). Empty
   *  blocks collapse to a 2px-high slit so the connection is still visible.
   *  flip=true swaps edges for the theirs gutter (center on left). */
  function ribbonPath(s: ArrowSlot, flip: boolean): string {
    const fy = s.y, fh = Math.max(2, s.h)
    const cy = s.cy, ch = Math.max(2, s.ch)
    const [l, r] = flip ? [GUTTER_W, 0] : [0, GUTTER_W]
    const m = GUTTER_W / 2
    return `M ${l} ${fy} C ${m} ${fy} ${m} ${cy} ${r} ${cy}` +
           ` L ${r} ${cy + ch} C ${m} ${cy + ch} ${m} ${fy + fh} ${l} ${fy + fh} Z`
  }

  // Props mount-invariant via {#key} — effect runs once. No centerView guard.
  $effect(() => {
    if (!oursEl || !centerEl || !theirsEl) return

    // Derive from `blocks` (computed at mount) — no second LCS DP pass.
    const { aOnly: oursChanged, bOnly: theirsChanged } = blocksToLineSets(blocks)

    const lang = getCmLanguage(filePath)
    const { usesTabs, width } = detectIndent(sides.theirs)

    const sharedExts: Extension[] = [
      lineNumbers(),
      syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
      EditorState.tabSize.of(4),
      indentUnit.of(usesTabs ? '\t' : ' '.repeat(width)),
      cmTheme,
    ]
    if (lang) sharedExts.push(lang)

    const readonlyExts = [
      EditorState.readOnly.of(true),
      EditorView.editable.of(false),
    ]

    const ov = new EditorView({
      state: EditorState.create({
        doc: sides.ours,
        extensions: [...sharedExts, ...readonlyExts, flankHighlight(oursChanged, 'merge-changed-ours')],
      }),
      parent: oursEl,
    })
    oursView = ov

    const tv = new EditorView({
      state: EditorState.create({
        doc: sides.theirs,
        extensions: [...sharedExts, ...readonlyExts, flankHighlight(theirsChanged, 'merge-changed-theirs')],
      }),
      parent: theirsEl,
    })
    theirsView = tv

    // Convert 1-indexed line ranges → 0-indexed doc positions for the tracker.
    // Center doc seeds with theirs, so initialTrackPos reads bFrom/bTo directly.
    const initialTrack: CenterBlock[] = blocks.map(b => ({
      ...initialTrackPos(tv.state.doc, b),
      source: 'theirs' as const,
    }))
    const tracker = blockTracker(initialTrack)
    trackerField = tracker

    const cv = new EditorView({
      state: EditorState.create({
        doc: sides.theirs,  // seed with theirs
        extensions: [
          ...sharedExts,
          history(),
          // Undo restores TEXT but not StateField state. Register inverse
          // effects so Cmd+Z also restores block source/positions — otherwise
          // arrow stays dimmed, highlight stays wrong, counter stays wrong.
          // applyBlock (arrow click) and editInside (first hand-keystroke)
          // both snapshot→restore via restoreBlock. editInside inversion works
          // because restoreBlock's positions ARE correct post-undo: the undo
          // transaction's mapPos restores to pre-edit positions, and
          // restoreBlock then writes the SAME pre-edit positions (from the
          // startState snapshot).
          invertedEffects.of(tr => {
            const inv: StateEffect<unknown>[] = []
            const old = tr.startState.field(tracker)
            for (const e of tr.effects) {
              if (e.is(applyBlock)) {
                inv.push(restoreBlock.of({ idx: e.value.idx, ...old[e.value.idx] }))
              } else if (e.is(editInside)) {
                inv.push(restoreBlock.of({ idx: e.value, ...old[e.value] }))
              } else if (e.is(restoreBlock)) {
                // Undo dispatches restoreBlock; redo needs the inverse — the
                // PRE-undo state (= post-applyBlock state). Without this
                // branch, redo re-applies doc changes but leaves source tag
                // stale (arrow dimmed, highlight wrong, counter wrong).
                inv.push(restoreBlock.of({ idx: e.value.idx, ...old[e.value.idx] }))
              }
            }
            return inv
          }),
          // editInside as transactionExtender (NOT updateListener dispatch) so
          // it bundles with the text change — single transaction → in history →
          // refreshArrows sees the fresh 'mixed' source on the SAME listener
          // tick (no 1-keystroke lag) → Cmd+Z of the edit also restores source
          // via the invertedEffects above.
          //
          // Exclude applyBlock (arrow click) and restoreBlock (undo/redo of
          // arrow click or prior hand-edit) — both have their own source-setting.
          // The extender running on undo would otherwise re-mark 'mixed' and
          // immediately clobber what restoreBlock just restored.
          EditorState.transactionExtender.of(tr => {
            if (!tr.docChanged) return null
            if (tr.effects.some(e => e.is(applyBlock) || e.is(restoreBlock))) return null
            // iterChanges yields OLD-doc coords; startState.field = OLD block
            // positions. Same coord system (unlike u.state.field which is
            // post-mapping).
            const tracked = tr.startState.field(tracker)
            const effects: StateEffect<number>[] = []
            tr.changes.iterChanges((fromA, toA) => {
              for (let i = 0; i < tracked.length; i++) {
                const b = tracked[i]
                // Non-strict overlap: boundary-touching DELETES affect the
                // block even though [b.from-1,b.from) doesn't strictly overlap
                // [b.from,b.to). Backspace at block start joins with preceding
                // line → block's from maps mid-line → next arrow click garbles
                // content. Marking 'mixed' makes takeBlock's idempotent-source
                // check irrelevant (user can still arrow-toggle, but at least
                // the source indicator is honest). Pure insertions at
                // boundaries (fromA===toA===b.from) are still OK with <= here:
                // they don't join lines.
                if (b.source !== 'mixed' && fromA <= b.to && toA >= b.from) {
                  effects.push(editInside.of(i))
                }
              }
            })
            return effects.length ? { effects } : null
          }),
          highlightActiveLine(),
          highlightActiveLineGutter(),
          tracker,
          sourceHighlight(tracker),  // replaces old static centerHighlight
          EditorView.updateListener.of(u => {
            // Arrow positions only shift on doc changes. Cursor/selection
            // updates don't need refreshArrows → skips two $state writes and
            // the downstream gutter DOM diff on every keystroke.
            if (!u.docChanged) return
            dirty = true
            refreshArrows()
          }),
          keymap.of([
            ...defaultKeymap,
            ...historyKeymap,
            indentWithTab,
            { key: 'Mod-s', run: () => { save(); return true } },
            { key: 'Escape', run: () => { tryCancel(); return true } },
          ]),
        ],
      }),
      parent: centerEl,
    })
    centerView = cv

    // Scroll sync — vertical only. Arrows positioned relative to scroll
    // container, so scrollTop drives their CSS translate.
    let syncing = false
    const views = [ov, cv, tv]
    const scrollHandlers: { el: HTMLElement; fn: () => void }[] = []
    for (const self of views) {
      const fn = () => {
        if (syncing) return
        syncing = true
        const top = self.scrollDOM.scrollTop
        for (const other of views) {
          if (other !== self) other.scrollDOM.scrollTop = top
        }
        scrollTop = top  // drive arrow positioning
        requestAnimationFrame(() => { syncing = false })
      }
      self.scrollDOM.addEventListener('scroll', fn)
      scrollHandlers.push({ el: self.scrollDOM, fn })
    }

    cv.focus()
    refreshArrows()  // initial population

    return () => {
      for (const { el, fn } of scrollHandlers) el.removeEventListener('scroll', fn)
      ov.destroy(); tv.destroy(); cv.destroy()
      oursView = centerView = theirsView = undefined
      trackerField = undefined
    }
  })

  /** Read current block positions from center's StateField → arrow slots.
   *  Flank Y/H from static line ranges (read-only panes). Center Y/H from the
   *  tracked doc positions (changes as user edits). Both needed for the SVG
   *  ribbon paths that connect flank-block-region → center-block-region. */
  function refreshArrows() {
    if (!centerView || !trackerField) return
    const tracked = centerView.state.field(trackerField)
    const doc = centerView.state.doc
    // Center position: convert doc char-offset → line number → pixel Y.
    const centerYH = (from: number, to: number): [number, number] => {
      const startLine = doc.lineAt(Math.min(from, doc.length)).number
      if (from >= to) return [(startLine - 1) * ROW_H, 0]
      const endLine = doc.lineAt(Math.min(to - 1, doc.length)).number
      return [(startLine - 1) * ROW_H, (endLine - startLine + 1) * ROW_H]
    }
    const slot = (from: number, to: number, src: BlockSource, cy: number, ch: number): ArrowSlot => ({
      y: ((from < to ? from : Math.max(1, from - 1)) - 1) * ROW_H,
      h: Math.max(0, to - from) * ROW_H,
      cy, ch,
      empty: from === to,
      source: src,
    })
    const o: ArrowSlot[] = []
    const t: ArrowSlot[] = []
    for (let i = 0; i < blocks.length; i++) {
      const src = tracked[i].source
      const [cy, ch] = centerYH(tracked[i].from, tracked[i].to)
      o.push(slot(blocks[i].aFrom, blocks[i].aTo, src, cy, ch))
      t.push(slot(blocks[i].bFrom, blocks[i].bTo, src, cy, ch))
    }
    oursArrows = o
    theirsArrows = t
  }

  /** Apply flank content for block `idx` into center at its tracked position.
   *  No-op if center already contains that side's content (idempotent).
   *  Position surgery lives in merge-surgery.ts (planTake) — extracted so the
   *  separator-math cases are unit-testable without a CM6 EditorView in jsdom.
   *  See merge-surgery.test.ts for the full round-trip invariant suite. */
  function takeBlock(idx: number, side: 'ours' | 'theirs') {
    if (!centerView || !trackerField) return
    const tracked = centerView.state.field(trackerField)
    const pos = tracked[idx]
    if (!pos) return

    const srcLines = side === 'ours' ? oursLines : theirsLines
    const plan = planTake(centerView.state.doc, pos, side, srcLines, blocks[idx])
    if (!plan) return  // idempotent (pos.source === side)

    centerView.dispatch({
      changes: plan.change,
      effects: applyBlock.of({ idx, side, newFrom: plan.newTrack.from, newTo: plan.newTrack.to }),
      scrollIntoView: true,
    })
    currentBlockIdx = idx
  }

  /** Scroll center pane so block `i` is centered. Reads live position from
   *  trackerField (remapped through all edits), not the static `blocks[]`. */
  function scrollToBlock(i: number) {
    if (!centerView || !trackerField || i < 0 || i >= blocks.length) return
    const pos = centerView.state.field(trackerField)[i].from
    centerView.dispatch({
      effects: EditorView.scrollIntoView(pos, { y: 'center' }),
    })
    currentBlockIdx = i
  }

  /** [/] nav: wraps at ends. No-op when blocks.length === 0 (no conflicts). */
  function navBlock(delta: 1 | -1) {
    if (blocks.length === 0) return
    const n = blocks.length
    scrollToBlock(((currentBlockIdx + delta) % n + n) % n)
  }

  /** Apply one side to every block. Synchronous dispatches land within CM6
   *  history's newGroupDelay (500ms) → typically one Cmd+Z undoes the batch.
   *  Empty-source blocks included — "take ours" when ours has nothing means
   *  delete center content there (planTake's srcEmpty branch), which is the
   *  correct semantics for "give me everything from the ours side". */
  function takeAll(side: 'ours' | 'theirs') {
    for (let i = 0; i < blocks.length; i++) takeBlock(i, side)
  }

  /** Concatenate ours+theirs for the current block. For additive conflicts
   *  (dueling imports, new list entries) where you want BOTH changes. No-op
   *  if either side is empty (degenerates to regular take). */
  function takeBoth(idx: number) {
    if (!centerView || !trackerField) return
    const tracked = centerView.state.field(trackerField)
    const pos = tracked[idx]
    if (!pos) return
    const plan = planTakeBoth(pos, oursLines, theirsLines, blocks[idx])
    if (!plan) return  // idempotent or one side empty
    centerView.dispatch({
      changes: plan.change,
      effects: applyBlock.of({ idx, side: 'both', newFrom: plan.newTrack.from, newTo: plan.newTrack.to }),
      scrollIntoView: true,
    })
    currentBlockIdx = idx
  }

  function save() {
    if (centerView && !busy) onsave(centerView.state.doc.toString())
  }

  function tryCancel() {
    if (busy) return
    if (dirty && !confirm('Discard merge edits?')) return
    oncancel()
  }

  function cycle() {
    const next = hiddenFlank === null ? 'theirs' : hiddenFlank === 'theirs' ? 'ours' : null
    hiddenFlank = next
    // bug_002: browsers ignore scrollTop on display:none. A pane that was
    // hidden during scroll is stale. Re-sync on next frame after CSS applies.
    if (centerView) {
      const top = centerView.scrollDOM.scrollTop
      requestAnimationFrame(() => {
        if (oursView) oursView.scrollDOM.scrollTop = top
        if (theirsView) theirsView.scrollDOM.scrollTop = top
      })
    }
  }

  // bug_030: clicking toolbar buttons moves focus out of the CM6 editor. App's
  // handleKeydown then sees !isInInput → j/k navigation fires → reset effect
  // clears merge state → unsaved work lost. Swallow ALL keydown at the panel
  // boundary; internal keys (Mod-s/Escape/editing) are handled by CM6's keymap
  // before bubbling reaches here.
  function swallowKeydown(e: KeyboardEvent) {
    // CM6's keymap preventDefault()s handled keys but does NOT stopPropagation().
    // Without this check, Escape fires tryCancel() from the keymap AND here on
    // bubble-up → two confirm() dialogs when dirty (user dismisses one, gets hit
    // with another), or double oncancel() when clean.
    if (e.defaultPrevented) { e.stopPropagation(); return }
    // Allow browser-level shortcuts (Cmd-R, Cmd-W, devtools) to pass.
    if (e.metaKey || e.ctrlKey) {
      // Except Cmd-S — MergePanel handles it, but if focus is on a button
      // (not CM6), the keymap won't fire. Handle it here too.
      if (e.key === 's') { e.preventDefault(); save(); return }
      return
    }
    if (e.key === 'Escape') { tryCancel(); e.stopPropagation(); return }
    // Block nav. [/] are valid source chars — only hijack when focus is NOT in
    // the editable center pane. Toolbar nav buttons work regardless of focus.
    // (Alt+] produces "'" on macOS, so an in-editor chord isn't portable.)
    if (!centerEl?.contains(e.target as Node)) {
      if (e.key === ']') { navBlock(1); e.preventDefault(); e.stopPropagation(); return }
      if (e.key === '[') { navBlock(-1); e.preventDefault(); e.stopPropagation(); return }
      if (e.key === 'b') { takeBoth(currentBlockIdx); e.preventDefault(); e.stopPropagation(); return }
      if (e.key === 'h') { cycle(); e.preventDefault(); e.stopPropagation(); return }
    }
    e.stopPropagation()
  }

  // Count blocks still unresolved (arrow still active on at least one side).
  // "Resolved" = user has made an explicit choice. 'theirs' is the initial
  // state (center seeded with theirs), so it counts as unresolved until the
  // user either clicks ← (confirming theirs) or → (taking ours) or hand-edits.
  // We approximate: a block is resolved once it's NOT 'theirs'. Clicking ←
  // on a theirs block is a no-op (idempotent), so this doesn't flip it — but
  // that's fine: explicitly keeping theirs IS implicit by saving as-is.
  //
  // Exclude blocks with empty ours side (aFrom===aTo → oursArrows[i].empty).
  // The → arrow isn't rendered for those (nothing to take), ← is a no-op
  // (already theirs), so the only way to "resolve" would be hand-editing —
  // the counter would otherwise never reach N/N.
  let pendingCount = $derived(
    oursArrows.filter(a => a.source === 'theirs' && !a.empty).length
  )
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class="merge-panel" onkeydown={swallowKeydown}>
  <div class="merge-toolbar">
    <span class="merge-title">⧉ <code>{filePath}</code></span>
    {#if blocks.length > 0}
      <span class="merge-counter" class:merge-done={pendingCount === 0}>
        {blocks.length - pendingCount}/{blocks.length}
      </span>
      <div class="merge-nav">
        <button class="merge-nav-btn" onclick={() => navBlock(-1)} title="Previous block ([)">‹</button>
        <span class="merge-nav-pos">{currentBlockIdx + 1} of {blocks.length}</span>
        <button class="merge-nav-btn" onclick={() => navBlock(1)} title="Next block (])">›</button>
      </div>
    {/if}
    {#if error}<span class="merge-error" title={error}>⚠ {error}</span>{/if}
    <span class="merge-spacer"></span>
    {#if blocks.length > 0}
      <button class="merge-btn merge-btn-ours" onclick={() => takeAll('ours')} disabled={busy} title="Take ours for every block">→→ All ours</button>
      <button class="merge-btn merge-btn-theirs" onclick={() => takeAll('theirs')} disabled={busy} title="Take theirs for every block">All theirs ←←</button>
    {/if}
    <button class="merge-btn" onclick={cycle} title="Toggle pane visibility (h)">
      {hiddenFlank === null ? '◫◫◫' : hiddenFlank === 'theirs' ? '◫◫▯' : '▯◫◫'}
    </button>
    <button class="merge-btn merge-save" onclick={save} disabled={busy} title="Save (⌘S)">
      {busy ? 'Saving…' : 'Save'}
    </button>
    <button class="merge-btn" onclick={tryCancel} disabled={busy} title="Cancel (Esc)">Cancel</button>
  </div>

  <div class="merge-headers">
    {#if hiddenFlank !== 'ours'}
      <div class="merge-header merge-header-ours">
        ⬅ {#if sides.oursRef}<code class="merge-ref">{sides.oursRef.changeId.slice(0, 8)}</code> · {/if}{sides.oursLabel || 'Ours (side #1)'}
      </div>
    {/if}
    <div class="merge-header merge-header-center">✎ Result</div>
    {#if hiddenFlank !== 'theirs'}
      <div class="merge-header merge-header-theirs">
        {#if sides.theirsRef}<code class="merge-ref">{sides.theirsRef.changeId.slice(0, 8)}</code> · {/if}{sides.theirsLabel || 'Theirs (side #2)'} ➡
      </div>
    {/if}
  </div>

  <div class="merge-panes">
    <div class="merge-pane" class:merge-hidden={hiddenFlank === 'ours'} bind:this={oursEl}></div>
    <!-- Ours gutter: arrows point → (content flows ours → center) -->
    <div class="merge-gutter merge-gutter-ours" class:merge-hidden={hiddenFlank === 'ours'}>
      <svg class="merge-ribbons" style="transform: translateY({-scrollTop}px)">
        {#each oursArrows as slot, i (i)}
          <path class="merge-ribbon-ours"
                class:merge-ribbon-applied={slot.source === 'ours'}
                class:merge-ribbon-current={i === currentBlockIdx}
                class:merge-ribbon-hovered={i === hoveredBlockIdx}
                d={ribbonPath(slot, false)} />
        {/each}
      </svg>
      {#each oursArrows as slot, i (i)}
        {#if !slot.empty}
          <button
            class="merge-arrow merge-arrow-ours"
            class:merge-arrow-applied={slot.source === 'ours'}
            class:merge-arrow-current={i === currentBlockIdx}
            style="transform: translateY({slot.y - scrollTop}px)"
            onmouseenter={() => hoveredBlockIdx = i}
            onmouseleave={() => hoveredBlockIdx = -1}
            onclick={() => takeBlock(i, 'ours')}
            title={slot.source === 'ours' ? 'Already using ours' : 'Take ours for this hunk'}
            aria-label="Take ours for hunk {i + 1}"
          >→</button>
        {/if}
      {/each}
    </div>
    <div class="merge-pane merge-center" bind:this={centerEl}></div>
    <!-- Theirs gutter: arrows point ← (content flows theirs → center) -->
    <div class="merge-gutter merge-gutter-theirs" class:merge-hidden={hiddenFlank === 'theirs'}>
      <svg class="merge-ribbons" style="transform: translateY({-scrollTop}px)">
        {#each theirsArrows as slot, i (i)}
          <path class="merge-ribbon-theirs"
                class:merge-ribbon-applied={slot.source === 'theirs'}
                class:merge-ribbon-current={i === currentBlockIdx}
                class:merge-ribbon-hovered={i === hoveredBlockIdx}
                d={ribbonPath(slot, true)} />
        {/each}
      </svg>
      {#each theirsArrows as slot, i (i)}
        {#if !slot.empty}
          <button
            class="merge-arrow merge-arrow-theirs"
            class:merge-arrow-applied={slot.source === 'theirs'}
            class:merge-arrow-current={i === currentBlockIdx}
            style="transform: translateY({slot.y - scrollTop}px)"
            onmouseenter={() => hoveredBlockIdx = i}
            onmouseleave={() => hoveredBlockIdx = -1}
            onclick={() => takeBlock(i, 'theirs')}
            title={slot.source === 'theirs' ? 'Already using theirs' : 'Take theirs for this hunk'}
            aria-label="Take theirs for hunk {i + 1}"
          >←</button>
          {#if !oursArrows[i]?.empty}
            <!-- Both-sides non-empty is planTakeBoth's precondition; hide otherwise. -->
            <button
              class="merge-arrow merge-arrow-both"
              class:merge-arrow-applied={slot.source === 'both'}
              class:merge-arrow-current={i === currentBlockIdx}
              style="transform: translateY({slot.y - scrollTop + 20}px)"
              onmouseenter={() => hoveredBlockIdx = i}
              onmouseleave={() => hoveredBlockIdx = -1}
              onclick={() => takeBoth(i)}
              title={slot.source === 'both' ? 'Already has both' : 'Take both (ours + theirs, b)'}
              aria-label="Take both for hunk {i + 1}"
            >⇄</button>
          {/if}
        {/if}
      {/each}
    </div>
    <div class="merge-pane" class:merge-hidden={hiddenFlank === 'theirs'} bind:this={theirsEl}></div>
    <!-- Minimap: proportional chips showing where blocks sit in the file.
         Positions from theirs-lines (immutable — "where are conflicts" doesn't
         change during resolution, only the source color does). -->
    <div class="merge-minimap">
      {#each blocks as blk, i (i)}
        {@const src = oursArrows[i]?.source ?? 'theirs'}
        <button
          class="merge-minimap-chip merge-minimap-{src}"
          class:merge-minimap-current={i === currentBlockIdx}
          style="top: {(blk.bFrom - 1) / totalLines * 100}%; height: max(3px, {(blk.bTo - blk.bFrom) / totalLines * 100}%)"
          onclick={() => scrollToBlock(i)}
          title="Block {i + 1}"
          aria-label="Jump to block {i + 1}"
        ></button>
      {/each}
    </div>
  </div>
</div>

<style>
  .merge-panel {
    display: flex;
    flex-direction: column;
    height: 100%;
    background: var(--base);
  }

  /* ── Toolbar ─────────────────────────────────────────────────────────── */

  .merge-toolbar {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 5px 10px;
    background: var(--mantle);
    border-bottom: 1px solid var(--surface0);
    font-size: 11px;
    flex-shrink: 0;
  }
  .merge-title { color: var(--subtext0); }
  .merge-title code { color: var(--text); font-family: var(--font-mono); }
  .merge-spacer { flex: 1; }

  .merge-counter {
    font-family: var(--font-mono);
    font-size: 10px;
    padding: 1px 6px;
    border-radius: 8px;
    background: color-mix(in srgb, var(--amber) 18%, transparent);
    color: var(--amber);
    letter-spacing: 0.3px;
  }
  .merge-counter.merge-done {
    background: color-mix(in srgb, var(--green) 18%, transparent);
    color: var(--green);
  }

  .merge-nav {
    display: flex;
    align-items: center;
    gap: 2px;
    font-family: var(--font-mono);
    font-size: 10px;
    color: var(--subtext0);
  }
  .merge-nav-pos {
    padding: 0 6px;
    min-width: 6ch;
    text-align: center;
  }
  .merge-nav-btn {
    width: 18px;
    height: 18px;
    padding: 0;
    border: 1px solid var(--surface1);
    background: var(--surface0);
    color: var(--text);
    border-radius: 3px;
    cursor: pointer;
    font-family: inherit;
    font-size: 13px;
    line-height: 1;
    transition: background 120ms ease;
  }
  .merge-nav-btn:hover { background: var(--surface1); }

  .merge-error {
    font-size: 10px;
    padding: 2px 8px;
    border-radius: 3px;
    background: color-mix(in srgb, var(--red) 15%, transparent);
    color: var(--red);
    max-width: 40ch;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .merge-btn {
    background: var(--surface0);
    border: 1px solid var(--surface1);
    color: var(--text);
    padding: 3px 10px;
    border-radius: 4px;
    cursor: pointer;
    font-family: inherit;
    font-size: 11px;
    transition: background 120ms ease, border-color 120ms ease, transform 80ms ease;
  }
  .merge-btn:hover:not(:disabled) { background: var(--surface1); transform: translateY(-1px); }
  .merge-btn:active:not(:disabled) { transform: translateY(0); }
  .merge-btn:disabled { opacity: 0.45; cursor: not-allowed; }
  .merge-save {
    background: color-mix(in srgb, var(--green) 12%, var(--surface0));
    border-color: color-mix(in srgb, var(--green) 40%, var(--surface1));
    color: var(--green);
    font-weight: 600;
  }
  .merge-save:hover {
    background: color-mix(in srgb, var(--green) 22%, var(--surface0));
  }
  .merge-btn-ours {
    border-color: color-mix(in srgb, var(--green) 30%, var(--surface1));
    color: color-mix(in srgb, var(--green) 70%, var(--text));
  }
  .merge-btn-theirs {
    border-color: color-mix(in srgb, var(--blue) 30%, var(--surface1));
    color: color-mix(in srgb, var(--blue) 70%, var(--text));
  }

  /* ── Pane headers ────────────────────────────────────────────────────── */

  .merge-headers {
    display: flex;
    background: var(--crust);
    border-bottom: 1px solid var(--surface0);
    font-size: 10px;
    flex-shrink: 0;
  }
  .merge-header {
    flex: 1;
    padding: 4px 10px;
    color: var(--subtext0);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    min-width: 0;
    letter-spacing: 0.2px;
  }
  .merge-header-ours {
    border-left: 3px solid var(--green);
    background: color-mix(in srgb, var(--green) 4%, transparent);
  }
  .merge-header-center {
    color: var(--text);
    font-weight: 600;
    border-left: 1px solid var(--surface0);
    border-right: 1px solid var(--surface0);
  }
  .merge-header-theirs {
    border-right: 3px solid var(--blue);
    background: color-mix(in srgb, var(--blue) 4%, transparent);
    text-align: right;
  }
  .merge-ref {
    font-family: var(--font-mono);
    color: var(--amber);
    font-size: 9px;
  }

  /* ── Pane layout ─────────────────────────────────────────────────────── */

  .merge-panes {
    display: flex;
    flex: 1;
    min-height: 0;
  }
  .merge-pane {
    flex: 1;
    min-width: 0;
    overflow: hidden;
  }
  .merge-center {
    border-left: 1px solid var(--surface1);
    border-right: 1px solid var(--surface1);
  }
  .merge-hidden { display: none; }

  .merge-panes :global(.cm-editor) { height: 100%; }

  /* ── Gutters (between panes) ─────────────────────────────────────────── */

  .merge-gutter {
    position: relative;
    width: 40px;
    flex-shrink: 0;
    overflow: hidden;
    background: var(--crust);
  }
  .merge-gutter-ours {
    border-right: 1px solid var(--surface0);
    background: linear-gradient(90deg,
      color-mix(in srgb, var(--green) 5%, transparent),
      transparent);
  }
  .merge-gutter-theirs {
    border-left: 1px solid var(--surface0);
    background: linear-gradient(-90deg,
      color-mix(in srgb, var(--blue) 5%, transparent),
      transparent);
  }

  /* Arrows are absolutely positioned at y=0 and translateY()'d to their slot.
     GPU-accelerated transform → smooth scroll tracking. */
  .merge-arrow {
    position: absolute;
    top: 0;
    left: 11px;  /* centered in 40px gutter */
    width: 18px;
    height: 18px;
    padding: 0;
    border: none;
    border-radius: 3px;
    cursor: pointer;
    font-size: 12px;
    font-weight: 700;
    line-height: 18px;
    font-family: var(--font-mono);
    display: flex;
    align-items: center;
    justify-content: center;
    transition: background 120ms ease, opacity 150ms ease;
    /* No transition on translateY — instant scroll tracking. */
  }
  .merge-arrow-ours {
    background: color-mix(in srgb, var(--green) 25%, var(--surface0));
    color: var(--green);
  }
  .merge-arrow-ours:hover:not(.merge-arrow-applied) {
    background: var(--green);
    color: var(--base);
  }
  .merge-arrow-theirs {
    background: color-mix(in srgb, var(--blue) 25%, var(--surface0));
    color: var(--blue);
  }
  .merge-arrow-theirs:hover:not(.merge-arrow-applied) {
    background: var(--blue);
    color: var(--base);
  }
  .merge-arrow-both {
    background: linear-gradient(135deg,
      color-mix(in srgb, var(--green) 25%, var(--surface0)),
      color-mix(in srgb, var(--blue) 25%, var(--surface0)));
    color: var(--text);
  }
  .merge-arrow-both:hover:not(.merge-arrow-applied) {
    background: linear-gradient(135deg, var(--green), var(--blue));
    color: var(--base);
  }
  .merge-arrow-applied {
    opacity: 0.25;
    background: var(--surface0);
    color: var(--subtext0);
  }
  .merge-arrow-applied:hover {
    /* Re-apply on hover: subtle lift but stays muted */
    opacity: 0.6;
  }
  .merge-arrow-current {
    outline: 2px solid var(--amber);
    outline-offset: 1px;
  }
  /* bug_005: applied arrows sit at opacity 0.25 — the amber ring inherits that
     and becomes near-invisible. Keep the ring readable when both classes apply. */
  .merge-arrow-current.merge-arrow-applied { opacity: 0.6; }

  /* Ribbons: Kaleidoscope-style bezier quads in the gutter connecting
     flank-block-region → center-block-region. SVG spans the full doc height
     (translateY scrolls it); each <path> is one ribbon. Subtle fill + stroke
     outline — the shape shows where misaligned blocks connect. */
  .merge-ribbons {
    position: absolute;
    top: 0;
    left: 0;
    width: 40px;
    height: 100000px;  /* tall enough for any doc; clipped by gutter */
    pointer-events: none;
  }
  .merge-ribbon-ours {
    fill: var(--green);
    fill-opacity: 0.12;
    stroke: var(--green);
    stroke-opacity: 0.4;
    stroke-width: 1;
  }
  .merge-ribbon-theirs {
    fill: var(--blue);
    fill-opacity: 0.12;
    stroke: var(--blue);
    stroke-opacity: 0.4;
    stroke-width: 1;
  }
  .merge-ribbon-applied { fill-opacity: 0.04; stroke-opacity: 0.15; }
  .merge-ribbon-current { fill-opacity: 0.25; stroke-opacity: 0.7; }
  .merge-ribbon-hovered { fill-opacity: 0.3; stroke-opacity: 0.9; }

  /* ── Minimap ─────────────────────────────────────────────────────────── */

  .merge-minimap {
    position: relative;
    width: 12px;
    flex-shrink: 0;
    background: var(--crust);
    border-left: 1px solid var(--surface0);
  }
  .merge-minimap-chip {
    position: absolute;
    left: 2px;
    right: 2px;
    padding: 0;
    border: none;
    border-radius: 2px;
    cursor: pointer;
  }
  /* Colors mirror .merge-from-* so the eye maps minimap → center highlight. */
  .merge-minimap-theirs { background: var(--blue); opacity: 0.5; }
  .merge-minimap-ours   { background: var(--green); opacity: 0.5; }
  .merge-minimap-both   { background: linear-gradient(var(--green), var(--blue)); opacity: 0.5; }
  .merge-minimap-mixed  { background: var(--amber); opacity: 0.5; }
  .merge-minimap-chip:hover { opacity: 0.8; }
  /* bug_015: :hover (0,1,1) beat .current (0,1,0) — two-class selector wins. */
  .merge-minimap-chip.merge-minimap-current {
    opacity: 1;
    outline: 1px solid var(--amber);
  }

  /* ── Diff highlights ─────────────────────────────────────────────────── */

  .merge-panes :global(.merge-changed-ours) {
    background: color-mix(in srgb, var(--green) 14%, transparent);
    box-shadow: inset 3px 0 0 color-mix(in srgb, var(--green) 50%, transparent);
  }
  .merge-panes :global(.merge-changed-theirs) {
    background: color-mix(in srgb, var(--blue) 14%, transparent);
    box-shadow: inset -3px 0 0 color-mix(in srgb, var(--blue) 50%, transparent);
  }
  /* Center block highlights — reflect which side the content came from.
     Matches flank colors so the eye can track: green left → green center. */
  .merge-panes :global(.merge-from-ours) {
    background: color-mix(in srgb, var(--green) 12%, transparent);
    box-shadow: inset 3px 0 0 color-mix(in srgb, var(--green) 40%, transparent);
  }
  .merge-panes :global(.merge-from-theirs) {
    background: color-mix(in srgb, var(--blue) 12%, transparent);
    box-shadow: inset -3px 0 0 color-mix(in srgb, var(--blue) 40%, transparent);
  }
  .merge-panes :global(.merge-from-both) {
    /* Both sides concatenated — gradient showing green-top (ours) + blue-bottom (theirs). */
    background: linear-gradient(
      color-mix(in srgb, var(--green) 10%, transparent),
      color-mix(in srgb, var(--blue) 10%, transparent));
  }
  .merge-panes :global(.merge-from-mixed) {
    /* User hand-edited — neutral amber, no side indicator. */
    background: color-mix(in srgb, var(--amber) 10%, transparent);
  }
</style>
