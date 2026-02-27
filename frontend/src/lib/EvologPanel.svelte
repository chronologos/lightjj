<script lang="ts">
  import { api, type LogEntry, type EvologEntry } from './api'
  import { parseDiffContent } from './diff-parser'
  import { createLoader } from './loader.svelte'
  import DiffFileView from './DiffFileView.svelte'

  interface Props {
    entries: EvologEntry[]
    loading: boolean
    selectedRevision: LogEntry | null
    onrefresh: () => void
    onclose: () => void
  }

  let { entries, loading, selectedRevision, onrefresh, onclose }: Props = $props()

  let selectedIdx: number = $state(-1)

  // Using createLoader (not manual state) avoids the spinner-freeze bug where
  // clicking a no-predecessor entry after an in-flight fetch leaves the prior
  // fetch's loading flag stuck (its finally-block gen check fails to clear it).
  const interDiff = createLoader(
    (pred: string, cur: string) => api.diffRange(pred, cur).then(r => r.diff),
    '',
  )

  let parsedDiff = $derived(parseDiffContent(interDiff.value))
  let selectedEntry = $derived(selectedIdx >= 0 ? entries[selectedIdx] : null)

  function selectEntry(i: number) {
    selectedIdx = i
    const entry = entries[i]
    const pred = entry?.predecessor_ids[0]
    if (pred) {
      interDiff.load(pred, entry.commit_id)
    } else {
      interDiff.reset()
    }
  }
</script>

<div class="evolog-panel">
  <div class="panel-header">
    <span class="panel-title">
      Evolution Log
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
    <div class="entry-list">
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
          >
            <span class="entry-id">{entry.commit_id}</span>
            <span class="entry-op">
              {entry.operation}
              {#if extraPreds > 0}<span class="entry-multi" title="{extraPreds + 1} predecessors; diff shown from first">(+{extraPreds})</span>{/if}
            </span>
            <span class="entry-time">{entry.time.slice(0, 19)}</span>
          </button>
        {/each}
      {/if}
    </div>

    <div class="diff-area">
      {#if interDiff.loading}
        <div class="empty-state">
          <div class="spinner"></div>
          <span>Loading diff...</span>
        </div>
      {:else if interDiff.error}
        <div class="empty-state error-state">
          <span>⚠ {interDiff.error}</span>
          <button class="header-btn" onclick={() => selectEntry(selectedIdx)}>Retry</button>
        </div>
      {:else if !selectedEntry}
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
    height: 360px;
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

  .error-state {
    color: var(--red);
  }

  .error-state span {
    max-width: 600px;
    text-align: center;
    word-break: break-word;
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
