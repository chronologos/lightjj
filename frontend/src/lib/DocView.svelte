<script lang="ts">
  import { onDestroy } from 'svelte'
  import { EditorState } from 'prosemirror-state'
  import { EditorView, Decoration, DecorationSet } from 'prosemirror-view'
  import { keymap } from 'prosemirror-keymap'
  import { history, undo, redo } from 'prosemirror-history'
  import { baseKeymap, toggleMark } from 'prosemirror-commands'
  import { inputRules, textblockTypeInputRule, wrappingInputRule } from 'prosemirror-inputrules'
  import { splitListItem, liftListItem, sinkListItem } from 'prosemirror-schema-list'
  import { docSchema } from './pm-schema'
  import { mermaidNodeViews } from './pm-mermaid'
  import type { DocSession } from './doc-session.svelte'

  let {
    session,
    editable = false,
    focusedComment = null,
    onaddcomment,
    onsave,
  }: {
    session: DocSession
    editable?: boolean
    focusedComment?: string | null
    onaddcomment?: (from: number, to: number, x: number, y: number) => void
    onsave?: () => void
  } = $props()

  // Editing plugins only matter when editable; created once. baseKeymap covers
  // Enter/Backspace/Delete; the chained map adds undo/redo + list structure.
  // Cmd+S returns true synchronously so the browser's save dialog is suppressed
  // even though onsave is async.
  const editPlugins = [
    history(),
    keymap({
      'Mod-z': undo,
      'Mod-y': redo,
      'Mod-Shift-z': redo,
      'Mod-s': () => { onsave?.(); return true },
      'Mod-b': toggleMark(docSchema.marks.strong),
      'Mod-i': toggleMark(docSchema.marks.em),
      'Mod-`': toggleMark(docSchema.marks.code),
      'Enter': splitListItem(docSchema.nodes.list_item),
      'Tab': sinkListItem(docSchema.nodes.list_item),
      'Shift-Tab': liftListItem(docSchema.nodes.list_item),
    }),
    keymap(baseKeymap),
    // Markdown-ish typing: `# `, `> `, `- `, `1. `, ``` at line start convert
    // the block in place. Backspace immediately after reverts (built into
    // inputRules). prosemirror-inputrules: same author as the other 8 PM
    // packages, transitives are state+transform (already installed).
    inputRules({ rules: [
      textblockTypeInputRule(/^(#{1,6})\s$/, docSchema.nodes.heading, (m) => ({ level: m[1].length })),
      textblockTypeInputRule(/^```$/, docSchema.nodes.code_block),
      wrappingInputRule(/^>\s$/, docSchema.nodes.blockquote),
      wrappingInputRule(/^[-*]\s$/, docSchema.nodes.bullet_list),
      wrappingInputRule(/^(\d+)\.\s$/, docSchema.nodes.ordered_list,
        (m) => ({ order: +m[1] }),
        (m, node) => node.childCount + (node.attrs.order as number) === +m[1]),
    ] }),
  ]

  let mount: HTMLDivElement
  let view: EditorView | undefined
  let affordance = $state<{ x: number; y: number; from: number; to: number } | null>(null)

  // Comment highlights. Pure f(session.comments, session.doc) — pushed to
  // the view via setProps rather than plugin state.
  const decoSet = $derived.by(() => {
    const d = session.doc
    if (!d) return DecorationSet.empty
    const decos = session.comments
      .filter((c) => !c.parentId && !c.orphaned && c.from !== undefined && c.to !== undefined && c.from < c.to)
      .map((c) =>
        Decoration.inline(c.from!, c.to!, {
          class:
            (c.resolution ? 'doc-comment-hl resolved' : 'doc-comment-hl') +
            (c.id === focusedComment ? ' focused' : ''),
          'data-comment-id': c.id,
        }),
      )
    return DecorationSet.create(d, decos)
  })

  // Create view once (first non-null state), then sync via updateState. No
  // cleanup-return — destroy+recreate per transaction would thrash; onDestroy
  // handles unmount. {#key docFilePath} in the parent gives a fresh mount per
  // file, so view is always 1:1 with session.
  // session.doc is a Node, not an EditorState — DocView owns the state (plugins
  // + history are view-local). dispatchTransaction applies tr here AND notifies
  // the session for comment-mapping. session.doc only changes externally on
  // import/reload, so the else-if branch fires once per file, not per keystroke.
  let importedDoc: typeof session.doc = null
  $effect(() => {
    const d = session.doc
    if (!d || !mount) return
    if (!view) {
      importedDoc = d
      view = new EditorView(mount, {
        state: EditorState.create({ schema: docSchema, doc: d, plugins: editPlugins }),
        editable: () => editable,
        nodeViews: mermaidNodeViews,
        decorations: () => decoSet,
        dispatchTransaction: (tr) => {
          if (!view) return
          const ns = view.state.apply(tr)
          view.updateState(ns)
          session.onTransaction(tr, ns.doc)
        },
      })
    } else if (d !== importedDoc && d !== view.state.doc) {
      importedDoc = d
      view.updateState(EditorState.create({ schema: docSchema, doc: d, plugins: editPlugins }))
    }
  })

  $effect(() => {
    view?.setProps({ editable: () => editable })
  })

  $effect(() => {
    const ds = decoSet
    view?.setProps({ decorations: () => ds })
  })

  onDestroy(() => view?.destroy())

  // Exported so the rail's Accept button can apply a suggestion. session
  // returns the edit spec (pure); the view builds the tr (it owns state).
  export function applyReplace(from: number, to: number, text: string) {
    if (!view) return
    view.dispatch(view.state.tr.insertText(text, from, to))
  }

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
    if (affordance && onaddcomment && view) {
      // Viewport coords are recomputed at click time (not stored at mouseup) so
      // a scroll between select and click still positions the bubble correctly.
      const c = view.coordsAtPos(affordance.to)
      onaddcomment(affordance.from, affordance.to, c.left, c.bottom)
    }
    affordance = null
  }
</script>

<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
<div class="doc-view prose" bind:this={mount} onmouseup={handleMouseUp} role="document">
  {#if affordance}
    <button
      class="btn btn-sm doc-add-comment"
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
  }
  /* Typography comes from theme.css .prose. Here: PM-specific layout only.
     max-width matches MarkdownPreview's .md-preview so the View↔Edit toggle
     doesn't reflow text. */
  .doc-view :global(.ProseMirror) {
    outline: none;
    max-width: 920px;
    margin: 0 auto;
  }
  .doc-view :global(.ProseMirror > :first-child) { margin-top: 0; }

  .doc-view :global(.doc-comment-hl) {
    background: var(--bg-warning);
    border-bottom: 1px solid var(--amber);
    cursor: pointer;
  }
  .doc-view :global(.doc-comment-hl.resolved) {
    background: var(--surface0);
    border-bottom: 1px dotted var(--subtext0);
  }
  .doc-view :global(.doc-comment-hl.focused) {
    outline: 2px solid var(--amber);
    outline-offset: 1px;
    background: var(--bg-active);
    border-radius: 2px;
  }

  .doc-view :global(.pm-mermaid) {
    position: relative;
    border: 1px solid var(--surface1);
    border-radius: 4px;
    margin: 12px 0;
  }
  .doc-view :global(.pm-mermaid-toggle) {
    position: absolute;
    top: 4px;
    right: 4px;
    z-index: 2;
    font-family: var(--font-ui);
    /* Same as .doc-add-comment: .btn is transparent; floats over the diagram. */
    background: var(--mantle);
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.25);
  }
  .doc-view :global(.pm-mermaid-src) {
    margin: 0;
    padding: 8px;
    display: none;
  }
  .doc-view :global(.pm-mermaid.show-source .pm-mermaid-src) { display: block; }
  .doc-view :global(.pm-mermaid.show-source .mermaid-block) { display: none; }

  .doc-add-comment {
    position: absolute;
    z-index: 5;
    white-space: nowrap;
    /* .prose sets weight 370 / fs-lg on the container; reassert UI chrome. */
    font-family: var(--font-ui);
    font-weight: 500;
    /* .btn is transparent (ghost) — fine in toolbars, illegible when floating
     * over highlighted prose. Opaque + shadow lifts it off the selection. */
    background: var(--mantle);
    color: var(--text);
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.25);
  }
</style>
