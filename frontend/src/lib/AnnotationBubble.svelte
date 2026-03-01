<script lang="ts">
  import { tick } from 'svelte'
  import type { Annotation, AnnotationSeverity } from './api'

  interface Props {
    open: boolean
    x: number
    y: number
    /** Existing annotation for edit; null for create-new. */
    editing: Annotation | null
    /** Prefilled line context (for create-new). */
    lineContext?: { filePath: string; lineNum: number; lineContent: string }
    onsave: (comment: string, severity: AnnotationSeverity) => void
    ondelete?: () => void
    onclose: () => void
  }

  let { open = $bindable(false), x, y, editing, lineContext, onsave, ondelete, onclose }: Props = $props()

  let comment = $state('')
  let severity = $state<AnnotationSeverity>('suggestion')
  let textareaEl: HTMLTextAreaElement | undefined = $state()
  let bubbleEl: HTMLDivElement | undefined = $state()
  let adjustedX = $state(0)
  let adjustedY = $state(0)

  const SEVERITIES: AnnotationSeverity[] = ['must-fix', 'suggestion', 'question', 'nitpick']
  const MARGIN = 8

  $effect(() => {
    if (!open) return
    // Populate from editing or reset for create
    comment = editing?.comment ?? ''
    severity = editing?.severity ?? 'suggestion'
    adjustedX = x
    adjustedY = y
    tick().then(() => {
      if (!bubbleEl) return
      const rect = bubbleEl.getBoundingClientRect()
      if (rect.right > window.innerWidth - MARGIN) {
        adjustedX = Math.max(MARGIN, window.innerWidth - rect.width - MARGIN)
      }
      if (rect.bottom > window.innerHeight - MARGIN) {
        adjustedY = Math.max(MARGIN, window.innerHeight - rect.height - MARGIN)
      }
      textareaEl?.focus()
    })
  })

  function handleSubmit() {
    const trimmed = comment.trim()
    if (!trimmed) return
    onsave(trimmed, severity)
    open = false
    onclose()
  }

  function handleKeydown(e: KeyboardEvent) {
    if (e.key === 'Escape') {
      e.preventDefault()
      open = false
      onclose()
    } else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault()
      handleSubmit()
    }
  }
</script>

{#if open}
  <!-- svelte-ignore a11y_click_events_have_key_events -->
  <div class="bubble-backdrop" onclick={() => { open = false; onclose() }} role="presentation"></div>
  <div
    bind:this={bubbleEl}
    class="annotation-bubble"
    style="left: {adjustedX}px; top: {adjustedY}px"
    onkeydown={handleKeydown}
    role="dialog"
    aria-label="Annotation"
    tabindex="-1"
  >
    <div class="bubble-header">
      <select bind:value={severity} class="severity-select severity-{severity}">
        {#each SEVERITIES as s}
          <option value={s}>{s}</option>
        {/each}
      </select>
      {#if lineContext}
        <span class="bubble-context">{lineContext.filePath}:{lineContext.lineNum}</span>
      {/if}
      <button class="bubble-close" onclick={() => { open = false; onclose() }} aria-label="Close">×</button>
    </div>
    <textarea
      bind:this={textareaEl}
      bind:value={comment}
      class="bubble-input"
      placeholder="Review comment… (⌘Enter to save)"
      rows="3"
    ></textarea>
    <div class="bubble-actions">
      {#if editing && ondelete}
        <button class="bubble-delete" onclick={() => { ondelete(); open = false; onclose() }}>Delete</button>
      {/if}
      <button class="bubble-cancel" onclick={() => { open = false; onclose() }}>Cancel</button>
      <button class="bubble-save" onclick={handleSubmit} disabled={!comment.trim()}>Save</button>
    </div>
  </div>
{/if}

<style>
  .bubble-backdrop {
    position: fixed;
    inset: 0;
    z-index: 90;
  }

  .annotation-bubble {
    position: fixed;
    z-index: 91;
    width: 360px;
    background: var(--mantle);
    border: 1px solid var(--surface1);
    border-radius: 6px;
    box-shadow: 0 4px 16px rgba(0, 0, 0, 0.3);
    padding: 10px;
    font-size: 12px;
  }

  .bubble-header {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-bottom: 8px;
  }

  .severity-select {
    background: var(--surface0);
    border: 1px solid var(--surface1);
    color: var(--text);
    border-radius: 4px;
    padding: 2px 6px;
    font-size: 11px;
    font-family: inherit;
  }

  .severity-must-fix { border-left: 3px solid var(--red); }
  .severity-suggestion { border-left: 3px solid var(--amber); }
  .severity-question { border-left: 3px solid var(--blue); }
  .severity-nitpick { border-left: 3px solid var(--surface2); }

  .bubble-context {
    flex: 1;
    font-family: var(--font-mono);
    color: var(--subtext0);
    font-size: 10px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .bubble-close {
    background: transparent;
    border: none;
    color: var(--subtext0);
    font-size: 16px;
    cursor: pointer;
    padding: 0 4px;
    line-height: 1;
  }
  .bubble-close:hover { color: var(--text); }

  .bubble-input {
    width: 100%;
    background: var(--base);
    border: 1px solid var(--surface1);
    color: var(--text);
    border-radius: 4px;
    padding: 6px;
    font-family: inherit;
    font-size: 12px;
    resize: vertical;
    min-height: 60px;
  }
  .bubble-input:focus {
    outline: none;
    border-color: var(--amber);
  }

  .bubble-actions {
    display: flex;
    gap: 6px;
    margin-top: 8px;
    justify-content: flex-end;
  }

  .bubble-actions button {
    background: var(--surface0);
    border: 1px solid var(--surface1);
    color: var(--text);
    border-radius: 4px;
    padding: 4px 10px;
    font-size: 11px;
    font-family: inherit;
    cursor: pointer;
  }
  .bubble-actions button:hover { background: var(--surface1); }
  .bubble-actions button:disabled { opacity: 0.5; cursor: not-allowed; }

  .bubble-delete {
    margin-right: auto;
    color: var(--red) !important;
  }

  .bubble-save {
    background: var(--amber) !important;
    color: var(--crust) !important;
    border-color: var(--amber) !important;
  }
</style>
