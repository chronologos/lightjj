<script lang="ts">
  import { api, type LogEntry } from './api'
  import { createLoader, DIFF_LOAD_DEBOUNCE_MS } from './loader.svelte'
  import { parseDiffContent } from './diff-parser'
  import { relativeTime, firstLine } from './time-format'
  import { tick } from 'svelte'
  import FileHistoryRail from './FileHistoryRail.svelte'
  import DiffFileView from './DiffFileView.svelte'

  interface Props {
    path: string
    /** The revision currently being viewed — the "against" side of the diff. */
    against: string
    onclose: () => void
  }

  let { path, against, onclose }: Props = $props()

  let revisions: LogEntry[] = $state([])
  let selectedIndex = $state(0)
  let railRef: FileHistoryRail | undefined = $state()
  let rootEl: HTMLElement | undefined = $state()

  // Auto-focus so j/k reach our onkeydown instead of App's global handler
  // (which navigates the main graph → reset effect → picker closes).
  $effect(() => { if (rootEl) tick().then(() => rootEl?.focus()) })

  function handleKeydown(e: KeyboardEvent) {
    if (railRef?.handleKeydown(e)) { e.preventDefault(); e.stopPropagation(); return }
    if (e.key === 'Escape') { onclose(); e.stopPropagation() }
  }

  let selected = $derived(revisions[selectedIndex])
  let selectedId = $derived(selected?.commit.commit_id)

  // Skip when selection matches the anchor — diffRange(x, x) is empty anyway.
  let isSelf = $derived(selectedId === against)

  const diff = createLoader(
    async (from: string) => {
      const r = await api.diffRange(from, against, [path])
      return parseDiffContent(r.diff)
    },
    [] as ReturnType<typeof parseDiffContent>,
  )

  let debounce: ReturnType<typeof setTimeout> | undefined
  $effect(() => {
    if (!selectedId || isSelf) { diff.reset(); return }
    const id = selectedId
    clearTimeout(debounce)
    debounce = setTimeout(() => diff.load(id), DIFF_LOAD_DEBOUNCE_MS)
    return () => clearTimeout(debounce)
  })

  const EMPTY_HL = new Map<string, string>()
  const EMPTY_WD = new Map<string, Map<number, import('./word-diff').WordSpan[]>>()
</script>

<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
<div class="fcp-root" bind:this={rootEl} tabindex="-1" onkeydown={handleKeydown}>
  <div class="fcp-header">
    <span class="fcp-title">Compare <code>{path}</code> against…</span>
    <button class="close-btn" onclick={onclose} title="Close (Esc)">✕</button>
  </div>
  <div class="fcp-body">
    <FileHistoryRail bind:this={railRef} {path} bind:revisions bind:selectedIndex />
    <div class="fcp-diff">
      {#if !selected}
        <div class="fcp-empty">Select a revision</div>
      {:else if isSelf}
        <div class="fcp-empty">This is the revision you're viewing.</div>
      {:else}
        <div class="fcp-selected">
          <code>{selected.commit.change_id.slice(0, 8)}</code>
          <span class="fcp-desc">{firstLine(selected.description) || '(no description)'}</span>
          <span class="fcp-age">{relativeTime(selected.commit.timestamp)}</span>
        </div>
        {#if diff.loading}
          <div class="fcp-empty">Loading diff…</div>
        {:else if diff.error}
          <div class="fcp-empty fcp-error">{diff.error}</div>
        {:else if diff.value.length === 0}
          <div class="fcp-empty">No changes for this file.</div>
        {:else}
          {#each diff.value as file (file.filePath)}
            <DiffFileView
              {file}
              fileStats={undefined}
              isCollapsed={false}
              isExpanded={false}
              splitView={false}
              highlightedLines={EMPTY_HL}
              wordDiffs={EMPTY_WD}
              ontoggle={() => {}}
            />
          {/each}
        {/if}
      {/if}
    </div>
  </div>
</div>

<style>
  .fcp-root {
    display: flex;
    flex-direction: column;
    max-height: 60vh;
    border: 1px solid var(--surface1);
    border-radius: 4px;
    background: var(--base);
    margin: 8px;
    overflow: hidden;
  }
  .fcp-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 6px 10px;
    border-bottom: 1px solid var(--surface0);
    font-size: 11px;
    background: var(--mantle);
  }
  .fcp-title code {
    font-family: var(--font-mono);
    color: var(--text);
  }
  .fcp-body {
    display: flex;
    flex: 1;
    min-height: 0;
  }
  .fcp-diff {
    flex: 1;
    min-width: 0;
    overflow-y: auto;
  }
  .fcp-selected {
    display: flex;
    align-items: baseline;
    gap: 8px;
    padding: 6px 10px;
    border-bottom: 1px solid var(--surface0);
    font-size: 11px;
  }
  .fcp-selected code {
    font-family: var(--font-mono);
    font-size: 10px;
    color: var(--amber);
  }
  .fcp-desc {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .fcp-age {
    font-size: 9px;
    color: var(--subtext0);
    font-family: var(--font-mono);
  }
  .fcp-empty {
    padding: 20px;
    text-align: center;
    color: var(--subtext0);
    font-size: 11px;
  }
  .fcp-error { color: var(--red); }
</style>
