<script lang="ts">
  import { tick } from 'svelte'
  import { SvelteSet } from 'svelte/reactivity'
  import { api, effectiveId, type LogEntry, type FileChange, type PullRequest } from './api'
  import { parseDiffContent, type DiffFile, type DiffLine } from './diff-parser'
  import { groupByWithIndex } from './group-by'
  import { computeWordDiffs, type WordSpan } from './word-diff'
  import { highlightLines, detectLanguage } from './highlighter'
  import DescriptionEditor from './DescriptionEditor.svelte'
  import DiffFileView from './DiffFileView.svelte'

  interface Props {
    diffContent: string
    changedFiles: FileChange[]
    selectedRevision: LogEntry | null
    fullDescription: string
    checkedRevisions: SvelteSet<string>
    diffLoading: boolean
    filesLoading: boolean
    splitView: boolean
    descriptionEditing: boolean
    descriptionDraft: string
    describeSaved: boolean
    commitMode: boolean
    onstartdescribe: () => void
    ondescribe: () => void
    oncanceldescribe: () => void
    ondraftchange: (value: string) => void
    onbookmarkclick: (name: string) => void
    fileSelectionMode: boolean
    squashSelectedFiles: SvelteSet<string>
    ontogglefile: (path: string) => void
    splitMode: boolean
    onresolve?: (file: string, tool: ':ours' | ':theirs') => void
    divergentSelected?: boolean
    onresolveDivergence?: () => void
    prByBookmark: Map<string, PullRequest>
  }

  let {
    diffContent, changedFiles, selectedRevision, fullDescription, checkedRevisions,
    diffLoading, filesLoading, splitView = $bindable(false), descriptionEditing, descriptionDraft, describeSaved, commitMode,
    onstartdescribe, ondescribe, oncanceldescribe, ondraftchange, onbookmarkclick,
    fileSelectionMode, squashSelectedFiles, ontogglefile, splitMode, onresolve,
    divergentSelected, onresolveDivergence, prByBookmark,
  }: Props = $props()

  // --- Local state ---
  let fileSelectIdx: number = $state(0)
  let fileSelectionListEl: HTMLElement | undefined = $state(undefined)
  let collapsedFiles = new SvelteSet<string>()
  // Persist collapse state per revision so switching back restores it
  let collapseStateCache = new Map<string, Set<string>>()
  // Expanded files: store full-context DiffFile per file path
  let expandedDiffs: Map<string, DiffFile> = $state(new Map())

  let parsedDiff = $derived(parseDiffContent(diffContent))

  // Aggregate diff stats across all files
  let totalStats = $derived.by(() => {
    let add = 0, del = 0
    for (const f of changedFiles) {
      add += f.additions
      del += f.deletions
    }
    return { add, del }
  })

  let conflictCount = $derived(changedFiles.filter(f => f.conflict).length)

  // Pre-built map for O(1) file stats lookup
  let fileStatsMap = $derived(new Map(changedFiles.map(f => [f.path, f])))

  // Conflict-only files: in changedFiles with conflict=true but not in parsedDiff.
  // These don't appear in jj diff --tool :git output — we fetch their content via
  // jj file show and convert to DiffFile objects with all lines as 'add' type.
  let conflictOnlyFiles = $derived.by(() => {
    if (conflictCount === 0) return []
    const diffPaths = new Set(parsedDiff.map(f => f.filePath))
    return changedFiles.filter(f => f.conflict && !diffPaths.has(f.path))
  })

  // Active revset: multi-checked join or single selected revision
  let activeRevset = $derived(
    checkedRevisions.size > 0
      ? [...checkedRevisions].join('|')
      : selectedRevision ? effectiveId(selectedRevision.commit) : undefined
  )

  let conflictFileDiffs: Map<string, DiffFile> = $state(new Map())
  let conflictFetchGen = 0

  $effect(() => {
    const gen = ++conflictFetchGen
    const files = conflictOnlyFiles
    if (files.length === 0) {
      if (conflictFileDiffs.size > 0) conflictFileDiffs = new Map()
      return
    }
    const revset = activeRevset
    if (!revset) return
    for (const f of files) {
      if (conflictFileDiffs.has(f.path)) continue
      api.fileShow(revset, f.path).then(result => {
        if (gen !== conflictFetchGen) return // discard stale responses
        const lines: DiffLine[] = result.content.split('\n').map(line => ({
          type: 'add' as const,
          content: '+' + line,
        }))
        conflictFileDiffs = new Map(conflictFileDiffs).set(f.path, {
          header: `Conflicted file: ${f.path}`,
          filePath: f.path,
          hunks: [{ header: '@@ conflict @@', oldStart: 1, newStart: 1, newCount: lines.length, lines }],
        })
      }).catch(() => {})
    }
  })

  // File suffixes where word-level diffs add noise rather than value
  const SKIP_WORD_DIFF_SUFFIXES = [
    '.svg', '.xml', '.csv', '.tsv', '.json', '.yaml', '.yml', '.toml',
    '.lock', '.map', '.min.js', '.min.css', '.bundle.js',
  ]

  // Max total lines per file before skipping word diff (avoids blocking main thread)
  const WORD_DIFF_LINE_LIMIT = 1000
  // Auto-collapse files larger than this to prevent DOM flooding
  const AUTO_COLLAPSE_LINE_LIMIT = 500

  function shouldSkipWordDiff(filePath: string, lineCount: number): boolean {
    if (lineCount > WORD_DIFF_LINE_LIMIT) return true
    const lower = filePath.toLowerCase()
    return SKIP_WORD_DIFF_SUFFIXES.some(suffix => lower.endsWith(suffix))
  }

  // Memoize word diffs — recomputed when parsedDiff or expandedDiffs change
  let wordDiffMap = $derived.by(() => {
    const map = new Map<string, Map<number, WordSpan[]>>()
    for (const file of parsedDiff) {
      const effectiveFile = expandedDiffs.get(file.filePath) ?? file
      const filePath = effectiveFile.filePath
      const lineCount = effectiveFile.hunks.reduce((sum, h) => sum + h.lines.length, 0)
      if (shouldSkipWordDiff(filePath, lineCount)) continue
      for (let hunkIdx = 0; hunkIdx < effectiveFile.hunks.length; hunkIdx++) {
        map.set(`${filePath}:${hunkIdx}`, computeWordDiffs(effectiveFile.hunks[hunkIdx]))
      }
    }
    return map
  })

  // --- Syntax highlighting ---
  // Per-file highlight maps. highlightDiff updates individual file entries,
  // so only the DiffFileViews for changed files see a new Map reference.
  let highlightsByFile: Map<string, Map<string, string>> = $state(new Map())
  let highlightGeneration = 0

  let lastHighlightedDiff = ''
  let highlightTimer: number | undefined

  async function highlightDiff(files: DiffFile[]) {
    const gen = ++highlightGeneration
    // Accumulate completed files locally; push to state after each file
    const done = new Map<string, Map<string, string>>()
    for (let fileIdx = 0; fileIdx < files.length; fileIdx++) {
      const file = files[fileIdx]
      // Yield between files so the browser can paint and process input
      await new Promise<void>(resolve => setTimeout(resolve, 0))
      if (gen !== highlightGeneration) return

      const filePath = file.filePath
      const lang = detectLanguage(filePath)
      const fileMap = new Map<string, string>()

      for (let hunkIdx = 0; hunkIdx < file.hunks.length; hunkIdx++) {
        const hunk = file.hunks[hunkIdx]
        // Group lines by type so Shiki highlights each group with correct context
        const groups = new Map<DiffLine['type'], { idx: number; content: string }[]>()
        hunk.lines.forEach((line, i) => {
          const list = groups.get(line.type) ?? []
          list.push({ idx: i, content: line.content.slice(1) })
          groups.set(line.type, list)
        })

        for (const [type, group] of groups) {
          const highlighted = await highlightLines(group.map(g => g.content), lang)
          if (gen !== highlightGeneration) return
          const prefix = type === 'add' ? '+' : type === 'remove' ? '-' : ' '
          group.forEach((g, j) => {
            fileMap.set(
              `${filePath}:${hunkIdx}:${g.idx}`,
              `<span class="diff-prefix">${prefix}</span>${highlighted[j]}`,
            )
          })
        }
      }

      done.set(filePath, fileMap)
      // Publish after each file. Files already done keep their existing Map
      // reference (in `done`); files not yet done are absent. The outer Map
      // identity changes to trigger template reads, but inner Maps that haven't
      // changed since last publish are reused so those DiffFileViews don't re-render.
      if (gen === highlightGeneration) {
        highlightsByFile = new Map(done)
      }
    }
  }

  // Build effective file list that substitutes expanded versions
  let effectiveFiles = $derived(
    parsedDiff.map(f => expandedDiffs.get(f.filePath) ?? f)
  )

  $effect(() => {
    clearTimeout(highlightTimer)
    if (parsedDiff.length > 0 && diffContent !== lastHighlightedDiff) {
      lastHighlightedDiff = diffContent
      // Clear stale highlights immediately to prevent wrong-color flicker
      // when old and new diffs share the same file/hunk/line keys
      highlightsByFile = new Map()
      // Defer Shiki so it doesn't block the keydown → paint path.
      // Plain text + word-diff renders instantly; syntax colors appear ~150ms later.
      highlightTimer = setTimeout(() => highlightDiff(effectiveFiles), 150)
    } else if (parsedDiff.length === 0) {
      lastHighlightedDiff = ''
      highlightsByFile = new Map()
    }
    return () => clearTimeout(highlightTimer)
  })

  // Save/restore collapse state when revision changes
  let lastRevisionId: string | null = null
  $effect(() => {
    const currentId = selectedRevision ? effectiveId(selectedRevision.commit) : null
    if (currentId === lastRevisionId) return
    // Save current state before switching
    if (lastRevisionId && collapsedFiles.size > 0) {
      collapseStateCache.set(lastRevisionId, new Set(collapsedFiles))
      if (collapseStateCache.size > 50) {
        // Evict oldest entry (Map preserves insertion order)
        collapseStateCache.delete(collapseStateCache.keys().next().value!)
      }
    }
    // Restore saved state or start expanded
    collapsedFiles.clear()
    expandedDiffs = new Map()
    conflictFetchGen++ // invalidate any in-flight fileShow requests
    conflictFileDiffs = new Map()
    const saved = currentId ? collapseStateCache.get(currentId) : null
    if (saved) {
      for (const path of saved) collapsedFiles.add(path)
      // Suppress auto-collapse for cached revisions — user's manual expand/collapse
      // choices are already preserved in the cache
      lastAutoCollapseDiff = diffContent
    }
    lastRevisionId = currentId
  })

  // Auto-collapse large files to prevent DOM flooding
  let lastAutoCollapseDiff = ''
  $effect(() => {
    if (!diffContent || diffContent === lastAutoCollapseDiff) return
    lastAutoCollapseDiff = diffContent
    for (const file of parsedDiff) {
      const lineCount = file.hunks.reduce((sum, h) => sum + h.lines.length, 0)
      if (lineCount > AUTO_COLLAPSE_LINE_LIMIT) collapsedFiles.add(file.filePath)
    }
  })

  // --- Expand context ---
  async function expandFile(filePath: string) {
    if (!activeRevset) return
    try {
      const result = await api.diff(activeRevset, filePath, 10000)
      const parsed = parseDiffContent(result.diff)
      if (parsed.length > 0) {
        expandedDiffs = new Map(expandedDiffs).set(filePath, parsed[0])
        const files = parsedDiff.map(f => expandedDiffs.get(f.filePath) ?? f)
        clearTimeout(highlightTimer)
        highlightTimer = setTimeout(() => highlightDiff(files), 50)
      }
    } catch {
      // Silently fail — the unexpanded diff remains visible
    }
  }

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
      collapsedFiles.add(f.filePath)
    }
  }

  function expandAll() {
    collapsedFiles.clear()
  }

  function scrollToFile(path: string) {
    collapsedFiles.delete(path)
    requestAnimationFrame(() => {
      const el = document.querySelector(`[data-file-path="${CSS.escape(path)}"]`)
      el?.scrollIntoView({ block: 'start', behavior: 'smooth' })
    })
  }

  // Reset collapsed files when diff changes significantly (e.g., multi-select)
  export function resetCollapsed() {
    collapsedFiles.clear()
    if (lastRevisionId) collapseStateCache.delete(lastRevisionId)
  }

  // --- Diff search ---
  let searchOpen = $state(false)
  let searchQuery = $state('')
  let searchInputEl: HTMLInputElement | undefined = $state(undefined)
  let currentMatchIdx = $state(0)

  export interface SearchMatch {
    filePath: string
    hunkIdx: number
    lineIdx: number
    startCol: number
    endCol: number
  }

  function findMatchesInFile(file: DiffFile, query: string, matches: SearchMatch[]) {
    for (let hunkIdx = 0; hunkIdx < file.hunks.length; hunkIdx++) {
      const hunk = file.hunks[hunkIdx]
      for (let lineIdx = 0; lineIdx < hunk.lines.length; lineIdx++) {
        const text = hunk.lines[lineIdx].content.slice(1) // strip +/-/space prefix
        let pos = 0
        const lower = text.toLowerCase()
        while ((pos = lower.indexOf(query, pos)) !== -1) {
          matches.push({ filePath: file.filePath, hunkIdx, lineIdx, startCol: pos, endCol: pos + query.length })
          pos += 1
        }
      }
    }
  }

  let searchMatches: SearchMatch[] = $derived.by(() => {
    if (!searchQuery || searchQuery.length < 2) return []
    const query = searchQuery.toLowerCase()
    const matches: SearchMatch[] = []
    for (const file of effectiveFiles) findMatchesInFile(file, query, matches)
    // Include conflict-only files (not in parsedDiff)
    for (const file of conflictFileDiffs.values()) {
      if (!effectiveFiles.some(f => f.filePath === file.filePath)) {
        findMatchesInFile(file, query, matches)
      }
    }
    return matches
  })

  // Pre-group search matches by filePath so each DiffFileView receives only its
  // own matches. Preserves global index for "is this the current match?" checks.
  const EMPTY_MATCHES: { item: SearchMatch; index: number }[] = []
  const EMPTY_MATCH_MAP = new Map<string, { item: SearchMatch; index: number }[]>()
  let matchesByFile = $derived(
    searchOpen && searchMatches.length > 0
      ? groupByWithIndex(searchMatches, m => m.filePath)
      : EMPTY_MATCH_MAP
  )

  const EMPTY_HL: Map<string, string> = new Map()

  // Clamp currentMatchIdx when matches change
  $effect(() => {
    if (searchMatches.length === 0) {
      currentMatchIdx = 0
    } else if (currentMatchIdx >= searchMatches.length) {
      currentMatchIdx = searchMatches.length - 1
    }
  })

  // Reset search when revision changes
  let lastSearchRevId: string | null = null
  $effect(() => {
    const id = selectedRevision ? effectiveId(selectedRevision.commit) : null
    if (id === lastSearchRevId) return
    lastSearchRevId = id
    if (searchOpen) {
      searchQuery = ''
      currentMatchIdx = 0
    }
  })

  export function openSearch() {
    if (!selectedRevision && checkedRevisions.size === 0) return
    if (searchOpen) {
      // Re-focus and select all
      searchInputEl?.focus()
      searchInputEl?.select()
      return
    }
    searchOpen = true
    requestAnimationFrame(() => searchInputEl?.focus())
  }

  function closeSearch() {
    searchOpen = false
    searchQuery = ''
    currentMatchIdx = 0
  }

  function handleSearchKeydown(e: KeyboardEvent) {
    if (e.key === 'Enter') {
      e.preventDefault()
      e.shiftKey ? prevMatch() : nextMatch()
    } else if (e.key === 'Escape') {
      e.preventDefault()
      closeSearch()
    }
  }

  function nextMatch() {
    if (searchMatches.length === 0) return
    currentMatchIdx = (currentMatchIdx + 1) % searchMatches.length
    scrollToMatch()
  }

  function prevMatch() {
    if (searchMatches.length === 0) return
    currentMatchIdx = (currentMatchIdx - 1 + searchMatches.length) % searchMatches.length
    scrollToMatch()
  }

  async function scrollToMatch() {
    const match = searchMatches[currentMatchIdx]
    if (!match) return
    collapsedFiles.delete(match.filePath)
    // tick() ensures Svelte has flushed DOM updates (e.g. expanding a collapsed file)
    // before we query for the scroll target
    await tick()
    requestAnimationFrame(() => {
      const el = document.querySelector('[data-search-match-current="true"]')
      el?.scrollIntoView({ block: 'center', behavior: 'smooth' })
    })
  }

  function scrollFileSelectIntoView() {
    requestAnimationFrame(() => {
      fileSelectionListEl?.querySelector('.file-select-active')?.scrollIntoView({ block: 'nearest' })
    })
  }

  function handleFileSelectionKeydown(e: KeyboardEvent) {
    switch (e.key) {
      case 'ArrowDown':
      case 'j':
        e.preventDefault()
        if (fileSelectIdx < changedFiles.length - 1) { fileSelectIdx++; scrollFileSelectIntoView() }
        break
      case 'ArrowUp':
      case 'k':
        e.preventDefault()
        if (fileSelectIdx > 0) { fileSelectIdx--; scrollFileSelectIntoView() }
        break
      case ' ':
        e.preventDefault()
        if (changedFiles[fileSelectIdx]) ontogglefile(changedFiles[fileSelectIdx].path)
        break
      case 'a':
        e.preventDefault()
        for (const f of changedFiles) {
          if (!squashSelectedFiles.has(f.path)) ontogglefile(f.path)
        }
        break
      case 'n':
        e.preventDefault()
        for (const f of changedFiles) {
          if (squashSelectedFiles.has(f.path)) ontogglefile(f.path)
        }
        break
    }
  }

  // Auto-focus file selection list when entering split/squash mode
  $effect(() => {
    if (fileSelectionMode && fileSelectionListEl) {
      fileSelectIdx = 0
      fileSelectionListEl.focus()
    }
  })

  export function rehighlight() {
    lastHighlightedDiff = ''
    highlightsByFile = new Map()
    clearTimeout(highlightTimer)
    if (parsedDiff.length > 0) {
      highlightTimer = setTimeout(() => highlightDiff(parsedDiff), 50)
    }
  }
</script>

<div class="panel diff-panel">
  {#if selectedRevision && checkedRevisions.size === 0}
    <div class="revision-detail">
      <div class="detail-header">
        <div class="detail-ids">
          <span class="detail-change-id">{selectedRevision.commit.change_id.slice(0, 8)}</span>
          <span class="detail-description-inline">{(fullDescription || selectedRevision.description) || '(no description)'}</span>
        </div>
        <div class="panel-actions">
          {#if describeSaved}
            <span class="describe-saved">Saved</span>
          {/if}
          <button class="header-btn" onclick={onstartdescribe} title="Edit description (e)">
            Describe
          </button>
          {#if divergentSelected}
            <button class="header-btn divergent-btn" onclick={onresolveDivergence} title="Resolve divergent commit">
              Divergence
            </button>
          {/if}
        </div>
      </div>
      {#if selectedRevision.bookmarks?.length}
        <div class="detail-bookmarks">
          {#each selectedRevision.bookmarks as bm}
            {@const pr = prByBookmark.get(bm)}
            {#if pr}
              <a class="detail-pr-badge" class:is-draft={pr.is_draft}
                 href={pr.url} target="_blank" rel="noopener"
                 title="{pr.is_draft ? 'Draft ' : ''}PR #{pr.number} — click to open on GitHub">
                <svg class="pr-icon" viewBox="0 0 16 16" fill="currentColor"><path d="M5 3.254V3.25a.75.75 0 110 .005v5.45a2.5 2.5 0 101.5 0V5.558a4 4 0 002.74 1.353v1.839a2.5 2.5 0 101.5 0V6.25a.75.75 0 01-1.5 0v-1a.75.75 0 01.75-.75A2.5 2.5 0 007.5 2H7V.75a.25.25 0 00-.4-.2l-1.8 1.35a.25.25 0 000 .4L6.6 3.65a.25.25 0 00.4-.2V2.5h.5a1 1 0 010 2H7a.75.75 0 01-.75-.75v-.001A.75.75 0 015 3.254zM5.75 12a1 1 0 100-2 1 1 0 000 2zm5.5 0a1 1 0 100-2 1 1 0 000 2z"/></svg>
                <span class="pr-name">{bm}</span>
                <span class="pr-number">#{pr.number}</span>
              </a>
            {:else}
              <button class="detail-bookmark-badge" onclick={() => onbookmarkclick(bm)}>{bm}</button>
            {/if}
          {/each}
        </div>
      {/if}
    </div>
  {:else if checkedRevisions.size > 0}
    <div class="panel-header">
      <span class="panel-title">
        Changes in
        <span class="header-change-id">{checkedRevisions.size === 1 ? [...checkedRevisions][0].slice(0, 12) : `${checkedRevisions.size} revisions`}</span>
      </span>
    </div>
  {:else}
    <div class="panel-header">
      <span class="panel-title">Diff Viewer</span>
    </div>
  {/if}
  {#if descriptionEditing && selectedRevision}
    <DescriptionEditor
      revision={selectedRevision}
      draft={descriptionDraft}
      onsave={ondescribe}
      oncancel={oncanceldescribe}
      ondraftchange={ondraftchange}
      {commitMode}
    />
  {/if}
  {#if fileSelectionMode}
    <div class="file-selection-panel" class:split-selection={splitMode}>
      <div class="file-selection-header">
        {#if splitMode}
          <span class="file-selection-title">Split — <kbd>Space</kbd> toggle · <kbd>↑↓</kbd> navigate · <kbd>Enter</kbd> apply</span>
        {:else}
          <span class="file-selection-title">Squash — <kbd>Space</kbd> toggle · <kbd>↑↓</kbd> navigate · <kbd>Enter</kbd> apply</span>
        {/if}
        <span class="file-selection-count">{squashSelectedFiles.size}/{changedFiles.length} {splitMode ? 'stay' : 'selected'}</span>
      </div>
      <!-- svelte-ignore a11y_no_static_element_interactions -->
      <div class="file-selection-list" tabindex="-1"
        onkeydown={handleFileSelectionKeydown}
        bind:this={fileSelectionListEl}>
        {#each changedFiles as file, i (file.path)}
          <!-- svelte-ignore a11y_click_events_have_key_events -->
          <div
            class="file-select-row"
            class:file-select-active={i === fileSelectIdx}
            class:file-checked={squashSelectedFiles.has(file.path)}
            onclick={() => { fileSelectIdx = i; ontogglefile(file.path) }}
            onmouseenter={() => { fileSelectIdx = i }}
            role="option"
            tabindex="-1"
            aria-selected={squashSelectedFiles.has(file.path)}
          >
            <span class="file-check-indicator">{squashSelectedFiles.has(file.path) ? '✓' : ' '}</span>
            {#if file.conflict}
              <span class="file-dot dot-C"></span>
            {:else}
              <span class="file-dot" class:dot-A={file.type === 'A'} class:dot-D={file.type === 'D'} class:dot-M={file.type === 'M'}></span>
            {/if}
            <span class="file-select-path">{file.path}</span>
            {#if file.additions > 0 || file.deletions > 0}
              <span class="file-tab-stats">
                {#if file.additions > 0}<span class="stat-add">+{file.additions}</span>{/if}
                {#if file.deletions > 0}<span class="stat-del">-{file.deletions}</span>{/if}
              </span>
            {/if}
          </div>
        {/each}
      </div>
    </div>
  {/if}
  {#if (selectedRevision || checkedRevisions.size > 0) && changedFiles.length > 0 && !fileSelectionMode}
    <div class="file-list-bar">
      <span class="file-list-label">Files ({changedFiles.length}){#if conflictCount > 0}<span class="conflict-count-label"> · {conflictCount} conflict{conflictCount !== 1 ? 's' : ''}</span>{/if}</span>
      {#if totalStats.add > 0 || totalStats.del > 0}
        <span class="total-stats">
          {#if totalStats.add > 0}<span class="stat-add">+{totalStats.add}</span>{/if}
          {#if totalStats.del > 0}<span class="stat-del">-{totalStats.del}</span>{/if}
        </span>
      {/if}
      <div class="file-tabs">
        {#each changedFiles as file (file.path)}
          <button
            class="file-tab"
            onclick={() => scrollToFile(file.path)}
            title={file.path}
          >
            {#if file.conflict}
              <span class="file-dot dot-C"></span>
            {:else}
              <span class="file-dot" class:dot-A={file.type === 'A'} class:dot-D={file.type === 'D'} class:dot-M={file.type === 'M'}></span>
            {/if}
            <span class="file-tab-name">{file.path.split('/').pop()}</span>
            {#if file.additions > 0 || file.deletions > 0}
              <span class="file-tab-stats">
                {#if file.additions > 0}<span class="stat-add">+{file.additions}</span>{/if}
                {#if file.deletions > 0}<span class="stat-del">-{file.deletions}</span>{/if}
              </span>
            {/if}
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
      <div class="diff-toggle-pill">
        <button
          class="toggle-pill-btn"
          class:toggle-active={!splitView}
          onclick={() => splitView = false}
        >Unified</button>
        <button
          class="toggle-pill-btn"
          class:toggle-active={splitView}
          onclick={() => splitView = true}
        >Split</button>
      </div>
    </div>
  {/if}
  {#if searchOpen}
    <div class="search-bar">
      <input
        bind:this={searchInputEl}
        bind:value={searchQuery}
        class="search-input"
        placeholder="Search in diff..."
        onkeydown={handleSearchKeydown}
      />
      <span class="search-count">
        {#if searchMatches.length > 0}
          {currentMatchIdx + 1} / {searchMatches.length}
        {:else if searchQuery.length >= 2}
          No matches
        {/if}
      </span>
      <button class="search-nav-btn" onclick={prevMatch} disabled={searchMatches.length === 0}>&#9650;</button>
      <button class="search-nav-btn" onclick={nextMatch} disabled={searchMatches.length === 0}>&#9660;</button>
      <button class="search-close-btn" onclick={closeSearch}>&#10005;</button>
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
    {:else if parsedDiff.length === 0 && changedFiles.length === 0 && conflictOnlyFiles.length === 0}
      <div class="empty-state">
        <span class="empty-hint">No changes in this revision</span>
      </div>
    {:else}
      <div class="diff-content">
        {#each parsedDiff as file (file.filePath)}
          {@const filePath = file.filePath}
          {@const effectiveFile = expandedDiffs.get(filePath) ?? file}
          <DiffFileView
            file={effectiveFile}
            fileStats={fileStatsMap.get(filePath)}
            isCollapsed={collapsedFiles.has(filePath)}
            isExpanded={expandedDiffs.has(filePath)}
            {splitView}
            highlightedLines={highlightsByFile.get(filePath) ?? EMPTY_HL}
            {wordDiffMap}
            ontoggle={toggleFile}
            onexpand={expandFile}
            {onresolve}
            searchMatches={matchesByFile.get(filePath) ?? EMPTY_MATCHES}
            {currentMatchIdx}
          />
        {/each}
        {#each conflictOnlyFiles as cf (cf.path)}
          {@const conflictFile = conflictFileDiffs.get(cf.path)}
          {#if conflictFile}
            <DiffFileView
              file={conflictFile}
              fileStats={cf}
              isCollapsed={collapsedFiles.has(cf.path)}
              isExpanded={false}
              {splitView}
              highlightedLines={EMPTY_HL}
              {wordDiffMap}
              ontoggle={toggleFile}
              onexpand={expandFile}
              {onresolve}
              searchMatches={matchesByFile.get(cf.path) ?? EMPTY_MATCHES}
              {currentMatchIdx}
            />
          {:else}
            <div class="diff-file" data-file-path={cf.path}>
              <div class="conflict-file-header">
                <span class="file-type-badge badge-C">C</span>
                <span class="diff-file-path">{cf.path}</span>
                <span class="conflict-loading">Loading...</span>
                {#if onresolve}
                  <button class="resolve-btn resolve-ours" onclick={() => onresolve!(cf.path, ':ours')}>Accept Ours</button>
                  <button class="resolve-btn resolve-theirs" onclick={() => onresolve!(cf.path, ':theirs')}>Accept Theirs</button>
                {/if}
              </div>
            </div>
          {/if}
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
    background: var(--mantle);
    border-bottom: 1px solid var(--surface0);
    flex-shrink: 0;
    user-select: none;
  }

  .panel-title {
    font-size: 11px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--subtext1);
  }

  .header-change-id {
    color: var(--amber);
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

  .divergent-btn {
    color: var(--red);
    border-color: var(--red);
  }

  .divergent-btn:hover {
    background: rgba(235, 100, 100, 0.15);
  }

  .panel-content {
    flex: 1;
    overflow-y: auto;
    overflow-x: hidden;
  }

  /* --- Revision detail --- */
  .revision-detail {
    padding: 8px 12px;
    background: var(--mantle);
    border-bottom: 1px solid var(--surface0);
    flex-shrink: 0;
    font-size: 11px;
    display: flex;
    flex-direction: column;
    gap: 4px;
  }

  .detail-header {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 8px;
  }

  .detail-ids {
    display: flex;
    align-items: baseline;
    gap: 8px;
    min-width: 0;
    flex: 1;
  }

  .detail-change-id {
    font-family: var(--font-mono);
    color: var(--amber);
    font-weight: 600;
    font-size: 12px;
    flex-shrink: 0;
  }

  .detail-description-inline {
    color: var(--text);
    font-size: 12px;
    min-width: 0;
    white-space: pre-wrap;
    word-break: break-word;
  }

  .detail-bookmarks {
    display: flex;
    align-items: center;
    gap: 4px;
    flex-wrap: wrap;
  }

  .detail-bookmark-badge {
    display: inline-flex;
    align-items: center;
    background: var(--bg-bookmark);
    color: var(--green);
    padding: 0 5px;
    border-radius: 3px;
    font-size: 10px;
    font-weight: 600;
    border: 1px solid var(--border-bookmark);
    line-height: 1.15;
    letter-spacing: 0.02em;
    cursor: pointer;
    font-family: inherit;
  }

  .detail-pr-badge {
    display: inline-flex;
    align-items: center;
    gap: 3px;
    background: var(--bg-pr);
    color: var(--blue);
    padding: 0 6px;
    border-radius: 3px;
    font-size: 10px;
    font-weight: 600;
    border: 1px solid var(--border-pr);
    line-height: 1.15;
    letter-spacing: 0.02em;
    cursor: pointer;
    font-family: inherit;
    text-decoration: none;
  }

  .detail-pr-badge:hover {
    border-color: var(--border-pr-hover);
    filter: brightness(1.15);
  }

  .detail-pr-badge.is-draft {
    border-style: dashed;
    opacity: 0.75;
  }

  .pr-icon {
    width: 10px;
    height: 10px;
    flex-shrink: 0;
    opacity: 0.7;
  }

  .pr-name {
    color: var(--blue);
  }

  .pr-number {
    color: var(--overlay0);
    font-weight: 400;
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

  /* --- File selection panel (split/squash) --- */
  .file-selection-panel {
    border-bottom: 1px solid var(--green);
    flex-shrink: 0;
    animation: slide-down var(--anim-duration) var(--anim-ease);
  }

  .file-selection-panel.split-selection {
    border-bottom-color: var(--cyan);
  }

  .file-selection-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 6px 12px;
    background: var(--bg-checked);
    font-size: 11px;
    font-weight: 600;
    color: var(--green);
  }

  .split-selection .file-selection-header {
    background: var(--badge-workspace-bg);
    color: var(--cyan);
  }

  .file-selection-title {
    display: flex;
    align-items: center;
    gap: 4px;
  }

  .file-selection-title kbd {
    background: var(--surface0);
    padding: 0 4px;
    border-radius: 3px;
    font-family: inherit;
    font-size: 10px;
    border: 1px solid var(--surface1);
    color: var(--overlay0);
    font-weight: 500;
  }

  .file-selection-count {
    font-variant-numeric: tabular-nums;
  }

  .file-selection-list {
    display: flex;
    flex-direction: column;
    max-height: 160px;
    overflow-y: auto;
    background: var(--mantle);
    outline: none;
  }

  .file-select-row {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 4px 12px;
    color: var(--text);
    font-size: 12px;
    cursor: pointer;
    user-select: none;
    transition: background-color var(--anim-duration) var(--anim-ease);
  }

  .file-select-row:hover:not(.file-select-active) {
    background: var(--bg-hover);
  }

  .file-select-row.file-select-active {
    background: var(--surface0);
  }

  .file-check-indicator {
    width: 14px;
    flex-shrink: 0;
    text-align: center;
    font-size: 11px;
    font-weight: 700;
    transition: color var(--anim-duration) var(--anim-ease),
                transform var(--anim-duration) var(--anim-ease);
  }

  .file-checked .file-check-indicator {
    color: var(--green);
    transform: scale(1.15);
  }

  .split-selection .file-checked .file-check-indicator {
    color: var(--cyan);
  }

  .file-select-path {
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-family: var(--font-mono);
    font-size: 11px;
    color: var(--subtext0);
  }

  .file-select-row.file-checked .file-select-path {
    color: var(--text);
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
    overflow: hidden;
    min-width: 0;
  }

  .file-list-label {
    color: var(--surface2);
    font-size: 10px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    flex-shrink: 0;
  }

  .total-stats {
    font-size: 11px;
    font-weight: 600;
    flex-shrink: 0;
    display: flex;
    gap: 6px;
  }

  .total-stats .stat-add { color: var(--green); }
  .total-stats .stat-del { color: var(--red); }

  .file-tabs {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    max-height: 52px;
    overflow-y: auto;
    flex: 1;
  }

  .file-tab {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    background: transparent;
    color: var(--subtext0);
    border: none;
    border-bottom: 2px solid transparent;
    padding: 4px 10px;
    cursor: pointer;
    font-family: inherit;
    font-size: 11px;
    white-space: nowrap;
    flex-shrink: 0;
  }

  .file-tab:hover {
    color: var(--text);
    background: var(--bg-hover);
  }

  .file-dot {
    width: 5px;
    height: 5px;
    border-radius: 50%;
    background: var(--subtext0);
    flex-shrink: 0;
  }

  .file-dot.dot-A { background: var(--green); }
  .file-dot.dot-D { background: var(--red); }
  .file-dot.dot-M { background: var(--amber); }
  .file-dot.dot-C { background: var(--red); }

  .file-tab-name {
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .file-tab-stats {
    display: inline-flex;
    gap: 3px;
    font-size: 10px;
    opacity: 0.7;
  }

  .file-tab-stats .stat-add { color: var(--green); }
  .file-tab-stats .stat-del { color: var(--red); }

  .conflict-count-label {
    color: var(--red);
    font-weight: 700;
    text-transform: none;
    letter-spacing: normal;
  }

  .conflict-file-header {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px 12px;
    background: var(--mantle);
    border-bottom: 1px solid var(--surface0);
    font-size: 12px;
    font-weight: 600;
  }

  .badge-C {
    font-size: 10px;
    font-weight: 700;
    padding: 0 4px;
    border-radius: 3px;
    flex-shrink: 0;
    background: var(--badge-delete-bg);
    color: var(--red);
  }

  .conflict-loading {
    color: var(--overlay0);
    font-size: 11px;
    font-weight: 400;
    font-style: italic;
    flex: 1;
  }

  .resolve-btn {
    background: transparent;
    border: 1px solid var(--surface1);
    color: var(--subtext0);
    padding: 1px 6px;
    border-radius: 3px;
    cursor: pointer;
    font-family: inherit;
    font-size: 10px;
    flex-shrink: 0;
  }

  .resolve-ours:hover {
    background: var(--conflict-side1-bg);
    border-color: var(--amber);
    color: var(--amber);
  }

  .resolve-theirs:hover {
    background: var(--conflict-side2-bg);
    border-color: var(--purple);
    color: var(--purple);
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

  .diff-toolbar-left {
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
  }

  .toolbar-btn-sm:hover {
    background: var(--surface0);
    color: var(--text);
  }

  .diff-toggle-pill {
    display: flex;
    background: var(--surface0);
    border-radius: 6px;
    overflow: hidden;
    border: 1px solid var(--surface1);
  }

  .toggle-pill-btn {
    background: transparent;
    border: none;
    color: var(--subtext0);
    padding: 3px 10px;
    cursor: pointer;
    font-family: inherit;
    font-size: 11px;
    font-weight: 500;
  }

  .toggle-pill-btn:hover:not(.toggle-active) {
    color: var(--text);
  }

  .toggle-pill-btn.toggle-active {
    background: var(--bg-active);
    color: var(--amber);
    font-weight: 600;
  }

  /* --- Search bar --- */
  .search-bar {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 4px 12px;
    background: var(--mantle);
    border-bottom: 1px solid var(--surface0);
    flex-shrink: 0;
  }

  .search-input {
    flex: 1;
    background: var(--base);
    border: 1px solid var(--surface1);
    color: var(--text);
    padding: 3px 8px;
    border-radius: 3px;
    font-family: var(--font-mono);
    font-size: 12px;
    outline: none;
  }

  .search-input:focus {
    border-color: var(--amber);
  }

  .search-count {
    font-size: 11px;
    color: var(--subtext0);
    white-space: nowrap;
    min-width: 60px;
    text-align: center;
  }

  .search-nav-btn, .search-close-btn {
    background: transparent;
    border: 1px solid var(--surface1);
    color: var(--subtext0);
    padding: 2px 6px;
    border-radius: 3px;
    cursor: pointer;
    font-size: 11px;
  }

  .search-nav-btn:hover, .search-close-btn:hover {
    background: var(--surface0);
    color: var(--text);
  }

  .search-nav-btn:disabled {
    opacity: 0.3;
    cursor: default;
  }

  .search-nav-btn:disabled:hover {
    background: transparent;
    color: var(--subtext0);
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
    border-top-color: var(--amber);
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
