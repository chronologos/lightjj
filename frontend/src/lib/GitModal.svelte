<script lang="ts">
  import { tick } from 'svelte'
  import { api, bookmarkPushFlags, type Bookmark } from './api'
  import { createLoader } from './loader.svelte'
  import { fuzzyMatch } from './fuzzy'
  import { groupByWithIndex } from './group-by'
  import { createListCursor } from './list-cursor.svelte'

  // Structured op — presentation decided in template, not here.
  // Raw command line is derived: `git ${type} ${flags.join(' ')}`
  interface GitOp {
    type: 'push' | 'fetch'
    group: 'common' | 'bookmarks' | 'other'  // → section; emitted contiguously in this order
    title: string
    hotkey?: string    // single-char; rendered as kbd hint + wired into handleKeydown
    bookmark?: string  // → badge (mirrors RevisionGraph's .bookmark-badge)
    here?: boolean     // bookmark sits on the selected revision → sorts first, gets ▸ marker
    scope?: 'all' | 'deleted' | 'tracked' | 'all-remotes'  // → chip
    changeId?: string  // short form, for the --change entry
    flags: string[]
  }

  const GROUP_LABELS: Record<GitOp['group'], string> = {
    common: 'Common',
    bookmarks: 'Bookmarks',
    other: 'Other',
  }

  interface Props {
    open: boolean
    currentChangeId: string | null
    currentBookmarks?: string[]
    onexecute: (type: 'push' | 'fetch', flags: string[]) => void
  }

  let { open = $bindable(false), currentChangeId, currentBookmarks = [], onexecute }: Props = $props()

  let query: string = $state('')
  // null = "use default" (remotes[0]); set on user cycle/click. Derived
  // selectedRemote means it tracks remotes[0] the same tick data lands —
  // no .then() side-effect, no microtask gap.
  let remoteOverride: string | null = $state(null)
  let modalEl: HTMLDivElement | undefined = $state(undefined)
  let inputEl: HTMLInputElement | undefined = $state(undefined)
  let inputFocused: boolean = $state(false)
  let previousFocus: HTMLElement | null = null
  const data = createLoader(
    () => Promise.all([api.bookmarks({ local: true }), api.remotes()]),
    [[], []] as [Bookmark[], string[]],
  )
  let bookmarks = $derived(data.value[0])
  let remotes = $derived(data.value[1])
  let selectedRemote = $derived(remoteOverride ?? remotes[0] ?? 'origin')

  function buildOps(bms: Bookmark[], remote: string, allRemotes: string[], changeId: string | null, here: ReadonlySet<string>): GitOp[] {
    const ops: GitOp[] = []
    const r = ['--remote', remote]

    // Common — everyday ops stay above the per-bookmark wall (one entry per
    // local bookmark, can get long), so opening `g` lands on Fetch and the
    // whole-repo pushes are visible without scrolling.
    // Flagless fetch respects git.fetch config (jj's own default-resolution:
    // configured list, else origin). Fork workflows set git.fetch =
    // ["upstream","origin"]; forcing --remote <selected> here would silently
    // drop upstream. The pill selector scopes PUSH ops only.
    ops.push({ type: 'fetch', group: 'common', title: 'Fetch', hotkey: 'f', flags: [] })
    if (changeId) {
      const short = changeId.slice(0, 8)
      ops.push({ type: 'push', group: 'common', title: 'Push current change', hotkey: 'c', changeId: short, flags: ['--change', changeId, ...r] })
    }
    ops.push({ type: 'push', group: 'common', title: 'Push tracking bookmarks in current revset', hotkey: 'p', flags: r })
    ops.push({ type: 'push', group: 'common', title: 'Push all bookmarks (incl. new + deleted)', hotkey: 'a', scope: 'all', flags: ['--all', ...r] })

    // Bookmarks get 1-9 (first 9 only — beyond that, j/k is faster than scanning for a digit).
    // Bookmarks on the selected revision sort first so `g 1` pushes the one under your cursor.
    const local = bms.filter(bm => bm.local)
    const ordered = [...local.filter(bm => here.has(bm.name)), ...local.filter(bm => !here.has(bm.name))]
    let n = 0
    for (const bm of ordered) {
      n++
      ops.push({ type: 'push', group: 'bookmarks', title: 'Push bookmark', bookmark: bm.name,
        here: here.has(bm.name),
        hotkey: n <= 9 ? String(n) : undefined,
        flags: bookmarkPushFlags(bm.name, remote) })
    }

    // Other — rarely-used scoped pushes + per-remote fetch variants.
    ops.push({ type: 'push', group: 'other', title: 'Push deleted bookmarks', hotkey: 'd', scope: 'deleted', flags: ['--deleted', ...r] })
    ops.push({ type: 'push', group: 'other', title: 'Push tracked bookmarks (incl. deleted)', hotkey: 't', scope: 'tracked', flags: ['--tracked', ...r] })
    if (allRemotes.length > 1) {
      ops.push({ type: 'fetch', group: 'other', title: `Fetch from ${remote} only`, flags: r })
      ops.push({ type: 'fetch', group: 'other', title: 'Fetch from all remotes', hotkey: 'F', scope: 'all-remotes', flags: ['--all-remotes'] })
    }

    return ops
  }

  let allOps = $derived(buildOps(bookmarks, selectedRemote, remotes, currentChangeId, new Set(currentBookmarks)))
  let hotkeyMap = $derived(new Map(allOps.filter(o => o.hotkey).map(o => [o.hotkey!, o])))

  let filtered = $derived.by(() => {
    if (!open) return []
    if (!query) return allOps
    // Match against title, bookmark name, and scope
    return allOps.filter(op =>
      fuzzyMatch(query, op.title) ||
      (op.bookmark && fuzzyMatch(query, op.bookmark)) ||
      (op.scope && fuzzyMatch(query, op.scope))
    )
  })

  // Section per op.group (common/bookmarks/other), not push/fetch — the type
  // is already conveyed by the title color + raw command line. globalIndex
  // keeps j/k + aria-activedescendant continuous across sections.
  let sections = $derived(
    Array.from(groupByWithIndex(filtered, op => op.group), ([group, ops]) => ({
      header: GROUP_LABELS[group],
      ops: ops.map(({ item, index }) => ({ op: item, globalIndex: index })),
    }))
  )

  // Cursor/hover/keydown core via the shared factory; h/l remote cycling and
  // single-char hotkeys layer on top in handleKeydown.
  const cursor = createListCursor({
    count: () => filtered.length,
    container: () => modalEl,
    inputFocused: () => inputFocused,
    onLeaveInput: () => modalEl?.focus(),
    onEnter: (e) => {
      e.stopPropagation()
      if (selected) execute(selected)
    },
    onEscape: (e) => {
      e.stopPropagation()
      if (query) { query = ''; modalEl?.focus(); return }
      close()
    },
    onSlash: (e) => {
      e.stopPropagation()
      inputEl?.focus()
    },
    hoverMovesCursor: true,
  })

  let selected = $derived(filtered[cursor.index] as GitOp | undefined)

  $effect(() => {
    if (open) {
      previousFocus = document.activeElement as HTMLElement | null
      query = ''
      cursor.index = 0
      remoteOverride = null
      data.load()
      tick().then(() => modalEl?.focus())
    }
  })

  function close() {
    open = false
    previousFocus?.focus()
  }

  function execute(op: GitOp) {
    close()
    onexecute(op.type, op.flags)
  }

  function cycleRemote(delta: 1 | -1) {
    if (remotes.length <= 1) return
    const i = remotes.indexOf(selectedRemote)
    remoteOverride = remotes[(i + delta + remotes.length) % remotes.length]
    cursor.index = 0
  }

  function handleKeydown(e: KeyboardEvent) {
    // Nav (j/k/arrows), Enter, Escape, '/' route through the cursor factory.
    if (cursor.handleKey(e)) return
    if (inputFocused) return
    switch (e.key) {
      case 'ArrowLeft':
      case 'h':
        if (remotes.length > 1) { e.preventDefault(); cycleRemote(-1) }
        return
      case 'ArrowRight':
      case 'l':
        if (remotes.length > 1) { e.preventDefault(); cycleRemote(1) }
        return
      default: {
        // Single-char hotkey — fires immediately. No modifier keys (they bubble
        // for global shortcuts like Cmd+K).
        if (e.ctrlKey || e.metaKey || e.altKey) break
        const op = hotkeyMap.get(e.key)
        if (op) {
          e.preventDefault()
          e.stopPropagation()
          execute(op)
        }
      }
    }
  }

  let inputCollapsed = $derived(!query && !inputFocused)
</script>

{#if open}
  <div class="modal-backdrop" onclick={close} role="presentation"></div>
  <div
    bind:this={modalEl}
    class="modal"
    onkeydown={handleKeydown}
    role="dialog"
    aria-modal="true"
    aria-label="Git operations"
    aria-describedby="git-footer"
    tabindex="-1"
  >
    <div class="modal-header">
      Git
      <span class="git-header-hint"><kbd class="key">/</kbd> to filter</span>
    </div>
    {#if remotes.length > 1}
      <div class="git-remotes">
        <span class="git-remotes-label">remote:</span>
        {#each remotes as r}
          <button
            class="git-remote-pill"
            class:active={r === selectedRemote}
            onclick={() => { remoteOverride = r; cursor.index = 0 }}
          >{r}</button>
        {/each}
        <span class="git-remotes-hint">h/l</span>
      </div>
    {/if}
    <input
      bind:this={inputEl}
      bind:value={query}
      class="modal-input"
      class:git-input-collapsed={inputCollapsed}
      type="text"
      placeholder="Filter..."
      tabindex={inputCollapsed ? -1 : 0}
      aria-hidden={inputCollapsed}
      oninput={() => { cursor.index = 0 }}
      onfocus={() => { inputFocused = true }}
      onblur={() => { inputFocused = false }}
    />
    <!-- Hover moves the cursor via the factory's delegated mousemove. -->
    <div
      class="git-results"
      role="listbox"
      tabindex="-1"
      aria-label="Git operations"
      aria-activedescendant={selected ? `git-opt-${cursor.index}` : undefined}
      onmousemove={cursor.onRowsMouseMove}
      onmouseleave={cursor.onRowsMouseLeave}
    >
      {#if data.loading}
        <div class="git-empty">Loading...</div>
      {:else if data.error}
        <div class="git-empty git-error" role="alert">{data.error}</div>
      {:else if filtered.length === 0}
        <div class="git-empty">No matching operations</div>
      {:else}
        {#each sections as section}
          <div class="git-section-header">{section.header}</div>
          {#each section.ops as { op, globalIndex } (globalIndex)}
            <!-- svelte-ignore a11y_click_events_have_key_events -->
            <div
              id="git-opt-{globalIndex}"
              class="git-item"
              class:git-item-active={globalIndex === cursor.index}
              data-idx={globalIndex}
              onclick={() => execute(op)}
              role="option"
              tabindex="-1"
              aria-selected={globalIndex === cursor.index}
            >
              <div class="git-title" class:is-push={op.type === 'push'} class:is-fetch={op.type === 'fetch'}>
                {op.title}
                {#if op.here}<span class="git-here" title="on selected revision" aria-label="on selected revision">▸</span>{/if}
                {#if op.bookmark}<span class="git-bm-badge">⑂ {op.bookmark}</span>{/if}
                {#if op.changeId}<span class="git-change-chip">{op.changeId}</span>{/if}
                {#if op.scope}<span class="git-scope-chip">{op.scope}</span>{/if}
                {#if op.hotkey}<kbd class="git-hotkey">{op.hotkey}</kbd>{/if}
              </div>
              <div class="git-cmd">git {op.type} {op.flags.join(' ')}</div>
            </div>
          {/each}
        {/each}
      {/if}
    </div>
    <div id="git-footer" class="key-footer">
      <span><kbd>⏎</kbd> execute</span>
      <span><kbd>j</kbd><kbd>k</kbd> navigate</span>
      {#if remotes.length > 1}<span><kbd>h</kbd><kbd>l</kbd> remote</span>{/if}
      <span><kbd>Esc</kbd> close</span>
    </div>
  </div>
{/if}

<style>
  .git-header-hint {
    font-weight: 400;
    text-transform: none;
    letter-spacing: 0;
    color: var(--text-faint);
  }

  .git-remotes {
    display: flex;
    gap: 4px;
    padding: 6px 16px;
    border-bottom: 1px solid var(--surface0);
    align-items: center;
  }
  .git-remotes-label { font-size: var(--fs-sm); color: var(--overlay0); }
  .git-remotes-hint { font-size: var(--fs-xs); color: var(--text-faint); margin-left: auto; }
  .git-remote-pill {
    padding: 2px 8px;
    border: 1px solid var(--surface1);
    border-radius: 10px;
    background: transparent;
    color: var(--subtext0);
    font-size: var(--fs-sm);
    font-family: inherit;
    cursor: pointer;
  }
  .git-remote-pill.active {
    background: var(--surface1);
    color: var(--text);
    border-color: var(--overlay0);
  }

  .modal-input {
    transition: max-height var(--anim-duration) var(--anim-ease), padding var(--anim-duration) var(--anim-ease), opacity var(--anim-duration) var(--anim-ease);
    max-height: 40px;
  }

  .git-input-collapsed {
    max-height: 0;
    padding-top: 0;
    padding-bottom: 0;
    border-bottom-width: 0;
    opacity: 0;
  }

  .git-results {
    overflow-y: auto;
    padding: 4px 0;
    flex: 1;
    min-height: 0;
  }

  .git-section-header {
    padding: 8px 16px 4px;
    font-size: var(--fs-xs);
    font-weight: 700;
    color: var(--overlay0);
    text-transform: uppercase;
    letter-spacing: 0.08em;
    user-select: none;
  }

  .git-section-header:not(:first-child) {
    margin-top: 4px;
    border-top: 1px solid var(--surface0);
    padding-top: 10px;
  }

  .git-item {
    display: block;
    width: 100%;
    padding: 7px 16px;
    font-size: var(--font-size);
    user-select: none;
    cursor: pointer;
  }

  .git-item-active { background: var(--surface0); }

  /* Title line: description + inline badge/chip. Color-coded by op type. */
  .git-title {
    font-size: var(--font-size);
    display: flex;
    align-items: center;
    gap: 6px;
    flex-wrap: wrap;
  }
  .git-title.is-push { color: var(--green); }
  .git-title.is-fetch { color: var(--amber); }

  /* Mirrors RevisionGraph .bookmark-badge — same visual language for
     bookmark identity across the app. */
  .git-here {
    color: var(--amber);
    font-size: var(--fs-sm);
  }

  .git-bm-badge {
    display: inline-flex;
    align-items: center;
    background: var(--bg-bookmark);
    color: var(--subtext0);
    padding: 0 5px;
    border-radius: 3px;
    font-size: var(--fs-xs);
    font-weight: 600;
    border: 1px solid var(--border-bookmark);
    line-height: 1.4;
    letter-spacing: 0.02em;
  }

  /* Scope modifiers (--all, --deleted, --tracked) — hollow chip,
     visually distinct from bookmark badges. */
  .git-scope-chip {
    font-size: var(--fs-xs);
    padding: 0 6px;
    border: 1px solid var(--overlay0);
    border-radius: 3px;
    color: var(--overlay1);
    font-weight: 500;
    line-height: 1.4;
  }

  /* Change-id: mono font, matches commit_id styling elsewhere. */
  .git-change-chip {
    font-family: var(--font-mono, monospace);
    font-size: var(--fs-xs);
    padding: 0 5px;
    background: var(--surface0);
    border-radius: 3px;
    color: var(--overlay1);
    line-height: 1.4;
  }

  /* Hotkey hint — right-aligned, subtle. margin-left:auto pushes it to the end
     of the flex row without an extra wrapper. */
  .git-hotkey {
    margin-left: auto;
    min-width: 16px;
    padding: 1px 5px;
    font-family: var(--font-mono, monospace);
    font-size: var(--fs-xs);
    text-align: center;
    background: var(--surface0);
    border: 1px solid var(--surface1);
    border-radius: 3px;
    color: var(--subtext0);
    flex-shrink: 0;
  }

  /* Raw command — dimmed, mono, below the title. */
  .git-cmd {
    color: var(--overlay0);
    font-family: var(--font-mono, monospace);
    font-size: var(--fs-xs);
    margin-top: 2px;
  }


  .git-empty {
    padding: 16px;
    color: var(--text-faint);
    text-align: center;
    font-size: var(--font-size);
  }

  .git-error { color: var(--red); }

</style>
