<script lang="ts">
  // Dropdown jump-list over DiffPanel's `navAnnotations` — sibling to
  // SearchResults.svelte (same parent-owned-cursor pattern: this list does NOT
  // use createListCursor; DiffPanel's annNavIdx + onjump own the cursor).
  // issue #25: clicking the annotations-bar counter opens this so users can
  // skim all comments without `}`-stepping through long diffs.
  import type { PlacedReview } from './review'
  import { SEVERITY_VAR } from './review'
  import { scrollIdxIntoView } from './scroll-into-view'
  import { firstLine } from './time-format'
  import { basename, dirname } from './paths'

  interface Props {
    reviews: PlacedReview[]
    currentIdx: number
    onjump: (idx: number) => void
    onclose: () => void
  }

  let { reviews, currentIdx, onjump, onclose }: Props = $props()

  let rootEl: HTMLDivElement | undefined = $state(undefined)
  let listEl: HTMLDivElement | undefined = $state(undefined)
  let hoveredIdx = $state(-1)

  // Same cap/reason as SearchResults — beyond this `{`/`}` is the way.
  const RENDER_CAP = 200
  let shown = $derived(reviews.slice(0, RENDER_CAP))
  let fileCount = $derived(new Set(reviews.map(r => (r.anchor as { filePath: string }).filePath)).size)

  $effect(() => {
    const i = currentIdx
    if (i < 0 || i >= RENDER_CAP) return
    scrollIdxIntoView(listEl, i)
  })

  // Dismiss on Escape and click-outside. The window listeners mount with the
  // component (which itself is inside `{#if annListOpen}`), so they only run
  // while open. The toggle button carries a data-attr so its own click can
  // flip annListOpen without this handler immediately re-closing it.
  function onWindowKey(e: KeyboardEvent) {
    if (e.key === 'Escape') { e.stopPropagation(); onclose() }
  }
  function onWindowPointer(e: PointerEvent) {
    const t = e.target as Element | null
    if (rootEl?.contains(t as Node)) return
    if (t?.closest('[data-ann-list-toggle]')) return
    onclose()
  }
</script>

<svelte:window onkeydown={onWindowKey} onpointerdown={onWindowPointer} />

<div class="rj-dropdown" bind:this={rootEl}>
  <div class="rj-summary">
    {reviews.length} {reviews.length === 1 ? 'comment' : 'comments'} in {fileCount} {fileCount === 1 ? 'file' : 'files'}
    {#if reviews.length > RENDER_CAP}<span class="rj-cap">· showing first {RENDER_CAP}</span>{/if}
    <span class="rj-hint">· <kbd class="nav-hint">{'{'}</kbd> <kbd class="nav-hint">{'}'}</kbd> step</span>
  </div>
  <div class="rj-list" bind:this={listEl} role="listbox" tabindex="-1" aria-label="Review comments"
    onmousemove={(e) => {
      const t = (e.target as Element).closest('[data-idx]')
      hoveredIdx = t ? Number(t.getAttribute('data-idx')) : -1
    }}
    onmouseleave={() => hoveredIdx = -1}>
    {#each shown as r, i (r.id)}
      {@const path = (r.anchor as { filePath: string }).filePath}
      <!-- svelte-ignore a11y_click_events_have_key_events -->
      <div
        class="rj-row"
        class:rj-current={i === currentIdx}
        class:hovered={i === hoveredIdx}
        data-idx={i}
        role="option"
        tabindex="-1"
        aria-selected={i === currentIdx}
        onclick={() => onjump(i)}
      >
        <div class="rj-loc">
          <span class="rj-sev" style:color={r.severity ? `var(${SEVERITY_VAR[r.severity]})` : 'var(--overlay0)'}>●</span>
          <span class="rj-path"><span class="rj-dir">{dirname(path)}</span><span class="rj-base">{basename(path)}</span></span>
          <span class="rj-line">:{r.line ?? '?'}</span>
          {#if r.author}<span class="rj-author">{r.author}</span>{/if}
        </div>
        <div class="rj-body">{firstLine(r.body) || '(no text)'}</div>
      </div>
    {/each}
  </div>
</div>

<style>
  .rj-dropdown {
    position: absolute;
    top: 100%;
    left: 0;
    right: 0;
    z-index: 20;
    background: var(--base);
    border: 1px solid var(--surface0);
    border-top: none;
    border-radius: 0 0 6px 6px;
    box-shadow: 0 8px 24px rgba(0, 0, 0, 0.3);
    display: flex;
    flex-direction: column;
    max-height: 320px;
  }

  .rj-summary {
    padding: 6px 12px;
    font-size: var(--fs-sm);
    color: var(--subtext0);
    border-bottom: 1px solid var(--surface0);
    user-select: none;
  }
  .rj-cap { color: var(--overlay0); }
  .rj-hint { float: right; color: var(--overlay0); }

  .rj-list {
    overflow-y: auto;
    flex: 1;
    min-height: 0;
  }

  .rj-row {
    padding: 6px 12px;
    border-left: 3px solid transparent;
    cursor: pointer;
    user-select: none;
  }
  .rj-row.hovered { background: var(--surface0); }
  .rj-current {
    border-left-color: var(--amber);
    background: var(--surface0);
  }

  .rj-loc {
    display: flex;
    align-items: baseline;
    gap: 6px;
    font-size: var(--fs-md);
    margin-bottom: 2px;
  }
  .rj-sev { font-size: var(--fs-2xs); flex-shrink: 0; }
  .rj-path {
    font-family: var(--font-mono, monospace);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    min-width: 0;
  }
  .rj-dir { color: var(--overlay0); }
  .rj-base { color: var(--text); font-weight: 600; }
  .rj-line {
    font-family: var(--font-mono, monospace);
    font-size: var(--fs-sm);
    color: var(--overlay1);
    flex-shrink: 0;
  }
  .rj-author {
    margin-left: auto;
    font-size: var(--fs-xs);
    color: var(--text-faint);
    flex-shrink: 0;
  }

  .rj-body {
    font-size: var(--fs-sm);
    color: var(--subtext0);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    padding-left: 16px;
  }
</style>
