<script lang="ts">
  import { api, type LogEntry } from './api'
  import { createLoader } from './loader.svelte'
  import { parseDiffContent } from './diff-parser'
  import DiffFileView from './DiffFileView.svelte'

  interface Props {
    path: string
    onclose: () => void
  }

  let { path, onclose }: Props = $props()

  // ── Revision list ────────────────────────────────────────────────────────
  // Two-tier: mutable-only is instant but shows only your WIP. full=true drops
  // the scope — fast once jj's changed-path index is built (jj#7250). Index
  // build is a separate streaming call (no timeout) so first-build on large
  // repos doesn't hit the 30s read ceiling.
  let full = $state(false)
  let indexProgress = $state('')
  const history = createLoader(
    ([p, f]: [string, boolean]) => api.fileHistory(p, f),
    [] as LogEntry[],
  )
  $effect(() => { history.load([path, full]) })

  async function loadFull() {
    // jj's progress is TTY-gated — through our pipe we get zero output until
    // the final line. A ticking elapsed counter is the only "alive" signal.
    const started = Date.now()
    const tick = () => {
      indexProgress = `Building path index… ${Math.floor((Date.now() - started) / 1000)}s`
    }
    tick()
    const timer = setInterval(tick, 1000)
    try {
      await api.indexPaths(line => { indexProgress = line })
    } catch (e) {
      // Non-fatal — old jj or unsupported backend. files() falls back to
      // slow scan; may still time out on huge repos but worth the attempt.
      console.warn('index-changed-paths failed:', e)
    } finally {
      clearInterval(timer)
    }
    indexProgress = ''
    full = true
  }

  let revisions = $derived(history.value)
  // Sparse = mutable-only found few commits; prompt the user to load full.
  let sparse = $derived(!full && !history.loading && revisions.length < 5)

  // ── Two-cursor state ─────────────────────────────────────────────────────
  // cursorB moves with j/k; pinnedA is fixed until Space re-pins.
  let cursorB = $state(0)
  let pinnedA = $state(0)
  // bug_015: per-file collapse — diffRange can return multiple entries on renames.
  let collapsed = $state(new Set<string>())
  let hoveredIdx = $state(-1)
  let listEl: HTMLElement | undefined = $state()

  let revA = $derived(revisions[pinnedA])
  let revB = $derived(revisions[cursorB])
  let sameRev = $derived(pinnedA === cursorB)

  // ── Diff loader ──────────────────────────────────────────────────────────
  // createLoader's generation counter guards rapid j/k → stale overwrite.
  // diffRange returns {diff: string}; we unwrap in the fetch closure.
  const diff = createLoader(
    async (from: string, to: string) => {
      const r = await api.diffRange(from, to, [path])
      return parseDiffContent(r.diff)
    },
    [] as ReturnType<typeof parseDiffContent>,
  )

  // Reload diff whenever either cursor moves. Skip when A===B.
  // bug_001: diffRange(from, to) shows "what changed going from→to". With
  // A=newest (pinned) and B=cursor moving DOWN to older commits, the intuitive
  // read is "what did A add relative to B?" → from=B, to=A. Green = additions.
  // bug_027: 50ms debounce so rapid j/k doesn't fire N requests. createLoader's
  // gen counter cancels stale RESPONSES but doesn't skip intermediate LOADS.
  let debounce: ReturnType<typeof setTimeout> | undefined
  $effect(() => {
    if (sameRev || !revA || !revB) { diff.reset(); return }
    const a = revA.commit.commit_id
    const b = revB.commit.commit_id
    clearTimeout(debounce)
    debounce = setTimeout(() => diff.load(b, a), 50)
    return () => clearTimeout(debounce)
  })

  // ── Navigation ───────────────────────────────────────────────────────────
  function scrollTo(i: number) {
    // Query by data-idx (static attr) — cursorB=$state write hasn't re-rendered
    // yet when this runs synchronously. Same pattern as ConflictQueue bug_008.
    listEl?.querySelector(`[data-idx="${i}"]`)?.scrollIntoView({ block: 'nearest' })
  }

  function moveCursor(i: number) {
    if (i < 0 || i >= revisions.length) return
    cursorB = i
    scrollTo(i)
  }

  /** Exported for App delegation (BookmarksPanel/ConflictQueue pattern).
   *  Returns true if key consumed — even at a clamp bound. */
  export function handleKeydown(e: KeyboardEvent): boolean {
    switch (e.key) {
      case 'j': case 'ArrowDown':
        moveCursor(cursorB + 1)
        return true
      case 'k': case 'ArrowUp':
        moveCursor(cursorB - 1)
        return true
      case ' ':
        pinnedA = cursorB
        return true
      case 'Escape':
        onclose()
        return true
    }
    return false
  }

  // ── Rendering helpers ────────────────────────────────────────────────────
  /** Format jj timestamp as compact relative age (same scheme as RevisionGraph). */
  function relativeTime(ts: string | undefined): string {
    if (!ts) return ''
    const isoish = ts.replace(' ', 'T').replace(/\.(\d{3})\s+([+-])/, '.$1$2')
    const date = new Date(isoish)
    if (isNaN(date.getTime())) return ''
    const secs = Math.floor((Date.now() - date.getTime()) / 1000)
    if (secs < 60) return 'now'
    const mins = Math.floor(secs / 60)
    if (mins < 60) return `${mins}m`
    const hrs = Math.floor(mins / 60)
    if (hrs < 24) return `${hrs}h`
    const days = Math.floor(hrs / 24)
    if (days < 30) return `${days}d`
    const months = Math.floor(days / 30)
    if (months < 12) return `${months}mo`
    return `${Math.floor(days / 365)}y`
  }

  function firstLine(s: string): string {
    const nl = s.indexOf('\n')
    return nl < 0 ? s : s.slice(0, nl)
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
    <!-- ── Left rail: revision list ───────────────────────────────────── -->
    <!-- svelte-ignore a11y_no_static_element_interactions a11y_mouse_events_have_key_events -->
    <div class="fh-rail" bind:this={listEl}
      onmousemove={e => {
        const t = (e.target as Element).closest('[data-idx]')
        hoveredIdx = t ? Number(t.getAttribute('data-idx')) : -1
      }}
      onmouseleave={() => hoveredIdx = -1}
    >
      {#if indexProgress}
        <div class="fh-empty">
          {indexProgress}
          <br><small>First run per repo builds jj's changed-path index (one-time). Subsequent loads are instant.</small>
          <br><small>Large repo? Run <code>jj debug index-changed-paths</code> in a terminal for a live progress bar.</small>
        </div>
      {:else if history.loading && revisions.length === 0}
        <div class="fh-empty">Loading…</div>
      {:else if history.error}
        <div class="fh-empty fh-error">{history.error}</div>
      {:else if revisions.length === 0}
        <div class="fh-empty">
          No mutable revisions touch this file.
          {#if !full}<br><button class="fh-load-full" onclick={loadFull}>Load full history</button>{/if}
        </div>
      {:else}
        {#each revisions as rev, i (rev.commit.commit_id)}
          {@const c = rev.commit}
          <button
            class="fh-row"
            class:fh-cursor={i === cursorB}
            class:fh-pinned={i === pinnedA}
            class:fh-hovered={i === hoveredIdx}
            class:fh-immutable={c.immutable}
            data-idx={i}
            onclick={() => moveCursor(i)}
          >
            <span class="fh-badge">{i === pinnedA ? 'A' : i === cursorB ? 'B' : ''}</span>
            <code class="fh-id">{c.change_id.slice(0, c.change_prefix)}<span class="fh-id-rest">{c.change_id.slice(c.change_prefix, 8)}</span></code>
            <span class="fh-desc">{firstLine(rev.description) || '(no description)'}</span>
            <span class="fh-age">{relativeTime(c.timestamp)}</span>
          </button>
        {/each}
        {#if sparse}
          <div class="fh-sparse">
            <small>Only {revisions.length} mutable commit{revisions.length === 1 ? '' : 's'} — showing your WIP only.</small>
            <button class="fh-load-full" onclick={loadFull}>Load full history</button>
          </div>
        {/if}
      {/if}
    </div>

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

  /* ── Left rail ── */
  .fh-rail {
    min-width: 240px;
    max-width: 340px;
    overflow-y: auto;
    background: var(--mantle);
    border-right: 1px solid var(--surface0);
    user-select: none;
  }
  .fh-row {
    display: flex;
    align-items: center;
    gap: 6px;
    width: 100%;
    height: 18px;  /* match RevisionGraph row convention */
    padding: 0 8px;
    border: none;
    border-left: 2px solid transparent;
    background: transparent;
    color: var(--text);
    font-family: inherit;
    font-size: 11px;
    text-align: left;
    cursor: pointer;
    overflow: hidden;
  }
  .fh-immutable { opacity: 0.6; }
  .fh-hovered { background: var(--surface0); }
  .fh-cursor {
    background: color-mix(in srgb, var(--amber) 12%, transparent);
    border-left-color: var(--amber);
  }
  .fh-cursor.fh-hovered {
    background: color-mix(in srgb, var(--amber) 18%, transparent);
  }
  .fh-pinned:not(.fh-cursor) {
    border-left-color: var(--amber);
  }
  .fh-badge {
    width: 10px;
    font-family: var(--font-mono);
    font-size: 9px;
    font-weight: bold;
    color: var(--amber);
    text-align: center;
  }
  .fh-id {
    font-family: var(--font-mono);
    font-size: 10px;
    color: var(--amber);
  }
  .fh-id-rest { color: var(--subtext0); }
  .fh-desc {
    flex: 1;
    min-width: 0;  /* flex ellipsis requirement */
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .fh-age {
    font-size: 9px;
    color: var(--subtext0);
    font-family: var(--font-mono);
  }
  .fh-sparse {
    padding: 10px;
    text-align: center;
    color: var(--subtext0);
    border-top: 1px solid var(--surface0);
  }
  .fh-sparse small { display: block; margin-bottom: 6px; font-size: 10px; }
  .fh-load-full {
    padding: 4px 10px;
    border: 1px solid var(--surface1);
    border-radius: 4px;
    background: var(--surface0);
    color: var(--text);
    font-family: inherit;
    font-size: 11px;
    cursor: pointer;
  }
  .fh-load-full:hover { background: var(--surface1); }

  .fh-empty {
    padding: 16px;
    text-align: center;
    color: var(--subtext0);
    font-size: 11px;
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
