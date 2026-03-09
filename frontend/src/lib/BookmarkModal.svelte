<script lang="ts">
  import { tick } from 'svelte'
  import { api, type Bookmark } from './api'
  import { fuzzyMatch } from './fuzzy'
  import { recentActions } from './recent-actions.svelte'
  import { createConfirmGate } from './confirm-gate.svelte'
  import { trackOptions, type TrackOption } from './bookmark-sync'

  export interface BookmarkOp {
    action: 'move' | 'advance' | 'delete' | 'forget' | 'track' | 'untrack' | 'push-delete'
    bookmark: string
    remote?: string
  }

  interface Props {
    open: boolean
    currentCommitId: string | null
    filterBookmark: string
    onexecute: (op: BookmarkOp) => void
    ontrackmenu?: (bm: Bookmark, opts: TrackOption[], x: number, y: number) => void
  }

  let { open = $bindable(false), currentCommitId, filterBookmark, onexecute, ontrackmenu }: Props = $props()

  let query: string = $state('')
  let index: number = $state(0)
  let inputEl: HTMLInputElement | undefined = $state(undefined)
  let modalEl: HTMLDivElement | undefined = $state(undefined)
  let inputFocused: boolean = $state(false)
  let bookmarks: Bookmark[] = $state([])
  let remotes: string[] = $state([])
  let loading: boolean = $state(false)
  let fetchError: string | null = $state(null)
  let previousFocus: HTMLElement | null = null
  let fetchGen: number = 0

  const confirm = createConfirmGate<'d' | 'f' | 't'>()
  let armed = $derived(confirm.armed)

  // Frequency-sort by bookmark name (not by action) — if you've been touching
  // a bookmark you want it at the top regardless of which op you last used.
  const history = recentActions('bookmark-modal')

  let filtered = $derived.by(() => {
    if (!open) return []
    let bms = bookmarks
    if (filterBookmark) bms = bms.filter(b => b.name === filterBookmark)
    if (query) return bms.filter(b => fuzzyMatch(query, b.name))
    // No query: recent first. Hoist counts — history.count() parses
    // localStorage on every call; inside the sort comparator that's 2N·logN
    // synchronous JSON.parse calls.
    const counts = new Map(bms.map(b => [b.name, history.count(b.name)]))
    return [...bms].sort((a, b) => counts.get(b.name)! - counts.get(a.name)!)
  })

  let selected = $derived(filtered[index] as Bookmark | undefined)

  // Per-selection action availability. Drives footer hint dimming and key
  // handler guards. No forget entry — forget is always available for any
  // selection (only dimmed when nothing is selected).
  let can = $derived.by(() => {
    const bm = selected
    if (!bm) return { move: false, del: false, track: [] as TrackOption[] }
    return {
      move: !!currentCommitId && bm.commit_id !== currentCommitId,
      del: !!bm.local,
      track: trackOptions(bm, remotes),
    }
  })

  $effect(() => {
    if (open) {
      previousFocus = document.activeElement as HTMLElement | null
      query = ''
      index = 0
      confirm.disarm()
      loading = true
      fetchError = null
      const gen = ++fetchGen
      api.bookmarks({ local: true }).then(async (bms) => {
        if (gen !== fetchGen) return
        let rs: string[] = []
        try { rs = await api.remotes() } catch { /* optional */ }
        if (gen !== fetchGen) return // re-check: modal may have closed/reopened during remotes await
        bookmarks = bms
        remotes = rs
        loading = false
      }).catch((e) => { if (gen === fetchGen) { loading = false; fetchError = e.message || 'Failed to load' } })
      // {#if open} hasn't mounted yet on this tick — modalEl is undefined.
      // tick() resolves after DOM flush. Same pattern as ContextMenu/AnnotationBubble.
      tick().then(() => modalEl?.focus())
    }
  })

  $effect(() => {
    if (open && index >= filtered.length && filtered.length > 0) {
      index = filtered.length - 1
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

  function scrollActiveIntoView() {
    requestAnimationFrame(() => {
      modalEl?.querySelector('.bm-item-active')?.scrollIntoView({ block: 'nearest' })
    })
  }

  function handleKeydown(e: KeyboardEvent) {
    const bm = selected

    switch (e.key) {
      case 'ArrowDown':
      case 'j':
        if (e.key === 'j' && inputFocused) return
        e.preventDefault()
        disarm()
        if (inputFocused) modalEl?.focus()
        index = Math.min(index + 1, Math.max(filtered.length - 1, 0))
        scrollActiveIntoView()
        return
      case 'ArrowUp':
      case 'k':
        if (e.key === 'k' && inputFocused) return
        e.preventDefault()
        disarm()
        index = Math.max(index - 1, 0)
        scrollActiveIntoView()
        return
      case 'Enter':
        e.preventDefault()
        e.stopPropagation()
        moveSelected(bm)
        return
      case 'Escape':
        e.preventDefault()
        e.stopPropagation()
        if (armed) { disarm(); return }
        if (query) { query = ''; modalEl?.focus(); return }
        close()
        return
      case '/':
        if (inputFocused) return
        e.preventDefault()
        e.stopPropagation()
        disarm()
        inputEl?.focus()
        return
    }

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
        const rect = modalEl?.querySelector('.bm-item-active')?.getBoundingClientRect()
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
  <div class="bm-backdrop" onclick={close} role="presentation"></div>
  <div
    bind:this={modalEl}
    class="bm-modal"
    onkeydown={handleKeydown}
    role="dialog"
    aria-modal="true"
    aria-label="Bookmarks"
    aria-describedby="bm-footer"
    tabindex="-1"
  >
    <div class="bm-header">
      Bookmarks
      <span class="bm-header-hint"><kbd>/</kbd> to filter</span>
    </div>
    <input
      bind:this={inputEl}
      bind:value={query}
      class="bm-input"
      class:bm-input-collapsed={inputCollapsed}
      type="text"
      placeholder="Filter..."
      tabindex={inputCollapsed ? -1 : 0}
      aria-hidden={inputCollapsed}
      oninput={() => { index = 0; disarm() }}
      onfocus={() => { inputFocused = true }}
      onblur={() => { inputFocused = false }}
    />
    <!-- tabindex=-1: programmatically focusable (satisfies aria-activedescendant
         requirement) but not in tab order. Same pattern as RevisionGraph. -->
    <div
      class="bm-results"
      role="listbox"
      tabindex="-1"
      aria-label="Bookmarks"
      aria-activedescendant={selected ? `bm-opt-${index}` : undefined}
    >
      {#if loading}
        <div class="bm-empty">Loading...</div>
      {:else if fetchError}
        <div class="bm-empty bm-error" role="alert">{fetchError}</div>
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
            class:bm-item-active={i === index}
            onmousemove={() => { if (index !== i) { index = i; disarm() } }}
            onclick={() => moveSelected(bm)}
            role="option"
            tabindex="-1"
            aria-selected={i === index}
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
    <div id="bm-footer" class="bm-footer">
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
  .bm-backdrop {
    position: fixed;
    inset: 0;
    background: var(--backdrop);
    z-index: 100;
  }

  .bm-modal {
    position: fixed;
    top: 20%;
    left: 50%;
    transform: translateX(-50%);
    width: 520px;
    max-height: 420px;
    background: var(--base);
    border: 1px solid var(--surface1);
    border-radius: 8px;
    box-shadow: var(--shadow-heavy);
    z-index: 101;
    display: flex;
    flex-direction: column;
    overflow: hidden;
    outline: none;
  }

  .bm-header {
    display: flex;
    justify-content: space-between;
    align-items: baseline;
    padding: 10px 16px 6px;
    font-size: 12px;
    font-weight: 700;
    color: var(--subtext0);
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }

  .bm-header-hint {
    font-weight: 400;
    text-transform: none;
    letter-spacing: 0;
    color: var(--surface2);
  }

  .bm-input {
    width: 100%;
    background: var(--mantle);
    color: var(--text);
    border: none;
    border-bottom: 1px solid var(--surface0);
    padding: 8px 16px;
    font-family: inherit;
    font-size: 13px;
    outline: none;
    transition: max-height 0.12s ease, padding 0.12s ease, opacity 0.12s ease;
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

  .bm-input::placeholder { color: var(--surface2); }

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
    font-size: 13px;
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
    font-size: 11px;
    color: var(--overlay0);
  }

  .bm-here {
    font-size: 11px;
    color: var(--green);
  }

  .bm-badge {
    font-size: 10px;
    padding: 1px 6px;
    border-radius: 3px;
    background: var(--surface0);
    color: var(--overlay1);
  }

  .bm-badge-tracked { color: var(--blue); }
  .bm-badge-conflict { color: var(--red); background: color-mix(in srgb, var(--red) 15%, transparent); }

  .bm-footer {
    display: flex;
    flex-wrap: wrap;
    gap: 14px;
    padding: 8px 16px;
    border-top: 1px solid var(--surface0);
    font-size: 11px;
    color: var(--subtext0);
    background: var(--mantle);
  }

  .bm-footer .dim { opacity: 0.3; }

  .bm-confirm {
    color: var(--red);
    animation: bm-pulse 0.15s ease;
  }

  .bm-confirm b { font-weight: 600; }

  @keyframes bm-pulse {
    from { opacity: 0.4; }
    to { opacity: 1; }
  }

  .bm-remote {
    color: var(--overlay0);
  }

  kbd {
    display: inline-block;
    min-width: 14px;
    padding: 1px 4px;
    font-family: var(--font-mono, monospace);
    font-size: 10px;
    text-align: center;
    background: var(--surface0);
    border: 1px solid var(--surface1);
    border-radius: 3px;
    color: var(--text);
  }

  .bm-empty {
    padding: 16px;
    color: var(--surface2);
    text-align: center;
    font-size: 13px;
  }

  .bm-error { color: var(--red); }
</style>
