<script lang="ts">
  import { SvelteSet } from 'svelte/reactivity'
  import { effectiveId, type LogEntry, type PullRequest } from './api'
  import { targetModeLabel, type RebaseMode, type SquashMode, type SplitMode } from './modes.svelte'
  import GraphSvg from './GraphSvg.svelte'

  interface Props {
    revisions: LogEntry[]
    selectedIndex: number
    checkedRevisions: SvelteSet<string>
    loading: boolean
    revsetFilter: string
    viewMode: 'log' | 'tracked'
    lastCheckedIndex: number
    onselect: (index: number) => void
    oncheck: (changeId: string, index: number) => void
    onrangecheck: (from: number, to: number) => void
    oncontextmenu: (changeId: string, x: number, y: number) => void
    onnewfromchecked: () => void
    onabandonchecked: () => void
    onclearchecks: () => void
    onrevsetsubmit: () => void
    onrevsetclear: () => void
    onrevsetchange: (value: string) => void
    onrevsetescaped: () => void
    onviewmodechange: () => void
    onbookmarkclick: (name: string) => void
    rebase: RebaseMode
    squash: SquashMode
    split: SplitMode
    isDark: boolean
    prByBookmark: Map<string, PullRequest>
  }

  let {
    revisions, selectedIndex, checkedRevisions, loading, revsetFilter, viewMode, lastCheckedIndex,
    onselect, oncheck, onrangecheck, oncontextmenu,
    onnewfromchecked, onabandonchecked, onclearchecks,
    onrevsetsubmit, onrevsetclear, onrevsetchange, onrevsetescaped, onviewmodechange, onbookmarkclick,
    rebase, squash, split,
    isDark, prByBookmark,
  }: Props = $props()

  let anyModeActive = $derived(rebase.active || squash.active || split.active)

  let revsetInputEl: HTMLInputElement | undefined = $state(undefined)
  let hoveredLane: number | null = $state(null)

  interface FlatLine {
    gutter: string
    content?: string // text content for connector lines (e.g., "(elided revisions)")
    entryIndex: number
    lineKey: string // semantic key within this entry (e.g., 'node', 'bm', 'desc', 'g0')
    isNode: boolean
    isBookmarkLine: boolean
    isDescLine: boolean
    isWorkingCopy: boolean
    isHidden: boolean
    isImmutable?: boolean
    isConflicted?: boolean
    isDivergent?: boolean
  }

  const sourceModeLabel: Record<string, string> = { '-r': 'move', '-s': 'source', '-b': 'branch' }

  // Build a continuation gutter: replace node symbols with │, keep pipes and spaces
  const nodeChars = new Set(['@', '○', '◆', '×', '◌'])
  const branchChars = new Set(['─', '╮', '╯', '╭', '╰', '├', '┤'])

  function continuationGutter(gutter: string): string {
    let result = ''
    for (const ch of gutter) {
      if (nodeChars.has(ch)) result += '│'
      else if (branchChars.has(ch)) result += ' '
      else result += ch
    }
    return result
  }

  // Compute max gutter width across all lines so we can pad gutters
  // to a uniform width, keeping descriptions vertically aligned.
  // Cap at MAX_GUTTER to prevent deep graphs from consuming too much space.
  const MAX_GUTTER = 12

  let maxGutterLen = $derived.by(() => {
    let max = 0
    for (const entry of revisions) {
      for (const gl of entry.graph_lines) {
        if (gl.gutter.length > max) max = gl.gutter.length
      }
    }
    return Math.min(max, MAX_GUTTER)
  })

  let maxLanes = $derived(Math.ceil(maxGutterLen / 2))

  function padGutter(gutter: string): string {
    return gutter.length > maxGutterLen
      ? gutter.slice(0, maxGutterLen)
      : gutter.padEnd(maxGutterLen)
  }

  // Compute divergence offsets: for divergent commits sharing a change_id,
  // assign /0, /1, ... sorted by commit_id (matching jj's convention).
  let divergenceOffsets = $derived.by(() => {
    const map = new Map<string, string>() // commit_id → "/N"
    // Group divergent commits by change_id
    const groups = new Map<string, string[]>() // change_id → [commit_id, ...]
    for (const entry of revisions) {
      if (!entry.commit.divergent) continue
      const cid = entry.commit.change_id
      if (!groups.has(cid)) groups.set(cid, [])
      groups.get(cid)!.push(entry.commit.commit_id)
    }
    for (const commitIds of groups.values()) {
      commitIds.sort() // lexicographic, matches jj's offset assignment
      for (let i = 0; i < commitIds.length; i++) {
        map.set(commitIds[i], `/${i}`)
      }
    }
    return map
  })

  let flatLines = $derived.by(() => {
    const lines: FlatLine[] = []
    revisions.forEach((entry, i) => {
      // Use semantic keys ('node', 'bm', 'desc', 'g0', 'g1', ...) so that
      // adding/removing a bookmark line doesn't shift sibling keys and cause
      // Svelte's keyed {#each} to mismap DOM nodes during reconciliation.
      let graphIdx = 0
      entry.graph_lines.forEach((gl, j) => {
        const isNode = gl.is_node ?? (j === 0)
        lines.push({
          gutter: padGutter(gl.gutter),
          content: gl.content || undefined,
          entryIndex: i,
          lineKey: isNode ? 'node' : `g${graphIdx++}`,
          isNode,
          isBookmarkLine: false,
          isDescLine: false,
          isWorkingCopy: entry.commit.is_working_copy,
          isHidden: entry.commit.hidden,
          isImmutable: entry.commit.immutable,
          isConflicted: isNode && entry.commit.conflicted,
          isDivergent: isNode && entry.commit.divergent,
        })
        if (isNode) {
          const contGutter = padGutter(continuationGutter(gl.gutter))
          const hasLabels = (entry.bookmarks?.length ?? 0) + (entry.commit.working_copies?.length ?? 0) > 0
          if (hasLabels) {
            lines.push({
              gutter: contGutter,
              entryIndex: i,
              lineKey: 'bm',
              isNode: false,
              isBookmarkLine: true,
              isDescLine: false,
              isWorkingCopy: entry.commit.is_working_copy,
              isHidden: entry.commit.hidden,
            })
          }
          lines.push({
            gutter: contGutter,
            entryIndex: i,
            lineKey: 'desc',
            isNode: false,
            isBookmarkLine: false,
            isDescLine: true,
            isWorkingCopy: entry.commit.is_working_copy,
            isHidden: entry.commit.hidden,
          })
        }
      })
    })
    return lines
  })

  export function focusRevsetInput() {
    revsetInputEl?.focus()
  }

  // Scroll the selected node row into view when selectedIndex changes.
  // Svelte 5 effects run after DOM updates, so no rAF needed.
  let listEl: HTMLElement | undefined = $state(undefined)
  $effect(() => {
    if (selectedIndex < 0) return
    const el = listEl?.querySelector('.graph-row.node-row.selected')
    el?.scrollIntoView({ block: 'nearest' })
  })
</script>

<div class="panel revisions-panel">
  <div class="panel-header">
    <span class="panel-title">Revisions</span>
    <div class="view-toggle">
      <button class="view-btn" class:view-btn-active={viewMode === 'log'} onclick={() => { if (viewMode !== 'log') onviewmodechange() }}>Log</button>
      <button class="view-btn" class:view-btn-active={viewMode === 'tracked'} onclick={() => { if (viewMode !== 'tracked') onviewmodechange() }}>Tracked</button>
    </div>
    {#if !loading}
      <span class="panel-badge">{revisions.length}{#if checkedRevisions.size > 0} ({checkedRevisions.size} checked){/if}</span>
    {/if}
  </div>
  <!-- Revset filter input -->
  <div class="revset-filter-bar">
    <span class="revset-icon">$</span>
    <input
      bind:this={revsetInputEl}
      value={revsetFilter}
      oninput={(e: Event) => onrevsetchange((e.target as HTMLInputElement).value)}
      class="revset-input"
      type="text"
      placeholder="revset filter (press / to focus)"
      onkeydown={(e: KeyboardEvent) => {
        if (e.key === 'Enter') {
          e.preventDefault()
          onrevsetsubmit()
        } else if (e.key === 'Escape') {
          e.preventDefault()
          onrevsetescaped()
          revsetInputEl?.blur()
        }
      }}
    />
    {#if revsetFilter}
      <button class="revset-clear" onclick={onrevsetclear} title="Clear filter (Escape)">x</button>
    {/if}
  </div>
  {#if checkedRevisions.size > 0 && !anyModeActive}
    <div class="batch-actions-bar">
      <span class="batch-label">{checkedRevisions.size} checked</span>
      <button class="action-btn" onclick={onnewfromchecked} title="New from checked (n)">new</button>
      <button class="action-btn danger" onclick={onabandonchecked} title="Abandon checked">abandon</button>
      <button class="action-btn" onclick={onclearchecks} title="Clear checks (Escape)">clear</button>
    </div>
  {/if}
  <div class="panel-content">
    {#if loading}
      <div class="empty-state">
        <div class="spinner"></div>
        <span>Loading revisions...</span>
      </div>
    {:else if revisions.length === 0}
      <div class="empty-state">No revisions found</div>
    {:else}
      <!-- svelte-ignore a11y_no_static_element_interactions -->
      <div class="revision-list" bind:this={listEl} role="listbox" tabindex="-1" aria-label="Revision list"
        onmouseleave={() => hoveredLane = null}>
        {#each flatLines as line, lineIdx (effectiveId(revisions[line.entryIndex].commit) + ':' + line.lineKey)}
          {@const isChecked = checkedRevisions.has(effectiveId(revisions[line.entryIndex]?.commit))}
          <!-- svelte-ignore a11y_click_events_have_key_events -->
          <div
            class="graph-row"
            class:node-row={line.isNode}
            class:bookmark-row={line.isBookmarkLine}
            class:desc-row={line.isDescLine}
            class:selected={selectedIndex === line.entryIndex}
            class:checked={isChecked}
            class:wc={line.isWorkingCopy}
            class:hidden-rev={line.isHidden}
            class:immutable={line.isImmutable}
            onclick={(e: MouseEvent) => {
              if (e.shiftKey && line.isNode && lastCheckedIndex >= 0) {
                e.preventDefault()
                onrangecheck(lastCheckedIndex, line.entryIndex)
              } else {
                onselect(line.entryIndex)
              }
            }}
            oncontextmenu={(e: MouseEvent) => {
              e.preventDefault()
              if (anyModeActive) return
              oncontextmenu(effectiveId(revisions[line.entryIndex].commit), e.clientX, e.clientY)
            }}
            role="option"
            tabindex={line.isNode ? 0 : -1}
            aria-selected={selectedIndex === line.entryIndex}
          >
            <span class="check-gutter">{#if line.isNode && isChecked}✓{/if}</span>
            <GraphSvg
              gutter={line.gutter}
              isNode={line.isNode}
              isWorkingCopy={line.isWorkingCopy}
              isImmutable={line.isImmutable ?? false}
              isConflicted={line.isConflicted ?? false}
              isDivergent={line.isDivergent ?? false}
              isHidden={line.isHidden}
              {maxLanes}
              {hoveredLane}
              {isDark}
              onlanehover={(lane) => hoveredLane = lane}
            />
            {#if line.isNode}
              {@const entry = revisions[line.entryIndex]}
              {@const eid = effectiveId(entry.commit)}
              {@const isRebaseSource = rebase.active && rebase.sources.includes(eid)}
              {@const isRebaseTarget = rebase.active && selectedIndex === line.entryIndex && !isRebaseSource}
              {@const isSquashSource = squash.active && squash.sources.includes(eid)}
              {@const isSquashTarget = squash.active && selectedIndex === line.entryIndex && !isSquashSource}
              {@const isSplitSource = split.active && eid === split.revision}
              {#if isRebaseSource}
                <span class="rebase-badge rebase-source">&lt;&lt; {sourceModeLabel[rebase.sourceMode]} &gt;&gt;</span>
              {/if}
              {#if isRebaseTarget}
                <span class="rebase-badge rebase-target">&lt;&lt; {targetModeLabel[rebase.targetMode]} &gt;&gt;</span>
              {/if}
              {#if isSquashSource}
                <span class="rebase-badge rebase-source">&lt;&lt; from &gt;&gt;</span>
              {/if}
              {#if isSquashTarget}
                <span class="rebase-badge rebase-target">&lt;&lt; into &gt;&gt;</span>
              {/if}
              {#if isSplitSource}
                <span class="rebase-badge split-source">&lt;&lt; split &gt;&gt;</span>
              {/if}
              {#if entry.commit.divergent}
                <span class="divergent-badge">divergent</span>
              {/if}
              <span class="node-line-content">
                {#if entry.commit.is_working_copy}
                  <span class="wc-badge">@</span>
                {/if}
                <span class="description-text">{entry.description || '(no description)'}</span>
              </span>
            {:else if line.isBookmarkLine}
              {@const entry = revisions[line.entryIndex]}
              <span class="bookmark-line-content">
                {#each entry.commit.working_copies ?? [] as ws}
                  <span class="workspace-badge">◇ {ws}@</span>
                {/each}
                {#each entry.bookmarks ?? [] as bm}
                  {@const pr = prByBookmark.get(bm)}
                  {#if pr}
                    <a class="pr-badge" class:is-draft={pr.is_draft}
                       href={pr.url} target="_blank" rel="noopener"
                       onclick={(e: MouseEvent) => e.stopPropagation()}
                       title="{pr.is_draft ? 'Draft ' : ''}PR #{pr.number} — click to open on GitHub">
                      <span class="pr-name">↗ {bm}</span>
                      <span class="pr-number">#{pr.number}</span>
                    </a>
                  {:else}
                    <button class="bookmark-badge" onclick={(e: MouseEvent) => { e.stopPropagation(); onbookmarkclick(bm) }}>⑂ {bm}</button>
                  {/if}
                {/each}
              </span>
            {:else if line.isDescLine}
              {@const entry = revisions[line.entryIndex]}
              {@const descEid = effectiveId(entry.commit)}
              {@const isRebaseTarget = rebase.active && selectedIndex === line.entryIndex && !rebase.sources.includes(descEid)}
              {@const isSquashTarget = squash.active && selectedIndex === line.entryIndex && !squash.sources.includes(descEid)}
              {@const isSplitPreview = split.active && descEid === split.revision}
              <span class="desc-line-content">
                {#if isSplitPreview}
                  <span class="rebase-preview">jj split -r {entry.commit.change_id.slice(0, 8)}{split.parallel ? ' --parallel' : ''}</span>
                {:else if isRebaseTarget}
                  <span class="rebase-preview">rebase {rebase.sourceMode} {rebase.sources.map(s => s.slice(0, 8)).join(' ')} {rebase.targetMode} {entry.commit.change_id.slice(0, 8)}</span>
                {:else if isSquashTarget}
                  <span class="rebase-preview">jj squash --from {squash.sources.map(s => s.slice(0, 8)).join(' --from ')} --into {entry.commit.change_id.slice(0, 8)}{squash.keepEmptied ? ' --keep-emptied' : ''}{squash.useDestMsg ? ' --use-destination-message' : ''}</span>
                {:else}
                  {@const divOffset = divergenceOffsets.get(entry.commit.commit_id)}
                  <span class="meta-line">
                    <span class="change-id">{entry.commit.change_id.slice(0, entry.commit.change_prefix)}<span class="id-rest">{entry.commit.change_id.slice(entry.commit.change_prefix, 12)}</span>{#if divOffset}<span class="div-offset">{divOffset}</span>{/if}</span>
                    <span class="commit-id">{entry.commit.commit_id.slice(0, entry.commit.commit_prefix)}<span class="id-rest">{entry.commit.commit_id.slice(entry.commit.commit_prefix, 12)}</span></span>
                  </span>
                {/if}
              </span>
            {:else if line.content}
              <span class="elided-marker">
                <span class="elided-dots" aria-hidden="true"></span>
                <span class="elided-label">{line.content}</span>
                <span class="elided-dots" aria-hidden="true"></span>
              </span>
            {/if}
          </div>
        {/each}
      </div>
    {/if}
  </div>
</div>

<style>
  /* --- View toggle --- */
  .view-toggle {
    display: flex;
    gap: 1px;
    background: var(--surface0);
    border-radius: 4px;
    overflow: hidden;
  }

  .view-btn {
    padding: 2px 8px;
    font-size: 11px;
    font-family: inherit;
    font-weight: 500;
    border: none;
    background: var(--mantle);
    color: var(--overlay0);
    cursor: pointer;
    line-height: 1.4;
  }

  .view-btn:hover:not(.view-btn-active) {
    color: var(--text);
  }

  .view-btn-active {
    background: var(--surface0);
    color: var(--text);
  }

  /* --- Revset filter --- */
  .revset-filter-bar {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 4px 8px;
    background: var(--mantle);
    border-bottom: 1px solid var(--surface0);
    flex-shrink: 0;
  }

  .revset-icon {
    color: var(--surface2);
    font-size: 12px;
    font-weight: 700;
    flex-shrink: 0;
  }

  .revset-input {
    flex: 1;
    background: var(--base);
    color: var(--text);
    border: 1px solid var(--surface1);
    border-radius: 3px;
    padding: 3px 6px;
    font-family: inherit;
    font-size: 12px;
    outline: none;
    transition: border-color 0.15s ease;
  }

  .revset-input:focus {
    border-color: var(--amber);
  }

  .revset-input::placeholder {
    color: var(--surface1);
  }

  .revset-clear {
    background: transparent;
    border: none;
    color: var(--surface2);
    cursor: pointer;
    font-family: inherit;
    font-size: 14px;
    padding: 0 4px;
    line-height: 1;
    flex-shrink: 0;
  }

  .revset-clear:hover {
    color: var(--red);
  }

  /* --- Batch actions bar --- */
  .batch-actions-bar {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 4px 8px;
    background: var(--bg-checked);
    border-bottom: 1px solid var(--border-bookmark);
    flex-shrink: 0;
  }

  .batch-label {
    color: var(--green);
    font-size: 11px;
    font-weight: 600;
    margin-right: 4px;
  }

  /* --- Panel structure --- */
  .panel {
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }

  .revisions-panel {
    width: 420px;
    min-width: 320px;
    border-right: 1px solid var(--surface1);
    flex-shrink: 0;
  }

  .panel-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    height: 34px;
    padding: 0 12px;
    background: var(--mantle);
    border-bottom: 1px solid var(--surface0);
    flex-shrink: 0;
    user-select: none;
  }

  .panel-title {
    font-size: 11px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--subtext1);
  }

  .panel-badge {
    background: var(--surface0);
    color: var(--subtext0);
    padding: 0 6px;
    border-radius: 8px;
    font-size: 10px;
    font-weight: 600;
  }

  .panel-content {
    flex: 1;
    overflow-y: auto;
    overflow-x: hidden;
  }

  /* --- Revision list (flat graph rows) --- */
  .revision-list {
    display: flex;
    flex-direction: column;
    user-select: none;
    -webkit-user-select: none;
  }

  .revision-list ::selection {
    background: transparent;
  }

  .graph-row {
    display: flex;
    align-items: center;
    height: 18px;
    line-height: 18px;
    font-size: 13px;
    cursor: pointer;
    outline: none;
    -webkit-tap-highlight-color: transparent;
    overflow: hidden;
    position: relative;
    transition: box-shadow var(--anim-duration) var(--anim-ease);
  }

  .graph-row:hover:not(.selected) {
    background: var(--bg-hover);
  }

  /* Hovering any row in a revision group highlights all rows in that group.
     DOM order is either: node → desc (no bookmarks) or node → bookmark → desc.
     Use explicit sibling chains to avoid crossing revision boundaries. */

  /* No bookmarks: node ↔ desc */
  .graph-row.node-row:not(.selected):has(+ .graph-row.desc-row:hover) {
    background: var(--bg-hover);
  }
  .graph-row.node-row:hover:not(.selected) + .graph-row.desc-row:not(.selected) {
    background: var(--bg-hover);
  }

  /* With bookmarks: node ↔ bookmark ↔ desc */
  .graph-row.node-row:not(.selected):has(+ .graph-row.bookmark-row:hover) {
    background: var(--bg-hover);
  }
  .graph-row.node-row:not(.selected):has(+ .graph-row.bookmark-row + .graph-row.desc-row:hover) {
    background: var(--bg-hover);
  }
  .graph-row.node-row:hover:not(.selected) + .graph-row.bookmark-row:not(.selected) {
    background: var(--bg-hover);
  }
  .graph-row.node-row:hover:not(.selected) + .graph-row.bookmark-row + .graph-row.desc-row:not(.selected) {
    background: var(--bg-hover);
  }
  .graph-row.bookmark-row:hover:not(.selected) + .graph-row.desc-row:not(.selected) {
    background: var(--bg-hover);
  }
  .graph-row.bookmark-row:not(.selected):has(+ .graph-row.desc-row:hover) {
    background: var(--bg-hover);
  }

  .graph-row.selected {
    background: rgba(from var(--amber) r g b / 0.04);
    box-shadow: inset 2px 0 0 var(--amber);
  }

  .graph-row.checked {
    background: var(--bg-checked);
  }

  .graph-row.checked.selected {
    background: var(--bg-checked-selected);
    box-shadow: inset 2px 0 0 var(--amber);
  }

  .graph-row.hidden-rev {
    opacity: 0.45;
  }

  .graph-row.immutable .description-text {
    color: var(--overlay0);
  }

  .check-gutter {
    width: 14px;
    flex-shrink: 0;
    text-align: center;
    color: var(--green);
    font-size: 11px;
    padding-left: 4px;
  }

  .node-line-content,
  .bookmark-line-content,
  .desc-line-content {
    display: inline-flex;
    align-items: baseline;
    overflow: hidden;
    white-space: nowrap;
    min-width: 0;
    flex: 1;
  }

  .node-line-content {
    gap: 6px;
  }

  .bookmark-line-content {
    gap: 4px;
  }

  .wc-badge {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    background: var(--amber);
    color: var(--crust);
    font-size: 9px;
    font-weight: 800;
    width: 14px;
    height: 14px;
    border-radius: 3px;
    flex-shrink: 0;
    line-height: 1;
  }

  .change-id {
    font-family: var(--font-mono);
    font-size: 11px;
    color: var(--amber);
    font-weight: 600;
    letter-spacing: 0.02em;
    flex-shrink: 0;
  }

  .meta-line {
    display: inline-flex;
    align-items: baseline;
    gap: 8px;
  }

  .id-rest {
    color: var(--surface2);
    font-weight: 400;
  }

  .div-offset {
    color: var(--red);
    font-weight: 700;
  }

  .elided-marker {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    flex: 1;
    min-width: 0;
    overflow: hidden;
  }

  .elided-label {
    color: var(--surface2);
    font-size: 10px;
    letter-spacing: 0.04em;
    flex-shrink: 0;
  }

  .elided-dots {
    flex: 1;
    min-width: 8px;
    max-width: 60px;
    height: 0;
    border-top: 1px dashed var(--surface1);
  }

  .commit-id {
    font-family: var(--font-mono);
    font-size: 10px;
    color: var(--overlay0);
    letter-spacing: 0.02em;
  }

  .bookmark-badge {
    display: inline-flex;
    align-items: center;
    background: var(--bg-bookmark);
    color: var(--subtext0);
    padding: 0 5px;
    border-radius: 3px;
    font-size: 10px;
    font-weight: 600;
    border: 1px solid var(--border-bookmark);
    line-height: 1.15;
    letter-spacing: 0.02em;
    vertical-align: baseline;
    cursor: pointer;
    font-family: inherit;
    transition: border-color var(--anim-duration) var(--anim-ease);
  }

  .bookmark-badge:hover {
    border-color: var(--surface2);
  }

  .pr-badge {
    display: inline-flex;
    align-items: center;
    gap: 3px;
    background: var(--bg-pr);
    color: var(--subtext0);
    padding: 0 5px;
    border-radius: 3px;
    font-size: 10px;
    font-weight: 600;
    border: 1px solid var(--border-pr);
    line-height: 1.15;
    letter-spacing: 0.02em;
    vertical-align: baseline;
    cursor: pointer;
    font-family: inherit;
    text-decoration: none;
    transition: border-color var(--anim-duration) var(--anim-ease);
  }

  .pr-badge:hover {
    border-color: var(--border-pr-hover);
  }

  .pr-badge.is-draft {
    border-style: dashed;
    opacity: 0.75;
  }

  .pr-name {
    color: var(--subtext0);
  }

  .pr-number {
    color: var(--overlay0);
    font-weight: 400;
  }

  .workspace-badge {
    display: inline-flex;
    align-items: center;
    background: var(--badge-workspace-bg);
    color: var(--subtext0);
    padding: 0 5px;
    border-radius: 3px;
    font-size: 10px;
    font-weight: 600;
    border: 1px solid var(--border-workspace);
    line-height: 1.15;
    letter-spacing: 0.02em;
    vertical-align: baseline;
  }

  .rebase-badge {
    font-size: 10px;
    font-weight: 700;
    padding: 0 4px;
    border-radius: 3px;
    flex-shrink: 0;
    line-height: 1.15;
    vertical-align: baseline;
    animation: badge-in var(--anim-duration) var(--anim-ease);
  }

  .rebase-source,
  .rebase-target,
  .split-source {
    background: var(--badge-other-bg);
    color: var(--amber);
    border: 1px solid var(--amber);
  }

  .divergent-badge {
    font-size: 10px;
    font-weight: 700;
    padding: 0 4px;
    border-radius: 3px;
    flex-shrink: 0;
    line-height: 1.15;
    vertical-align: baseline;
    background: var(--badge-danger-bg, rgba(235, 100, 100, 0.15));
    color: var(--red);
    border: 1px solid var(--red);
  }

  .rebase-preview {
    color: var(--overlay0);
    font-size: 12px;
    font-style: italic;
  }

  .description-text {
    color: var(--text);
    font-size: 12px;
  }

  .wc .description-text {
    color: var(--wc-desc-color);
  }

  /* --- Empty states --- */
  .empty-state {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 8px;
    padding: 48px 24px;
    color: var(--surface2);
    font-size: 13px;
  }

  .spinner {
    width: 20px;
    height: 20px;
    border: 2px solid var(--surface0);
    border-top-color: var(--amber);
    border-radius: 50%;
    animation: spin 0.8s linear infinite;
  }

  @keyframes spin {
    to { transform: rotate(360deg); }
  }

  /* --- Scrollbar --- */
  .panel-content::-webkit-scrollbar {
    width: 8px;
  }

  .panel-content::-webkit-scrollbar-track {
    background: transparent;
  }

  .panel-content::-webkit-scrollbar-thumb {
    background: var(--surface0);
    border-radius: 4px;
  }

  .panel-content::-webkit-scrollbar-thumb:hover {
    background: var(--surface1);
  }
</style>
