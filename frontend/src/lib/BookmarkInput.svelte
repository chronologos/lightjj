<script lang="ts">
  import { api, type Bookmark } from './api'
  import { fuzzyMatch } from './fuzzy'
  import { recentActions } from './recent-actions.svelte'

  interface Props {
    open: boolean
    onsave: (name: string) => void
  }

  let { open = $bindable(false), onsave }: Props = $props()

  // Shared namespace with BookmarkModal — setting a bookmark here bumps its
  // rank in the `b` modal's frequency sort too.
  const history = recentActions('bookmark-modal')

  // Trunk-name pattern. jj's trunk() alias defaults to checking these against
  // @origin in this order; we match the same names as a heuristic for "default
  // branch you'd want to advance". No API call to resolve trunk() — it's a
  // revset function, not a bookmark query.
  const TRUNK_NAMES = new Set(['main', 'master', 'trunk'])

  let value: string = $state('')
  let inputEl: HTMLInputElement | undefined = $state(undefined)
  let bookmarks: Bookmark[] = $state([])
  let suggestionsError: string = $state('')
  let selectedSuggestion: number = $state(-1)
  let previousFocus: HTMLElement | null = null

  let filtered = $derived.by(() => {
    if (!open) return []
    if (value) return bookmarks.filter(b => fuzzyMatch(value, b.name)).slice(0, 8)
    // Empty input: surface conflicted bookmarks (why you'd open this dialog
    // mid-conflict) then trunk names (common advance target). 5 is enough for
    // an at-a-glance pick — more and you'd type to filter anyway.
    // +bool coercion: true→1, false→0; b-a for descending (trues first).
    const counts = history.snapshot()
    return [...bookmarks]
      .sort((a, b) =>
        (+b.conflict - +a.conflict) ||
        (+TRUNK_NAMES.has(b.name) - +TRUNK_NAMES.has(a.name)) ||
        ((counts[b.name] ?? 0) - (counts[a.name] ?? 0))
      )
      .slice(0, 5)
  })

  $effect(() => {
    if (open) {
      previousFocus = document.activeElement as HTMLElement | null
      value = ''
      selectedSuggestion = -1
      suggestionsError = ''
      api.bookmarks({ local: true }).then((bms: Bookmark[]) => {
        bookmarks = bms
      }).catch((e) => {
        suggestionsError = e instanceof Error ? e.message : 'Failed to load bookmarks'
      })
      inputEl?.focus()
    }
  })

  function submit() {
    const name = filtered[selectedSuggestion]?.name ?? value.trim()
    if (!name) return
    history.record(name)
    onsave(name)
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
      // Arrows move the highlight only — they do NOT write `value`. Writing
      // `value` would flip `filtered` from the default-sort branch to the
      // fuzzy-filter branch, collapsing the list to items matching the first
      // selection's name. submit() already reads filtered[selectedSuggestion]
      // first, so the highlight alone is enough.
      case 'ArrowDown':
        if (filtered.length > 0) {
          e.preventDefault()
          selectedSuggestion = Math.min(selectedSuggestion + 1, filtered.length - 1)
        }
        break
      case 'ArrowUp':
        if (filtered.length > 0) {
          e.preventDefault()
          selectedSuggestion = Math.max(selectedSuggestion - 1, 0)
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
        {#each filtered as bm, i (bm.name)}
          <button
            class="bm-set-suggestion"
            class:active={i === selectedSuggestion}
            onmousedown={(e: MouseEvent) => { e.preventDefault(); value = bm.name; submit() }}
          >
            <span class="bm-set-move-hint" class:bm-set-resolve={bm.conflict}>
              {bm.conflict ? 'resolve' : 'move'}
            </span>
            {bm.name}{#if bm.conflict}<span class="bm-set-conflict-badge">??</span>{/if} → here
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
  .bm-set-move-hint.bm-set-resolve {
    color: var(--red);
  }

  /* Matches .conflict-marker in RevisionGraph — `??` is jj's own decorator,
     glued to the name with no whitespace (staging??, not staging ??). */
  .bm-set-conflict-badge {
    color: var(--red);
    font-weight: 600;
    margin-left: 1px;
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
