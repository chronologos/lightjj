<script module lang="ts">
  import { ensureMermaidLoaded } from './markdown-render'
  // Module-level: the lazy chunk loads once. Per-instance $state(false) was
  // forcing a SECOND full marked.parse on every mount-after-first (the .then
  // microtask flips it after html already computed correctly).
  let mermaidReady = $state(false)
  ensureMermaidLoaded().then(() => mermaidReady = true)
</script>

<script lang="ts">
  import { renderMarkdown, renderMarkdownAnnotated, wirePanzoom, stampedBlocks, type PreviewContext } from './markdown-render'
  import type { Annotation } from './api'

  interface Props {
    content: string
    ctx?: PreviewContext
    // Same signatures as DiffFileView — DiffPanel threads them through.
    annotationsForLine?: (lineNum: number) => readonly Annotation[]
    onannotationclick?: (lineNum: number, lineContent: string, e: MouseEvent) => void
    addedLines?: ReadonlySet<number>
  }

  let { content, ctx, annotationsForLine, onannotationclick, addedLines }: Props = $props()
  let container: HTMLElement | undefined = $state()

  let stamped = $derived(!!annotationsForLine || !!addedLines?.size)
  let html = $derived((void mermaidReady, stamped
    ? renderMarkdownAnnotated(content, ctx)
    : renderMarkdown(content, ctx)))

  let sourceLines = $derived(stamped ? content.split('\n') : [])

  $effect(() => {
    void html
    if (!container) return
    return wirePanzoom(container)
  })

  // ───── Gutter rows — explicit column, NOT injected ::before/badges ─────
  // One row per stamped block, positioned at the block's offsetTop. Replaces
  // wireAnnotations/wireDiffGutter (imperative inject/cleanup) with a plain
  // {#each} so annotation changes flow through Svelte's normal reactivity
  // instead of a re-run-everything $effect. All gutter elements at one x —
  // no per-element-type offset CSS (li/pre/mermaid special cases deleted).

  interface GutterRow {
    srcLine: number; top: number; height: number
    added: boolean; anns: readonly Annotation[]
  }
  const SEV_ORDER: Record<string, number> = { 'must-fix': 0, suggestion: 1, question: 2, nitpick: 3 }

  let gutterRows = $state<GutterRow[]>([])
  let resizeEpoch = $state(0)

  $effect(() => {
    void html; void resizeEpoch
    if (!container || !stamped) { gutterRows = []; return }
    const ranges = stampedBlocks(container, sourceLines.length)
    gutterRows = ranges.map(({ el, start, end }) => {
      const anns: Annotation[] = []
      let added = false
      for (let n = start; n < end; n++) {
        if (annotationsForLine) anns.push(...annotationsForLine(n))
        if (addedLines?.has(n)) added = true
      }
      anns.sort((a, b) => SEV_ORDER[a.severity] - SEV_ORDER[b.severity])
      return { srcLine: start, top: el.offsetTop, height: el.offsetHeight, added, anns }
    })
  })

  // Re-measure on reflow (image load, mermaid render, split-drag). One
  // observer on the content container; any descendant size change bubbles
  // to a content-box change here.
  $effect(() => {
    if (!container) return
    const ro = new ResizeObserver(() => resizeEpoch++)
    ro.observe(container)
    return () => ro.disconnect()
  })

  // Alt+click annotate — the only remaining imperative wire (a delegated
  // listener; everything else is template-rendered).
  function handleContentClick(e: MouseEvent) {
    if (!e.altKey || !onannotationclick) return
    const el = (e.target as Element).closest<HTMLElement>('[data-src-line]')
    if (!el) return
    const n = +el.dataset.srcLine!
    onannotationclick(n, sourceLines[n - 1] ?? '', e)
  }

  // ToC: query headings post-{@html}. Depth from tag (h1→1..h6→6) for indent.
  // Click scrolls the heading element directly — no IDs needed.
  // (Gutter is a separate column now — no badge buttons in headings, so the
  //  declared-before-wireAnnotations ordering constraint is gone.)
  interface TocEntry { el: HTMLElement; depth: number; text: string }
  let toc = $state<TocEntry[]>([])
  let activeHeading = $state<HTMLElement | null>(null)
  let tocOpen = $state(true)
  let tocItemsEl: HTMLElement | undefined = $state()
  // Keep the .active row visible inside the ToC's own overflow-y scrollbox.
  // Direct scrollTop math — scrollIntoView() bubbles to ancestor scroll
  // containers and CANCELS the content's smooth-scroll mid-flight (the IO
  // fires repeatedly during the smooth scroll → this effect fires → ToC
  // scrollIntoView touches .panel-content → heading scroll stops short).
  $effect(() => {
    void activeHeading
    if (!tocItemsEl) return
    const active = tocItemsEl.querySelector<HTMLElement>('.md-toc-item.active')
    if (!active) return
    const top = active.offsetTop, bot = top + active.offsetHeight
    const viewTop = tocItemsEl.scrollTop, viewBot = viewTop + tocItemsEl.clientHeight
    if (top < viewTop) tocItemsEl.scrollTop = top
    else if (bot > viewBot) tocItemsEl.scrollTop = bot - tocItemsEl.clientHeight
  })
  $effect(() => {
    void html
    // Reset first: on html re-derive, old elements are detached. Stale
    // activeHeading would never match new h.el until the observer fires.
    activeHeading = null
    if (!container) { toc = []; return }
    const headings = [...container.querySelectorAll<HTMLElement>('h1,h2,h3,h4,h5,h6')]
    toc = headings.map(el => ({
      el, depth: +el.tagName[1], text: el.textContent ?? '',
    }))
    if (headings.length < 2) return
    // Scroll-spy: whichever heading is nearest the top-of-viewport band is
    // "current". rootMargin -70% bottom = only the top 30% counts. When
    // multiple headings intersect (short sections), the last one to enter
    // wins — matches reading-order intuition.
    // root = the actual scroll container (DiffPanel's .panel-content), not
    // viewport — rootMargin % is relative to root, and viewport-relative
    // miscounts the ~100px of toolbar/header chrome above the scrollport.
    const root = container.closest<HTMLElement>('.panel-content')
    const io = new IntersectionObserver(
      entries => {
        for (const e of entries) {
          if (e.isIntersecting) activeHeading = e.target as HTMLElement
        }
      },
      { root, rootMargin: '-40px 0px -70% 0px' },
    )
    headings.forEach(h => io.observe(h))
    return () => io.disconnect()
  })

</script>

<div class="md-preview">
  {#if annotationsForLine}
    <div class="md-hint"><kbd class="nav-hint">Alt</kbd>+click any block to annotate</div>
  {/if}
  {#if toc.length > 1}
    {#if tocOpen}
      <nav class="md-toc" aria-label="Table of contents">
        <button class="md-toc-close" onclick={() => tocOpen = false} title="Hide outline" aria-label="Hide outline">›</button>
        <div class="md-toc-items" bind:this={tocItemsEl}>
          {#each toc as h}
            <button
              class="md-toc-item"
              class:active={h.el === activeHeading}
              class:deep={h.depth >= 4}
              style:padding-left="{(h.depth - 1) * 10 + 8}px"
              onclick={() => { activeHeading = h.el; h.el.scrollIntoView({ block: 'start', behavior: 'smooth' }) }}
              title={h.text}
            >{h.text}</button>
          {/each}
        </div>
      </nav>
    {:else}
      <div class="md-toc-tab">
        <button onclick={() => tocOpen = true} title="Show outline ({toc.length})" aria-label="Show outline">‹</button>
      </div>
    {/if}
  {/if}
  <!-- contain on the {@html} wrapper ONLY — it's the phishing-overlay defense
       (untrusted markdown can't position:fixed over the real UI). On the outer
       .md-preview it broke ToC sticky: contain:paint is a clipping boundary,
       browsers treat that as the sticky scroll container. ToC is our chrome,
       sits outside the boundary; container binding stays on the {@html} host
       (wirePanzoom/wireAnnotations/toc-query all target [data-src-line]/h1-6
       which live inside). -->
  <div class="md-body">
    {#if stamped}
      <div class="md-gutter">
        {#each gutterRows as row (row.srcLine)}
          <div class="md-gutter-row" style:top="{row.top}px" style:height="{row.height}px">
            {#if row.added}<span class="md-strip-add"></span>{/if}
            {#if row.anns.length}
              {@const a = row.anns[0]}
              <button
                class="annotation-badge severity-{a.severity}"
                class:orphaned={a.status === 'orphaned'}
                onclick={(e) => onannotationclick?.(a.lineNum, a.lineContent, e)}
                title="{row.anns.length} annotation{row.anns.length > 1 ? 's' : ''}: {a.comment}"
                aria-label="View annotation"
              >💬{#if row.anns.length > 1}<sup>{row.anns.length}</sup>{/if}</button>
            {/if}
          </div>
        {/each}
      </div>
    {/if}
    <!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
    <div class="md-content" bind:this={container} onclick={handleContentClick}>
      {@html html}
    </div>
  </div>
</div>

<style>
  .md-preview {
    padding: 12px 24px 12px 0;
    font-family: system-ui, -apple-system, sans-serif;
    font-size: 14px;
    line-height: 1.6;
    color: var(--text);
    /* 1100px ≈ 90ch at 14px — upper bound of readable prose. Code blocks
       and mermaid get the full width; margin:auto centers on wider panes. */
    max-width: 1100px;
    margin: 0 auto;
  }
  .md-body {
    position: relative;  /* anchor for .md-gutter absolute */
  }
  .md-gutter {
    position: absolute;
    left: 0; top: 0; bottom: 0;
    width: 36px;
    pointer-events: none;  /* badge re-enables */
  }
  .md-gutter-row {
    position: absolute;
    left: 0; right: 0;
    display: flex;
    align-items: flex-start;
    gap: 4px;
  }
  .md-strip-add {
    width: 3px;
    height: 100%;
    background: var(--green);
    border-radius: 2px;
    opacity: 0.7;
  }
  .md-gutter :global(.annotation-badge) {
    position: static;  /* override theme.css absolute */
    pointer-events: auto;
    font-size: 13px;
    padding: 2px 4px;
    margin-top: 2px;
  }
  .md-gutter :global(.annotation-badge sup) { font-size: 9px; vertical-align: super; }
  .md-content {
    padding-left: 36px;
    /* Containing block for fixed-position descendants — neutralizes the
       <div style="position:fixed;..."> phishing-overlay vector without
       stripping inline style. On the outer .md-preview this broke ToC sticky
       (browsers treat any paint-clipping ancestor as the sticky scroll
       boundary; ToC now sits OUTSIDE this and sticks to .panel-content). */
    contain: layout paint;
    /* Long unbroken tokens (URLs, hashes) would be clipped by contain:paint. */
    overflow-wrap: break-word;
  }
  .md-preview :global(h1), .md-preview :global(h2), .md-preview :global(h3),
  .md-preview :global(h4), .md-preview :global(h5), .md-preview :global(h6) {
    font-weight: 600;
    line-height: 1.25;
    margin: 1.5em 0 0.5em;
    /* scrollIntoView({block:'start'}) + footnote # links would land under
       DiffFileView's sticky .diff-file-header (~33px) without this. */
    scroll-margin-top: 40px;
  }
  .md-preview :global(h1) { font-size: 2em; }
  .md-preview :global(h2) { font-size: 1.5em; }
  .md-preview :global(h3) { font-size: 1.25em; }
  .md-preview :global(h4) { font-size: 1em; }
  .md-preview :global(h5) { font-size: 0.875em; }
  .md-preview :global(h6) { font-size: 0.85em; color: var(--subtext0); }
  .md-preview :global(h1), .md-preview :global(h2) {
    border-bottom: 1px solid var(--surface1);
    padding-bottom: 0.3em;
  }
  .md-preview :global([id^="fn"]) { scroll-margin-top: 40px; }
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
    /* Wide tables would be clipped by contain:paint — display:block lets
       overflow-x scroll. (table-layout stays auto; cells size normally.) */
    display: block;
    overflow-x: auto;
    max-width: 100%;
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
  .md-preview :global(img) {
    /* contain:paint on .md-content silently CLIPS overflow — without this,
       wide screenshots lose their right edge with no scrollbar. */
    max-width: 100%;
    height: auto;
    border-radius: 4px;
  }
  .md-preview :global(hr) {
    border: none;
    border-top: 1px solid var(--surface1);
    margin: 1.5em 0;
  }
  .md-preview :global(ul),
  .md-preview :global(ol) {
    /* Browser defaults vary (40px Chrome / 2.5em legacy). 1.8em is enough
       for ::marker + the diff strip's -1.8em offset to land in clear space. */
    padding-left: 1.8em;
  }
  .md-preview :global(.fn-ref) {
    font-size: 0.75em;
    line-height: 0;  /* don't push line-height of surrounding prose */
  }
  .md-preview :global(.fn-ref a) {
    text-decoration: none;
    padding: 0 2px;
  }
  .md-preview :global(.footnotes) {
    margin-top: 2.5em;
    padding-top: 0.8em;
    border-top: 1px solid var(--surface1);
    font-size: 0.88em;
    color: var(--subtext0);
  }
  .md-preview :global(.footnotes ol) {
    padding-left: 1.5em;
  }
  .md-preview :global(.fn-back) {
    text-decoration: none;
    font-family: system-ui;  /* ↩ glyph */
    margin-left: 4px;
  }
  .md-preview :global(.md-alert) {
    padding: 10px 14px;
    margin: 1em 0;
    border-left: 3px solid var(--alert-c);
    border-radius: 0 4px 4px 0;
    background: color-mix(in srgb, var(--alert-c) 8%, transparent);
  }
  .md-preview :global(.md-alert-title) {
    margin: 0 0 4px;
    font-weight: 600;
    font-size: 0.85em;
    color: var(--alert-c);
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }
  .md-preview :global(.md-alert > p:last-child) { margin-bottom: 0; }
  .md-preview :global(.md-alert-note)      { --alert-c: var(--blue); }
  .md-preview :global(.md-alert-tip)       { --alert-c: var(--green); }
  .md-preview :global(.md-alert-important) { --alert-c: var(--mauve); }
  .md-preview :global(.md-alert-warning)   { --alert-c: var(--amber); }
  .md-preview :global(.md-alert-caution)   { --alert-c: var(--red); }
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

  /* ToC minimap. position:sticky works through contain:paint (unlike fixed,
     which it traps) — sticks at scroll-top while the preview is in view,
     scrolls away when the file scrolls off. float:right takes it out of flow
     so prose wraps around it. */
  .md-toc {
    position: sticky;
    /* .diff-file-header (sticky top:0, ~33px tall) sits above; offset below it. */
    top: 40px;
    float: right;
    width: 170px;
    max-height: 70vh;
    /* Flex column: close button stays in the non-scrolling header zone,
       only .md-toc-items scrolls (so the › doesn't disappear on long ToCs). */
    display: flex;
    flex-direction: column;
    margin: 0 -8px 12px 20px;
    padding: 4px 0;
    background: color-mix(in srgb, var(--mantle) 80%, transparent);
    border-radius: 6px;
    backdrop-filter: blur(6px);
    font-size: 11px;
    opacity: 0.75;
    transition: opacity 120ms ease;
    z-index: 1;
  }
  .md-toc:hover { opacity: 1; }
  .md-toc-items {
    overflow-y: auto;
    min-height: 0;
    scrollbar-width: thin;
  }
  .md-toc-item {
    display: block;
    width: 100%;
    padding: 3px 8px 3px 6px;
    background: transparent;
    border: none;
    border-left: 2px solid transparent;
    text-align: left;
    color: var(--subtext0);
    font-family: inherit;
    font-size: inherit;
    line-height: 1.4;
    cursor: pointer;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    transition: border-color 80ms ease, color 80ms ease;
  }
  .md-toc-item:hover {
    color: var(--text);
    background: var(--surface0);
  }
  .md-toc-item.active {
    color: var(--text);
    border-left-color: var(--amber);
    background: color-mix(in srgb, var(--amber) 8%, transparent);
  }
  .md-toc-item.deep {
    color: var(--overlay0);
    font-size: 10px;
  }
  .md-toc-close {
    align-self: flex-end;
    flex-shrink: 0;
    width: 16px;
    height: 16px;
    margin: 0 4px 2px 0;
    padding: 0;
    background: transparent;
    border: none;
    color: var(--overlay0);
    font-size: 12px;
    line-height: 1;
    cursor: pointer;
    border-radius: 3px;
  }
  .md-toc-close:hover { color: var(--text); background: var(--surface0); }
  /* Collapsed-state tab — same sticky+float positioning as the open ToC so
     it doesn't reflow prose when toggled. */
  .md-toc-tab {
    position: sticky;
    top: 40px;
    float: right;
    margin: 0 -8px 12px 8px;
    z-index: 1;
    opacity: 0.6;
    transition: opacity 120ms ease;
  }
  .md-toc-tab:hover { opacity: 1; }
  .md-toc-tab button {
    width: 18px;
    height: 32px;
    padding: 0;
    background: color-mix(in srgb, var(--mantle) 80%, transparent);
    border: none;
    border-radius: 6px 0 0 6px;
    color: var(--subtext0);
    font-size: 12px;
    cursor: pointer;
    backdrop-filter: blur(6px);
  }
  .md-toc-tab:hover button { color: var(--text); }

  .md-hint {
    display: inline-block;
    font-size: 10px;
    color: var(--overlay0);
    margin: -4px 0 12px 36px;
    padding: 2px 8px;
    background: var(--surface0);
    border-radius: 10px;
    user-select: none;
  }
</style>
