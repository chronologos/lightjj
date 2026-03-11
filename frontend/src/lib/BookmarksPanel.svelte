<script lang="ts">
  import { untrack } from 'svelte'
  import type { Bookmark, PullRequest, RemoteVisibility, RemoteVisibilityEntry } from './api'
  import { classifyBookmark, syncPriority, syncLabel, trackOptions, type SyncState, type TrackOption } from './bookmark-sync'
  import { fuzzyMatch } from './fuzzy'
  import { createConfirmGate } from './confirm-gate.svelte'
  import type { BookmarkOp } from './BookmarkModal.svelte'

  /** Gates for context-menu items — same source of truth as the d/f/t keys.
   *  Precomputed here so App's menu builder doesn't duplicate the logic. */
  export interface BookmarkRowActions {
    jump: boolean
    del: boolean
    /** Tracked remote-only (delete-staged): `d` pushes the deletion instead
     *  of local-delete. One entry per tracked remote; [0] is the push target
     *  (jj git push is single-remote — user presses `d` again for the rest).
     *  Empty = local exists or untracked or conflicted → use `del`/none. */
    pushDelete: string[]
    /** Per-remote track/untrack toggles. Empty = nothing to do. */
    track: TrackOption[]
  }

  interface GroupRow {
    kind: 'group'
    remote: string
    label: string
    count: number
    expanded: boolean
    visibility: RemoteVisibilityEntry | null  // null = local (no toggle)
  }

  interface BookmarkRow {
    kind: 'bookmark'
    bm: Bookmark
    sync: SyncState
    remote: string
    visibleInLog: boolean
    // commit_id to jump to on click/Enter. For remote-group rows this is the
    // scoped remote's commit_id — display (shownRemote) and click must agree.
    // Falls back to bm.commit_id (LOCAL group, or remote entry without one).
    jumpTarget?: string
  }

  type PanelRow = GroupRow | BookmarkRow

  interface Props {
    bookmarks: Bookmark[]
    loading: boolean
    error: string
    defaultRemote: string
    allRemotes: string[]
    remoteVisibility: RemoteVisibility
    prByBookmark: Map<string, PullRequest>
    /** Commit_id of the graph's selected revision — rows whose jumpTarget
     *  matches get an amber tint (bidirectional: click bookmark → graph
     *  highlights, click graph → bookmark highlights). */
    graphCommitId?: string
    onjump: (bm: Bookmark, commitId?: string) => void
    onexecute: (op: BookmarkOp) => void
    onrefresh: () => void
    onclose: () => void
    onvisibilitychange: (vis: RemoteVisibility) => void
    oncontextmenu?: (bm: Bookmark, actions: BookmarkRowActions, x: number, y: number, jumpTarget?: string) => void
    ontrackmenu?: (bm: Bookmark, opts: TrackOption[], x: number, y: number) => void
  }

  let { bookmarks, loading, error, defaultRemote, allRemotes, remoteVisibility, prByBookmark, graphCommitId, onjump, onexecute, onrefresh, onclose, onvisibilitychange, oncontextmenu, ontrackmenu }: Props = $props()

  let query: string = $state('')
  let index: number = $state(0)
  let inputEl: HTMLInputElement | undefined = $state(undefined)
  let listEl: HTMLDivElement | undefined = $state(undefined)
  let inputFocused: boolean = $state(false)

  const confirm = createConfirmGate<'d' | 'f' | 't'>()

  let expandedGroups = $state(new Set<string>(['.']))

  // Group-level toggle. OFF→ON clears `hidden` (intent of the big toggle is
  // "show all of this remote"); ON→OFF preserves it (re-enabling later
  // remembers per-bookmark selections). Without the OFF→ON clear, toggling
  // the group after a single-bookmark flip would claim "visible" while
  // still hiding N-1 bookmarks.
  function toggleGroupVisibility(remote: string) {
    const vis = { ...remoteVisibility }
    const current = vis[remote]
    const next = !current?.visible
    vis[remote] = { visible: next, hidden: next ? [] : (current?.hidden ?? []) }
    onvisibilitychange(vis)
  }

  // Toggle a single bookmark's visibility. Three cases:
  //  - remote hidden → enable remote with hidden=[all_other_bookmarks]
  //    (flip on JUST this bookmark without flooding the log — the original
  //    design required enabling the whole remote first then hiding N-1)
  //  - remote visible + bookmark shown → add to hidden
  //  - remote visible + bookmark hidden → remove from hidden
  function toggleBookmarkVisibility(remote: string, name: string) {
    const vis = { ...remoteVisibility }
    const entry = vis[remote]
    if (!entry?.visible) {
      // All bookmarks that have a presence on this remote, except the one
      // we're turning on. Computed fresh at click time (bookmarks prop may
      // lag behind a concurrent fetch; stale = worst case one bookmark
      // briefly appears that wasn't in the snapshot — benign).
      const others = bookmarks
        .filter(bm => bm.name !== name && bm.remotes?.some(r => r.remote === remote))
        .map(bm => bm.name)
      vis[remote] = { visible: true, hidden: others }
    } else {
      const hidden = new Set(entry.hidden ?? [])
      if (hidden.has(name)) hidden.delete(name)
      else hidden.add(name)
      vis[remote] = { ...entry, hidden: [...hidden] }
    }
    onvisibilitychange(vis)
  }

  // Auto-expand newly discovered remote groups
  $effect(() => {
    void allRemotes  // tracked dep
    const current = untrack(() => expandedGroups)  // untrack avoids self-loop
    const next = new Set(current)
    let changed = false
    for (const r of allRemotes) {
      if (!next.has(r)) { next.add(r); changed = true }
    }
    if (changed) expandedGroups = next
  })

  let panelRows = $derived.by((): PanelRow[] => {
    const result: PanelRow[] = []

    // 1. Local group
    const localBms = bookmarks.filter(bm => bm.local)
    const filteredLocal = query ? localBms.filter(b => fuzzyMatch(query, b.name)) : localBms
    result.push({
      kind: 'group', remote: '.', label: 'LOCAL',
      count: filteredLocal.length, expanded: expandedGroups.has('.'),
      visibility: null,
    })
    if (expandedGroups.has('.')) {
      for (const entry of filteredLocal
        .map(bm => ({ bm, sync: classifyBookmark(bm) }))
        .sort((a, b) => {
          const p = syncPriority(a.sync) - syncPriority(b.sync)
          return p !== 0 ? p : a.bm.name.localeCompare(b.bm.name)
        })) {
        result.push({ kind: 'bookmark', bm: entry.bm, sync: entry.sync, remote: '.', visibleInLog: true })
      }
    }

    // 2. Per-remote groups — includes bookmarks that ALSO have local presence
    for (const remote of allRemotes) {
      const visEntry = remoteVisibility[remote]
      const remoteBms = bookmarks.filter(bm => bm.remotes?.some(r => r.remote === remote))
      const filtered = query ? remoteBms.filter(b => fuzzyMatch(query, b.name)) : remoteBms
      result.push({
        kind: 'group', remote, label: remote.toUpperCase(),
        count: filtered.length, expanded: expandedGroups.has(remote),
        visibility: visEntry ?? { visible: false },
      })
      if (expandedGroups.has(remote)) {
        for (const bm of filtered.sort((a, b) => a.name.localeCompare(b.name))) {
          const hidden = visEntry?.hidden?.includes(bm.name) ?? false
          // classifyBookmark(bm, remote) — scoped so the sync dot/label
          // describe THIS remote's state, not the first-tracked-remote's.
          // jumpTarget is the scoped remote's commit_id for the same reason:
          // display and click must agree on which commit they mean.
          const scoped = bm.remotes?.find(r => r.remote === remote)
          result.push({
            kind: 'bookmark', bm, sync: classifyBookmark(bm, remote), remote,
            visibleInLog: (visEntry?.visible ?? false) && !hidden,
            jumpTarget: scoped?.commit_id ?? bm.commit_id,
          })
        }
      }
    }
    return result
  })

  let selected = $derived(panelRows[index] as PanelRow | undefined)

  // Per-bookmark action gates. Factored out of the keyboard-selection
  // $derived so context-menu can compute them for the RIGHT-CLICKED row
  // (not the keyboard-selected one).
  function computeActions(bm: Bookmark): BookmarkRowActions {
    // Delete-staged: no local, but tracked remote(s) still exist. `d` pushes
    // the deletion (network op). Untracked remote-only is left alone —
    // pushing -b <name> would implicitly TRACK it, not delete. Conflicted
    // refs are excluded too (jj refuses to push conflicts; resolve first).
    const pushDelete = !bm.local && !bm.conflict
      ? (bm.remotes ?? []).filter(r => r.tracked).map(r => r.remote)
      : []
    return {
      jump: !bm.conflict && !!bm.commit_id,
      del: !!bm.local,
      pushDelete,
      track: trackOptions(bm, allRemotes),
    }
  }

  // Single computeActions() call; both can and trackInfo derive from it.
  let selActions = $derived(
    selected?.kind === 'bookmark' ? computeActions(selected.bm) : null
  )
  let trackInfo = $derived(selActions?.track ?? [])

  let can = $derived({
    // selActions.jump checks bm.commit_id — but remote-group rows can have
    // empty bm.commit_id (delete-staged on a non-default remote) with a valid
    // jumpTarget. Enter/click both pass jumpTarget; the gate must honor it too.
    jump: (selActions?.jump ?? false) || !!(selected?.kind === 'bookmark' && selected.jumpTarget),
    del: selActions?.del ?? false,
    pushDelete: selActions?.pushDelete ?? [],
    forget: selected?.kind === 'bookmark',
    track: trackInfo.length > 0,
  })

  // Reload can reorder rows (sync state changed → different priority).
  // Restore selection by (name, remote) when bookmarks prop changes. Tracking
  // both fields means selecting `main` in the UPSTREAM group restores there,
  // not to the LOCAL row with the same name. untrack() on index/panelRows so
  // j/k doesn't trigger this (would immediately restore the pre-j index).
  let lastSelectedName: string | undefined
  let lastSelectedRemote: string | undefined
  $effect(() => {
    void bookmarks // tracked dep: reload reorders, restore needed
    untrack(() => {
      if (lastSelectedName) {
        const i = panelRows.findIndex(r =>
          r.kind === 'bookmark' && r.bm.name === lastSelectedName && r.remote === lastSelectedRemote
        )
        if (i >= 0) index = i
      }
    })
  })
  // Clamp is a SEPARATE effect tracking panelRows.length — collapsing a group
  // via Enter shrinks panelRows without changing bookmarks; the restore effect
  // above wouldn't fire, leaving index past the end → selected undefined →
  // d/f/t/e silently no-op.
  $effect(() => {
    const len = panelRows.length
    untrack(() => {
      if (index >= len && len > 0) index = len - 1
    })
  })
  $effect(() => {
    lastSelectedName = selected?.kind === 'bookmark' ? selected.bm.name : undefined
    lastSelectedRemote = selected?.kind === 'bookmark' ? selected.remote : undefined
  })

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
        index = Math.min(index + 1, Math.max(panelRows.length - 1, 0))
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
        if (selected?.kind === 'group') {
          const next = new Set(expandedGroups)
          if (next.has(selected.remote)) next.delete(selected.remote)
          else next.add(selected.remote)
          expandedGroups = next
        } else if (can.jump && selected?.kind === 'bookmark') {
          onjump(selected.bm, selected.jumpTarget)
        }
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
      case 'e': {
        if (inputFocused) return
        e.preventDefault()
        const eRow = panelRows[index]
        if (!eRow) return
        if (eRow.kind === 'group' && eRow.visibility) {
          toggleGroupVisibility(eRow.remote)
        } else if (eRow.kind === 'bookmark' && eRow.remote !== '.') {
          toggleBookmarkVisibility(eRow.remote, eRow.bm.name)
        }
        return
      }
    }

    // Claim panel-owned keys even when nothing is selected (empty list,
    // initial load) so they don't fall through to App's global t=theme,
    // f=fetch etc. Default case's disarm is harmless when nothing armed.
    if (inputFocused) return
    if (!row) {
      if (['d', 'f', 't', 'r'].includes(e.key)) e.preventDefault()
      return
    }
    // Guard d/f/t against GroupRow — only meaningful for bookmark rows
    if (selected?.kind !== 'bookmark') {
      if (['d', 'f', 't'].includes(e.key)) e.preventDefault()
      if (e.key === 'r') {
        e.preventDefault()
        confirm.disarm()
        onrefresh()
      }
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
        if (!can.del && !can.pushDelete[0]) { confirm.disarm(); return }
        if (confirm.gate('d', true)) return
        if (can.pushDelete[0]) {
          fire({ action: 'push-delete', bookmark: selected.bm.name, remote: can.pushDelete[0] })
        } else {
          fire({ action: 'delete', bookmark: selected.bm.name })
        }
        return
      case 'f':
        e.preventDefault()
        if (confirm.gate('f', true)) return
        fire({ action: 'forget', bookmark: selected.bm.name })
        return
      case 't': {
        e.preventDefault()
        const opts = trackInfo
        if (opts.length === 0) { confirm.disarm(); return }
        if (opts.length === 1) {
          // Single-remote: preserve current immediate-fire + confirm ergonomics.
          const t = opts[0]
          if (confirm.gate('t', t.action === 'untrack')) return
          fire({ action: t.action, bookmark: selected.bm.name, remote: t.remote })
          return
        }
        // Multi-remote: open submenu at the active row's right edge.
        confirm.disarm()
        const rect = listEl?.querySelector('.bp-row-active')?.getBoundingClientRect()
        ontrackmenu?.(selected.bm, opts,
          rect ? rect.right - 40 : window.innerWidth / 2,
          rect ? rect.top + rect.height / 2 : window.innerHeight / 2)
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

{#snippet eyeIcon(visible: boolean)}
  <!-- Stroke-only SVG (inherits currentColor). The diagonal slash is drawn
       only when hidden — shape distinction in addition to opacity, so the
       state reads at a glance without hovering. -->
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none"
       stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7-11-7-11-7z"/>
    <circle cx="12" cy="12" r="3"/>
    {#if !visible}<path d="M3 3l18 18"/>{/if}
  </svg>
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
    <span class="bp-count">{panelRows.filter(r => r.kind === 'bookmark').length}</span>
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
    {:else if panelRows.length === 0}
      <div class="bp-empty">{query ? 'No matching bookmarks' : 'No bookmarks'}</div>
    {:else}
      {#each panelRows as row, i (row.kind === 'group' ? `g:${row.remote}` : `b:${row.remote}:${row.bm.name}`)}
        {#if row.kind === 'group'}
          <!-- svelte-ignore a11y_click_events_have_key_events -- Enter handled on panel -->
          <div
            id="bp-row-{i}"
            class="bp-group-row"
            class:bp-row-active={i === index}
            onmousemove={() => { if (index !== i) index = i }}
            onclick={() => {
              const next = new Set(expandedGroups)
              if (next.has(row.remote)) next.delete(row.remote)
              else next.add(row.remote)
              expandedGroups = next
            }}
            role="option"
            tabindex="-1"
            aria-selected={i === index}
          >
            <span class="bp-chevron">{row.expanded ? '▼' : '▶'}</span>
            <span class="bp-group-label">{row.label}</span>
            <span class="bp-group-count">({row.count})</span>
            {#if row.visibility}
              <button class="bp-eye" class:bp-eye-off={!row.visibility.visible}
                onclick={(ev: MouseEvent) => { ev.stopPropagation(); toggleGroupVisibility(row.remote) }}
                title={row.visibility.visible ? 'Hide from revision graph' : 'Show in revision graph'}>
                {@render eyeIcon(row.visibility.visible)}
              </button>
            {/if}
          </div>
        {:else}
          <!-- Remote-group rows scope to THIS group's remote entry; LOCAL group
               uses the first tracked remote for sync context. Without this, the
               UPSTREAM > main row showed `origin 2d37a09e` — the row.remote
               context was computed but never used to select which remote's
               commit_id/sync state to render. -->
          {@const scopedRemote = row.remote !== '.' ? row.bm.remotes?.find(r => r.remote === row.remote) : undefined}
          {@const trackedRemote = row.bm.remotes?.find(r => r.tracked)}
          {@const shownRemote = scopedRemote ?? trackedRemote ?? row.bm.remotes?.[0]}
          {@const label = syncLabel(row.sync, shownRemote?.remote ?? defaultRemote)}
          {@const local = row.remote === '.' ? row.bm.local : undefined}
          {@const diverged = local && shownRemote && local.commit_id !== shownRemote.commit_id}
          {@const primaryCid = local?.commit_id ?? shownRemote?.commit_id}
          {@const extraRemotes = row.remote === '.' ? (row.bm.remotes ?? []).filter(r => r !== shownRemote && r.commit_id && r.commit_id !== primaryCid) : []}
          {@const pr = prByBookmark.get(row.bm.name)}
          {@const matchesGraph = !!graphCommitId && (row.jumpTarget ?? row.bm.commit_id) === graphCommitId}
          <!-- svelte-ignore a11y_click_events_have_key_events -- Enter handled on panel -->
          <div
            id="bp-row-{i}"
            class="bp-row bp-bookmark-row"
            class:bp-row-active={i === index}
            class:bp-row-matches-graph={matchesGraph}
            class:bp-row-hidden={!row.visibleInLog && row.remote !== '.'}
            onmousemove={() => { if (index !== i) index = i }}
            onclick={() => { if (!row.bm.conflict && (row.jumpTarget ?? row.bm.commit_id)) onjump(row.bm, row.jumpTarget) }}
            oncontextmenu={oncontextmenu ? (e: MouseEvent) => {
              e.preventDefault()
              confirm.disarm() // right-click cancels any pending double-press confirm
              index = i        // sync keyboard selection to right-clicked row
              oncontextmenu!(row.bm, computeActions(row.bm), e.clientX, e.clientY, row.jumpTarget)
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
              {#each extraRemotes as extra}
                {@render commitLine(extra, true)}
              {/each}
            </div>

            {#if row.remote !== '.'}
              <button class="bp-eye bp-eye-inline" class:bp-eye-off={!row.visibleInLog}
                onclick={(ev: MouseEvent) => {
                  ev.stopPropagation()
                  toggleBookmarkVisibility(row.remote, row.bm.name)
                }}
                title={row.visibleInLog ? 'Hide from revision graph' : 'Show in revision graph'}>
                {@render eyeIcon(row.visibleInLog)}
              </button>
            {/if}
          </div>
        {/if}
      {/each}
    {/if}
  </div>

  <div class="bp-footer">
    {#if confirm.armed === 'd'}
      <span class="bp-confirm">
        <kbd>d</kbd> again to
        {#if can.pushDelete[0]}
          push delete <b>{selected?.kind === 'bookmark' ? selected.bm.name : ''}</b> → {can.pushDelete[0]}
          {#if can.pushDelete.length > 1}<span class="bp-more">(+{can.pushDelete.length - 1} more)</span>{/if}
        {:else}
          delete <b>{selected?.kind === 'bookmark' ? selected.bm.name : ''}</b>
        {/if}
        · Esc to cancel
      </span>
    {:else if confirm.armed === 'f'}
      <span class="bp-confirm"><kbd>f</kbd> again to forget <b>{selected?.kind === 'bookmark' ? selected.bm.name : ''}</b> · Esc to cancel</span>
    {:else if confirm.armed === 't'}
      <span class="bp-confirm"><kbd>t</kbd> again to untrack <b>{selected?.kind === 'bookmark' ? selected.bm.name : ''}</b>@{trackInfo[0]?.remote} · Esc to cancel</span>
    {:else}
      <span class:dim={!can.jump}><kbd>⏎</kbd> jump</span>
      <span class:dim={!can.del && !can.pushDelete[0]}>
        <kbd>d</kbd>
        {#if can.pushDelete[0]}push delete → {can.pushDelete[0]}{:else}delete{/if}
      </span>
      <span class:dim={!can.forget}><kbd>f</kbd> forget</span>
      <span class:dim={!can.track}>
        <kbd>t</kbd>
        {#if trackInfo.length === 1}
          {trackInfo[0].action} <span class="bp-remote">({trackInfo[0].remote})</span>
        {:else if trackInfo.length > 1}
          track/untrack…
        {:else}
          track
        {/if}
      </span>
      <!-- dim when `e` would no-op: no selection, LOCAL group header, or a LOCAL bookmark row.
           Remote-group bookmarks are always toggleable now (hidden-remote → allowlist flip). -->
      <span class:dim={!selected || (selected.kind === 'group' && !selected.visibility) || (selected.kind === 'bookmark' && selected.remote === '.')}><kbd>e</kbd> eye</span>
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

  .bp-group-row {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 6px 14px;
    background: var(--mantle);
    font-size: 11px;
    font-weight: 600;
    color: var(--subtext0);
    text-transform: uppercase;
    letter-spacing: 0.5px;
    cursor: pointer;
    user-select: none;
  }
  .bp-group-row.bp-row-active {
    background: var(--surface0);
  }
  .bp-chevron {
    font-size: 9px;
    width: 10px;
    text-align: center;
  }
  .bp-group-count {
    font-size: 9px;
    color: var(--overlay0);
    font-weight: normal;
    text-transform: none;
  }

  .bp-eye {
    margin-left: auto;
    background: none;
    border: none;
    cursor: pointer;
    padding: 2px;
    opacity: 0.7;
    color: var(--text);
    display: inline-flex;
    align-items: center;
  }
  .bp-eye:hover { opacity: 1; color: var(--mauve); }
  .bp-eye-off { opacity: 0.35; }
  .bp-eye-off:hover { opacity: 0.6; }
  .bp-eye-inline {
    flex-shrink: 0;
  }
  .bp-eye svg { display: block; }

  .bp-row {
    display: flex;
    align-items: flex-start;
    gap: 14px;
    padding: 8px 16px;
    font-size: 13px;
    cursor: pointer;
    border-left: 2px solid transparent;
  }

  .bp-bookmark-row {
    padding-left: 28px;
  }

  .bp-row-active {
    background: var(--surface0);
    border-left-color: var(--blue);
  }

  /* Graph cursor points at this bookmark's commit. Amber (=active, Tier 1)
     right-border mirrors the graph's amber left-border selection — visual
     symmetry across the divider. Keyboard cursor (blue left-border) is
     independent; both can show. */
  .bp-row-matches-graph {
    background: var(--bg-selected);
    border-right: 2px solid var(--amber);
  }
  .bp-row-matches-graph.bp-row-active {
    /* Stack: amber tint wins over gray, but keep both borders visible */
    background: var(--bg-selected);
  }

  .bp-row-hidden {
    opacity: 0.4;
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
  .bp-more { color: var(--overlay0); font-weight: normal; margin-left: 4px; }

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
