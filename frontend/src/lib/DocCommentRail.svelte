<script lang="ts">
  import type { DocSession, PlacedComment } from './doc-session.svelte'
  import { renderMarkdown } from './markdown-render'

  let {
    session,
    onjump,
  }: {
    session: DocSession
    onjump?: (pmPos: number) => void
  } = $props()

  type Thread = { root: PlacedComment; replies: PlacedComment[] }

  const threads = $derived.by((): Thread[] => {
    const roots = session.comments.filter((c) => !c.parentId && !c.orphaned)
    const byParent = new Map<string, PlacedComment[]>()
    for (const c of session.comments) {
      if (!c.parentId) continue
      const arr = byParent.get(c.parentId) ?? []
      arr.push(c)
      byParent.set(c.parentId, arr)
    }
    return roots
      .map((root) => ({
        root,
        replies: (byParent.get(root.id) ?? []).sort((a, b) => a.createdAt - b.createdAt),
      }))
      .sort((a, b) => (a.root.from ?? 0) - (b.root.from ?? 0))
  })

  const openCount = $derived(threads.filter((t) => !t.root.resolution).length)

  let replyDrafts = $state<Record<string, string>>({})

  function fmtAge(ts: number): string {
    const s = Math.floor((Date.now() - ts) / 1000)
    if (s < 60) return `${s}s`
    if (s < 3600) return `${Math.floor(s / 60)}m`
    if (s < 86400) return `${Math.floor(s / 3600)}h`
    return `${Math.floor(s / 86400)}d`
  }

  async function submitReply(rootId: string) {
    const body = replyDrafts[rootId]?.trim()
    if (!body) return
    const root = session.comments.find((c) => c.id === rootId)
    if (!root || root.from === undefined || root.to === undefined) return
    await session.addComment(root.from, root.to, body, rootId)
    replyDrafts = { ...replyDrafts, [rootId]: '' }
  }
</script>

<div class="rail">
  <div class="panel-header">
    <span class="panel-title">Comments</span>
    <span class="rail-count">{openCount} open</span>
  </div>

  <div class="rail-body">
    {#each threads as t (t.root.id)}
      <div class="thread" class:resolved={!!t.root.resolution}>
        <button
          class="thread-quote"
          onclick={() => t.root.from !== undefined && onjump?.(t.root.from)}
          title="Jump to selection"
        >
          {t.root.anchor.selection || '(empty selection)'}
        </button>
        {#each [t.root, ...t.replies] as c (c.id)}
          <div class="comment">
            <div class="comment-meta">
              <span class="author">{c.author}</span>
              <span class="age">{fmtAge(c.createdAt)}</span>
            </div>
            <div class="comment-body">{@html renderMarkdown(c.body)}</div>
          </div>
        {/each}
        <div class="thread-actions">
          <input
            class="modal-input reply-input"
            placeholder="Reply…"
            bind:value={replyDrafts[t.root.id]}
            onkeydown={(e) => e.key === 'Enter' && !e.shiftKey && (e.preventDefault(), submitReply(t.root.id))}
          />
          {#if !t.root.resolution}
            <button class="btn-sm" onclick={() => session.resolveComment(t.root.id, 'addressed')}>Resolve</button>
          {:else}
            <span class="resolved-badge">✓ {t.root.resolution}</span>
          {/if}
          <button class="btn-sm" onclick={() => session.removeComment(t.root.id)} title="Delete thread">✕</button>
        </div>
      </div>
    {:else}
      <div class="placeholder-text">No comments. Select text in the document to add one.</div>
    {/each}

    {#if session.orphanedComments.length > 0}
      <div class="panel-header orphan-header">
        <span class="panel-title">Orphaned</span>
        <span class="rail-count">{session.orphanedComments.length}</span>
      </div>
      {#each session.orphanedComments as c (c.id)}
        <div class="thread orphaned">
          <div class="thread-quote orphan-quote">{c.anchor.selection}</div>
          <div class="comment">
            <div class="comment-body">{@html renderMarkdown(c.body)}</div>
          </div>
          <div class="thread-actions">
            <button class="btn-sm" onclick={() => session.removeComment(c.id)}>✕</button>
          </div>
        </div>
      {/each}
    {/if}
  </div>
</div>

<style>
  .rail {
    display: flex;
    flex-direction: column;
    width: 340px;
    flex-shrink: 0;
    height: 100%;
    border-left: 1px solid var(--surface1);
    background: var(--mantle);
  }
  .rail-body { flex: 1; overflow-y: auto; padding: 8px; }
  .rail-count { font-size: var(--fs-xs); color: var(--subtext0); }

  .thread {
    border: 1px solid var(--surface1);
    border-radius: 4px;
    margin-bottom: 8px;
    background: var(--base);
    overflow: hidden;
  }
  .thread.resolved { opacity: 0.55; }
  .thread.orphaned { border-color: var(--surface2); border-style: dashed; }

  .thread-quote {
    display: block;
    width: 100%;
    text-align: left;
    border: none;
    border-left: 3px solid var(--amber);
    background: var(--bg-warning);
    padding: 4px 8px;
    font-family: var(--font-ui);
    font-size: var(--fs-xs);
    color: var(--subtext1);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    cursor: pointer;
  }
  .thread-quote:hover { background: var(--bg-active); }
  .orphan-quote { border-left-color: var(--surface2); background: var(--surface0); cursor: default; }

  .comment { padding: 6px 8px; border-top: 1px solid var(--surface0); }
  .comment:first-of-type { border-top: none; }
  .comment-meta { display: flex; gap: 6px; font-size: var(--fs-2xs); color: var(--subtext0); margin-bottom: 2px; }
  .author { font-weight: 600; }
  .comment-body { font-size: var(--fs-sm); }
  .comment-body :global(p) { margin: 0.2em 0; }
  .comment-body :global(code) { font-family: var(--font-mono); font-size: 0.92em; }

  .thread-actions {
    display: flex;
    gap: 4px;
    padding: 4px 6px;
    border-top: 1px solid var(--surface0);
    align-items: center;
  }
  .reply-input { flex: 1; font-size: var(--fs-xs); padding: 2px 6px; }
  .resolved-badge { font-size: var(--fs-2xs); color: var(--green); }

  .orphan-header { margin-top: 12px; }
</style>
