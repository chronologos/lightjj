<script lang="ts">
  import { onMount } from 'svelte'
  import { EditorView, keymap, lineNumbers, highlightActiveLine, highlightActiveLineGutter } from '@codemirror/view'
  import { EditorState, Compartment } from '@codemirror/state'
  import { defaultKeymap, indentWithTab } from '@codemirror/commands'
  import { foldGutter, foldEffect, unfoldAll, bracketMatching, indentUnit } from '@codemirror/language'
  import { detectIndent, getCmLanguage, cmTheme, cmHighlight } from './cm-shared'
  import { registerUnsaved } from './unsaved'
  import { detectEol, withEol } from './eol'

  interface Props {
    content: string
    filePath: string
    changedRanges: { fromLine: number; toLine: number }[]
    onsave: (content: string) => void
    oncancel: () => void
  }

  let { content, filePath, changedRanges, onsave, oncancel }: Props = $props()

  let containerEl: HTMLDivElement | undefined = $state(undefined)
  let view: EditorView | undefined
  let initialDoc: EditorState['doc'] | undefined
  // Fixed at mount, like the document itself.
  // svelte-ignore state_referenced_locally
  const eol = detectEol(content)

  /** The buffer as it must be written: same line endings the file came with. */
  function text(): string | undefined {
    if (!view) return undefined
    // 'mixed' splits on '\n' only (lineSeparator below), so any '\r' is still in the
    // document and comes back exactly where it was.
    return eol === 'mixed' ? view.state.sliceDoc() : withEol(view.state.doc.toString(), eol)
  }

  const isDirty = () => !!view && !!initialDoc && !view.state.doc.eq(initialDoc)
  const unsaved = registerUnsaved({ label: () => filePath, lostOn: 'selection', dirty: isDirty })

  /** Cancel, asking first when there is something to lose. */
  export function requestCancel(): void {
    if (isDirty() && !confirm(`Discard unsaved changes to ${filePath}?`)) return
    oncancel()
  }

  function computeFoldRanges(doc: EditorState['doc'], ranges: Props['changedRanges']): { from: number; to: number }[] {
    if (ranges.length === 0) return []

    const totalLines = doc.lines
    const sorted = [...ranges]
      .filter(r => r.fromLine <= r.toLine && r.fromLine >= 1)
      .sort((a, b) => a.fromLine - b.fromLine)
    if (sorted.length === 0) return []

    const CONTEXT = 3
    const visible: { from: number; to: number }[] = []
    for (const r of sorted) {
      const from = Math.max(1, r.fromLine - CONTEXT)
      const to = Math.min(totalLines, r.toLine + CONTEXT)
      if (visible.length > 0 && from <= visible[visible.length - 1].to + 1) {
        visible[visible.length - 1].to = to
      } else {
        visible.push({ from, to })
      }
    }

    const folds: { from: number; to: number }[] = []
    let cursor = 1
    for (const v of visible) {
      if (cursor < v.from && v.from - 1 <= totalLines) {
        const fromOffset = doc.line(cursor).from
        const toOffset = doc.line(v.from - 1).to
        if (fromOffset < toOffset) folds.push({ from: fromOffset, to: toOffset })
      }
      cursor = v.to + 1
    }
    if (cursor <= totalLines) {
      const fromOffset = doc.line(cursor).from
      const toOffset = doc.line(totalLines).to
      if (fromOffset < toOffset) folds.push({ from: fromOffset, to: toOffset })
    }

    return folds
  }

  // onMount, NOT $effect: the body reads content/changedRanges, and changedRanges is
  // a new array on every diff refresh. As an effect this re-ran on each snapshot
  // (any file, any agent edit), destroying the view and the user's unsaved text.
  onMount(() => {
    if (!containerEl) return

    // Detect whether the file uses tabs or spaces for indentation, and what
    // the indent width is. This keeps new lines aligned with existing ones.
    // Heuristic: scan first ~200 non-blank leading-whitespace lines.
    const { usesTabs, width } = detectIndent(content)

    // getCmLanguage is async (legacy modes lazy-load). The editor mounts
    // immediately with an empty slot; language drops in via reconfigure when
    // resolved. The view === editorView check skips dispatch if cleanup ran.
    const langCompartment = new Compartment()

    const extensions = [
      lineNumbers(),
      highlightActiveLine(),
      highlightActiveLineGutter(),
      foldGutter(),
      bracketMatching(),
      cmHighlight,  // tok-* classes → theme.css --syn-* vars (see cm-shared.ts)
      // tab-size must match DiffFileView's .diff-line { tab-size: 4 } so the
      // left (diff) and right (editor) columns align in split view.
      EditorState.tabSize.of(4),
      // Indent with whatever the file already uses. indentWithTab below will
      // insert this string, not a literal tab, unless the file is tab-indented.
      indentUnit.of(usesTabs ? '\t' : ' '.repeat(width)),
      keymap.of([
        ...defaultKeymap,
        indentWithTab,
        // Use a closure that reads `view` at call time, not at creation time.
        // `view` is guaranteed non-null when the keymap fires because it's set
        // immediately after EditorView construction, before any user interaction.
        { key: 'Mod-s', run: () => { const t = text(); if (t !== undefined) onsave(t); return true } },
        { key: 'Escape', run: () => { requestCancel(); return true } },
      ]),
      cmTheme,
      eol === 'mixed' ? EditorState.lineSeparator.of('\n') : [],
      langCompartment.of([]),
      EditorView.updateListener.of(u => { if (u.docChanged) unsaved.touch() }),
    ]

    const state = EditorState.create({ doc: content, extensions })
    initialDoc = state.doc
    const editorView = new EditorView({ state, parent: containerEl })

    const foldRanges = computeFoldRanges(state.doc, changedRanges)
    if (foldRanges.length > 0) {
      editorView.dispatch({
        effects: foldRanges.map(r => foldEffect.of({ from: r.from, to: r.to }))
      })
    }

    view = editorView
    getCmLanguage(filePath).then(ls => {
      if (ls && view === editorView) editorView.dispatch({ effects: langCompartment.reconfigure(ls) })
    }).catch(() => {})
    return () => { view = undefined; editorView.destroy() }
  })

  export function getContent(): string {
    return text() ?? content
  }

  export function unfoldAllRegions(): void {
    if (view) unfoldAll(view)
  }
</script>

<div class="file-editor" bind:this={containerEl}></div>

<style>
  .file-editor {
    flex: 1;
    min-height: 0;
    overflow: hidden;
  }
  .file-editor :global(.cm-editor) {
    height: 100%;
  }
</style>
