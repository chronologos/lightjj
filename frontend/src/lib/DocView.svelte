<script lang="ts">
  import { onDestroy } from 'svelte'
  import { EditorView, Decoration, DecorationSet } from 'prosemirror-view'
  import type { DocSession } from './doc-session.svelte'

  let {
    session,
    onaddcomment,
  }: {
    session: DocSession
    onaddcomment?: (from: number, to: number) => void
  } = $props()

  let mount: HTMLDivElement
  let view: EditorView | undefined
  let affordance = $state<{ x: number; y: number; from: number; to: number } | null>(null)

  // Comment highlights. Pure f(session.comments, session.state.doc) — pushed to
  // the view via setProps rather than plugin state.
  const decoSet = $derived.by(() => {
    const st = session.state
    if (!st) return DecorationSet.empty
    const decos = session.comments
      .filter((c) => !c.parentId && !c.orphaned && c.from !== undefined && c.to !== undefined && c.from < c.to)
      .map((c) =>
        Decoration.inline(c.from!, c.to!, {
          class: c.resolution ? 'doc-comment-hl resolved' : 'doc-comment-hl',
          'data-comment-id': c.id,
        }),
      )
    return DecorationSet.create(st.doc, decos)
  })

  // Create view once (first non-null state), then sync via updateState. No
  // cleanup-return — destroy+recreate per transaction would thrash; onDestroy
  // handles unmount. {#key docFilePath} in the parent gives a fresh mount per
  // file, so view is always 1:1 with session.
  $effect(() => {
    const st = session.state
    if (!st || !mount) return
    if (!view) {
      view = new EditorView(mount, {
        state: st,
        editable: () => false,
        decorations: () => decoSet,
        dispatchTransaction: (tr) => session.onTransaction(tr),
      })
    } else if (view.state !== st) {
      view.updateState(st)
    }
  })

  $effect(() => {
    const ds = decoSet
    view?.setProps({ decorations: () => ds })
  })

  onDestroy(() => view?.destroy())

  // Exported for parent (DocCommentRail click → scroll). BookmarksPanel pattern.
  export function scrollTo(pmPos: number) {
    if (!view) return
    const dom = view.domAtPos(pmPos)
    const el = dom.node instanceof Element ? dom.node : dom.node.parentElement
    el?.scrollIntoView({ block: 'center', behavior: 'smooth' })
  }

  function handleMouseUp() {
    if (!view) return
    const sel = view.state.selection
    if (sel.empty) {
      affordance = null
      return
    }
    const coords = view.coordsAtPos(sel.to)
    const box = mount.getBoundingClientRect()
    // coords/box are both viewport-relative; the affordance is position:absolute
    // inside the scroll container, so add scroll offset to land in content space.
    affordance = {
      x: coords.right - box.left + mount.scrollLeft,
      y: coords.top - box.top + mount.scrollTop,
      from: sel.from,
      to: sel.to,
    }
  }

  function handleAddClick() {
    if (affordance && onaddcomment) onaddcomment(affordance.from, affordance.to)
    affordance = null
  }
</script>

<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
<div class="doc-view" bind:this={mount} onmouseup={handleMouseUp} role="document">
  {#if affordance}
    <button
      class="btn-sm doc-add-comment"
      style:left="{affordance.x + 6}px"
      style:top="{affordance.y}px"
      onclick={handleAddClick}
      onmousedown={(e) => e.preventDefault()}
    >
      💬 Comment
    </button>
  {/if}
</div>

<style>
  .doc-view {
    position: relative;
    height: 100%;
    overflow-y: auto;
    padding: 24px 32px;
    font-family: var(--font-ui);
    font-size: var(--fs-md);
    line-height: 1.6;
    color: var(--text);
  }
  .doc-view :global(.ProseMirror) {
    outline: none;
    max-width: 760px;
    margin: 0 auto;
  }
  .doc-view :global(.ProseMirror h1) { font-size: var(--fs-xl); margin: 1.2em 0 0.4em; }
  .doc-view :global(.ProseMirror h2) { font-size: var(--fs-lg); margin: 1.2em 0 0.4em; }
  .doc-view :global(.ProseMirror h3) { font-size: var(--fs-md); margin: 1em 0 0.3em; font-weight: 600; }
  .doc-view :global(.ProseMirror p) { margin: 0.5em 0; }
  .doc-view :global(.ProseMirror code) {
    font-family: var(--font-mono);
    font-size: 0.92em;
    background: var(--surface0);
    padding: 1px 4px;
    border-radius: 3px;
  }
  .doc-view :global(.ProseMirror pre) {
    font-family: var(--font-mono);
    background: var(--surface0);
    padding: 10px 12px;
    border-radius: 4px;
    overflow-x: auto;
  }
  .doc-view :global(.ProseMirror pre code) { background: none; padding: 0; }
  .doc-view :global(.ProseMirror blockquote) {
    border-left: 3px solid var(--surface2);
    margin: 0.5em 0;
    padding: 0 0 0 12px;
    color: var(--subtext0);
  }
  .doc-view :global(.ProseMirror hr) { border: none; border-top: 1px solid var(--surface1); margin: 1.5em 0; }
  .doc-view :global(.ProseMirror ul),
  .doc-view :global(.ProseMirror ol) { padding-left: 24px; margin: 0.4em 0; }

  .doc-view :global(.doc-comment-hl) {
    background: var(--bg-warning);
    border-bottom: 1px solid var(--amber);
    cursor: pointer;
  }
  .doc-view :global(.doc-comment-hl.resolved) {
    background: var(--surface0);
    border-bottom: 1px dotted var(--subtext0);
  }

  .doc-add-comment {
    position: absolute;
    z-index: 5;
    white-space: nowrap;
  }
</style>
