<script lang="ts">
  import { untrack } from 'svelte'
  import type { Bookmark, PullRequest } from './api'
  import { classifyBookmark, syncPriority, syncLabel, type SyncState } from './bookmark-sync'
  import { fuzzyMatch } from './fuzzy'
  import { createConfirmGate } from './confirm-gate.svelte'
  import type { BookmarkOp } from './BookmarkModal.svelte'

  /** Gates for context-menu items — same source of truth as the d/f/t keys.
   *  Precomputed here so App's menu builder doesn't duplicate the logic. */
  export interface BookmarkRowActions {
    jump: boolean
    del: boolean
    /** Non-null when track/untrack is possible; carries the resolved remote. */
    track: { action: 'track' | 'untrack'; remote: string } | null
  }

  interface Props {
    bookmarks: Bookmark[]
    loading: boolean
    error: string
    defaultRemote: string
    prByBookmark: Map<string, PullRequest>
    onjump: (bm: Bookmark) => void
    onexecute: (op: BookmarkOp) => void
    onrefresh: () => void
    onclose: () => void
    oncontextmenu?: (bm: Bookmark, actions: BookmarkRowActions, x: number, y: number) => void
  }

  let { bookmarks, loading, error, defaultRemote, prByBookmark, onjump, onexecute, onrefresh, onclose, oncontextmenu }: Props = $props()

  let query: string = $state('')
  let index: number = $state(0)
  let inputEl: HTMLInputElement | undefined = $state(undefined)
  let listEl: HTMLDivElement | undefined = $state(undefined)
  let inputFocused: boolean = $state(false)

  const confirm = createConfirmGate<'d' | 'f' | 't'>()

  // Precompute sync state per bookmark — classifyBookmark walks remotes[]
  // and the sort comparator calls it 2N·logN times otherwise.
  interface Row { bm: Bookmark; sync: SyncState }
  let rows = $derived.by((): Row[] => {
    let filtered = query
      ? bookmarks.filter(b => fuzzyMatch(query, b.name))
      : bookmarks
    return filtered
      .map(bm => ({ bm, sync: classifyBookmark(bm) }))
      .sort((a, b) => {
        const p = syncPriority(a.sync) - syncPriority(b.sync)
        return p !== 0 ? p : a.bm.name.localeCompare(b.bm.name)
      })
  })

  let selected = $derived(rows[index] as Row | undefined)

  // Per-bookmark action gates. Factored out of the keyboard-selection
  // $derived so context-menu can compute them for the RIGHT-CLICKED row
  // (not the keyboard-selected one).
  function computeActions(bm: Bookmark): BookmarkRowActions {
    // Track/untrack: prefer an existing remote entry (toggle its state);
    // fall back to defaultRemote for local-only bookmarks.
    const r = bm.remotes?.[0]
    const track = r ? { action: r.tracked ? 'untrack' as const : 'track' as const, remote: r.remote }
      : bm.local && defaultRemote ? { action: 'track' as const, remote: defaultRemote }
      : null
    return {
      jump: !bm.conflict && !!bm.commit_id,
      del: !!bm.local,
      track,
    }
  }

  let trackInfo = $derived(selected ? computeActions(selected.bm).track : null)

  let can = $derived({
    jump: !!selected && !selected.bm.conflict && !!selected.bm.commit_id,
    del: !!selected?.bm.local,
    forget: !!selected,
    track: trackInfo,
  })

  // Reload can reorder rows (sync state changed → different priority).
  // Restore selection by name when bookmarks prop changes. untrack() on
  // index/rows so j/k doesn't trigger this (would immediately restore the
  // pre-j index). Clamp stays inside: runs only on prop change too, which
  // is the only time rows.length can shrink under index.
  let lastSelectedName: string | undefined
  $effect(() => {
    void bookmarks // ONLY tracked dep
    untrack(() => {
      if (lastSelectedName) {
        const i = rows.findIndex(r => r.bm.name === lastSelectedName)
        if (i >= 0) index = i
      }
      if (index >= rows.length && rows.length > 0) index = rows.length - 1
    })
  })
  $effect(() => { lastSelectedName = selected?.bm.name })

  // Disarm when selection changes (keyboard OR mouse OR reload-deleted-row).
  // Identity change, not value — rows rederive gives new wrapper objects.
  $effect(() => {
    void selected
    confirm.disarm()
  })

  // Auto-focus list on mount so j/k work immediately. Panel is mounted via
  // {#if activeView === 'branches'} so mount = view entry.
  $effect(() => {
    listEl?.focus()
  })

  function scrollActiveIntoView() {
    requestAnimationFrame(() => {
      listEl?.querySelector('.bp-row-active')?.scrollIntoView({ block: 'nearest' })
    })
  }

  function fire(op: BookmarkOp) {
    confirm.disarm()
    onexecute(op)
  }

  // Exported for App.svelte focus-independent dispatch. When focus drifts
  // (toolbar click), element onkeydown doesn't fire but App's window listener
  // does — it calls this directly. Returns true if handled (App checks
  // e.defaultPrevented).
  export function handleKeydown(e: KeyboardEvent) {
    const row = selected

    switch (e.key) {
      case 'ArrowDown':
      case 'j':
        if (e.key === 'j' && inputFocused) return
        e.preventDefault()
        if (inputFocused) listEl?.focus()
        index = Math.min(index + 1, Math.max(rows.length - 1, 0))
        scrollActiveIntoView()
        return
      case 'ArrowUp':
      case 'k':
        if (e.key === 'k' && inputFocused) return
        e.preventDefault()
        index = Math.max(index - 1, 0)
        scrollActiveIntoView()
        return
      case 'Enter':
        e.preventDefault()
        e.stopPropagation()
        confirm.disarm()
        if (can.jump && row) onjump(row.bm)
        return
      case 'Escape':
        e.preventDefault()
        e.stopPropagation()
        if (confirm.armed) { confirm.disarm(); return }
        if (query) { query = ''; listEl?.focus(); return }
        onclose()
        return
      case '/':
        if (inputFocused) return
        e.preventDefault()
        confirm.disarm()
        inputEl?.focus()
        return
    }

    // Claim panel-owned keys even when nothing is selected (empty list,
    // initial load) so they don't fall through to App's global t=theme,
    // f=fetch etc. Default case's disarm is harmless when nothing armed.
    if (inputFocused) return
    if (!row) {
      if (['d', 'f', 't', 'r'].includes(e.key)) e.preventDefault()
      return
    }
    switch (e.key) {
      case 'r':
        e.preventDefault()
        confirm.disarm()
        onrefresh()
        return
      case 'd':
        e.preventDefault()
        if (!can.del) { confirm.disarm(); return }
        if (confirm.gate('d', true)) return
        fire({ action: 'delete', bookmark: row.bm.name })
        return
      case 'f':
        e.preventDefault()
        if (confirm.gate('f', true)) return
        fire({ action: 'forget', bookmark: row.bm.name })
        return
      case 't': {
        e.preventDefault()
        const t = trackInfo
        if (!t) { confirm.disarm(); return }
        if (confirm.gate('t', t.action === 'untrack')) return
        fire({ action: t.action, bookmark: row.bm.name, remote: t.remote })
        return
      }
      default:
        confirm.disarm()
    }
  }

  // Dot color per sync kind. Uses existing palette vars.
  const DOT_CLASS: Record<SyncState['kind'], string> = {
    'conflict': 'bp-dot-red',
    'diverged': 'bp-dot-red',
    'ahead': 'bp-dot-amber',
    'behind': 'bp-dot-blue',
    'local-only': 'bp-dot-gray',
    'remote-only': 'bp-dot-hollow',
    'synced': 'bp-dot-green',
  }
</script>

{#snippet commitLine(ref: import('./api').BookmarkRemote, isRemote: boolean)}
  <div class="bp-commit-line" class:bp-commit-remote={isRemote}>
    <span class="bp-cid">{ref.commit_id.slice(0, 8)}</span>
    <span class="bp-desc">{ref.description || '(no description)'}</span>
    {#if ref.ago}<span class="bp-ago">{ref.ago}</span>{/if}
    {#if isRemote}<span class="bp-remote-tag">@{ref.remote}</span>{/if}
  </div>
{/snippet}

<!-- svelte-ignore a11y_no_noninteractive_element_interactions --
     keydown is delegated here so filter-input and listbox share handlers;
     the focusable listbox child holds actual focus. -->
<div class="bp-root" onkeydown={handleKeydown} role="region" aria-label="Bookmarks panel">
  <div class="bp-header">
    <input
      bind:this={inputEl}
      bind:value={query}
      class="bp-filter"
      type="text"
      placeholder="Filter bookmarks... (press / to focus)"
      oninput={() => { index = 0 }}
      onfocus={() => { inputFocused = true }}
      onblur={() => { inputFocused = false }}
    />
    <span class="bp-count">{rows.length}</span>
  </div>

  <div
    bind:this={listEl}
    class="bp-list"
    role="listbox"
    tabindex="0"
    aria-label="Bookmarks"
    aria-activedescendant={selected ? `bp-row-${index}` : undefined}
  >
    {#if loading && bookmarks.length === 0}
      <div class="bp-empty">Loading...</div>
    {:else if error}
      <div class="bp-empty bp-error" role="alert">{error}</div>
    {:else if rows.length === 0}
      <div class="bp-empty">{query ? 'No matching bookmarks' : 'No bookmarks'}</div>
    {:else}
      {#each rows as row, i (row.bm.name)}
        {@const trackedRemote = row.bm.remotes?.find(r => r.tracked)}
        {@const shownRemote = trackedRemote ?? row.bm.remotes?.[0]}
        {@const label = syncLabel(row.sync, shownRemote?.remote ?? defaultRemote)}
        {@const local = row.bm.local}
        {@const diverged = local && shownRemote && local.commit_id !== shownRemote.commit_id}
        {@const pr = prByBookmark.get(row.bm.name)}
        <!-- svelte-ignore a11y_click_events_have_key_events -- Enter handled on panel -->
        <div
          id="bp-row-{i}"
          class="bp-row"
          class:bp-row-active={i === index}
          onmousemove={() => { if (index !== i) index = i }}
          onclick={() => { if (!row.bm.conflict && row.bm.commit_id) onjump(row.bm) }}
          oncontextmenu={oncontextmenu ? (e: MouseEvent) => {
            e.preventDefault()
            confirm.disarm() // right-click cancels any pending double-press confirm
            index = i        // sync keyboard selection to right-clicked row
            oncontextmenu!(row.bm, computeActions(row.bm), e.clientX, e.clientY)
          } : undefined}
          role="option"
          tabindex="-1"
          aria-selected={i === index}
        >
          <span class="bp-dot {DOT_CLASS[row.sync.kind]}"></span>
          <span class="bp-name">
            {row.bm.name}
            {#if pr}
              <a class="bp-pr-badge" class:is-draft={pr.is_draft}
                 href={pr.url} target="_blank" rel="noopener"
                 onclick={(e) => e.stopPropagation()}
                 title="{pr.is_draft ? 'Draft ' : ''}PR #{pr.number}">
                #{pr.number}
              </a>
            {/if}
          </span>
          <span class="bp-sync" class:bp-sync-conflict={row.sync.kind === 'conflict'}>{label}</span>

          <div class="bp-commits">
            {#if row.sync.kind === 'conflict'}
              {#each row.bm.added_targets ?? [] as cid}
                <div class="bp-commit-line">
                  <span class="bp-cid bp-cid-conflict">+{cid.slice(0, 8)}</span>
                </div>
              {/each}
            {:else if diverged}
              {@render commitLine(local, false)}
              {@render commitLine(shownRemote, true)}
            {:else if local}
              {@render commitLine(local, false)}
            {:else if shownRemote}
              {@render commitLine(shownRemote, true)}
            {:else}
              <span class="bp-cid">—</span>
            {/if}
          </div>
        </div>
      {/each}
    {/if}
  </div>

  <div class="bp-footer">
    {#if confirm.armed === 'd'}
      <span class="bp-confirm"><kbd>d</kbd> again to delete <b>{selected?.bm.name}</b> · Esc to cancel</span>
    {:else if confirm.armed === 'f'}
      <span class="bp-confirm"><kbd>f</kbd> again to forget <b>{selected?.bm.name}</b> · Esc to cancel</span>
    {:else if confirm.armed === 't'}
      <span class="bp-confirm"><kbd>t</kbd> again to untrack <b>{selected?.bm.name}@{trackInfo?.remote}</b> · Esc to cancel</span>
    {:else}
      <span class:dim={!can.jump}><kbd>⏎</kbd> jump</span>
      <span class:dim={!can.del}><kbd>d</kbd> delete</span>
      <span class:dim={!can.forget}><kbd>f</kbd> forget</span>
      <span class:dim={!can.track}>
        <kbd>t</kbd> {trackInfo?.action ?? 'track'}{#if trackInfo} <span class="bp-remote">({trackInfo.remote})</span>{/if}
      </span>
      <span><kbd>r</kbd> refresh</span>
      <span><kbd>/</kbd> filter</span>
    {/if}
  </div>
</div>

<style>
  .bp-root {
    display: flex;
    flex-direction: column;
    height: 100%;
    background: var(--base);
    outline: none;
    /* Parent is display:flex — without this the panel shrinks to content */
    flex: 1;
    min-width: 0;
  }

  .bp-header {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 10px 16px;
    border-bottom: 1px solid var(--surface0);
    background: var(--mantle);
  }

  .bp-filter {
    width: 340px;
    background: var(--base);
    color: var(--text);
    border: 1px solid var(--surface0);
    border-radius: 4px;
    padding: 6px 10px;
    font-family: inherit;
    font-size: 13px;
    outline: none;
  }

  .bp-filter:focus { border-color: var(--blue); }
  .bp-filter::placeholder { color: var(--surface2); }

  .bp-count {
    font-size: 11px;
    color: var(--overlay0);
    padding: 2px 8px;
    background: var(--surface0);
    border-radius: 10px;
  }

  .bp-list {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    outline: none;
    user-select: none;
  }

  .bp-row {
    display: flex;
    align-items: flex-start;
    gap: 14px;
    padding: 8px 16px;
    font-size: 13px;
    cursor: pointer;
    border-left: 2px solid transparent;
  }

  .bp-row-active {
    background: var(--surface0);
    border-left-color: var(--blue);
  }

  .bp-dot {
    width: 8px;
    height: 8px;
    margin-top: 5px;
    border-radius: 50%;
    flex-shrink: 0;
  }

  .bp-dot-green  { background: var(--green); }
  .bp-dot-amber  { background: var(--amber); }
  .bp-dot-blue   { background: var(--blue); }
  .bp-dot-red    { background: var(--red); }
  .bp-dot-gray   { background: var(--overlay0); }
  .bp-dot-hollow { background: transparent; border: 1px solid var(--overlay0); }

  .bp-name {
    width: 280px;
    flex-shrink: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-weight: 500;
  }

  .bp-sync {
    width: 150px;
    flex-shrink: 0;
    font-size: 11px;
    color: var(--subtext0);
    text-align: left;
  }

  .bp-sync-conflict { color: var(--red); font-weight: 500; }

  /* Commit column: flex-grows to fill remaining width. Stacked lines for
     diverged (local + remote) and conflict (one line per added_target). */
  .bp-commits {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  .bp-commit-line {
    display: flex;
    align-items: baseline;
    gap: 8px;
    min-width: 0;
  }

  .bp-cid {
    font-family: var(--font-mono, monospace);
    font-size: 11px;
    color: var(--overlay0);
    flex-shrink: 0;
  }

  .bp-cid-conflict { color: var(--red); }

  .bp-desc {
    font-size: 12px;
    color: var(--subtext0);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    flex: 1;
    min-width: 0;
  }

  .bp-commit-remote .bp-cid { color: var(--blue); }
  .bp-commit-remote .bp-desc { color: var(--overlay1); }

  .bp-ago {
    font-size: 10px;
    color: var(--surface2);
    flex-shrink: 0;
    margin-right: 4px;
  }

  .bp-remote-tag {
    font-size: 10px;
    color: var(--overlay0);
    padding: 0 5px;
    background: var(--surface0);
    border-radius: 3px;
    flex-shrink: 0;
  }

  .bp-pr-badge {
    display: inline-block;
    margin-left: 6px;
    padding: 0 6px;
    font-size: 10px;
    font-weight: 600;
    background: var(--green);
    color: var(--crust);
    border-radius: 3px;
    text-decoration: none;
  }

  .bp-pr-badge.is-draft {
    background: var(--surface2);
    color: var(--subtext0);
  }

  .bp-footer {
    display: flex;
    flex-wrap: wrap;
    gap: 14px;
    padding: 8px 16px;
    border-top: 1px solid var(--surface0);
    font-size: 11px;
    color: var(--subtext0);
    background: var(--mantle);
  }

  .bp-footer .dim { opacity: 0.3; }
  .bp-remote { color: var(--overlay0); }

  .bp-confirm {
    color: var(--red);
    animation: bp-pulse 0.15s ease;
  }

  .bp-confirm b { font-weight: 600; }

  @keyframes bp-pulse {
    from { opacity: 0.4; }
    to { opacity: 1; }
  }

  kbd {
    display: inline-block;
    min-width: 14px;
    padding: 1px 4px;
    font-family: var(--font-mono, monospace);
    font-size: 10px;
    text-align: center;
    background: var(--surface0);
    border: 1px solid var(--surface1);
    border-radius: 3px;
    color: var(--text);
  }

  .bp-empty {
    padding: 24px;
    color: var(--surface2);
    text-align: center;
    font-size: 13px;
  }

  .bp-error { color: var(--red); }
</style>
