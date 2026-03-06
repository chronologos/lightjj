<script lang="ts">
  import type { SvelteSet } from 'svelte/reactivity'
  import type { FileChange } from './api'

  interface Props {
    /** Drives title + count-suffix labels. All three modes use identical
     *  selection mechanics; only the labels differ (squash/split are verbs,
     *  review reframes toggle as accept/reject). */
    mode: 'squash' | 'split' | 'review'
    files: FileChange[]
    selected: SvelteSet<string>
    ontoggle: (path: string) => void
  }

  let { mode, files, selected, ontoggle }: Props = $props()

  let cursorIdx: number = $state(0)
  let listEl: HTMLElement | undefined = $state(undefined)

  const LABELS = {
    squash: { title: 'Squash', countSuffix: 'to move' },
    split:  { title: 'Split',  countSuffix: 'stay' },
    review: { title: 'Review', countSuffix: 'accepted' },
  }

  function scrollCursorIntoView() {
    requestAnimationFrame(() => {
      listEl?.querySelector('.file-select-active')?.scrollIntoView({ block: 'nearest' })
    })
  }

  function selectAll() {
    for (const f of files) { if (!selected.has(f.path)) ontoggle(f.path) }
  }

  function selectNone() {
    for (const f of files) { if (selected.has(f.path)) ontoggle(f.path) }
  }

  // Enter/Escape NOT handled — they bubble to App.svelte's global keydown
  // handler which executes/cancels the inline mode.
  function handleKeydown(e: KeyboardEvent) {
    switch (e.key) {
      case 'ArrowDown':
      case 'j':
        e.preventDefault()
        if (cursorIdx < files.length - 1) { cursorIdx++; scrollCursorIntoView() }
        break
      case 'ArrowUp':
      case 'k':
        e.preventDefault()
        if (cursorIdx > 0) { cursorIdx--; scrollCursorIntoView() }
        break
      case ' ':
        e.preventDefault()
        if (files[cursorIdx]) ontoggle(files[cursorIdx].path)
        break
      case 'a':
        e.preventDefault()
        selectAll()
        break
      case 'n':
        e.preventDefault()
        selectNone()
        break
    }
  }

  // Auto-focus on mount so j/k/Space work immediately. DiffPanel wraps us
  // in `{#if fileSelectionMode}` — mount = mode entry, unmount = mode exit.
  // Blur-on-unmount is implicit (element gone).
  $effect(() => {
    listEl?.focus()
  })
</script>

<div class="file-selection-panel">
  <div class="file-selection-header">
    <span class="file-selection-title">{LABELS[mode].title} — <kbd>Space</kbd> toggle · <kbd>↑↓</kbd> navigate · <kbd>Enter</kbd> apply</span>
    <span class="file-selection-actions">
      <button class="file-select-action" onclick={selectAll}>All</button>
      <button class="file-select-action" onclick={selectNone}>None</button>
    </span>
    <span class="file-selection-count">{selected.size}/{files.length} {LABELS[mode].countSuffix}</span>
  </div>
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div class="file-selection-list" tabindex="-1"
    onkeydown={handleKeydown}
    bind:this={listEl}>
    {#each files as file, i (file.path)}
      <!-- svelte-ignore a11y_click_events_have_key_events -->
      <div
        class="file-select-row"
        class:file-select-active={i === cursorIdx}
        class:file-checked={selected.has(file.path)}
        onclick={() => { cursorIdx = i; ontoggle(file.path) }}
        onmouseenter={() => { cursorIdx = i }}
        role="option"
        tabindex="-1"
        aria-selected={selected.has(file.path)}
      >
        <span class="file-check-indicator">{selected.has(file.path) ? '✓' : ' '}</span>
        {#if file.conflict}
          <span class="file-dot dot-C"></span>
        {:else}
          <span class="file-dot" class:dot-A={file.type === 'A'} class:dot-D={file.type === 'D'} class:dot-M={file.type === 'M'}></span>
        {/if}
        <span class="file-select-path">{file.path}</span>
        {#if file.additions > 0 || file.deletions > 0}
          <span class="file-tab-stats">
            {#if file.additions > 0}<span class="stat-add">+{file.additions}</span>{/if}
            {#if file.deletions > 0}<span class="stat-del">-{file.deletions}</span>{/if}
          </span>
        {/if}
      </div>
    {/each}
  </div>
</div>

<style>
  .file-selection-panel {
    border-bottom: 1px solid var(--amber);
    flex-shrink: 0;
    animation: slide-down var(--anim-duration) var(--anim-ease);
  }

  .file-selection-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 6px 12px;
    background: var(--bg-selected);
    font-size: 11px;
    font-weight: 600;
    color: var(--amber);
  }

  .file-selection-title {
    display: flex;
    align-items: center;
    gap: 4px;
  }

  .file-selection-title kbd {
    background: var(--surface0);
    padding: 0 4px;
    border-radius: 3px;
    font-family: inherit;
    font-size: 10px;
    border: 1px solid var(--surface1);
    color: var(--overlay0);
    font-weight: 500;
  }

  .file-selection-actions {
    display: flex;
    gap: 6px;
    margin-left: auto;
    margin-right: 8px;
  }

  .file-select-action {
    background: none;
    border: none;
    color: var(--subtext0);
    font-family: inherit;
    font-size: 11px;
    font-weight: 500;
    cursor: pointer;
    padding: 0;
    text-decoration: underline;
    text-underline-offset: 2px;
  }

  .file-select-action:hover {
    color: var(--text);
  }

  .file-selection-count {
    font-variant-numeric: tabular-nums;
  }

  .file-selection-list {
    display: flex;
    flex-direction: column;
    max-height: 160px;
    overflow-y: auto;
    background: var(--mantle);
    outline: none;
  }

  .file-select-row {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 4px 12px;
    color: var(--text);
    font-size: 12px;
    cursor: pointer;
    user-select: none;
    transition: background-color var(--anim-duration) var(--anim-ease);
  }

  .file-select-row:hover:not(.file-select-active) {
    background: var(--bg-hover);
  }

  .file-select-row.file-select-active {
    background: var(--surface0);
  }

  .file-check-indicator {
    width: 14px;
    flex-shrink: 0;
    text-align: center;
    font-size: 11px;
    font-weight: 700;
    transition: color var(--anim-duration) var(--anim-ease),
                transform var(--anim-duration) var(--anim-ease);
  }

  .file-checked .file-check-indicator {
    color: var(--amber);
    transform: scale(1.15);
  }

  .file-select-path {
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-family: var(--font-mono);
    font-size: 11px;
    color: var(--subtext0);
  }

  .file-select-row.file-checked .file-select-path {
    color: var(--text);
  }

  .file-dot {
    width: 5px;
    height: 5px;
    border-radius: 50%;
    background: var(--subtext0);
    flex-shrink: 0;
  }

  .file-dot.dot-A { background: var(--green); }
  .file-dot.dot-D { background: var(--red); }
  .file-dot.dot-M { background: var(--amber); }
  .file-dot.dot-C { background: var(--red); }

  .file-tab-stats {
    display: inline-flex;
    gap: 3px;
    font-size: 10px;
    opacity: 0.7;
  }

  .file-tab-stats .stat-add { color: var(--green); }
  .file-tab-stats .stat-del { color: var(--red); }
</style>
