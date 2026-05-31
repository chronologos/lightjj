<script lang="ts">
  import { tick, untrack } from 'svelte'
  import { api, type Bookmark } from './api'
  import { createLoader } from './loader.svelte'
  import { fuzzyMatch } from './fuzzy'
  import { recentActions } from './recent-actions.svelte'
  import { createConfirmGate } from './confirm-gate.svelte'
  import { createListCursor } from './list-cursor.svelte'
  import { trackOptions, type TrackOption } from './bookmark-sync'

  export interface BookmarkOp {
    action: 'move' | 'advance' | 'delete' | 'forget' | 'track' | 'untrack' | 'push' | 'push-delete' | 'set-to-remote'
    bookmark: string
    remote?: string
  }

  interface Props {
    open: boolean
    currentCommitId: string | null
    filterBookmark: string
    /** commit_ids of the loaded log in display order — powers the "nearby" sort tier */
    logOrder?: string[]
    onexecute: (op: BookmarkOp) => void
    ontrackmenu?: (bm: Bookmark, opts: TrackOption[], x: number, y: number) => void
  }

  let { open = $bindable(false), currentCommitId, filterBookmark, logOrder = [], onexecute, ontrackmenu }: Props = $props()

  let query: string = $state('')
  let inputEl: HTMLInputElement | undefined = $state(undefined)
  let modalEl: HTMLDivElement | undefined = $state(undefined)
  let inputFocused: boolean = $state(false)
  let previousFocus: HTMLElement | null = null
  const bms = createLoader(() => api.bookmarks({ local: true }), [] as Bookmark[])

  const confirm = createConfirmGate<'d' | 'f' | 't'>()
  let armed = $derived(confirm.armed)

  // Last-used recency by bookmark name (not by action) — if you've been
  // touching a bookmark you want it at the top regardless of which op you
  // last used. Namespace shared with BookmarkInput.
  const history = recentActions('bookmark-modal')

  // Sort tiers for the no-query list: conflict > recently used > nearby.
  // "Recent" = touched via this modal / BookmarkInput within the window;
  // "nearby" = the bookmark's commit sits close to the selected revision in
  // the loaded log (row distance as a graph-distance proxy; off-log = FAR).
  const RECENT_WINDOW_MS = 7 * 24 * 60 * 60 * 1000
  // Finite (not Infinity) so the comparator never sees Infinity - Infinity = NaN.
  const FAR = Number.MAX_SAFE_INTEGER

  // Log row positions captured once per open — a background log refresh while
  // the modal is up must not re-sort the list under the cursor (or under a
  // half-armed d/f confirm). The open $effect untracks the reads so it
  // doesn't re-fire (and reset query/index) on every log refresh.
  let logRows: { byCommit: Map<string, number>; cur: number | undefined } = $state({ byCommit: new Map(), cur: undefined })

  let filtered = $derived.by(() => {
    if (!open) return []
    let list = bms.value
    if (filterBookmark) list = list.filter(b => b.name === filterBookmark)
    if (query) return list.filter(b => fuzzyMatch(query, b.name))
    // Conflict-first mirrors BookmarksPanel's trouble-first syncPriority — if
    // a bookmark is conflicted you opened this modal to resolve it.
    // snapshot()/destructure once: per-comparator reads would re-hit the
    // reactive sources N·logN times.
    const last = history.snapshot()
    const { byCommit, cur } = logRows
    const now = Date.now()
    const recency = (bm: Bookmark) => {
      const t = last[bm.name] ?? 0
      return now - t < RECENT_WINDOW_MS ? t : 0
    }
    const distance = (bm: Bookmark) => {
      const row = byCommit.get(bm.commit_id)
      return row === undefined || cur === undefined ? FAR : Math.abs(row - cur)
    }
    return [...list].sort((a, b) =>
      (+b.conflict - +a.conflict) ||
      (recency(b) - recency(a)) ||
      (distance(a) - distance(b))
    )
  })

  // Cursor/hover/keydown core via the shared factory. Hooks layer the modal's
  // domain semantics (confirm-gate disarm, tiered Escape, filter focus) on top.
  const cursor = createListCursor({
    count: () => filtered.length,
    container: () => modalEl,
    inputFocused: () => inputFocused,
    onLeaveInput: () => modalEl?.focus(),
    onNav: () => disarm(),
    onEnter: (e) => {
      e.stopPropagation()
      moveSelected(selected)
    },
    onEscape: (e) => {
      e.stopPropagation()
      if (armed) { disarm(); return }
      if (query) { query = ''; modalEl?.focus(); return }
      close()
    },
    onSlash: (e) => {
      e.stopPropagation()
      disarm()
      inputEl?.focus()
    },
    hoverMovesCursor: true,
    onHoverCursor: () => disarm(),
  })

  let selected = $derived(filtered[cursor.index] as Bookmark | undefined)

  // Per-selection action availability. Drives footer hint dimming and key
  // handler guards. No forget entry — forget is always available for any
  // selection (only dimmed when nothing is selected).
  let can = $derived.by(() => {
    const bm = selected
    if (!bm) return { move: false, del: false, track: [] as TrackOption[] }
    return {
      move: !!currentCommitId && bm.commit_id !== currentCommitId,
      del: !!bm.local,
      track: trackOptions(bm),
    }
  })

  $effect(() => {
    if (open) {
      previousFocus = document.activeElement as HTMLElement | null
      query = ''
      cursor.index = 0
      confirm.disarm()
      // Snapshot nearby-sort inputs (untracked — see logRows comment).
      const byCommit = new Map(untrack(() => logOrder).map((id, i) => [id, i]))
      logRows = { byCommit, cur: byCommit.get(untrack(() => currentCommitId) ?? '') }
      bms.load()
      // {#if open} hasn't mounted yet on this tick — modalEl is undefined.
      // tick() resolves after DOM flush. Same pattern as ContextMenu/AnnotationBubble.
      tick().then(() => modalEl?.focus())
    }
  })

  function close() {
    open = false
    previousFocus?.focus()
  }

  function fire(op: BookmarkOp) {
    history.record(op.bookmark)
    close()
    onexecute(op)
  }

  function disarm() { confirm.disarm() }

  function moveSelected(bm: Bookmark | undefined) {
    disarm()
    if (bm && can.move) fire({ action: 'move', bookmark: bm.name })
  }

  function handleKeydown(e: KeyboardEvent) {
    // Nav (j/k/arrows), Enter, Escape, '/' route through the cursor factory.
    if (cursor.handleKey(e)) return

    const bm = selected

    // Action keys — only when not typing in the filter. preventDefault
    // unconditionally so guarded-off keys don't bubble to App.svelte's
    // global handler (anyModalOpen guard catches them today, but that's a
    // load-bearing coincidence).
    if (inputFocused || !bm) return
    switch (e.key) {
      case 'a':
        // advance: forward-only move. jj refuses backwards/sideways, so no
        // confirm gate — wrong bookmark is harmless. Same gate as move.
        e.preventDefault()
        disarm()
        if (can.move) fire({ action: 'advance', bookmark: bm.name })
        return
      case 'd':
        e.preventDefault()
        if (!can.del) { disarm(); return }
        if (confirm.gate('d', true)) return
        fire({ action: 'delete', bookmark: bm.name })
        return
      case 'f':
        e.preventDefault()
        if (confirm.gate('f', true)) return
        fire({ action: 'forget', bookmark: bm.name })
        return
      case 't': {
        e.preventDefault()
        const opts = can.track
        if (opts.length === 0) { disarm(); return }
        if (opts.length === 1) {
          const t = opts[0]
          if (confirm.gate('t', t.action === 'untrack')) return
          fire({ action: t.action, bookmark: bm.name, remote: t.remote })
          return
        }
        // Multi-remote: open submenu at the active row. Modal closes so the
        // ContextMenu can receive focus — tick() ensures unmount completes
        // before the menu's own mount-focus effect fires.
        disarm()
        const rect = modalEl?.querySelector(`[data-idx="${cursor.index}"]`)?.getBoundingClientRect()
        const x = rect ? rect.right - 40 : window.innerWidth / 2
        const y = rect ? rect.top + rect.height / 2 : window.innerHeight / 2
        close()
        tick().then(() => ontrackmenu?.(bm, opts, x, y))
        return
      }
      default:
        // Any unhandled key disarms. Prevents stale armed state when the
        // user fat-fingers a letter between the two presses.
        disarm()
    }
  }

  let inputCollapsed = $derived(!query && !inputFocused)
</script>

{#if open}
  <div class="modal-backdrop" onclick={close} role="presentation"></div>
  <div
    bind:this={modalEl}
    class="modal"
    onkeydown={handleKeydown}
    role="dialog"
    aria-modal="true"
    aria-label="Bookmarks"
    aria-describedby="bm-footer"
    tabindex="-1"
  >
    <div class="modal-header">
      Bookmarks
      <span class="bm-header-hint"><kbd class="key">/</kbd> to filter</span>
    </div>
    <input
      bind:this={inputEl}
      bind:value={query}
      class="modal-input"
      class:bm-input-collapsed={inputCollapsed}
      type="text"
      placeholder="Filter..."
      tabindex={inputCollapsed ? -1 : 0}
      aria-hidden={inputCollapsed}
      oninput={() => { cursor.index = 0; disarm() }}
      onfocus={() => { inputFocused = true }}
      onblur={() => { inputFocused = false }}
    />
    <!-- tabindex=-1: programmatically focusable (satisfies aria-activedescendant
         requirement) but not in tab order. Same pattern as RevisionGraph.
         Hover moves the cursor via the factory's delegated mousemove (no
         per-row handlers, no :hover). -->
    <div
      class="bm-results"
      role="listbox"
      tabindex="-1"
      aria-label="Bookmarks"
      aria-activedescendant={selected ? `bm-opt-${cursor.index}` : undefined}
      onmousemove={cursor.onRowsMouseMove}
      onmouseleave={cursor.onRowsMouseLeave}
    >
      {#if bms.loading}
        <div class="bm-empty">Loading...</div>
      {:else if bms.error}
        <div class="bm-empty bm-error" role="alert">{bms.error}</div>
      {:else if filtered.length === 0}
        <div class="bm-empty">No matching bookmarks</div>
      {:else}
        {#each filtered as bm, i (bm.name)}
          {@const here = bm.commit_id === currentCommitId}
          {@const tracked = bm.remotes?.find(r => r.tracked)}
          <!-- svelte-ignore a11y_click_events_have_key_events -- Enter on the
               modal's onkeydown fires the same action as click. -->
          <div
            id="bm-opt-{i}"
            class="bm-item"
            class:bm-item-active={i === cursor.index}
            data-idx={i}
            onclick={() => moveSelected(bm)}
            role="option"
            tabindex="-1"
            aria-selected={i === cursor.index}
          >
            <span class="bm-name">{bm.name}</span>
            {#if here}
              <span class="bm-here">→ here</span>
            {:else}
              <span class="bm-commit">{bm.commit_id.slice(0, 8)}</span>
            {/if}
            {#if bm.conflict}
              <span class="bm-badge bm-badge-conflict">conflict</span>
            {:else if tracked}
              <span class="bm-badge bm-badge-tracked">⊙ {tracked.remote}</span>
            {:else if bm.local}
              <span class="bm-badge">○ local</span>
            {/if}
          </div>
        {/each}
      {/if}
    </div>
    <div id="bm-footer" class="key-footer">
      {#if armed === 'd'}
        <span class="bm-confirm"><kbd>d</kbd> again to delete <b>{selected?.name}</b> · Esc to cancel</span>
      {:else if armed === 'f'}
        <span class="bm-confirm"><kbd>f</kbd> again to forget <b>{selected?.name}</b> · Esc to cancel</span>
      {:else if armed === 't'}
        <span class="bm-confirm"><kbd>t</kbd> again to untrack <b>{selected?.name}@{can.track[0]?.remote}</b> · Esc to cancel</span>
      {:else}
        <span class:dim={!can.move}><kbd>⏎</kbd> move here</span>
        <span class:dim={!can.move}><kbd>a</kbd> advance</span>
        <span class:dim={!can.del}><kbd>d</kbd> delete</span>
        <span class:dim={!selected}><kbd>f</kbd> forget</span>
        <span class:dim={can.track.length === 0}>
          <kbd>t</kbd>
          {#if can.track.length === 1}
            {can.track[0].action} <span class="bm-remote">({can.track[0].remote})</span>
          {:else if can.track.length > 1}
            track/untrack…
          {:else}
            track
          {/if}
        </span>
      {/if}
    </div>
  </div>
{/if}

<style>
  .bm-header-hint {
    font-weight: 400;
    text-transform: none;
    letter-spacing: 0;
    color: var(--text-faint);
  }

  .modal-input {
    transition: max-height var(--anim-duration) var(--anim-ease), padding var(--anim-duration) var(--anim-ease), opacity var(--anim-duration) var(--anim-ease);
    max-height: 40px;
  }

  /* Collapse the input when unused — recency sort + action keys mean most
     interactions never touch the filter. / expands it. */
  .bm-input-collapsed {
    max-height: 0;
    padding-top: 0;
    padding-bottom: 0;
    border-bottom-width: 0;
    opacity: 0;
  }

  .bm-results {
    overflow-y: auto;
    padding: 4px 0;
    flex: 1;
    min-height: 0;
  }

  .bm-item {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 6px 16px;
    font-size: var(--font-size);
    user-select: none;
    cursor: pointer;
  }

  .bm-item-active { background: var(--surface0); }

  .bm-name {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .bm-commit {
    font-family: var(--font-mono, monospace);
    font-size: var(--fs-sm);
    color: var(--overlay0);
  }

  .bm-here {
    font-size: var(--fs-sm);
    color: var(--green);
  }

  .bm-badge {
    font-size: var(--fs-xs);
    padding: 1px 6px;
    border-radius: 3px;
    background: var(--surface0);
    color: var(--overlay1);
  }

  .bm-badge-tracked { color: var(--blue); }
  .bm-badge-conflict { color: var(--red); background: color-mix(in srgb, var(--red) 15%, transparent); }


  .bm-confirm {
    color: var(--red);
    animation: bm-pulse var(--anim-duration) ease;
  }

  .bm-confirm b { font-weight: 600; }

  @keyframes bm-pulse {
    from { opacity: 0.4; }
    to { opacity: 1; }
  }

  .bm-remote {
    color: var(--overlay0);
  }


  .bm-empty {
    padding: 16px;
    color: var(--text-faint);
    text-align: center;
    font-size: var(--font-size);
  }

  .bm-error { color: var(--red); }
</style>
