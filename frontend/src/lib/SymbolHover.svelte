<script lang="ts">
  import { api } from './api'
  import type { SymbolHover } from './symbol-hover.svelte'

  let { hover }: { hover: SymbolHover } = $props()
  let openErr = $state('')

  const PAD = 8
  const GAP = 6

  // Span-rect anchored: horizontally centred on the token, above by default,
  // flip below if it would clip the top, clamp X to viewport. $effect (not
  // $derived) so getBoundingClientRect() runs AFTER the {#each hits} rows
  // mount — a derived would measure the loading-state card and decide
  // flip/clamp against the wrong height.
  let cardEl: HTMLDivElement | undefined = $state()
  let pos = $state<{ x: number; y: number } | null>(null)
  $effect(() => {
    const r = hover.rect
    void hover.hits
    if (!r || !cardEl) { pos = null; return }
    const { width: cw, height: ch } = cardEl.getBoundingClientRect()
    let x = r.left + r.width / 2 - cw / 2
    x = Math.max(PAD, Math.min(x, window.innerWidth - cw - PAD))
    const above = r.top - ch - GAP
    pos = { x, y: above >= PAD ? above : r.bottom + GAP }
  })

  async function open(file: string, line: number) {
    openErr = ''
    try {
      await api.openFile(file, line)
      hover.clear()
    } catch (e) {
      openErr = String(e)
    }
  }
</script>

{#if hover.anchor}
  <!-- svelte-ignore a11y_no_static_element_interactions a11y_mouse_events_have_key_events -->
  <div
    bind:this={cardEl}
    class="sym-card"
    style:left="{pos?.x ?? -9999}px"
    style:top="{pos?.y ?? -9999}px"
    onmouseenter={() => hover.pin(true)}
    onmouseleave={() => hover.pin(false)}
  >
    <div class="sym-head">
      <span class="sym-name">{hover.symbol}</span>
      {#if hover.hits}<span class="sym-count">{hover.hits.length} def{hover.hits.length === 1 ? '' : 's'}</span>{/if}
    </div>
    {#if hover.hits === null}
      <div class="sym-empty">…</div>
    {:else if hover.hits.length === 0}
      <div class="sym-empty">no definition found in working copy</div>
    {:else}
      {#each hover.hits.slice(0, 5) as h (h.file + ':' + h.line)}
        <button class="sym-hit" onclick={() => open(h.file, h.line)} title="Open in editor">
          <div class="sym-loc">{h.file}:{h.line}</div>
          {#each h.context as c}<div class="sym-ctx">{c}</div>{/each}
          <div class="sym-sig">{h.text}</div>
        </button>
      {/each}
      {#if hover.hits.length > 5}<div class="sym-more">+{hover.hits.length - 5} more</div>{/if}
    {/if}
    {#if openErr}<div class="sym-empty" style:color="var(--red)">{openErr}</div>{/if}
  </div>
{/if}

<style>
  .sym-card {
    position: fixed;
    z-index: 80;
    max-width: 520px;
    background: var(--mantle);
    border: 1px solid var(--surface1);
    border-radius: 6px;
    box-shadow: 0 4px 16px rgba(0, 0, 0, 0.3);
    font-family: var(--font-ui);
    font-size: var(--fs-sm);
    overflow: hidden;
  }
  .sym-head {
    display: flex;
    align-items: baseline;
    gap: 8px;
    padding: 6px 10px;
    border-bottom: 1px solid var(--surface0);
  }
  .sym-name { font-family: var(--font-mono); font-weight: 600; color: var(--amber); }
  .sym-count { font-size: var(--fs-2xs); color: var(--subtext0); margin-left: auto; }
  .sym-empty { padding: 8px 10px; color: var(--subtext0); font-size: var(--fs-xs); }
  .sym-hit {
    display: block;
    width: 100%;
    text-align: left;
    border: none;
    background: none;
    padding: 6px 10px;
    border-top: 1px solid var(--surface0);
    cursor: pointer;
    font-family: inherit;
  }
  .sym-hit:first-of-type { border-top: none; }
  .sym-hit:hover { background: var(--surface0); }
  .sym-loc { font-size: var(--fs-2xs); color: var(--subtext0); margin-bottom: 2px; }
  .sym-ctx, .sym-sig {
    font-family: var(--font-mono);
    font-size: var(--fs-xs);
    white-space: pre;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .sym-ctx { color: var(--overlay1); }
  .sym-sig { color: var(--text); }
  .sym-more { padding: 4px 10px; font-size: var(--fs-2xs); color: var(--subtext0); border-top: 1px solid var(--surface0); }
</style>
