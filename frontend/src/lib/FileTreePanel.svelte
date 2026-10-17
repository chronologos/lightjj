<script lang="ts">
  import { tick, untrack } from 'svelte'
  import { SvelteMap, SvelteSet } from 'svelte/reactivity'
  import { api, FILE_TYPE_LABELS, type FileChange, type FileTreeSearchResponse, type TreeEntryType } from './api'
  import { createLoader, DIFF_LOAD_DEBOUNCE_MS } from './loader.svelte'
  import { createListCursor } from './list-cursor.svelte'
  import { createWindower, type VirtualItem } from './virtual.svelte'
  import {
    flattenTree, ancestorDirs, parentDir, changeMarks, contentKind, contentLines, visiblePath,
    type DirState, type TreeRow,
  } from './file-tree'
  import { detectLanguage, needsLegacyParser, ensureLegacyParsers } from './languages'
  import { highlightLines, escapeHtml } from './highlighter'

  // Full file tree at ONE revision (issue #39) — every file in the commit, not
  // just the changed ones. Left: lazily-expanded tree (server returns one dir's
  // children per request, from a per-commit index) or, while `/` filter text is
  // present, ranked server-side search results across the whole tree. Right:
  // read-only highlighted view of the file under the cursor (follows the cursor
  // with the shared nav debounce). Mounted by App as a full-screen overlay
  // inside {#key commitId}; keys arrive via the exported handleKeydown (App's
  // overlay delegate), the filter input handles its own.

  interface Props {
    commitId: string
    changeId: string
    /** Viewing @ — "Open in editor" opens the WORKING-COPY file, which only
     *  matches what's shown here when the revision is @. */
    isWorkingCopy: boolean
    onclose: () => void
    onfilehistory?: (path: string) => void
    onopenfile?: (path: string) => void
  }

  let { commitId, changeId, isWorkingCopy, onclose, onfilehistory, onopenfile }: Props = $props()

  const ROW_HEIGHT = 20
  const SEARCH_LIMIT = 200
  const SEARCH_DEBOUNCE_MS = 120
  // Viewer caps: syntax highlighting is synchronous (Lezer, ~9ms/500 lines);
  // past MAX_HIGHLIGHT_LINES we show escaped plain text, past MAX_RENDER_LINES
  // we stop rendering rows at all (DOM size), with a note.
  const MAX_HIGHLIGHT_LINES = 5000
  const MAX_RENDER_LINES = 10000

  // ── Directory state ────────────────────────────────────────────────────────
  // Per-open, keyed by dir path. No generation guards needed: the component is
  // remounted per commit ({#key}), and a dir listing of a fixed commit is
  // immutable, so a late response is never stale — only possibly redundant.
  const dirs = new SvelteMap<string, DirState>()
  const expanded = new SvelteSet<string>()
  const pending = new Map<string, Promise<void>>()
  let totalFiles: number | null = $state(null)
  let truncated = $state(false)

  function loadDir(dir: string): Promise<void> {
    if (untrack(() => dirs.get(dir))?.status === 'ok') return Promise.resolve()
    const inflight = pending.get(dir)
    if (inflight) return inflight
    dirs.set(dir, { status: 'loading' })
    const p = api.fileTree(commitId, dir).then(
      (r) => {
        dirs.set(dir, { status: 'ok', entries: r.entries, omitted: r.omitted ?? 0 })
        totalFiles = r.total_files
        truncated = r.truncated
      },
      (e) => { dirs.set(dir, { status: 'error', error: e instanceof Error ? e.message : String(e) }) },
    ).finally(() => pending.delete(dir))
    pending.set(dir, p)
    return p
  }
  // untrack: one-shot init reads of the (never-changing) commitId prop.
  untrack(() => { loadDir('') })

  // Changed files in THIS revision → A/M/D/R marks + "contains changes" dots.
  // api.files is commit_id-cached, so this is usually a cache hit (the diff
  // panel already loaded it).
  let changes: FileChange[] = $state([])
  untrack(() => api.files(commitId).then((f) => { changes = f }, () => {}))
  let marks = $derived(changeMarks(changes))

  // ── Filter (server-side search) ───────────────────────────────────────────
  let query = $state('')
  let filtering = $derived(query.trim() !== '')
  const search = createLoader(
    (q: string) => api.fileTreeSearch(commitId, q, SEARCH_LIMIT),
    null as FileTreeSearchResponse | null,
  )
  $effect(() => {
    const q = query.trim()
    if (!q) { search.reset(); return }
    const t = setTimeout(() => search.load(q), SEARCH_DEBOUNCE_MS)
    return () => clearTimeout(t)
  })

  // ── Rows ──────────────────────────────────────────────────────────────────
  type MatchRow = { kind: 'match'; key: string; path: string; type: TreeEntryType; executable?: boolean }
  type ListRow = TreeRow | MatchRow

  // Row keys: entries/matches use the repo path; status rows use a NUL prefix
  // (repo paths can't contain NUL) so they never collide with a real path.
  let treeRows = $derived(filtering ? [] : flattenTree(dirs, expanded))
  let matchRows: ListRow[] = $derived.by(() => {
    if (!filtering) return []
    const r = search.value
    if (search.error) return [{ kind: 'status', key: '\0err', depth: 0, text: search.error, error: true }]
    if (!r) return [{ kind: 'status', key: '\0searching', depth: 0, text: 'Searching…' }]
    if (r.matches.length === 0) return [{ kind: 'status', key: '\0none', depth: 0, text: 'No matching files' }]
    return r.matches.map((m): MatchRow => ({ kind: 'match', key: m.path, path: m.path, type: m.type, executable: m.executable }))
  })
  let rows: ListRow[] = $derived(filtering ? matchRows : treeRows)

  // ── Cursor (identity-keyed) ───────────────────────────────────────────────
  // createListCursor owns an index; selectedKey is the identity. Expanding a
  // dir, a listing landing, or a collapse re-shapes `rows` — the reconcile
  // effect re-finds the selected row by key so the cursor never re-binds to
  // whatever row slid into its old position (CLAUDE.md: key selection by id).
  let rootEl: HTMLElement | undefined = $state()
  let listEl: HTMLElement | undefined = $state()
  let filterEl: HTMLInputElement | undefined = $state()
  let filterFocused = $state(false)
  let selectedKey: string | null = $state(null)

  const win = createWindower({ count: () => rows.length, scrollEl: () => listEl, rowHeight: ROW_HEIGHT, overscan: 12 })
  // Same pre-measurement fallback as RevisionGraph: the windower has no
  // viewport height on the first frame (and never in jsdom).
  const FALLBACK_ROWS = 60
  let renderItems: VirtualItem[] = $derived.by(() => {
    if (win.items.length > 0 || rows.length === 0) return win.items
    return Array.from({ length: Math.min(rows.length, FALLBACK_ROWS) }, (_, i) => ({ index: i, start: i * ROW_HEIGHT }))
  })

  const cursor = createListCursor({
    count: () => rows.length,
    inputFocused: () => filterFocused,
    onLeaveInput: () => rootEl?.focus(),
    onMove: (i) => {
      selectedKey = rows[i]?.key ?? null
      win.scrollToIndex(i)
    },
    onEnter: () => activate(cursor.index),
    onSlash: () => filterEl?.focus(),
  })

  $effect(() => {
    const rs = rows
    const key = untrack(() => selectedKey)
    const i = key == null ? -1 : rs.findIndex((r) => r.key === key)
    if (i >= 0) {
      if (i !== untrack(() => cursor.index)) cursor.index = i
    } else if (rs.length > 0) {
      // Selected row vanished (filter results replaced, first load): adopt
      // whatever the clamped cursor now points at as the new identity.
      const at = Math.min(Math.max(untrack(() => cursor.index), 0), rs.length - 1)
      cursor.index = at
      selectedKey = rs[at].key
    }
  })

  // A new result set starts at the best match.
  $effect(() => {
    const r = search.value
    if (!r) return
    untrack(() => {
      cursor.index = 0
      selectedKey = rows[0]?.key ?? null
      if (listEl) listEl.scrollTop = 0
    })
  })

  let cursorRow = $derived(rows[cursor.index] as ListRow | undefined)

  function fileOf(row: ListRow | undefined): { path: string; type: TreeEntryType; executable?: boolean } | null {
    if (!row) return null
    if (row.kind === 'match') return row
    if (row.kind === 'entry' && row.entry.type !== 'dir') return row.entry
    return null
  }

  // ── Viewer ────────────────────────────────────────────────────────────────
  interface Viewed { path: string; type: TreeEntryType; executable: boolean; content: string }
  let preview: { path: string; type: TreeEntryType; executable: boolean } | null = $state(null)
  const viewer = createLoader(
    async (path: string, type: TreeEntryType, executable: boolean): Promise<Viewed> => {
      if (type === 'git-submodule') return { path, type, executable, content: '' }
      const lang = detectLanguage(path)
      // Read by commit_id (content-addressed — CLAUDE.md issue #16 lesson).
      const [r] = await Promise.all([
        api.fileShow(commitId, path),
        needsLegacyParser(lang) ? ensureLegacyParsers().catch(() => {}) : undefined,
      ])
      return { path, type, executable, content: r.content }
    },
    null as Viewed | null,
  )

  function openFile(f: { path: string; type: TreeEntryType; executable?: boolean }) {
    if (preview?.path === f.path && !viewer.error) return
    preview = { path: f.path, type: f.type, executable: !!f.executable }
    viewer.load(f.path, f.type, !!f.executable)
  }

  // Preview follows the cursor (debounced like the other nav-driven loads);
  // landing on a dir keeps the last file shown.
  $effect(() => {
    const f = fileOf(cursorRow)
    if (!f || f.path === untrack(() => preview?.path)) return
    const t = setTimeout(() => openFile(f), DIFF_LOAD_DEBOUNCE_MS)
    return () => clearTimeout(t)
  })

  type View =
    | { kind: 'submodule' }
    | { kind: 'symlink'; target: string }
    | { kind: 'image' }
    | { kind: 'binary'; size: number }
    | { kind: 'text'; html: string[]; total: number; highlighted: boolean }

  let view: View | null = $derived.by(() => {
    const v = viewer.value
    if (!v) return null
    if (v.type === 'git-submodule') return { kind: 'submodule' }
    if (v.type === 'symlink') return { kind: 'symlink', target: v.content }
    const kind = contentKind(v.path, v.content)
    if (kind === 'image') return { kind: 'image' }
    if (kind === 'binary') return { kind: 'binary', size: v.content.length }
    const all = contentLines(v.content)
    const lines = all.slice(0, MAX_RENDER_LINES)
    const highlight = lines.length <= MAX_HIGHLIGHT_LINES
    return {
      kind: 'text',
      html: highlight ? highlightLines(lines, detectLanguage(v.path)) : lines.map(escapeHtml),
      total: all.length,
      highlighted: highlight,
    }
  })

  let viewerScrollEl: HTMLElement | undefined = $state()
  // New file → top of the viewer.
  $effect(() => {
    viewer.value
    if (viewerScrollEl) viewerScrollEl.scrollTop = 0
  })

  // ── Actions ───────────────────────────────────────────────────────────────
  function toggleDir(path: string) {
    if (expanded.has(path)) expanded.delete(path)
    else { expanded.add(path); loadDir(path) }
  }

  function activate(i: number) {
    const row = rows[i]
    if (!row) return
    if (row.kind === 'entry' && row.entry.type === 'dir') toggleDir(row.entry.path)
    else {
      const f = fileOf(row)
      if (f) openFile(f)
    }
  }

  /** l / → : expand a collapsed dir; on an expanded one, step into its first child. */
  function expandOrEnter() {
    const row = cursorRow
    if (row?.kind !== 'entry' || row.entry.type !== 'dir') return
    if (!expanded.has(row.entry.path)) { expanded.add(row.entry.path); loadDir(row.entry.path) }
    else if (rows[cursor.index + 1]?.kind === 'entry') cursor.moveBy(1)
  }

  /** h / ← : collapse an expanded dir; otherwise jump to the parent dir. */
  function collapseOrParent() {
    const row = cursorRow
    if (!row || row.kind === 'match') return
    if (row.kind === 'entry' && row.entry.type === 'dir' && expanded.has(row.entry.path)) {
      expanded.delete(row.entry.path)
      return
    }
    // Parent of an entry; for a status row, the dir it sits under.
    const parent = row.kind === 'entry' ? parentDir(row.entry.path) : statusDir(row.key)
    if (parent === '') return
    const i = rows.findIndex((r) => r.key === parent)
    if (i >= 0) cursor.moveTo(i)
  }
  const statusDir = (key: string) => key.slice(key.indexOf(':') + 1)

  /** Leave filter mode and show `path` in the tree (expand its ancestors). */
  async function clearFilter() {
    const target = preview?.path ?? (cursorRow?.kind === 'match' ? cursorRow.path : null)
    query = ''
    rootEl?.focus()
    if (!target) return
    const anc = ancestorDirs(target)
    for (const d of anc) expanded.add(d)
    selectedKey = target // reconcile effect lands the cursor once the rows exist
    await Promise.all(anc.map(loadDir))
    await tick()
    const i = rows.findIndex((r) => r.key === target)
    if (i < 0) return
    cursor.index = i
    // Centre the revealed row — it's a jump, not a step (scrollToIndex would
    // leave it pinned to the bottom edge).
    if (listEl) listEl.scrollTop = Math.max(0, i * ROW_HEIGHT - listEl.clientHeight / 2)
  }

  function onRowsClick(e: MouseEvent) {
    const t = (e.target as Element).closest('[data-idx]')
    if (!t) return
    const i = Number(t.getAttribute('data-idx'))
    cursor.moveTo(i)
    selectedKey = rows[i]?.key ?? null
    activate(i)
  }

  /** Exported for App's overlay delegation (keys reach here whenever focus
   *  isn't in a text field). Returns true when consumed. */
  export function handleKeydown(e: KeyboardEvent): boolean {
    if (e.metaKey || e.ctrlKey || e.altKey) return false
    if (cursor.handleKey(e)) return true
    switch (e.key) {
      case 'l': case 'ArrowRight': expandOrEnter(); return true
      case 'h': case 'ArrowLeft': collapseOrParent(); return true
      case 'H':
        if (onfilehistory && preview) onfilehistory(preview.path)
        return true
      case 'Escape':
        if (filtering) clearFilter()
        else onclose()
        return true
    }
    return false
  }

  // The filter input owns its keys (App's router stops at "focus is in an
  // input"): arrows navigate the results, Enter opens, Escape clears.
  function onFilterKeydown(e: KeyboardEvent) {
    if (e.key === 'Escape') {
      e.preventDefault()
      if (filtering) clearFilter()
      else rootEl?.focus()
      return
    }
    if (e.key === 'Enter') {
      e.preventDefault()
      activate(cursor.index)
      return
    }
    cursor.handleKey(e) // ArrowUp/Down only (j/k type while focused)
  }

  // Focus the panel so the first keystroke reaches it (App delegates by
  // overlay state, but focus must leave whatever was clicked underneath).
  $effect(() => { if (rootEl) tick().then(() => rootEl?.focus()) })

  // ── Display helpers ───────────────────────────────────────────────────────
  const splitPath = (p: string) => {
    const i = p.lastIndexOf('/')
    return i < 0 ? { dir: '', base: p } : { dir: p.slice(0, i + 1), base: p.slice(i + 1) }
  }
  function markFor(path: string) { return marks.files.get(path) }
  function copyPath(p: string) { navigator.clipboard?.writeText(p).catch(() => {}) }
</script>

<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
<div class="ft-root" bind:this={rootEl} tabindex="-1" role="dialog" aria-label="Files at revision {changeId.slice(0, 8)}">
  <div class="ft-header">
    <span class="ft-title">
      Files at <code class="ft-change">{changeId.slice(0, 8)}</code>
      {#if totalFiles !== null}
        <span class="ft-count">{totalFiles.toLocaleString()} file{totalFiles === 1 ? '' : 's'}</span>
      {/if}
      {#if truncated}
        <span class="ft-warn" title="The listing hit the server cap; files sorting after the last listed path are not shown. Search covers the listed part only.">listing truncated</span>
      {/if}
    </span>
    <span class="panel-actions">
      <button class="close-btn" onclick={onclose} title="Close (Esc)">✕</button>
    </span>
  </div>

  <div class="ft-body">
    <div class="ft-side">
      <div class="ft-filter">
        <input
          bind:this={filterEl}
          bind:value={query}
          class="ft-filter-input"
          placeholder="Filter all files… (/)"
          spellcheck="false"
          autocomplete="off"
          onfocus={() => filterFocused = true}
          onblur={() => filterFocused = false}
          onkeydown={onFilterKeydown}
        />
      </div>
      <!-- svelte-ignore a11y_click_events_have_key_events -->
      <div
        class="ft-list"
        bind:this={listEl}
        role="tree"
        tabindex="-1"
        aria-label="File tree"
        onmousemove={cursor.onRowsMouseMove}
        onmouseleave={cursor.onRowsMouseLeave}
        onclick={onRowsClick}
      >
        <div class="ft-rows" style="height:{win.totalHeight}px">
          {#each renderItems as item (rows[item.index]?.key ?? item.index)}
            {@const row = rows[item.index]}
            {#if row}
              <div
                class="ft-row"
                class:ft-cursor={item.index === cursor.index}
                class:ft-hovered={item.index === cursor.hovered}
                data-idx={item.index}
                role="treeitem"
                aria-selected={item.index === cursor.index}
                style="transform:translateY({item.start}px)"
              >
                {#if row.kind === 'status'}
                  <span class="ft-indent" style="width:{row.depth * 14 + 18}px"></span>
                  <span class="ft-status" class:ft-error={row.error}>{row.text}</span>
                {:else if row.kind === 'entry'}
                  {@const e = row.entry}
                  {@const m = markFor(e.path)}
                  <span class="ft-indent" style="width:{row.depth * 14}px"></span>
                  {#if e.type === 'dir'}
                    <span class="ft-chevron">{expanded.has(e.path) ? '▾' : '▸'}</span>
                    <span class="ft-name ft-dir">{visiblePath(e.name)}/</span>
                    {#if marks.dirs.has(e.path)}<span class="ft-dot" title="Contains files changed in this revision"></span>{/if}
                    <span class="ft-meta">{e.files?.toLocaleString()}</span>
                  {:else}
                    <span class="ft-chevron"></span>
                    <span class="ft-name" class:ft-conflict={e.type === 'conflict' || m?.conflict} class:ft-changed={!!m}>{visiblePath(e.name)}</span>
                    {#if e.type === 'symlink'}<span class="ft-tag" title="Symlink">→</span>{/if}
                    {#if e.type === 'git-submodule'}<span class="ft-tag" title="Git submodule">⊙</span>{/if}
                    {#if e.executable}<span class="ft-tag" title="Executable">*</span>{/if}
                    {#if m}
                      <span class="ft-badge" class:badge-A={m.type === 'A'} class:badge-M={m.type === 'M'} class:badge-R={m.type === 'R' || m.type === 'C'} class:badge-x={m.conflict}
                        title="{m.conflict ? 'Conflicted — ' : ''}{FILE_TYPE_LABELS[m.type] ?? m.type} in this revision">{m.conflict ? '!' : m.type}</span>
                    {/if}
                  {/if}
                {:else}
                  {@const sp = splitPath(row.path)}
                  {@const m = markFor(row.path)}
                  <span class="ft-name ft-match" class:ft-changed={!!m}><span class="ft-match-dir">{visiblePath(sp.dir)}</span>{visiblePath(sp.base)}</span>
                  {#if m}<span class="ft-badge" class:badge-A={m.type === 'A'} class:badge-M={m.type === 'M'} class:badge-R={m.type === 'R' || m.type === 'C'} class:badge-x={m.conflict}>{m.conflict ? '!' : m.type}</span>{/if}
                {/if}
              </div>
            {/if}
          {/each}
        </div>
      </div>
      <div class="ft-foot">
        {#if filtering && search.value}
          {#if search.value.total > search.value.matches.length}
            best {search.value.matches.length} of {search.value.total.toLocaleString()} matches
          {:else}
            {search.value.total.toLocaleString()} match{search.value.total === 1 ? '' : 'es'}
          {/if}
        {:else}
          <kbd>j</kbd>/<kbd>k</kbd> move <kbd>h</kbd>/<kbd>l</kbd> fold <kbd>/</kbd> filter <kbd>Esc</kbd> {filtering ? 'clear' : 'close'}
        {/if}
      </div>
    </div>

    <div class="ft-viewer">
      {#if preview}
        {@const sp = splitPath(preview.path)}
        {@const m = markFor(preview.path)}
        <div class="ft-viewer-header">
          <span class="ft-viewer-path" title={visiblePath(preview.path)}><span class="ft-match-dir">{visiblePath(sp.dir)}</span>{visiblePath(sp.base)}</span>
          {#if m}<span class="ft-chip">{m.conflict ? 'conflicted' : (FILE_TYPE_LABELS[m.type] ?? m.type).toLowerCase()} in this revision</span>{/if}
          {#if preview.executable}<span class="ft-chip">executable</span>{/if}
          {#if view?.kind === 'text' && view.total > 0}<span class="ft-viewer-meta">{view.total.toLocaleString()} line{view.total === 1 ? '' : 's'}</span>{/if}
          <span class="panel-actions">
            {#if onfilehistory}
              <button class="btn btn-sm" onclick={() => onfilehistory(preview!.path)} title="File history (H)">History</button>
            {/if}
            {#if onopenfile && isWorkingCopy}
              <button class="btn btn-sm" onclick={() => onopenfile(preview!.path)} title="Open the working-copy file in $EDITOR">Open in editor</button>
            {/if}
            <button class="btn btn-sm" onclick={() => copyPath(preview!.path)} title="Copy repo-relative path">Copy path</button>
          </span>
        </div>
        <div class="ft-viewer-body" bind:this={viewerScrollEl}>
          {#if viewer.error}
            <div class="ft-empty ft-error">{viewer.error}</div>
          {:else if !viewer.value || viewer.value.path !== preview.path}
            <div class="ft-empty">Loading…</div>
          {:else if view?.kind === 'submodule'}
            <div class="ft-empty">Git submodule — its contents live in another repository.</div>
          {:else if view?.kind === 'symlink'}
            <div class="ft-empty">
              {#if view.target}Symlink → <code>{view.target}</code>{:else}Symlink — jj doesn't print a link's target, so there's nothing to show.{/if}
            </div>
          {:else if view?.kind === 'image'}
            <div class="ft-image"><img src={api.fileRawUrl(commitId, preview.path)} alt={preview.path} /></div>
          {:else if view?.kind === 'binary'}
            <div class="ft-empty">Binary file — not shown.</div>
          {:else if view?.kind === 'text'}
            {#if view.total === 0}
              <div class="ft-empty">(empty file)</div>
            {:else}
              <div class="ft-code" class:ft-plain={!view.highlighted}>
                {#each view.html as line, i}
                  <div class="ft-line"><span class="ft-ln">{i + 1}</span><span class="ft-lc">{@html line}</span></div>
                {/each}
              </div>
              {#if view.total > view.html.length}
                <div class="ft-empty">… {(view.total - view.html.length).toLocaleString()} more lines not shown{onopenfile && isWorkingCopy ? ' — open in your editor for the rest' : ''}.</div>
              {/if}
            {/if}
          {/if}
        </div>
      {:else}
        <div class="ft-empty ft-hint">
          Select a file to view it at <code>{changeId.slice(0, 8)}</code>.
          <div class="ft-hint-keys"><kbd>⏎</kbd>/<kbd>l</kbd> expand · <kbd>h</kbd> collapse · <kbd>/</kbd> search all paths · <kbd>H</kbd> history</div>
        </div>
      {/if}
    </div>
  </div>
</div>

<style>
  .ft-root {
    display: flex;
    flex-direction: column;
    height: 100%;
    width: 100%; /* parent overlay is display:flex (same as FileHistoryPanel) */
    background: var(--base);
  }
  .ft-root:focus, .ft-list:focus { outline: none; }
  .ft-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 8px 12px;
    border-bottom: 1px solid var(--surface0);
    font-size: var(--fs-md);
  }
  .ft-title { display: flex; align-items: baseline; gap: 8px; }
  .ft-change { font-family: var(--font-mono); color: var(--amber); font-weight: 600; }
  .ft-count { font-size: var(--fs-xs); color: var(--subtext0); }
  .ft-warn {
    font-size: var(--fs-xs);
    color: var(--amber);
    border: 1px solid color-mix(in srgb, var(--amber) 40%, transparent);
    border-radius: 3px;
    padding: 0 4px;
  }
  .ft-body { display: flex; flex: 1; min-height: 0; }

  /* ── Tree side ── */
  .ft-side {
    width: 380px;
    min-width: 260px;
    max-width: 40%;
    display: flex;
    flex-direction: column;
    background: var(--mantle);
    border-right: 1px solid var(--surface0);
  }
  .ft-filter { padding: 6px 8px; border-bottom: 1px solid var(--surface0); }
  .ft-filter-input {
    width: 100%;
    box-sizing: border-box;
    padding: 3px 6px;
    background: var(--base);
    color: var(--text);
    border: 1px solid var(--surface1);
    border-radius: 3px;
    font-family: var(--font-mono);
    font-size: var(--fs-sm);
  }
  .ft-filter-input:focus { outline: none; border-color: var(--amber); }
  .ft-list {
    flex: 1;
    min-height: 0;
    overflow: auto;
    position: relative;
    user-select: none;
  }
  .ft-rows { position: relative; min-width: 100%; }
  .ft-row {
    position: absolute;
    left: 0;
    right: 0;
    height: 20px; /* = ROW_HEIGHT — fixed for windowing */
    display: flex;
    align-items: center;
    gap: 4px;
    padding: 0 8px;
    border-left: 2px solid transparent;
    font-family: var(--font-mono);
    font-size: var(--fs-sm);
    white-space: nowrap;
    overflow: hidden;
    cursor: pointer;
    color: var(--text);
  }
  .ft-hovered { background: var(--bg-hover); }
  .ft-cursor {
    background: color-mix(in srgb, var(--amber) 12%, transparent);
    border-left-color: var(--amber);
  }
  .ft-indent { flex-shrink: 0; }
  .ft-chevron { width: 12px; flex-shrink: 0; color: var(--subtext0); text-align: center; }
  .ft-name { overflow: hidden; text-overflow: ellipsis; min-width: 0; }
  .ft-dir { color: var(--blue); }
  .ft-changed { color: var(--amber); }
  .ft-conflict { color: var(--red); }
  .ft-match { flex: 1; direction: ltr; }
  .ft-match-dir { color: var(--text-faint); }
  .ft-tag { color: var(--subtext0); font-size: var(--fs-xs); flex-shrink: 0; }
  .ft-dot {
    width: 6px; height: 6px; border-radius: 50%; flex-shrink: 0;
    background: var(--amber);
  }
  .ft-meta {
    margin-left: auto;
    padding-left: 8px;
    font-size: var(--fs-2xs);
    color: var(--text-faint);
    flex-shrink: 0;
  }
  .ft-badge {
    margin-left: auto;
    flex-shrink: 0;
    font-size: var(--fs-2xs);
    font-weight: bold;
    padding: 0 4px;
    border-radius: 3px;
    color: var(--subtext0);
  }
  .ft-badge.badge-A { background: var(--badge-add-bg); color: var(--green); }
  .ft-badge.badge-M { background: var(--badge-modify-bg); color: var(--amber); }
  .ft-badge.badge-R { background: var(--badge-other-bg); color: var(--amber); }
  .ft-badge.badge-x { background: var(--badge-delete-bg); color: var(--red); }
  .ft-status { color: var(--subtext0); font-style: italic; overflow: hidden; text-overflow: ellipsis; }
  .ft-foot {
    padding: 4px 8px;
    border-top: 1px solid var(--surface0);
    font-size: var(--fs-2xs);
    color: var(--subtext0);
    white-space: nowrap;
    overflow: hidden;
  }
  kbd {
    padding: 0 3px;
    border: 1px solid var(--surface1);
    border-radius: 3px;
    font-family: var(--font-mono);
    font-size: var(--fs-2xs);
  }

  /* ── Viewer ── */
  .ft-viewer { flex: 1; min-width: 0; display: flex; flex-direction: column; }
  .ft-viewer-header {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 6px 12px;
    border-bottom: 1px solid var(--surface0);
    font-size: var(--fs-sm);
    min-height: 20px;
  }
  .ft-viewer-path {
    font-family: var(--font-mono);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    min-width: 0;
  }
  .ft-chip {
    font-size: var(--fs-2xs);
    color: var(--subtext0);
    border: 1px solid var(--surface1);
    border-radius: 3px;
    padding: 0 4px;
    white-space: nowrap;
  }
  .ft-viewer-meta { font-size: var(--fs-2xs); color: var(--text-faint); white-space: nowrap; }
  .ft-viewer-header .panel-actions { margin-left: auto; }
  .ft-viewer-body { flex: 1; min-height: 0; overflow: auto; }
  .ft-code {
    font-family: var(--font-mono);
    font-size: var(--fs-sm);
    line-height: 1.5;
    padding: 4px 0;
  }
  .ft-line {
    /* Hanging indent keeps wrapped lines clear of the gutter (DiffFileView pattern). */
    --gutter: 6ch;
    padding: 0 12px 0 var(--gutter);
    text-indent: calc(-1 * var(--gutter));
    white-space: pre-wrap;
    word-break: break-all;
  }
  .ft-ln {
    display: inline-block;
    width: calc(var(--gutter) - 1ch);
    padding-right: 1ch;
    text-align: right;
    text-indent: 0;
    color: var(--text-faint);
    user-select: none;
  }
  .ft-image { padding: 16px; }
  .ft-image img {
    max-width: 100%;
    background: repeating-conic-gradient(var(--surface1) 0% 25%, transparent 0% 50%) 50% / 16px 16px;
  }
  .ft-empty {
    padding: 20px;
    text-align: center;
    color: var(--subtext0);
    font-size: var(--fs-sm);
  }
  .ft-empty code { font-family: var(--font-mono); color: var(--text); }
  .ft-hint { padding-top: 60px; }
  .ft-hint-keys { margin-top: 10px; font-size: var(--fs-xs); }
  .ft-error { color: var(--red); }
</style>
