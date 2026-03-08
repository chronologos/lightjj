<script lang="ts">
  import { api, type Bookmark } from './api'
  import { fuzzyMatch } from './fuzzy'

  interface Props {
    open: boolean
    onsave: (name: string) => void
  }

  let { open = $bindable(false), onsave }: Props = $props()

  let value: string = $state('')
  let inputEl: HTMLInputElement | undefined = $state(undefined)
  let suggestions: string[] = $state([])
  let suggestionsError: string = $state('')
  let selectedSuggestion: number = $state(-1)
  let previousFocus: HTMLElement | null = null

  let filtered = $derived.by(() => {
    if (!open || !value) return []
    return suggestions.filter(s => fuzzyMatch(value, s)).slice(0, 8)
  })

  $effect(() => {
    if (open) {
      previousFocus = document.activeElement as HTMLElement | null
      value = ''
      selectedSuggestion = -1
      suggestionsError = ''
      api.bookmarks({ local: true }).then((bms: Bookmark[]) => {
        suggestions = bms.map(b => b.name)
      }).catch((e) => {
        suggestionsError = e instanceof Error ? e.message : 'Failed to load bookmarks'
      })
      inputEl?.focus()
    }
  })

  function submit() {
    const name = filtered[selectedSuggestion] ?? value.trim()
    if (name) onsave(name)
  }

  function close() {
    open = false
    previousFocus?.focus()
  }

  function handleKeydown(e: KeyboardEvent) {
    switch (e.key) {
      case 'Enter':
        e.preventDefault()
        e.stopPropagation()
        submit()
        break
      case 'Escape':
        e.preventDefault()
        e.stopPropagation()
        close()
        break
      case 'ArrowDown':
        if (filtered.length > 0) {
          e.preventDefault()
          selectedSuggestion = Math.min(selectedSuggestion + 1, filtered.length - 1)
          value = filtered[selectedSuggestion]
        }
        break
      case 'ArrowUp':
        if (filtered.length > 0) {
          e.preventDefault()
          selectedSuggestion = Math.max(selectedSuggestion - 1, 0)
          value = filtered[selectedSuggestion]
        }
        break
    }
  }
</script>

{#if open}
  <div class="bm-set-backdrop" onclick={close} role="presentation"></div>
  <div class="bm-set-modal">
    <div class="bm-set-header">Set Bookmark</div>
    <input
      bind:this={inputEl}
      bind:value
      class="bm-set-input"
      type="text"
      placeholder="Type bookmark name..."
      onkeydown={handleKeydown}
      oninput={() => { selectedSuggestion = -1 }}
    />
    {#if suggestionsError}
      <div class="bm-set-error">⚠ {suggestionsError}</div>
    {:else if filtered.length > 0}
      <div class="bm-set-suggestions">
        {#each filtered as suggestion, i}
          <button
            class="bm-set-suggestion"
            class:active={i === selectedSuggestion}
            onmousedown={(e: MouseEvent) => { e.preventDefault(); value = suggestion; submit() }}
          >
            <span class="bm-set-move-hint">move</span> {suggestion} → here
          </button>
        {/each}
      </div>
    {/if}
    <div class="bm-set-hint">Enter to set · Escape to cancel · ↑↓ to select existing</div>
  </div>
{/if}

<style>
  .bm-set-backdrop {
    position: fixed;
    inset: 0;
    background: var(--backdrop);
    z-index: 100;
  }

  .bm-set-modal {
    position: fixed;
    top: 25%;
    left: 50%;
    transform: translateX(-50%);
    width: 400px;
    background: var(--base);
    border: 1px solid var(--surface1);
    border-radius: 8px;
    box-shadow: var(--shadow-heavy);
    z-index: 101;
    overflow: hidden;
  }

  .bm-set-header {
    padding: 10px 16px 6px;
    font-size: 12px;
    font-weight: 700;
    color: var(--subtext0);
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }

  .bm-set-input {
    width: 100%;
    background: var(--mantle);
    color: var(--text);
    border: none;
    border-bottom: 1px solid var(--surface0);
    padding: 10px 16px;
    font-family: inherit;
    font-size: 14px;
    outline: none;
  }

  .bm-set-input::placeholder {
    color: var(--surface2);
  }

  .bm-set-suggestions {
    border-bottom: 1px solid var(--surface0);
  }

  .bm-set-suggestion {
    display: block;
    width: 100%;
    padding: 6px 16px;
    background: transparent;
    border: none;
    color: var(--text);
    font-family: inherit;
    font-size: 13px;
    text-align: left;
    cursor: pointer;
  }

  .bm-set-suggestion:hover,
  .bm-set-suggestion.active {
    background: var(--surface0);
  }

  .bm-set-move-hint {
    color: var(--amber);
    font-size: 11px;
    font-weight: 600;
    text-transform: uppercase;
  }

  .bm-set-error {
    padding: 8px 16px;
    font-size: 12px;
    color: var(--red);
    border-bottom: 1px solid var(--surface0);
  }

  .bm-set-hint {
    padding: 6px 16px;
    font-size: 11px;
    color: var(--surface2);
  }
</style>
