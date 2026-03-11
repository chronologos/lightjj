<script lang="ts">
  import type { LogEntry, EvologEntry } from './api'
  import { parseDiffContent } from './diff-parser'
  import DiffFileView from './DiffFileView.svelte'
  import type { ContextMenuHandler } from './ContextMenu.svelte'

  interface Props {
    entries: EvologEntry[]
    loading: boolean
    selectedRevision: LogEntry | null
    height: number
    onrefresh: () => void
    onclose: () => void
    onrestoreversion?: (fromCommitId: string) => void
    oncontextmenu?: ContextMenuHandler
  }

  let { entries, loading, selectedRevision, height, onrefresh, onclose, onrestoreversion, oncontextmenu }: Props = $props()

  let selectedIdx: number = $state(-1)
  let entryListEl: HTMLDivElement | undefined = $state()

  // Diff arrives inline with each entry (rebase-safe inter_diff from the backend
  // template) — no per-click fetch needed.
  let selectedEntry = $derived(selectedIdx >= 0 ? entries[selectedIdx] : null)
  let parsedDiff = $derived(selectedEntry ? parseDiffContent(selectedEntry.diff) : [])

  function selectEntry(i: number) {
    selectedIdx = i
  }

  function handleEntryContextMenu(e: MouseEvent, entry: EvologEntry, i: number) {
    if (!oncontextmenu) return
    e.preventDefault()
    selectedIdx = i
    // Gate restore: i===0 is the current version (no-op); divergent change_id
    // means restore --to change_id is ambiguous (which /N?). jj undo recovers
    // from a fat-finger so no confirm gate — explicit wording is enough.
    const canRestore = i > 0 && onrestoreversion && !selectedRevision?.commit.divergent
    oncontextmenu([
      { label: `Copy commit ID (${entry.commit_id})`, action: () => navigator.clipboard.writeText(entry.commit_id) },
      { separator: true },
      { label: canRestore ? 'Restore this version (overwrites current tree)' : 'Restore this version', danger: true,
        disabled: !canRestore, action: () => onrestoreversion?.(entry.commit_id) },
    ], e.clientX, e.clientY)
  }

  function handleKeydown(e: KeyboardEvent) {
    if (entries.length === 0) return
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault()
        selectEntry(selectedIdx === -1 ? 0 : Math.min(selectedIdx + 1, entries.length - 1))
        break
      case 'ArrowUp':
        e.preventDefault()
        selectEntry(selectedIdx === -1 ? 0 : Math.max(selectedIdx - 1, 0))
        break
    }
  }

  // Auto-focus entry list once when entries first load — enables immediate arrow-key
  // step-through. The {#key} wrapper in App.svelte remounts this component on revision
  // nav, resetting `didAutoFocus`. Guard prevents focus-steal on future live-refresh.
  let didAutoFocus = false
  $effect(() => {
    if (!didAutoFocus && entries.length > 0 && entryListEl) {
      didAutoFocus = true
      entryListEl.focus()
    }
  })

  // Scroll selected entry into view on keyboard nav.
  $effect(() => {
    if (selectedIdx >= 0) {
      entryListEl?.querySelector('.evolog-entry.selected')?.scrollIntoView({ block: 'nearest' })
    }
  })
</script>

<div class="evolog-panel" style:height="{height}px">
  <div class="panel-header">
    <span class="panel-title">
      Evolution Log <kbd class="nav-hint">↑</kbd><kbd class="nav-hint">↓</kbd>
      {#if selectedRevision}
        <span class="header-change-id">{selectedRevision.commit.change_id.slice(0, 12)}</span>
      {/if}
      {#if entries.length > 0}
        <span class="entry-count">· {entries.length} {entries.length === 1 ? 'entry' : 'entries'}</span>
      {/if}
    </span>
    <div class="panel-actions">
      {#if selectedRevision}
        <button class="header-btn" onclick={onrefresh}>Refresh</button>
      {/if}
      <button class="header-btn" onclick={onclose}>Close</button>
    </div>
  </div>

  <div class="evolog-body">
    <div class="entry-list" role="listbox" tabindex="-1" bind:this={entryListEl} onkeydown={handleKeydown}>
      {#if loading && entries.length === 0}
        <div class="empty-state">
          <div class="spinner"></div>
          <span>Loading evolution log...</span>
        </div>
      {:else if entries.length === 0}
        <div class="empty-state">Select a revision to view its evolution</div>
      {:else}
        {#each entries as entry, i (entry.commit_id)}
          {@const extraPreds = entry.predecessor_ids.length - 1}
          <button
            class="evolog-entry"
            class:selected={i === selectedIdx}
            class:current={i === 0}
            class:origin={entry.predecessor_ids.length === 0}
            onclick={() => selectEntry(i)}
            oncontextmenu={(e) => handleEntryContextMenu(e, entry, i)}
          >
            <span class="entry-id">{entry.commit_id}</span>
            <span class="entry-op">
              {entry.operation}
              {#if extraPreds > 0}<span class="entry-multi" title="{extraPreds + 1} predecessors">(+{extraPreds})</span>{/if}
            </span>
            <span class="entry-time">{entry.time.slice(0, 19)}</span>
          </button>
        {/each}
      {/if}
    </div>

    <div class="diff-area">
      {#if !selectedEntry}
        <div class="empty-state">Click an entry to see what changed in that step</div>
      {:else if selectedEntry.predecessor_ids.length === 0}
        <div class="empty-state">Initial entry — no predecessor to diff against</div>
      {:else if parsedDiff.length === 0}
        <div class="empty-state">No changes (metadata-only operation)</div>
      {:else}
        {#each parsedDiff as file (file.filePath)}
          <DiffFileView
            {file}
            fileStats={undefined}
            isCollapsed={false}
            isExpanded={false}
            splitView={false}
            highlightedLines={new Map()}
            wordDiffs={new Map()}
            ontoggle={() => {}}
            onexpand={() => {}}
          />
        {/each}
      {/if}
    </div>
  </div>
</div>

<style>
  .evolog-panel {
    border-top: 1px solid var(--surface1);
    flex-shrink: 0;
    display: flex;
    flex-direction: column;
    min-height: 0;
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

  .header-change-id {
    color: var(--amber);
    text-transform: none;
    letter-spacing: normal;
    font-weight: 700;
  }

  .entry-count {
    color: var(--subtext0);
    text-transform: none;
    letter-spacing: normal;
    font-weight: 400;
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

  .evolog-body {
    flex: 1;
    display: flex;
    min-height: 0;
  }

  .entry-list {
    width: 340px;
    flex-shrink: 0;
    overflow-y: auto;
    border-right: 1px solid var(--surface0);
    font-size: 12px;
    outline: none;
  }

  .evolog-entry {
    display: flex;
    align-items: baseline;
    gap: 10px;
    width: 100%;
    padding: 4px 12px;
    border: none;
    border-bottom: 1px solid var(--border-hunk-header);
    background: transparent;
    cursor: pointer;
    font-family: inherit;
    font-size: 12px;
    text-align: left;
  }

  .evolog-entry:hover:not(.selected) {
    background: var(--bg-hover);
  }

  .evolog-entry.selected {
    background: var(--bg-checked);
  }

  .evolog-entry.current .entry-id {
    color: var(--amber);
  }

  .evolog-entry.origin {
    opacity: 0.6;
  }

  .entry-id {
    font-family: var(--font-mono);
    color: var(--subtext0);
    font-weight: 600;
    font-size: 11px;
    flex-shrink: 0;
    width: 96px;
  }

  .entry-op {
    flex: 1;
    color: var(--text);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .entry-multi {
    color: var(--overlay0);
    font-size: 10px;
    margin-left: 4px;
  }

  .entry-time {
    color: var(--surface2);
    font-size: 10px;
    flex-shrink: 0;
    white-space: nowrap;
  }

  .diff-area {
    flex: 1;
    overflow-y: auto;
    min-width: 0;
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
