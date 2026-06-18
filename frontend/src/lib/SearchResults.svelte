<script lang="ts">
  import type { SearchMatch } from './DiffPanel.svelte'
  import { scrollIdxIntoView } from './scroll-into-view'
  import { basename, dirname } from './paths'

  interface Props {
    matches: SearchMatch[]
    currentIdx: number
    fileCount: number
    onjump: (idx: number) => void
  }

  let { matches, currentIdx, fileCount, onjump }: Props = $props()

  let listEl: HTMLDivElement | undefined = $state(undefined)
  let hoveredIdx = $state(-1)

  // Cap rendering — beyond this, ↑/↓ nav is the way (the inline highlight
  // still covers all matches; this is just the jump list).
  const RENDER_CAP = 200
  let shown = $derived(matches.slice(0, RENDER_CAP))

  // Keep current row visible in the dropdown as ↑/↓ cycles through.
  // The cursor itself is parent-owned (DiffPanel's currentIdx prop + onjump)
  // so this list does NOT use createListCursor — only the data-idx scroll
  // helper and the delegated hover tracking below.
  $effect(() => {
    const i = currentIdx
    if (i >= RENDER_CAP) return
    scrollIdxIntoView(listEl, i)
  })

  // Window the snippet around the match so long lines don't blow out the row.
  // Returns [pre, match, post, leadEllipsis, trailEllipsis].
  function snippet(m: SearchMatch): [string, string, string, boolean, boolean] {
    const PRE = 30, POST = 60
    const lead = m.startCol > PRE
    const from = lead ? m.startCol - PRE : 0
    const tailEnd = m.endCol + POST
    const trail = m.content.length > tailEnd
    return [
      m.content.slice(from, m.startCol),
      m.content.slice(m.startCol, m.endCol),
      m.content.slice(m.endCol, trail ? tailEnd : undefined),
      lead, trail,
    ]
  }
</script>

<div class="sr-dropdown">
  <div class="sr-summary">
    {matches.length} {matches.length === 1 ? 'match' : 'matches'} in {fileCount} {fileCount === 1 ? 'file' : 'files'}
    {#if matches.length > RENDER_CAP}<span class="sr-cap">· showing first {RENDER_CAP}</span>{/if}
  </div>
  <div class="sr-list" bind:this={listEl} role="listbox" tabindex="-1" aria-label="Search results"
    onmousemove={(e) => {
      const t = (e.target as Element).closest('[data-idx]')
      hoveredIdx = t ? Number(t.getAttribute('data-idx')) : -1
    }}
    onmouseleave={() => hoveredIdx = -1}>
    {#each shown as m, i (i)}
      {@const [pre, hit, post, lead, trail] = snippet(m)}
      <!-- svelte-ignore a11y_click_events_have_key_events -->
      <div
        class="sr-row"
        class:sr-current={i === currentIdx}
        class:hovered={i === hoveredIdx}
        data-idx={i}
        role="option"
        tabindex="-1"
        aria-selected={i === currentIdx}
        onclick={() => onjump(i)}
      >
        <div class="sr-loc">
          <span class="sr-path"><span class="sr-dir">{dirname(m.filePath)}</span><span class="sr-base">{basename(m.filePath)}</span></span>
          <span class="sr-line sr-line-{m.side}">{m.side === 'add' ? '+' : m.side === 'remove' ? '-' : ''}{m.lineNum}</span>
        </div>
        <div class="sr-snippet">
          {#if lead}<span class="sr-ell">…</span>{/if}<span>{pre}</span><span class="sr-hit">{hit}</span><span>{post}</span>{#if trail}<span class="sr-ell">…</span>{/if}
        </div>
      </div>
    {/each}
  </div>
</div>

<style>
  .sr-dropdown {
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

  .sr-summary {
    padding: 6px 12px;
    font-size: var(--fs-sm);
    color: var(--subtext0);
    border-bottom: 1px solid var(--surface0);
    user-select: none;
  }
  .sr-cap { color: var(--overlay0); }

  .sr-list {
    overflow-y: auto;
    flex: 1;
    min-height: 0;
  }

  .sr-row {
    padding: 6px 12px;
    border-left: 3px solid transparent;
    cursor: pointer;
    user-select: none;
  }
  .sr-row.hovered { background: var(--surface0); }
  .sr-current {
    border-left-color: var(--amber);
    background: var(--surface0);
  }

  .sr-loc {
    display: flex;
    align-items: baseline;
    gap: 8px;
    font-size: var(--fs-md);
    margin-bottom: 2px;
  }
  .sr-path {
    font-family: var(--font-mono, monospace);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    min-width: 0;
  }
  .sr-dir { color: var(--overlay0); }
  .sr-base { color: var(--text); font-weight: 600; }

  .sr-line {
    font-family: var(--font-mono, monospace);
    font-size: var(--fs-sm);
    padding: 0 5px;
    border-radius: 3px;
    background: var(--surface0);
    color: var(--overlay1);
    flex-shrink: 0;
  }
  .sr-line-add { background: var(--diff-add-bg); color: var(--green); }
  .sr-line-remove { background: var(--diff-remove-bg); color: var(--red); }

  .sr-snippet {
    font-family: var(--font-mono, monospace);
    font-size: var(--fs-md);
    color: var(--subtext0);
    white-space: pre;
    overflow: hidden;
    text-overflow: ellipsis;
    padding-left: 12px;
  }
  .sr-hit {
    background: var(--search-match-bg);
    color: var(--text);
    border-radius: 2px;
  }
  .sr-ell { color: var(--overlay0); }
</style>
