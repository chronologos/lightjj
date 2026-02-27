<script lang="ts">
  import { EditorView, keymap, lineNumbers, highlightActiveLine, highlightActiveLineGutter } from '@codemirror/view'
  import { EditorState } from '@codemirror/state'
  import { defaultKeymap, indentWithTab } from '@codemirror/commands'
  import { foldGutter, foldEffect, unfoldAll, syntaxHighlighting, defaultHighlightStyle, bracketMatching, indentUnit, type LanguageSupport } from '@codemirror/language'
  import { javascript } from '@codemirror/lang-javascript'
  import { python } from '@codemirror/lang-python'
  import { go } from '@codemirror/lang-go'
  import { rust } from '@codemirror/lang-rust'
  import { detectLanguage } from './highlighter'

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

  // Detect the file's existing indentation style so new lines match.
  // Scans up to SAMPLE lines with leading whitespace; falls back to 2-space.
  function detectIndent(src: string): { usesTabs: boolean; width: number } {
    const SAMPLE = 200
    let tabLines = 0
    let spaceLines = 0
    const widthCounts = new Map<number, number>()
    let scanned = 0
    for (const line of src.split('\n')) {
      if (scanned >= SAMPLE) break
      if (line.length === 0 || (line[0] !== ' ' && line[0] !== '\t')) continue
      scanned++
      if (line[0] === '\t') {
        tabLines++
      } else {
        spaceLines++
        // Count leading spaces — the GCD-ish mode of first-indent widths
        let n = 0
        while (n < line.length && line[n] === ' ') n++
        if (n > 0 && n <= 8) widthCounts.set(n, (widthCounts.get(n) ?? 0) + 1)
      }
    }
    const usesTabs = tabLines > spaceLines
    // Most common leading-space count, preferring smaller widths (2 over 4 over 8)
    let width = 2
    let bestCount = 0
    for (const [w, c] of [...widthCounts.entries()].sort((a, b) => a[0] - b[0])) {
      if (c > bestCount) { bestCount = c; width = w }
    }
    return { usesTabs, width }
  }

  function getCmLanguage(filePath: string): LanguageSupport | null {
    const lang = detectLanguage(filePath)
    switch (lang) {
      case 'typescript':
      case 'javascript':
        return javascript({ typescript: lang === 'typescript', jsx: true })
      case 'python': return python()
      case 'go': return go()
      case 'rust': return rust()
      default: return null
    }
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

  // Create editor once on mount; don't re-create on prop changes to preserve in-progress edits
  $effect(() => {
    if (!containerEl || view) return

    const langSupport = getCmLanguage(filePath)

    // Detect whether the file uses tabs or spaces for indentation, and what
    // the indent width is. This keeps new lines aligned with existing ones.
    // Heuristic: scan first ~200 non-blank leading-whitespace lines.
    const { usesTabs, width } = detectIndent(content)

    const extensions = [
      lineNumbers(),
      highlightActiveLine(),
      highlightActiveLineGutter(),
      foldGutter(),
      bracketMatching(),
      syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
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
        { key: 'Mod-s', run: () => { if (view) onsave(view.state.doc.toString()); return true } },
        { key: 'Escape', run: () => { oncancel(); return true } },
      ]),
      EditorView.theme({
        '&': { height: '100%', fontSize: '12px', backgroundColor: 'var(--base)', color: 'var(--text)' },
        '.cm-scroller': { overflow: 'auto', fontFamily: 'var(--font-mono, monospace)' },
        '.cm-content': { padding: '0', caretColor: 'var(--text)' },
        '.cm-line': { padding: '0 4px', lineHeight: '18px' },
        '.cm-gutters': { minWidth: '3em', backgroundColor: 'var(--mantle)', color: 'var(--subtext0)', borderRight: '1px solid var(--surface0)' },
        '.cm-activeLineGutter': { backgroundColor: 'var(--surface0)' },
        '.cm-activeLine': { backgroundColor: 'var(--surface0)' },
        '&.cm-focused .cm-selectionBackground, .cm-selectionBackground': { backgroundColor: 'var(--bg-selected)' },
        '.cm-cursor': { borderLeftColor: 'var(--text)' },
        '.cm-matchingBracket': { backgroundColor: 'var(--surface1)', outline: '1px solid var(--surface2)' },
        '.cm-foldPlaceholder': { backgroundColor: 'var(--surface0)', border: '1px solid var(--surface1)', color: 'var(--subtext0)' },
      }),
    ]
    if (langSupport) extensions.push(langSupport)

    const state = EditorState.create({ doc: content, extensions })
    const editorView = new EditorView({ state, parent: containerEl })

    const foldRanges = computeFoldRanges(state.doc, changedRanges)
    if (foldRanges.length > 0) {
      editorView.dispatch({
        effects: foldRanges.map(r => foldEffect.of({ from: r.from, to: r.to }))
      })
    }

    view = editorView
    return () => { view = undefined; editorView.destroy() }
  })

  export function getContent(): string {
    return view?.state.doc.toString() ?? content
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
