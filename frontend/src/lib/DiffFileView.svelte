<script lang="ts">
  import type { DiffFile, DiffLine } from './diff-parser'
  import { toSplitView } from './split-view'
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

  // Pre-build a Map<hunkIdx, Map<lineIdx, cssClass>> for O(1) conflict styling lookups.
  // Only computed when the file has conflicts.
  let conflictData = $derived.by(() => {
    if (!isConflict) return null
    const lineClasses = new Map<number, Map<number, string>>()
    let totalConflicts = 0
    for (let hunkIdx = 0; hunkIdx < file.hunks.length; hunkIdx++) {
      const regions = findConflicts(file.hunks[hunkIdx].lines)
      if (regions.length === 0) continue
      totalConflicts += regions.length
      const classMap = new Map<number, string>()
      for (const region of regions) {
        classMap.set(region.startIdx, 'conflict-boundary')
        classMap.set(region.endIdx, 'conflict-boundary')
        for (const side of region.sides) {
          classMap.set(side.startIdx, side.type === 'diff' ? 'conflict-diff-marker' : 'conflict-snap-marker')
          const lineClass = side.type === 'diff' ? 'conflict-diff-line' : 'conflict-snap-line'
          for (let i = side.startIdx + 1; i <= side.endIdx; i++) {
            classMap.set(i, lineClass)
          }
        }
      }
      lineClasses.set(hunkIdx, classMap)
    }
    return { lineClasses, totalConflicts }
  })
</script>

{#snippet diffLine(line: DiffLine, hlKey: string, spans: WordSpan[] | undefined)}
  {#if highlightedLines.has(hlKey)}
    <div
      class="diff-line highlighted"
      class:diff-add={line.type === 'add'}
      class:diff-remove={line.type === 'remove'}
      class:diff-context={line.type === 'context'}
    >{@html highlightedLines.get(hlKey)}</div>
  {:else if spans}
    <div
      class="diff-line"
      class:diff-add={line.type === 'add'}
      class:diff-remove={line.type === 'remove'}
    ><span class="diff-prefix">{line.content[0]}</span>{#each spans as span}{#if span.changed}<span
          class="word-change"
        >{span.text}</span>{:else}{span.text}{/if}{/each}</div>
  {:else}
    <div
      class="diff-line"
      class:diff-add={line.type === 'add'}
      class:diff-remove={line.type === 'remove'}
      class:diff-context={line.type === 'context'}
    >{line.content}</div>
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
    {#if isConflict && conflictData}
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
      <div class="split-view">
        <div class="split-col split-left">
          {#each splitLines as sl}
            {#if sl.left?.line.type === 'header'}
              {#if !isExpanded}<div class="diff-hunk-header">{sl.left.line.content}</div>{/if}
            {:else if sl.left}
              {@const slKey = `${filePath}:${sl.left.hunkIdx}:${sl.left.lineIdx}`}
              {@const spans = wordDiffMap.get(`${filePath}:${sl.left.hunkIdx}`)?.get(sl.left.lineIdx)}
              {@render diffLine(sl.left.line, slKey, spans)}
            {:else}
              <div class="diff-line diff-empty">&nbsp;</div>
            {/if}
          {/each}
        </div>
        <div class="split-col split-right">
          {#each splitLines as sl}
            {#if sl.right?.line.type === 'header'}
              {#if !isExpanded}<div class="diff-hunk-header">{sl.right.line.content}</div>{/if}
            {:else if sl.right}
              {@const srKey = `${filePath}:${sl.right.hunkIdx}:${sl.right.lineIdx}`}
              {@const spans = wordDiffMap.get(`${filePath}:${sl.right.hunkIdx}`)?.get(sl.right.lineIdx)}
              {@render diffLine(sl.right.line, srKey, spans)}
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
        <div class="diff-lines">
          {#each hunk.lines as line, lineIdx}
            {@const hlKey = `${filePath}:${hunkIdx}:${lineIdx}`}
            {@const spans = wordDiffs.get(lineIdx)}
            {@const cc = conflictData?.lineClasses.get(hunkIdx)?.get(lineIdx) ?? ''}
            {#if cc}
              <div class="conflict-line {cc}">
                {@render diffLine(line, hlKey, spans)}
              </div>
            {:else}
              {@render diffLine(line, hlKey, spans)}
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
    font-size: 12px;
    line-height: 1.5;
  }

  .diff-line {
    padding: 0 12px;
    white-space: pre-wrap;
    word-break: break-all;
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
    background: var(--badge-modify-bg);
    border-color: var(--blue);
    color: var(--blue);
  }

  .resolve-theirs:hover {
    background: var(--badge-other-bg);
    border-color: var(--yellow);
    color: var(--yellow);
  }

  /* --- Conflict region styling --- */
  .conflict-line :global(.diff-line) {
    border-left: 3px solid var(--conflict-color);
  }

  .conflict-boundary {
    --conflict-color: var(--red);
  }
  .conflict-boundary :global(.diff-line) {
    background: var(--bg-error);
    color: var(--red);
    font-weight: 700;
  }

  .conflict-diff-marker,
  .conflict-diff-line {
    --conflict-color: var(--yellow);
  }
  .conflict-diff-marker :global(.diff-line),
  .conflict-diff-line :global(.diff-line) {
    background: var(--badge-other-bg);
  }
  .conflict-diff-marker :global(.diff-line) {
    color: var(--yellow);
    font-weight: 600;
  }

  .conflict-snap-marker,
  .conflict-snap-line {
    --conflict-color: var(--blue);
  }
  .conflict-snap-marker :global(.diff-line),
  .conflict-snap-line :global(.diff-line) {
    background: var(--badge-modify-bg);
  }
  .conflict-snap-marker :global(.diff-line) {
    color: var(--blue);
    font-weight: 600;
  }
</style>
