<script lang="ts">
  import { api, type Bookmark } from './api'

  interface GitOp {
    label: string
    description: string
    flags: string[]
    type: 'push' | 'fetch'
  }

  interface Props {
    open: boolean
    currentChangeId: string | null
    onexecute: (type: 'push' | 'fetch', flags: string[]) => void
    onclose: () => void
  }

  let { open = $bindable(false), currentChangeId, onexecute, onclose }: Props = $props()

  let index: number = $state(0)
  let bookmarks: Bookmark[] = $state([])
  let remotes: string[] = $state([])
  let loading: boolean = $state(false)
  let modalEl: HTMLDivElement | undefined = $state(undefined)

  function buildOps(bms: Bookmark[], rms: string[], changeId: string | null): GitOp[] {
    const ops: GitOp[] = []
    const remote = rms[0] ?? 'origin'

    // Per-bookmark push for tracked bookmarks
    for (const bm of bms) {
      if (bm.local) {
        ops.push({
          label: `git push --bookmark ${bm.name} --remote ${remote}`,
          description: `Push bookmark ${bm.name} to ${remote}`,
          flags: ['--bookmark', bm.name, '--remote', remote],
          type: 'push',
        })
      }
    }

    // General push options
    ops.push({
      label: `git push --remote ${remote}`,
      description: 'Push tracking bookmarks in the current revset',
      flags: ['--remote', remote],
      type: 'push',
    })

    ops.push({
      label: `git push --all --remote ${remote}`,
      description: 'Push all bookmarks (including new and deleted)',
      flags: ['--all', '--remote', remote],
      type: 'push',
    })

    if (changeId) {
      const short = changeId.slice(0, 8)
      ops.push({
        label: `git push --change ${short} --remote ${remote}`,
        description: `Push the current change (${short})`,
        flags: ['--change', changeId, '--remote', remote],
        type: 'push',
      })
    }

    ops.push({
      label: `git push --deleted --remote ${remote}`,
      description: 'Push all deleted bookmarks',
      flags: ['--deleted', '--remote', remote],
      type: 'push',
    })

    ops.push({
      label: `git push --tracked --remote ${remote}`,
      description: 'Push all tracked bookmarks (including deleted)',
      flags: ['--tracked', '--remote', remote],
      type: 'push',
    })

    // Fetch options
    ops.push({
      label: `git fetch --remote ${remote}`,
      description: `Fetch from ${remote}`,
      flags: ['--remote', remote],
      type: 'fetch',
    })

    if (rms.length > 1) {
      ops.push({
        label: 'git fetch --all-remotes',
        description: 'Fetch from all remotes',
        flags: ['--all-remotes'],
        type: 'fetch',
      })
    }

    return ops
  }

  let ops = $derived(buildOps(bookmarks, remotes, currentChangeId))

  $effect(() => {
    if (open) {
      index = 0
      loading = true
      Promise.all([api.bookmarks(), api.remotes()]).then(([bms, rms]) => {
        bookmarks = bms
        remotes = rms
        loading = false
      }).catch(() => { loading = false })
      requestAnimationFrame(() => modalEl?.focus())
    }
  })

  function close() {
    open = false
    onclose()
  }

  function execute(op: GitOp) {
    close()
    onexecute(op.type, op.flags)
  }

  function scrollActiveIntoView() {
    requestAnimationFrame(() => {
      const el = document.querySelector('.git-item-active')
      el?.scrollIntoView({ block: 'nearest' })
    })
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
      case 'Enter':
        e.preventDefault()
        if (ops[index]) execute(ops[index])
        break
      case 'Escape':
        e.preventDefault()
        close()
        break
    }
  }
</script>

{#if open}
  <div class="git-backdrop" onclick={close} role="presentation"></div>
  <div class="git-modal" bind:this={modalEl} onkeydown={handleKeydown} role="dialog" aria-label="Git operations" tabindex="-1">
    <div class="git-header">Git Operations</div>
    {#if loading}
      <div class="git-empty">Loading...</div>
    {:else}
      <div class="git-results">
        {#each ops as op, i}
          <button
            class="git-item"
            class:git-item-active={i === index}
            onclick={() => execute(op)}
            onmouseenter={() => { index = i }}
          >
            <div class="git-cmd" class:git-push={op.type === 'push'} class:git-fetch={op.type === 'fetch'}>{op.label}</div>
            <div class="git-desc">{op.description}</div>
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

  .git-results {
    overflow-y: auto;
    padding: 4px 0;
  }

  .git-item {
    display: block;
    width: 100%;
    padding: 8px 16px;
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

  .git-cmd {
    font-weight: 600;
    font-size: 12px;
  }

  .git-cmd.git-push {
    color: var(--green);
  }

  .git-cmd.git-fetch {
    color: var(--teal);
  }

  .git-desc {
    color: var(--overlay0);
    font-size: 11px;
    margin-top: 2px;
  }

  .git-empty {
    padding: 16px;
    color: var(--surface2);
    text-align: center;
    font-size: 13px;
  }
</style>
