<script lang="ts">
  import { api, type LogEntry, type FileChange, type OpEntry } from './lib/api'
  import { highlightLines, detectLanguage } from './lib/highlighter'

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
  let changedFiles: FileChange[] = $state([])
  let selectedFile: FileChange | null = $state(null)
  let filesLoading: boolean = $state(false)
  let describeSaved: boolean = $state(false)
  let collapsedFiles: Set<string> = $state(new Set())
  let splitView: boolean = $state(false)
  let checkedRevisions: Set<string> = $state(new Set())
  let lastCheckedIndex: number = $state(-1)
  let diffGeneration: number = 0
  let filesGeneration: number = 0
  let oplogOpen: boolean = $state(false)
  let oplogEntries: OpEntry[] = $state([])
  let oplogLoading: boolean = $state(false)
  let paletteOpen: boolean = $state(false)
  let paletteQuery: string = $state('')
  let paletteIndex: number = $state(0)

  // --- Refs ---
  let revsetInputEl: HTMLInputElement | undefined = $state(undefined)
  let paletteInputEl: HTMLInputElement | undefined = $state(undefined)

  // --- Derived ---
  let selectedRevision: LogEntry | null = $derived(
    selectedIndex >= 0 && selectedIndex < revisions.length
      ? revisions[selectedIndex]
      : null
  )

  // Effective revisions for operations: checked if any, otherwise cursor
  let effectiveRevisions = $derived.by(() => {
    if (checkedRevisions.size > 0) {
      return [...checkedRevisions]
    }
    return selectedRevision ? [selectedRevision.commit.change_id] : []
  })

  // Aggregate revset string for diff/files queries
  let effectiveRevset = $derived(effectiveRevisions.join('|'))

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

  // --- Syntax highlighting ---
  let highlightedLines: Map<string, string> = $state(new Map())
  let highlightGeneration = 0

  async function highlightDiff(files: DiffFile[]) {
    const gen = ++highlightGeneration
    const newMap = new Map<string, string>()
    for (const file of files) {
      const filePath = filePathFromHeader(file.header)
      const lang = detectLanguage(filePath)

      for (const hunk of file.hunks) {
        const hunkIdx = file.hunks.indexOf(hunk)
        // Collect lines by type for coherent highlighting (like antique)
        const addLines: { idx: number; content: string }[] = []
        const removeLines: { idx: number; content: string }[] = []
        const contextLines: { idx: number; content: string }[] = []

        hunk.lines.forEach((line, i) => {
          const stripped = line.content.slice(1) // remove +/- /space prefix
          if (line.type === 'add') addLines.push({ idx: i, content: stripped })
          else if (line.type === 'remove') removeLines.push({ idx: i, content: stripped })
          else contextLines.push({ idx: i, content: stripped })
        })

        // Highlight each group separately so the highlighter sees coherent code
        for (const group of [addLines, removeLines, contextLines]) {
          if (group.length === 0) continue
          const highlighted = await highlightLines(group.map(g => g.content), lang)
          if (gen !== highlightGeneration) return // stale — abort
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

  let statusText = $derived.by(() => {
    if (loading) return 'Loading revisions...'
    if (diffLoading) return 'Loading diff...'
    if (lastAction) return lastAction
    const count = revisions.length
    const wc = revisions.find(r => r.commit.is_working_copy)
    const checked = checkedRevisions.size > 0 ? `${checkedRevisions.size} checked | ` : ''
    return `${checked}${count} revisions${wc ? ` | @ ${wc.commit.change_id.slice(0, 8)}` : ''}`
  })

  function toggleCheck(changeId: string, index: number) {
    const next = new Set(checkedRevisions)
    if (next.has(changeId)) {
      next.delete(changeId)
    } else {
      next.add(changeId)
    }
    checkedRevisions = next
    collapsedFiles = new Set()
    lastCheckedIndex = index
  }

  function rangeCheck(fromIndex: number, toIndex: number) {
    const lo = Math.min(fromIndex, toIndex)
    const hi = Math.max(fromIndex, toIndex)
    const next = new Set(checkedRevisions)
    for (let i = lo; i <= hi; i++) {
      if (i < revisions.length) {
        next.add(revisions[i].commit.change_id)
      }
    }
    checkedRevisions = next
    collapsedFiles = new Set()
    lastCheckedIndex = toIndex
  }

  function clearChecks() {
    checkedRevisions = new Set()
    lastCheckedIndex = -1
  }

  // --- Command palette ---
  interface PaletteCommand {
    label: string
    shortcut?: string
    action: () => void
    when?: () => boolean  // only show when condition is true
  }

  let commands: PaletteCommand[] = $derived.by(() => [
    { label: 'Refresh revisions', shortcut: 'r', action: () => loadLog() },
    { label: 'Undo last operation', shortcut: 'u', action: () => handleUndo() },
    { label: 'Git fetch', action: () => handleGitFetch() },
    { label: 'Git push', action: () => handleGitPush() },
    { label: 'Focus revset filter', shortcut: '/', action: () => revsetInputEl?.focus() },
    { label: 'Clear revset filter', action: () => clearRevsetFilter(), when: () => revsetFilter !== '' },
    { label: 'Edit description', shortcut: 'e', action: () => startDescriptionEdit(), when: () => !!selectedRevision && checkedRevisions.size <= 1 },
    { label: 'New revision from selected', shortcut: 'n', action: () => {
      if (checkedRevisions.size > 0) handleNewFromChecked()
      else if (selectedRevision) handleNew(selectedRevision.commit.change_id)
    }, when: () => !!selectedRevision || checkedRevisions.size > 0 },
    { label: 'Edit selected revision', action: () => handleEdit(selectedRevision!.commit.change_id), when: () => !!selectedRevision },
    { label: 'Abandon selected revision', action: () => handleAbandon(selectedRevision!.commit.change_id), when: () => !!selectedRevision && checkedRevisions.size === 0 },
    { label: `Abandon ${checkedRevisions.size} checked revisions`, action: () => handleAbandonChecked(), when: () => checkedRevisions.size > 0 },
    { label: `New from ${checkedRevisions.size} checked revisions`, action: () => handleNewFromChecked(), when: () => checkedRevisions.size > 0 },
    { label: 'Clear all checked revisions', shortcut: 'Esc', action: () => {
      clearChecks()
      if (selectedRevision) { loadDiff(selectedRevision); loadFiles(selectedRevision) }
      else { diffContent = ''; changedFiles = [] }
    }, when: () => checkedRevisions.size > 0 },
    { label: 'Collapse all file diffs', action: () => collapseAll(), when: () => parsedDiff.length > 0 },
    { label: 'Expand all file diffs', action: () => expandAll(), when: () => parsedDiff.length > 0 },
    { label: 'Toggle split/unified diff view', action: () => { splitView = !splitView } },
    { label: 'Toggle operation log', action: () => toggleOplog() },
  ])

  function fuzzyMatch(query: string, text: string): boolean {
    const lq = query.toLowerCase()
    const lt = text.toLowerCase()
    let qi = 0
    for (let ti = 0; ti < lt.length && qi < lq.length; ti++) {
      if (lt[ti] === lq[qi]) qi++
    }
    return qi === lq.length
  }

  let filteredCommands = $derived.by(() => {
    const available = commands.filter(c => !c.when || c.when())
    if (!paletteQuery) return available
    return available.filter(c => fuzzyMatch(paletteQuery, c.label))
  })

  function openPalette() {
    paletteOpen = true
    paletteQuery = ''
    paletteIndex = 0
    requestAnimationFrame(() => paletteInputEl?.focus())
  }

  function closePalette() {
    paletteOpen = false
    paletteQuery = ''
  }

  function executePaletteCommand(cmd: PaletteCommand) {
    closePalette()
    cmd.action()
  }

  function handlePaletteKeydown(e: KeyboardEvent) {
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault()
        paletteIndex = Math.min(paletteIndex + 1, filteredCommands.length - 1)
        break
      case 'ArrowUp':
        e.preventDefault()
        paletteIndex = Math.max(paletteIndex - 1, 0)
        break
      case 'Enter':
        e.preventDefault()
        if (filteredCommands[paletteIndex]) {
          executePaletteCommand(filteredCommands[paletteIndex])
        }
        break
      case 'Escape':
        e.preventDefault()
        closePalette()
        break
    }
  }

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

  // --- Split view ---
  interface SplitSide {
    line: DiffLine
    hunkIdx: number
    lineIdx: number
  }

  interface SplitLine {
    left: SplitSide | null
    right: SplitSide | null
  }

  function toSplitView(hunks: DiffHunk[]): SplitLine[] {
    const result: SplitLine[] = []
    for (let hunkIdx = 0; hunkIdx < hunks.length; hunkIdx++) {
      const hunk = hunks[hunkIdx]
      result.push({
        left: { line: { type: 'header', content: hunk.header }, hunkIdx, lineIdx: -1 },
        right: { line: { type: 'header', content: hunk.header }, hunkIdx, lineIdx: -1 },
      })
      let dels: SplitSide[] = []
      let adds: SplitSide[] = []
      const flush = () => {
        const max = Math.max(dels.length, adds.length)
        for (let i = 0; i < max; i++) {
          result.push({ left: dels[i] ?? null, right: adds[i] ?? null })
        }
        dels = []
        adds = []
      }
      hunk.lines.forEach((line, lineIdx) => {
        const side: SplitSide = { line, hunkIdx, lineIdx }
        if (line.type === 'remove') {
          dels.push(side)
        } else if (line.type === 'add') {
          adds.push(side)
        } else {
          flush()
          result.push({ left: side, right: side })
        }
      })
      flush()
    }
    return result
  }

  // --- Collapse helpers ---
  function toggleFile(path: string) {
    const next = new Set(collapsedFiles)
    if (next.has(path)) {
      next.delete(path)
    } else {
      next.add(path)
    }
    collapsedFiles = next
  }

  function collapseAll() {
    collapsedFiles = new Set(parsedDiff.map((f) => filePathFromHeader(f.header)))
  }

  function expandAll() {
    collapsedFiles = new Set()
  }

  // Extract file path from diff header for matching with changedFiles
  function filePathFromHeader(header: string): string {
    // jj headers: "Modified regular file src/main.go:" or "Added regular file new.go:" etc.
    // Also git-style: "diff --git a/file b/file"
    const firstLine = header.split('\n')[0]
    // Match jj-style: "Modified regular file path/to/file:"
    const jjMatch = firstLine.match(/^(?:Modified|Added|Deleted|Copied|Renamed)\s+(?:regular\s+)?file\s+(.+?)(?::)?$/)
    if (jjMatch) return jjMatch[1]
    // Match git-style: "diff --git a/path b/path"
    const gitMatch = firstLine.match(/^diff --git a\/(.+?) b\//)
    if (gitMatch) return gitMatch[1]
    return firstLine
  }

  function scrollToFile(path: string) {
    // Expand if collapsed
    if (collapsedFiles.has(path)) {
      toggleFile(path)
    }
    // Also try to match by header
    requestAnimationFrame(() => {
      const el = document.querySelector(`[data-file-path="${CSS.escape(path)}"]`)
      el?.scrollIntoView({ block: 'start', behavior: 'smooth' })
    })
  }

  // Look up stats for a diff file by matching its header against changedFiles
  function statsForFile(header: string): FileChange | undefined {
    const path = filePathFromHeader(header)
    return changedFiles.find((f) => f.path === path)
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
      // Clear stale checked revisions (their change_ids may no longer exist)
      if (checkedRevisions.size > 0) {
        const validIds = new Set(revisions.map(r => r.commit.change_id))
        const next = new Set([...checkedRevisions].filter(id => validIds.has(id)))
        if (next.size !== checkedRevisions.size) {
          checkedRevisions = next
        }
      }
      // Reset range anchor — list may have been reordered
      lastCheckedIndex = -1
      if (selectedIndex >= 0 && checkedRevisions.size === 0) {
        await loadDiff(revisions[selectedIndex])
        await loadFiles(revisions[selectedIndex])
      }
    } catch (e) {
      error = e instanceof Error ? e.message : String(e)
    } finally {
      loading = false
    }
  }

  async function loadDiffForRevset(revset: string, file?: string) {
    const gen = ++diffGeneration
    diffLoading = true
    try {
      const result = await api.diff(revset, file)
      if (gen !== diffGeneration) return
      diffContent = result.diff
    } catch (e) {
      if (gen !== diffGeneration) return
      const msg = e instanceof Error ? e.message : String(e)
      diffContent = ''
      error = msg
    } finally {
      if (gen === diffGeneration) diffLoading = false
    }
  }

  async function loadFilesForRevset(revset: string) {
    const gen = ++filesGeneration
    filesLoading = true
    try {
      const result = await api.files(revset)
      if (gen !== filesGeneration) return
      changedFiles = result
    } catch {
      if (gen !== filesGeneration) return
      changedFiles = []
    } finally {
      if (gen === filesGeneration) filesLoading = false
    }
  }

  async function loadDiff(entry: LogEntry, file?: string) {
    await loadDiffForRevset(entry.commit.change_id, file)
  }

  async function loadFiles(entry: LogEntry) {
    await loadFilesForRevset(entry.commit.change_id)
  }

  async function selectRevision(index: number) {
    selectedIndex = index
    const entry = revisions[index]
    if (entry) {
      descriptionEditing = false
      selectedFile = null
      collapsedFiles = new Set()
      // When checked revisions exist, don't reload on cursor move — the effect handles it
      if (checkedRevisions.size === 0) {
        await Promise.all([loadDiff(entry), loadFiles(entry)])
      }
    }
  }

  // Reload diff/files when checked revisions change
  // Build revset directly from checkedRevisions to avoid tracking cursor changes
  $effect(() => {
    // Access checkedRevisions to create dependency
    const checked = [...checkedRevisions]
    if (checked.length === 0) return
    const revset = checked.join('|')
    loadDiffForRevset(revset)
    loadFilesForRevset(revset)
  })

  function selectFile(file: FileChange) {
    scrollToFile(file.path)
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

  async function handleAbandonChecked() {
    const revs = effectiveRevisions
    if (revs.length === 0) return
    try {
      const result = await api.abandon(revs)
      lastAction = revs.length > 1
        ? `Abandoned ${revs.length} revisions`
        : `Abandoned ${revs[0].slice(0, 8)}`
      commandOutput = result.output
      clearChecks()
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

  async function handleNewFromChecked() {
    const revs = effectiveRevisions
    if (revs.length === 0) return
    try {
      const result = await api.newRevision(revs)
      lastAction = revs.length > 1
        ? `Created new revision from ${revs.length} revisions`
        : `Created new revision from ${revs[0].slice(0, 8)}`
      commandOutput = result.output
      clearChecks()
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

  async function toggleOplog() {
    oplogOpen = !oplogOpen
    if (oplogOpen && oplogEntries.length === 0) {
      await loadOplog()
    }
  }

  async function loadOplog() {
    oplogLoading = true
    try {
      oplogEntries = await api.oplog(50)
    } catch (e) {
      error = e instanceof Error ? e.message : String(e)
    } finally {
      oplogLoading = false
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
    clearChecks()
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

    // Cmd+K / Ctrl+K opens palette from anywhere
    if (e.key === 'k' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault()
      openPalette()
      return
    }

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
      case ' ':
        if (selectedRevision) {
          e.preventDefault()
          toggleCheck(selectedRevision.commit.change_id, selectedIndex)
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
        if (checkedRevisions.size > 1) {
          e.preventDefault()
          lastAction = 'Describe works on a single revision — clear checks first'
        } else if (selectedRevision) {
          e.preventDefault()
          startDescriptionEdit()
        }
        break
      case 'n':
        e.preventDefault()
        if (checkedRevisions.size > 0) {
          handleNewFromChecked()
        } else if (selectedRevision) {
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
        } else if (checkedRevisions.size > 0) {
          clearChecks()
          // Reload diff for cursor selection, or clear stale aggregate diff
          if (selectedRevision) {
            loadDiff(selectedRevision)
            loadFiles(selectedRevision)
          } else {
            diffContent = ''
            changedFiles = []
          }
        } else if (error) {
          dismissError()
        }
        break
    }
  }

  // Scroll selected revision into view.
  // Accepts _index parameter to create a reactive dependency in $effect.
  function scrollSelectedIntoView(_index: number) {
    requestAnimationFrame(() => {
      const el = document.querySelector('.graph-row.node-row.selected')
      el?.scrollIntoView({ block: 'nearest' })
    })
  }

  $effect(() => {
    scrollSelectedIntoView(selectedIndex)
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
      <kbd class="shortcut-hint">Cmd+K</kbd> commands
      <kbd class="shortcut-hint">/</kbd> filter
      <kbd class="shortcut-hint">j/k</kbd> navigate
      <kbd class="shortcut-hint">Space</kbd> check
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
          <span class="panel-badge">{revisions.length}{#if checkedRevisions.size > 0} ({checkedRevisions.size} checked){/if}</span>
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
      {#if checkedRevisions.size > 0}
        <div class="batch-actions-bar">
          <span class="batch-label">{checkedRevisions.size} checked</span>
          <button class="action-btn" onclick={handleNewFromChecked} title="New from checked (n)">new</button>
          <button class="action-btn danger" onclick={handleAbandonChecked} title="Abandon checked">abandon</button>
          <button class="action-btn" onclick={clearChecks} title="Clear checks (Escape)">clear</button>
        </div>
      {/if}
      <div class="panel-content">
        {#if loading}
          <div class="empty-state">
            <div class="spinner"></div>
            <span>Loading revisions...</span>
          </div>
        {:else if revisions.length === 0}
          <div class="empty-state">No revisions found</div>
        {:else}
          <div class="revision-list" role="listbox" aria-label="Revision list">
            {#each flatLines as line, lineIdx}
              {@const isChecked = checkedRevisions.has(revisions[line.entryIndex]?.commit.change_id)}
              <div
                class="graph-row"
                class:node-row={line.isNode}
                class:selected={selectedIndex === line.entryIndex}
                class:checked={isChecked}
                class:wc={line.isWorkingCopy}
                class:hidden-rev={line.isHidden}
                onclick={(e: MouseEvent) => {
                  if (e.shiftKey && line.isNode && lastCheckedIndex >= 0) {
                    e.preventDefault()
                    rangeCheck(lastCheckedIndex, line.entryIndex)
                  } else {
                    selectRevision(line.entryIndex)
                  }
                }}
                role="option"
                tabindex={line.isNode ? 0 : -1}
                aria-selected={selectedIndex === line.entryIndex}
              >
                <span class="check-gutter">{#if line.isNode && isChecked}✓{/if}</span>
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
                  <span class="rev-actions" role="group">
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
            <button class="header-btn" onclick={startDescriptionEdit} title="Edit description (e)">
              Describe
            </button>
          </div>
        {:else}
          <span class="panel-title">Diff Viewer</span>
        {/if}
      </div>
      {#if descriptionEditing && selectedRevision}
        <div class="desc-editor">
          <label class="desc-label" for="desc-textarea">Description for {selectedRevision.commit.change_id.slice(0, 12)}</label>
          <textarea
            id="desc-textarea"
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
      {#if (selectedRevision || checkedRevisions.size > 0) && changedFiles.length > 0}
        <div class="file-list-bar">
          <span class="file-list-label">Files ({changedFiles.length})</span>
          <div class="file-list">
            {#each changedFiles as file}
              <button
                class="file-chip"
                onclick={() => selectFile(file)}
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
          <div class="diff-content">
            {#each parsedDiff as file}
              {@const filePath = filePathFromHeader(file.header)}
              {@const fileStats = statsForFile(file.header)}
              {@const isCollapsed = collapsedFiles.has(filePath)}
              <div class="diff-file" data-file-path={filePath}>
                <div
                  class="diff-file-header"
                  onclick={() => toggleFile(filePath)}
                  role="button"
                  tabindex="0"
                  onkeydown={(e: KeyboardEvent) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleFile(filePath) }}}
                >
                  <span class="collapse-toggle">{isCollapsed ? '\u25B6' : '\u25BC'}</span>
                  {#if fileStats}
                    <span class="file-type-badge" class:badge-A={fileStats.type === 'A'} class:badge-M={fileStats.type === 'M'} class:badge-D={fileStats.type === 'D'} class:badge-R={fileStats.type === 'R'}>{fileStats.type}</span>
                  {/if}
                  <span class="diff-file-path">
                    {#if filePath.includes('/')}
                      <span class="file-dir">{filePath.slice(0, filePath.lastIndexOf('/') + 1)}</span><span class="file-name">{filePath.slice(filePath.lastIndexOf('/') + 1)}</span>
                    {:else}
                      <span class="file-name">{filePath}</span>
                    {/if}
                  </span>
                  {#if fileStats && (fileStats.additions > 0 || fileStats.deletions > 0)}
                    <span class="file-stats">
                      {#if fileStats.additions > 0}<span class="stat-add">+{fileStats.additions}</span>{/if}
                      {#if fileStats.deletions > 0}<span class="stat-del">-{fileStats.deletions}</span>{/if}
                    </span>
                  {/if}
                </div>
                {#if !isCollapsed}
                  {#if splitView}
                    <!-- Split (side-by-side) view -->
                    {@const splitLines = toSplitView(file.hunks)}
                    <div class="split-view">
                      <div class="split-col split-left">
                        {#each splitLines as sl}
                          {#if sl.left?.line.type === 'header'}
                            <div class="diff-hunk-header">{sl.left.line.content}</div>
                          {:else if sl.left}
                            {@const slKey = `${filePath}:${sl.left.hunkIdx}:${sl.left.lineIdx}`}
                            {#if highlightedLines.has(slKey)}
                              <div
                                class="diff-line highlighted"
                                class:diff-remove={sl.left.line.type === 'remove'}
                                class:diff-context={sl.left.line.type === 'context'}
                              >{@html highlightedLines.get(slKey)}</div>
                            {:else}
                              <div
                                class="diff-line"
                                class:diff-remove={sl.left.line.type === 'remove'}
                                class:diff-context={sl.left.line.type === 'context'}
                              >{sl.left.line.content}</div>
                            {/if}
                          {:else}
                            <div class="diff-line diff-empty">&nbsp;</div>
                          {/if}
                        {/each}
                      </div>
                      <div class="split-col split-right">
                        {#each splitLines as sl}
                          {#if sl.right?.line.type === 'header'}
                            <div class="diff-hunk-header">{sl.right.line.content}</div>
                          {:else if sl.right}
                            {@const srKey = `${filePath}:${sl.right.hunkIdx}:${sl.right.lineIdx}`}
                            {#if highlightedLines.has(srKey)}
                              <div
                                class="diff-line highlighted"
                                class:diff-add={sl.right.line.type === 'add'}
                                class:diff-context={sl.right.line.type === 'context'}
                              >{@html highlightedLines.get(srKey)}</div>
                            {:else}
                              <div
                                class="diff-line"
                                class:diff-add={sl.right.line.type === 'add'}
                                class:diff-context={sl.right.line.type === 'context'}
                              >{sl.right.line.content}</div>
                            {/if}
                          {:else}
                            <div class="diff-line diff-empty">&nbsp;</div>
                          {/if}
                        {/each}
                      </div>
                    </div>
                  {:else}
                    <!-- Unified view -->
                    {#each file.hunks as hunk, hunkIdx}
                      <div class="diff-hunk-header">{hunk.header}</div>
                      <div class="diff-lines">
                        {#each hunk.lines as line, lineIdx}
                          {@const hlKey = `${filePath}:${hunkIdx}:${lineIdx}`}
                          {#if highlightedLines.has(hlKey)}
                            <div
                              class="diff-line highlighted"
                              class:diff-add={line.type === 'add'}
                              class:diff-remove={line.type === 'remove'}
                              class:diff-context={line.type === 'context'}
                            >{@html highlightedLines.get(hlKey)}</div>
                          {:else}
                            <div
                              class="diff-line"
                              class:diff-add={line.type === 'add'}
                              class:diff-remove={line.type === 'remove'}
                              class:diff-context={line.type === 'context'}
                            >{line.content}</div>
                          {/if}
                        {/each}
                      </div>
                    {/each}
                  {/if}
                {/if}
              </div>
            {/each}
          </div>
        {/if}
      </div>
    </div>
  </div>

  <!-- Operation log panel -->
  {#if oplogOpen}
    <div class="oplog-panel">
      <div class="panel-header">
        <span class="panel-title">Operation Log</span>
        <div class="panel-actions">
          <button class="header-btn" onclick={loadOplog}>Refresh</button>
          <button class="header-btn" onclick={() => { oplogOpen = false }}>Close</button>
        </div>
      </div>
      <div class="oplog-content">
        {#if oplogLoading}
          <div class="empty-state">
            <div class="spinner"></div>
            <span>Loading operations...</span>
          </div>
        {:else}
          {#each oplogEntries as op}
            <div class="oplog-entry" class:oplog-current={op.is_current}>
              <span class="oplog-id">{op.id}</span>
              <span class="oplog-desc">{op.description}</span>
              <span class="oplog-time">{op.time}</span>
            </div>
          {:else}
            <div class="empty-state">No operations</div>
          {/each}
        {/if}
      </div>
    </div>
  {/if}

  <!-- Command palette -->
  {#if paletteOpen}
    <div class="palette-backdrop" onclick={closePalette} role="presentation"></div>
    <div class="palette">
      <input
        bind:this={paletteInputEl}
        bind:value={paletteQuery}
        class="palette-input"
        type="text"
        placeholder="Type a command..."
        onkeydown={handlePaletteKeydown}
        oninput={() => { paletteIndex = 0 }}
      />
      <div class="palette-results">
        {#each filteredCommands as cmd, i}
          <button
            class="palette-item"
            class:palette-item-active={i === paletteIndex}
            onclick={() => executePaletteCommand(cmd)}
            onmouseenter={() => { paletteIndex = i }}
          >
            <span class="palette-label">{cmd.label}</span>
            {#if cmd.shortcut}
              <kbd class="palette-shortcut">{cmd.shortcut}</kbd>
            {/if}
          </button>
        {:else}
          <div class="palette-empty">No matching commands</div>
        {/each}
      </div>
    </div>
  {/if}

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

  /* --- Batch actions bar --- */
  .batch-actions-bar {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 4px 8px;
    background: #1e2a1e;
    border-bottom: 1px solid #2d5a3d;
    flex-shrink: 0;
  }

  .batch-label {
    color: #a6e3a1;
    font-size: 11px;
    font-weight: 600;
    margin-right: 4px;
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

  .graph-row.checked {
    background: #1e2a1e;
  }

  .graph-row.checked.selected {
    background: #243024;
    box-shadow: inset 2px 0 0 #89b4fa;
  }

  .graph-row.hidden-rev {
    opacity: 0.45;
  }

  /* Check gutter: ✓ indicator for checked revisions */
  .check-gutter {
    width: 14px;
    flex-shrink: 0;
    text-align: center;
    color: #a6e3a1;
    font-size: 11px;
    padding-left: 4px;
  }

  /* Gutter: graph characters */
  .gutter {
    white-space: pre;
    font-size: 13px;
    line-height: 1.15;
    color: #585b70;
    flex-shrink: 0;
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

  .file-type-indicator {
    font-weight: 700;
    font-size: 10px;
    margin-right: 3px;
    color: #a6adc8;
  }

  .file-type-A {
    color: #a6e3a1;
  }

  .file-type-D {
    color: #f38ba8;
  }

  .file-type-M {
    color: #f9e2af;
  }

  /* --- Diff toolbar --- */
  .diff-toolbar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 4px 12px;
    background: #181825;
    border-bottom: 1px solid #313244;
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
    border: 1px solid #45475a;
    color: #a6adc8;
    padding: 2px 8px;
    border-radius: 3px;
    cursor: pointer;
    font-family: inherit;
    font-size: 11px;
    transition: all 0.15s ease;
  }

  .toolbar-btn-sm:hover {
    background: #313244;
    color: #cdd6f4;
  }

  .toolbar-btn-sm.active {
    background: #89b4fa22;
    border-color: #89b4fa;
    color: #89b4fa;
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
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px 12px;
    background: #181825;
    color: #cdd6f4;
    font-weight: 600;
    font-size: 12px;
    border-bottom: 1px solid #313244;
    position: sticky;
    top: 0;
    z-index: 1;
    cursor: pointer;
    user-select: none;
    transition: background 0.1s ease;
  }

  .diff-file-header:hover {
    background: #1e1e30;
  }

  .collapse-toggle {
    color: #585b70;
    font-size: 10px;
    width: 12px;
    flex-shrink: 0;
  }

  .file-type-badge {
    font-size: 10px;
    font-weight: 700;
    padding: 0 4px;
    border-radius: 3px;
    flex-shrink: 0;
  }

  .badge-A {
    background: #a6e3a120;
    color: #a6e3a1;
  }

  .badge-M {
    background: #89b4fa20;
    color: #89b4fa;
  }

  .badge-D {
    background: #f38ba820;
    color: #f38ba8;
  }

  .badge-R {
    background: #f9e2af20;
    color: #f9e2af;
  }

  .diff-file-path {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .file-dir {
    color: #585b70;
    font-weight: 400;
  }

  .file-name {
    color: #cdd6f4;
    font-weight: 700;
  }

  .file-stats {
    display: flex;
    gap: 6px;
    flex-shrink: 0;
    font-size: 11px;
    font-weight: 600;
  }

  .stat-add {
    color: #a6e3a1;
  }

  .stat-del {
    color: #f38ba8;
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

  /* When syntax-highlighted, let Shiki token colors show through */
  .diff-line.highlighted {
    color: #cdd6f4;
  }

  .diff-line.highlighted.diff-add {
    color: inherit;
  }

  .diff-line.highlighted.diff-remove {
    color: inherit;
  }

  .diff-line.highlighted.diff-context {
    color: inherit;
    opacity: 0.7;
  }

  :global(.diff-prefix) {
    user-select: none;
    opacity: 0.5;
    margin-right: 0;
  }

  /* --- Split view --- */
  .split-view {
    display: flex;
  }

  .split-col {
    flex: 1;
    min-width: 0;
    overflow-x: auto;
  }

  .split-left {
    border-right: 1px solid #313244;
  }

  .diff-empty {
    background: #1a1a2a;
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

  /* --- Operation log panel --- */
  .oplog-panel {
    border-top: 1px solid #313244;
    flex-shrink: 0;
    max-height: 200px;
    display: flex;
    flex-direction: column;
  }

  .oplog-content {
    overflow-y: auto;
    font-size: 12px;
  }

  .oplog-entry {
    display: flex;
    align-items: baseline;
    gap: 10px;
    padding: 3px 12px;
    border-bottom: 1px solid #1a1a2e;
  }

  .oplog-entry:hover {
    background: #262637;
  }

  .oplog-entry.oplog-current {
    background: #1e2a1e;
  }

  .oplog-id {
    color: #89b4fa;
    font-weight: 600;
    font-size: 11px;
    flex-shrink: 0;
    width: 100px;
  }

  .oplog-desc {
    flex: 1;
    color: #cdd6f4;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .oplog-time {
    color: #585b70;
    font-size: 11px;
    flex-shrink: 0;
    white-space: nowrap;
  }

  /* --- Command palette --- */
  .palette-backdrop {
    position: fixed;
    inset: 0;
    background: #00000066;
    z-index: 100;
  }

  .palette {
    position: fixed;
    top: 20%;
    left: 50%;
    transform: translateX(-50%);
    width: 480px;
    max-height: 400px;
    background: #1e1e2e;
    border: 1px solid #45475a;
    border-radius: 8px;
    box-shadow: 0 16px 48px #00000088;
    z-index: 101;
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }

  .palette-input {
    width: 100%;
    background: #181825;
    color: #cdd6f4;
    border: none;
    border-bottom: 1px solid #313244;
    padding: 12px 16px;
    font-family: inherit;
    font-size: 14px;
    outline: none;
  }

  .palette-input::placeholder {
    color: #585b70;
  }

  .palette-results {
    overflow-y: auto;
    padding: 4px 0;
  }

  .palette-item {
    display: flex;
    align-items: center;
    justify-content: space-between;
    width: 100%;
    padding: 8px 16px;
    background: transparent;
    border: none;
    color: #cdd6f4;
    font-family: inherit;
    font-size: 13px;
    cursor: pointer;
    text-align: left;
  }

  .palette-item-active {
    background: #313244;
  }

  .palette-label {
    flex: 1;
  }

  .palette-shortcut {
    background: #313244;
    color: #a6adc8;
    padding: 1px 6px;
    border-radius: 3px;
    font-size: 11px;
    font-family: inherit;
    border: 1px solid #45475a;
    margin-left: 12px;
  }

  .palette-item-active .palette-shortcut {
    background: #45475a;
  }

  .palette-empty {
    padding: 16px;
    color: #585b70;
    text-align: center;
    font-size: 13px;
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
