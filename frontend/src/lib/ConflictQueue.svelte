<script lang="ts">
  import type { ConflictEntry } from './api'
  import type { ContextMenuItem, ContextMenuHandler } from './ContextMenu.svelte'
  import { createListCursor } from './list-cursor.svelte'

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
    loading?: boolean
    oncontextmenu?: ContextMenuHandler
    /** Open-in-$EDITOR callback. Undefined = editor not configured (item disabled). */
    onopenfile?: (path: string) => void
  }

  let { entries, resolved, onselect, current = null, loading = false, oncontextmenu, onopenfile }: Props = $props()

  // Flatten commit-grouped entries into a navigable list. Each file becomes one
  // queue item; commit headers are rendered separately (they're not navigable).
  // entries arrive in jj-log order (heads first); reverse so the EARLIEST commit
  // is first — that's where conflicts originate, and resolving there propagates
  // to descendants (jj's own "resolve at earliest" guidance). select(0) on mount
  // then lands on a propagation root, not a downstream copy.
  let flat = $derived.by((): QueueItem[] =>
    entries.slice().reverse().flatMap(e =>
      e.files.map(f => ({ commitId: e.commit_id, changeId: e.change_id, path: f.path, sides: f.sides })),
    ),
  )

  // For each path, the first occurrence in flat (= earliest commit) is the
  // propagation root; later occurrences likely auto-resolve once the root is
  // fixed. HEURISTIC: assumes linear ancestry — for sibling branches both
  // conflicting on the same path, the hint points at an unrelated commit.
  // Tooltip says "may"; items stay navigable; non-destructive. Making it
  // sound needs parent_ids in ConflictEntry (backend change).
  let propagatedFrom = $derived.by(() => {
    const firstSeen = new Map<string, string>() // path → earliest changeId
    const result = new Map<string, string>() // key(item) → root changeId
    for (const it of flat) {
      const root = firstSeen.get(it.path)
      if (root === undefined) firstSeen.set(it.path, it.changeId)
      else result.set(key(it), root)
    }
    return result
  })

  let resolvedCount = $derived(flat.filter(it => resolved.has(key(it))).length)

  // bug_009: O(1) group-header lookup instead of .find() per row in {#each}.
  let entryByCommit = $derived(new Map(entries.map(e => [e.commit_id, e])))

  let listEl: HTMLElement | undefined = $state()

  // Cursor + JS-tracked hover (bug_006/007: :hover recomputes on layout shift;
  // mousemove only on physical pointer movement) + bounds clamp (bug_001:
  // external resolve shortens flat) + data-idx scroll (bug_008: a .cq-selected
  // class query after a $state write would find the OLD row) — all via the
  // shared factory. onMove notifies the parent on keyboard nav; select() below
  // notifies for mount auto-select and clicks (which must fire even when the
  // index doesn't change).
  const cursor = createListCursor({
    count: () => flat.length,
    container: () => listEl,
    onMove: (i) => onselect(flat[i]),
  })

  // Keep the cursor synced with parent's current (for external jumps e.g.
  // from DiffPanel).
  $effect(() => {
    if (!current) return
    const i = flat.findIndex(it => it.commitId === current.commitId && it.path === current.path)
    if (i >= 0 && i !== cursor.index) { cursor.index = i; cursor.scrollIntoView() }
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
    cursor.index = i
    // Always notify — mount auto-select fires onselect for index 0 even though
    // the cursor is already there (cursor.moveTo would skip the callback).
    onselect(flat[i])
    cursor.scrollIntoView()
  }

  /** Exported so App can delegate regardless of DOM focus (BookmarksPanel pattern).
   *  Returns true if the key was consumed (even at a bound — j at last item is
   *  still "consumed", it just doesn't move). */
  export function handleKeydown(e: KeyboardEvent): boolean {
    return cursor.handleKey(e)
  }

  // Auto-select first item so MergePanel has something to show. Gated on
  // !loading — stale-while-revalidate means flat can be populated with OLD
  // entries during re-fetch; selecting from those before fresh data arrives
  // would load a file that may not be in the new queue.
  $effect(() => {
    if (flat.length > 0 && !current && !loading) select(0)
  })

  function openContextMenu(e: MouseEvent, i: number) {
    if (!oncontextmenu) return
    e.preventDefault()
    // bug_017: DON'T call select() — it fires onselect → loadMergeFile →
    // {#key} remounts MergePanel → destroys unsaved edits. Right-click on a
    // different item should just show the menu; Copy/Open use flat[i].path
    // directly. Sync the cursor only so subsequent j/k continues from here.
    cursor.index = i
    const path = flat[i].path
    const items: ContextMenuItem[] = [
      { label: 'Copy file path', action: () => navigator.clipboard.writeText(path) },
      onopenfile
        ? { label: 'Open in editor', action: () => onopenfile(path) }
        : { label: 'Open in editor (not configured)', disabled: true },
    ]
    oncontextmenu(items, e.clientX, e.clientY)
  }
</script>

<div class="cq-root">
  <!-- svelte-ignore a11y_no_static_element_interactions a11y_mouse_events_have_key_events -->
  <div class="cq-list" bind:this={listEl}
    onmousemove={cursor.onRowsMouseMove}
    onmouseleave={cursor.onRowsMouseLeave}
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
        class:cq-selected={i === cursor.index}
        class:cq-hovered={i === cursor.hovered}
        class:cq-resolved={resolved.has(key(item))}
        data-idx={i}
        onclick={() => select(i)}
        oncontextmenu={e => openContextMenu(e, i)}
      >
        <span class="cq-dot">{resolved.has(key(item)) ? '●' : '○'}</span>
        <span class="cq-path" class:cq-propagated={propagatedFrom.has(key(item))}>{item.path}</span>
        {#if propagatedFrom.has(key(item))}
          <span class="cq-hint" title="Same file conflicts in {propagatedFrom.get(key(item))?.slice(0,8)} — resolving there may auto-resolve this">↑</span>
        {/if}
        {#if item.sides > 2}<span class="cq-nway">{item.sides}-way</span>{/if}
      </button>
    {/each}
    {#if flat.length === 0}
      <div class="cq-empty">{loading ? 'Loading conflicts…' : 'No conflicts.'}</div>
    {/if}
  </div>
  {#if flat.length > 0}
    <div class="cq-footer">
      {resolvedCount}/{flat.length} resolved
      {#if propagatedFrom.size > 0}<span class="cq-footer-hint"> · {propagatedFrom.size} propagated ↑</span>{/if}
    </div>
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
    font-size: var(--fs-sm);
    border-top: 1px solid var(--surface0);
    color: var(--subtext0);
  }
  .cq-group:first-child { border-top: none; }
  .cq-change-id {
    font-family: var(--font-mono);
    color: var(--amber);
    font-size: var(--fs-xs);
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
    font-size: var(--fs-sm);
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
  .cq-propagated { opacity: 0.55; }
  .cq-hint {
    font-size: var(--fs-2xs);
    color: var(--overlay0);
    cursor: help;
  }
  .cq-footer-hint { color: var(--overlay0); }
  .cq-nway {
    font-size: var(--fs-2xs);
    padding: 1px 4px;
    border-radius: 3px;
    background: color-mix(in srgb, var(--red) 18%, transparent);
    color: var(--red);
  }
  .cq-empty {
    padding: 20px;
    text-align: center;
    color: var(--subtext0);
    font-size: var(--fs-sm);
  }
  .cq-footer {
    padding: 6px 10px;
    border-top: 1px solid var(--surface0);
    font-size: var(--fs-xs);
    font-family: var(--font-mono);
    color: var(--subtext0);
    text-align: center;
  }
</style>
