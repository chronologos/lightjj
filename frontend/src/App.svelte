<script lang="ts">
  import { SvelteSet } from 'svelte/reactivity'
  import { api, isCached, onStale, type LogEntry, type FileChange, type OpEntry } from './lib/api'
  import type { PaletteCommand } from './lib/CommandPalette.svelte'
  import Toolbar from './lib/Toolbar.svelte'
  import StatusBar from './lib/StatusBar.svelte'
  import CommandPalette from './lib/CommandPalette.svelte'
  import RevisionGraph from './lib/RevisionGraph.svelte'
  import DiffPanel from './lib/DiffPanel.svelte'
  import EvologPanel from './lib/EvologPanel.svelte'
  import OplogPanel from './lib/OplogPanel.svelte'
  import BookmarkModal, { type BookmarkOp } from './lib/BookmarkModal.svelte'
  import BookmarkInput from './lib/BookmarkInput.svelte'
  import GitModal from './lib/GitModal.svelte'
  type SourceMode = '-r' | '-s' | '-b'
  type TargetMode = '-d' | '--insert-after' | '--insert-before'

  const sourceModeLabel: Record<SourceMode, string> = { '-r': 'revision', '-s': 'source', '-b': 'branch' }
  const targetModeLabel: Record<TargetMode, string> = { '-d': 'onto', '--insert-after': 'after', '--insert-before': 'before' }

  // --- Global state ---
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
  let viewMode: 'log' | 'tracked' = $state('log')
  const TRACKED_REVSET = 'ancestors(@ | mutable() & mine() | trunk()..tracked_remote_bookmarks(), 2) | trunk()'
  let changedFiles: FileChange[] = $state([])
  let filesLoading: boolean = $state(false)
  let describeSaved: boolean = $state(false)
  let splitView: boolean = $state(false)
  let checkedRevisions = new SvelteSet<string>()
  let lastCheckedIndex: number = $state(-1)
  // Non-reactive generation counters for async cancellation
  let logGeneration: number = 0
  let diffGeneration: number = 0
  let filesGeneration: number = 0
  let evologGeneration: number = 0
  // Debounce timer for diff/files loading during rapid j/k navigation
  let navDebounceTimer: number | undefined
  let evologOpen: boolean = $state(false)
  let evologContent: string = $state('')
  let evologLoading: boolean = $state(false)
  let oplogOpen: boolean = $state(false)
  let oplogEntries: OpEntry[] = $state([])
  let oplogLoading: boolean = $state(false)

  let paletteOpen: boolean = $state(false)
  let bookmarkModalOpen: boolean = $state(false)
  let bookmarkModalFilter: string = $state('')
  let bookmarkInputOpen: boolean = $state(false)
  let gitModalOpen: boolean = $state(false)
  let rebaseMode: boolean = $state(false)
  let rebaseSources: string[] = $state([])
  let rebaseSourceMode: SourceMode = $state('-r')
  let rebaseTargetMode: TargetMode = $state('-d')

  let squashMode: boolean = $state(false)
  let squashSources: string[] = $state([])
  let squashKeepEmptied: boolean = $state(false)
  let squashUseDestMsg: boolean = $state(false)
  let squashSelectedFiles = new SvelteSet<string>()
  let squashTotalFiles: number = $state(0) // snapshot of file count at entry time

  let splitMode: boolean = $state(false)
  let splitRevision: string = $state('')
  let splitParallel: boolean = $state(false)

  let anyModalOpen = $derived(paletteOpen || bookmarkModalOpen || bookmarkInputOpen || gitModalOpen)
  let conflictCount = $derived(changedFiles.filter(f => f.conflict).length)

  // --- Theme ---
  let darkMode: boolean = $state(localStorage.getItem('lightjj-theme') !== 'light')

  function toggleTheme() {
    darkMode = !darkMode
    document.documentElement.classList.toggle('light', !darkMode)
    localStorage.setItem('lightjj-theme', darkMode ? 'dark' : 'light')
    diffPanelRef?.rehighlight()
  }

  // Apply saved theme on load
  if (localStorage.getItem('lightjj-theme') === 'light') document.documentElement.classList.add('light')

  // --- Refs ---
  let revisionGraphRef: ReturnType<typeof RevisionGraph> | undefined = $state(undefined)
  let diffPanelRef: ReturnType<typeof DiffPanel> | undefined = $state(undefined)

  // --- Derived ---
  let selectedRevision: LogEntry | null = $derived(
    selectedIndex >= 0 && selectedIndex < revisions.length
      ? revisions[selectedIndex]
      : null
  )

  let effectiveRevisions = $derived.by(() => {
    if (checkedRevisions.size > 0) {
      return [...checkedRevisions]
    }
    return selectedRevision ? [selectedRevision.commit.change_id] : []
  })

  let statusText = $derived.by(() => {
    if (rebaseMode || squashMode || splitMode) return ''
    if (loading) return 'Loading revisions...'
    if (diffLoading) return 'Loading diff...'
    if (lastAction) return lastAction
    const count = revisions.length
    const wc = revisions.find(r => r.commit.is_working_copy)
    const checked = checkedRevisions.size > 0 ? `${checkedRevisions.size} checked | ` : ''
    const conflicts = conflictCount > 0 ? ` | ${conflictCount} conflict${conflictCount !== 1 ? 's' : ''}` : ''
    return `${checked}${count} revisions${wc ? ` | @ ${wc.commit.change_id.slice(0, 8)}` : ''}${conflicts}`
  })

  // --- Check management ---
  function toggleCheck(changeId: string, index: number) {
    if (checkedRevisions.has(changeId)) {
      checkedRevisions.delete(changeId)
    } else {
      checkedRevisions.add(changeId)
    }
    diffPanelRef?.resetCollapsed()
    lastCheckedIndex = index
  }

  function rangeCheck(fromIndex: number, toIndex: number) {
    const lo = Math.min(fromIndex, toIndex)
    const hi = Math.max(fromIndex, toIndex)
    for (let i = lo; i <= hi; i++) {
      if (i < revisions.length) {
        checkedRevisions.add(revisions[i].commit.change_id)
      }
    }
    diffPanelRef?.resetCollapsed()
    lastCheckedIndex = toIndex
  }

  function clearChecks() {
    checkedRevisions.clear()
    lastCheckedIndex = -1
  }

  function clearChecksAndReload() {
    clearChecks()
    if (selectedRevision) loadDiffAndFiles(selectedRevision.commit.change_id)
    else { diffContent = ''; changedFiles = [] }
  }

  // --- Error helper ---
  function showError(e: unknown) {
    error = e instanceof Error ? e.message : String(e)
  }

  function dismissError() {
    error = ''
  }

  // --- Command palette ---
  const noop = () => {}
  let commands: PaletteCommand[] = $derived.by(() => [
    // Navigation
    { label: 'Move down', shortcut: 'j', category: 'Navigation', action: noop, infoOnly: true },
    { label: 'Move up', shortcut: 'k', category: 'Navigation', action: noop, infoOnly: true },
    { label: 'Toggle check', shortcut: 'Space', category: 'Navigation', action: noop, infoOnly: true },
    { label: 'Load diff', shortcut: 'Enter', category: 'Navigation', action: noop, infoOnly: true },
    { label: 'Focus revset filter', shortcut: '/', category: 'Navigation', action: () => revisionGraphRef?.focusRevsetInput() },
    { label: 'Clear revset filter', category: 'Navigation', action: clearRevsetFilter, when: () => revsetFilter !== '' },

    // Revisions
    { label: 'Refresh revisions', shortcut: 'r', category: 'Revisions', action: loadLog },
    { label: 'New revision', shortcut: 'n', category: 'Revisions', action: () => {
      if (checkedRevisions.size > 0) handleNewFromChecked()
      else if (selectedRevision) handleNew(selectedRevision.commit.change_id)
    }, when: () => !!selectedRevision || checkedRevisions.size > 0 },
    { label: 'Edit description', shortcut: 'e', category: 'Revisions', action: startDescriptionEdit, when: () => !!selectedRevision && checkedRevisions.size <= 1 },
    { label: 'Edit selected revision', category: 'Revisions', action: () => handleEdit(selectedRevision!.commit.change_id), when: () => !!selectedRevision },
    { label: 'Abandon selected revision', category: 'Revisions', action: () => handleAbandon(selectedRevision!.commit.change_id), when: () => !!selectedRevision && checkedRevisions.size === 0 },
    { label: `Abandon ${checkedRevisions.size} checked`, category: 'Revisions', action: handleAbandonChecked, when: () => checkedRevisions.size > 0 },
    { label: `New from ${checkedRevisions.size} checked`, category: 'Revisions', action: handleNewFromChecked, when: () => checkedRevisions.size > 0 },
    { label: 'Rebase revision(s)', shortcut: 'R', category: 'Revisions', action: enterRebaseMode, when: () => !rebaseMode && !squashMode && !splitMode && (!!selectedRevision || checkedRevisions.size > 0) },
    { label: 'Squash revision(s)', shortcut: 'S', category: 'Revisions', action: enterSquashMode, when: () => !squashMode && !rebaseMode && !splitMode && (!!selectedRevision || checkedRevisions.size > 0) },
    { label: 'Split revision', shortcut: 's', category: 'Revisions', action: enterSplitMode, when: () => !splitMode && !squashMode && !rebaseMode && !!selectedRevision && checkedRevisions.size === 0 },

    // Git
    { label: 'Git operations (push/fetch)', category: 'Git', action: () => { closeAllModals(); gitModalOpen = true } },

    // Bookmarks
    { label: 'Bookmark operations', shortcut: 'b', category: 'Bookmarks', action: openBookmarkModal },
    { label: 'Set bookmark', shortcut: 'B', category: 'Bookmarks', action: () => { closeAllModals(); bookmarkInputOpen = true }, when: () => !!selectedRevision && checkedRevisions.size === 0 },

    // View
    { label: viewMode === 'log' ? 'Switch to tracked view' : 'Switch to log view', shortcut: 't', category: 'View', action: toggleViewMode },
    { label: 'Toggle split/unified diff', category: 'View', action: () => { splitView = !splitView } },
    { label: 'Toggle operation log', category: 'View', action: toggleOplog },
    { label: 'Toggle evolution log', category: 'View', action: toggleEvolog, when: () => !!selectedRevision },
    { label: darkMode ? 'Light theme' : 'Dark theme', category: 'View', action: toggleTheme },

    // Actions
    { label: 'Undo last operation', shortcut: 'u', category: 'Actions', action: handleUndo },
    { label: 'Clear checked revisions', shortcut: 'Esc', category: 'Actions', action: clearChecksAndReload, when: () => checkedRevisions.size > 0 },
    { label: 'Command palette', shortcut: '\u2318K', category: 'Actions', action: noop, infoOnly: true },
  ])

  // --- API actions ---
  async function loadLog(resetSelection = false) {
    const gen = ++logGeneration
    if (revisions.length === 0) loading = true
    error = ''
    try {
      const effectiveRevset = revsetFilter || (viewMode === 'tracked' ? TRACKED_REVSET : undefined)
      const result = await api.log(effectiveRevset)
      if (gen !== logGeneration) return
      revisions = result
      if (resetSelection || selectedIndex < 0 || selectedIndex >= revisions.length) {
        selectedIndex = revisions.findIndex(r => r.commit.is_working_copy)
      }
      if (checkedRevisions.size > 0) {
        const validIds = new Set(revisions.map(r => r.commit.change_id))
        for (const id of [...checkedRevisions]) {
          if (!validIds.has(id)) checkedRevisions.delete(id)
        }
      }
      lastCheckedIndex = -1
      if (selectedIndex >= 0 && checkedRevisions.size === 0) {
        loadDiffAndFiles(revisions[selectedIndex].commit.change_id)
      }
      // Refresh open panels — oplog always reflects new operations,
      // evolog may change if the selected revision was modified
      if (oplogOpen) loadOplog()
      if (evologOpen && selectedIndex >= 0 && revisions[selectedIndex]) {
        loadEvolog(revisions[selectedIndex].commit.change_id)
      }
    } catch (e) {
      if (gen !== logGeneration) return
      showError(e)
    } finally {
      if (gen === logGeneration) loading = false
    }
  }

  async function loadDiffForRevset(revset: string, file?: string) {
    const gen = ++diffGeneration
    if (!isCached(revset)) diffLoading = true
    try {
      const result = await api.diff(revset, file)
      if (gen !== diffGeneration) return
      if (diffContent !== result.diff) diffContent = result.diff
    } catch (e) {
      if (gen !== diffGeneration) return
      diffContent = ''
      showError(e)
    } finally {
      if (gen === diffGeneration) diffLoading = false
    }
  }

  async function loadFilesForRevset(revset: string) {
    const gen = ++filesGeneration
    if (!isCached(revset)) filesLoading = true
    try {
      const result = await api.files(revset)
      if (gen !== filesGeneration) return
      if (changedFiles !== result) changedFiles = result
    } catch (e) {
      if (gen !== filesGeneration) return
      changedFiles = []
      showError(e)
    } finally {
      if (gen === filesGeneration) filesLoading = false
    }
  }

  function loadDiffAndFiles(changeId: string) {
    loadDiffForRevset(changeId)
    loadFilesForRevset(changeId)
  }

  // Move cursor without loading diff/files — used in squash mode where
  // the diff is intentionally frozen on the source revision
  function selectRevisionCursorOnly(index: number) {
    selectedIndex = index
  }

  function selectRevision(index: number) {
    selectedIndex = index
    descriptionEditing = false

    const entry = revisions[index]
    if (!entry) return

    // Debounce diff/files loading: highlight moves instantly, but fetches
    // wait for navigation to settle. Cache hits skip the debounce.
    clearTimeout(navDebounceTimer)
    const cached = isCached(entry.commit.change_id)
    if (checkedRevisions.size === 0) {
      if (cached) {
        loadDiffAndFiles(entry.commit.change_id)
      } else {
        navDebounceTimer = setTimeout(() => {
          const current = revisions[selectedIndex]
          if (current) {
            loadDiffAndFiles(current.commit.change_id)
            if (evologOpen) loadEvolog(current.commit.change_id)
          }
        }, 50)
        return // evolog deferred with the rest
      }
    }
    if (evologOpen) {
      loadEvolog(entry.commit.change_id)
    }
  }

  // Reload diff/files when checked revisions change
  // Skip during squash/split mode — diff is intentionally frozen on source revision
  $effect(() => {
    const checked = [...checkedRevisions]
    if (checked.length === 0) return
    if (squashMode || splitMode) return
    const revset = checked.join('|')
    loadDiffForRevset(revset)
    loadFilesForRevset(revset)
  })

  async function handleAbandon(changeId: string) {
    try {
      const result = await api.abandon([changeId])
      lastAction = `Abandoned ${changeId.slice(0, 8)}`
      commandOutput = result.output
      await loadLog()
    } catch (e) {
      showError(e)
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
      showError(e)
    }
  }

  async function handleNew(changeId: string) {
    try {
      const result = await api.newRevision([changeId])
      lastAction = `Created new revision from ${changeId.slice(0, 8)}`
      commandOutput = result.output
      await loadLog()
    } catch (e) {
      showError(e)
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
      showError(e)
    }
  }

  async function handleEdit(changeId: string) {
    try {
      const result = await api.edit(changeId)
      lastAction = `Editing ${changeId.slice(0, 8)}`
      commandOutput = result.output
      await loadLog()
    } catch (e) {
      showError(e)
    }
  }

  async function handleUndo() {
    try {
      const result = await api.undo()
      lastAction = 'Undo successful'
      commandOutput = result.output
      await loadLog()
    } catch (e) {
      showError(e)
    }
  }

  async function handleDescribe() {
    if (!selectedRevision) return
    try {
      const result = await api.describe(selectedRevision.commit.change_id, descriptionDraft)
      lastAction = `Updated description for ${selectedRevision.commit.change_id.slice(0, 8)}`
      commandOutput = result.output
      descriptionEditing = false
      describeSaved = true
      setTimeout(() => { describeSaved = false }, 1500)
      await loadLog()
    } catch (e) {
      showError(e)
    }
  }

  async function handleGitOp(type: 'push' | 'fetch', flags: string[]) {
    try {
      const result = type === 'push' ? await api.gitPush(flags) : await api.gitFetch(flags)
      lastAction = `Git ${type} complete`
      commandOutput = result.output
      await loadLog()
    } catch (e) {
      showError(e)
    }
  }

  async function handleBookmarkSet(name: string) {
    if (!selectedRevision) return
    try {
      const result = await api.bookmarkSet(selectedRevision.commit.change_id, name)
      bookmarkInputOpen = false
      lastAction = `Set bookmark ${name}`
      commandOutput = result.output
      await loadLog()
    } catch (e) {
      showError(e)
    }
  }

  async function handleBookmarkOp(op: BookmarkOp) {
    if (op.action === 'move' && !selectedRevision) return
    try {
      const changeId = selectedRevision?.commit.change_id ?? ''
      const actions: Record<BookmarkOp['action'], () => Promise<{ output: string }>> = {
        move: () => api.bookmarkMove(op.bookmark, changeId),
        delete: () => api.bookmarkDelete(op.bookmark),
        forget: () => api.bookmarkForget(op.bookmark),
        track: () => api.bookmarkTrack(op.bookmark, op.remote!),
        untrack: () => api.bookmarkUntrack(op.bookmark, op.remote!),
      }
      const result = await actions[op.action]()
      bookmarkModalOpen = false
      lastAction = `${op.action} ${op.bookmark}`
      commandOutput = result.output
      await loadLog()
    } catch (e) {
      showError(e)
    }
  }

  async function handleResolve(file: string, tool: ':ours' | ':theirs') {
    const revision = selectedRevision?.commit.change_id
    if (!revision) return
    try {
      await api.resolve(revision, file, tool)
      lastAction = `Resolved ${file.split('/').pop()} with ${tool.slice(1)}`
      await loadLog()
    } catch (e) {
      showError(e)
    }
  }

  function enterRebaseMode() {
    const revs = effectiveRevisions
    if (revs.length === 0) return
    // Ensure mutual exclusion with squash/split mode
    squashMode = false
    splitMode = false
    squashSelectedFiles.clear()
    rebaseSources = revs
    rebaseSourceMode = '-r'
    rebaseTargetMode = '-d'
    rebaseMode = true
  }

  async function executeRebase() {
    if (!selectedRevision || rebaseSources.length === 0) return
    const destination = selectedRevision.commit.change_id
    // Don't rebase onto self
    if (rebaseSources.includes(destination)) {
      lastAction = 'Cannot rebase onto source revision'
      return
    }
    rebaseMode = false
    try {
      const result = await api.rebase(rebaseSources, destination, rebaseSourceMode, rebaseTargetMode)
      const modeLabel = targetModeLabel[rebaseTargetMode]
      lastAction = rebaseSources.length > 1
        ? `Rebased ${rebaseSources.length} revisions ${modeLabel} ${destination.slice(0, 8)}`
        : `Rebased ${rebaseSources[0].slice(0, 8)} ${modeLabel} ${destination.slice(0, 8)}`
      commandOutput = result.output
      clearChecks()
      await loadLog()
    } catch (e) {
      showError(e)
    }
  }

  function enterSquashMode() {
    const revs = effectiveRevisions
    if (revs.length === 0) return
    // Ensure mutual exclusion with rebase/split mode
    rebaseMode = false
    splitMode = false
    squashSources = revs
    squashKeepEmptied = false
    squashUseDestMsg = false
    squashSelectedFiles.clear()
    // Initialize with all current changed files (source's files) and snapshot the count
    for (const f of changedFiles) squashSelectedFiles.add(f.path)
    squashTotalFiles = changedFiles.length
    squashMode = true
    // Move cursor to parent of first source (default squash target)
    const sourceIdx = revisions.findIndex(r => r.commit.change_id === revs[0])
    if (sourceIdx >= 0 && sourceIdx < revisions.length - 1) {
      selectRevisionCursorOnly(sourceIdx + 1)
    }
  }

  async function executeSquash() {
    if (!selectedRevision || squashSources.length === 0) return
    const destination = selectedRevision.commit.change_id
    // C2: exit mode before guard so user isn't stuck
    if (squashSources.includes(destination)) {
      squashMode = false
      squashSelectedFiles.clear()
      lastAction = 'Cannot squash into source revision'
      return
    }
    // C1: block execution when no files selected (empty array would squash ALL files)
    if (squashSelectedFiles.size === 0) {
      lastAction = 'Select at least one file to squash'
      return
    }
    try {
      // W3: compare against snapshotted total, not live changedFiles
      const files = squashSelectedFiles.size < squashTotalFiles
        ? [...squashSelectedFiles]
        : undefined
      const result = await api.squash(squashSources, destination, {
        files,
        keepEmptied: squashKeepEmptied || undefined,
        useDestinationMessage: squashUseDestMsg || undefined,
      })
      // W1: only exit mode after successful API call
      squashMode = false
      squashSelectedFiles.clear()
      lastAction = squashSources.length > 1
        ? `Squashed ${squashSources.length} revisions into ${destination.slice(0, 8)}`
        : `Squashed ${squashSources[0].slice(0, 8)} into ${destination.slice(0, 8)}`
      commandOutput = result.output
      clearChecks()
      await loadLog()
    } catch (e) {
      // W1: keep squash mode active so user can retry or Escape
      showError(e)
    }
  }

  function toggleSquashFile(path: string) {
    if (squashSelectedFiles.has(path)) {
      squashSelectedFiles.delete(path)
    } else {
      squashSelectedFiles.add(path)
    }
  }

  function enterSplitMode() {
    if (!selectedRevision || checkedRevisions.size > 0) return
    // Ensure mutual exclusion
    rebaseMode = false
    squashMode = false
    splitRevision = selectedRevision.commit.change_id
    splitParallel = false
    // Initialize: all files checked (stay), user unchecks what to split out
    squashSelectedFiles.clear()
    for (const f of changedFiles) squashSelectedFiles.add(f.path)
    squashTotalFiles = changedFiles.length
    splitMode = true
  }

  async function executeSplit() {
    if (!splitRevision) return
    // Validate: at least one file must stay (checked) and one must move (unchecked)
    if (squashSelectedFiles.size === squashTotalFiles) {
      error = 'Uncheck at least one file to split out'
      return
    }
    if (squashSelectedFiles.size === 0) {
      error = 'Select at least one file to keep'
      return
    }
    try {
      const files = [...squashSelectedFiles]
      const result = await api.split(splitRevision, files, splitParallel || undefined)
      splitMode = false
      splitRevision = ''
      splitParallel = false
      squashSelectedFiles.clear()
      lastAction = `Split ${splitRevision.slice(0, 8)} (${files.length} files stay)`
      commandOutput = result.output
      clearChecks()
      await loadLog()
    } catch (e) {
      // Keep split mode active so user can retry or Escape
      showError(e)
    }
  }

  let squashFileCount = $derived.by(() => {
    if (!squashMode || squashTotalFiles === 0) return null
    return { selected: squashSelectedFiles.size, total: squashTotalFiles }
  })

  let splitFileCount = $derived.by(() => {
    if (!splitMode || squashTotalFiles === 0) return null
    return { selected: squashSelectedFiles.size, total: squashTotalFiles }
  })

  function closeModals() {
    paletteOpen = false
    bookmarkModalOpen = false
    bookmarkInputOpen = false
    gitModalOpen = false
  }

  function closeAllModals() {
    closeModals()
    rebaseMode = false
    squashMode = false
    splitMode = false
    splitRevision = ''
    splitParallel = false
    squashSelectedFiles.clear()
  }

  function openBookmarkModal(filter?: string) {
    closeAllModals()
    bookmarkModalFilter = filter ?? ''
    bookmarkModalOpen = true
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
      showError(e)
    } finally {
      oplogLoading = false
    }
  }

  async function toggleEvolog() {
    evologOpen = !evologOpen
    if (evologOpen && selectedRevision) {
      await loadEvolog(selectedRevision.commit.change_id)
    }
  }

  async function loadEvolog(changeId: string) {
    const gen = ++evologGeneration
    evologLoading = true
    evologContent = ''
    try {
      const result = await api.evolog(changeId)
      if (gen !== evologGeneration) return
      evologContent = result.output
    } catch (e) {
      if (gen !== evologGeneration) return
      evologContent = ''
      showError(e)
    } finally {
      if (gen === evologGeneration) evologLoading = false
    }
  }

  async function startDescriptionEdit() {
    if (!selectedRevision) return
    try {
      const result = await api.description(selectedRevision.commit.change_id)
      descriptionDraft = result.description
    } catch (e) {
      // Fall back to cached description but warn the user
      descriptionDraft = selectedRevision.description
      lastAction = 'Using cached description (could not fetch latest)'
    }
    descriptionEditing = true
    requestAnimationFrame(() => {
      const el = document.querySelector('.desc-editor textarea') as HTMLTextAreaElement
      el?.focus()
    })
  }

  function handleRevsetSubmit() {
    clearTimeout(navDebounceTimer)
    diffContent = ''
    changedFiles = []
    clearChecks()
    loadLog(true)
  }

  function clearRevsetFilter() {
    revsetFilter = ''
    handleRevsetSubmit()
  }

  function toggleViewMode() {
    revsetFilter = ''
    viewMode = viewMode === 'log' ? 'tracked' : 'log'
    handleRevsetSubmit()
  }

  // --- Keyboard shortcuts ---
  function handleKeydown(e: KeyboardEvent) {
    const target = e.target as HTMLElement

    // Cmd+K / Ctrl+K opens palette from anywhere
    if (e.key === 'k' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault()
      closeModals()
      paletteOpen = true
      return
    }

    if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA') return

    // Skip all shortcuts when any modal is open (modals handle their own keys)
    if (anyModalOpen) return

    // Split mode: no j/k (operates on fixed revision), Enter executes, Escape cancels, p toggles parallel
    if (splitMode) {
      switch (e.key) {
        case 'Enter':
          e.preventDefault()
          executeSplit()
          break
        case 'Escape':
          e.preventDefault()
          splitMode = false
          splitRevision = ''
          splitParallel = false
          squashSelectedFiles.clear()
          break
        case 'p':
          e.preventDefault()
          splitParallel = !splitParallel
          break
      }
      return
    }

    // Squash mode: j/k navigate (cursor only, keep source diff), Enter executes, Escape cancels
    if (squashMode) {
      switch (e.key) {
        case 'j':
          e.preventDefault()
          if (selectedIndex < revisions.length - 1) selectRevisionCursorOnly(selectedIndex + 1)
          break
        case 'k':
          e.preventDefault()
          if (selectedIndex > 0) selectRevisionCursorOnly(selectedIndex - 1)
          break
        case 'Enter':
          e.preventDefault()
          executeSquash()
          break
        case 'Escape':
          e.preventDefault()
          squashMode = false
          squashSelectedFiles.clear()
          break
        case 'e':
          e.preventDefault()
          squashKeepEmptied = !squashKeepEmptied
          break
        case 'd':
          e.preventDefault()
          squashUseDestMsg = !squashUseDestMsg
          break
      }
      return
    }

    // Rebase mode: limited keyset — j/k navigate, Enter executes, Escape cancels, mode keys
    if (rebaseMode) {
      switch (e.key) {
        case 'j':
          e.preventDefault()
          if (selectedIndex < revisions.length - 1) selectRevision(selectedIndex + 1)
          break
        case 'k':
          e.preventDefault()
          if (selectedIndex > 0) selectRevision(selectedIndex - 1)
          break
        case 'Enter':
          e.preventDefault()
          executeRebase()
          break
        case 'Escape':
          e.preventDefault()
          rebaseMode = false
          break
        case 'r':
          e.preventDefault()
          rebaseSourceMode = '-r'
          break
        case 's':
          e.preventDefault()
          rebaseSourceMode = '-s'
          break
        case 'b':
          e.preventDefault()
          rebaseSourceMode = '-b'
          break
        case 'a':
          e.preventDefault()
          rebaseTargetMode = '--insert-after'
          break
        case 'i':
          e.preventDefault()
          rebaseTargetMode = '--insert-before'
          break
        case 'o': case 'd':
          e.preventDefault()
          rebaseTargetMode = '-d'
          break
      }
      return
    }

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
          loadDiffAndFiles(selectedRevision.commit.change_id)
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
      case 'b':
        e.preventDefault()
        openBookmarkModal()
        break
      case 'R':
        if (selectedRevision || checkedRevisions.size > 0) {
          e.preventDefault()
          enterRebaseMode()
        }
        break
      case 's':
        if (selectedRevision && checkedRevisions.size === 0) {
          e.preventDefault()
          enterSplitMode()
        }
        break
      case 'S':
        if (selectedRevision || checkedRevisions.size > 0) {
          e.preventDefault()
          enterSquashMode()
        }
        break
      case 'B':
        if (selectedRevision && checkedRevisions.size === 0) {
          e.preventDefault()
          bookmarkInputOpen = true
        }
        break
      case 't':
        e.preventDefault()
        toggleViewMode()
        break
      case '/':
        e.preventDefault()
        revisionGraphRef?.focusRevsetInput()
        break
      case 'Escape':
        if (descriptionEditing) {
          descriptionEditing = false
        } else if (checkedRevisions.size > 0) {
          clearChecksAndReload()
        } else if (error) {
          dismissError()
        }
        break
    }
  }

  // Auto-refresh when jj state changes outside the UI (detected via op-id header).
  // Skip if a loadLog is already in progress (mutation handlers call loadLog explicitly).
  $effect(() => {
    return onStale(() => {
      if (!loading && !anyModalOpen && !squashMode && !rebaseMode && !splitMode) loadLog()
    })
  })

  loadLog()
</script>

<svelte:window onkeydown={handleKeydown} />

<div class="app">
  <Toolbar
    onrefresh={loadLog}
    onundo={handleUndo}
    onfetch={() => { closeAllModals(); gitModalOpen = true }}
    onpush={() => { closeAllModals(); gitModalOpen = true }}
    onopenpalette={() => { closeModals(); paletteOpen = true }}
  />

  {#if error}
    <div class="error-bar" role="alert">
      <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
        <path d="M8 1a7 7 0 1 0 0 14A7 7 0 0 0 8 1zm0 10.5a.75.75 0 1 1 0-1.5.75.75 0 0 1 0 1.5zM8.75 4.5v4a.75.75 0 0 1-1.5 0v-4a.75.75 0 0 1 1.5 0z"/>
      </svg>
      <span class="error-text">{error}</span>
      <button class="error-dismiss" onclick={dismissError}>Dismiss</button>
    </div>
  {/if}

  <div class="workspace">
    <RevisionGraph
      bind:this={revisionGraphRef}
      {revisions}
      {selectedIndex}
      {checkedRevisions}
      {loading}
      {revsetFilter}
      {viewMode}
      {lastCheckedIndex}
      onselect={selectRevision}
      oncheck={toggleCheck}
      onrangecheck={rangeCheck}
      onedit={handleEdit}
      onnew={handleNew}
      onabandon={handleAbandon}
      onnewfromchecked={handleNewFromChecked}
      onabandonchecked={handleAbandonChecked}
      onclearchecks={clearChecksAndReload}
      onrevsetsubmit={handleRevsetSubmit}
      onrevsetclear={clearRevsetFilter}
      onrevsetchange={(v) => { revsetFilter = v }}
      onrevsetescaped={clearRevsetFilter}
      onviewmodechange={toggleViewMode}
      onbookmarkclick={openBookmarkModal}
      {rebaseMode}
      {rebaseSources}
      {rebaseSourceMode}
      {rebaseTargetMode}
      {squashMode}
      {squashSources}
      {squashKeepEmptied}
      {squashUseDestMsg}
      {splitMode}
      {splitRevision}
      {splitParallel}
    />

    <DiffPanel
      bind:this={diffPanelRef}
      {diffContent}
      {changedFiles}
      {selectedRevision}
      {checkedRevisions}
      {diffLoading}
      {filesLoading}
      bind:splitView
      {descriptionEditing}
      {descriptionDraft}
      {describeSaved}
      onstartdescribe={startDescriptionEdit}
      ondescribe={handleDescribe}
      oncanceldescribe={() => { descriptionEditing = false }}
      ondraftchange={(v) => { descriptionDraft = v }}
      onbookmarkclick={openBookmarkModal}
      squashMode={squashMode || splitMode}
      {squashSelectedFiles}
      ontogglefile={toggleSquashFile}
      {splitMode}
      onresolve={squashMode || rebaseMode ? undefined : handleResolve}
    />
  </div>

  {#if evologOpen}
    <EvologPanel
      content={evologContent}
      loading={evologLoading}
      {selectedRevision}
      onrefresh={() => { if (selectedRevision) loadEvolog(selectedRevision.commit.change_id) }}
      onclose={() => { evologOpen = false }}
    />
  {/if}

  {#if oplogOpen}
    <OplogPanel
      entries={oplogEntries}
      loading={oplogLoading}
      onrefresh={loadOplog}
      onclose={() => { oplogOpen = false }}
    />
  {/if}

  <CommandPalette bind:open={paletteOpen} {commands} />

  <GitModal
    bind:open={gitModalOpen}
    currentChangeId={selectedRevision?.commit.change_id ?? null}
    onexecute={handleGitOp}
    onclose={() => { gitModalOpen = false }}
  />

  <BookmarkInput
    bind:open={bookmarkInputOpen}
    onsave={handleBookmarkSet}
    oncancel={() => { bookmarkInputOpen = false }}
  />

  <BookmarkModal
    bind:open={bookmarkModalOpen}
    currentCommitId={selectedRevision?.commit.commit_id ?? null}
    filterBookmark={bookmarkModalFilter}
    onexecute={handleBookmarkOp}
    onclose={() => { bookmarkModalOpen = false }}
  />

  <StatusBar
    {statusText}
    {commandOutput}
    {rebaseMode}
    {rebaseSourceMode}
    {rebaseTargetMode}
    {squashMode}
    {squashKeepEmptied}
    {squashUseDestMsg}
    {squashFileCount}
    {splitMode}
    {splitParallel}
    {splitFileCount}
  />
</div>

<style>
  /* --- Catppuccin Mocha (dark) --- */
  :root {
    --base: #1e1e2e;
    --mantle: #181825;
    --crust: #11111b;
    --surface0: #313244;
    --surface1: #45475a;
    --surface2: #585b70;
    --overlay0: #6c7086;
    --overlay1: #7f849c;
    --subtext0: #a6adc8;
    --subtext1: #bac2de;
    --text: #cdd6f4;
    --blue: #89b4fa;
    --green: #a6e3a1;
    --red: #f38ba8;
    --yellow: #f9e2af;
    --teal: #74c7ec;
    --peach: #fab387;
    --mauve: #cba6f7;

    /* Conflict region card */
    --conflict-boundary-border: #f38ba835;
    --conflict-boundary-bg: #f38ba810;
    --conflict-boundary-color: #6c7086;
    --conflict-side1-border: #fab387;
    --conflict-side1-bg: #fab38710;
    --conflict-side1-marker-bg: #fab38718;
    --conflict-side2-border: #cba6f7;
    --conflict-side2-bg: #cba6f710;
    --conflict-side2-marker-bg: #cba6f718;
    --conflict-marker-color: #6c7086;

    /* Semantic tinted backgrounds */
    --bg-hover: #262637;
    --bg-selected: #2a2a40;
    --bg-checked: #1e2a1e;
    --bg-checked-selected: #243024;
    --bg-error: #45171a;
    --bg-error-hover: #f38ba822;
    --bg-bookmark: #1e3a2a;
    --border-bookmark: #2d5a3d;
    --bg-diff-header-hover: #1e1e30;
    --bg-hunk-header: #1a1a2e;
    --border-hunk-header: #21212e;
    --bg-diff-empty: #1a1a2a;
    --bg-active: #89b4fa22;
    --bg-btn-primary-hover: #b4d0fb;
    --bg-btn-kbd: #1e1e2e33;
    --wc-desc-color: #e0e0e0;

    /* Diff line backgrounds */
    --diff-add-bg: #a6e3a112;
    --diff-remove-bg: #f38ba812;
    --diff-add-word: #a6e3a133;
    --diff-remove-word: #f38ba833;

    /* File type badge backgrounds */
    --badge-add-bg: #a6e3a120;
    --badge-modify-bg: #89b4fa20;
    --badge-delete-bg: #f38ba820;
    --badge-other-bg: #f9e2af20;
    --badge-workspace-bg: #74c7ec15;
    --border-workspace: #74c7ec40;

    /* Palette overlay */
    --backdrop: #00000066;
    --shadow-heavy: 0 16px 48px #00000088;
  }

  /* --- Catppuccin Latte (light) --- */
  :root.light {
    --base: #eff1f5;
    --mantle: #e6e9ef;
    --crust: #dce0e8;
    --surface0: #ccd0da;
    --surface1: #bcc0cc;
    --surface2: #acb0be;
    --overlay0: #9ca0b0;
    --overlay1: #8c8fa1;
    --subtext0: #6c6f85;
    --subtext1: #5c5f77;
    --text: #4c4f69;
    --blue: #1e66f5;
    --green: #40a02b;
    --red: #d20f39;
    --yellow: #df8e1d;
    --teal: #04a5e5;
    --peach: #fe640b;
    --mauve: #8839ef;

    --conflict-boundary-border: #d20f3935;
    --conflict-boundary-bg: #d20f3910;
    --conflict-boundary-color: #8c8fa1;
    --conflict-side1-border: #fe640b;
    --conflict-side1-bg: #fe640b10;
    --conflict-side1-marker-bg: #fe640b18;
    --conflict-side2-border: #8839ef;
    --conflict-side2-bg: #8839ef10;
    --conflict-side2-marker-bg: #8839ef18;
    --conflict-marker-color: #8c8fa1;

    --bg-hover: #d9dbe5;
    --bg-selected: #cbd0e0;
    --bg-checked: #d4e8d0;
    --bg-checked-selected: #c0ddb8;
    --bg-error: #fce4e8;
    --bg-error-hover: #d20f3918;
    --bg-bookmark: #d8f0d0;
    --border-bookmark: #90c480;
    --bg-diff-header-hover: #d8dae5;
    --bg-hunk-header: #d5d8e2;
    --border-hunk-header: #c8ccd8;
    --bg-diff-empty: #e0e2ea;
    --bg-active: #1e66f522;
    --bg-btn-primary-hover: #1555d0;
    --bg-btn-kbd: #ffffff55;
    --wc-desc-color: #2a2d3a;

    --diff-add-bg: #40a02b15;
    --diff-remove-bg: #d20f3915;
    --diff-add-word: #40a02b30;
    --diff-remove-word: #d20f3930;

    --badge-add-bg: #40a02b20;
    --badge-modify-bg: #1e66f520;
    --badge-delete-bg: #d20f3920;
    --badge-other-bg: #df8e1d20;
    --badge-workspace-bg: #04a5e515;
    --border-workspace: #04a5e540;

    --backdrop: #00000033;
    --shadow-heavy: 0 16px 48px #00000044;
  }

  /* --- Reset & Globals --- */
  :global(*) {
    box-sizing: border-box;
  }

  :global(body) {
    margin: 0;
    padding: 0;
    font-family: 'SF Mono', 'Cascadia Code', 'JetBrains Mono', 'Fira Code', 'Menlo', 'Consolas', monospace;
    font-size: 13px;
    background: var(--base);
    color: var(--text);
    overflow: hidden;
  }

  /* --- Layout --- */
  .app {
    display: flex;
    flex-direction: column;
    height: 100vh;
    overflow: hidden;
  }

  .workspace {
    display: flex;
    flex: 1;
    overflow: hidden;
  }

  /* --- Error bar --- */
  .error-bar {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 6px 12px;
    background: var(--bg-error);
    border-bottom: 1px solid var(--red);
    color: var(--red);
    font-size: 12px;
    flex-shrink: 0;
  }

  .error-text {
    flex: 1;
  }

  .error-dismiss {
    background: transparent;
    border: 1px solid var(--red);
    color: var(--red);
    padding: 2px 8px;
    border-radius: 3px;
    cursor: pointer;
    font-family: inherit;
    font-size: 11px;
  }

  .error-dismiss:hover {
    background: var(--bg-error-hover);
  }
</style>
