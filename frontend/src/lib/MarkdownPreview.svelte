<script lang="ts">
  import { renderMarkdown, ensureMermaidLoaded, wirePanzoom } from './markdown-render'

  let { content }: { content: string } = $props()
  let container: HTMLElement | undefined = $state()

  // Mermaid chunk lazy-loads on first preview. `mermaidReady` is a dep of
  // `html` so the preview re-derives once the renderer lands — first paint
  // shows raw ```mermaid blocks, ~100ms later they become SVGs. Subsequent
  // previews start with mermaidReady=true (module-level cache).
  let mermaidReady = $state(false)
  $effect(() => { ensureMermaidLoaded().then(() => mermaidReady = true) })

  let html = $derived((void mermaidReady, renderMarkdown(content)))

  // Re-wire panzoom after every html change. Returned cleanup calls
  // pz.destroy() on the prior batch — panzoom attaches document-level
  // pointermove/up that survive {@html} subtree replacement.
  $effect(() => {
    void html
    if (!container) return
    return wirePanzoom(container)
  })
</script>

<div class="md-preview" bind:this={container}>{@html html}</div>

<style>
  .md-preview {
    padding: 12px 16px;
    font-family: system-ui, -apple-system, sans-serif;
    font-size: 14px;
    line-height: 1.6;
    color: var(--text);
    max-width: 900px;
    /* Containing block for fixed-position descendants — neutralizes the
       <div style="position:fixed;..."> phishing-overlay vector without
       stripping inline style (which mermaid SVG may use). */
    contain: layout paint;
  }
  .md-preview :global(h1),
  .md-preview :global(h2),
  .md-preview :global(h3) {
    border-bottom: 1px solid var(--surface1);
    padding-bottom: 0.3em;
    margin-top: 1.2em;
  }
  .md-preview :global(code) {
    background: var(--surface0);
    padding: 0.15em 0.35em;
    border-radius: 3px;
    font-family: ui-monospace, monospace;
    font-size: 0.9em;
  }
  .md-preview :global(pre) {
    background: var(--surface0);
    padding: 12px;
    border-radius: 4px;
    overflow-x: auto;
  }
  .md-preview :global(pre code) {
    background: none;
    padding: 0;
  }
  .md-preview :global(blockquote) {
    border-left: 3px solid var(--overlay0);
    margin-left: 0;
    padding-left: 12px;
    color: var(--overlay0);
  }
  .md-preview :global(table) {
    border-collapse: collapse;
    margin: 1em 0;
  }
  .md-preview :global(th),
  .md-preview :global(td) {
    border: 1px solid var(--surface2);
    padding: 6px 12px;
  }
  .md-preview :global(th) {
    background: var(--surface0);
  }
  .md-preview :global(a) {
    color: var(--blue);
  }
  .md-preview :global(hr) {
    border: none;
    border-top: 1px solid var(--surface1);
    margin: 1.5em 0;
  }
  .md-preview :global(.mermaid-block) {
    border: 1px solid var(--surface1);
    border-radius: 4px;
    margin: 1em 0;
    overflow: hidden;
    cursor: grab;
  }
  .md-preview :global(.mermaid-block:active) {
    cursor: grabbing;
  }
  .md-preview :global(.mermaid-fallback) {
    border-left: 3px solid var(--overlay0);
  }
</style>
