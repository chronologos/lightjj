<script lang="ts">
  import { tick } from 'svelte'
  import { FILE_LEVEL, type Annotation, type AnnotationSeverity } from './api'

  interface Props {
    open: boolean
    x: number
    y: number
    /** Existing annotation for edit; null for create-new. */
    editing: Annotation | null
    /** Prefilled line context (for create-new). */
    lineContext?: { filePath: string; lineNum: number; lineContent: string }
    onsave: (comment: string, severity: AnnotationSeverity) => void
    onresolve?: () => void
    ondelete?: () => void
    onclose: () => void
  }

  let { open = $bindable(false), x, y, editing, lineContext, onsave, onresolve, ondelete, onclose }: Props = $props()

  let comment = $state('')
  let severity = $state<AnnotationSeverity>('suggestion')
  let textareaEl: HTMLTextAreaElement | undefined = $state()
  let bubbleEl: HTMLDivElement | undefined = $state()
  let adjustedX = $state(0)
  let adjustedY = $state(0)

  // 'reviewed' is NOT offered here — the file-header checkbox is the sole
  // affordance for the marker. Offering it in the bubble created a second
  // path to the same backend object with divergent semantics (no dedup, no
  // auto-collapse, bumps loadGen).
  const SEVERITIES: AnnotationSeverity[] = ['must-fix', 'suggestion', 'question', 'nitpick']
  const MARGIN = 8

  let contextLabel = $derived(
    !lineContext ? '' : lineContext.lineNum === FILE_LEVEL ? lineContext.filePath : `${lineContext.filePath}:${lineContext.lineNum}`
  )

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
        <span class="bubble-context">{contextLabel}</span>
      {/if}
      <button class="close-btn" onclick={() => { open = false; onclose() }} aria-label="Close">×</button>
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
        <button class="btn btn-danger bubble-delete" onclick={() => { ondelete(); open = false; onclose() }}>Delete</button>
      {/if}
      {#if editing && onresolve && editing.status !== 'resolved'}
        <button class="btn bubble-resolve" onclick={() => { onresolve(); open = false; onclose() }} title="Mark as resolved — hides from open list, kept for history">✓ Resolve</button>
      {/if}
      <button class="btn" onclick={() => { open = false; onclose() }}>Cancel</button>
      <button class="btn btn-primary" onclick={handleSubmit} disabled={!comment.trim()}>Save</button>
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
    font-size: var(--fs-md);
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
    border-left: 3px solid var(--ann-accent, var(--surface2));
    color: var(--text);
    border-radius: 4px;
    padding: 2px 6px;
    font-size: var(--fs-sm);
    font-family: inherit;
  }

  .bubble-context {
    flex: 1;
    font-family: var(--font-mono);
    color: var(--subtext0);
    font-size: var(--fs-xs);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .bubble-input {
    width: 100%;
    background: var(--base);
    border: 1px solid var(--surface1);
    color: var(--text);
    border-radius: 4px;
    padding: 6px;
    font-family: inherit;
    font-size: var(--fs-md);
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

  .bubble-delete { margin-right: auto; }
  .bubble-resolve { color: var(--green); border-color: var(--green); }
  .bubble-resolve:hover { background: color-mix(in srgb, var(--green) 15%, transparent); }
</style>
