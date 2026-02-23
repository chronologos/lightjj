<script lang="ts">
  import type { OpEntry } from './api'

  interface Props {
    entries: OpEntry[]
    loading: boolean
    onrefresh: () => void
    onclose: () => void
  }

  let { entries, loading, onrefresh, onclose }: Props = $props()
</script>

<div class="oplog-panel">
  <div class="panel-header">
    <span class="panel-title">Operation Log</span>
    <div class="panel-actions">
      <button class="header-btn" onclick={onrefresh}>Refresh</button>
      <button class="header-btn" onclick={onclose}>Close</button>
    </div>
  </div>
  <div class="oplog-content">
    {#if loading}
      <div class="empty-state">
        <div class="spinner"></div>
        <span>Loading operations...</span>
      </div>
    {:else}
      {#each entries as op (op.id)}
        <div class="oplog-entry" class:oplog-current={op.is_current}>
          <span class="oplog-id">{op.id}</span>
          <span class="oplog-desc">{op.description}</span>
          <span class="oplog-time">{op.time}</span>
        </div>
      {:else}
        <div class="empty-state">No operations</div>
      {/each}
    {/if}
  </div>
</div>

<style>
  .oplog-panel {
    border-top: 1px solid var(--surface0);
    flex-shrink: 0;
    max-height: 200px;
    display: flex;
    flex-direction: column;
  }

  .panel-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    height: 34px;
    padding: 0 12px;
    background: var(--base);
    border-bottom: 1px solid var(--surface0);
    flex-shrink: 0;
    user-select: none;
  }

  .panel-title {
    font-size: 11px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--subtext0);
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

  .oplog-id {
    color: var(--blue);
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
    border-top-color: var(--blue);
    border-radius: 50%;
    animation: spin 0.8s linear infinite;
  }

  @keyframes spin {
    to { transform: rotate(360deg); }
  }
</style>
