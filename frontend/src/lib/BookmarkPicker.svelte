<script lang="ts">
  // Shared autocomplete bookmark picker — the input-modal-with-suggestions
  // skeleton that BookmarkInput and DestinationInput previously hand-rolled
  // (~80% line-for-line identical, with drift: only one had tick()-deferred
  // focus, only one stopped key propagation). This component is the union of
  // the safe behaviors:
  //   - tick()-deferred input focus ({#if open} hasn't mounted when the open
  //     $effect fires — a synchronous focus() silently no-ops on first open)
  //   - stopPropagation on every key (inline modes' handleInlineNav swallows
  //     ALL keys; anything that bubbles from here would be re-dispatched as a
  //     mode key — `d` typed in this input would flip rebase targetMode to -d)
  // Wrappers own: ranking/capping the suggestion list, row rendering, recency
  // recording, and whether picking closes the modal.
  import { tick } from 'svelte'
  import type { Snippet } from 'svelte'
  import { api, type Bookmark } from './api'
  import { createListCursor } from './list-cursor.svelte'

  interface Props {
    open: boolean
    /** Header text (uppercased by CSS). */
    title: string
    placeholder: string
    /** Footer hint line. */
    hint: string
    /** Filter + sort + cap the suggestion list for the current input value. */
    rank: (bookmarks: Bookmark[], value: string) => Bookmark[]
    /** Resolved pick: the highlighted suggestion's name, or the trimmed raw
     *  input (DestinationInput's change_id/revset pass-through). */
    onpick: (name: string) => void
    /** Close (and restore focus) before onpick fires. Default false —
     *  BookmarkInput stays open until App's mutation closes it. */
    closeOnPick?: boolean
    /** Render bookmark-fetch errors inline. Default false = silent
     *  (suggestions stay empty; typing + submitting still works). */
    showError?: boolean
    /** Suggestion row content. */
    row: Snippet<[Bookmark]>
  }

  let { open = $bindable(false), title, placeholder, hint, rank, onpick, closeOnPick = false, showError = false, row }: Props = $props()

  let value: string = $state('')
  let inputEl: HTMLInputElement | undefined = $state(undefined)
  let bookmarks: Bookmark[] = $state([])
  let error: string = $state('')
  let previousFocus: HTMLElement | null = null

  let filtered = $derived(open ? rank(bookmarks, value) : [])

  // Suggestion highlight via the shared cursor factory. -1 = nothing
  // highlighted (Enter submits the raw typed value). The input always holds
  // focus, so inputFocused: () => true makes j/k type while ArrowUp/ArrowDown
  // move the highlight. Arrows do NOT write `value` — that would flip
  // `filtered` from the default-sort branch to the fuzzy-filter branch,
  // collapsing the list to items matching the first selection's name.
  // submit() reads filtered[cursor.index] first, so the highlight is enough.
  const cursor = createListCursor({
    count: () => filtered.length,
    initialIndex: -1,
    inputFocused: () => true,
    onEnter: () => submit(),
    onEscape: () => close(),
  })

  $effect(() => {
    if (!open) return
    previousFocus = document.activeElement as HTMLElement | null
    value = ''
    cursor.index = -1
    error = ''
    api.bookmarks({ local: true })
      .then((bms: Bookmark[]) => { bookmarks = bms })
      .catch((e: unknown) => { error = e instanceof Error ? e.message : 'Failed to load bookmarks' })
    // {#if open} hasn't mounted when this fires; defer the focus.
    tick().then(() => inputEl?.focus())
  })

  function close() {
    open = false
    previousFocus?.focus()
  }

  function submit() {
    const name = filtered[cursor.index]?.name ?? value.trim()
    if (!name) return
    if (closeOnPick) close()
    onpick(name)
  }

  function handleKeydown(e: KeyboardEvent) {
    // stopPropagation on every key — see the header comment.
    e.stopPropagation()
    cursor.handleKey(e)
  }
</script>

{#if open}
  <div class="modal-backdrop" onclick={close} role="presentation"></div>
  <div class="bm-set-modal">
    <div class="bm-set-header">{title}</div>
    <input
      bind:this={inputEl}
      bind:value
      class="bm-set-input"
      type="text"
      {placeholder}
      onkeydown={handleKeydown}
      oninput={() => { cursor.index = -1 }}
    />
    {#if error && showError}
      <div class="bm-set-error">⚠ {error}</div>
    {:else if filtered.length > 0}
      <div class="bm-set-suggestions">
        {#each filtered as bm, i (bm.name)}
          <button
            class="bm-set-suggestion"
            class:active={i === cursor.index}
            onmousedown={(e: MouseEvent) => { e.preventDefault(); value = bm.name; submit() }}
          >
            {@render row(bm)}
          </button>
        {/each}
      </div>
    {/if}
    <div class="bm-set-hint">{hint}</div>
  </div>
{/if}

<style>
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
    font-size: var(--fs-md);
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
    font-size: var(--fs-lg);
    outline: none;
  }

  .bm-set-input::placeholder {
    color: var(--text-faint);
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
    font-size: var(--font-size);
    text-align: left;
    cursor: pointer;
  }

  .bm-set-suggestion:hover,
  .bm-set-suggestion.active {
    background: var(--surface0);
  }

  .bm-set-error {
    padding: 8px 16px;
    font-size: var(--fs-md);
    color: var(--red);
    border-bottom: 1px solid var(--surface0);
  }

  .bm-set-hint {
    padding: 6px 16px;
    font-size: var(--fs-sm);
    color: var(--text-faint);
  }
</style>
