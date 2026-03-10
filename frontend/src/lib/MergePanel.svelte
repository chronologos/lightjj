<script module lang="ts">
  import { EditorView, keymap, lineNumbers, Decoration, type DecorationSet } from '@codemirror/view'
  import { EditorState, StateField, StateEffect, type Extension } from '@codemirror/state'

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
  type BlockSource = 'ours' | 'theirs' | 'mixed'
  interface ApplyBlockEffect { idx: number; side: 'ours' | 'theirs'; newTo: number }
  const applyBlock = StateEffect.define<ApplyBlockEffect>()
  const editInside = StateEffect.define<number>()  // block index → mark mixed
  // Undo inverse: restores {source, from, to} snapshot captured pre-apply.
  // Without this, Cmd+Z restores the TEXT but the block stays marked as the
  // new source (arrow stays dimmed, highlight wrong, counter wrong).
  const restoreBlock = StateEffect.define<{ idx: number; from: number; to: number; source: BlockSource }>()
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
        let result: CenterBlock[] = tr.changes.empty ? blocks : blocks.map(b => ({
          ...b,
          from: tr.changes.mapPos(b.from, 1),
          to: tr.changes.mapPos(b.to, -1),
        }))
        // Effects override mapped positions for the target block. applyBlock
        // carries `newTo` because mapPos(to, -1) maps the OLD range's end to
        // the deletion point, not to the end of the NEW insert.
        for (const e of tr.effects) {
          if (e.is(applyBlock)) {
            const { idx, side, newTo } = e.value
            // from: pre-mapped by the pass above — but for pure-insertion case
            // (old from===to), mapPos(from,1) with assoc=1 jumps PAST the
            // insert. The block's from should STAY at the insertion point.
            // Use assoc=-1 to stick left of the insert start.
            const origFrom = blocks[idx].from
            result = result.map((b, i) => i === idx
              ? { from: tr.changes.mapPos(origFrom, -1), to: newTo, source: side }
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
  import { diffBlocks, blocksToLineSets, type ChangeBlock } from './merge-diff'
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
    /** Which side the center currently has. Arrow dims when it matches THIS side. */
    source: BlockSource
    /** true for pure insertions on the flank side (no content to pull) */
    empty: boolean
  }
  let oursArrows: ArrowSlot[] = $state([])
  let theirsArrows: ArrowSlot[] = $state([])
  let scrollTop = $state(0)

  // Immutable at mount (parent uses {#key mergingPath}). Flank content never
  // changes; only center edits matter and those are tracked via StateField.
  // untrack silences state_referenced_locally — prop IS mount-invariant here.
  const oursLines = untrack(() => sides.ours).split('\n')
  const theirsLines = untrack(() => sides.theirs).split('\n')

  // blocks[i] is the merge unit for arrow i. aFrom/aTo = ours lines,
  // bFrom/bTo = theirs (= initial center) lines. Both 1-indexed half-open.
  const blocks: ChangeBlock[] = diffBlocks(oursLines, theirsLines)

  // StateField instance — retained so we can read .state.field(trackerField).
  let trackerField: StateField<CenterBlock[]> | undefined

  const ROW_H = 18  // matches cmTheme .cm-line lineHeight

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
    // Center doc starts as theirs, so bFrom/bTo map directly.
    const initialTrack: CenterBlock[] = blocks.map(b => {
      const doc = tv.state.doc  // theirs doc (same shape as center's initial)
      // bFrom===bTo (pure insertion) → from===to (zero-width marker at line start)
      const from = b.bFrom <= doc.lines ? doc.line(b.bFrom).from : doc.length
      const to = b.bTo - 1 <= doc.lines && b.bTo > b.bFrom ? doc.line(b.bTo - 1).to : from
      return { from, to, source: 'theirs' as const }  // seeded with theirs
    })
    const tracker = blockTracker(initialTrack)
    trackerField = tracker

    const cv = new EditorView({
      state: EditorState.create({
        doc: sides.theirs,  // seed with theirs
        extensions: [
          ...sharedExts,
          history(),
          // Undo restores TEXT but not StateField state. Register inverse
          // effects so Cmd+Z after an arrow click also restores the block's
          // prior {from, to, source} — otherwise arrow stays dimmed, highlight
          // stays wrong, counter stays wrong.
          invertedEffects.of(tr => {
            // editInside is NOT inverted — it's dispatched as an effect-only
            // transaction from updateListener (no doc change → not in history).
            for (const e of tr.effects) {
              if (e.is(applyBlock)) {
                const old = tr.startState.field(tracker)[e.value.idx]
                return [restoreBlock.of({ idx: e.value.idx, ...old })]
              }
            }
            return []
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
            // Detect user edits INSIDE a block (not via arrow) → mark mixed.
            // Arrow clicks dispatch applyBlock which sets source explicitly,
            // so this only catches hand-edits.
            if (!u.transactions.some(t => t.effects.some(e => e.is(applyBlock)))) {
              const tracked = u.state.field(tracker)
              const effects: StateEffect<number>[] = []
              u.changes.iterChanges((fromA, toA) => {
                for (let i = 0; i < tracked.length; i++) {
                  const b = tracked[i]
                  if (b.source !== 'mixed' && fromA < b.to && toA > b.from) {
                    effects.push(editInside.of(i))
                  }
                }
              })
              if (effects.length) u.view.dispatch({ effects })
            }
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
   *  Arrow Y = pixel offset of the block's first line in the FLANK pane
   *  (flanks are read-only → stable line positions). */
  function refreshArrows() {
    if (!centerView || !trackerField) return
    const tracked = centerView.state.field(trackerField)
    // Empty range (from===to) means the flank side DELETED here — no content
    // to pull, so hide that arrow. Anchor it to the line before the gap.
    const slot = (from: number, to: number, source: BlockSource): ArrowSlot => ({
      y: ((from < to ? from : Math.max(1, from - 1)) - 1) * ROW_H,
      empty: from === to,
      source,
    })
    const o: ArrowSlot[] = []
    const t: ArrowSlot[] = []
    for (let i = 0; i < blocks.length; i++) {
      const src = tracked[i].source
      o.push(slot(blocks[i].aFrom, blocks[i].aTo, src))
      t.push(slot(blocks[i].bFrom, blocks[i].bTo, src))
    }
    oursArrows = o
    theirsArrows = t
  }

  /** Apply flank content for block `idx` into center at its tracked position.
   *  No-op if center already contains that side's content (idempotent). */
  function takeBlock(idx: number, side: 'ours' | 'theirs') {
    if (!centerView || !trackerField) return
    const tracked = centerView.state.field(trackerField)
    const pos = tracked[idx]
    if (!pos) return
    // Idempotent: clicking → twice doesn't overwrite. User feedback was
    // "clicking multiple times shouldn't overwrite text" — they meant re-apply
    // of the SAME side. Switching sides (→ then ←) still works.
    if (pos.source === side) return

    const blk = blocks[idx]
    const srcLines = side === 'ours' ? oursLines : theirsLines
    const from1 = side === 'ours' ? blk.aFrom : blk.bFrom
    const to1 = side === 'ours' ? blk.aTo : blk.bTo
    let insert = srcLines.slice(from1 - 1, to1 - 1).join('\n')

    // Line-boundary surgery. pos.from is line-start, pos.to is line-end (no
    // trailing \n — CM6's line.to excludes the line break).
    let { from, to } = pos
    if (from === to) {
      // Zero-width position (pure-insertion block, or prior apply deleted all).
      // Add trailing \n so insert becomes its own line(s), not prepended.
      if (insert) insert += '\n'
    } else if (!insert) {
      // Deleting a non-empty region (flank side is empty for this block).
      // Extend `to` through newline so we don't leave a blank line.
      if (to < centerView.state.doc.length) to += 1
    }

    // Compute where the block's new `to` will land AFTER the insertion. The
    // tracker's mapPos would map old-to to the deletion point (=from), not to
    // the end of the new insert. Explicit computation: from + insert.length,
    // minus the trailing \n we added (so `to` sits at line-end not next-line-start).
    const newTo = from + insert.length - (from === to && insert ? 1 : 0)

    centerView.dispatch({
      changes: { from, to, insert },
      effects: applyBlock.of({ idx, side, newTo }),
      scrollIntoView: true,
    })
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
    // Allow browser-level shortcuts (Cmd-R, Cmd-W, devtools) to pass.
    if (e.metaKey || e.ctrlKey) {
      // Except Cmd-S — MergePanel handles it, but if focus is on a button
      // (not CM6), the keymap won't fire. Handle it here too.
      if (e.key === 's') { e.preventDefault(); save(); return }
      return
    }
    if (e.key === 'Escape') { tryCancel(); e.stopPropagation(); return }
    e.stopPropagation()
  }

  // Count blocks still unresolved (arrow still active on at least one side).
  // "Resolved" = user has made an explicit choice. 'theirs' is the initial
  // state (center seeded with theirs), so it counts as unresolved until the
  // user either clicks ← (confirming theirs) or → (taking ours) or hand-edits.
  // We approximate: a block is resolved once it's NOT 'theirs'. Clicking ←
  // on a theirs block is a no-op (idempotent), so this doesn't flip it — but
  // that's fine: explicitly keeping theirs IS implicit by saving as-is.
  let pendingCount = $derived(oursArrows.filter(a => a.source === 'theirs').length)
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class="merge-panel" onkeydown={swallowKeydown}>
  <div class="merge-toolbar">
    <span class="merge-title">⧉ <code>{filePath}</code></span>
    {#if blocks.length > 0}
      <span class="merge-counter" class:merge-done={pendingCount === 0}>
        {blocks.length - pendingCount}/{blocks.length}
      </span>
    {/if}
    {#if error}<span class="merge-error" title={error}>⚠ {error}</span>{/if}
    <span class="merge-spacer"></span>
    <button class="merge-btn" onclick={cycle} title="Toggle pane visibility">
      {hiddenFlank === null ? '◫◫◫' : hiddenFlank === 'theirs' ? '◫◫▯' : '▯◫◫'}
    </button>
    <button class="merge-btn merge-save" onclick={save} disabled={busy} title="Save (⌘S)">
      {busy ? 'Saving…' : 'Save'}
    </button>
    <button class="merge-btn" onclick={tryCancel} disabled={busy} title="Cancel (Esc)">Cancel</button>
  </div>

  <div class="merge-headers">
    {#if hiddenFlank !== 'ours'}
      <div class="merge-header merge-header-ours">⬅ {sides.oursLabel || 'Ours (side #1)'}</div>
    {/if}
    <div class="merge-header merge-header-center">✎ Result</div>
    {#if hiddenFlank !== 'theirs'}
      <div class="merge-header merge-header-theirs">{sides.theirsLabel || 'Theirs (side #2)'} ➡</div>
    {/if}
  </div>

  <div class="merge-panes">
    <div class="merge-pane" class:merge-hidden={hiddenFlank === 'ours'} bind:this={oursEl}></div>
    <!-- Ours gutter: arrows point → (content flows ours → center) -->
    <div class="merge-gutter merge-gutter-ours" class:merge-hidden={hiddenFlank === 'ours'}>
      {#each oursArrows as slot, i (i)}
        {#if !slot.empty}
          <button
            class="merge-arrow merge-arrow-ours"
            class:merge-arrow-applied={slot.source === 'ours'}
            style="transform: translateY({slot.y - scrollTop}px)"
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
      {#each theirsArrows as slot, i (i)}
        {#if !slot.empty}
          <button
            class="merge-arrow merge-arrow-theirs"
            class:merge-arrow-applied={slot.source === 'theirs'}
            style="transform: translateY({slot.y - scrollTop}px)"
            onclick={() => takeBlock(i, 'theirs')}
            title={slot.source === 'theirs' ? 'Already using theirs' : 'Take theirs for this hunk'}
            aria-label="Take theirs for hunk {i + 1}"
          >←</button>
        {/if}
      {/each}
    </div>
    <div class="merge-pane" class:merge-hidden={hiddenFlank === 'theirs'} bind:this={theirsEl}></div>
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
    width: 22px;
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
    left: 2px;
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
  .merge-arrow-applied {
    opacity: 0.25;
    background: var(--surface0);
    color: var(--subtext0);
  }
  .merge-arrow-applied:hover {
    /* Re-apply on hover: subtle lift but stays muted */
    opacity: 0.6;
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
  .merge-panes :global(.merge-from-mixed) {
    /* User hand-edited — neutral amber, no side indicator. */
    background: color-mix(in srgb, var(--amber) 10%, transparent);
  }
</style>
