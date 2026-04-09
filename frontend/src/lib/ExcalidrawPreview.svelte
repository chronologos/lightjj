<script lang="ts">
  import { renderExcalidrawSVG } from './excalidraw-render'
  import { wireSvg } from './panzoom'

  interface Props { content: string }
  let { content }: Props = $props()

  let canvas: HTMLElement | undefined = $state()
  let svg = $derived(renderExcalidrawSVG(content))

  $effect(() => {
    void svg
    const el = canvas?.querySelector<SVGSVGElement>('svg')
    if (!el || !canvas) return
    return wireSvg(el, canvas)
  })
</script>

{#if svg}
  <!-- eslint-disable-next-line svelte/no-at-html-tags — renderer escapes all user strings -->
  <div class="ex-canvas" bind:this={canvas}>{@html svg}</div>
  <div class="ex-hint">scroll to zoom · drag to pan · double-click to reset</div>
{:else}
  <div class="ex-error">Not a valid Excalidraw file (expected <code>{'{"type":"excalidraw",...}'}</code>)</div>
{/if}

<style>
  .ex-canvas {
    overflow: hidden;
    cursor: grab;
    min-height: 200px;
    max-height: 70vh;
    border-radius: 6px;
    margin: 8px;
    /* Background comes from the SVG's own style (appState.viewBackgroundColor)
       so author-chosen colors keep their intended contrast. */
  }
  .ex-canvas:active { cursor: grabbing; }
  .ex-canvas :global(svg) { display: block; width: 100%; height: auto; }
  .ex-hint {
    font-size: 11px;
    color: var(--overlay0);
    text-align: center;
    padding-bottom: 8px;
    user-select: none;
  }
  .ex-error { padding: 16px; color: var(--subtext0); font-size: 13px; }
  .ex-error code { font-family: var(--font-mono, monospace); }
</style>
