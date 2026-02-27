<script lang="ts">
  import type { DiffFile, DiffHunk, DiffLine } from './diff-parser'
  import { toSplitView, type SplitLine } from './split-view'
  import type { WordSpan } from './word-diff'
  import type { FileChange } from './api'
  import { findConflicts, extractSideLabel, type ConflictRegion } from './conflict-parser'
  import type { SearchMatch } from './DiffPanel.svelte'

  interface Props {
    file: DiffFile
    fileStats: FileChange | undefined
    isCollapsed: boolean
    isExpanded: boolean
    splitView: boolean
    highlightedLines: Map<string, string>
    wordDiffs: Map<string, Map<number, WordSpan[]>>
    ontoggle: (path: string) => void
    onexpand: (path: string) => void
    onresolve?: (file: string, tool: ':ours' | ':theirs') => void
    searchMatches?: { item: SearchMatch; index: number }[]
    currentMatchIdx?: number
  }

  let { file, fileStats, isCollapsed, isExpanded, splitView, highlightedLines, wordDiffs, ontoggle, onexpand, onresolve, searchMatches = [], currentMatchIdx = 0 }: Props = $props()

  let filePath = $derived(file.filePath)
  let isConflict = $derived(fileStats?.conflict ?? false)
  // Conflict arity from `jj resolve --list` — authoritative. 2 = resolvable with
  // :ours/:theirs. 0 = unknown (fall back to marker counting). 3+ = N-way merge,
  // resolve tools are ambiguous so buttons are hidden.
  let conflictSides = $derived(fileStats?.conflict_sides ?? 0)
  let hoveredResolve: { regionIdx: number; side: number } | null = $state(null)

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
    sideLabel?: string
    sideIndex?: number       // 0-based side index within the conflict region
    regionIdx?: number       // which conflict region (0-based) this line belongs to
    sideCount?: number       // number of sides in this conflict region
    sideLabels?: string[]    // labels for each side (for resolve buttons)
    regionLabel?: string     // e.g. "Conflict 1 of 3"
  }

  interface LineMatch { startCol: number; endCol: number; isCurrent: boolean }

  // Pre-build per-line search match lookup for O(1) access in the render loop.
  // searchMatches is already filtered to this file by the parent; each entry
  // carries its global index so we can check "is this the current match?"
  let lineMatchMap = $derived.by(() => {
    if (searchMatches.length === 0) return new Map<string, LineMatch[]>()
    const map = new Map<string, LineMatch[]>()
    for (const { item: m, index } of searchMatches) {
      const key = `${m.hunkIdx}:${m.lineIdx}`
      const list = map.get(key) ?? []
      list.push({ startCol: m.startCol, endCol: m.endCol, isCurrent: index === currentMatchIdx })
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

  // Extract display content — strips prefix character(s) from line content
  function getDisplayContent(isMarker: boolean, innerType: string | null, content: string): string {
    if (isMarker) return ''
    if (innerType) return content.slice(2) // strip outer `+` and inner `-`/`+`
    // All lines: strip the first character (diff format prefix +/-/space)
    return content.slice(1)
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

  function escapeHtml(text: string): string {
    return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  }

  function highlightSearchInText(text: string, matches: LineMatch[]): string {
    const sorted = [...matches].sort((a, b) => a.startCol - b.startCol)
    let result = ''
    let pos = 0
    for (const m of sorted) {
      result += escapeHtml(text.slice(pos, m.startCol))
      const cls = m.isCurrent ? 'search-match search-match-current' : 'search-match'
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
    const allRegionEnds: ConflictLineMeta[] = []
    let totalConflicts = 0
    for (let hunkIdx = 0; hunkIdx < file.hunks.length; hunkIdx++) {
      const regions = findConflicts(file.hunks[hunkIdx].lines)
      if (regions.length === 0) continue
      totalConflicts += regions.length
      const metaMap = new Map<number, ConflictLineMeta>()
      for (let regionIdx = 0; regionIdx < regions.length; regionIdx++) {
        const region = regions[regionIdx]
        const sideLabels = region.sides.map(s => s.label || (s.type === 'diff' ? 'changes' : 'content'))
        metaMap.set(region.startIdx, { cssClass: 'conflict-boundary', isRegionStart: true, regionLabel: region.label, regionIdx })
        const endMeta: ConflictLineMeta = {
          cssClass: 'conflict-boundary', isRegionEnd: true,
          sideCount: region.sides.length, sideLabels, regionLabel: region.label, regionIdx,
        }
        metaMap.set(region.endIdx, endMeta)
        allRegionEnds.push(endMeta)
        for (let sideIdx = 0; sideIdx < region.sides.length; sideIdx++) {
          const side = region.sides[sideIdx]
          const isDiff = side.type === 'diff'
          const label = side.label || (isDiff ? 'changes' : 'content')
          metaMap.set(side.startIdx, {
            cssClass: isDiff ? 'conflict-diff-marker' : 'conflict-snap-marker',
            sideLabel: label, sideIndex: sideIdx, regionIdx,
          })
          const lineClass = isDiff ? 'conflict-diff-line' : 'conflict-snap-line'
          for (let i = side.startIdx + 1; i <= side.endIdx; i++) {
            const lineContent = file.hunks[hunkIdx].lines[i]?.content ?? ''
            if (isDiff && /^\+\\{7}\s/.test(lineContent)) {
              metaMap.set(i, { cssClass: 'conflict-diff-marker', sideLabel: extractSideLabel(lineContent.slice(8)), sideIndex: sideIdx, regionIdx })
            } else {
              metaMap.set(i, { cssClass: lineClass, sideIndex: sideIdx, regionIdx })
            }
          }
        }
      }
      lineMeta.set(hunkIdx, metaMap)
    }
    // Determine if :ours/:theirs resolution is applicable. Prefer the authoritative
    // arity from `jj resolve --list` (conflictSides). Fall back to marker counting
    // when arity is unknown (conflictSides === 0). jj can represent a 2-way conflict
    // with a single %%%%%%% diff section (sideCount === 1), so marker counting alone
    // would incorrectly hide the buttons for those conflicts.
    const allTwoWay = conflictSides > 0
      ? conflictSides === 2
      : allRegionEnds.length > 0 && allRegionEnds.every(m => (m.sideCount ?? 0) <= 2)
    return { lineMeta, totalConflicts, allRegionEnds, allTwoWay }
  })
</script>

{#snippet diffLine(line: DiffLine, hlKey: string, spans: WordSpan[] | undefined, lineNumbers: (number | null)[], hunkIdx?: number, lineIdx?: number, conflictMeta?: ConflictLineMeta)}
  {@const searchKey = hunkIdx !== undefined && lineIdx !== undefined ? `${hunkIdx}:${lineIdx}` : ''}
  {@const lm = searchKey ? lineMatchMap.get(searchKey) : undefined}
  {@const inConflict = !!conflictMeta}
  {@const isMarker = inConflict && (conflictMeta.cssClass === 'conflict-boundary' || conflictMeta.cssClass.endsWith('-marker'))}
  {@const innerType = conflictInnerType(conflictMeta, line.content)}
  {@const displayContent = getDisplayContent(isMarker, innerType, line.content)}
  {@const displayPrefix = getDisplayPrefix(isMarker, innerType, inConflict, line.content)}
  {#if isMarker}
    <div class="diff-line conflict-marker-line">{#each lineNumbers as n}<span class="line-num"></span>{/each}</div>
  {:else if lm && lm.length > 0}
    {@const hasCurrent = lm.some(m => m.isCurrent)}
    <div
      class="diff-line"
      class:diff-add={!inConflict && line.type === 'add'}
      class:diff-remove={!inConflict && line.type === 'remove'}
      class:diff-context={!inConflict && line.type === 'context'}
      class:conflict-inner-add={innerType === 'add'}
      class:conflict-inner-remove={innerType === 'remove'}
      data-search-match-current={hasCurrent ? 'true' : undefined}
    >{#each lineNumbers as n}<span class="line-num">{n ?? ''}</span>{/each}<span class="diff-prefix">{displayPrefix}</span>{@html highlightSearchInText(displayContent, lm)}</div>
  {:else if highlightedLines.has(hlKey)}
    <div
      class="diff-line highlighted"
      class:diff-add={!inConflict && line.type === 'add'}
      class:diff-remove={!inConflict && line.type === 'remove'}
      class:diff-context={!inConflict && line.type === 'context'}
      class:conflict-inner-add={innerType === 'add'}
      class:conflict-inner-remove={innerType === 'remove'}
    >{#each lineNumbers as n}<span class="line-num">{n ?? ''}</span>{/each}{@html highlightedLines.get(hlKey)}</div>
  {:else if spans}
    <div
      class="diff-line"
      class:diff-add={!inConflict && line.type === 'add'}
      class:diff-remove={!inConflict && line.type === 'remove'}
      class:conflict-inner-add={innerType === 'add'}
      class:conflict-inner-remove={innerType === 'remove'}
    >{#each lineNumbers as n}<span class="line-num">{n ?? ''}</span>{/each}<span class="diff-prefix">{displayPrefix}</span>{#each spans as span}{#if span.changed}<span
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
    >{#each lineNumbers as n}<span class="line-num">{n ?? ''}</span>{/each}<span class="diff-prefix">{displayPrefix}</span>{displayContent}</div>
  {/if}
{/snippet}

<div class="diff-file" data-file-path={filePath}>
  <div
    class="diff-file-header"
    onclick={() => ontoggle(filePath)}
    role="button"
    tabindex="0"
    aria-expanded={!isCollapsed}
    aria-label="{isCollapsed ? 'Expand' : 'Collapse'} {filePath}"
    onkeydown={(e: KeyboardEvent) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); ontoggle(filePath) }}}
  >
    <span class="collapse-icon" class:is-collapsed={isCollapsed} aria-hidden="true"><svg width="8" height="8" viewBox="0 0 8 8" fill="currentColor"><path d="M2 1L6 4L2 7z"/></svg></span>
    {#if fileStats}
      <span class="file-type-badge" class:badge-A={fileStats.type === 'A'} class:badge-M={fileStats.type === 'M'} class:badge-D={fileStats.type === 'D'} class:badge-R={fileStats.type === 'R'}>{fileStats.type}</span>
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
    {#if isConflict && conflictData && conflictData.totalConflicts > 0}
      <span class="conflict-indicator">{conflictData.totalConflicts} conflict{conflictData.totalConflicts !== 1 ? 's' : ''}</span>
      {#if onresolve && conflictData.allTwoWay}
        <button class="resolve-btn resolve-ours"
          onclick={(e: MouseEvent) => { e.stopPropagation(); onresolve!(filePath, ':ours') }}
          onmouseenter={() => hoveredResolve = { regionIdx: -1, side: 0 }}
          onfocus={() => hoveredResolve = { regionIdx: -1, side: 0 }}
          onmouseleave={() => hoveredResolve = null}
          onblur={() => hoveredResolve = null}
          title="Discards {conflictData.allRegionEnds[0]?.sideLabels?.[1] ?? 'side 2'}">Keep {conflictData.allRegionEnds[0]?.sideLabels?.[0] ?? 'side 1'}</button>
        <button class="resolve-btn resolve-theirs"
          onclick={(e: MouseEvent) => { e.stopPropagation(); onresolve!(filePath, ':theirs') }}
          onmouseenter={() => hoveredResolve = { regionIdx: -1, side: 1 }}
          onfocus={() => hoveredResolve = { regionIdx: -1, side: 1 }}
          onmouseleave={() => hoveredResolve = null}
          onblur={() => hoveredResolve = null}
          title="Discards {conflictData.allRegionEnds[0]?.sideLabels?.[0] ?? 'side 1'}">Keep {conflictData.allRegionEnds[0]?.sideLabels?.[1] ?? 'side 2'}</button>
      {/if}
    {/if}
  </div>
  {#if !isCollapsed}
    {#if effectiveSplit}
      <!-- Split (side-by-side) view -->
      {#if !isExpanded && file.hunks.length > 1}
        <button class="expand-btn" onclick={() => onexpand(filePath)} aria-label="Show full context for {filePath}">
          <span class="expand-dots" aria-hidden="true">···</span>
          <span class="expand-label">full context</span>
        </button>
      {/if}
      <div class="split-view">
        <div class="split-col split-left">
          {#each splitLines as sl, si}
            {#if sl.left?.line.type === 'header'}
              {#if !isExpanded}<div class="diff-hunk-header">{sl.left.line.content}</div>{/if}
            {:else if sl.left}
              {@const slKey = `${filePath}:${sl.left.hunkIdx}:${sl.left.lineIdx}`}
              {@const spans = wordDiffs.get(String(sl.left.hunkIdx))?.get(sl.left.lineIdx)}
              {@const slCm = conflictData?.lineMeta.get(sl.left.hunkIdx)?.get(sl.left.lineIdx)}
              {@render diffLine(sl.left.line, slKey, spans, [splitNums[si].oldLeft], sl.left.hunkIdx, sl.left.lineIdx, slCm)}
            {:else}
              <div class="diff-line diff-empty">&nbsp;</div>
            {/if}
          {/each}
        </div>
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
      </div>
    {:else}
      <!-- Unified view -->
      {#each file.hunks as hunk, hunkIdx}
        {@const hunkWordDiffs = wordDiffs.get(String(hunkIdx)) ?? new Map()}
        {#if !isExpanded}
          {#if hunkIdx === 0 && hunk.newStart > 1}
            <button class="expand-btn" onclick={() => onexpand(filePath)} aria-label="Show {hunk.newStart - 1} hidden lines above">
              <span class="expand-dots" aria-hidden="true">···</span>
              <span class="expand-label">{hunk.newStart - 1} lines</span>
            </button>
          {/if}
          {#if hunkIdx > 0}
            {@const prev = file.hunks[hunkIdx - 1]}
            {@const gap = hunk.newStart - (prev.newStart + prev.newCount)}
            {#if gap > 0}
              <button class="expand-btn" onclick={() => onexpand(filePath)} aria-label="Show {gap} hidden lines">
                <span class="expand-dots" aria-hidden="true">···</span>
                <span class="expand-label">{gap} lines</span>
              </button>
            {/if}
          {/if}
          {@const parsed = parsedHunkHeaders[hunkIdx]}
          <div class="diff-hunk-header">
            <span class="hunk-range">{parsed.range}</span>
            {#if parsed.context}<span class="hunk-context">{parsed.context}</span>{/if}
          </div>
        {/if}
        {@const lineNums = lineNumsByHunk[hunkIdx]}
        <div class="diff-lines">
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
                class:conflict-side-kept={hoveredResolve !== null && (hoveredResolve.regionIdx === -1 || cm.regionIdx === hoveredResolve.regionIdx) && cm.sideIndex === hoveredResolve.side}
                class:conflict-side-discarded={hoveredResolve !== null && (hoveredResolve.regionIdx === -1 || cm.regionIdx === hoveredResolve.regionIdx) && cm.sideIndex !== undefined && cm.sideIndex !== hoveredResolve.side}
              >
                {#if cm.sideLabel}
                  <span class="conflict-side-label">{cm.sideLabel}</span>
                {/if}
                {#if cm.isRegionEnd && onresolve && conflictData?.allTwoWay}
                  <div class="conflict-resolve-inline" role="group" onmouseleave={() => hoveredResolve = null}>
                    <button class="resolve-btn-inline resolve-inline-ours"
                      onclick={(e: MouseEvent) => { e.stopPropagation(); onresolve!(filePath, ':ours') }}
                      onmouseenter={() => hoveredResolve = { regionIdx: cm.regionIdx!, side: 0 }}
                      onfocus={() => hoveredResolve = { regionIdx: cm.regionIdx!, side: 0 }}
                      onblur={() => hoveredResolve = null}
                      title="Discards {cm.sideLabels?.[1] ?? 'side 2'}">Keep {cm.sideLabels?.[0] ?? 'side 1'}</button>
                    <button class="resolve-btn-inline resolve-inline-theirs"
                      onclick={(e: MouseEvent) => { e.stopPropagation(); onresolve!(filePath, ':theirs') }}
                      onmouseenter={() => hoveredResolve = { regionIdx: cm.regionIdx!, side: 1 }}
                      onfocus={() => hoveredResolve = { regionIdx: cm.regionIdx!, side: 1 }}
                      onblur={() => hoveredResolve = null}
                      title="Discards {cm.sideLabels?.[0] ?? 'side 1'}">Keep {cm.sideLabels?.[1] ?? 'side 2'}</button>
                  </div>
                {/if}
                {@render diffLine(line, hlKey, spans, [ln.old, ln.new], hunkIdx, lineIdx, cm)}
              </div>
            {:else}
              {@render diffLine(line, hlKey, spans, [ln.old, ln.new], hunkIdx, lineIdx)}
            {/if}
          {/each}
        </div>
      {/each}
    {/if}
  {/if}
</div>

<style>
  .diff-file {
    border-bottom: 1px solid var(--surface0);
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
    padding: 0 12px 0 0;
    white-space: pre-wrap;
    word-break: break-all;
    border-left: 3px solid transparent;
  }

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

  .split-left {
    border-right: 1px solid var(--surface0);
  }

  .diff-empty {
    background: var(--bg-diff-empty);
    border-left: 3px solid transparent;
  }

  /* --- Conflict indicators --- */
  .conflict-indicator {
    color: var(--red);
    font-size: 10px;
    font-weight: 700;
    flex-shrink: 0;
  }

  .resolve-btn {
    background: transparent;
    border: 1px solid var(--surface1);
    color: var(--subtext0);
    padding: 1px 6px;
    border-radius: 3px;
    cursor: pointer;
    font-family: inherit;
    font-size: 10px;
    flex-shrink: 0;
    transition: background 0.15s ease, border-color 0.15s ease, color 0.15s ease;
  }

  .resolve-btn:hover {
    color: var(--text);
  }

  .resolve-ours:hover {
    background: var(--conflict-side1-bg);
    border-color: var(--conflict-side1-border);
    color: var(--red);
  }

  .resolve-theirs:hover {
    background: var(--conflict-side2-bg);
    border-color: var(--conflict-side2-border);
    color: var(--red);
  }

  /* --- Conflict region card --- */
  .conflict-line {
    position: relative;
    border-left: 1px solid var(--conflict-boundary-border);
    border-right: 1px solid var(--conflict-boundary-border);
  }

  .conflict-line :global(.diff-line) {
    border-left: 3px solid var(--conflict-side-color, var(--conflict-boundary-border));
    padding-left: 16px;
  }

  .conflict-region-start {
    border-top: 1px solid var(--conflict-boundary-border);
    border-top-left-radius: 6px;
    border-top-right-radius: 6px;
    margin-top: 8px;
  }

  .conflict-region-end {
    border-bottom: 1px solid var(--conflict-boundary-border);
    border-bottom-left-radius: 6px;
    border-bottom-right-radius: 6px;
    margin-bottom: 8px;
  }

  /* Marker lines (<<<<<<< / %%%%%%% / ++++++++ / >>>>>>>) — hidden content, minimal height */
  .conflict-marker-line {
    height: 2px;
    font-size: 0;
    overflow: hidden;
    background: transparent;
  }

  /* Boundary lines (<<<<<<< / >>>>>>>) — just the top/bottom bar */
  .conflict-boundary :global(.conflict-marker-line) {
    height: 2px;
    background: var(--conflict-boundary-border);
  }

  /* Side 1: diff (changes from base) */
  .conflict-diff-marker,
  .conflict-diff-line {
    --conflict-side-color: var(--conflict-side1-border);
  }

  /* Side marker: thin colored bar with side label */
  .conflict-diff-marker :global(.conflict-marker-line) {
    height: 2px;
    background: var(--conflict-side1-border);
  }

  .conflict-diff-line :global(.diff-line) {
    background: var(--conflict-side1-bg);
    border-left-color: var(--conflict-side1-border);
  }

  /* Inner diff within %%%%%%% sections: red for removals, green for additions */
  .conflict-diff-line :global(.conflict-inner-remove) {
    background: var(--diff-remove-bg);
    color: var(--red);
    border-left: 3px solid var(--red);
  }

  .conflict-diff-line :global(.conflict-inner-add) {
    background: var(--diff-add-bg);
    color: var(--green);
    border-left: 3px solid var(--green);
  }

  /* Side 2: snapshot (full content) */
  .conflict-snap-marker,
  .conflict-snap-line {
    --conflict-side-color: var(--conflict-side2-border);
  }

  .conflict-snap-marker :global(.conflict-marker-line) {
    height: 2px;
    background: var(--conflict-side2-border);
  }

  .conflict-snap-line :global(.diff-line) {
    background: var(--conflict-side2-bg);
    border-left-color: var(--conflict-side2-border);
    opacity: 0.7;
  }

  /* --- Inline side labels (right-aligned on marker lines) --- */
  .conflict-side-label {
    position: absolute;
    right: 12px;
    top: 50%;
    transform: translateY(-50%);
    font-size: 10px;
    font-weight: 600;
    font-style: italic;
    letter-spacing: 0.3px;
    color: var(--conflict-side-color, var(--subtext0));
    opacity: 0.9;
    pointer-events: none;
    background: var(--base);
    padding: 0 6px;
    border-radius: 3px;
    z-index: 1;
  }

  /* --- Per-region resolve buttons (on >>>>>>> line) --- */
  /* Hover preview: strikethrough overlay on discarded side, amber accent on kept side */

  /* Transition on kept/discarded so both discard and un-discard animate smoothly */
  .conflict-side-kept :global(.diff-line),
  .conflict-side-discarded :global(.diff-line) {
    transition: opacity var(--anim-duration) var(--anim-ease);
  }

  .conflict-side-kept :global(.diff-line) {
    border-left-color: var(--amber);
  }

  /* Preserve inner-diff red/green borders over the amber kept highlight */
  .conflict-side-kept :global(.conflict-inner-remove) {
    border-left-color: var(--red);
  }

  .conflict-side-kept :global(.conflict-inner-add) {
    border-left-color: var(--green);
  }

  /* Strikethrough via ::after pseudo-element — avoids layout reflow from text-decoration */
  .conflict-side-discarded :global(.diff-line) {
    position: relative;
    opacity: 0.4;
  }

  .conflict-side-discarded :global(.diff-line)::after {
    content: '';
    position: absolute;
    top: 50%;
    left: 0;
    right: 0;
    height: 1px;
    background: var(--surface2);
    pointer-events: none;
  }

  .conflict-resolve-inline {
    position: absolute;
    left: 50%;
    top: 50%;
    transform: translate(-50%, -50%);
    display: flex;
    gap: 6px;
    z-index: 2;
  }

  .resolve-btn-inline {
    background: var(--surface0);
    border: 1px solid var(--surface1);
    color: var(--subtext0);
    padding: 1px 8px;
    border-radius: 3px;
    cursor: pointer;
    font-family: inherit;
    font-size: 9px;
    font-weight: 600;
    transition: background 0.15s ease, border-color 0.15s ease, color 0.15s ease;
  }

  .resolve-inline-ours:hover {
    background: var(--conflict-side1-marker-bg);
    border-color: var(--conflict-side1-border);
    color: var(--conflict-side1-border);
  }

  .resolve-inline-theirs:hover {
    background: var(--conflict-side2-marker-bg);
    border-color: var(--conflict-side2-border);
    color: var(--conflict-side2-border);
  }
</style>
