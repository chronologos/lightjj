<script lang="ts">
  import { SvelteSet } from 'svelte/reactivity'
  import { createWindower } from './virtual.svelte'
  import { effectiveId, type LogEntry, type PullRequest, type RemoteRef, type RemoteVisibility } from './api'
  import { targetModeLabel, type RebaseMode, type SquashMode, type SplitMode } from './modes.svelte'
  import { relativeTime } from './time-format'
  import GraphSvg from './GraphSvg.svelte'

  // All graph rows are height:18px (enforced below for graph pipe continuity —
  // see CLAUDE.md). Fixed-size virtualization is the simplest case: no dynamic
  // measurement, no ResizeObserver on items.
  const ROW_HEIGHT = 18
  // Virtualize only above this many lines (~50 commits depending on bookmarks/
  // connectors). Below threshold, render eagerly — overhead is noise and jsdom
  // tests (clientHeight=0) render nothing under virtualization.
  const VIRTUALIZE_THRESHOLD = 150

  interface Props {
    revisions: LogEntry[]
    selectedIndex: number
    checkedRevisions: SvelteSet<string>
    loading: boolean
    mutating: boolean
    viewLabel: string | null
    lastCheckedIndex: number
    onselect: (index: number) => void
    ontogglecheck: (changeId: string, index: number) => void
    onrangecheck: (from: number, to: number) => void
    oncontextmenu: (changeId: string, x: number, y: number) => void
    onresolvedivergence: (changeId: string) => void
    onnewfromchecked: () => void
    onabandonchecked: () => void
    onclearchecks: () => void
    onbookmarkclick: (name: string) => void
    rebase: RebaseMode
    squash: SquashMode
    split: SplitMode
    isDark: boolean
    prByBookmark: Map<string, PullRequest>
    impliedCommitIds: Set<string>
    remoteVisibility: RemoteVisibility
  }

  let {
    revisions, selectedIndex, checkedRevisions, loading, mutating, viewLabel, lastCheckedIndex,
    onselect, ontogglecheck, onrangecheck, oncontextmenu, onresolvedivergence,
    onnewfromchecked, onabandonchecked, onclearchecks,
    onbookmarkclick,
    rebase, squash, split,
    isDark, prByBookmark, impliedCommitIds, remoteVisibility,
  }: Props = $props()

  let anyModeActive = $derived(rebase.active || squash.active || split.active)

  // Stale-while-revalidate: when we already have revisions, don't blank the
  // list during reloads — dim it and show a thin progress bar instead.
  // Covers both post-mutation reloads (mutating=true) and the log fetch
  // itself (loading=true). Initial load (no data) still shows the spinner.
  let isRefreshing = $derived((loading || mutating) && revisions.length > 0)

  // The scroll container — .panel-content has overflow-y:auto. Virtualizer
  // needs this (not .revision-list, which is the scrolled content). Also
  // serves querySelector('.graph-row.selected') — it's an ancestor of listEl.
  let scrollEl: HTMLDivElement | undefined = $state(undefined)


  interface FlatLine {
    gutter: string
    content?: string // text content for connector lines (e.g., "(elided revisions)")
    entryIndex: number
    eid: string     // effectiveId(commit) — precomputed; the snippet would
                    // otherwise re-call effectiveId() 4× per rendered row
    lineKey: string // semantic key ('node', 'bm', 'desc', 'g0', ...)
    isNode: boolean
    isBookmarkLine: boolean
    isDescLine: boolean
    isWorkingCopy: boolean
    isHidden: boolean
    isImmutable?: boolean
    isDivergent?: boolean
    nodeLane?: number // graph lane of this entry's node (for bookmark color hints)
  }

  const sourceModeLabel: Record<string, string> = { '-r': 'move', '-s': 'source', '-b': 'branch' }

  // Build a continuation gutter: replace node symbols with │, keep pipes and spaces
  const nodeChars = new Set(['@', '○', '◆', '×', '◌'])
  const GRAPH_COLORS = 8

  /** Find the lane of the node character in a gutter string. */
  function findNodeLane(gutter: string): number {
    let col = 0
    for (const ch of gutter) {
      if (nodeChars.has(ch)) return Math.floor(col / 2)
      col++
    }
    return 0
  }
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

  // Parser already splits remote bookmarks into {name, remote} and filters
  // the @git colocation synthetic — all we do here is check visibility config.
  function isRemoteVisible(ref: RemoteRef, vis: RemoteVisibility): boolean {
    const entry = vis[ref.remote]
    if (!entry?.visible) return false
    if (entry.hidden?.includes(ref.name)) return false
    return true
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


  function padGutter(gutter: string): string {
    return gutter.length > maxGutterLen
      ? gutter.slice(0, maxGutterLen)
      : gutter.padEnd(maxGutterLen)
  }

  // Compute divergence offsets: for divergent commits sharing a change_id,
  // assign /0, /1, ... in jj's emission order (GlobalCommitPosition — NOT
  // commit_id sort; see divergence.go:65-68). `revisions` is already in that
  // order, so encounter order during iteration is correct.
  let divergenceOffsets = $derived.by(() => {
    const map = new Map<string, string>() // commit_id → "/N"
    const groups = new Map<string, string[]>() // change_id → [commit_id, ...]
    for (const entry of revisions) {
      if (!entry.commit.divergent) continue
      const cid = entry.commit.change_id
      if (!groups.has(cid)) groups.set(cid, [])
      groups.get(cid)!.push(entry.commit.commit_id)
    }
    for (const commitIds of groups.values()) {
      for (let i = 0; i < commitIds.length; i++) {
        map.set(commitIds[i], `/${i}`)
      }
    }
    return map
  })

  let flatLines = $derived.by(() => {
    const lines: FlatLine[] = []
    revisions.forEach((entry, i) => {
      const eid = effectiveId(entry.commit)
      // Semantic keys ('node', 'bm', 'desc', 'g0', ...) — adding/removing a
      // bookmark line doesn't shift sibling keys → stable {#each} reconciliation.
      let graphIdx = 0
      entry.graph_lines.forEach((gl, j) => {
        const isNode = gl.is_node ?? (j === 0)
        lines.push({
          gutter: padGutter(gl.gutter),
          content: gl.content || undefined,
          entryIndex: i, eid,
          lineKey: isNode ? 'node' : `g${graphIdx++}`,
          isNode,
          isBookmarkLine: false,
          isDescLine: false,
          isWorkingCopy: entry.commit.is_working_copy,
          isHidden: entry.commit.hidden,
          isImmutable: entry.commit.immutable,
          isDivergent: isNode && entry.commit.divergent,
        })
        if (isNode) {
          const contGutter = padGutter(continuationGutter(gl.gutter))
          const localBms = entry.bookmarks ?? []
          const visibleRemoteBms = (entry.remote_bookmarks ?? []).filter(r => isRemoteVisible(r, remoteVisibility))
          const hasLabels = (localBms.length + visibleRemoteBms.length + (entry.commit.working_copies?.length ?? 0)) > 0
          if (hasLabels) {
            lines.push({
              gutter: contGutter,
              entryIndex: i, eid, lineKey: 'bm',
              isNode: false,
              isBookmarkLine: true,
              isDescLine: false,
              isWorkingCopy: entry.commit.is_working_copy,
              isHidden: entry.commit.hidden,
              nodeLane: findNodeLane(gl.gutter),
            })
          }
          lines.push({
            gutter: contGutter,
            entryIndex: i, eid, lineKey: 'desc',
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

  let shouldVirtualize = $derived(flatLines.length > VIRTUALIZE_THRESHOLD)

  // Windower is always created (observers are cheap) but only USED above
  // threshold. count and scrollEl passed as getters → reactive without
  // $effect glue. No untrack dance needed — createWindower uses runes
  // directly, not a self-notifying Svelte-4 store.
  const windower = createWindower({
    count: () => flatLines.length,
    scrollEl: () => scrollEl,
    rowHeight: ROW_HEIGHT,
    // Generous overscan — j/k navigation is the hot path, rendering a few
    // extra rows is cheaper than mount/unmount churn on every keypress.
    overscan: 10,
  })

  // Hover is tracked in JS, not via CSS :hover. The :hover pseudo-class
  // recomputes on every paint — layout shifts (error bar mount/unmount,
  // batch-actions bar toggle, scrollIntoView, post-rebase DOM reshuffle)
  // slide :hover onto whatever row is NOW under a stationary mouse. A
  // suppress-flag approach is whack-a-mole: every layout-affecting state
  // must be tracked, including parent state that isn't even a prop.
  //
  // mousemove fires ONLY on physical pointer movement (UI Events spec) —
  // never on layout shift. Hover state built on it cannot go stale. During
  // j/k + scrollIntoView, hoveredIndex stays at the row the mouse last
  // touched; if that row scrolls off-screen the highlight is simply
  // invisible. No phantom.
  //
  // Side benefit: entryIndex is per-revision, so hovering ANY row
  // (including connectors) highlights the whole revision group. This
  // replaces 8 sibling-chain :has() rules with one class selector.
  let hoveredIndex = $state(-1)
  function onListMouseMove(e: MouseEvent) {
    const row = (e.target as HTMLElement).closest<HTMLElement>('.graph-row')
    const idx = row ? Number(row.dataset.entry) : -1
    if (idx !== hoveredIndex) hoveredIndex = idx
  }
  function onListMouseLeave() {
    hoveredIndex = -1
  }

  // Scroll the selected node row into view. Deps: selectedIndex + flatLines
  // (via shouldVirtualize and the findIndex scan) — the latter means post-
  // loadLog reflow also scrolls-to-selection, which is intentional.
  // Virtualized path uses scrollToIndex (selected row may not be in DOM);
  // eager path queries DOM.
  $effect(() => {
    if (selectedIndex < 0) return
    if (shouldVirtualize) {
      // Selection is by entryIndex; windower scrolls by flatLines index.
      // findIndex is O(n) but n~1500 max = <2μs; cheaper than a $derived Map
      // built unconditionally (including below threshold where it's unused).
      const idx = flatLines.findIndex(l => l.isNode && l.entryIndex === selectedIndex)
      if (idx >= 0) windower.scrollToIndex(idx)
    } else {
      scrollEl?.querySelector('.graph-row.node-row.selected')?.scrollIntoView({ block: 'nearest' })
    }
  })
</script>

<div class="panel revisions-panel">
  <div class="panel-header">
    <span class="panel-title">Revisions <kbd class="nav-hint">j</kbd><kbd class="nav-hint">k</kbd></span>
    <div class="view-toggle">
      {#if viewLabel}
        <span class="view-btn view-btn-active">{viewLabel}</span>
      {/if}
    </div>
    {#if revisions.length > 0}
      <span class="panel-badge">{revisions.length}{#if checkedRevisions.size > 0} ({checkedRevisions.size} checked){/if}</span>
    {/if}
  </div>
  {#if checkedRevisions.size > 0 && !anyModeActive}
    <div class="batch-actions-bar">
      <span class="batch-label">{checkedRevisions.size} checked</span>
      <button class="action-btn" onclick={onnewfromchecked} disabled={mutating} title="New from checked (n)">new</button>
      <button class="action-btn danger" onclick={onabandonchecked} disabled={mutating} title="Abandon checked">abandon</button>
      <button class="action-btn" onclick={onclearchecks} title="Clear checks (Escape)">clear</button>
    </div>
  {/if}
  <!-- Always mounted (height reserved) to avoid 2px layout shift on refresh start/end -->
  <div class="refresh-bar" class:active={isRefreshing} aria-hidden="true"></div>
  <div class="panel-content" bind:this={scrollEl}>
    {#if loading && revisions.length === 0}
      <!-- Spinner only on INITIAL load. Refreshes keep showing stale content
           (dimmed + progress bar) so SSH-latency reloads don't blank the UI. -->
      <div class="empty-state">
        <div class="spinner"></div>
        <span>Loading revisions...</span>
      </div>
    {:else if revisions.length === 0}
      <div class="empty-state">No revisions found</div>
    {:else}
      <!-- Row snippet — shared by virtual and eager render paths below. -->
      {#snippet graphRow(line: FlatLine)}
        {@const isChecked = checkedRevisions.has(line.eid)}
        {@const isImplied = !isChecked && impliedCommitIds.has(revisions[line.entryIndex]?.commit.commit_id)}
        <!-- svelte-ignore a11y_click_events_have_key_events -->
        <div
          class="graph-row"
          data-entry={line.entryIndex}
          class:node-row={line.isNode}
          class:bookmark-row={line.isBookmarkLine}
          class:desc-row={line.isDescLine}
          class:selected={selectedIndex === line.entryIndex}
          class:hovered={hoveredIndex === line.entryIndex}
          class:checked={isChecked}
          class:implied={isImplied}
          class:wc={line.isWorkingCopy}
          class:hidden-rev={line.isHidden}
          class:immutable={line.isImmutable}
          onclick={(e: MouseEvent) => {
            const modifier = e.metaKey || e.ctrlKey || e.shiftKey
            if (!line.isNode || !modifier || anyModeActive || isRefreshing) {
              onselect(line.entryIndex)
              return
            }
            e.preventDefault()
            if (e.metaKey || e.ctrlKey) {
              ontogglecheck(line.eid, line.entryIndex)
            } else {
              // Shift: anchor from last check, else cursor (click A → shift-click B = range A..B).
              const anchor = lastCheckedIndex >= 0 ? lastCheckedIndex : selectedIndex
              if (anchor >= 0) onrangecheck(anchor, line.entryIndex)
              else ontogglecheck(line.eid, line.entryIndex)
            }
          }}
          oncontextmenu={(e: MouseEvent) => {
            e.preventDefault()
            if (anyModeActive || isRefreshing) return
            oncontextmenu(line.eid, e.clientX, e.clientY)
          }}
          role="option"
          tabindex={line.isNode ? 0 : -1}
          aria-selected={selectedIndex === line.entryIndex}
        >
          <span class="check-gutter" class:implied={isImplied} title={isImplied ? 'Included via gap-fill (connected)' : ''}>{#if line.isNode && isChecked}✓{:else if line.isNode && isImplied}◌{/if}</span>
          <GraphSvg
            gutter={line.gutter}
            isDivergent={line.isDivergent ?? false}
            gutterWidth={maxGutterLen}
            {isDark}
          />
          {#if line.isNode}
            {@const entry = revisions[line.entryIndex]}
            {@const isRebaseSource = rebase.active && rebase.sources.includes(line.eid)}
            {@const isRebaseTarget = rebase.active && selectedIndex === line.entryIndex && !isRebaseSource}
            {@const isSquashSource = squash.active && squash.sources.includes(line.eid)}
            {@const isSquashTarget = squash.active && selectedIndex === line.entryIndex && !isSquashSource}
            {@const isSplitSource = split.active && line.eid === split.revision}
            {#if isRebaseSource}
              <span class="mode-badge badge-source">&lt;&lt; {sourceModeLabel[rebase.sourceMode]} &gt;&gt;</span>
            {/if}
            {#if isRebaseTarget}
              <span class="mode-badge badge-target">&lt;&lt; {targetModeLabel[rebase.targetMode]} &gt;&gt;</span>
            {/if}
            {#if isSquashSource}
              <span class="mode-badge badge-source">&lt;&lt; from &gt;&gt;</span>
            {/if}
            {#if isSquashTarget}
              <span class="mode-badge badge-target">&lt;&lt; into &gt;&gt;</span>
            {/if}
            {#if isSplitSource}
              <span class="mode-badge badge-source">&lt;&lt; {split.review ? 'review' : 'split'} &gt;&gt;</span>
            {/if}
            {#if entry.commit.divergent}
              <button class="alert-badge alert-badge-click" title="Resolve divergence"
                onclick={(e) => { e.stopPropagation(); onresolvedivergence(entry.commit.change_id) }}
              >divergent</button>
            {/if}
            {#if entry.commit.conflicted}
              <span class="alert-badge">conflict</span>
            {/if}
            <span class="node-line-content">
              {#if entry.commit.is_working_copy}
                <span class="wc-badge">@</span>
              {/if}
              {#if entry.commit.empty}
                <span class="desc-placeholder">(empty)</span>
              {/if}
              {#if entry.description}
                <span class="description-text">{entry.description}</span>
              {:else if !entry.commit.empty}
                <span class="desc-placeholder">(no description)</span>
              {/if}
            </span>
          {:else if line.isBookmarkLine}
            {@const entry = revisions[line.entryIndex]}
            {@const laneColorVar = line.nodeLane != null ? `var(--graph-${line.nodeLane % GRAPH_COLORS})` : ''}
            {@const localBookmarks = entry.bookmarks ?? []}
            <!-- Suppress origin/foo when local foo is on THIS same commit (synced → redundant).
                 Conflicted locals are excluded from the suppress-set: the remote badge
                 disambiguates which side the remote agrees with. hasLabels at line ~188
                 over-counts by the suppressed entries but the bool outcome is unchanged
                 (suppression only happens when localBookmarks.length > 0 anyway). -->
            {@const syncedLocal = new Set(localBookmarks.filter(b => !b.conflict).map(b => b.name))}
            {@const visibleRemoteBookmarks = (entry.remote_bookmarks ?? []).filter(r => isRemoteVisible(r, remoteVisibility) && !syncedLocal.has(r.name))}
            <span class="bookmark-line-content">
              {#each entry.commit.working_copies ?? [] as ws}
                <span class="workspace-badge">◇ {ws}@</span>
              {/each}
              {#each localBookmarks as bm}
                {@const pr = prByBookmark.get(bm.name)}
                {@const tinted = !!laneColorVar && !bm.conflict}
                {#if pr}
                  <a class="pr-badge" class:is-draft={pr.is_draft} class:conflicted={bm.conflict}
                     href={pr.url} target="_blank" rel="noopener"
                     onclick={(e: MouseEvent) => e.stopPropagation()}
                     title="{pr.is_draft ? 'Draft ' : ''}PR #{pr.number} — click to open on GitHub"
                     style={tinted ? `--lane-color: ${laneColorVar}` : ''} class:lane-tinted={tinted}>
                    <span class="pr-name">↗ {bm.name}{#if bm.conflict}<span class="conflict-marker">??</span>{/if}</span>
                    <span class="pr-number">#{pr.number}</span>
                  </a>
                {:else}
                  <button class="bookmark-badge" class:conflicted={bm.conflict}
                     onclick={(e: MouseEvent) => { e.stopPropagation(); onbookmarkclick(bm.name) }}
                     style={tinted ? `--lane-color: ${laneColorVar}` : ''} class:lane-tinted={tinted}
                     title={bm.conflict ? 'Conflicted — this bookmark points at multiple commits' : undefined}>⑂ {bm.name}{#if bm.conflict}<span class="conflict-marker">??</span>{/if}</button>
                {/if}
              {/each}
              {#each visibleRemoteBookmarks as ref}
                <span class="remote-bookmark-badge">{ref.remote}/{ref.name}</span>
              {/each}
            </span>
          {:else if line.isDescLine}
            {@const entry = revisions[line.entryIndex]}
            {@const isRebaseTarget = rebase.active && selectedIndex === line.entryIndex && !rebase.sources.includes(line.eid)}
            {@const isSquashTarget = squash.active && selectedIndex === line.entryIndex && !squash.sources.includes(line.eid)}
            {@const isSplitPreview = split.active && line.eid === split.revision}
            <span class="desc-line-content">
              {#if isSplitPreview}
                <span class="rebase-preview">jj split -r {entry.commit.change_id.slice(0, 8)}{split.parallel ? ' --parallel' : ''}</span>
              {:else if isRebaseTarget}
                <span class="rebase-preview">rebase {rebase.sourceMode} {rebase.sources.map(s => s.slice(0, 8)).join(' ')} {rebase.targetMode} {entry.commit.change_id.slice(0, 8)}</span>
              {:else if isSquashTarget}
                <span class="rebase-preview">jj squash --from {squash.sources.map(s => s.slice(0, 8)).join(' --from ')} --into {entry.commit.change_id.slice(0, 8)}{squash.keepEmptied ? ' --keep-emptied' : ''}</span>
              {:else}
                {@const divOffset = divergenceOffsets.get(entry.commit.commit_id)}
                <span class="meta-line">
                  <span class="change-id">{entry.commit.change_id.slice(0, entry.commit.change_prefix)}<span class="id-rest">{entry.commit.change_id.slice(entry.commit.change_prefix, 12)}</span>{#if divOffset}<span class="div-offset">{divOffset}</span>{/if}</span>
                  <span class="commit-id">{entry.commit.commit_id.slice(0, entry.commit.commit_prefix)}<span class="id-rest">{entry.commit.commit_id.slice(entry.commit.commit_prefix, 12)}</span></span>
                  {#if !entry.commit.mine && entry.commit.author_email}
                    <span class="author-chip" title={entry.commit.author_email}>{entry.commit.author_email.split('@')[0]}</span>
                  {/if}
                  {#if entry.commit.timestamp}
                    {@const age = relativeTime(entry.commit.timestamp)}
                    {#if age}<span class="timestamp-chip" title={entry.commit.timestamp}>{age}</span>{/if}
                  {/if}
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
      {/snippet}

      <!-- svelte-ignore a11y_no_static_element_interactions -->
      <div
        class="revision-list"
        class:refreshing={isRefreshing}
        class:virtual-list={shouldVirtualize}
        style={shouldVirtualize ? `height:${windower.totalHeight}px` : undefined}
        onmousemove={onListMouseMove}
        onmouseleave={onListMouseLeave}
        role="listbox"
        tabindex="-1"
        aria-label="Revision list"
      >
        {#if shouldVirtualize}
          {#each windower.items as item (`${flatLines[item.index].eid}:${flatLines[item.index].lineKey}`)}
            <div class="virtual-row" style="transform:translateY({item.start}px)">
              {@render graphRow(flatLines[item.index])}
            </div>
          {/each}
        {:else}
          {#each flatLines as line (`${line.eid}:${line.lineKey}`)}
            {@render graphRow(line)}
          {/each}
        {/if}
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

  .action-btn {
    padding: 2px 10px;
    background: transparent;
    border: 1px solid var(--surface1);
    border-radius: 4px;
    color: var(--subtext0);
    font-family: inherit;
    font-size: 11px;
    cursor: pointer;
    line-height: 1.4;
  }

  .action-btn:hover:not(:disabled) {
    background: var(--bg-hover);
    color: var(--text);
    border-color: var(--surface2);
  }

  .action-btn.danger:hover:not(:disabled) {
    color: var(--red);
    border-color: rgba(from var(--red) r g b / 0.4);
  }

  .action-btn:disabled {
    opacity: 0.35;
    cursor: default;
  }

  /* --- Refresh indicator (stale-while-revalidate) --- */
  /* Always mounted at 2px to avoid layout shift. .active triggers animation. */
  .refresh-bar {
    height: 2px;
    flex-shrink: 0;
    overflow: hidden;
    position: relative;
    background: transparent;
  }

  .refresh-bar.active {
    background: var(--surface0);
  }

  .refresh-bar.active::after {
    content: '';
    position: absolute;
    inset: 0;
    background: var(--amber);
    transform-origin: left;
    animation: refresh-indeterminate 1.2s ease-in-out infinite;
  }

  @keyframes refresh-indeterminate {
    0%   { transform: translateX(-60%) scaleX(0.4); }
    50%  { transform: translateX(  0%) scaleX(0.6); }
    100% { transform: translateX(100%) scaleX(0.4); }
  }

  .revision-list.refreshing {
    opacity: 0.55;
  }

  /* --- Panel structure --- */
  .panel {
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }

  .revisions-panel {
    width: 100%;
    border-right: 1px solid var(--surface1);
    flex: 1;
    min-height: 0;
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
    /* Transition on base class so fade-OUT also animates (when .refreshing removed) */
    transition: opacity 0.15s ease;
  }

  .revision-list ::selection {
    background: transparent;
  }

  /* Virtualized layout: container height = totalSize; each row absolutely
     positioned via translateY(item.start). .graph-row CSS stays unchanged
     (position:relative is fine inside an absolute parent). */
  .virtual-list {
    position: relative;
  }
  .virtual-row {
    position: absolute;
    top: 0;
    left: 0;
    width: 100%;
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
    transition: box-shadow 50ms var(--anim-ease);
  }

  /* .hovered is JS-managed (hoveredIndex state, mousemove-driven) — see
     comment in script. All rows of a revision share entryIndex, so one
     class selector replaces the 8 sibling-chain :has() rules that :hover
     required. Source order: this comes BEFORE .selected/.checked/.implied
     so those backgrounds win on overlap. */
  .graph-row.hovered:not(.selected) {
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

  .graph-row.implied {
    /* Fainter than checked — "included but not explicitly selected" */
    background: rgba(from var(--green) r g b / 0.04);
  }

  .graph-row.implied.selected {
    /* Selected + implied: amber indicator wins, green tint stays faint */
    background: rgba(from var(--green) r g b / 0.06);
    box-shadow: inset 2px 0 0 var(--amber);
  }

  .check-gutter.implied {
    color: var(--overlay0);
    cursor: help;
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
    font-size: 10px;
    font-weight: 400;
    padding-left: 2px;
    opacity: 0.85;
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
    transition: border-color var(--anim-duration) var(--anim-ease),
                color var(--anim-duration) var(--anim-ease);
  }

  .bookmark-badge:hover {
    border-color: var(--surface2);
  }

  .bookmark-badge.lane-tinted {
    border-color: color-mix(in srgb, var(--lane-color) 50%, transparent);
    color: var(--lane-color);
  }

  .bookmark-badge.lane-tinted:hover {
    border-color: color-mix(in srgb, var(--lane-color) 75%, transparent);
  }

  .remote-bookmark-badge {
    display: inline-flex;
    align-items: center;
    padding: 0 4px;
    border-radius: 3px;
    font-size: 9px;
    font-weight: 500;
    color: var(--overlay0);
    border: 1px solid var(--surface0);
    line-height: 1.15;
    letter-spacing: 0.02em;
    background: transparent;
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

  .pr-badge.lane-tinted {
    border-color: color-mix(in srgb, var(--lane-color) 50%, transparent);
  }

  .pr-badge.lane-tinted .pr-name {
    color: var(--lane-color);
  }

  .pr-badge.lane-tinted:hover {
    border-color: color-mix(in srgb, var(--lane-color) 75%, transparent);
  }

  .pr-badge.is-draft {
    border-style: dashed;
    opacity: 0.75;
  }

  .bookmark-badge.conflicted,
  .pr-badge.conflicted {
    border-color: color-mix(in srgb, var(--red) 40%, transparent);
  }

  .conflict-marker {
    color: var(--red);
    font-weight: 600;
    margin-left: 1px;
  }

  .pr-name {
    color: var(--subtext0);
  }

  .pr-number {
    color: var(--overlay0);
    font-weight: 400;
  }

  .author-chip {
    display: inline-flex;
    align-items: center;
    background: var(--surface0);
    color: var(--subtext0);
    padding: 0 5px;
    border-radius: 3px;
    font-size: 10px;
    line-height: 1.15;
  }

  .timestamp-chip {
    color: var(--overlay0);
    font-size: 10px;
    line-height: 1.15;
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

  .mode-badge {
    font-size: 10px;
    font-weight: 700;
    padding: 0 4px;
    border-radius: 3px;
    flex-shrink: 0;
    line-height: 1.15;
    vertical-align: baseline;
    animation: badge-in var(--anim-duration) var(--anim-ease);
  }

  .badge-source,
  .badge-target {
    background: var(--badge-other-bg);
    color: var(--amber);
    border: 1px solid var(--amber);
  }

  /* Shared red-alert treatment for divergent + conflict — both are "this commit
   * needs attention" states that block clean shipping. The ×-glyph in GraphSvg
   * is the gutter indicator for conflict; this badge makes it scannable. */
  .alert-badge {
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
  .alert-badge-click {
    font-family: inherit;
    cursor: pointer;
    margin: 0;
  }
  .alert-badge-click:hover {
    background: var(--red);
    color: var(--base);
  }

  /* Shared treatment for "(empty)" and "(no description)" — both annotate absence.
   * No italic: the --font-ui stack's synthesized oblique reads heavier at 12px,
   * inverting the hierarchy (meta-text should recede, not advance). */
  .desc-placeholder {
    color: var(--overlay0);
    font-size: 12px;
  }
  .desc-placeholder + .description-text {
    margin-left: 6px;
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
