<!--
  Unified comment card — renders a Review (annotation or doc-comment) with
  replies and intent callbacks. Pure presentational: never imports ReviewAnchor;
  the parent surface computes anchorText/staleness from its own context and
  owns mutation. Extracted from DocCommentRail's .thread block.
  See docs/design-notes/unified-review.md.
-->
<script lang="ts">
  import type { Resolution, Review } from './review'
  import { SEVERITY_VAR } from './review'
  import { renderMarkdown } from './markdown-render'
  import { relativeTime } from './time-format'

  let {
    review,
    anchorText,
    staleness,
    replies = [],
    orphaned = false,
    onresolve,
    onreply,
    onaccept,
    ondelete,
    onhideauthor,
    onjump,
    onhover,
  }: {
    review: Review
    anchorText: string
    staleness?: number
    replies?: Review[]
    orphaned?: boolean
    onresolve?: (id: string, r: Resolution) => void
    onreply?: (id: string, body: string) => void
    onaccept?: (id: string) => void
    ondelete?: (id: string) => void
    onhideauthor?: (author: string) => void
    onjump?: () => void
    onhover?: (id: string | null) => void
  } = $props()

  let replyDraft = $state('')

  const sevVar = $derived(SEVERITY_VAR[review.severity ?? 'nitpick'])
  const isSugg = $derived(review.kind === 'suggestion' && !!review.suggestion)

  function submitReply() {
    const body = replyDraft.trim()
    if (!body) return
    onreply?.(review.id, body)
    replyDraft = ''
  }
</script>

<!-- svelte-ignore a11y_no_static_element_interactions a11y_mouse_events_have_key_events -->
<div
  class="cmt"
  class:resolved={!!review.resolution}
  class:orphaned
  style:--sev={`var(${sevVar})`}
  onmouseenter={() => onhover?.(review.id)}
  onmouseleave={() => onhover?.(null)}
>
  <button
    class="cmt-quote"
    class:is-suggestion={isSugg}
    onclick={onjump}
    disabled={!onjump}
    title={onjump ? 'Jump to anchor' : undefined}
  >
    {#if isSugg}
      <span class="sugg-del">{anchorText}</span>
      <span class="sugg-add">{review.suggestion?.replacement}</span>
    {:else}
      {anchorText || '(no anchor text)'}
    {/if}
  </button>

  {#each [review, ...replies] as c, i (c.id)}
    <div class="cmt-entry" class:is-reply={i > 0}>
      <div class="cmt-meta">
        <span class="cmt-author" class:agent={!!c.author && c.author !== 'you'}>{c.author ?? 'you'}</span>
        <span class="cmt-age">{relativeTime(c.createdAt)}</span>
        {#if i === 0 && staleness}<span class="cmt-stale" title="Created {staleness} commit{staleness === 1 ? '' : 's'} ago">commit −{staleness}</span>{/if}
        {#if i === 0 && review.severity && review.severity !== 'reviewed'}<span class="cmt-sev">{review.severity}</span>{/if}
      </div>
      {#if c.body}<div class="cmt-body">{@html renderMarkdown(c.body)}</div>{/if}
    </div>
  {/each}

  <div class="cmt-actions">
    {#if onreply}
      <input
        class="modal-input cmt-reply-input"
        placeholder="Reply…"
        bind:value={replyDraft}
        onkeydown={(e) => e.key === 'Enter' && !e.shiftKey && (e.preventDefault(), submitReply())}
      />
    {/if}
    {#if !review.resolution}
      {#if isSugg && onaccept}
        <button class="btn btn-sm btn-primary" disabled={orphaned} onclick={() => onaccept(review.id)}>Accept</button>
        <button class="btn btn-sm" onclick={() => onresolve?.(review.id, 'wontfix')}>Reject</button>
      {:else}
        <button class="btn btn-sm" onclick={() => onresolve?.(review.id, 'addressed')}>Resolve</button>
        <button class="btn btn-sm" onclick={() => onresolve?.(review.id, 'wontfix')} title="Mark won't-fix">✗</button>
      {/if}
    {:else}
      <span class="cmt-resolved" class:wontfix={review.resolution === 'wontfix'}>
        {review.resolution === 'wontfix' ? '✗' : '✓'} {review.resolution}
      </span>
      {#if isSugg && review.resolution === 'addressed'}
        <button class="btn btn-sm" onclick={() => onresolve?.(review.id, 'wontfix')} title="Mark rejected instead (text change stays)">Reject</button>
      {/if}
    {/if}
    {#if onhideauthor && review.author && review.author !== 'you'}
      <button class="btn btn-sm" onclick={() => onhideauthor(review.author!)} title="Hide all from {review.author}">Hide author</button>
    {/if}
    {#if ondelete}
      <button class="btn btn-sm btn-danger" onclick={() => ondelete(review.id)} title="Delete">✕</button>
    {/if}
  </div>
</div>

<style>
  .cmt {
    border: 1px solid var(--surface1);
    border-left: 3px solid var(--sev);
    border-radius: 4px;
    background: var(--base);
    overflow: hidden;
    transition: opacity var(--anim-duration) var(--anim-ease);
  }
  .cmt.resolved { opacity: 0.55; }
  .cmt.resolved:hover { opacity: 1; }
  .cmt.orphaned { border-style: dashed; border-left-style: solid; }

  .cmt-quote {
    display: block;
    width: 100%;
    text-align: left;
    border: none;
    background: color-mix(in srgb, var(--sev) 10%, transparent);
    padding: 4px 8px;
    font-family: var(--font-ui);
    font-size: var(--fs-xs);
    color: var(--subtext1);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    cursor: pointer;
  }
  .cmt-quote:disabled { cursor: default; }
  .cmt-quote:not(:disabled):hover { background: color-mix(in srgb, var(--sev) 16%, transparent); }
  .cmt-quote.is-suggestion {
    white-space: normal;
    display: flex;
    flex-direction: column;
    gap: 2px;
    font-family: var(--font-mono);
  }
  .sugg-del, .sugg-add { display: block; overflow-wrap: break-word; }
  .sugg-del { color: var(--red); text-decoration: line-through; background: var(--diff-remove-bg); padding: 1px 4px; }
  .sugg-add { color: var(--green); background: var(--diff-add-bg); padding: 1px 4px; }

  .cmt-entry { padding: 6px 8px; border-top: 1px solid var(--surface0); }
  .cmt-entry:first-of-type { border-top: none; }
  .cmt-entry.is-reply { padding-left: 16px; border-left: 2px solid var(--surface2); margin-left: 6px; }
  .cmt-meta { display: flex; gap: 6px; align-items: baseline; font-size: var(--fs-2xs); color: var(--subtext0); margin-bottom: 2px; }
  .cmt-author { font-weight: 600; }
  .cmt-author.agent::before { content: '⟐ '; color: var(--sev); font-weight: 400; }
  .cmt-stale { padding: 0 4px; border: 1px dashed var(--surface2); border-radius: 3px; }
  .cmt-sev { color: var(--sev); margin-left: auto; }
  .cmt-body { font-size: var(--fs-sm); }
  .cmt-body :global(p) { margin: 0.2em 0; }
  .cmt-body :global(code) { font-family: var(--font-mono); font-size: 0.92em; }

  .cmt-actions {
    display: flex;
    gap: 4px;
    padding: 4px 6px;
    border-top: 1px solid var(--surface0);
    align-items: center;
  }
  .cmt-reply-input { flex: 1; font-size: var(--fs-xs); padding: 2px 6px; }
  .cmt-resolved { font-size: var(--fs-2xs); color: var(--green); }
  .cmt-resolved.wontfix { color: var(--subtext0); }
</style>
