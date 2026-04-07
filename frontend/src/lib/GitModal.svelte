<script lang="ts">
  import { tick } from 'svelte'
  import { api, type Bookmark } from './api'
  import { createLoader } from './loader.svelte'
  import { fuzzyMatch } from './fuzzy'
  import { scrollIdxIntoView } from './scroll-into-view'

  // Structured op — presentation decided in template, not here.
  // Raw command line is derived: `git ${type} ${flags.join(' ')}`
  interface GitOp {
    type: 'push' | 'fetch'
    title: string
    hotkey?: string    // single-char; rendered as kbd hint + wired into handleKeydown
    bookmark?: string  // → badge (mirrors RevisionGraph's .bookmark-badge)
    scope?: 'all' | 'deleted' | 'tracked' | 'all-remotes'  // → chip
    changeId?: string  // short form, for the --change entry
    flags: string[]
  }

  interface Props {
    open: boolean
    currentChangeId: string | null
    onexecute: (type: 'push' | 'fetch', flags: string[]) => void
  }

  let { open = $bindable(false), currentChangeId, onexecute }: Props = $props()

  let query: string = $state('')
  let index: number = $state(0)
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

  function buildOps(bms: Bookmark[], remote: string, allRemotes: string[], changeId: string | null): GitOp[] {
    const ops: GitOp[] = []
    const r = ['--remote', remote]

    // Bookmarks get 1-9 (first 9 only — beyond that, j/k is faster than scanning for a digit)
    let n = 0
    for (const bm of bms) {
      if (!bm.local) continue
      n++
      ops.push({ type: 'push', title: 'Push bookmark', bookmark: bm.name,
        hotkey: n <= 9 ? String(n) : undefined,
        flags: ['--bookmark', bm.name, ...r] })
    }

    ops.push({ type: 'push', title: 'Push tracking bookmarks in current revset', hotkey: 'p', flags: r })
    ops.push({ type: 'push', title: 'Push all bookmarks (incl. new + deleted)', hotkey: 'a', scope: 'all', flags: ['--all', ...r] })

    if (changeId) {
      const short = changeId.slice(0, 8)
      ops.push({ type: 'push', title: 'Push current change', hotkey: 'c', changeId: short, flags: ['--change', changeId, ...r] })
    }

    ops.push({ type: 'push', title: 'Push deleted bookmarks', hotkey: 'd', scope: 'deleted', flags: ['--deleted', ...r] })
    ops.push({ type: 'push', title: 'Push tracked bookmarks (incl. deleted)', hotkey: 't', scope: 'tracked', flags: ['--tracked', ...r] })

    // Flagless fetch respects git.fetch config (jj's own default-resolution:
    // configured list, else origin). Fork workflows set git.fetch =
    // ["upstream","origin"]; forcing --remote <selected> here would silently
    // drop upstream. The pill selector scopes PUSH ops only.
    ops.push({ type: 'fetch', title: 'Fetch', hotkey: 'f', flags: [] })
    if (allRemotes.length > 1) {
      ops.push({ type: 'fetch', title: `Fetch from ${remote} only`, flags: r })
      ops.push({ type: 'fetch', title: 'Fetch from all remotes', hotkey: 'F', scope: 'all-remotes', flags: ['--all-remotes'] })
    }

    return ops
  }

  let allOps = $derived(buildOps(bookmarks, selectedRemote, remotes, currentChangeId))
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

  // Compute section boundaries for rendering headers
  let sections = $derived.by(() => {
    const result: { header: string; ops: { op: GitOp; globalIndex: number }[] }[] = []
    let currentType = ''
    for (let i = 0; i < filtered.length; i++) {
      const op = filtered[i]
      if (op.type !== currentType) {
        currentType = op.type
        result.push({ header: op.type === 'push' ? 'Push' : 'Fetch', ops: [] })
      }
      result[result.length - 1].ops.push({ op, globalIndex: i })
    }
    return result
  })

  let selected = $derived(filtered[index] as GitOp | undefined)

  $effect(() => {
    if (open) {
      previousFocus = document.activeElement as HTMLElement | null
      query = ''
      index = 0
      remoteOverride = null
      data.load()
      tick().then(() => modalEl?.focus())
    }
  })

  $effect(() => {
    if (open && index >= filtered.length && filtered.length > 0) {
      index = filtered.length - 1
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

  function scrollActiveIntoView() {
    scrollIdxIntoView(modalEl, index)
  }

  function cycleRemote(delta: 1 | -1) {
    if (remotes.length <= 1) return
    const i = remotes.indexOf(selectedRemote)
    remoteOverride = remotes[(i + delta + remotes.length) % remotes.length]
    index = 0
  }

  function handleKeydown(e: KeyboardEvent) {
    switch (e.key) {
      case 'ArrowDown':
      case 'j':
        if (e.key === 'j' && inputFocused) return
        e.preventDefault()
        if (inputFocused) modalEl?.focus()
        index = Math.min(index + 1, Math.max(filtered.length - 1, 0))
        scrollActiveIntoView()
        return
      case 'ArrowUp':
      case 'k':
        if (e.key === 'k' && inputFocused) return
        e.preventDefault()
        index = Math.max(index - 1, 0)
        scrollActiveIntoView()
        return
      case 'ArrowLeft':
      case 'h':
        if (inputFocused) return
        if (remotes.length > 1) { e.preventDefault(); cycleRemote(-1) }
        return
      case 'ArrowRight':
      case 'l':
        if (inputFocused) return
        if (remotes.length > 1) { e.preventDefault(); cycleRemote(1) }
        return
      case 'Enter':
        e.preventDefault()
        e.stopPropagation()
        if (selected) execute(selected)
        return
      case 'Escape':
        e.preventDefault()
        e.stopPropagation()
        if (query) { query = ''; modalEl?.focus(); return }
        close()
        return
      case '/':
        if (inputFocused) return
        e.preventDefault()
        e.stopPropagation()
        inputEl?.focus()
        return
      default: {
        // Single-char hotkey — fires immediately. No modifier keys (they bubble
        // for global shortcuts like Cmd+K). Guard against input focus.
        if (inputFocused || e.ctrlKey || e.metaKey || e.altKey) break
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
            onclick={() => { remoteOverride = r; index = 0 }}
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
      oninput={() => { index = 0 }}
      onfocus={() => { inputFocused = true }}
      onblur={() => { inputFocused = false }}
    />
    <div
      class="git-results"
      role="listbox"
      tabindex="-1"
      aria-label="Git operations"
      aria-activedescendant={selected ? `git-opt-${index}` : undefined}
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
              class:git-item-active={globalIndex === index}
              data-idx={globalIndex}
              onmousemove={() => { if (index !== globalIndex) index = globalIndex }}
              onclick={() => execute(op)}
              role="option"
              tabindex="-1"
              aria-selected={globalIndex === index}
            >
              <div class="git-title" class:is-push={op.type === 'push'} class:is-fetch={op.type === 'fetch'}>
                {op.title}
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
    color: var(--surface2);
  }

  .git-remotes {
    display: flex;
    gap: 4px;
    padding: 6px 16px;
    border-bottom: 1px solid var(--surface0);
    align-items: center;
  }
  .git-remotes-label { font-size: 11px; color: var(--overlay0); }
  .git-remotes-hint { font-size: 10px; color: var(--surface2); margin-left: auto; }
  .git-remote-pill {
    padding: 2px 8px;
    border: 1px solid var(--surface1);
    border-radius: 10px;
    background: transparent;
    color: var(--subtext0);
    font-size: 11px;
    font-family: inherit;
    cursor: pointer;
  }
  .git-remote-pill.active {
    background: var(--surface1);
    color: var(--text);
    border-color: var(--overlay0);
  }

  .modal-input {
    transition: max-height 0.12s ease, padding 0.12s ease, opacity 0.12s ease;
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
    font-size: 10px;
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
    font-size: 13px;
    user-select: none;
    cursor: pointer;
  }

  .git-item-active { background: var(--surface0); }

  /* Title line: description + inline badge/chip. Color-coded by op type. */
  .git-title {
    font-size: 13px;
    display: flex;
    align-items: center;
    gap: 6px;
    flex-wrap: wrap;
  }
  .git-title.is-push { color: var(--green); }
  .git-title.is-fetch { color: var(--amber); }

  /* Mirrors RevisionGraph .bookmark-badge — same visual language for
     bookmark identity across the app. */
  .git-bm-badge {
    display: inline-flex;
    align-items: center;
    background: var(--bg-bookmark);
    color: var(--subtext0);
    padding: 0 5px;
    border-radius: 3px;
    font-size: 10px;
    font-weight: 600;
    border: 1px solid var(--border-bookmark);
    line-height: 1.4;
    letter-spacing: 0.02em;
  }

  /* Scope modifiers (--all, --deleted, --tracked) — hollow chip,
     visually distinct from bookmark badges. */
  .git-scope-chip {
    font-size: 10px;
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
    font-size: 10px;
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
    font-size: 10px;
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
    font-size: 10px;
    margin-top: 2px;
  }


  .git-empty {
    padding: 16px;
    color: var(--surface2);
    text-align: center;
    font-size: 13px;
  }

  .git-error { color: var(--red); }

</style>
