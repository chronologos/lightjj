<script lang="ts">
  import { onMount } from 'svelte'
  import type { LogEntry } from './api'

  interface Props {
    revision: LogEntry
    draft: string
    onsave: () => void
    oncancel: () => void
    ondraftchange: (value: string) => void
    commitMode?: boolean
    /** Take focus when mounted. Opening the editor also moves the selection, and
     *  the header remounts when that revision's diff lands — without this the
     *  remount drops focus to <body> and the message is typed into hotkeys. */
    focusOnMount?: boolean
  }

  let { revision, draft, onsave, oncancel, ondraftchange, commitMode = false, focusOnMount = false }: Props = $props()

  let textareaEl: HTMLTextAreaElement | undefined = $state()
  onMount(() => { if (focusOnMount) textareaEl?.focus() })
</script>

<div class="desc-editor">
  <label class="desc-label" for="desc-textarea">{commitMode ? 'Commit' : 'Description for'} {revision.commit.change_id.slice(0, 12)}</label>
  <textarea
    id="desc-textarea"
    bind:this={textareaEl}
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
    <button class="btn btn-primary" onclick={onsave}>
      {commitMode ? 'Commit' : 'Save'}
      <kbd>Cmd+Enter</kbd>
    </button>
    <button class="btn" onclick={oncancel}>Cancel</button>
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
    font-size: var(--fs-sm);
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
    font-size: var(--font-size);
    resize: vertical;
    outline: none;
    transition: border-color var(--anim-duration) var(--anim-ease);
  }

  .desc-editor textarea:focus {
    border-color: var(--amber);
  }

  .desc-actions {
    display: flex;
    gap: 6px;
    margin-top: 8px;
  }

  /* System .btn/.btn-primary; only the kbd hint inside Save is local. */
  .desc-actions :global(.btn-primary kbd) {
    background: var(--bg-btn-kbd);
    padding: 0 4px;
    border-radius: 2px;
    font-size: var(--fs-xs);
    font-family: inherit;
  }
</style>
