<script lang="ts">
  import type { DocSession, PlacedComment } from './doc-session.svelte'
  import type { CommentVisibility } from './comment-visibility.svelte'
  import { fromDocComment } from './review'
  import CommentCard from './CommentCard.svelte'

  let {
    session,
    vis,
    onjump,
    onhover,
    onaccept,
  }: {
    session: DocSession
    vis?: CommentVisibility
    onjump?: (pmPos: number) => void
    onhover?: (id: string | null) => void
    onaccept?: (id: string) => void
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

  const hidden = $derived(vis?.hiddenAuthors ?? new Set<string>())
  const visibleThreads = $derived(threads.filter((t) => !t.root.author || !hidden.has(t.root.author)))
  const openCount = $derived(visibleThreads.filter((t) => !t.root.resolution).length)

  let navIdx = $state(-1)

  /** {/}' nav over open threads in document order. Returns false when none. */
  export function stepComment(dir: 1 | -1): boolean {
    const open = visibleThreads.filter((t) => !t.root.resolution)
    if (open.length === 0) return false
    navIdx = (navIdx + dir + open.length) % open.length
    const t = open[navIdx]
    if (t.root.from !== undefined) onjump?.(t.root.from)
    onhover?.(t.root.id)
    return true
  }
</script>

<div class="rail">
  <div class="panel-header">
    <span class="panel-title">Comments</span>
    <span class="rail-count">{openCount} open</span>
    {#if hidden.size > 0}
      <span class="rail-filter" title="Hidden authors: {[...hidden].join(', ')}">
        {hidden.size} hidden
        {#each hidden as a}<button class="btn btn-sm" onclick={() => vis?.showAuthor(a)}>{a} ×</button>{/each}
      </span>
    {/if}
  </div>

  <div class="rail-body">
    {#each visibleThreads as t (t.root.id)}
      <CommentCard
        review={fromDocComment(t.root)}
        replies={t.replies.map(fromDocComment)}
        anchorText={t.root.anchor.selection}
        orphaned={t.root.orphaned}
        onjump={t.root.from !== undefined ? () => onjump?.(t.root.from!) : undefined}
        onhover={(id) => onhover?.(id)}
        onresolve={(id, r) => session.resolveComment(id, r)}
        onreply={(rootId, body) => {
          const root = session.comments.find((c) => c.id === rootId)
          if (root?.from !== undefined && root.to !== undefined) {
            void session.addComment(root.from, root.to, body, rootId)
          }
        }}
        onaccept={t.root.kind === 'suggestion' ? onaccept : undefined}
        ondelete={(id) => session.removeComment(id)}
        onhideauthor={vis ? (a) => vis.hideAuthor(a) : undefined}
      />
    {:else}
      <div class="placeholder-text">No comments yet. Select text to add one, or paste the Agent hint into a coding agent to request a review.</div>
    {/each}

    {#if session.orphanedComments.length > 0}
      <div class="panel-header orphan-header">
        <span class="panel-title">Orphaned</span>
        <span class="rail-count">{session.orphanedComments.length}</span>
      </div>
      {#each session.orphanedComments as c (c.id)}
        <CommentCard
          review={fromDocComment(c)}
          anchorText={c.anchor.selection}
          orphaned
          onresolve={(id, r) => session.resolveComment(id, r)}
          ondelete={(id) => session.removeComment(id)}
        />
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
  .rail-body { flex: 1; overflow-y: auto; padding: 8px; display: flex; flex-direction: column; gap: 8px; }
  .rail-count { font-size: var(--fs-xs); color: var(--subtext0); }
  .rail-filter { font-size: var(--fs-2xs); color: var(--subtext0); margin-left: auto; display: inline-flex; gap: 4px; align-items: center; }
  .orphan-header { margin-top: 12px; }
  .orphan-header .panel-title { color: var(--amber); }

  @media (max-width: 900px) {
    .rail { width: 240px; }
  }
</style>
