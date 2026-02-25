<script lang="ts">
  import type { DiffFile, DiffHunk, DiffLine } from './diff-parser'
  import { toSplitView, type SplitLine } from './split-view'
  import type { WordSpan } from './word-diff'
  import type { FileChange } from './api'
  import { findConflicts, type ConflictRegion } from './conflict-parser'

  interface Props {
    file: DiffFile
    fileStats: FileChange | undefined
    isCollapsed: boolean
    isExpanded: boolean
    splitView: boolean
    highlightedLines: Map<string, string>
    wordDiffMap: Map<string, Map<number, WordSpan[]>>
    ontoggle: (path: string) => void
    onexpand: (path: string) => void
    onresolve?: (file: string, tool: ':ours' | ':theirs') => void
  }

  let { file, fileStats, isCollapsed, isExpanded, splitView, highlightedLines, wordDiffMap, ontoggle, onexpand, onresolve }: Props = $props()

  let filePath = $derived(file.filePath)
  let isConflict = $derived(fileStats?.conflict ?? false)

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

  interface ConflictLineMeta {
    cssClass: string
    isRegionStart?: boolean
    isRegionEnd?: boolean
    sideLabel?: string
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
        metaMap.set(region.startIdx, { cssClass: 'conflict-boundary', isRegionStart: true })
        metaMap.set(region.endIdx, { cssClass: 'conflict-boundary', isRegionEnd: true })
        for (let sideIdx = 0; sideIdx < region.sides.length; sideIdx++) {
          const side = region.sides[sideIdx]
          const isDiff = side.type === 'diff'
          const label = side.label || (isDiff ? 'changes' : 'content')
          metaMap.set(side.startIdx, {
            cssClass: isDiff ? 'conflict-diff-marker' : 'conflict-snap-marker',
            sideLabel: label,
          })
          const lineClass = isDiff ? 'conflict-diff-line' : 'conflict-snap-line'
          for (let i = side.startIdx + 1; i <= side.endIdx; i++) {
            metaMap.set(i, { cssClass: lineClass })
          }
        }
      }
      lineMeta.set(hunkIdx, metaMap)
    }
    return { lineMeta, totalConflicts }
  })
</script>

{#snippet diffLine(line: DiffLine, hlKey: string, spans: WordSpan[] | undefined, lineNumbers: (number | null)[])}
  {#if highlightedLines.has(hlKey)}
    <div
      class="diff-line highlighted"
      class:diff-add={line.type === 'add'}
      class:diff-remove={line.type === 'remove'}
      class:diff-context={line.type === 'context'}
    >{#each lineNumbers as n}<span class="line-num">{n ?? ''}</span>{/each}{@html highlightedLines.get(hlKey)}</div>
  {:else if spans}
    <div
      class="diff-line"
      class:diff-add={line.type === 'add'}
      class:diff-remove={line.type === 'remove'}
    >{#each lineNumbers as n}<span class="line-num">{n ?? ''}</span>{/each}<span class="diff-prefix">{line.content[0]}</span>{#each spans as span}{#if span.changed}<span
          class="word-change"
        >{span.text}</span>{:else}{span.text}{/if}{/each}</div>
  {:else}
    <div
      class="diff-line"
      class:diff-add={line.type === 'add'}
      class:diff-remove={line.type === 'remove'}
      class:diff-context={line.type === 'context'}
    >{#each lineNumbers as n}<span class="line-num">{n ?? ''}</span>{/each}{line.content}</div>
  {/if}
{/snippet}

<div class="diff-file" data-file-path={filePath}>
  <div
    class="diff-file-header"
    onclick={() => ontoggle(filePath)}
    role="button"
    tabindex="0"
    onkeydown={(e: KeyboardEvent) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); ontoggle(filePath) }}}
  >
    <span class="collapse-toggle">{isCollapsed ? '\u25B6' : '\u25BC'}</span>
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
      {#if onresolve}
        <button class="resolve-btn resolve-ours" onclick={(e: MouseEvent) => { e.stopPropagation(); onresolve!(filePath, ':ours') }}>Accept Ours</button>
        <button class="resolve-btn resolve-theirs" onclick={(e: MouseEvent) => { e.stopPropagation(); onresolve!(filePath, ':theirs') }}>Accept Theirs</button>
      {/if}
    {/if}
  </div>
  {#if !isCollapsed}
    {#if splitView}
      <!-- Split (side-by-side) view -->
      {#if !isExpanded && file.hunks.length > 1}
        <button class="expand-btn" onclick={() => onexpand(filePath)}>
          ↕ Expand full context
        </button>
      {/if}
      {@const splitLines = toSplitView(file.hunks)}
      {@const splitNums = computeSplitLineNumbers(file.hunks, splitLines)}
      <div class="split-view">
        <div class="split-col split-left">
          {#each splitLines as sl, si}
            {#if sl.left?.line.type === 'header'}
              {#if !isExpanded}<div class="diff-hunk-header">{sl.left.line.content}</div>{/if}
            {:else if sl.left}
              {@const slKey = `${filePath}:${sl.left.hunkIdx}:${sl.left.lineIdx}`}
              {@const spans = wordDiffMap.get(`${filePath}:${sl.left.hunkIdx}`)?.get(sl.left.lineIdx)}
              {@render diffLine(sl.left.line, slKey, spans, [splitNums[si].oldLeft])}
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
              {@const spans = wordDiffMap.get(`${filePath}:${sl.right.hunkIdx}`)?.get(sl.right.lineIdx)}
              {@render diffLine(sl.right.line, srKey, spans, [splitNums[si].newRight])}
            {:else}
              <div class="diff-line diff-empty">&nbsp;</div>
            {/if}
          {/each}
        </div>
      </div>
    {:else}
      <!-- Unified view -->
      {#each file.hunks as hunk, hunkIdx}
        {@const wordDiffs = wordDiffMap.get(`${filePath}:${hunkIdx}`) ?? new Map()}
        {#if !isExpanded}
          {#if hunkIdx === 0 && hunk.newStart > 1}
            <button class="expand-btn" onclick={() => onexpand(filePath)}>
              ↕ Show {hunk.newStart - 1} lines above
            </button>
          {/if}
          {#if hunkIdx > 0}
            {@const prev = file.hunks[hunkIdx - 1]}
            {@const gap = hunk.newStart - (prev.newStart + prev.newCount)}
            {#if gap > 0}
              <button class="expand-btn" onclick={() => onexpand(filePath)}>
                ↕ Show {gap} hidden lines
              </button>
            {/if}
          {/if}
          <div class="diff-hunk-header">{hunk.header}</div>
        {/if}
        {@const lineNums = computeLineNumbers(hunk)}
        <div class="diff-lines">
          {#each hunk.lines as line, lineIdx}
            {@const hlKey = `${filePath}:${hunkIdx}:${lineIdx}`}
            {@const spans = wordDiffs.get(lineIdx)}
            {@const cm = conflictData?.lineMeta.get(hunkIdx)?.get(lineIdx)}
            {@const ln = lineNums[lineIdx]}
            {#if cm}
              <div
                class="conflict-line {cm.cssClass}"
                class:conflict-region-start={cm.isRegionStart}
                class:conflict-region-end={cm.isRegionEnd}
              >
                {#if cm.sideLabel}
                  <span class="conflict-side-label">{cm.sideLabel}</span>
                {/if}
                {#if cm.isRegionEnd && onresolve}
                  <div class="conflict-resolve-inline">
                    <button class="resolve-btn-inline resolve-inline-ours" onclick={(e: MouseEvent) => { e.stopPropagation(); onresolve!(filePath, ':ours') }}>Accept Ours</button>
                    <button class="resolve-btn-inline resolve-inline-theirs" onclick={(e: MouseEvent) => { e.stopPropagation(); onresolve!(filePath, ':theirs') }}>Accept Theirs</button>
                  </div>
                {/if}
                {@render diffLine(line, hlKey, spans, [ln.old, ln.new])}
              </div>
            {:else}
              {@render diffLine(line, hlKey, spans, [ln.old, ln.new])}
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
    padding: 8px 12px;
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
    transition: background 0.1s ease;
  }

  .diff-file-header:hover {
    background: var(--bg-diff-header-hover);
  }

  .collapse-toggle {
    color: var(--surface2);
    font-size: 10px;
    width: 12px;
    flex-shrink: 0;
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
    color: var(--blue);
  }

  .badge-D {
    background: var(--badge-delete-bg);
    color: var(--red);
  }

  .badge-R {
    background: var(--badge-other-bg);
    color: var(--yellow);
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
    display: block;
    width: 100%;
    padding: 3px 12px;
    background: var(--bg-hunk-header);
    color: var(--overlay0);
    border: none;
    border-bottom: 1px solid var(--border-hunk-header);
    font-family: inherit;
    font-size: 11px;
    cursor: pointer;
    text-align: center;
  }

  .expand-btn:hover {
    background: var(--bg-hover);
    color: var(--teal);
  }

  .diff-hunk-header {
    padding: 4px 12px;
    background: var(--bg-hunk-header);
    color: var(--teal);
    font-size: 12px;
    border-bottom: 1px solid var(--border-hunk-header);
    font-style: italic;
  }

  .diff-lines {
    font-family: var(--font-mono);
    font-size: 12px;
    line-height: 1.5;
  }

  .diff-line {
    padding: 0 12px;
    white-space: pre-wrap;
    word-break: break-all;
  }

  .line-num {
    display: inline-block;
    min-width: 4ch;
    text-align: right;
    padding-right: 1.5ch;
    color: var(--surface2);
    user-select: none;
    -webkit-user-select: none;
    font-size: 11px;
    opacity: 0.6;
  }

  .diff-add {
    background: var(--diff-add-bg);
    color: var(--green);
    border-left: 3px solid var(--green);
  }

  .diff-remove {
    background: var(--diff-remove-bg);
    color: var(--red);
    border-left: 3px solid var(--red);
  }

  .diff-context {
    color: var(--subtext0);
    border-left: 3px solid transparent;
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
    transition: all 0.15s ease;
  }

  .resolve-btn:hover {
    color: var(--text);
  }

  .resolve-ours:hover {
    background: var(--conflict-side1-bg);
    border-color: var(--peach);
    color: var(--peach);
  }

  .resolve-theirs:hover {
    background: var(--conflict-side2-bg);
    border-color: var(--mauve);
    color: var(--mauve);
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

  /* Boundary lines (<<<<<<< / >>>>>>>) — visual chrome, de-emphasized */
  .conflict-boundary :global(.diff-line) {
    background: var(--conflict-boundary-bg);
    color: var(--conflict-boundary-color);
    font-size: 10px;
    font-weight: 500;
    letter-spacing: 0.3px;
    line-height: 2;
    opacity: 0.7;
  }

  /* Side 1: diff (changes) — peach */
  .conflict-diff-marker,
  .conflict-diff-line {
    --conflict-side-color: var(--conflict-side1-border);
  }

  .conflict-diff-line :global(.diff-line) {
    background: var(--conflict-side1-bg);
  }

  .conflict-diff-marker :global(.diff-line) {
    background: var(--conflict-side1-marker-bg);
    color: var(--conflict-marker-color);
    font-size: 10px;
    font-weight: 400;
    letter-spacing: 0.3px;
    line-height: 2;
    opacity: 0.6;
  }

  /* Side 2: snapshot (content) — mauve */
  .conflict-snap-marker,
  .conflict-snap-line {
    --conflict-side-color: var(--conflict-side2-border);
  }

  .conflict-snap-line :global(.diff-line) {
    background: var(--conflict-side2-bg);
  }

  .conflict-snap-marker :global(.diff-line) {
    background: var(--conflict-side2-marker-bg);
    color: var(--conflict-marker-color);
    font-size: 10px;
    font-weight: 400;
    letter-spacing: 0.3px;
    line-height: 2;
    opacity: 0.6;
  }

  /* --- Inline side labels (right-aligned on marker lines) --- */
  .conflict-side-label {
    position: absolute;
    right: 12px;
    top: 50%;
    transform: translateY(-50%);
    font-size: 10px;
    font-weight: 600;
    letter-spacing: 0.3px;
    color: var(--conflict-side-color, var(--subtext0));
    opacity: 0.8;
    pointer-events: none;
    z-index: 1;
  }

  /* --- Per-region resolve buttons (on >>>>>>> line) --- */
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
    transition: all 0.15s ease;
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
