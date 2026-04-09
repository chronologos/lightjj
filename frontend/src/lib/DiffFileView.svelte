<script lang="ts">
  import { newSideAddedLines, type DiffFile, type DiffHunk, type DiffLine } from './diff-parser'
  import { toSplitView, type SplitLine } from './split-view'
  import type { WordSpan } from './word-diff'
  import { FILE_TYPE_LABELS, type FileChange, type Annotation } from './api'
  import { findConflicts } from './conflict-parser'
  import { hunkKey, fileSelectionState, type SelectionState } from './hunk-apply'
  import type { SearchMatch } from './DiffPanel.svelte'
  import type { ContextMenuItem, ContextMenuHandler } from './ContextMenu.svelte'
  // import type: erased at build — keeps editorRef typed without bundling CM6.
  import type FileEditor from './FileEditor.svelte'
  import { escapeHtml } from './highlighter'

  interface Props {
    file: DiffFile
    fileStats: FileChange | undefined
    isCollapsed: boolean
    isExpanded: boolean
    /** Maps effective (post-merge) gap index → original gap index. Undefined =
     *  identity (no gaps revealed yet). See context-expand.ts. */
    gapMap?: number[]
    splitView: boolean
    highlightedLines: Map<string, string>
    wordDiffs: Map<string, Map<number, WordSpan[]>>
    ontoggle: (path: string) => void
    /** gapIdx: which gap to reveal (original-diff index via gapMap). -1 = all. */
    onexpand?: (path: string, gapIdx: number) => void
    onmerge?: (file: string) => void
    searchMatches?: { item: SearchMatch; index: number }[]
    currentMatchIdx?: number
    editing?: boolean
    editContent?: string
    editBusy?: boolean
    onedit?: (path: string) => void
    /** Toggle markdown preview. undefined = disabled (multi-rev mode). Gated
     *  on .md extension at the render site. */
    onpreview?: (path: string) => void
    previewContent?: string
    /** Commit id for image-src resolution in markdown preview. */
    previewRevision?: string
    ondiscard?: (path: string, sourcePath?: string) => void
    onsavefile?: (path: string, content: string) => void
    oncanceledit?: (path: string) => void
    onlinecontext?: (e: MouseEvent, info: DiffLineInfo) => void
    /** File-header context menu. Items built here (component owns filePath/
     *  isCollapsed/isExpanded/fileStats); parent supplies only the singleton
     *  renderer. Distinct from onlinecontext (different signature — raw event
     *  + domain data, parent builds items). */
    oncontextmenu?: ContextMenuHandler
    /** Open in $EDITOR. undefined = disabled (SSH mode). */
    onopenfile?: (path: string, line?: number) => void
    onfilehistory?: (path: string) => void
    oncompare?: (path: string) => void
    /** Lookup annotations for a new-side line number. Called per-line during
     *  render — MUST be O(1) (backed by a Map, not a filter). Stable reference
     *  (the store's forLine method directly) — a fresh closure per render would
     *  defeat MarkdownPreview's gutterRows $derived short-circuit. */
    annotationsForLine?: (filePath: string, lineNum: number) => readonly Annotation[]
    /** Click handler for the annotation gutter badge. Receives the new-side
     *  line number, the line's raw content (without diff prefix), and the
     *  click event (for positioning the bubble). Also fires on left-click of
     *  an unannotated line when Alt is held — quick-annotate shortcut. */
    onannotationclick?: (lineNum: number, lineContent: string, e: MouseEvent) => void
    /** Hunk-level review. When non-null: hunk headers grow checkboxes,
     *  rejected hunks dim to 0.4 (the dimming IS the preview — dimmed =
     *  what moves to the child commit), cursor hunk gets amber ring +
     *  scrollIntoView, file header shows tri-state ◐/●/○. onexpand is
     *  already undefined in this mode (DiffPanel gates it — context
     *  expansion merges adjacent hunks → invalidates keys). */
    hunkReview?: HunkReviewState | null
  }

  export interface HunkReviewState {
    selected: ReadonlySet<string>
    cursor: { path: string; idx: number } | null
    toggle: (path: string, idx: number) => void
    toggleFile: (path: string) => void
  }

  export interface DiffLineInfo {
    filePath: string
    lines: { lineNum: number | null, content: string }[]
  }

  let { file, fileStats, isCollapsed, isExpanded, gapMap, splitView, highlightedLines, wordDiffs, ontoggle, onexpand, onmerge, searchMatches = [], currentMatchIdx = 0, editing = false, editContent, editBusy = false, onedit, onpreview, previewContent, previewRevision, ondiscard, onsavefile, oncanceledit, onlinecontext, oncontextmenu, onopenfile, onfilehistory, oncompare, annotationsForLine, onannotationclick, hunkReview = null }: Props = $props()

  // Translate effective (rendered) gap index → original. When no gaps are
  // revealed, gapMap is undefined → identity. After revealing, hunks merge so
  // rendered indices shift; gapMap from expandGaps() tracks the mapping.
  const origGap = (i: number) => gapMap?.[i] ?? i

  // ── Hunk review derived state ────────────────────────────────────────────
  let reviewFileState: SelectionState | null = $derived(
    hunkReview ? fileSelectionState(file, hunkReview.selected) : null
  )
  const REVIEW_GLYPH = { all: '●', none: '○', some: '◐' } as const

  // Cursor scrollIntoView — only fires when cursor lands on THIS file.
  // `block: 'nearest'` keeps visible hunks from jumping; `data-hunk` queried
  // because the hunk header element is deep in the unified-view each.
  let fileEl: HTMLElement | undefined = $state(undefined)
  $effect(() => {
    if (!hunkReview?.cursor || hunkReview.cursor.path !== filePath) return
    const idx = hunkReview.cursor.idx
    fileEl?.querySelector(`[data-hunk="${idx}"]`)
      ?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
  })

  let editorRef: FileEditor | undefined = $state(undefined)

  // Compute hunk line ranges (1-based) for the "new" side, used by FileEditor for folding
  let changedRanges = $derived(
    file.hunks.filter(h => h.newCount > 0).map(h => ({ fromLine: h.newStart, toLine: h.newStart + h.newCount - 1 }))
  )

  let filePath = $derived(file.filePath)
  let isConflict = $derived(fileStats?.conflict ?? false)
  let isMarkdown = $derived(/\.md$/i.test(filePath))
  let isExcalidraw = $derived(/\.excalidraw$/i.test(filePath))

  // Gutter marks for the markdown preview. Gated on previewContent so the
  // hunk walk doesn't run on every render of the (much hotter) source view.
  let addedLines = $derived(previewContent !== undefined ? newSideAddedLines(file.hunks) : undefined)

  // Hidden context exists if there are lines before the first hunk or between
  // hunks. We can't know trailing lines (no total-line-count in diff headers)
  // so "rest of file" expand is approximated by showing the button whenever
  // ANY leading/between gap exists — the user clicks once, gets everything.
  // Previous gate was `hunks.length > 1` which hid the button entirely for
  // single-hunk-mid-file diffs (the common case).
  let hasHiddenContext = $derived.by(() => {
    if (file.hunks.length === 0) return false
    if (file.hunks[0].newStart > 1) return true
    for (let i = 1; i < file.hunks.length; i++) {
      const prev = file.hunks[i - 1]
      if (file.hunks[i].newStart > prev.newStart + prev.newCount) return true
    }
    return false
  })

  // Truncate long side labels for tab text. Full label goes in title attribute.
  function truncate(s: string, n = 28): string {
    return s.length > n ? s.slice(0, n - 1) + '…' : s
  }

  // Side badge letters: A, B, C... Creates spatial correspondence between
  // buttons ("Keep A") and section tabs ("[A] commit description").
  // Commit messages are opaque — the letter is what the user actually tracks.
  const SIDE_LETTERS = 'ABCDEFGH'
  function sideLetter(idx: number): string {
    return SIDE_LETTERS[idx] ?? String(idx + 1)
  }

  function computeLineNumbers(hunk: DiffHunk): { old: number | null; new: number | null }[] {
    let oldLine = hunk.oldStart
    let newLine = hunk.newStart
    return hunk.lines.map(line => {
      if (line.type === 'context') return { old: oldLine++, new: newLine++ }
      if (line.type === 'remove') return { old: oldLine++, new: null }
      if (line.type === 'add') return { old: null, new: newLine++ }
      return { old: null, new: null }
    })
  }

  function computeSplitLineNumbers(hunks: DiffHunk[], splitLines: SplitLine[]): { oldLeft: number | null; newRight: number | null }[] {
    const hunkOld = hunks.map(h => h.oldStart)
    const hunkNew = hunks.map(h => h.newStart)
    return splitLines.map(sl => {
      let oldLeft: number | null = null
      let newRight: number | null = null
      if (sl.left && sl.left.line.type !== 'header') {
        const hi = sl.left.hunkIdx
        if (sl.left.line.type === 'remove' || sl.left.line.type === 'context') {
          oldLeft = hunkOld[hi]++
        }
      }
      if (sl.right && sl.right.line.type !== 'header') {
        const hi = sl.right.hunkIdx
        if (sl.right.line.type === 'add' || sl.right.line.type === 'context') {
          newRight = hunkNew[hi]++
        }
      }
      return { oldLeft, newRight }
    })
  }

  // Conflicted files force unified view — split view makes no sense when all lines are additions
  let effectiveSplit = $derived(splitView && !isConflict)

  // Memoized split-view data — depends only on file.hunks, not on
  // highlightedLines/wordDiffs which update frequently during rendering
  let splitLines = $derived(effectiveSplit ? toSplitView(file.hunks) : [])
  let splitNums = $derived(effectiveSplit ? computeSplitLineNumbers(file.hunks, splitLines) : [])

  // Memoized unified-view line numbers — keyed by hunk index
  let lineNumsByHunk = $derived(
    effectiveSplit ? [] : file.hunks.map(h => computeLineNumbers(h))
  )

  // Memoize hunk header parsing — only re-runs when file.hunks changes
  let parsedHunkHeaders = $derived(
    file.hunks.map(h => parseHunkHeader(h.header))
  )

  interface ConflictLineMeta {
    cssClass: string
    isRegionStart?: boolean
    isRegionEnd?: boolean
    sideLabel?: string       // what choosing this side KEEPS (the "to" commit for diff sides)
    sideIndex?: number       // 0-based side index within the conflict region
    regionLabel?: string     // e.g. "Conflict 1 of 3"
  }

  interface LineMatch { startCol: number; endCol: number; globalIndex: number }

  // Pre-build per-line search match lookup for O(1) access in the render loop.
  // searchMatches is already filtered to this file by the parent; each entry
  // carries its global index so we can check "is this the current match?"
  // globalIndex (not isCurrent) stored: Map is stable across Enter presses —
  // only the 2 lines containing old-current and new-current re-render.
  let lineMatchMap = $derived.by(() => {
    if (searchMatches.length === 0) return new Map<string, LineMatch[]>()
    const map = new Map<string, LineMatch[]>()
    for (const { item: m, index } of searchMatches) {
      const key = `${m.hunkIdx}:${m.lineIdx}`
      const list = map.get(key) ?? []
      list.push({ startCol: m.startCol, endCol: m.endCol, globalIndex: index })
      map.set(key, list)
    }
    return map
  })

  // Determine inner diff type within a %%%%%%% conflict region.
  // Inside conflict-diff-line, the second character (+/-) indicates the change direction.
  function conflictInnerType(meta: ConflictLineMeta | undefined, content: string): 'remove' | 'add' | 'context' | null {
    if (!meta || meta.cssClass !== 'conflict-diff-line') return null
    const ch = content[1]
    if (ch === '-') return 'remove'
    if (ch === '+') return 'add'
    return 'context'
  }

  // Extract display prefix character for the line gutter
  function getDisplayPrefix(isMarker: boolean, innerType: string | null, inConflict: boolean, content: string): string {
    if (isMarker) return ''
    if (innerType === 'remove') return '-'
    if (innerType === 'add') return '+'
    if (inConflict) return '' // no prefix for conflict content lines
    return content[0] // +/-/space
  }

  // Parse hunk header: "@@ -old,count +new,count @@ optional function context"
  function parseHunkHeader(header: string): { range: string; context: string } {
    const m = header.match(/^@@\s+(-\d+(?:,\d+)?)\s+(\+\d+(?:,\d+)?)\s+@@(.*)$/)
    if (!m) return { range: header, context: '' }
    return { range: `${m[1]} ${m[2]}`, context: m[3].trim() }
  }

  // Extract line number + text content from a .diff-line DOM element.
  // Unified has [old, new] spans — take new-side unconditionally; remove
  // lines yield null (they don't exist in the current file, so copy-ref
  // and open-in-editor correctly skip them). Split has one span.
  function extractLineFromDom(el: Element): { lineNum: number | null, content: string } {
    const spans = el.querySelectorAll('.line-num')
    const t = spans[spans.length - 1]?.textContent?.trim()
    const lineNum = t ? parseInt(t, 10) : null
    let content = ''
    for (const child of el.childNodes) {
      if (child instanceof Element && (child.classList.contains('line-num') || child.classList.contains('diff-prefix'))) continue
      content += child.textContent ?? ''
    }
    return { lineNum, content }
  }

  /** Alt+click on any diff line → quick-annotate (mirrors markdown preview's wireAnnotations). */
  function handleAltClick(e: MouseEvent, annLine: number | null, rawContent: string): void {
    if (!e.altKey || annLine === null || !onannotationclick) return
    e.preventDefault()
    onannotationclick(annLine, rawContent, e)
  }

  function handleLineContextMenu(e: MouseEvent, line: DiffLine, lineNumbers: (number | null)[]): void {
    if (!onlinecontext) return
    e.preventDefault()

    // Detect native text selection spanning multiple diff lines
    const selection = window.getSelection()
    const fileEl = (e.currentTarget as HTMLElement).closest('.diff-file')
    let lines: { lineNum: number | null, content: string }[] = []

    if (selection && !selection.isCollapsed && fileEl) {
      const range = selection.getRangeAt(0)
      for (const el of fileEl.querySelectorAll('.diff-line:not(.conflict-marker-line)')) {
        if (range.intersectsNode(el)) {
          lines.push(extractLineFromDom(el))
        }
      }
    }

    // Fallback: single right-clicked line. Unified = [old, new]; split = [num].
    // new-side is what exists in the file — remove lines (new=null) skip ref.
    if (lines.length === 0) {
      const lineNum = lineNumbers[lineNumbers.length - 1] ?? null
      lines = [{ lineNum, content: line.content.replace(/^[-+ ]/, '') }]
    }

    onlinecontext(e, { filePath, lines })
  }

  function handleFileHeaderContextMenu(e: MouseEvent): void {
    if (!oncontextmenu) return
    e.preventDefault()
    e.stopPropagation()

    // Require fileStats known — the conflict-only DiffFileView mount path in
    // DiffPanel passes fileStats=cf (always present), but future callers might
    // not. undefined !== 'D' is true, which would enable open on deleted files.
    const canOpen = !!(onopenfile && fileStats && fileStats.type !== 'D')
    const items: ContextMenuItem[] = [
      { label: 'Copy path', action: () => navigator.clipboard.writeText(filePath) },
      canOpen
        ? { label: 'Open in editor', action: () => onopenfile!(filePath) }
        : { label: onopenfile ? 'Open in editor' : 'Open in editor (not configured)', disabled: true },
      ...(onfilehistory ? [{ label: 'View history', action: () => onfilehistory(filePath) }] : []),
      ...(oncompare ? [{ label: 'Compare to…', action: () => oncompare(filePath) }] : []),
      { separator: true },
    ]
    if (!isExpanded && onexpand) {
      items.push({ label: 'Expand full context', action: () => onexpand?.(filePath, -1) })
    }
    items.push({ label: isCollapsed ? 'Expand' : 'Collapse', action: () => ontoggle(filePath) })
    if (ondiscard) {
      items.push(
        { separator: true },
        { label: 'Discard changes', danger: true, action: () => ondiscard!(filePath, file.sourcePath) },
      )
    }
    oncontextmenu(items, e.clientX, e.clientY)
  }

  function highlightSearchInText(text: string, matches: LineMatch[], currentIdx: number): string {
    const sorted = [...matches].sort((a, b) => a.startCol - b.startCol)
    let result = ''
    let pos = 0
    for (const m of sorted) {
      result += escapeHtml(text.slice(pos, m.startCol))
      const cls = m.globalIndex === currentIdx ? 'search-match search-match-current' : 'search-match'
      result += `<mark class="${cls}">${escapeHtml(text.slice(m.startCol, m.endCol))}</mark>`
      pos = m.endCol
    }
    result += escapeHtml(text.slice(pos))
    return result
  }

  // Pre-build a Map<hunkIdx, Map<lineIdx, ConflictLineMeta>> for O(1) conflict styling lookups.
  // Only computed when the file has conflicts.
  let conflictData = $derived.by(() => {
    if (!isConflict) return null
    const lineMeta = new Map<number, Map<number, ConflictLineMeta>>()
    let totalConflicts = 0
    for (let hunkIdx = 0; hunkIdx < file.hunks.length; hunkIdx++) {
      const regions = findConflicts(file.hunks[hunkIdx].lines)
      if (regions.length === 0) continue
      totalConflicts += regions.length
      const metaMap = new Map<number, ConflictLineMeta>()
      for (const region of regions) {
        metaMap.set(region.startIdx, {
          cssClass: 'conflict-boundary', isRegionStart: true, regionLabel: region.label,
        })
        metaMap.set(region.endIdx, {
          cssClass: 'conflict-boundary', isRegionEnd: true, regionLabel: region.label,
        })
        for (let sideIdx = 0; sideIdx < region.sides.length; sideIdx++) {
          const side = region.sides[sideIdx]
          const isDiff = side.type === 'diff'
          const label = side.label || (isDiff ? 'changes' : 'content')
          // Side header (%%%%%%% or +++++++). Label is what you KEEP if you
          // pick this side — for diff sides that's the "to" commit.
          metaMap.set(side.startIdx, {
            cssClass: isDiff ? 'conflict-diff-marker' : 'conflict-snap-marker',
            sideLabel: label, sideIndex: sideIdx,
          })
          const lineClass = isDiff ? 'conflict-diff-line' : 'conflict-snap-line'
          for (let i = side.startIdx + 1; i <= side.endIdx; i++) {
            const lineContent = file.hunks[hunkIdx].lines[i]?.content ?? ''
            // \\\\\\\ sub-marker lines: hide them (no sideLabel → no tab).
            // They're metadata already absorbed into the parent side's label.
            if (isDiff && /^\+\\{7,}\s/.test(lineContent)) {
              metaMap.set(i, { cssClass: 'conflict-diff-marker', sideIndex: sideIdx })
            } else {
              metaMap.set(i, { cssClass: lineClass, sideIndex: sideIdx })
            }
          }
        }
      }
      lineMeta.set(hunkIdx, metaMap)
    }
    return { lineMeta, totalConflicts }
  })
</script>

{#snippet gutter(lineNumbers: (number | null)[], rawContent: string, annLine: number | null)}
  {@const anns = annLine !== null && annotationsForLine ? annotationsForLine(filePath, annLine) : []}
  {#each lineNumbers as n}<span class="line-num">{n ?? ''}</span>{/each}{#if anns.length > 0 && annLine !== null}<!--
  --><button
        class="annotation-badge severity-{anns[0].severity}"
        class:orphaned={anns[0].status === 'orphaned'}
        onclick={(e) => { e.stopPropagation(); onannotationclick?.(annLine, rawContent, e) }}
        title="{anns.length} annotation{anns.length > 1 ? 's' : ''}: {anns[0].comment}"
        aria-label="View annotation"
      >💬{#if anns.length > 1}<sup>{anns.length}</sup>{/if}</button>{/if}{/snippet}

<!-- svelte-ignore a11y_no_static_element_interactions -->
<!-- annLine default infers new-side for unified ([old,new]) and split-right
     ([newRight]). Split-left must pass null — it has [oldLeft], not new-side. -->
{#snippet diffLine(line: DiffLine, hlKey: string, spans: WordSpan[] | undefined, lineNumbers: (number | null)[], hunkIdx?: number, lineIdx?: number, conflictMeta?: ConflictLineMeta, annLine: number | null = lineNumbers[lineNumbers.length - 1])}
  {@const searchKey = hunkIdx !== undefined && lineIdx !== undefined ? `${hunkIdx}:${lineIdx}` : ''}
  {@const lm = searchKey ? lineMatchMap.get(searchKey) : undefined}
  {@const inConflict = !!conflictMeta}
  {@const isMarker = inConflict && (conflictMeta.cssClass === 'conflict-boundary' || conflictMeta.cssClass.endsWith('-marker'))}
  {@const innerType = conflictInnerType(conflictMeta, line.content)}
  {@const rawContent = line.content.slice(1)}
  <!-- displayContent reuses rawContent in the common (non-conflict) path
       instead of re-slicing. Conflict-diff lines need one more char off. -->
  {@const displayContent = isMarker ? '' : innerType ? rawContent.slice(1) : rawContent}
  {@const displayPrefix = getDisplayPrefix(isMarker, innerType, inConflict, line.content)}
  <!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions --
    Alt+click is a mouse-only quick-add gesture by design (handleAltClick no-ops
    unless e.altKey). Keyboard users get the annotation bubble; this is the
    fast-path for mouse users. -->
  {#if isMarker}
    <div class="diff-line conflict-marker-line">{#each lineNumbers as n}<span class="line-num"></span>{/each}</div>
  {:else if lm && lm.length > 0}
    {@const hasCurrent = lm.some(m => m.globalIndex === currentMatchIdx)}
    <div
      class="diff-line"
      class:diff-add={!inConflict && line.type === 'add'}
      class:diff-remove={!inConflict && line.type === 'remove'}
      class:diff-context={!inConflict && line.type === 'context'}
      class:conflict-inner-add={innerType === 'add'}
      class:conflict-inner-remove={innerType === 'remove'}
      data-search-match-current={hasCurrent ? 'true' : undefined}
      onclick={(e) => handleAltClick(e, annLine, rawContent)}
      oncontextmenu={(e) => handleLineContextMenu(e, line, lineNumbers)}
    >{@render gutter(lineNumbers, rawContent, annLine)}<span class="diff-prefix">{displayPrefix}</span>{@html highlightSearchInText(displayContent, lm, currentMatchIdx)}</div>
  {:else if highlightedLines.has(hlKey)}
    <div
      class="diff-line highlighted"
      class:diff-add={!inConflict && line.type === 'add'}
      class:diff-remove={!inConflict && line.type === 'remove'}
      class:diff-context={!inConflict && line.type === 'context'}
      class:conflict-inner-add={innerType === 'add'}
      class:conflict-inner-remove={innerType === 'remove'}
      onclick={(e) => handleAltClick(e, annLine, rawContent)}
      oncontextmenu={(e) => handleLineContextMenu(e, line, lineNumbers)}
    >{@render gutter(lineNumbers, rawContent, annLine)}{@html highlightedLines.get(hlKey)}</div>
  {:else if spans}
    <div
      class="diff-line"
      class:diff-add={!inConflict && line.type === 'add'}
      class:diff-remove={!inConflict && line.type === 'remove'}
      class:conflict-inner-add={innerType === 'add'}
      class:conflict-inner-remove={innerType === 'remove'}
      onclick={(e) => handleAltClick(e, annLine, rawContent)}
      oncontextmenu={(e) => handleLineContextMenu(e, line, lineNumbers)}
    >{@render gutter(lineNumbers, rawContent, annLine)}<span class="diff-prefix">{displayPrefix}</span>{#each spans as span}{#if span.changed}<span
          class="word-change"
        >{span.text}</span>{:else}{span.text}{/if}{/each}</div>
  {:else}
    <div
      class="diff-line"
      class:diff-add={!inConflict && line.type === 'add'}
      class:diff-remove={!inConflict && line.type === 'remove'}
      class:diff-context={!inConflict && line.type === 'context'}
      class:conflict-inner-add={innerType === 'add'}
      class:conflict-inner-remove={innerType === 'remove'}
      onclick={(e) => handleAltClick(e, annLine, rawContent)}
      oncontextmenu={(e) => handleLineContextMenu(e, line, lineNumbers)}
    >{@render gutter(lineNumbers, rawContent, annLine)}<span class="diff-prefix">{displayPrefix}</span>{displayContent}</div>
  {/if}
{/snippet}

<div class="diff-file" data-file-path={filePath} bind:this={fileEl} class:hunk-reviewing={!!hunkReview}>
  <div
    class="diff-file-header"
    onclick={() => ontoggle(filePath)}
    oncontextmenu={handleFileHeaderContextMenu}
    role="button"
    tabindex="0"
    aria-expanded={!isCollapsed}
    aria-label="{isCollapsed ? 'Expand' : 'Collapse'} {filePath}"
    onkeydown={(e: KeyboardEvent) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); ontoggle(filePath) }}}
  >
    {#if reviewFileState}
      <!-- Tri-state glyph replaces collapse chevron in review mode. Click
           toggles all↔none (some→all); stopPropagation keeps the file from
           collapsing (default header click). -->
      <button
        class="review-file-glyph"
        class:rfg-all={reviewFileState === 'all'}
        class:rfg-none={reviewFileState === 'none'}
        onclick={(e: MouseEvent) => { e.stopPropagation(); hunkReview?.toggleFile(filePath) }}
        title="{reviewFileState === 'all' ? 'All accepted' : reviewFileState === 'none' ? 'All rejected' : 'Partially accepted'} — click to toggle all"
        aria-label="Toggle all hunks in {filePath}"
      >{REVIEW_GLYPH[reviewFileState]}</button>
    {:else}
      <span class="collapse-icon" class:is-collapsed={isCollapsed} aria-hidden="true"><svg width="8" height="8" viewBox="0 0 8 8" fill="currentColor"><path d="M2 1L6 4L2 7z"/></svg></span>
    {/if}
    {#if fileStats}
      <span class="file-type-badge" class:badge-A={fileStats.type === 'A'} class:badge-M={fileStats.type === 'M'} class:badge-D={fileStats.type === 'D'} class:badge-R={fileStats.type === 'R'} title={FILE_TYPE_LABELS[fileStats.type] ?? fileStats.type}>{fileStats.type}</span>
    {/if}
    <span class="diff-file-path">
      {#if filePath.includes('/')}
        <span class="file-dir">{filePath.slice(0, filePath.lastIndexOf('/') + 1)}</span><span class="file-name">{filePath.slice(filePath.lastIndexOf('/') + 1)}</span>
      {:else}
        <span class="file-name">{filePath}</span>
      {/if}
    </span>
    {#if fileStats && (fileStats.additions > 0 || fileStats.deletions > 0)}
      <span class="file-stats">
        {#if fileStats.additions > 0}<span class="stat-add">+{fileStats.additions}</span>{/if}
        {#if fileStats.deletions > 0}<span class="stat-del">-{fileStats.deletions}</span>{/if}
      </span>
    {/if}
    {#if onpreview && (isMarkdown || isExcalidraw) && !editing && fileStats?.type !== 'D'}
      <button class="btn btn-sm" onclick={(e: MouseEvent) => { e.stopPropagation(); onpreview(filePath) }} title={isExcalidraw ? 'Render diagram' : 'Render markdown (mermaid diagrams supported)'}>{previewContent !== undefined ? 'Source' : 'Preview'}</button>
    {/if}
    {#if onfilehistory && !editing}
      <button class="btn btn-sm" onclick={(e: MouseEvent) => { e.stopPropagation(); onfilehistory(filePath) }} title="View file history (Kaleidoscope-style two-cursor compare)">History</button>
    {/if}
    {#if onedit && !editing && fileStats?.type !== 'D'}
      <button class="btn btn-sm" disabled={editBusy} onclick={(e: MouseEvent) => { e.stopPropagation(); onedit(filePath) }} title="Edit this file (switches to split view)">{editBusy ? 'Loading…' : 'Edit'}</button>
    {/if}
    {#if ondiscard && !editing}
      <!-- A→delete-file, D→undelete, M→revert, R→undo-rename (pass both paths).
           Rename-with-edits never hits the R path: jj decomposes it to A+D. -->
      <button class="btn btn-sm btn-danger" disabled={editBusy} onclick={(e: MouseEvent) => { e.stopPropagation(); ondiscard(filePath, file.sourcePath) }} title="Discard changes to this file from this revision (jj restore)">Discard</button>
    {/if}
    {#if editing && onsavefile && oncanceledit}
      <button class="btn btn-sm btn-primary" disabled={editBusy || !editorRef} onclick={(e: MouseEvent) => { e.stopPropagation(); if (editorRef) onsavefile(filePath, editorRef.getContent()) }} title="Save changes (Ctrl+S)">{editBusy ? 'Saving…' : 'Save'}</button>
      <button class="btn btn-sm" disabled={editBusy} onclick={(e: MouseEvent) => { e.stopPropagation(); oncanceledit(filePath) }} title="Cancel editing (Esc)">Cancel</button>
    {/if}
    {#if isConflict}
      <!-- Gate on fileStats.conflict (backend truth), not findConflicts:
           markers unchanged from parent appear as context lines → found=0
           → indicator/button would hide despite the file still conflicting. -->
      <span class="conflict-indicator">
        <span class="conflict-glyph" aria-hidden="true">⚡</span>
        {#if conflictData && conflictData.totalConflicts > 0}{conflictData.totalConflicts} conflict{conflictData.totalConflicts !== 1 ? 's' : ''}{:else}conflicted{/if}
      </span>
      {#if onmerge}
        <!-- 3-pane merge editor. N-way conflicts: reconstructSides returns null
             → falls back to raw FileEditor (still the correct entry point). -->
        <button class="resolve-btn"
          onclick={(e: MouseEvent) => { e.stopPropagation(); onmerge(filePath) }}
          title="3-pane merge editor — edit the resolution manually"
        >⧉ Merge</button>
      {/if}
    {/if}
  </div>
  {#if !isCollapsed}
    {#if previewContent !== undefined}
      {#if isExcalidraw}
        {#await import('./ExcalidrawPreview.svelte') then { default: ExcalidrawPreview }}
          <ExcalidrawPreview content={previewContent} />
        {/await}
      {:else}
        {#await import('./MarkdownPreview.svelte') then { default: MarkdownPreview }}
          <MarkdownPreview
            content={previewContent}
            ctx={previewRevision
              ? { revision: previewRevision, baseDir: filePath.split('/').slice(0, -1).join('/') }
              : undefined}
            {filePath}
            {annotationsForLine}
            {onannotationclick}
            {addedLines}
          />
        {/await}
      {/if}
    {:else if effectiveSplit}
      <!-- Split (side-by-side) view -->
      {#if !isExpanded && hasHiddenContext}
        <button class="expand-btn" onclick={() => onexpand?.(filePath, -1)} aria-label="Show full context for {filePath}">
          <span class="expand-dots" aria-hidden="true">···</span>
          <span class="expand-label">full context</span>
        </button>
      {/if}
      <div class="split-view" class:split-editing={editing}>
        <div class="split-col split-left">
          {#each splitLines as sl, si}
            {#if sl.left?.line.type === 'header'}
              {#if !isExpanded}<div class="diff-hunk-header">{sl.left.line.content}</div>{/if}
            {:else if sl.left}
              {@const slKey = `${filePath}:${sl.left.hunkIdx}:${sl.left.lineIdx}`}
              {@const spans = wordDiffs.get(String(sl.left.hunkIdx))?.get(sl.left.lineIdx)}
              {@const slCm = conflictData?.lineMeta.get(sl.left.hunkIdx)?.get(sl.left.lineIdx)}
              <!-- 8th arg null: split-left has OLD line numbers; annotation
                   store is NEW-indexed. Right column + unified use the default. -->
              {@render diffLine(sl.left.line, slKey, spans, [splitNums[si].oldLeft], sl.left.hunkIdx, sl.left.lineIdx, slCm, null)}
            {:else}
              <div class="diff-line diff-empty">&nbsp;</div>
            {/if}
          {/each}
        </div>
        {#if editing && editContent !== undefined}
          <div class="split-col split-right split-editor">
            {#await import('./FileEditor.svelte') then { default: FileEditor }}
              <FileEditor
                bind:this={editorRef}
                content={editContent}
                {filePath}
                {changedRanges}
                onsave={(c) => onsavefile?.(filePath, c)}
                oncancel={() => oncanceledit?.(filePath)}
              />
            {/await}
          </div>
        {:else}
        <div class="split-col split-right">
          {#each splitLines as sl, si}
            {#if sl.right?.line.type === 'header'}
              {#if !isExpanded}<div class="diff-hunk-header">{sl.right.line.content}</div>{/if}
            {:else if sl.right}
              {@const srKey = `${filePath}:${sl.right.hunkIdx}:${sl.right.lineIdx}`}
              {@const spans = wordDiffs.get(String(sl.right.hunkIdx))?.get(sl.right.lineIdx)}
              {@const srCm = conflictData?.lineMeta.get(sl.right.hunkIdx)?.get(sl.right.lineIdx)}
              {@render diffLine(sl.right.line, srKey, spans, [splitNums[si].newRight], sl.right.hunkIdx, sl.right.lineIdx, srCm)}
            {:else}
              <div class="diff-line diff-empty">&nbsp;</div>
            {/if}
          {/each}
        </div>
        {/if}
      </div>
    {:else}
      <!-- Unified view -->
      {#each file.hunks as hunk, hunkIdx}
        {@const hunkWordDiffs = wordDiffs.get(String(hunkIdx)) ?? new Map()}
        {@const hunkAccepted = hunkReview ? hunkReview.selected.has(hunkKey(filePath, hunkIdx)) : true}
        {@const hunkIsCursor = hunkReview?.cursor?.path === filePath && hunkReview.cursor.idx === hunkIdx}
        {#if !isExpanded}
          {#if hunkIdx === 0 && hunk.newStart > 1}
            <button class="expand-btn" onclick={() => onexpand?.(filePath, origGap(0))} aria-label="Show {hunk.newStart - 1} hidden lines above">
              <span class="expand-dots" aria-hidden="true">···</span>
              <span class="expand-label">{hunk.newStart - 1} lines</span>
            </button>
          {/if}
          {#if hunkIdx > 0}
            {@const prev = file.hunks[hunkIdx - 1]}
            {@const gap = hunk.newStart - (prev.newStart + prev.newCount)}
            {#if gap > 0}
              <button class="expand-btn" onclick={() => onexpand?.(filePath, origGap(hunkIdx))} aria-label="Show {gap} hidden lines">
                <span class="expand-dots" aria-hidden="true">···</span>
                <span class="expand-label">{gap} lines</span>
              </button>
            {/if}
          {/if}
          {@const parsed = parsedHunkHeaders[hunkIdx]}
          <div
            class="diff-hunk-header"
            class:hunk-cursor={hunkIsCursor}
            data-hunk={hunkIdx}
          >
            {#if hunkReview}
              <button
                class="hunk-check"
                class:hunk-check-on={hunkAccepted}
                onclick={() => hunkReview?.toggle(filePath, hunkIdx)}
                aria-pressed={hunkAccepted}
                aria-label="{hunkAccepted ? 'Accepted' : 'Rejected'} — hunk {hunkIdx + 1}"
              >{hunkAccepted ? '✓' : ' '}</button>
            {/if}
            <span class="hunk-range">{parsed.range}</span>
            {#if parsed.context}<span class="hunk-context">{parsed.context}</span>{/if}
            {#if hunkReview && !hunkAccepted}
              <span class="hunk-rejected-label">rejected</span>
            {/if}
          </div>
        {/if}
        {@const lineNums = lineNumsByHunk[hunkIdx]}
        <div class="diff-lines" class:hunk-dim={hunkReview && !hunkAccepted}>
          {#each hunk.lines as line, lineIdx}
            {@const hlKey = `${filePath}:${hunkIdx}:${lineIdx}`}
            {@const spans = hunkWordDiffs.get(lineIdx)}
            {@const cm = conflictData?.lineMeta.get(hunkIdx)?.get(lineIdx)}
            {@const ln = lineNums[lineIdx]}
            {#if cm}
              <div
                class="conflict-line {cm.cssClass}"
                class:conflict-region-start={cm.isRegionStart}
                class:conflict-region-end={cm.isRegionEnd}
              >
                {#if cm.isRegionStart}
                  <div class="conflict-region-header">
                    <span class="conflict-region-title">
                      <span class="conflict-glyph" aria-hidden="true">⚡</span>
                      {cm.regionLabel || 'Conflict'}
                    </span>
                  </div>
                {:else if cm.sideLabel && cm.sideIndex !== undefined}
                  <!-- Side header: letter badge + commit description.
                       The letter badge matches the button above. -->
                  <span class="conflict-side-tab" title={cm.sideLabel}>
                    <span class="side-badge">{sideLetter(cm.sideIndex)}</span>
                    {truncate(cm.sideLabel)}
                  </span>
                {/if}
                {@render diffLine(line, hlKey, spans, [ln.old, ln.new], hunkIdx, lineIdx, cm)}
              </div>
            {:else}
              {@render diffLine(line, hlKey, spans, [ln.old, ln.new], hunkIdx, lineIdx)}
            {/if}
          {/each}
        </div>
      {/each}
      {#if !isExpanded && file.hunks.length > 0}
        <!-- Trailing expand — unconditional (gated only on !isExpanded).
             Diff headers don't carry total file line count, so we can't
             prove trailing context exists. A hunk at the top of a file
             (newStart=1) has hidden trailing lines but hasHiddenContext
             misses it. Showing the button when there IS no trailing context
             is harmless — expanded view just shows the same hunk. -->
        <button class="expand-btn" onclick={() => onexpand?.(filePath, origGap(file.hunks.length))} aria-label="Show full file context">
          <span class="expand-dots" aria-hidden="true">···</span>
          <span class="expand-label">rest of file</span>
        </button>
      {/if}
    {/if}
  {/if}
</div>

<style>
  .diff-file {
    border-bottom: 1px solid var(--surface0);
    content-visibility: auto;
    contain-intrinsic-size: auto 200px;
  }

  .diff-file:last-child {
    border-bottom: none;
  }

  .diff-file-header {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 7px 12px;
    background: var(--mantle);
    color: var(--text);
    font-weight: 600;
    font-size: 12px;
    border-bottom: 1px solid var(--surface0);
    position: sticky;
    top: 0;
    z-index: 1;
    cursor: pointer;
    user-select: none;
    transition: background var(--anim-duration) var(--anim-ease);
  }

  .diff-file-header:hover {
    background: var(--bg-diff-header-hover);
  }

  .collapse-icon {
    color: var(--surface2);
    width: 12px;
    flex-shrink: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    transition: transform var(--anim-duration) var(--anim-ease);
    transform: rotate(90deg);
  }

  .collapse-icon.is-collapsed {
    transform: rotate(0deg);
  }

  /* ── Hunk review UI ─────────────────────────────────────────────────── */

  .review-file-glyph {
    width: 14px;
    height: 14px;
    padding: 0;
    border: none;
    background: none;
    font-family: inherit;
    font-size: 11px;
    line-height: 1;
    cursor: pointer;
    color: var(--amber);
    flex-shrink: 0;
    transition: transform var(--anim-duration) var(--anim-ease);
  }
  .review-file-glyph:hover { transform: scale(1.2); }
  .review-file-glyph.rfg-none { color: var(--overlay0); }
  /* ◐ (some) uses default amber — "work in progress" signal */

  .hunk-check {
    width: 16px;
    height: 16px;
    padding: 0;
    margin-right: 6px;
    border: 1px solid var(--surface1);
    border-radius: 3px;
    background: var(--mantle);
    font-family: inherit;
    font-size: 10px;
    font-weight: 700;
    line-height: 1;
    cursor: pointer;
    color: transparent;
    flex-shrink: 0;
    transition: background var(--anim-duration) var(--anim-ease),
                border-color var(--anim-duration) var(--anim-ease),
                color var(--anim-duration) var(--anim-ease);
  }
  .hunk-check:hover { border-color: var(--surface2); }
  .hunk-check.hunk-check-on {
    background: var(--amber);
    border-color: var(--amber);
    color: var(--base);
  }

  .diff-hunk-header.hunk-cursor {
    /* Amber ring — mirrors RevisionGraph's selected-row left-border. sticky
       header + scroll-margin-top keeps the cursor visible below the file
       header when scrollIntoView fires. */
    box-shadow: inset 2px 0 0 var(--amber), inset 0 0 0 1px var(--amber);
    background: var(--bg-selected);
    scroll-margin-top: 36px;
  }

  .hunk-rejected-label {
    margin-left: auto;
    padding: 1px 6px;
    font-size: 9px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.5px;
    color: var(--overlay0);
    border: 1px solid var(--surface0);
    border-radius: 3px;
  }

  /* The dimming IS the preview: 0.4 opacity = "this moves to the child
     commit". Desaturate avoids rejected-green-add reading as accepted.
     Transition is the one micro-interaction that sells the accept/reject —
     Space feels like a physical gate closing. */
  .diff-lines.hunk-dim {
    opacity: 0.4;
    filter: grayscale(0.5);
    transition: opacity var(--anim-duration) var(--anim-ease),
                filter var(--anim-duration) var(--anim-ease);
  }

  /* In review mode, expand buttons are gated off (onexpand=undefined) —
     hide the leftover ··· button shells. Context expansion would merge
     adjacent hunks and invalidate selectedHunks keys. */
  .hunk-reviewing .expand-btn { display: none; }

  .file-type-badge {
    font-size: 10px;
    font-weight: 700;
    padding: 0 4px;
    border-radius: 3px;
    flex-shrink: 0;
  }

  .badge-A {
    background: var(--badge-add-bg);
    color: var(--green);
  }

  .badge-M {
    background: var(--badge-modify-bg);
    color: var(--amber);
  }

  .badge-D {
    background: var(--badge-delete-bg);
    color: var(--red);
  }

  .badge-R {
    background: var(--badge-other-bg);
    color: var(--amber);
  }

  .diff-file-path {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .file-dir {
    color: var(--surface2);
    font-weight: 400;
  }

  .file-name {
    color: var(--text);
    font-weight: 700;
  }

  .file-stats {
    display: flex;
    gap: 6px;
    flex-shrink: 0;
    font-size: 11px;
    font-weight: 600;
  }

  .stat-add {
    color: var(--green);
  }

  .stat-del {
    color: var(--red);
  }

  .expand-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 6px;
    width: 100%;
    padding: 2px 12px;
    background: transparent;
    color: var(--surface2);
    border: none;
    border-top: 1px dashed var(--border-hunk-header);
    border-bottom: 1px dashed var(--border-hunk-header);
    font-family: inherit;
    font-size: 11px;
    cursor: pointer;
    text-align: center;
    transition: background var(--anim-duration) var(--anim-ease),
                color var(--anim-duration) var(--anim-ease);
  }

  .expand-dots {
    letter-spacing: 2px;
    color: var(--surface2);
    font-size: 10px;
  }

  .expand-label {
    font-size: 10px;
  }

  .expand-btn:hover {
    background: var(--bg-hunk-header);
    color: var(--subtext0);
  }

  .expand-btn:hover .expand-dots {
    color: var(--amber);
  }

  .diff-hunk-header {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 3px 12px;
    background: var(--bg-hunk-header);
    color: var(--overlay0);
    font-size: 11px;
    border-bottom: 1px solid var(--border-hunk-header);
    font-family: var(--font-mono);
  }

  .hunk-range {
    color: var(--surface2);
    font-size: 10px;
    flex-shrink: 0;
  }

  .hunk-context {
    color: var(--subtext0);
    font-style: italic;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .diff-lines {
    font-family: var(--font-mono);
    font-size: 12px;
    line-height: 1.5;
  }

  .diff-line {
    /* Hanging indent keeps soft-wrapped lines clear of the line-number gutter:
       padding-left pushes ALL lines right, negative text-indent pulls only the
       FIRST line back — so .line-num spans sit in the padding zone and wraps
       start at the content column. --diff-gutter-w approximates
       2×line-num (unified) + 1ch prefix; split-col overrides to 1×line-num. */
    --diff-gutter-w: 11ch;
    padding: 0 12px 0 var(--diff-gutter-w);
    text-indent: calc(-1 * var(--diff-gutter-w));
    white-space: pre-wrap;
    word-break: break-all;
    border-left: 3px solid transparent;
    /* Match CodeMirror's default tabSize so side-by-side split view aligns */
    tab-size: 4;
  }
  /* text-indent is inherited — reset for inline-blocks or their own content
     would be negatively indented. */
  .diff-line > :global(*) { text-indent: 0; }

  .line-num {
    display: inline-block;
    min-width: 4ch;
    text-align: right;
    padding-right: 1ch;
    color: var(--surface2);
    user-select: none;
    -webkit-user-select: none;
    font-size: 11px;
    opacity: 0.5;
    border-right: 1px solid var(--line-gutter-border, transparent);
    margin-right: 1ch;
  }

  /* Show gutter border only on context lines for subtle structure */
  .diff-context .line-num {
    --line-gutter-border: var(--surface0);
  }

  /* Annotation gutter badge — positioning + size only; shared semantic
     rules (.severity-*, .orphaned, hover) in theme.css. The diff-line's
     right padding (12px) reserves space so the badge doesn't push content. */
  .diff-line { position: relative; }
  :global(.diff-line .annotation-badge) {
    right: 2px;
    font-size: 11px;
    padding: 1px 2px;
    transition: opacity var(--anim-duration) var(--anim-ease);
  }
  :global(.diff-line .annotation-badge sup) { font-size: 8px; }

  .diff-add {
    background: var(--diff-add-bg);
    color: var(--green);
    border-left-color: var(--green);
  }

  .diff-remove {
    background: var(--diff-remove-bg);
    color: var(--red);
    border-left-color: var(--red);
  }

  .diff-context {
    color: var(--subtext0);
  }

  .diff-line.highlighted {
    color: var(--text);
  }

  .diff-line.highlighted.diff-context {
    opacity: 0.7;
  }

  .word-change {
    border-radius: 2px;
  }
  .diff-add .word-change {
    background: var(--diff-add-word);
  }
  .diff-remove .word-change {
    background: var(--diff-remove-word);
  }

  :global(.search-match) {
    background: var(--search-match-bg);
    border-radius: 2px;
  }

  :global(.search-match-current) {
    background: var(--search-match-current-bg);
    outline: 1px solid var(--amber);
  }

  :global(.diff-prefix) {
    user-select: none;
    opacity: 0.5;
  }

  /* --- Split view --- */
  .split-view {
    display: flex;
  }

  .split-col {
    flex: 1;
    min-width: 0;
    overflow-x: auto;
    font-family: var(--font-mono);
    font-size: 12px;
    line-height: 1.5;
  }
  .split-col .diff-line { --diff-gutter-w: 6ch; }

  .split-left {
    border-right: 1px solid var(--surface0);
  }

  .diff-empty {
    background: var(--bg-diff-empty);
    border-left: 3px solid transparent;
  }

  /* ═══════════════════════════════════════════════════════════════════════
     CONFLICT RESOLUTION UI
     Design: industrial/utilitarian. Conflicts are decision-points — the UI
     presents them as such. Buttons at region TOP (see choices before content).
     Side headers are tab-like anchors, not floating italic labels.
     Hover preview: kept side glows amber, discarded side gets redacted-stripe.
     ═══════════════════════════════════════════════════════════════════════ */

  /* File-header conflict indicator */
  .conflict-indicator {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    color: var(--red);
    font-size: 10px;
    font-weight: 700;
    letter-spacing: 0.02em;
    flex-shrink: 0;
  }

  .conflict-glyph {
    font-size: 11px;
    filter: drop-shadow(0 0 2px color-mix(in srgb, var(--red) 40%, transparent));
  }

  /* Merge button — opens 3-pane editor. Compact pill matching file-header style. */
  .resolve-btn {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    background: var(--surface0);
    border: 1px solid var(--surface1);
    color: var(--subtext0);
    padding: 3px 8px;
    border-radius: 4px;
    cursor: pointer;
    font-family: inherit;
    font-size: 10px;
    font-weight: 600;
    flex-shrink: 0;
    white-space: nowrap;
    transition: all 0.12s var(--anim-ease);
  }
  .resolve-btn:hover {
    background: var(--bg-selected);
    border-color: var(--amber);
    color: var(--text);
    transform: translateY(-1px);
  }

  /* Letter badge: still used by per-side tabs in the conflict region display. */
  .side-badge {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-width: 16px;
    height: 16px;
    padding: 0 4px;
    border-radius: 3px;
    font-size: 10px;
    font-weight: 800;
    font-family: var(--font-mono);
    letter-spacing: 0.02em;
    background: var(--surface1);
    color: var(--subtext1);
  }

  /* ─── Conflict region frame ─────────────────────────────────────────── */

  .conflict-line {
    position: relative;
    border-left: 2px solid var(--conflict-boundary-border);
    border-right: 1px solid var(--conflict-boundary-border);
    margin-left: 6px;
    margin-right: 6px;
  }

  .conflict-region-start {
    border-top: 2px solid var(--conflict-boundary-border);
    border-top-left-radius: 4px;
    border-top-right-radius: 4px;
    margin-top: 10px;
  }

  .conflict-region-end {
    border-bottom: 2px solid var(--conflict-boundary-border);
    border-bottom-left-radius: 4px;
    border-bottom-right-radius: 4px;
    margin-bottom: 10px;
  }

  /* Region header bar: sits above the first content, replaces the <<<<<<< line */
  .conflict-region-header {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 5px 10px;
    background: linear-gradient(
      90deg,
      var(--conflict-boundary-bg) 0%,
      transparent 60%
    );
    border-bottom: 1px solid var(--conflict-boundary-border);
    user-select: none;
  }

  .conflict-region-title {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    font-size: 10px;
    font-weight: 700;
    color: var(--red);
    text-transform: lowercase;
    letter-spacing: 0.02em;
    font-variant: small-caps;
  }

  /* Side tabs: letter badge + description. The badge is the primary identifier —
     matches the button above. Description is secondary context (commit message). */
  .conflict-side-tab {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 3px 10px 3px 4px;
    margin: 2px 0 2px -2px; /* align with region border, small breathing room */
    font-size: 10px;
    font-weight: 500;
    color: var(--subtext0);
    background: var(--mantle);
    border-left: 3px solid var(--conflict-side-color, var(--surface1));
    border-radius: 0 3px 3px 0;
    position: relative;
    z-index: 1;
    max-width: 100%;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  /* Tab badge adopts the side color — visual link to the content rail below */
  .conflict-side-tab .side-badge {
    background: var(--conflict-side-color, var(--surface1));
    color: var(--base);
    flex-shrink: 0;
  }

  /* Content lines: strong left rail in side color */
  .conflict-line :global(.diff-line) {
    border-left: 4px solid var(--conflict-side-color, transparent);
    padding-left: 12px;
  }

  /* Marker line content (the actual jj markers) — collapsed to zero height.
     The visible headers above are the .conflict-region-header / .conflict-side-tab. */
  .conflict-marker-line {
    height: 0;
    font-size: 0;
    overflow: hidden;
  }

  /* Side 1: diff section (full red intensity per DESIGN_LANGUAGE.md) */
  .conflict-diff-marker,
  .conflict-diff-line {
    --conflict-side-color: var(--conflict-side1-border);
  }

  .conflict-diff-line :global(.diff-line) {
    background: var(--conflict-side1-bg);
  }

  /* Inner diff (+/- within %%%%%%% section): preserve semantic red/green */
  .conflict-diff-line :global(.conflict-inner-remove) {
    background: var(--diff-remove-bg);
    border-left-color: var(--red);
  }
  .conflict-diff-line :global(.conflict-inner-add) {
    background: var(--diff-add-bg);
    border-left-color: var(--green);
  }

  /* Side 2: snapshot section. Snapshot content is RAW (no +/- prefix) — it's
     "what this side has", semantically equivalent to the + lines in side 1's
     diff section. Without a visible tint it looks like context, not a side's
     contribution. Match the inner-add green so both sides' content reads as
     "this is what you get if you pick this side". */
  .conflict-snap-marker,
  .conflict-snap-line {
    --conflict-side-color: var(--conflict-side2-border);
  }

  .conflict-snap-line :global(.diff-line) {
    background: var(--diff-add-bg);
    border-left-color: var(--green);
  }

  /* --- Edit mode --- */
  .split-editing {
    min-height: 300px;
  }
  .split-editor {
    display: flex;
    flex-direction: column;
  }
</style>
