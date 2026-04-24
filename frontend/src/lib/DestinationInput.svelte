<script lang="ts">
  import { tick } from 'svelte'
  import { api, type Bookmark } from './api'
  import { fuzzyMatch } from './fuzzy'

  // Transient destination picker for inline rebase/squash modes — opened with
  // `/` when the j/k cursor can't reach the target (off-revset bookmark like
  // a freshly-synced upstream main). Input accepts a bookmark name OR a raw
  // change_id/revset; bookmarks get autocompleted, anything else passes
  // straight through to jj (which validates the revset).
  //
  // Deliberately NOT BookmarkInput: that component's semantics are inverted
  // ("move bookmark X to HERE" — cursor is the data, input is the name).
  // Here the source is fixed and input is the destination.

  interface Props {
    open: boolean
    /** Rendered as "Rebase <verb>" / "Squash <verb>" — e.g. "onto", "into", "after". */
    verb: string
    onsubmit: (dest: string) => void
  }

  let { open = $bindable(false), verb, onsubmit }: Props = $props()

  let value = $state('')
  let inputEl: HTMLInputElement | undefined = $state()
  let bookmarks: Bookmark[] = $state([])
  let selected = $state(-1)
  let previousFocus: HTMLElement | null = null

  // Trunk-first default sort: rebase-onto-main is the dominant case for the
  // off-revset scenario this exists for. Typing filters via fuzzy match.
  const TRUNK_NAMES = new Set(['main', 'master', 'trunk'])
  const filtered = $derived.by(() => {
    if (!open) return []
    const matches = value
      ? bookmarks.filter(b => fuzzyMatch(value, b.name))
      : [...bookmarks].sort((a, b) => +TRUNK_NAMES.has(b.name) - +TRUNK_NAMES.has(a.name))
    return matches.slice(0, 8)
  })

  $effect(() => {
    if (!open) return
    previousFocus = document.activeElement as HTMLElement | null
    value = ''
    selected = -1
    api.bookmarks({ local: true }).then(bms => { bookmarks = bms }).catch(() => {})
    // {#if open} hasn't mounted when this fires; defer the focus().
    tick().then(() => inputEl?.focus())
  })

  function close() {
    open = false
    previousFocus?.focus()
  }

  function submit() {
    const dest = filtered[selected]?.name ?? value.trim()
    if (!dest) return
    close()
    onsubmit(dest)
  }

  function handleKeydown(e: KeyboardEvent) {
    // stopPropagation on every branch: rebase mode's handleInlineNav swallows
    // ALL keys (load-bearing — normal-mode keys mustn't leak into modes), so
    // anything that bubbles from here would be re-dispatched as a mode key
    // (`d` typed in this input would flip targetMode to -d).
    e.stopPropagation()
    switch (e.key) {
      case 'Enter': e.preventDefault(); submit(); break
      case 'Escape': e.preventDefault(); close(); break
      case 'ArrowDown':
        if (filtered.length) { e.preventDefault(); selected = Math.min(selected + 1, filtered.length - 1) }
        break
      case 'ArrowUp':
        if (filtered.length) { e.preventDefault(); selected = Math.max(selected - 1, 0) }
        break
    }
  }
</script>

{#if open}
  <div class="modal-backdrop" onclick={close} role="presentation"></div>
  <div class="dest-modal">
    <div class="dest-header">{verb}</div>
    <input
      bind:this={inputEl}
      bind:value
      class="modal-input"
      type="text"
      placeholder="Bookmark, change_id, or revset…"
      onkeydown={handleKeydown}
      oninput={() => { selected = -1 }}
    />
    {#if filtered.length > 0}
      <div class="dest-suggestions">
        {#each filtered as bm, i (bm.name)}
          <button
            class="dest-suggestion"
            class:active={i === selected}
            onmousedown={(e) => { e.preventDefault(); value = bm.name; submit() }}
          >
            {bm.name}
            {#if bm.commit_id}<span class="dest-cid">{bm.commit_id.slice(0, 8)}</span>{/if}
          </button>
        {/each}
      </div>
    {/if}
    <div class="dest-hint">Enter to {verb.split(' ')[0].toLowerCase()} · Esc to cancel · ↑↓ select</div>
  </div>
{/if}

<style>
  .dest-modal {
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
  .dest-header {
    padding: 10px 16px 6px;
    font-size: var(--fs-md);
    font-weight: 700;
    color: var(--subtext0);
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }
  .dest-suggestions { border-top: 1px solid var(--surface0); }
  .dest-suggestion {
    display: flex;
    align-items: baseline;
    gap: 8px;
    width: 100%;
    padding: 6px 16px;
    background: transparent;
    border: none;
    color: var(--text);
    font: inherit;
    text-align: left;
    cursor: pointer;
  }
  .dest-suggestion:hover, .dest-suggestion.active { background: var(--surface0); }
  .dest-cid { color: var(--surface2); font-family: var(--font-mono); font-size: var(--fs-sm); }
  .dest-hint { padding: 6px 16px; font-size: var(--fs-sm); color: var(--surface2); border-top: 1px solid var(--surface0); }
</style>
