<script lang="ts">
  import { api, type Bookmark } from './api'
  import { fuzzyMatch } from './fuzzy'

  export interface BookmarkOp {
    action: 'move' | 'delete' | 'forget' | 'track' | 'untrack'
    bookmark: string
    remote?: string
  }

  interface Props {
    open: boolean
    currentCommitId: string | null
    filterBookmark: string
    onexecute: (op: BookmarkOp) => void
    onclose: () => void
  }

  let { open = $bindable(false), currentCommitId, filterBookmark, onexecute, onclose }: Props = $props()

  let query: string = $state('')
  let index: number = $state(0)
  let inputEl: HTMLInputElement | undefined = $state(undefined)
  let bookmarks: Bookmark[] = $state([])
  let remotes: string[] = $state([])
  let loading: boolean = $state(false)
  let fetchError: string | null = $state(null)
  let previousFocus: HTMLElement | null = null
  let fetchGen: number = 0

  function opLabel(op: BookmarkOp): string {
    const suffix = op.remote ? `@${op.remote}` : ''
    return `${op.action} ${op.bookmark}${suffix}`
  }

  function buildOps(bms: Bookmark[], changeId: string | null, availableRemotes: string[]): BookmarkOp[] {
    const ops: BookmarkOp[] = []
    for (const bm of bms) {
      if (changeId && bm.commit_id !== changeId) {
        ops.push({ action: 'move', bookmark: bm.name })
      }
      if (bm.local) {
        ops.push({ action: 'delete', bookmark: bm.name })
      }
      ops.push({ action: 'forget', bookmark: bm.name })
      // Track/untrack for existing remote entries
      for (const remote of bm.remotes ?? []) {
        const action = remote.tracked ? 'untrack' : 'track'
        ops.push({ action, bookmark: bm.name, remote: remote.remote })
      }
      // Offer track for local-only bookmarks against available remotes
      if (bm.local && (!bm.remotes || bm.remotes.length === 0)) {
        for (const remote of availableRemotes) {
          ops.push({ action: 'track', bookmark: bm.name, remote })
        }
      }
    }
    return ops
  }

  let allOps = $derived(buildOps(bookmarks, currentCommitId, remotes))

  let filteredOps = $derived.by(() => {
    if (!open) return []
    let ops = allOps
    if (filterBookmark) {
      ops = ops.filter(op => op.bookmark === filterBookmark)
    }
    if (query) {
      ops = ops.filter(op => fuzzyMatch(query, opLabel(op)))
    }
    return ops
  })

  $effect(() => {
    if (open) {
      previousFocus = document.activeElement as HTMLElement | null
      query = ''
      index = 0
      loading = true
      fetchError = null
      const gen = ++fetchGen
      Promise.all([api.bookmarks(), api.remotes()]).then(([bms, rms]) => {
        if (gen !== fetchGen) return
        bookmarks = bms
        remotes = rms
        loading = false
      }).catch((e) => { if (gen === fetchGen) { loading = false; fetchError = e.message || 'Failed to load' } })
      inputEl?.focus()
    }
  })

  // Clamp index when filtered list shrinks
  $effect(() => {
    if (open && index >= filteredOps.length && filteredOps.length > 0) {
      index = filteredOps.length - 1
    }
  })

  function close() {
    fetchError = null
    open = false
    onclose()
    previousFocus?.focus()
  }

  function execute(op: BookmarkOp) {
    close()
    onexecute(op)
  }

  function scrollActiveIntoView() {
    requestAnimationFrame(() => {
      const el = document.querySelector('.bm-item-active')
      el?.scrollIntoView({ block: 'nearest' })
    })
  }

  function handleKeydown(e: KeyboardEvent) {
    const inInput = document.activeElement === inputEl
    switch (e.key) {
      case 'ArrowDown':
      case 'j':
        if (e.key === 'j' && inInput) break
        e.preventDefault()
        index = Math.min(index + 1, Math.max(filteredOps.length - 1, 0))
        scrollActiveIntoView()
        break
      case 'ArrowUp':
      case 'k':
        if (e.key === 'k' && inInput) break
        e.preventDefault()
        index = Math.max(index - 1, 0)
        scrollActiveIntoView()
        break
      case 'Enter':
        e.preventDefault()
        e.stopPropagation()
        if (filteredOps[index]) execute(filteredOps[index])
        break
      case 'Escape':
        e.preventDefault()
        e.stopPropagation()
        close()
        break
    }
  }

  const actionColors: Record<string, string> = {
    move: 'var(--blue)',
    delete: 'var(--red)',
    forget: 'var(--yellow)',
    track: 'var(--green)',
    untrack: 'var(--overlay0)',
  }
</script>

{#if open}
  <div class="bm-backdrop" onclick={close} role="presentation"></div>
  <div class="bm-modal" onkeydown={handleKeydown} role="dialog" aria-label="Bookmark operations" tabindex="-1">
    <div class="bm-header">Bookmark Operations</div>
    <input
      bind:this={inputEl}
      bind:value={query}
      class="bm-input"
      type="text"
      placeholder="Filter bookmarks..."
      oninput={() => { index = 0 }}
    />
    <div class="bm-results">
      {#if loading}
        <div class="bm-empty">Loading bookmarks...</div>
      {:else if fetchError}
        <div class="bm-empty" style="color: var(--red)">{fetchError}</div>
      {:else if filteredOps.length === 0}
        <div class="bm-empty">No matching operations</div>
      {:else}
        {#each filteredOps as op, i}
          <button
            class="bm-item"
            class:bm-item-active={i === index}
            onclick={() => execute(op)}
            onmouseenter={() => { index = i }}
          >
            <span class="bm-action" style="color: {actionColors[op.action]}">{op.action}</span>
            <span class="bm-label">{op.bookmark}{#if op.remote}@{op.remote}{/if}</span>
            {#if op.action === 'move'}
              <span class="bm-arrow">→ here</span>
            {/if}
          </button>
        {/each}
      {/if}
    </div>
  </div>
{/if}

<style>
  .bm-backdrop {
    position: fixed;
    inset: 0;
    background: var(--backdrop);
    z-index: 100;
  }

  .bm-modal {
    position: fixed;
    top: 20%;
    left: 50%;
    transform: translateX(-50%);
    width: 480px;
    max-height: 400px;
    background: var(--base);
    border: 1px solid var(--surface1);
    border-radius: 8px;
    box-shadow: var(--shadow-heavy);
    z-index: 101;
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }

  .bm-header {
    padding: 10px 16px 6px;
    font-size: 12px;
    font-weight: 700;
    color: var(--subtext0);
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }

  .bm-input {
    width: 100%;
    background: var(--mantle);
    color: var(--text);
    border: none;
    border-bottom: 1px solid var(--surface0);
    padding: 8px 16px;
    font-family: inherit;
    font-size: 13px;
    outline: none;
  }

  .bm-input::placeholder {
    color: var(--surface2);
  }

  .bm-results {
    overflow-y: auto;
    padding: 4px 0;
  }

  .bm-item {
    display: flex;
    align-items: center;
    gap: 8px;
    width: 100%;
    padding: 6px 16px;
    background: transparent;
    border: none;
    color: var(--text);
    font-family: inherit;
    font-size: 13px;
    cursor: pointer;
    text-align: left;
  }

  .bm-item-active {
    background: var(--surface0);
  }

  .bm-action {
    font-size: 11px;
    font-weight: 700;
    min-width: 52px;
    text-transform: uppercase;
  }

  .bm-label {
    flex: 1;
  }

  .bm-arrow {
    color: var(--surface2);
    font-size: 11px;
  }

  .bm-empty {
    padding: 16px;
    color: var(--surface2);
    text-align: center;
    font-size: 13px;
  }
</style>
