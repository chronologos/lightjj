<script lang="ts">
  import type { Bookmark } from './api'
  import { fuzzyMatch } from './fuzzy'
  import BookmarkPicker from './BookmarkPicker.svelte'

  // Transient destination picker for inline rebase/squash modes — opened with
  // `/` when the j/k cursor can't reach the target (off-revset bookmark like
  // a freshly-synced upstream main). Input accepts a bookmark name OR a raw
  // change_id/revset; bookmarks get autocompleted, anything else passes
  // straight through to jj (which validates the revset).
  //
  // Deliberately NOT BookmarkInput: that component's semantics are inverted
  // ("move bookmark X to HERE" — cursor is the data, input is the name).
  // Here the source is fixed and the input is the destination. Both are thin
  // wrappers over the shared BookmarkPicker.

  interface Props {
    open: boolean
    /** Rendered as "Rebase <verb>" / "Squash <verb>" — e.g. "onto", "into", "after". */
    verb: string
    onsubmit: (dest: string) => void
  }

  let { open = $bindable(false), verb, onsubmit }: Props = $props()

  // Trunk-first default sort: rebase-onto-main is the dominant case for the
  // off-revset scenario this exists for. Typing filters via fuzzy match.
  const TRUNK_NAMES = new Set(['main', 'master', 'trunk'])

  function rank(bookmarks: Bookmark[], value: string): Bookmark[] {
    const matches = value
      ? bookmarks.filter(b => fuzzyMatch(value, b.name))
      : [...bookmarks].sort((a, b) => +TRUNK_NAMES.has(b.name) - +TRUNK_NAMES.has(a.name))
    return matches.slice(0, 8)
  }
</script>

<!-- closeOnPick: destination is consumed immediately by the inline mode —
     close (and restore focus) before onsubmit fires. -->
<BookmarkPicker
  bind:open
  title={verb}
  placeholder="Bookmark, change_id, or revset…"
  hint="Enter to {verb.split(' ')[0].toLowerCase()} · Esc to cancel · ↑↓ select"
  {rank}
  closeOnPick
  onpick={onsubmit}
>
  {#snippet row(bm: Bookmark)}
    {bm.name}
    {#if bm.commit_id}<span class="dest-cid">{bm.commit_id.slice(0, 8)}</span>{/if}
  {/snippet}
</BookmarkPicker>

<style>
  .dest-cid {
    color: var(--text-faint);
    font-family: var(--font-mono);
    font-size: var(--fs-sm);
    margin-left: 8px;
  }
</style>
