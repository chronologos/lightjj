<script lang="ts">
  import { api, type LogEntry } from './api'
  import { createLoader, DIFF_LOAD_DEBOUNCE_MS } from './loader.svelte'
  import { parseDiffContent } from './diff-parser'
  import { relativeTime, firstLine } from './time-format'
  import DiffFileView from './DiffFileView.svelte'
  import FileHistoryRail from './FileHistoryRail.svelte'

  interface Props {
    path: string
    /** commit_id to pre-pin as cursor A. If absent from the mutable-scoped
     *  list, auto-triggers loadFull() to find it in the complete history. */
    initialPin?: string | null
    onclose: () => void
  }

  let { path, initialPin, onclose }: Props = $props()

  // ── Two-cursor state ─────────────────────────────────────────────────────
  // cursorB moves with j/k (rail owns it); pinnedA is fixed until Space re-pins.
  let revisions: LogEntry[] = $state([])
  let cursorB = $state(0)
  let pinnedA = $state(0)
  // bug_015: per-file collapse — diffRange can return multiple entries on renames.
  let collapsed = $state(new Set<string>())
  let railRef: FileHistoryRail | undefined = $state()

  // ── initialPin resolution ────────────────────────────────────────────────
  // When initialPin is set, the rail gets startFull={true} — skips the
  // mutable-scoped tier entirely since the pin target is unlikely to be in
  // WIP. Once the full list arrives, find and pin. {#key} remount resets the
  // flag. Plain let (not $state) — only this effect reads it; $state would
  // self-invalidate on the pinApplied=true write.
  let pinApplied = false
  $effect(() => {
    if (pinApplied || !initialPin || revisions.length === 0) return
    const idx = revisions.findIndex(r => r.commit.commit_id === initialPin)
    if (idx >= 0) pinnedA = idx
    pinApplied = true
  })

  let revA = $derived(revisions[pinnedA])
  let revB = $derived(revisions[cursorB])
  let sameRev = $derived(pinnedA === cursorB)

  // ── Diff loader ──────────────────────────────────────────────────────────
  const diff = createLoader(
    async (from: string, to: string) => {
      const r = await api.diffRange(from, to, [path])
      return parseDiffContent(r.diff)
    },
    [] as ReturnType<typeof parseDiffContent>,
  )

  // bug_001: diffRange(from, to) shows "what changed going from→to". With
  // A=newest (pinned) and B=cursor moving DOWN to older commits, the intuitive
  // read is "what did A add relative to B?" → from=B, to=A. Green = additions.
  // bug_027: 50ms debounce so rapid j/k doesn't fire N requests.
  let debounce: ReturnType<typeof setTimeout> | undefined
  $effect(() => {
    if (sameRev || !revA || !revB) { diff.reset(); return }
    const a = revA.commit.commit_id
    const b = revB.commit.commit_id
    clearTimeout(debounce)
    debounce = setTimeout(() => diff.load(b, a), DIFF_LOAD_DEBOUNCE_MS)
    return () => clearTimeout(debounce)
  })

  /** Exported for App delegation. Rail handles j/k; we handle Space/Escape. */
  export function handleKeydown(e: KeyboardEvent): boolean {
    if (railRef?.handleKeydown(e)) return true
    switch (e.key) {
      case ' ':
        pinnedA = cursorB
        return true
      case 'Escape':
        onclose()
        return true
    }
    return false
  }

  // Stable empty maps for DiffFileView props (same pattern as EvologPanel).
  const EMPTY_HL = new Map<string, string>()
  const EMPTY_WD = new Map<string, Map<number, import('./word-diff').WordSpan[]>>()
</script>

<div class="fh-root">
  <div class="fh-header">
    <span class="fh-title">File history: <code>{path}</code></span>
    <button class="close-btn" onclick={onclose} title="Close (Escape)">✕</button>
  </div>

  <div class="fh-body">
    <FileHistoryRail
      bind:this={railRef}
      {path}
      pinnedIndex={pinnedA}
      startFull={!!initialPin}
      bind:revisions
      bind:selectedIndex={cursorB}
    />

    <!-- ── Right: A/B cards + diff ─────────────────────────────────────── -->
    <div class="fh-diff-side">
      {#if revA && revB}
        <div class="fh-cards">
          <div class="fh-card fh-card-a">
            <div class="fh-card-label">A <span class="fh-card-hint">(pinned — Space to re-pin)</span></div>
            <code class="fh-card-id">{revA.commit.change_id.slice(0, 8)}</code>
            <span class="fh-card-desc">{firstLine(revA.description) || '(no description)'}</span>
            <span class="fh-card-age">{relativeTime(revA.commit.timestamp)}</span>
          </div>
          <span class="fh-swap">⇄</span>
          <div class="fh-card fh-card-b">
            <div class="fh-card-label">B <span class="fh-card-hint">(cursor — j/k)</span></div>
            <code class="fh-card-id">{revB.commit.change_id.slice(0, 8)}</code>
            <span class="fh-card-desc">{firstLine(revB.description) || '(no description)'}</span>
            <span class="fh-card-age">{relativeTime(revB.commit.timestamp)}</span>
          </div>
        </div>
      {/if}

      <div class="fh-diff-scroll">
        {#if sameRev}
          <div class="fh-empty-state">Same revision — press <kbd>j</kbd>/<kbd>k</kbd> to compare</div>
        {:else if diff.loading}
          <div class="fh-empty-state">Loading diff…</div>
        {:else if diff.error}
          <div class="fh-empty-state fh-error">{diff.error}</div>
        {:else if diff.value.length === 0}
          <div class="fh-empty-state">No changes between A and B for this file.</div>
        {:else}
          {#each diff.value as file (file.filePath)}
            <DiffFileView
              {file}
              fileStats={undefined}
              isCollapsed={collapsed.has(file.filePath)}
              isExpanded={false}
              splitView={false}
              highlightedLines={EMPTY_HL}
              wordDiffs={EMPTY_WD}
              ontoggle={() => {
                const next = new Set(collapsed)
                next.has(file.filePath) ? next.delete(file.filePath) : next.add(file.filePath)
                collapsed = next
              }}
            />
          {/each}
        {/if}
      </div>
    </div>
  </div>
</div>

<style>
  .fh-root {
    display: flex;
    flex-direction: column;
    height: 100%;
    width: 100%;  /* bug_020: parent overlay is display:flex → child needs explicit fill */
    background: var(--base);
  }
  .fh-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 8px 12px;
    border-bottom: 1px solid var(--surface0);
    font-size: 12px;
  }
  .fh-title code {
    font-family: var(--font-mono);
    color: var(--text);
  }
  .fh-body {
    display: flex;
    flex: 1;
    min-height: 0;
  }

  /* ── Right side ── */
  .fh-diff-side {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
  }
  .fh-cards {
    display: flex;
    align-items: stretch;
    gap: 8px;
    padding: 8px 12px;
    border-bottom: 1px solid var(--surface0);
  }
  .fh-card {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 2px;
    padding: 6px 8px;
    background: var(--surface0);
    border-radius: 4px;
    border-left: 3px solid transparent;
    font-size: 11px;
  }
  .fh-card-a { border-left-color: var(--amber); }
  .fh-card-label {
    font-family: var(--font-mono);
    font-size: 10px;
    font-weight: bold;
    color: var(--amber);
  }
  .fh-card-hint {
    font-weight: normal;
    color: var(--subtext0);
  }
  .fh-card-id {
    font-family: var(--font-mono);
    font-size: 10px;
    color: var(--subtext1);
  }
  .fh-card-desc {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .fh-card-age {
    font-size: 9px;
    color: var(--subtext0);
  }
  .fh-swap {
    align-self: center;
    color: var(--subtext0);
    font-size: 14px;
  }
  .fh-diff-scroll {
    flex: 1;
    overflow-y: auto;
  }
  .fh-empty-state {
    padding: 40px;
    text-align: center;
    color: var(--subtext0);
    font-size: 12px;
  }
  .fh-empty-state kbd {
    padding: 1px 4px;
    border: 1px solid var(--surface1);
    border-radius: 3px;
    font-family: var(--font-mono);
    font-size: 10px;
  }
  .fh-error { color: var(--red); }
</style>
