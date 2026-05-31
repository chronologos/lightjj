<script lang="ts">
  import type { Bookmark } from './api'
  import { fuzzyMatch } from './fuzzy'
  import { recentActions } from './recent-actions.svelte'
  import BookmarkPicker from './BookmarkPicker.svelte'

  // "Set bookmark HERE" modal — thin wrapper over the shared BookmarkPicker.
  // This wrapper owns the ranking (conflict > trunk > recency), the row
  // rendering (move/resolve verb + ?? marker), and recency recording.

  interface Props {
    open: boolean
    onsave: (name: string) => void
  }

  let { open = $bindable(false), onsave }: Props = $props()

  // Shared namespace with BookmarkModal — setting a bookmark here bumps its
  // rank in the `b` modal's recently-used sort too.
  const history = recentActions('bookmark-modal')

  // Trunk-name pattern. jj's trunk() alias defaults to checking these against
  // @origin in this order; we match the same names as a heuristic for "default
  // branch you'd want to advance". No API call to resolve trunk() — it's a
  // revset function, not a bookmark query.
  const TRUNK_NAMES = new Set(['main', 'master', 'trunk'])

  function rank(bookmarks: Bookmark[], value: string): Bookmark[] {
    if (value) return bookmarks.filter(b => fuzzyMatch(value, b.name)).slice(0, 8)
    // Empty input: surface conflicted bookmarks (why you'd open this dialog
    // mid-conflict) then trunk names (common advance target), then most
    // recently used. 5 is enough for an at-a-glance pick — more and you'd
    // type to filter anyway.
    // +bool coercion: true→1, false→0; b-a for descending (trues first).
    const last = history.snapshot()
    return [...bookmarks]
      .sort((a, b) =>
        (+b.conflict - +a.conflict) ||
        (+TRUNK_NAMES.has(b.name) - +TRUNK_NAMES.has(a.name)) ||
        ((last[b.name] ?? 0) - (last[a.name] ?? 0))
      )
      .slice(0, 5)
  }

  function handlePick(name: string) {
    // record() before onsave — if onsave throws, recency still updates.
    history.record(name)
    onsave(name)
  }
</script>

<!-- Picker stays open on pick: App closes it once the bookmark-set mutation
     lands (`before:` hook in handleBookmarkSet). -->
<BookmarkPicker
  bind:open
  title="Set Bookmark"
  placeholder="Type bookmark name..."
  hint="Enter to set · Escape to cancel · ↑↓ to select existing"
  {rank}
  showError
  onpick={handlePick}
>
  {#snippet row(bm: Bookmark)}
    <span class="bm-set-move-hint" class:bm-set-resolve={bm.conflict}>
      {bm.conflict ? 'resolve' : 'move'}
    </span>
    {bm.name}{#if bm.conflict}<span class="conflict-marker">??</span>{/if} → here
  {/snippet}
</BookmarkPicker>

<style>
  .bm-set-move-hint {
    color: var(--amber);
    font-size: var(--fs-sm);
    font-weight: 600;
    text-transform: uppercase;
  }
  .bm-set-move-hint.bm-set-resolve {
    color: var(--red);
  }
</style>
