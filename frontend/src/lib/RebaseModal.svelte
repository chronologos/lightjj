<script lang="ts">
  import type { LogEntry } from './api'
  import { fuzzyMatch } from './fuzzy'

  interface Props {
    open: boolean
    revisions: string[]
    candidates: LogEntry[]
    onexecute: (destination: string) => void
    onclose: () => void
  }

  let { open = $bindable(false), revisions, candidates, onexecute, onclose }: Props = $props()

  let query: string = $state('')
  let index: number = $state(0)
  let inputEl: HTMLInputElement | undefined = $state(undefined)

  let sourceSet = $derived(new Set(revisions))

  let filtered = $derived.by(() => {
    if (!open) return []
    let items = candidates.filter(c => !sourceSet.has(c.commit.change_id))
    if (query) {
      items = items.filter(c =>
        fuzzyMatch(query, c.commit.change_id) ||
        fuzzyMatch(query, c.description) ||
        (c.bookmarks ?? []).some(bm => fuzzyMatch(query, bm))
      )
    }
    return items
  })

  $effect(() => {
    if (open) {
      query = ''
      index = 0
      requestAnimationFrame(() => inputEl?.focus())
    }
  })

  function close() {
    open = false
    onclose()
  }

  function execute(entry: LogEntry) {
    close()
    onexecute(entry.commit.change_id)
  }

  function scrollActiveIntoView() {
    requestAnimationFrame(() => {
      const el = document.querySelector('.rb-item-active')
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
        index = Math.min(index + 1, filtered.length - 1)
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
        if (filtered[index]) execute(filtered[index])
        break
      case 'Escape':
        e.preventDefault()
        close()
        break
    }
  }

  function shortId(entry: LogEntry): { prefix: string; rest: string } {
    const id = entry.commit.change_id
    const n = entry.commit.change_prefix
    return { prefix: id.slice(0, n), rest: id.slice(n, 12) }
  }
</script>

{#if open}
  <div class="rb-backdrop" onclick={close} role="presentation"></div>
  <div class="rb-modal" onkeydown={handleKeydown} role="dialog" aria-label="Rebase revision" tabindex="-1">
    <div class="rb-header">
      Rebase {revisions.length > 1 ? `${revisions.length} revisions` : revisions[0]?.slice(0, 8)} onto...
    </div>
    <input
      bind:this={inputEl}
      bind:value={query}
      class="rb-input"
      type="text"
      placeholder="Filter destination..."
      oninput={() => { index = 0 }}
    />
    <div class="rb-results">
      {#if filtered.length === 0}
        <div class="rb-empty">No matching revisions</div>
      {:else}
        {#each filtered as entry, i}
          <button
            class="rb-item"
            class:rb-item-active={i === index}
            onclick={() => execute(entry)}
            onmouseenter={() => { index = i }}
          >
            {@const id = shortId(entry)}
            <span class="rb-change-id">
              <span class="rb-id-prefix">{id.prefix}</span><span class="rb-id-rest">{id.rest}</span>
            </span>
            <span class="rb-desc">{entry.description || '(no description)'}</span>
            {#if entry.bookmarks?.length}
              <span class="rb-bookmarks">
                {#each entry.bookmarks as bm}
                  <span class="rb-bookmark">{bm}</span>
                {/each}
              </span>
            {/if}
          </button>
        {/each}
      {/if}
    </div>
  </div>
{/if}

<style>
  .rb-backdrop {
    position: fixed;
    inset: 0;
    background: var(--backdrop);
    z-index: 100;
  }

  .rb-modal {
    position: fixed;
    top: 20%;
    left: 50%;
    transform: translateX(-50%);
    width: 540px;
    max-height: 400px;
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

  .rb-header {
    padding: 10px 16px 6px;
    font-size: 12px;
    font-weight: 700;
    color: var(--subtext0);
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }

  .rb-input {
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

  .rb-input::placeholder {
    color: var(--surface2);
  }

  .rb-results {
    overflow-y: auto;
    padding: 4px 0;
  }

  .rb-item {
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

  .rb-item-active {
    background: var(--surface0);
  }

  .rb-change-id {
    flex-shrink: 0;
    font-size: 12px;
  }

  .rb-id-prefix {
    color: var(--teal);
    font-weight: 700;
  }

  .rb-id-rest {
    color: var(--overlay0);
  }

  .rb-desc {
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--subtext1);
  }

  .rb-bookmarks {
    display: flex;
    gap: 4px;
    flex-shrink: 0;
  }

  .rb-bookmark {
    font-size: 11px;
    padding: 1px 5px;
    border-radius: 3px;
    background: var(--bg-bookmark);
    border: 1px solid var(--border-bookmark);
    color: var(--green);
  }

  .rb-empty {
    padding: 16px;
    color: var(--surface2);
    text-align: center;
    font-size: 13px;
  }
</style>
