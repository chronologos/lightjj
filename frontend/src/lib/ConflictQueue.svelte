<script lang="ts">
  import type { ConflictEntry } from './api'

  interface QueueItem {
    commitId: string
    changeId: string
    path: string
    sides: number
  }

  interface Props {
    entries: ConflictEntry[]
    /** commitId:path keys marked as resolved in this session */
    resolved: Set<string>
    /** Called with the flat-index position when j/k or click moves selection. */
    onselect: (item: QueueItem) => void
    current?: QueueItem | null
  }

  let { entries, resolved, onselect, current = null }: Props = $props()

  // Flatten commit-grouped entries into a navigable list. Each file becomes one
  // queue item; commit headers are rendered separately (they're not navigable).
  let flat = $derived.by((): QueueItem[] =>
    entries.flatMap(e =>
      e.files.map(f => ({ commitId: e.commit_id, changeId: e.change_id, path: f.path, sides: f.sides })),
    ),
  )

  let resolvedCount = $derived(flat.filter(it => resolved.has(key(it))).length)

  // bug_009: O(1) group-header lookup instead of .find() per row in {#each}.
  let entryByCommit = $derived(new Map(entries.map(e => [e.commit_id, e])))

  let idx = $state(0)
  // bug_006/007: JS-tracked hover per CLAUDE.md — :hover recomputes on layout
  // shift; mousemove only on physical pointer movement.
  let hoveredIdx = $state(-1)
  let listEl: HTMLElement | undefined = $state()

  function scrollTo(i: number) {
    listEl?.querySelector(`[data-idx="${i}"]`)?.scrollIntoView({ block: 'nearest' })
  }

  // Keep idx synced with parent's current (for external jumps e.g. from DiffPanel).
  // bug_001: also clamp idx when entries shrink (external resolve shortens flat).
  $effect(() => {
    const len = flat.length
    if (idx >= len) idx = Math.max(0, len - 1)
    if (!current) return
    const i = flat.findIndex(it => it.commitId === current.commitId && it.path === current.path)
    if (i >= 0 && i !== idx) { idx = i; scrollTo(i) }
  })

  // Track whether this commit header is first (for the group separator).
  function isNewGroup(i: number): boolean {
    return i === 0 || flat[i].commitId !== flat[i - 1].commitId
  }

  function key(it: QueueItem): string {
    return `${it.commitId}:${it.path}`
  }

  function select(i: number) {
    if (i < 0 || i >= flat.length) return
    idx = i
    onselect(flat[i])
    // bug_008: scroll into view. Query by data-idx (static attr) not .cq-selected
    // — idx=$state write hasn't re-rendered yet when this runs synchronously.
    scrollTo(i)
  }

  /** Exported so App can delegate regardless of DOM focus (BookmarksPanel pattern).
   *  Returns true if the key was consumed (even at a bound — j at last item is
   *  still "consumed", it just doesn't move). */
  export function handleKeydown(e: KeyboardEvent): boolean {
    if (e.key === 'j' || e.key === 'ArrowDown') {
      if (idx + 1 < flat.length) select(idx + 1)
      return true
    }
    if (e.key === 'k' || e.key === 'ArrowUp') {
      if (idx > 0) select(idx - 1)
      return true
    }
    return false
  }

  // Auto-select first item on mount so MergePanel has something to show.
  $effect(() => {
    if (flat.length > 0 && !current) select(0)
  })
</script>

<div class="cq-root">
  <!-- svelte-ignore a11y_no_static_element_interactions a11y_mouse_events_have_key_events -->
  <div class="cq-list" bind:this={listEl}
    onmousemove={e => {
      const t = (e.target as Element).closest('[data-idx]')
      hoveredIdx = t ? Number(t.getAttribute('data-idx')) : -1
    }}
    onmouseleave={() => hoveredIdx = -1}
  >
    {#each flat as item, i (key(item))}
      {#if isNewGroup(i)}
        {@const entry = entryByCommit.get(item.commitId)!}
        <div class="cq-group">
          <code class="cq-change-id">{item.changeId.slice(0, 8)}</code>
          <span class="cq-desc">{entry.description || '(no description)'}</span>
        </div>
      {/if}
      <button
        class="cq-item"
        class:cq-selected={i === idx}
        class:cq-hovered={i === hoveredIdx}
        class:cq-resolved={resolved.has(key(item))}
        data-idx={i}
        onclick={() => select(i)}
      >
        <span class="cq-dot">{resolved.has(key(item)) ? '●' : '○'}</span>
        <span class="cq-path">{item.path}</span>
        {#if item.sides > 2}<span class="cq-nway">{item.sides}-way</span>{/if}
      </button>
    {/each}
    {#if flat.length === 0}
      <div class="cq-empty">No conflicts.</div>
    {/if}
  </div>
  {#if flat.length > 0}
    <div class="cq-footer">{resolvedCount}/{flat.length} resolved</div>
  {/if}
</div>

<style>
  .cq-root {
    display: flex;
    flex-direction: column;
    height: 100%;
    border-right: 1px solid var(--surface0);
    background: var(--mantle);
    min-width: 220px;
    max-width: 320px;
  }
  .cq-list {
    flex: 1;
    overflow-y: auto;
    user-select: none;
  }
  .cq-group {
    display: flex;
    align-items: baseline;
    gap: 6px;
    padding: 6px 10px 4px;
    font-size: 11px;
    border-top: 1px solid var(--surface0);
    color: var(--subtext0);
  }
  .cq-group:first-child { border-top: none; }
  .cq-change-id {
    font-family: var(--font-mono);
    color: var(--amber);
    font-size: 10px;
  }
  .cq-desc {
    flex: 1;
    min-width: 0;  /* bug_022: flex items default min-width:auto → can't shrink → no ellipsis */
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .cq-item {
    display: flex;
    align-items: center;
    gap: 6px;
    width: 100%;
    padding: 3px 10px 3px 18px;
    border: none;
    background: transparent;
    color: var(--text);
    font-family: inherit;
    font-size: 11px;
    text-align: left;
    cursor: pointer;
  }
  .cq-hovered { background: var(--surface0); }
  .cq-selected {
    background: color-mix(in srgb, var(--amber) 12%, transparent);
    border-left: 2px solid var(--amber);
    padding-left: 16px;
  }
  .cq-selected.cq-hovered {
    background: color-mix(in srgb, var(--amber) 18%, transparent);
  }
  .cq-dot { width: 10px; color: var(--subtext1); }
  .cq-resolved .cq-dot { color: var(--green); }
  .cq-resolved .cq-path { color: var(--subtext0); }
  .cq-path {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-family: var(--font-mono);
  }
  .cq-nway {
    font-size: 9px;
    padding: 1px 4px;
    border-radius: 3px;
    background: color-mix(in srgb, var(--red) 18%, transparent);
    color: var(--red);
  }
  .cq-empty {
    padding: 20px;
    text-align: center;
    color: var(--subtext0);
    font-size: 11px;
  }
  .cq-footer {
    padding: 6px 10px;
    border-top: 1px solid var(--surface0);
    font-size: 10px;
    font-family: var(--font-mono);
    color: var(--subtext0);
    text-align: center;
  }
</style>
