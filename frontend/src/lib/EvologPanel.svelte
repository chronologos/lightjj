<script lang="ts">
  import type { LogEntry } from './api'

  interface Props {
    content: string
    loading: boolean
    selectedRevision: LogEntry | null
    onrefresh: () => void
    onclose: () => void
  }

  let { content, loading, selectedRevision, onrefresh, onclose }: Props = $props()
</script>

<div class="evolog-panel">
  <div class="panel-header">
    <span class="panel-title">
      Evolution Log
      {#if selectedRevision}
        <span class="header-change-id">{selectedRevision.commit.change_id.slice(0, 12)}</span>
      {/if}
    </span>
    <div class="panel-actions">
      {#if selectedRevision}
        <button class="header-btn" onclick={onrefresh}>Refresh</button>
      {/if}
      <button class="header-btn" onclick={onclose}>Close</button>
    </div>
  </div>
  <div class="evolog-content">
    {#if loading}
      <div class="empty-state">
        <div class="spinner"></div>
        <span>Loading evolution log...</span>
      </div>
    {:else if content}
      <pre class="evolog-pre">{content}</pre>
    {:else}
      <div class="empty-state">Select a revision to view its evolution</div>
    {/if}
  </div>
</div>

<style>
  .evolog-panel {
    border-top: 1px solid var(--surface1);
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

  .evolog-content {
    overflow-y: auto;
    font-size: 12px;
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

  .evolog-pre {
    margin: 0;
    padding: 8px 12px;
    font-family: inherit;
    font-size: 12px;
    line-height: 1.5;
    color: var(--text);
    white-space: pre-wrap;
    overflow-wrap: break-word;
  }
</style>
