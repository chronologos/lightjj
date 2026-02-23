<script lang="ts">
  import { api, type LogEntry } from './lib/api'

  // --- State ---
  let revisions: LogEntry[] = $state([])
  let selectedIndex: number = $state(-1)
  let diffContent: string = $state('')
  let error: string = $state('')
  let loading: boolean = $state(true)
  let diffLoading: boolean = $state(false)
  let lastAction: string = $state('')
  let descriptionEditing: boolean = $state(false)
  let descriptionDraft: string = $state('')
  let commandOutput: string = $state('')
  let revsetFilter: string = $state('')
  let changedFiles: string[] = $state([])
  let selectedFile: string | null = $state(null)
  let filesLoading: boolean = $state(false)
  let describeSaved: boolean = $state(false)

  // --- Refs ---
  let revsetInputEl: HTMLInputElement | undefined = $state(undefined)

  // --- Derived ---
  let selectedRevision: LogEntry | null = $derived(
    selectedIndex >= 0 && selectedIndex < revisions.length
      ? revisions[selectedIndex]
      : null
  )

  interface FlatLine {
    gutter: string
    entryIndex: number
    isNode: boolean
    isDescLine: boolean  // second line of a node row (description)
    isWorkingCopy: boolean
    isHidden: boolean
  }

  // Build a continuation gutter: replace node symbols with │, keep pipes and spaces
  function continuationGutter(gutter: string): string {
    const nodeChars = new Set(['@', '○', '◆', '×', '◌'])
    let result = ''
    for (const ch of gutter) {
      if (nodeChars.has(ch)) {
        result += '│'
      } else if (ch === '─' || ch === '╮' || ch === '╯' || ch === '╭' || ch === '╰' || ch === '├' || ch === '┤') {
        result += ' '
      } else {
        result += ch
      }
    }
    return result
  }

  let flatLines = $derived.by(() => {
    const lines: FlatLine[] = []
    revisions.forEach((entry, i) => {
      entry.graph_lines.forEach((gl, j) => {
        const isNode = gl.is_node ?? (j === 0)
        lines.push({
          gutter: gl.gutter,
          entryIndex: i,
          isNode,
          isDescLine: false,
          isWorkingCopy: entry.commit.is_working_copy,
          isHidden: entry.commit.hidden,
        })
        // For node lines, add a description continuation line with extended gutter
        if (isNode) {
          lines.push({
            gutter: continuationGutter(gl.gutter),
            entryIndex: i,
            isNode: false,
            isDescLine: true,
            isWorkingCopy: entry.commit.is_working_copy,
            isHidden: entry.commit.hidden,
          })
        }
      })
    })
    return lines
  })

  let parsedDiff = $derived(parseDiffContent(diffContent))

  let statusText = $derived.by(() => {
    if (loading) return 'Loading revisions...'
    if (diffLoading) return 'Loading diff...'
    if (lastAction) return lastAction
    const count = revisions.length
    const wc = revisions.find(r => r.commit.is_working_copy)
    return `${count} revisions${wc ? ` | @ ${wc.commit.change_id.slice(0, 8)}` : ''}`
  })

  // --- Types ---
  interface DiffFile {
    header: string
    hunks: DiffHunk[]
  }

  interface DiffHunk {
    header: string
    lines: DiffLine[]
  }

  interface DiffLine {
    type: 'add' | 'remove' | 'context' | 'header'
    content: string
  }

  // --- Diff parser ---
  function parseDiffContent(raw: string): DiffFile[] {
    if (!raw) return []

    const files: DiffFile[] = []
    const lines = raw.split('\n')
    let currentFile: DiffFile | null = null
    let currentHunk: DiffHunk | null = null

    for (const line of lines) {
      if (line.startsWith('diff --git') || line.startsWith('=== ') || line.startsWith('Modified ') || line.startsWith('Added ') || line.startsWith('Deleted ') || line.startsWith('Copied ') || line.startsWith('Renamed ')) {
        // jj uses different diff headers than git
        currentFile = { header: line, hunks: [] }
        files.push(currentFile)
        currentHunk = null
      } else if (line.startsWith('@@')) {
        currentHunk = { header: line, lines: [] }
        if (currentFile) {
          currentFile.hunks.push(currentHunk)
        } else {
          currentFile = { header: '(unknown file)', hunks: [currentHunk] }
          files.push(currentFile)
        }
      } else if (line.startsWith('---') || line.startsWith('+++')) {
        // file markers — attach to current file header
        if (currentFile) {
          currentFile.header += '\n' + line
        }
      } else if (currentHunk) {
        if (line.startsWith('+')) {
          currentHunk.lines.push({ type: 'add', content: line })
        } else if (line.startsWith('-')) {
          currentHunk.lines.push({ type: 'remove', content: line })
        } else {
          currentHunk.lines.push({ type: 'context', content: line })
        }
      } else if (currentFile && line.trim()) {
        // Lines between file header and first hunk (e.g. "Binary file..." or index lines)
        currentFile.header += '\n' + line
      }
    }

    return files
  }

  // --- Status parser ---
  // Parses `jj status` output to extract changed file paths
  function parseStatusOutput(raw: string): string[] {
    if (!raw) return []
    const files: string[] = []
    for (const line of raw.split('\n')) {
      // jj status lines look like: "M path/to/file" or "A path/to/file" etc.
      const match = line.match(/^([MADRC])\s+(.+)$/)
      if (match) {
        files.push(match[2])
      }
    }
    return files
  }

  // --- API actions ---
  async function loadLog() {
    loading = true
    error = ''
    try {
      revisions = await api.log(revsetFilter || undefined)
      // Preserve selection if possible, otherwise select working copy
      if (selectedIndex < 0 || selectedIndex >= revisions.length) {
        selectedIndex = revisions.findIndex(r => r.commit.is_working_copy)
      }
      if (selectedIndex >= 0) {
        await loadDiff(revisions[selectedIndex])
        await loadStatus(revisions[selectedIndex])
      }
    } catch (e) {
      error = e instanceof Error ? e.message : String(e)
    } finally {
      loading = false
    }
  }

  async function loadDiff(entry: LogEntry, file?: string) {
    diffLoading = true
    try {
      const result = await api.diff(entry.commit.change_id, file)
      diffContent = result.diff
    } catch (e) {
      diffContent = e instanceof Error ? e.message : String(e)
    } finally {
      diffLoading = false
    }
  }

  async function loadStatus(entry: LogEntry) {
    filesLoading = true
    try {
      const result = await api.status(entry.commit.change_id)
      changedFiles = parseStatusOutput(result.status)
    } catch {
      changedFiles = []
    } finally {
      filesLoading = false
    }
  }

  async function selectRevision(index: number) {
    selectedIndex = index
    const entry = revisions[index]
    if (entry) {
      descriptionEditing = false
      selectedFile = null
      await Promise.all([loadDiff(entry), loadStatus(entry)])
    }
  }

  async function selectFile(file: string) {
    if (!selectedRevision) return
    if (selectedFile === file) {
      // Deselect — show full diff
      selectedFile = null
      await loadDiff(selectedRevision)
    } else {
      selectedFile = file
      await loadDiff(selectedRevision, file)
    }
  }

  async function handleAbandon(changeId: string) {
    try {
      const result = await api.abandon([changeId])
      lastAction = `Abandoned ${changeId.slice(0, 8)}`
      commandOutput = result.output
      await loadLog()
    } catch (e) {
      error = e instanceof Error ? e.message : String(e)
    }
  }

  async function handleNew(changeId: string) {
    try {
      const result = await api.newRevision([changeId])
      lastAction = `Created new revision from ${changeId.slice(0, 8)}`
      commandOutput = result.output
      await loadLog()
    } catch (e) {
      error = e instanceof Error ? e.message : String(e)
    }
  }

  async function handleEdit(changeId: string) {
    try {
      const result = await api.edit(changeId)
      lastAction = `Editing ${changeId.slice(0, 8)}`
      commandOutput = result.output
      await loadLog()
    } catch (e) {
      error = e instanceof Error ? e.message : String(e)
    }
  }

  async function handleUndo() {
    try {
      const result = await api.undo()
      lastAction = 'Undo successful'
      commandOutput = result.output
      await loadLog()
    } catch (e) {
      error = e instanceof Error ? e.message : String(e)
    }
  }

  async function handleDescribe() {
    if (!selectedRevision) return
    try {
      const result = await api.describe(selectedRevision.commit.change_id, descriptionDraft)
      lastAction = `Updated description for ${selectedRevision.commit.change_id.slice(0, 8)}`
      commandOutput = result.output
      descriptionEditing = false
      // Show save feedback
      describeSaved = true
      setTimeout(() => { describeSaved = false }, 1500)
      await loadLog()
    } catch (e) {
      error = e instanceof Error ? e.message : String(e)
    }
  }

  async function handleGitPush() {
    try {
      const result = await api.gitPush()
      lastAction = 'Git push complete'
      commandOutput = result.output
    } catch (e) {
      error = e instanceof Error ? e.message : String(e)
    }
  }

  async function handleGitFetch() {
    try {
      const result = await api.gitFetch()
      lastAction = 'Git fetch complete'
      commandOutput = result.output
      await loadLog()
    } catch (e) {
      error = e instanceof Error ? e.message : String(e)
    }
  }

  async function startDescriptionEdit() {
    if (!selectedRevision) return
    // Load current description from API before showing editor
    try {
      const result = await api.description(selectedRevision.commit.change_id)
      descriptionDraft = result.description
    } catch {
      // Fall back to what we have locally
      descriptionDraft = selectedRevision.description
    }
    descriptionEditing = true
    // Focus the textarea after DOM update
    requestAnimationFrame(() => {
      const el = document.querySelector('.desc-editor textarea') as HTMLTextAreaElement
      el?.focus()
    })
  }

  function dismissError() {
    error = ''
  }

  function handleRevsetSubmit() {
    selectedIndex = -1
    selectedFile = null
    changedFiles = []
    loadLog()
  }

  function clearRevsetFilter() {
    revsetFilter = ''
    handleRevsetSubmit()
  }

  // --- Keyboard shortcuts ---
  function handleKeydown(e: KeyboardEvent) {
    // Don't capture when typing in inputs (except specific keys in revset input)
    const target = e.target as HTMLElement

    // Handle Escape in revset input specially
    if (target === revsetInputEl) {
      if (e.key === 'Escape') {
        e.preventDefault()
        revsetFilter = ''
        handleRevsetSubmit()
        revsetInputEl?.blur()
        // Refocus revision list
        const listEl = document.querySelector('.revision-list') as HTMLElement
        listEl?.focus()
      }
      return // Let other keys go to the input normally
    }

    if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA') return

    switch (e.key) {
      case 'j':
        e.preventDefault()
        if (selectedIndex < revisions.length - 1) {
          selectRevision(selectedIndex + 1)
        }
        break
      case 'k':
        e.preventDefault()
        if (selectedIndex > 0) {
          selectRevision(selectedIndex - 1)
        }
        break
      case 'Enter':
        if (selectedRevision) {
          e.preventDefault()
          loadDiff(selectedRevision)
        }
        break
      case 'u':
        e.preventDefault()
        handleUndo()
        break
      case 'r':
        e.preventDefault()
        loadLog()
        break
      case 'e':
        if (selectedRevision) {
          e.preventDefault()
          startDescriptionEdit()
        }
        break
      case 'n':
        if (selectedRevision) {
          e.preventDefault()
          handleNew(selectedRevision.commit.change_id)
        }
        break
      case '/':
        e.preventDefault()
        revsetInputEl?.focus()
        break
      case 'Escape':
        if (descriptionEditing) {
          descriptionEditing = false
        } else if (error) {
          dismissError()
        }
        break
    }
  }

  // Scroll selected revision into view
  function scrollSelectedIntoView() {
    requestAnimationFrame(() => {
      const el = document.querySelector('.graph-row.node-row.selected')
      el?.scrollIntoView({ block: 'nearest' })
    })
  }

  $effect(() => {
    // Re-run when selectedIndex changes
    selectedIndex;
    scrollSelectedIntoView()
  })

  loadLog()
</script>

<svelte:window onkeydown={handleKeydown} />

<div class="app">
  <!-- Title bar -->
  <header class="titlebar">
    <div class="titlebar-left">
      <span class="app-name">jj-web</span>
      <span class="separator">|</span>
      <div class="toolbar">
        <button class="toolbar-btn" onclick={loadLog} title="Refresh (r)">
          <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
            <path d="M13.5 2a.5.5 0 0 0-.5.5V5h-2.5a.5.5 0 0 0 0 1H14a.5.5 0 0 0 .5-.5V2.5a.5.5 0 0 0-.5-.5z"/>
            <path d="M13.36 4.05A6 6 0 1 0 14 8a.5.5 0 0 1 1 0 7 7 0 1 1-1.75-4.63l.11.68z"/>
          </svg>
          Refresh
        </button>
        <button class="toolbar-btn" onclick={handleUndo} title="Undo (u)">
          <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
            <path d="M2 5.5a.5.5 0 0 1 .5-.5h9a3.5 3.5 0 0 1 0 7H7a.5.5 0 0 1 0-1h4.5a2.5 2.5 0 0 0 0-5h-9a.5.5 0 0 1-.5-.5z"/>
            <path d="M4.854 3.146a.5.5 0 0 1 0 .708L2.707 6l2.147 2.146a.5.5 0 1 1-.708.708l-2.5-2.5a.5.5 0 0 1 0-.708l2.5-2.5a.5.5 0 0 1 .708 0z"/>
          </svg>
          Undo
        </button>
        <div class="toolbar-divider"></div>
        <button class="toolbar-btn" onclick={handleGitFetch} title="Git fetch">
          <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
            <path d="M8 1a.5.5 0 0 1 .5.5v10.793l3.146-3.147a.5.5 0 0 1 .708.708l-4 4a.5.5 0 0 1-.708 0l-4-4a.5.5 0 0 1 .708-.708L7.5 12.293V1.5A.5.5 0 0 1 8 1z"/>
          </svg>
          Fetch
        </button>
        <button class="toolbar-btn" onclick={handleGitPush} title="Git push">
          <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
            <path d="M8 15a.5.5 0 0 0 .5-.5V3.707l3.146 3.147a.5.5 0 0 0 .708-.708l-4-4a.5.5 0 0 0-.708 0l-4 4a.5.5 0 0 0 .708.708L7.5 3.707V14.5a.5.5 0 0 0 .5.5z"/>
          </svg>
          Push
        </button>
      </div>
    </div>
    <div class="titlebar-right">
      <kbd class="shortcut-hint">/</kbd> filter
      <kbd class="shortcut-hint">j/k</kbd> navigate
      <kbd class="shortcut-hint">e</kbd> describe
      <kbd class="shortcut-hint">n</kbd> new
      <kbd class="shortcut-hint">u</kbd> undo
    </div>
  </header>

  {#if error}
    <div class="error-bar" role="alert">
      <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
        <path d="M8 1a7 7 0 1 0 0 14A7 7 0 0 0 8 1zm0 10.5a.75.75 0 1 1 0-1.5.75.75 0 0 1 0 1.5zM8.75 4.5v4a.75.75 0 0 1-1.5 0v-4a.75.75 0 0 1 1.5 0z"/>
      </svg>
      <span class="error-text">{error}</span>
      <button class="error-dismiss" onclick={dismissError}>Dismiss</button>
    </div>
  {/if}

  <!-- Main content -->
  <div class="workspace">
    <!-- Left panel: revision list -->
    <div class="panel revisions-panel">
      <div class="panel-header">
        <span class="panel-title">Revisions</span>
        {#if !loading}
          <span class="panel-badge">{revisions.length}</span>
        {/if}
      </div>
      <!-- Revset filter input -->
      <div class="revset-filter-bar">
        <span class="revset-icon">$</span>
        <input
          bind:this={revsetInputEl}
          bind:value={revsetFilter}
          class="revset-input"
          type="text"
          placeholder="revset filter (press / to focus)"
          onkeydown={(e: KeyboardEvent) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              handleRevsetSubmit()
            }
          }}
        />
        {#if revsetFilter}
          <button class="revset-clear" onclick={clearRevsetFilter} title="Clear filter (Escape)">x</button>
        {/if}
      </div>
      <div class="panel-content">
        {#if loading}
          <div class="empty-state">
            <div class="spinner"></div>
            <span>Loading revisions...</span>
          </div>
        {:else if revisions.length === 0}
          <div class="empty-state">No revisions found</div>
        {:else}
          <div class="revision-list" role="listbox">
            {#each flatLines as line, lineIdx}
              <div
                class="graph-row"
                class:node-row={line.isNode}
                class:selected={selectedIndex === line.entryIndex}
                class:wc={line.isWorkingCopy}
                class:hidden-rev={line.isHidden}
                onclick={() => selectRevision(line.entryIndex)}
                role="option"
                tabindex={line.isNode ? 0 : -1}
                aria-selected={selectedIndex === line.entryIndex}
              >
                <span class="gutter" class:wc-gutter={line.isWorkingCopy}>{line.gutter}</span>
                {#if line.isNode}
                  {@const entry = revisions[line.entryIndex]}
                  <span class="node-line-content">
                    <span class="change-id"><span class="id-prefix">{entry.commit.change_id.slice(0, entry.commit.change_prefix)}</span><span class="id-rest">{entry.commit.change_id.slice(entry.commit.change_prefix)}</span></span>
                    {#if entry.bookmarks?.length}
                      {#each entry.bookmarks as bm}
                        <span class="bookmark-badge">{bm}</span>
                      {/each}
                    {/if}
                    <span class="commit-id"><span class="commit-id-prefix">{entry.commit.commit_id.slice(0, entry.commit.commit_prefix)}</span><span class="commit-id-rest">{entry.commit.commit_id.slice(entry.commit.commit_prefix)}</span></span>
                  </span>
                  <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions, a11y_no_noninteractive_element_interactions -->
                  <span class="rev-actions" role="group" onclick={(e: MouseEvent) => e.stopPropagation()}>
                    <button class="action-btn" onclick={(e: MouseEvent) => { e.stopPropagation(); handleEdit(entry.commit.change_id) }} title="Edit">edit</button>
                    <button class="action-btn" onclick={(e: MouseEvent) => { e.stopPropagation(); handleNew(entry.commit.change_id) }} title="New (n)">new</button>
                    <button class="action-btn danger" onclick={(e: MouseEvent) => { e.stopPropagation(); handleAbandon(entry.commit.change_id) }} title="Abandon">abandon</button>
                  </span>
                {:else if line.isDescLine}
                  {@const entry = revisions[line.entryIndex]}
                  <span class="desc-line-content">
                    <span class="description-text">{entry.description || '(no description)'}</span>
                  </span>
                {/if}
              </div>
            {/each}
          </div>
        {/if}
      </div>
    </div>

    <!-- Right panel: diff viewer -->
    <div class="panel diff-panel">
      <div class="panel-header">
        {#if selectedRevision}
          <span class="panel-title">
            Changes in
            <span class="header-change-id">{selectedRevision.commit.change_id.slice(0, 12)}</span>
          </span>
          <div class="panel-actions">
            {#if describeSaved}
              <span class="describe-saved">Saved</span>
            {/if}
            <button class="header-btn" onclick={startDescriptionEdit} title="Edit description (e)">
              Describe
            </button>
          </div>
        {:else}
          <span class="panel-title">Diff Viewer</span>
        {/if}
      </div>
      <div class="panel-content">
        {#if descriptionEditing && selectedRevision}
          <div class="desc-editor">
            <!-- svelte-ignore a11y_label_has_associated_control -->
            <label class="desc-label">Description for {selectedRevision.commit.change_id.slice(0, 12)}</label>
            <textarea
              bind:value={descriptionDraft}
              rows="4"
              placeholder="Enter commit description..."
              onkeydown={(e: KeyboardEvent) => {
                if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                  handleDescribe()
                }
                if (e.key === 'Escape') {
                  descriptionEditing = false
                }
              }}
            ></textarea>
            <div class="desc-actions">
              <button class="btn-primary" onclick={handleDescribe}>
                Save
                <kbd>Cmd+Enter</kbd>
              </button>
              <button class="btn-secondary" onclick={() => descriptionEditing = false}>Cancel</button>
            </div>
          </div>
        {/if}

        {#if diffLoading}
          <div class="empty-state">
            <div class="spinner"></div>
            <span>Loading diff...</span>
          </div>
        {:else if !selectedRevision}
          <div class="empty-state">
            <span class="empty-hint">Select a revision to view changes</span>
            <span class="empty-subhint">Use <kbd>j</kbd>/<kbd>k</kbd> to navigate, <kbd>Enter</kbd> to select</span>
          </div>
        {:else if parsedDiff.length === 0 && changedFiles.length === 0}
          <div class="empty-state">
            <span class="empty-hint">No changes in this revision</span>
          </div>
        {:else}
          <!-- File list -->
          {#if changedFiles.length > 0}
            <div class="file-list-bar">
              <span class="file-list-label">Files ({changedFiles.length})</span>
              <div class="file-list">
                {#each changedFiles as file}
                  <button
                    class="file-chip"
                    class:active={selectedFile === file}
                    onclick={() => selectFile(file)}
                    title={file}
                  >
                    {file.split('/').pop()}
                  </button>
                {/each}
                {#if selectedFile}
                  <button class="file-chip clear-chip" onclick={() => selectFile(selectedFile!)}>
                    Show all
                  </button>
                {/if}
              </div>
            </div>
          {/if}

          <div class="diff-content">
            {#each parsedDiff as file}
              <div class="diff-file">
                <div class="diff-file-header">
                  {#each file.header.split('\n') as headerLine}
                    <div>{headerLine}</div>
                  {/each}
                </div>
                {#each file.hunks as hunk}
                  <div class="diff-hunk-header">{hunk.header}</div>
                  <div class="diff-lines">
                    {#each hunk.lines as line}
                      <div
                        class="diff-line"
                        class:diff-add={line.type === 'add'}
                        class:diff-remove={line.type === 'remove'}
                        class:diff-context={line.type === 'context'}
                      >{line.content}</div>
                    {/each}
                  </div>
                {/each}
              </div>
            {/each}
          </div>
        {/if}
      </div>
    </div>
  </div>

  <!-- Status bar -->
  <footer class="statusbar">
    <div class="statusbar-left">
      <span class="status-item">{statusText}</span>
    </div>
    <div class="statusbar-right">
      {#if commandOutput}
        <span class="status-item output">{commandOutput.trim().split('\n').pop()}</span>
      {/if}
      <span class="status-item">jj-web</span>
    </div>
  </footer>
</div>

<style>
  /* --- Reset & Globals --- */
  :global(*) {
    box-sizing: border-box;
  }

  :global(body) {
    margin: 0;
    padding: 0;
    font-family: 'SF Mono', 'Cascadia Code', 'JetBrains Mono', 'Fira Code', 'Menlo', 'Consolas', monospace;
    font-size: 13px;
    background: #1e1e2e;
    color: #cdd6f4;
    overflow: hidden;
  }

  /* --- Layout --- */
  .app {
    display: flex;
    flex-direction: column;
    height: 100vh;
    overflow: hidden;
  }

  /* --- Titlebar --- */
  .titlebar {
    display: flex;
    justify-content: space-between;
    align-items: center;
    height: 40px;
    padding: 0 12px;
    background: #181825;
    border-bottom: 1px solid #313244;
    flex-shrink: 0;
    user-select: none;
  }

  .titlebar-left {
    display: flex;
    align-items: center;
    gap: 10px;
  }

  .app-name {
    font-weight: 700;
    font-size: 14px;
    color: #89b4fa;
    letter-spacing: -0.02em;
  }

  .separator {
    color: #45475a;
  }

  .toolbar {
    display: flex;
    align-items: center;
    gap: 2px;
  }

  .toolbar-btn {
    display: flex;
    align-items: center;
    gap: 5px;
    background: transparent;
    border: 1px solid transparent;
    color: #bac2de;
    padding: 4px 8px;
    border-radius: 4px;
    cursor: pointer;
    font-family: inherit;
    font-size: 12px;
    transition: all 0.15s ease;
  }

  .toolbar-btn:hover {
    background: #313244;
    border-color: #45475a;
    color: #cdd6f4;
  }

  .toolbar-btn:active {
    background: #45475a;
  }

  .toolbar-divider {
    width: 1px;
    height: 18px;
    background: #45475a;
    margin: 0 4px;
  }

  .titlebar-right {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 11px;
    color: #6c7086;
  }

  .shortcut-hint {
    display: inline-block;
    background: #313244;
    color: #a6adc8;
    padding: 1px 5px;
    border-radius: 3px;
    font-size: 10px;
    font-family: inherit;
    border: 1px solid #45475a;
  }

  /* --- Error bar --- */
  .error-bar {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 6px 12px;
    background: #45171a;
    border-bottom: 1px solid #f38ba8;
    color: #f38ba8;
    font-size: 12px;
    flex-shrink: 0;
  }

  .error-text {
    flex: 1;
  }

  .error-dismiss {
    background: transparent;
    border: 1px solid #f38ba8;
    color: #f38ba8;
    padding: 2px 8px;
    border-radius: 3px;
    cursor: pointer;
    font-family: inherit;
    font-size: 11px;
  }

  .error-dismiss:hover {
    background: #f38ba822;
  }

  /* --- Workspace (main panels) --- */
  .workspace {
    display: flex;
    flex: 1;
    overflow: hidden;
  }

  .panel {
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }

  .revisions-panel {
    width: 420px;
    min-width: 320px;
    border-right: 1px solid #313244;
    flex-shrink: 0;
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
    background: #1e1e2e;
    border-bottom: 1px solid #313244;
    flex-shrink: 0;
    user-select: none;
  }

  .panel-title {
    font-size: 11px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: #a6adc8;
  }

  .header-change-id {
    color: #89b4fa;
    text-transform: none;
    letter-spacing: normal;
    font-weight: 700;
  }

  .panel-badge {
    background: #313244;
    color: #a6adc8;
    padding: 0 6px;
    border-radius: 8px;
    font-size: 10px;
    font-weight: 600;
  }

  .panel-actions {
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .header-btn {
    background: transparent;
    border: 1px solid #45475a;
    color: #a6adc8;
    padding: 2px 8px;
    border-radius: 3px;
    cursor: pointer;
    font-family: inherit;
    font-size: 11px;
    transition: all 0.15s ease;
  }

  .header-btn:hover {
    background: #313244;
    color: #cdd6f4;
  }

  .panel-content {
    flex: 1;
    overflow-y: auto;
    overflow-x: hidden;
  }

  /* --- Revset filter --- */
  .revset-filter-bar {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 4px 8px;
    background: #181825;
    border-bottom: 1px solid #313244;
    flex-shrink: 0;
  }

  .revset-icon {
    color: #585b70;
    font-size: 12px;
    font-weight: 700;
    flex-shrink: 0;
  }

  .revset-input {
    flex: 1;
    background: #1e1e2e;
    color: #cdd6f4;
    border: 1px solid #313244;
    border-radius: 3px;
    padding: 3px 6px;
    font-family: inherit;
    font-size: 12px;
    outline: none;
    transition: border-color 0.15s ease;
  }

  .revset-input:focus {
    border-color: #89b4fa;
  }

  .revset-input::placeholder {
    color: #45475a;
  }

  .revset-clear {
    background: transparent;
    border: none;
    color: #585b70;
    cursor: pointer;
    font-family: inherit;
    font-size: 14px;
    padding: 0 4px;
    line-height: 1;
    flex-shrink: 0;
  }

  .revset-clear:hover {
    color: #f38ba8;
  }

  /* --- Revision list (flat graph rows) --- */
  .revision-list {
    display: flex;
    flex-direction: column;
  }

  .graph-row {
    display: flex;
    align-items: baseline;
    min-height: 0;
    line-height: 1.15;
    font-size: 13px;
    cursor: pointer;
    transition: background 0.1s ease;
  }

  .graph-row:hover {
    background: #262637;
  }

  .graph-row.selected {
    background: #2a2a40;
    box-shadow: inset 2px 0 0 #89b4fa;
  }

  .graph-row.hidden-rev {
    opacity: 0.45;
  }

  /* Gutter: graph characters */
  .gutter {
    white-space: pre;
    font-size: 13px;
    line-height: 1.15;
    color: #585b70;
    flex-shrink: 0;
    padding-left: 8px;
  }

  .gutter.wc-gutter {
    color: #a6e3a1;
    font-weight: 800;
  }

  /* Node line: IDs + bookmarks + commit hash inline */
  .node-line-content {
    display: inline-flex;
    align-items: baseline;
    gap: 6px;
    white-space: nowrap;
    overflow: hidden;
    min-width: 0;
    flex: 1;
  }

  /* Description line: below the node line */
  .desc-line-content {
    display: inline-flex;
    align-items: baseline;
    overflow: hidden;
    min-width: 0;
    flex: 1;
  }

  /* Non-node rows: just gutter, same height as every other line */

  /* --- Change ID with highlighted prefix --- */
  .change-id {
    font-size: 13px;
    letter-spacing: 0.02em;
    flex-shrink: 0;
  }

  .id-prefix {
    color: #89b4fa;
    font-weight: 700;
  }

  .id-rest {
    color: #585b70;
    font-weight: 400;
  }

  .wc .id-prefix {
    color: #a6e3a1;
  }

  /* --- Commit ID with highlighted prefix --- */
  .commit-id {
    font-size: 10px;
    letter-spacing: 0.04em;
    flex-shrink: 0;
  }

  .commit-id-prefix {
    color: #7f849c;
    font-weight: 600;
  }

  .commit-id-rest {
    color: #45475a;
    font-weight: 400;
  }

  /* --- Bookmark badge --- */
  .bookmark-badge {
    display: inline-flex;
    align-items: center;
    background: #1e3a2a;
    color: #a6e3a1;
    padding: 0 5px;
    border-radius: 3px;
    font-size: 10px;
    font-weight: 600;
    border: 1px solid #2d5a3d;
    line-height: 1.15;
    letter-spacing: 0.02em;
    vertical-align: baseline;
  }

  /* --- Description text --- */
  .description-text {
    color: #cdd6f4;
    font-size: 12px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    min-width: 0;
  }

  .wc .description-text {
    color: #e0e0e0;
  }

  /* --- Revision action buttons (on hover of node rows) --- */
  .rev-actions {
    display: inline-flex;
    align-items: center;
    gap: 2px;
    padding: 0 6px;
    opacity: 0;
    transition: opacity 0.15s ease;
    flex-shrink: 0;
  }

  .graph-row.node-row:hover .rev-actions,
  .graph-row.node-row.selected .rev-actions {
    opacity: 1;
  }

  .action-btn {
    background: #313244;
    border: 1px solid #45475a;
    color: #a6adc8;
    padding: 1px 5px;
    border-radius: 3px;
    cursor: pointer;
    font-family: inherit;
    font-size: 10px;
    white-space: nowrap;
    transition: all 0.15s ease;
    line-height: 1.15;
  }

  .action-btn:hover {
    background: #45475a;
    color: #cdd6f4;
  }

  .action-btn.danger:hover {
    background: #45171a;
    border-color: #f38ba8;
    color: #f38ba8;
  }

  /* --- Description editor --- */
  .desc-editor {
    padding: 12px;
    border-bottom: 1px solid #313244;
    background: #181825;
  }

  .desc-label {
    display: block;
    font-size: 11px;
    color: #a6adc8;
    margin-bottom: 6px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }

  .desc-editor textarea {
    width: 100%;
    background: #1e1e2e;
    color: #cdd6f4;
    border: 1px solid #45475a;
    border-radius: 4px;
    padding: 8px;
    font-family: inherit;
    font-size: 13px;
    resize: vertical;
    outline: none;
    transition: border-color 0.15s ease;
  }

  .desc-editor textarea:focus {
    border-color: #89b4fa;
  }

  .desc-actions {
    display: flex;
    gap: 6px;
    margin-top: 8px;
  }

  .btn-primary {
    display: flex;
    align-items: center;
    gap: 6px;
    background: #89b4fa;
    color: #1e1e2e;
    border: none;
    padding: 4px 12px;
    border-radius: 4px;
    cursor: pointer;
    font-family: inherit;
    font-size: 12px;
    font-weight: 600;
  }

  .btn-primary:hover {
    background: #b4d0fb;
  }

  .btn-primary kbd {
    background: #1e1e2e33;
    padding: 0 4px;
    border-radius: 2px;
    font-size: 10px;
    font-family: inherit;
  }

  .btn-secondary {
    background: transparent;
    color: #a6adc8;
    border: 1px solid #45475a;
    padding: 4px 12px;
    border-radius: 4px;
    cursor: pointer;
    font-family: inherit;
    font-size: 12px;
  }

  .btn-secondary:hover {
    background: #313244;
  }

  /* --- Describe saved feedback --- */
  .describe-saved {
    color: #a6e3a1;
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
    background: #181825;
    border-bottom: 1px solid #313244;
    flex-shrink: 0;
    overflow-x: auto;
  }

  .file-list-label {
    color: #585b70;
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
    background: #313244;
    color: #a6adc8;
    border: 1px solid #45475a;
    padding: 1px 8px;
    border-radius: 3px;
    cursor: pointer;
    font-family: inherit;
    font-size: 11px;
    white-space: nowrap;
    transition: all 0.15s ease;
  }

  .file-chip:hover {
    background: #45475a;
    color: #cdd6f4;
  }

  .file-chip.active {
    background: #89b4fa22;
    border-color: #89b4fa;
    color: #89b4fa;
  }

  .file-chip.clear-chip {
    background: transparent;
    border-color: #585b70;
    color: #585b70;
    font-style: italic;
  }

  .file-chip.clear-chip:hover {
    color: #a6adc8;
    border-color: #a6adc8;
  }

  /* --- Diff viewer --- */
  .diff-content {
    padding: 0;
  }

  .diff-file {
    margin-bottom: 0;
    border-bottom: 1px solid #313244;
  }

  .diff-file:last-child {
    border-bottom: none;
  }

  .diff-file-header {
    padding: 8px 12px;
    background: #181825;
    color: #cdd6f4;
    font-weight: 600;
    font-size: 12px;
    border-bottom: 1px solid #313244;
    position: sticky;
    top: 0;
    z-index: 1;
  }

  .diff-hunk-header {
    padding: 4px 12px;
    background: #1a1a2e;
    color: #74c7ec;
    font-size: 12px;
    border-bottom: 1px solid #21212e;
    font-style: italic;
  }

  .diff-lines {
    font-size: 12px;
    line-height: 1.5;
  }

  .diff-line {
    padding: 0 12px;
    white-space: pre-wrap;
    word-break: break-all;
  }

  .diff-add {
    background: #a6e3a112;
    color: #a6e3a1;
    border-left: 3px solid #a6e3a1;
  }

  .diff-remove {
    background: #f38ba812;
    color: #f38ba8;
    border-left: 3px solid #f38ba8;
  }

  .diff-context {
    color: #6c7086;
    border-left: 3px solid transparent;
  }

  /* --- Empty states --- */
  .empty-state {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 8px;
    padding: 48px 24px;
    color: #585b70;
    font-size: 13px;
  }

  .empty-hint {
    color: #6c7086;
    font-size: 14px;
  }

  .empty-subhint {
    color: #45475a;
    font-size: 12px;
  }

  .empty-subhint kbd {
    background: #313244;
    padding: 1px 4px;
    border-radius: 3px;
    font-family: inherit;
    font-size: 11px;
    border: 1px solid #45475a;
    color: #6c7086;
  }

  /* --- Spinner --- */
  .spinner {
    width: 20px;
    height: 20px;
    border: 2px solid #313244;
    border-top-color: #89b4fa;
    border-radius: 50%;
    animation: spin 0.8s linear infinite;
  }

  @keyframes spin {
    to { transform: rotate(360deg); }
  }

  /* --- Status bar --- */
  .statusbar {
    display: flex;
    justify-content: space-between;
    align-items: center;
    height: 24px;
    padding: 0 10px;
    background: #181825;
    border-top: 1px solid #313244;
    flex-shrink: 0;
    user-select: none;
    font-size: 11px;
    color: #6c7086;
  }

  .statusbar-left,
  .statusbar-right {
    display: flex;
    align-items: center;
    gap: 12px;
  }

  .status-item.output {
    color: #a6adc8;
    max-width: 500px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  /* --- Scrollbar --- */
  .panel-content::-webkit-scrollbar {
    width: 8px;
  }

  .panel-content::-webkit-scrollbar-track {
    background: transparent;
  }

  .panel-content::-webkit-scrollbar-thumb {
    background: #313244;
    border-radius: 4px;
  }

  .panel-content::-webkit-scrollbar-thumb:hover {
    background: #45475a;
  }
</style>
