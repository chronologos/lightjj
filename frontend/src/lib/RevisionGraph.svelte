<script lang="ts">
  import { SvelteSet } from 'svelte/reactivity'
  import type { LogEntry } from './api'

  interface Props {
    revisions: LogEntry[]
    selectedIndex: number
    checkedRevisions: SvelteSet<string>
    loading: boolean
    revsetFilter: string
    lastCheckedIndex: number
    onselect: (index: number) => void
    oncheck: (changeId: string, index: number) => void
    onrangecheck: (from: number, to: number) => void
    onedit: (changeId: string) => void
    onnew: (changeId: string) => void
    onabandon: (changeId: string) => void
    onnewfromchecked: () => void
    onabandonchecked: () => void
    onclearchecks: () => void
    onrevsetsubmit: () => void
    onrevsetclear: () => void
    onrevsetchange: (value: string) => void
    onrevsetescaped: () => void
    onbookmarkclick: (name: string) => void
  }

  let {
    revisions, selectedIndex, checkedRevisions, loading, revsetFilter, lastCheckedIndex,
    onselect, oncheck, onrangecheck, onedit, onnew, onabandon,
    onnewfromchecked, onabandonchecked, onclearchecks,
    onrevsetsubmit, onrevsetclear, onrevsetchange, onrevsetescaped, onbookmarkclick,
  }: Props = $props()

  let revsetInputEl: HTMLInputElement | undefined = $state(undefined)

  interface FlatLine {
    gutter: string
    entryIndex: number
    lineSubIdx: number // index within this entry's lines (stable across list changes)
    isNode: boolean
    isBookmarkLine: boolean
    isDescLine: boolean
    isWorkingCopy: boolean
    isHidden: boolean
  }

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

  let flatLines = $derived.by(() => {
    const lines: FlatLine[] = []
    revisions.forEach((entry, i) => {
      let subIdx = 0
      entry.graph_lines.forEach((gl, j) => {
        const isNode = gl.is_node ?? (j === 0)
        lines.push({
          gutter: gl.gutter,
          entryIndex: i,
          lineSubIdx: subIdx++,
          isNode,
          isBookmarkLine: false,
          isDescLine: false,
          isWorkingCopy: entry.commit.is_working_copy,
          isHidden: entry.commit.hidden,
        })
        if (isNode) {
          const contGutter = continuationGutter(gl.gutter)
          if (entry.bookmarks?.length) {
            lines.push({
              gutter: contGutter,
              entryIndex: i,
              lineSubIdx: subIdx++,
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
            lineSubIdx: subIdx++,
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
  {#if checkedRevisions.size > 0}
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
      <div class="revision-list" bind:this={listEl} role="listbox" aria-label="Revision list">
        {#each flatLines as line, lineIdx (revisions[line.entryIndex].commit.change_id + ':' + line.lineSubIdx)}
          {@const isChecked = checkedRevisions.has(revisions[line.entryIndex]?.commit.change_id)}
          <div
            class="graph-row"
            class:node-row={line.isNode}
            class:bookmark-row={line.isBookmarkLine}
            class:desc-row={line.isDescLine}
            class:selected={selectedIndex === line.entryIndex}
            class:checked={isChecked}
            class:wc={line.isWorkingCopy}
            class:hidden-rev={line.isHidden}
            onclick={(e: MouseEvent) => {
              if (e.shiftKey && line.isNode && lastCheckedIndex >= 0) {
                e.preventDefault()
                onrangecheck(lastCheckedIndex, line.entryIndex)
              } else {
                onselect(line.entryIndex)
              }
            }}
            role="option"
            tabindex={line.isNode ? 0 : -1}
            aria-selected={selectedIndex === line.entryIndex}
          >
            <span class="check-gutter">{#if line.isNode && isChecked}✓{/if}</span>
            <span class="gutter" class:wc-gutter={line.isWorkingCopy}>{line.gutter}</span>
            {#if line.isNode}
              {@const entry = revisions[line.entryIndex]}
              <span class="node-line-content">
                <span class="change-id"><span class="id-prefix">{entry.commit.change_id.slice(0, entry.commit.change_prefix)}</span><span class="id-rest">{entry.commit.change_id.slice(entry.commit.change_prefix)}</span></span>
                <span class="commit-id"><span class="commit-id-prefix">{entry.commit.commit_id.slice(0, entry.commit.commit_prefix)}</span><span class="commit-id-rest">{entry.commit.commit_id.slice(entry.commit.commit_prefix)}</span></span>
              </span>
              <span class="rev-actions" role="group">
                <button class="action-btn" onclick={(e: MouseEvent) => { e.stopPropagation(); onedit(entry.commit.change_id) }} title="Edit">edit</button>
                <button class="action-btn" onclick={(e: MouseEvent) => { e.stopPropagation(); onnew(entry.commit.change_id) }} title="New (n)">new</button>
                <button class="action-btn danger" onclick={(e: MouseEvent) => { e.stopPropagation(); onabandon(entry.commit.change_id) }} title="Abandon">abandon</button>
              </span>
            {:else if line.isBookmarkLine}
              {@const entry = revisions[line.entryIndex]}
              <span class="bookmark-line-content">
                {#each entry.bookmarks ?? [] as bm}
                  <button class="bookmark-badge" onclick={(e: MouseEvent) => { e.stopPropagation(); onbookmarkclick(bm) }}>{bm}</button>
                {/each}
              </span>
            {:else if line.isDescLine}
              {@const entry = revisions[line.entryIndex]}
              <span class="desc-line-content">
                <span class="description-text">{entry.description || '(no description)'}</span>
              </span>
            {/if}
          </div>
        {/each}
      </div>
    {/if}
  </div>
</div>

<style>
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
    border: 1px solid var(--surface0);
    border-radius: 3px;
    padding: 3px 6px;
    font-family: inherit;
    font-size: 12px;
    outline: none;
    transition: border-color 0.15s ease;
  }

  .revset-input:focus {
    border-color: var(--blue);
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
    border-right: 1px solid var(--surface0);
    flex-shrink: 0;
  }

  .panel-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    height: 34px;
    padding: 0 12px;
    background: var(--base);
    border-bottom: 1px solid var(--surface0);
    flex-shrink: 0;
    user-select: none;
  }

  .panel-title {
    font-size: 11px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--subtext0);
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
    align-items: baseline;
    min-height: 0;
    line-height: 1.15;
    font-size: 13px;
    cursor: pointer;
    outline: none;
    -webkit-tap-highlight-color: transparent;
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

  .graph-row.selected {
    background: var(--bg-selected);
    box-shadow: inset 2px 0 0 var(--blue);
  }

  .graph-row.checked {
    background: var(--bg-checked);
  }

  .graph-row.checked.selected {
    background: var(--bg-checked-selected);
    box-shadow: inset 2px 0 0 var(--blue);
  }

  .graph-row.hidden-rev {
    opacity: 0.45;
  }

  .check-gutter {
    width: 14px;
    flex-shrink: 0;
    text-align: center;
    color: var(--green);
    font-size: 11px;
    padding-left: 4px;
  }

  .gutter {
    white-space: pre;
    font-size: 13px;
    line-height: 1.15;
    color: var(--surface2);
    flex-shrink: 0;
  }

  .gutter.wc-gutter {
    color: var(--green);
    font-weight: 800;
  }

  .node-line-content,
  .bookmark-line-content,
  .desc-line-content {
    display: inline-flex;
    align-items: baseline;
    overflow: hidden;
    min-width: 0;
    flex: 1;
  }

  .node-line-content {
    gap: 6px;
    white-space: nowrap;
  }

  .bookmark-line-content {
    gap: 4px;
  }

  .change-id {
    font-size: 13px;
    letter-spacing: 0.02em;
    flex-shrink: 0;
  }

  .id-prefix {
    color: var(--blue);
    font-weight: 700;
  }

  .id-rest {
    color: var(--surface2);
    font-weight: 400;
  }

  .wc .id-prefix {
    color: var(--green);
  }

  .commit-id {
    font-size: 10px;
    letter-spacing: 0.04em;
    flex-shrink: 0;
  }

  .commit-id-prefix {
    color: var(--overlay1);
    font-weight: 600;
  }

  .commit-id-rest {
    color: var(--surface1);
    font-weight: 400;
  }

  .bookmark-badge {
    display: inline-flex;
    align-items: center;
    background: var(--bg-bookmark);
    color: var(--green);
    padding: 0 5px;
    border-radius: 3px;
    font-size: 10px;
    font-weight: 600;
    border: 1px solid var(--border-bookmark);
    line-height: 1.15;
    letter-spacing: 0.02em;
    vertical-align: baseline;
  }

  .description-text {
    color: var(--text);
    font-size: 12px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    min-width: 0;
  }

  .wc .description-text {
    color: var(--wc-desc-color);
  }

  .rev-actions {
    display: inline-flex;
    align-items: center;
    gap: 2px;
    padding: 0 6px;
    opacity: 0;
    flex-shrink: 0;
  }

  .graph-row.node-row:hover .rev-actions,
  .graph-row.node-row:has(+ .graph-row.desc-row:hover) .rev-actions,
  .graph-row.node-row:has(+ .graph-row.bookmark-row:hover) .rev-actions,
  .graph-row.node-row:has(+ .graph-row.bookmark-row + .graph-row.desc-row:hover) .rev-actions,
  .graph-row.node-row.selected .rev-actions {
    opacity: 1;
  }

  .action-btn {
    background: var(--surface0);
    border: 1px solid var(--surface1);
    color: var(--subtext0);
    padding: 1px 5px;
    border-radius: 3px;
    cursor: pointer;
    font-family: inherit;
    font-size: 10px;
    white-space: nowrap;
    transition: all 0.15s ease;
    line-height: 1.15;
  }

  .action-btn:hover {
    background: var(--surface1);
    color: var(--text);
  }

  .action-btn.danger:hover {
    background: var(--bg-error);
    border-color: var(--red);
    color: var(--red);
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
    border-top-color: var(--blue);
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
