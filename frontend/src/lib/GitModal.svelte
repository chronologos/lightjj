<script lang="ts">
  import { api, type Bookmark } from './api'

  // Structured op — presentation decided in template, not here.
  // Raw command line is derived: `git ${type} ${flags.join(' ')}`
  interface GitOp {
    type: 'push' | 'fetch'
    flags: string[]
    title: string
    hotkey?: string    // single-char; rendered as kbd hint + wired into handleKeydown
    bookmark?: string  // → badge (mirrors RevisionGraph's .bookmark-badge)
    scope?: 'all' | 'deleted' | 'tracked' | 'all-remotes'  // → chip
    changeId?: string  // short form, for the --change entry
  }

  interface Props {
    open: boolean
    currentChangeId: string | null
    onexecute: (type: 'push' | 'fetch', flags: string[]) => void
  }

  let { open = $bindable(false), currentChangeId, onexecute }: Props = $props()

  let index: number = $state(0)
  let bookmarks: Bookmark[] = $state([])
  let remotes: string[] = $state([])
  let selectedRemote: string = $state('origin')
  let loading: boolean = $state(false)
  let fetchError: string | null = $state(null)
  let modalEl: HTMLDivElement | undefined = $state(undefined)
  let previousFocus: HTMLElement | null = null
  let fetchGen: number = 0

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

    ops.push({ type: 'fetch', title: 'Fetch', hotkey: 'f', flags: r })
    if (allRemotes.length > 1) {
      ops.push({ type: 'fetch', title: 'Fetch from all remotes', hotkey: 'F', scope: 'all-remotes', flags: ['--all-remotes'] })
    }

    return ops
  }

  let ops = $derived(buildOps(bookmarks, selectedRemote, remotes, currentChangeId))
  let hotkeyMap = $derived(new Map(ops.filter(o => o.hotkey).map(o => [o.hotkey!, o])))

  $effect(() => {
    if (open) {
      previousFocus = document.activeElement as HTMLElement | null
      index = 0
      loading = true
      fetchError = null
      const gen = ++fetchGen
      Promise.all([api.bookmarks(), api.remotes()]).then(([bms, rms]) => {
        if (gen !== fetchGen) return
        bookmarks = bms
        remotes = rms
        selectedRemote = rms[0] ?? 'origin' // backend sorts default-remote first
        loading = false
      }).catch((e) => { if (gen === fetchGen) { loading = false; fetchError = e.message || 'Failed to load' } })
      modalEl?.focus()
    }
  })

  function close() {
    fetchError = null
    open = false
    previousFocus?.focus()
  }

  function execute(op: GitOp) {
    close()
    onexecute(op.type, op.flags)
  }

  function scrollActiveIntoView() {
    requestAnimationFrame(() => {
      modalEl?.querySelector('.git-item-active')?.scrollIntoView({ block: 'nearest' })
    })
  }

  function cycleRemote(delta: 1 | -1) {
    if (remotes.length <= 1) return
    const i = remotes.indexOf(selectedRemote)
    selectedRemote = remotes[(i + delta + remotes.length) % remotes.length]
    index = 0
  }

  function handleKeydown(e: KeyboardEvent) {
    switch (e.key) {
      case 'ArrowDown':
      case 'j':
        e.preventDefault()
        index = Math.min(index + 1, ops.length - 1)
        scrollActiveIntoView()
        break
      case 'ArrowUp':
      case 'k':
        e.preventDefault()
        index = Math.max(index - 1, 0)
        scrollActiveIntoView()
        break
      case 'ArrowLeft':
      case 'h':
        if (remotes.length > 1) { e.preventDefault(); cycleRemote(-1) }
        break
      case 'ArrowRight':
      case 'l':
        if (remotes.length > 1) { e.preventDefault(); cycleRemote(1) }
        break
      case 'Enter':
        e.preventDefault()
        e.stopPropagation()
        if (ops[index]) execute(ops[index])
        break
      case 'Escape':
        e.preventDefault()
        e.stopPropagation()
        close()
        break
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
</script>

{#if open}
  <div class="git-backdrop" onclick={close} role="presentation"></div>
  <div class="git-modal" bind:this={modalEl} onkeydown={handleKeydown} role="dialog" aria-label="Git operations" tabindex="-1">
    <div class="git-header">Git Operations</div>
    {#if remotes.length > 1}
      <div class="git-remotes">
        <span class="git-remotes-label">remote:</span>
        {#each remotes as r}
          <button
            class="git-remote-pill"
            class:active={r === selectedRemote}
            onclick={() => { selectedRemote = r; index = 0 }}
          >{r}</button>
        {/each}
        <span class="git-remotes-hint">←/→</span>
      </div>
    {/if}
    {#if loading}
      <div class="git-empty">Loading...</div>
    {:else if fetchError}
      <div class="git-empty" style="color: var(--red)">{fetchError}</div>
    {:else}
      <div class="git-results">
        {#each ops as op, i}
          <button
            class="git-item"
            class:git-item-active={i === index}
            onclick={() => execute(op)}
            onmouseenter={() => { index = i }}
          >
            <div class="git-title" class:is-push={op.type === 'push'} class:is-fetch={op.type === 'fetch'}>
              {op.title}
              {#if op.bookmark}<span class="git-bm-badge">⑂ {op.bookmark}</span>{/if}
              {#if op.changeId}<span class="git-change-chip">{op.changeId}</span>{/if}
              {#if op.scope}<span class="git-scope-chip">{op.scope}</span>{/if}
              {#if op.hotkey}<kbd class="git-hotkey">{op.hotkey}</kbd>{/if}
            </div>
            <div class="git-cmd">git {op.type} {op.flags.join(' ')}</div>
          </button>
        {/each}
      </div>
    {/if}
  </div>
{/if}

<style>
  .git-backdrop {
    position: fixed;
    inset: 0;
    background: var(--backdrop);
    z-index: 100;
  }

  .git-modal {
    position: fixed;
    top: 15%;
    left: 50%;
    transform: translateX(-50%);
    width: 560px;
    max-height: 500px;
    background: var(--base);
    border: 1px solid var(--surface1);
    border-radius: 8px;
    box-shadow: var(--shadow-heavy);
    z-index: 101;
    display: flex;
    flex-direction: column;
    overflow: hidden;
    outline: none;
  }

  .git-header {
    padding: 10px 16px 6px;
    font-size: 12px;
    font-weight: 700;
    color: var(--subtext0);
    text-transform: uppercase;
    letter-spacing: 0.05em;
    border-bottom: 1px solid var(--surface0);
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

  .git-results {
    overflow-y: auto;
    padding: 4px 0;
  }

  .git-item {
    display: block;
    width: 100%;
    padding: 7px 16px;
    background: transparent;
    border: none;
    color: var(--text);
    font-family: inherit;
    font-size: 13px;
    cursor: pointer;
    text-align: left;
  }

  .git-item-active {
    background: var(--surface0);
  }

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
</style>
