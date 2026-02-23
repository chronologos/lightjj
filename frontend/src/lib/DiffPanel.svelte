<script lang="ts">
  import { SvelteSet } from 'svelte/reactivity'
  import type { LogEntry, FileChange } from './api'
  import { parseDiffContent } from './diff-parser'
  import { computeWordDiffs, type WordSpan } from './word-diff'
  import { highlightLines, detectLanguage } from './highlighter'
  import DescriptionEditor from './DescriptionEditor.svelte'
  import DiffFileView from './DiffFileView.svelte'

  interface Props {
    diffContent: string
    changedFiles: FileChange[]
    selectedRevision: LogEntry | null
    checkedRevisions: SvelteSet<string>
    diffLoading: boolean
    filesLoading: boolean
    splitView: boolean
    descriptionEditing: boolean
    descriptionDraft: string
    describeSaved: boolean
    onstartdescribe: () => void
    ondescribe: () => void
    oncanceldescribe: () => void
    ondraftchange: (value: string) => void
  }

  let {
    diffContent, changedFiles, selectedRevision, checkedRevisions,
    diffLoading, filesLoading, splitView = $bindable(false), descriptionEditing, descriptionDraft, describeSaved,
    onstartdescribe, ondescribe, oncanceldescribe, ondraftchange,
  }: Props = $props()

  // --- Local state ---
  let collapsedFiles = new SvelteSet<string>()

  let parsedDiff = $derived(parseDiffContent(diffContent))

  // Pre-built map for O(1) file stats lookup
  let fileStatsMap = $derived(new Map(changedFiles.map(f => [f.path, f])))

  // Memoize word diffs — only recomputed when parsedDiff changes
  let wordDiffMap = $derived.by(() => {
    const map = new Map<string, Map<number, WordSpan[]>>()
    for (const file of parsedDiff) {
      const filePath = file.filePath
      for (let hunkIdx = 0; hunkIdx < file.hunks.length; hunkIdx++) {
        map.set(`${filePath}:${hunkIdx}`, computeWordDiffs(file.hunks[hunkIdx]))
      }
    }
    return map
  })

  // --- Syntax highlighting ---
  let highlightedLines: Map<string, string> = $state(new Map())
  let highlightGeneration = 0

  async function highlightDiff(files: import('./diff-parser').DiffFile[]) {
    const gen = ++highlightGeneration
    const newMap = new Map<string, string>()
    for (const file of files) {
      const filePath = file.filePath
      const lang = detectLanguage(filePath)

      for (let hunkIdx = 0; hunkIdx < file.hunks.length; hunkIdx++) {
        const hunk = file.hunks[hunkIdx]
        const addLines: { idx: number; content: string }[] = []
        const removeLines: { idx: number; content: string }[] = []
        const contextLines: { idx: number; content: string }[] = []

        hunk.lines.forEach((line, i) => {
          const stripped = line.content.slice(1)
          if (line.type === 'add') addLines.push({ idx: i, content: stripped })
          else if (line.type === 'remove') removeLines.push({ idx: i, content: stripped })
          else contextLines.push({ idx: i, content: stripped })
        })

        for (const group of [addLines, removeLines, contextLines]) {
          if (group.length === 0) continue
          const highlighted = await highlightLines(group.map(g => g.content), lang)
          if (gen !== highlightGeneration) return
          group.forEach((g, j) => {
            const key = `${filePath}:${hunkIdx}:${g.idx}`
            const line = hunk.lines[g.idx]
            const prefix = line.type === 'add' ? '+' : line.type === 'remove' ? '-' : ' '
            newMap.set(key, `<span class="diff-prefix">${prefix}</span>${highlighted[j]}`)
          })
        }
      }
    }
    if (gen === highlightGeneration) {
      highlightedLines = newMap
    }
  }

  $effect(() => {
    if (parsedDiff.length > 0) {
      highlightDiff(parsedDiff)
    } else {
      highlightedLines = new Map()
    }
  })

  // --- Collapse helpers ---
  function toggleFile(path: string) {
    if (collapsedFiles.has(path)) {
      collapsedFiles.delete(path)
    } else {
      collapsedFiles.add(path)
    }
  }

  function collapseAll() {
    collapsedFiles.clear()
    for (const f of parsedDiff) {
      collapsedFiles.add(filePathFromHeader(f.header))
    }
  }

  function expandAll() {
    collapsedFiles.clear()
  }

  function scrollToFile(path: string) {
    if (collapsedFiles.has(path)) {
      toggleFile(path)
    }
    requestAnimationFrame(() => {
      const el = document.querySelector(`[data-file-path="${CSS.escape(path)}"]`)
      el?.scrollIntoView({ block: 'start', behavior: 'smooth' })
    })
  }

  // Reset collapsed files when diff changes significantly
  export function resetCollapsed() {
    collapsedFiles.clear()
  }
</script>

<div class="panel diff-panel">
  <div class="panel-header">
    {#if checkedRevisions.size > 0}
      <span class="panel-title">
        Changes in
        <span class="header-change-id">{checkedRevisions.size === 1 ? [...checkedRevisions][0].slice(0, 12) : `${checkedRevisions.size} revisions`}</span>
      </span>
    {:else if selectedRevision}
      <span class="panel-title">
        Changes in
        <span class="header-change-id">{selectedRevision.commit.change_id.slice(0, 12)}</span>
      </span>
      <div class="panel-actions">
        {#if describeSaved}
          <span class="describe-saved">Saved</span>
        {/if}
        <button class="header-btn" onclick={onstartdescribe} title="Edit description (e)">
          Describe
        </button>
      </div>
    {:else}
      <span class="panel-title">Diff Viewer</span>
    {/if}
  </div>
  {#if descriptionEditing && selectedRevision}
    <DescriptionEditor
      revision={selectedRevision}
      draft={descriptionDraft}
      onsave={ondescribe}
      oncancel={oncanceldescribe}
      ondraftchange={ondraftchange}
    />
  {/if}
  {#if (selectedRevision || checkedRevisions.size > 0) && changedFiles.length > 0}
    <div class="file-list-bar">
      <span class="file-list-label">Files ({changedFiles.length})</span>
      <div class="file-list">
        {#each changedFiles as file (file.path)}
          <button
            class="file-chip"
            onclick={() => scrollToFile(file.path)}
            title={file.path}
          >
            <span class="file-type-indicator" class:file-type-A={file.type === 'A'} class:file-type-D={file.type === 'D'} class:file-type-M={file.type === 'M'}>{file.type}</span>
            {file.path.split('/').pop()}
          </button>
        {/each}
      </div>
    </div>
  {/if}
  {#if parsedDiff.length > 0}
    <div class="diff-toolbar">
      <div class="diff-toolbar-left">
        <button class="toolbar-btn-sm" onclick={collapseAll}>Collapse all</button>
        <button class="toolbar-btn-sm" onclick={expandAll}>Expand all</button>
      </div>
      <div class="diff-toolbar-right">
        <button
          class="toolbar-btn-sm"
          class:active={!splitView}
          onclick={() => splitView = false}
        >Unified</button>
        <button
          class="toolbar-btn-sm"
          class:active={splitView}
          onclick={() => splitView = true}
        >Split</button>
      </div>
    </div>
  {/if}
  <div class="panel-content">
    {#if diffLoading}
      <div class="empty-state">
        <div class="spinner"></div>
        <span>Loading diff...</span>
      </div>
    {:else if !selectedRevision && checkedRevisions.size === 0}
      <div class="empty-state">
        <span class="empty-hint">Select a revision to view changes</span>
        <span class="empty-subhint">Use <kbd>j</kbd>/<kbd>k</kbd> to navigate, <kbd>Enter</kbd> to select</span>
      </div>
    {:else if parsedDiff.length === 0 && changedFiles.length === 0}
      <div class="empty-state">
        <span class="empty-hint">No changes in this revision</span>
      </div>
    {:else}
      <div class="diff-content">
        {#each parsedDiff as file (file.filePath)}
          {@const filePath = file.filePath}
          <DiffFileView
            {file}
            fileStats={fileStatsMap.get(filePath)}
            isCollapsed={collapsedFiles.has(filePath)}
            {splitView}
            {highlightedLines}
            {wordDiffMap}
            ontoggle={toggleFile}
          />
        {/each}
      </div>
    {/if}
  </div>
</div>

<style>
  .panel {
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }

  .diff-panel {
    flex: 1;
    min-width: 0;
  }

  .panel-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    height: 34px;
    padding: 0 12px;
    background: var(--base);
    border-bottom: 1px solid var(--surface0);
    flex-shrink: 0;
    user-select: none;
  }

  .panel-title {
    font-size: 11px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--subtext0);
  }

  .header-change-id {
    color: var(--blue);
    text-transform: none;
    letter-spacing: normal;
    font-weight: 700;
  }

  .panel-actions {
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .header-btn {
    background: transparent;
    border: 1px solid var(--surface1);
    color: var(--subtext0);
    padding: 2px 8px;
    border-radius: 3px;
    cursor: pointer;
    font-family: inherit;
    font-size: 11px;
    transition: all 0.15s ease;
  }

  .header-btn:hover {
    background: var(--surface0);
    color: var(--text);
  }

  .panel-content {
    flex: 1;
    overflow-y: auto;
    overflow-x: hidden;
  }

  .describe-saved {
    color: var(--green);
    font-size: 11px;
    font-weight: 600;
    animation: save-flash 1.5s ease-out forwards;
  }

  @keyframes save-flash {
    0% { opacity: 1; }
    70% { opacity: 1; }
    100% { opacity: 0; }
  }

  /* --- File list bar --- */
  .file-list-bar {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 6px 12px;
    background: var(--mantle);
    border-bottom: 1px solid var(--surface0);
    flex-shrink: 0;
    overflow-x: auto;
  }

  .file-list-label {
    color: var(--surface2);
    font-size: 10px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    flex-shrink: 0;
  }

  .file-list {
    display: flex;
    align-items: center;
    gap: 4px;
    flex-wrap: wrap;
  }

  .file-chip {
    background: var(--surface0);
    color: var(--subtext0);
    border: 1px solid var(--surface1);
    padding: 1px 8px;
    border-radius: 3px;
    cursor: pointer;
    font-family: inherit;
    font-size: 11px;
    white-space: nowrap;
    transition: all 0.15s ease;
  }

  .file-chip:hover {
    background: var(--surface1);
    color: var(--text);
  }

  .file-type-indicator {
    font-weight: 700;
    font-size: 10px;
    margin-right: 3px;
    color: var(--subtext0);
  }

  .file-type-A {
    color: var(--green);
  }

  .file-type-D {
    color: var(--red);
  }

  .file-type-M {
    color: var(--yellow);
  }

  /* --- Diff toolbar --- */
  .diff-toolbar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 4px 12px;
    background: var(--mantle);
    border-bottom: 1px solid var(--surface0);
    flex-shrink: 0;
  }

  .diff-toolbar-left,
  .diff-toolbar-right {
    display: flex;
    align-items: center;
    gap: 4px;
  }

  .toolbar-btn-sm {
    background: transparent;
    border: 1px solid var(--surface1);
    color: var(--subtext0);
    padding: 2px 8px;
    border-radius: 3px;
    cursor: pointer;
    font-family: inherit;
    font-size: 11px;
    transition: all 0.15s ease;
  }

  .toolbar-btn-sm:hover {
    background: var(--surface0);
    color: var(--text);
  }

  .toolbar-btn-sm.active {
    background: #89b4fa22;
    border-color: var(--blue);
    color: var(--blue);
  }

  .diff-content {
    padding: 0;
  }

  /* --- Empty states --- */
  .empty-state {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 8px;
    padding: 48px 24px;
    color: var(--surface2);
    font-size: 13px;
  }

  .empty-hint {
    color: var(--overlay0);
    font-size: 14px;
  }

  .empty-subhint {
    color: var(--surface1);
    font-size: 12px;
  }

  .empty-subhint kbd {
    background: var(--surface0);
    padding: 1px 4px;
    border-radius: 3px;
    font-family: inherit;
    font-size: 11px;
    border: 1px solid var(--surface1);
    color: var(--overlay0);
  }

  .spinner {
    width: 20px;
    height: 20px;
    border: 2px solid var(--surface0);
    border-top-color: var(--blue);
    border-radius: 50%;
    animation: spin 0.8s linear infinite;
  }

  @keyframes spin {
    to { transform: rotate(360deg); }
  }

  /* --- Scrollbar --- */
  .panel-content::-webkit-scrollbar {
    width: 8px;
  }

  .panel-content::-webkit-scrollbar-track {
    background: transparent;
  }

  .panel-content::-webkit-scrollbar-thumb {
    background: var(--surface0);
    border-radius: 4px;
  }

  .panel-content::-webkit-scrollbar-thumb:hover {
    background: var(--surface1);
  }
</style>
