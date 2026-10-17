<script module lang="ts">
  import { EditorView, keymap, lineNumbers, Decoration, type DecorationSet, type Command } from '@codemirror/view'
  import { EditorState, StateField, Compartment, type Extension } from '@codemirror/state'
  import { blockCharRange, type BlockSource } from './merge-surgery'
  import type { ChangeBlock } from './merge-diff'
  // Center block tracker (StateField + history inverses + take transaction
  // shapes) lives in merge-tracker.ts — see there for the position/undo model.
  import { blockTracker, trackerHistory, takeSpec, takeAllSpec, isTrackerEffect, type CenterBlock } from './merge-tracker'

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

  // Center highlight — now driven by the blockTracker StateField directly.
  // Each block's `source` determines its class. Replaces the old static
  // centerHighlight(initial) that drifted as user edited.
  function sourceHighlight(tracker: StateField<readonly CenterBlock[]>): Extension {
    return EditorView.decorations.compute([tracker], state => {
      const blocks = state.field(tracker)
      const ranges = []
      for (const b of blocks) {
        if (b.from >= b.to) continue  // zero-line block: nothing to paint
        const cls = b.source === 'ours' ? 'merge-from-ours'
                  : b.source === 'theirs' ? 'merge-from-theirs'
                  : b.source === 'both' ? 'merge-from-both'
                  : 'merge-from-mixed'
        // Decorate each line in the range (clamped — a decoration past the
        // last line would throw inside the view update).
        for (let ln = Math.max(1, b.from); ln < b.to && ln <= state.doc.lines; ln++) {
          ranges.push(Decoration.line({ class: cls }).range(state.doc.line(ln).from))
        }
      }
      return Decoration.set(ranges, true)
    })
  }
</script>

<script lang="ts">
  import { untrack } from 'svelte'
  import { defaultKeymap, indentWithTab, historyKeymap, moveLineUp, moveLineDown, copyLineUp, copyLineDown } from '@codemirror/commands'
  import { indentUnit } from '@codemirror/language'
  import { highlightActiveLine, highlightActiveLineGutter } from '@codemirror/view'
  import { detectIndent, getCmLanguage, cmTheme, cmHighlight } from './cm-shared'
  import { blocksToLineSets } from './merge-diff'
  import { initialTrackPos } from './merge-surgery'
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
  // through edits (the StateField sees every transaction; hand-edits map via
  // its ChangeSet.mapPos, the authoritative algorithm), Svelte owns the arrow DOM.
  interface ArrowSlot {
    /** pixel y-offset within the scroll area (0 = top of line 1) */
    y: number
    /** Block height in pixels on the flank side. */
    h: number
    /** Center pane block position (from trackerField line ranges). */
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
  let trackerField: StateField<readonly CenterBlock[]> | undefined

  const ROW_H = 18  // matches cmTheme .cm-line lineHeight
  const NO_LINE_MOVES = new Set<Command>([moveLineUp, moveLineDown, copyLineUp, copyLineDown])
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

    const { usesTabs, width } = detectIndent(sides.theirs)
    const langCompartment = new Compartment()

    const sharedExts: Extension[] = [
      lineNumbers(),
      cmHighlight,  // tok-* classes → theme.css --syn-* vars (see cm-shared.ts)
      EditorState.tabSize.of(4),
      indentUnit.of(usesTabs ? '\t' : ' '.repeat(width)),
      cmTheme,
      langCompartment.of([]),
    ]

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

    // Center doc seeds with theirs, so a block's initial center line range IS
    // its bFrom/bTo — the tracker keeps line ranges, no char conversion.
    const initialTrack: CenterBlock[] = blocks.map(b => ({
      ...initialTrackPos(b),
      source: 'theirs' as const,
    }))
    const tracker = blockTracker(initialTrack)
    trackerField = tracker

    const cv = new EditorView({
      state: EditorState.create({
        doc: sides.theirs,  // seed with theirs
        extensions: [
          ...sharedExts,
          // Undo restores TEXT but not StateField state: trackerHistory
          // bundles history() with the tracker's whole-array undo/redo
          // snapshots and the hand-edit → 'mixed' extender (module script —
          // shared verbatim with the property tests).
          trackerHistory(tracker),
          highlightActiveLine(),
          highlightActiveLineGutter(),
          tracker,
          sourceHighlight(tracker),  // replaces old static centerHighlight
          EditorView.updateListener.of(u => {
            // Arrow positions/sources only shift on doc changes or tracker
            // effects (a zero-line take is a textually EMPTY change that still
            // flips the source tag). Cursor/selection updates don't need
            // refreshArrows → skips two $state writes and the downstream
            // gutter DOM diff on every keystroke.
            if (!u.docChanged && !u.transactions.some(t => t.effects.some(isTrackerEffect))) return
            dirty = true
            refreshArrows()
          }),
          keymap.of([
            // Alt-↑/↓ (move line) and Shift-Alt-↑/↓ (copy line) are dropped:
            // CM6 implements a line move as delete("\nD") + insert("D\n")
            // in one transaction, which to the block tracker is "the user
            // deleted shared line D and typed D into the block" — moving a
            // block's edge line past a shared neighbour would annex it and
            // the next arrow click would destroy it. Line moves across
            // conflict-block boundaries have no defined tracker semantics;
            // cut/paste (two transactions) behaves.
            ...defaultKeymap.filter(k => !(k.run && NO_LINE_MOVES.has(k.run))),
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

    getCmLanguage(filePath).then(ls => {
      if (!ls || centerView !== cv) return
      for (const v of [ov, cv, tv]) v.dispatch({ effects: langCompartment.reconfigure(ls) })
    }).catch(() => {})

    return () => {
      for (const { el, fn } of scrollHandlers) el.removeEventListener('scroll', fn)
      ov.destroy(); tv.destroy(); cv.destroy()
      oursView = centerView = theirsView = undefined
      trackerField = undefined
    }
  })

  /** Read current block positions from center's StateField → arrow slots.
   *  Flank Y/H from static line ranges (read-only panes). Center Y/H from the
   *  tracked line ranges (change as user edits). Both needed for the SVG
   *  ribbon paths that connect flank-block-region → center-block-region. */
  function refreshArrows() {
    if (!centerView || !trackerField) return
    const tracked = centerView.state.field(trackerField)
    // Center position: tracked line range → pixel Y. Same arithmetic as the
    // flank slots — the tracker is already in lines.
    const centerYH = (from: number, to: number): [number, number] =>
      [(from - 1) * ROW_H, Math.max(0, to - from) * ROW_H]
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
   *  Position surgery lives in merge-surgery.ts (planTake/planTakeBoth), the
   *  transaction shape in takeSpec (module script) — both unit/property-
   *  tested without a CM6 EditorView. */
  function takeBlock(idx: number, side: 'ours' | 'theirs' | 'both') {
    if (!centerView || !trackerField) return
    const spec = takeSpec(centerView.state, trackerField, blocks, oursLines, theirsLines, idx, side)
    if (!spec) return  // idempotent (source === side) or takeBoth on a one-sided block
    centerView.dispatch(spec)
    currentBlockIdx = idx
  }

  /** Scroll center pane so block `i` is centered. Reads live position from
   *  trackerField (remapped through all edits), not the static `blocks[]`. */
  function scrollToBlock(i: number) {
    if (!centerView || !trackerField || i < 0 || i >= blocks.length) return
    const pos = blockCharRange(centerView.state.doc, centerView.state.field(trackerField)[i]).from
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

  /** Apply one side to every block as ONE transaction — one Cmd+Z undoes
   *  the whole batch (takeAllSpec, module script). */
  function takeAll(side: 'ours' | 'theirs') {
    if (!centerView || !trackerField) return
    const spec = takeAllSpec(centerView.state, trackerField, blocks, oursLines, theirsLines, side)
    if (spec) centerView.dispatch(spec)
  }

  /** Concatenate ours+theirs for the current block. For additive conflicts
   *  (dueling imports, new list entries) where you want BOTH changes. No-op
   *  if either side is empty (degenerates to regular take). */
  function takeBoth(idx: number) {
    takeBlock(idx, 'both')
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
      <button class="btn merge-btn-ours" onclick={() => takeAll('ours')} disabled={busy} title="Take ours for every block">→→ All ours</button>
      <button class="btn merge-btn-theirs" onclick={() => takeAll('theirs')} disabled={busy} title="Take theirs for every block">All theirs ←←</button>
    {/if}
    <button class="btn" onclick={cycle} title="Toggle pane visibility (h)">
      {hiddenFlank === null ? '◫◫◫' : hiddenFlank === 'theirs' ? '◫◫▯' : '▯◫◫'}
    </button>
    <button class="btn btn-success" onclick={save} disabled={busy} title="Save (⌘S)">
      {busy ? 'Saving…' : 'Save'}
    </button>
    <button class="btn" onclick={tryCancel} disabled={busy} title="Cancel (Esc)">Cancel</button>
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
    font-size: var(--fs-sm);
    flex-shrink: 0;
  }
  .merge-title { color: var(--subtext0); }
  .merge-title code { color: var(--text); font-family: var(--font-mono); }
  .merge-spacer { flex: 1; }

  .merge-counter {
    font-family: var(--font-mono);
    font-size: var(--fs-xs);
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
    font-size: var(--fs-xs);
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
    font-size: var(--font-size);
    line-height: 1;
    transition: background var(--anim-duration) var(--anim-ease);
  }
  .merge-nav-btn:hover { background: var(--surface1); }

  .merge-error {
    font-size: var(--fs-xs);
    padding: 2px 8px;
    border-radius: 3px;
    background: color-mix(in srgb, var(--red) 15%, transparent);
    color: var(--red);
    max-width: 40ch;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  /* System .btn + the merge-panel signature lift-on-hover. */
  .merge-toolbar :global(.btn) { transition: transform var(--anim-duration) var(--anim-ease); }
  .merge-toolbar :global(.btn:hover:not(:disabled)) { transform: translateY(-1px); }
  .merge-toolbar :global(.btn:active:not(:disabled)) { transform: translateY(0); }
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
    font-size: var(--fs-xs);
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
    font-size: var(--fs-2xs);
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
    font-size: var(--fs-md);
    font-weight: 700;
    line-height: 18px;
    font-family: var(--font-mono);
    display: flex;
    align-items: center;
    justify-content: center;
    transition: background var(--anim-duration) var(--anim-ease), opacity var(--anim-duration) var(--anim-ease);
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
