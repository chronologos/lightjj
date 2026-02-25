<script lang="ts">
  import type { LogEntry } from './api'

  interface Props {
    revision: LogEntry
    draft: string
    onsave: () => void
    oncancel: () => void
    ondraftchange: (value: string) => void
    commitMode?: boolean
  }

  let { revision, draft, onsave, oncancel, ondraftchange, commitMode = false }: Props = $props()
</script>

<div class="desc-editor">
  <label class="desc-label" for="desc-textarea">{commitMode ? 'Commit' : 'Description for'} {revision.commit.change_id.slice(0, 12)}</label>
  <textarea
    id="desc-textarea"
    value={draft}
    oninput={(e: Event) => ondraftchange((e.target as HTMLTextAreaElement).value)}
    rows="4"
    placeholder="Enter commit description..."
    onkeydown={(e: KeyboardEvent) => {
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
        onsave()
      }
      if (e.key === 'Escape') {
        oncancel()
      }
    }}
  ></textarea>
  <div class="desc-actions">
    <button class="btn-primary" onclick={onsave}>
      {commitMode ? 'Commit' : 'Save'}
      <kbd>Cmd+Enter</kbd>
    </button>
    <button class="btn-secondary" onclick={oncancel}>Cancel</button>
  </div>
</div>

<style>
  .desc-editor {
    padding: 12px;
    border-bottom: 1px solid var(--surface0);
    background: var(--mantle);
  }

  .desc-label {
    display: block;
    font-size: 11px;
    color: var(--subtext0);
    margin-bottom: 6px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }

  .desc-editor textarea {
    width: 100%;
    background: var(--base);
    color: var(--text);
    border: 1px solid var(--surface1);
    border-radius: 4px;
    padding: 8px;
    font-family: inherit;
    font-size: 13px;
    resize: vertical;
    outline: none;
    transition: border-color 0.15s ease;
  }

  .desc-editor textarea:focus {
    border-color: var(--amber);
  }

  .desc-actions {
    display: flex;
    gap: 6px;
    margin-top: 8px;
  }

  .btn-primary {
    display: flex;
    align-items: center;
    gap: 6px;
    background: var(--amber);
    color: var(--base);
    border: none;
    padding: 4px 12px;
    border-radius: 4px;
    cursor: pointer;
    font-family: inherit;
    font-size: 12px;
    font-weight: 600;
  }

  .btn-primary:hover {
    background: var(--bg-btn-primary-hover);
  }

  .btn-primary kbd {
    background: var(--bg-btn-kbd);
    padding: 0 4px;
    border-radius: 2px;
    font-size: 10px;
    font-family: inherit;
  }

  .btn-secondary {
    background: transparent;
    color: var(--subtext0);
    border: 1px solid var(--surface1);
    padding: 4px 12px;
    border-radius: 4px;
    cursor: pointer;
    font-family: inherit;
    font-size: 12px;
  }

  .btn-secondary:hover {
    background: var(--surface0);
  }
</style>
