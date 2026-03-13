<script lang="ts">
  import { api, type OpEntry } from './api'
  import type { ContextMenuHandler } from './ContextMenu.svelte'

  interface Props {
    entries: OpEntry[]
    loading: boolean
    error?: string
    onrefresh: () => void
    onclose: () => void
    onopundo?: (opId: string) => void
    onoprestore?: (opId: string) => void
    oncontextmenu?: ContextMenuHandler
  }

  let { entries, loading, error = '', onrefresh, onclose, onopundo, onoprestore, oncontextmenu }: Props = $props()

  let selectedIdx = $state(-1)
  let contentEl: HTMLElement | undefined

  // Single-op expansion — `jj op show` output, displayed verbatim below the
  // selected row. Keyed by op.id (not index) so j/k away-and-back doesn't
  // refetch; refresh (entries change) wipes it via the reset effect below.
  let expandedId = $state('')
  let expandedOutput = $state('')
  let expandLoading = $state(false)

  // Reset selection on refresh — oplog prepends new ops at HEAD so the same
  // index points to a different operation after undo/restore. Also wipes
  // expansion — op IDs survive refresh but the content we'd show is stale
  // relative to what just happened.
  $effect(() => { void entries; selectedIdx = -1; expandedId = ''; expandedOutput = '' })

  async function toggleExpand(op: OpEntry) {
    if (expandedId === op.id) { expandedId = ''; return }
    expandedId = op.id
    expandedOutput = ''
    expandLoading = true
    try {
      const { output } = await api.opShow(op.id)
      // Post-await guard: user j'd to another op and hit Enter during fetch.
      if (expandedId !== op.id) return
      expandedOutput = output
    } catch (e) {
      if (expandedId !== op.id) return
      expandedOutput = `Error: ${e instanceof Error ? e.message : String(e)}`
    } finally {
      if (expandedId === op.id) expandLoading = false
    }
  }

  function handleKeydown(e: KeyboardEvent) {
    if (e.key === 'Escape') { e.preventDefault(); onclose(); return }
    if (entries.length === 0) return
    const move = (delta: 1 | -1) => {
      e.preventDefault()
      selectedIdx = selectedIdx === -1 ? 0
        : Math.max(0, Math.min(selectedIdx + delta, entries.length - 1))
    }
    switch (e.key) {
      case 'j': case 'ArrowDown': move(1); break
      case 'k': case 'ArrowUp': move(-1); break
      case 'Enter':
        if (selectedIdx < 0) return
        e.preventDefault()
        toggleExpand(entries[selectedIdx])
        break
    }
  }

  // Auto-focus when entries load so j/k works immediately. The {#if oplogOpen}
  // wrapper in App.svelte remounts the panel on open, resetting didAutoFocus.
  let didAutoFocus = false
  $effect(() => {
    if (!didAutoFocus && entries.length > 0 && contentEl) {
      didAutoFocus = true
      contentEl.focus()
    }
  })

  $effect(() => {
    if (selectedIdx >= 0) {
      contentEl?.querySelector('.oplog-entry.selected')?.scrollIntoView({ block: 'nearest' })
    }
  })

  function openMenuFor(op: OpEntry, x: number, y: number) {
    oncontextmenu?.([
      { label: expandedId === op.id ? 'Collapse' : 'Show details', shortcut: 'Enter',
        action: () => toggleExpand(op) },
      { label: `Copy op ID (${op.id})`, action: () => navigator.clipboard.writeText(op.id) },
      { separator: true },
      { label: 'Undo this operation', danger: true, disabled: op.is_current || !onopundo,
        action: () => onopundo?.(op.id) },
      { label: 'Restore to here', danger: true, disabled: op.is_current || !onoprestore,
        action: () => onoprestore?.(op.id) },
    ], x, y)
  }
</script>

<div class="oplog-panel">
  <div class="panel-header">
    <span class="panel-title">Operation Log <kbd class="nav-hint">j</kbd><kbd class="nav-hint">k</kbd><kbd class="nav-hint">Enter</kbd></span>
    <div class="panel-actions">
      <button class="header-btn" onclick={onrefresh}>Refresh</button>
      <button class="header-btn" onclick={onclose}>Close</button>
    </div>
  </div>
  <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
  <div class="oplog-content" role="listbox" tabindex="-1" bind:this={contentEl} onkeydown={handleKeydown}>
    {#if loading}
      <div class="empty-state">
        <div class="spinner"></div>
        <span>Loading operations...</span>
      </div>
    {:else if error}
      <div class="empty-state error-state">
        <span>⚠ {error}</span>
        <button class="header-btn" onclick={onrefresh}>Retry</button>
      </div>
    {:else}
      {#each entries as op, i (op.id)}
        <!-- svelte-ignore a11y_click_events_have_key_events -->
        <div
          class="oplog-entry"
          class:oplog-current={op.is_current}
          class:selected={selectedIdx === i}
          onclick={() => { selectedIdx = i }}
          ondblclick={() => { selectedIdx = i; toggleExpand(op) }}
          oncontextmenu={(e) => { e.preventDefault(); selectedIdx = i; openMenuFor(op, e.clientX, e.clientY) }}
          role="option"
          aria-selected={selectedIdx === i}
          tabindex="-1"
        >
          <span class="oplog-id">{op.id}</span>
          <span class="oplog-desc">{op.description}</span>
          <span class="oplog-time">{op.time}</span>
        </div>
        {#if expandedId === op.id}
          <pre class="oplog-expand">{expandLoading ? 'Loading…' : expandedOutput}</pre>
        {/if}
      {:else}
        <div class="empty-state">No operations</div>
      {/each}
    {/if}
  </div>
</div>

<style>
  .oplog-panel {
    border-top: 1px solid var(--surface1);
    flex: 1;
    max-height: 200px;
    display: flex;
    flex-direction: column;
    min-height: 0;
  }

  /* When used as fullwidth view via .fullwidth-panel parent */
  :global(.fullwidth-panel) .oplog-panel {
    max-height: none;
    border-top: none;
  }

  .panel-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    height: 34px;
    padding: 0 12px;
    background: var(--mantle);
    border-bottom: 1px solid var(--surface0);
    flex-shrink: 0;
    user-select: none;
  }

  .panel-title {
    font-size: 11px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--subtext1);
  }

  .panel-actions {
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .header-btn {
    background: transparent;
    border: 1px solid var(--surface1);
    color: var(--subtext0);
    padding: 2px 8px;
    border-radius: 3px;
    cursor: pointer;
    font-family: inherit;
    font-size: 11px;
    transition: all 0.15s ease;
  }

  .header-btn:hover {
    background: var(--surface0);
    color: var(--text);
  }

  .oplog-content {
    overflow-y: auto;
    font-size: 12px;
  }

  .oplog-entry {
    display: flex;
    align-items: baseline;
    gap: 10px;
    padding: 3px 12px;
    border-bottom: 1px solid var(--border-hunk-header);
  }

  .oplog-entry:hover {
    background: var(--bg-hover);
  }

  .oplog-entry.oplog-current {
    background: var(--bg-checked);
  }

  .oplog-entry.selected {
    background: var(--bg-selected);
  }

  .oplog-content:focus {
    outline: none;
  }

  .oplog-id {
    font-family: var(--font-mono);
    color: var(--amber);
    font-weight: 600;
    font-size: 11px;
    flex-shrink: 0;
    width: 100px;
  }

  .oplog-desc {
    flex: 1;
    color: var(--text);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .oplog-time {
    color: var(--surface2);
    font-size: 11px;
    flex-shrink: 0;
    white-space: nowrap;
  }

  .oplog-expand {
    margin: 0;
    padding: 8px 12px 8px 24px;
    background: var(--mantle);
    border-bottom: 1px solid var(--surface0);
    font-family: var(--font-mono);
    font-size: 11px;
    line-height: 1.5;
    color: var(--subtext1);
    white-space: pre-wrap;
    overflow-x: auto;
    max-height: 300px;
    overflow-y: auto;
  }

  .empty-state {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 8px;
    padding: 48px 24px;
    color: var(--surface2);
    font-size: 13px;
  }

  .error-state {
    color: var(--red);
  }

  .spinner {
    width: 20px;
    height: 20px;
    border: 2px solid var(--surface0);
    border-top-color: var(--amber);
    border-radius: 50%;
    animation: spin 0.8s linear infinite;
  }

  @keyframes spin {
    to { transform: rotate(360deg); }
  }
</style>
