<script lang="ts">
  import { SvelteSet } from 'svelte/reactivity'
  import { api, effectiveId, isCached, onStale, type LogEntry, type FileChange, type OpEntry, type Workspace, type Alias, type PullRequest } from './lib/api'
  import type { PaletteCommand } from './lib/CommandPalette.svelte'
  import Sidebar from './lib/Sidebar.svelte'
  import StatusBar from './lib/StatusBar.svelte'
  import CommandPalette from './lib/CommandPalette.svelte'
  import RevisionGraph from './lib/RevisionGraph.svelte'
  import DiffPanel from './lib/DiffPanel.svelte'
  import EvologPanel from './lib/EvologPanel.svelte'
  import OplogPanel from './lib/OplogPanel.svelte'
  import BookmarkModal, { type BookmarkOp } from './lib/BookmarkModal.svelte'
  import BookmarkInput from './lib/BookmarkInput.svelte'
  import GitModal from './lib/GitModal.svelte'
  import ContextMenu, { type ContextMenuItem } from './lib/ContextMenu.svelte'
  import DivergencePanel from './lib/DivergencePanel.svelte'
  import { createRebaseMode, createSquashMode, createSplitMode, createDivergenceMode, targetModeLabel } from './lib/modes.svelte'
  import { config } from './lib/config.svelte'

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
  let commitMode: boolean = $state(false) // when true, description editor saves via commit instead of describe
  let commandOutput: string = $state('')
  let revsetFilter: string = $state('')
  let viewMode: 'log' | 'tracked' = $state('log')
  const TRACKED_REVSET = 'ancestors(@ | mutable() & mine() | trunk()..tracked_remote_bookmarks(), 2) | trunk()'
  let changedFiles: FileChange[] = $state([])
  let filesLoading: boolean = $state(false)
  let describeSaved: boolean = $state(false)
  let fullDescription: string = $state('')
  let splitView: boolean = $state(false)
  let checkedRevisions = new SvelteSet<string>()
  let lastCheckedIndex: number = $state(-1)
  // Non-reactive generation counters for async cancellation
  let logGeneration: number = 0
  let diffGeneration: number = 0
  let filesGeneration: number = 0
  let descGeneration: number = 0
  let evologGeneration: number = 0
  let oplogGeneration: number = 0
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
  const rebase = createRebaseMode()
  const squash = createSquashMode()
  const split = createSplitMode()
  const divergence = createDivergenceMode()
  let squashSelectedFiles = new SvelteSet<string>()
  let squashTotalFiles: number = $state(0) // snapshot of file count at entry time

  let activeView: 'log' | 'branches' | 'operations' = $state('log')

  let currentWorkspace: string = $state('')
  let workspaceList: Workspace[] = $state([])
  let aliases: Alias[] = $state([])
  let pullRequests: PullRequest[] = $state([])
  let prByBookmark = $derived(new Map(pullRequests.map(pr => [pr.bookmark, pr])))

  let contextMenuItems: ContextMenuItem[] = $state([])
  let contextMenuX: number = $state(0)
  let contextMenuY: number = $state(0)
  let contextMenuOpen: boolean = $state(false)

  let anyModalOpen = $derived(paletteOpen || bookmarkModalOpen || bookmarkInputOpen || gitModalOpen || contextMenuOpen || divergence.active)
  let inlineMode = $derived(rebase.active || squash.active || split.active)
  let conflictCount = $derived(changedFiles.filter(f => f.conflict).length)

  // --- Theme ---
  let darkMode = $derived(config.theme === 'dark')

  function toggleTheme() {
    config.theme = darkMode ? 'light' : 'dark'
    diffPanelRef?.rehighlight()
  }

  // Sync theme class + reduce-motion class to <html>
  $effect(() => {
    document.documentElement.classList.toggle('light', !darkMode)
    document.documentElement.classList.toggle('reduce-motion', config.reduceMotion)
  })

  // --- Refs ---
  let revisionGraphRef: ReturnType<typeof RevisionGraph> | undefined = $state(undefined)
  let diffPanelRef: ReturnType<typeof DiffPanel> | undefined = $state(undefined)
  let sidebarRef: ReturnType<typeof Sidebar> | undefined = $state(undefined)

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
    return selectedRevision ? [effectiveId(selectedRevision.commit)] : []
  })

  let statusText = $derived.by(() => {
    if (inlineMode) return ''
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
        checkedRevisions.add(effectiveId(revisions[i].commit))
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
    if (selectedRevision) loadDiffAndFiles(effectiveId(selectedRevision.commit))
    else { diffContent = ''; changedFiles = [] }
  }

  // --- Error helper ---
  function showError(e: unknown) {
    error = e instanceof Error ? e.message : String(e)
  }

  function dismissError() {
    error = ''
  }

  // After mutations that re-render the DOM, focus can land on the revset input,
  // silently blocking all keyboard shortcuts via the INPUT tagName guard.
  // Only blur empty inputs — if the user is actively typing (has content), leave it.
  function blurActiveInput() {
    const el = document.activeElement as HTMLInputElement
    if ((el?.tagName === 'INPUT' || el?.tagName === 'TEXTAREA') && !el.value) el.blur()
  }

  // --- Alias duplicate filtering ---
  const BUILTIN_COMMANDS = new Set([
    'new', 'edit', 'abandon', 'rebase', 'squash', 'split', 'commit',
    'describe', 'bookmark', 'undo', 'restore', 'absorb', 'resolve',
    'git push', 'git fetch',
    'log', 'status', 'diff', 'file', 'op',
  ])

  function isBuiltinAlias(a: Alias): boolean {
    const cmd = a.command[0]
    if (cmd === 'git' && a.command[1]) return BUILTIN_COMMANDS.has(`git ${a.command[1]}`)
    return BUILTIN_COMMANDS.has(cmd)
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
      else if (selectedRevision) handleNew(effectiveId(selectedRevision.commit))
    }, when: () => !!selectedRevision || checkedRevisions.size > 0 },
    { label: 'Edit description', shortcut: 'e', category: 'Revisions', action: startDescriptionEdit, when: () => !inlineMode && !!selectedRevision && checkedRevisions.size <= 1 },
    { label: 'Edit selected revision', category: 'Revisions', action: () => handleEdit(effectiveId(selectedRevision!.commit)), when: () => !!selectedRevision },
    { label: 'Abandon selected revision', category: 'Revisions', action: () => handleAbandon(effectiveId(selectedRevision!.commit)), when: () => !!selectedRevision && checkedRevisions.size === 0 },
    { label: `Abandon ${checkedRevisions.size} checked`, category: 'Revisions', action: handleAbandonChecked, when: () => checkedRevisions.size > 0 },
    { label: `New from ${checkedRevisions.size} checked`, category: 'Revisions', action: handleNewFromChecked, when: () => checkedRevisions.size > 0 },
    { label: 'Rebase revision(s)', shortcut: 'R', category: 'Revisions', action: enterRebaseMode, when: () => !inlineMode && (!!selectedRevision || checkedRevisions.size > 0) },
    { label: 'Squash revision(s)', shortcut: 'S', category: 'Revisions', action: enterSquashMode, when: () => !inlineMode && (!!selectedRevision || checkedRevisions.size > 0) },
    { label: 'Split revision', shortcut: 's', category: 'Revisions', action: enterSplitMode, when: () => !inlineMode && !!selectedRevision && checkedRevisions.size === 0 },
    { label: 'Commit working copy', shortcut: 'c', category: 'Revisions', action: handleCommit, when: () => !inlineMode },

    // Git
    { label: 'Git fetch', shortcut: 'f', category: 'Git', action: () => handleGitOp('fetch', []), when: () => !inlineMode },
    { label: 'Git push', shortcut: 'p', category: 'Git', action: () => handleGitOp('push', []), when: () => !inlineMode },
    { label: 'Git operations (advanced)', shortcut: 'g', category: 'Git', action: () => { closeAllModals(); gitModalOpen = true }, when: () => !inlineMode },

    // Bookmarks
    { label: 'Bookmark operations', shortcut: 'b', category: 'Bookmarks', action: openBookmarkModal },
    { label: 'Set bookmark', shortcut: 'B', category: 'Bookmarks', action: () => { closeAllModals(); bookmarkInputOpen = true }, when: () => !!selectedRevision && checkedRevisions.size === 0 },

    // View
    { label: darkMode ? 'Light theme' : 'Dark theme', shortcut: 't', category: 'View', action: toggleTheme },
    { label: config.reduceMotion ? 'Enable animations' : 'Reduce motion', category: 'View', action: () => { config.reduceMotion = !config.reduceMotion } },
    { label: viewMode === 'log' ? 'Switch to tracked view' : 'Switch to log view', category: 'View', action: toggleViewMode },
    { label: 'Toggle split/unified diff', category: 'View', action: () => { splitView = !splitView } },
    { label: 'Toggle operation log', category: 'View', action: toggleOplog },
    { label: 'Toggle evolution log', category: 'View', action: toggleEvolog, when: () => !!selectedRevision },

    // Actions
    { label: 'Undo last operation', shortcut: 'u', category: 'Actions', action: handleUndo, when: () => !inlineMode },
    { label: 'Clear checked revisions', shortcut: 'Esc', category: 'Actions', action: clearChecksAndReload, when: () => checkedRevisions.size > 0 },
    { label: 'Command palette', shortcut: '\u2318K', category: 'Actions', action: noop, infoOnly: true },

    // Aliases — filtered to exclude builtins that already have palette entries
    ...aliases
      .filter(a => !isBuiltinAlias(a))
      .map(a => ({
        label: a.name,
        hint: a.command.join(' '),
        category: 'Aliases',
        action: () => handleRunAlias(a.name),
        when: () => !inlineMode,
      })),
  ])

  // --- API actions ---
  async function loadWorkspaces() {
    try {
      const result = await api.workspaces()
      currentWorkspace = result.current
      workspaceList = result.workspaces
    } catch { /* ignore — SSH mode or single workspace */ }
  }

  async function loadAliases() {
    try { aliases = await api.aliases() }
    catch { /* ignore — aliases are optional */ }
  }

  async function loadPullRequests() {
    try { pullRequests = await api.pullRequests() }
    catch { /* ignore — gh may not be available */ }
  }

  function handleRunAlias(name: string) {
    runMutation(() => api.runAlias(name), `Ran alias: ${name}`)
  }

  async function handleWorkspaceOpen(name: string) {
    try {
      const result = await api.workspaceOpen(name)
      window.open(result.url, '_blank')
    } catch (e) {
      showError(e)
    }
  }

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
        const validIds = new Set(revisions.map(r => effectiveId(r.commit)))
        for (const id of [...checkedRevisions]) {
          if (!validIds.has(id)) checkedRevisions.delete(id)
        }
      }
      lastCheckedIndex = -1
      if (selectedIndex >= 0 && checkedRevisions.size === 0) {
        loadDiffAndFiles(effectiveId(revisions[selectedIndex].commit))
      }
      // Refresh open panels — oplog always reflects new operations,
      // evolog may change if the selected revision was modified
      if (oplogOpen || activeView === 'operations') loadOplog()
      if (evologOpen && selectedIndex >= 0 && revisions[selectedIndex]) {
        loadEvolog(effectiveId(revisions[selectedIndex].commit))
      }
    } catch (e) {
      if (gen !== logGeneration) return
      showError(e)
    } finally {
      if (gen === logGeneration) {
        loading = false
        blurActiveInput()
      }
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

  async function loadDescription(changeId: string) {
    const gen = ++descGeneration
    try {
      const result = await api.description(changeId)
      if (gen !== descGeneration) return
      fullDescription = result.description
    } catch {
      if (gen !== descGeneration) return
      fullDescription = ''
    }
  }

  function loadDiffAndFiles(changeId: string) {
    loadDiffForRevset(changeId)
    loadFilesForRevset(changeId)
    loadDescription(changeId)
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
    const eid = effectiveId(entry.commit)
    const cached = isCached(eid)
    const doLoad = (id: string) => {
      if (checkedRevisions.size === 0) loadDiffAndFiles(id)
      if (evologOpen) loadEvolog(id)
    }
    if (cached) {
      doLoad(eid)
    } else {
      navDebounceTimer = setTimeout(() => {
        const current = revisions[selectedIndex]
        if (current) doLoad(effectiveId(current.commit))
      }, 50)
    }
  }

  function selectByChangeId(changeId: string) {
    const idx = revisions.findIndex(r => effectiveId(r.commit) === changeId)
    if (idx >= 0) selectRevision(idx)
  }

  function openRevisionContextMenu(changeId: string, x: number, y: number) {
    const entry = revisions.find(r => effectiveId(r.commit) === changeId)
    const commitId = entry?.commit.commit_id ?? ''
    const items: ContextMenuItem[] = [
      { label: 'Edit working copy', action: () => handleEdit(changeId) },
      { label: 'New revision', shortcut: 'n', action: () => handleNew(changeId) },
      { label: 'Describe', shortcut: 'e', action: () => { selectByChangeId(changeId); startDescriptionEdit() } },
      { separator: true },
      { label: 'Rebase...', shortcut: 'R', action: () => { selectByChangeId(changeId); enterRebaseMode() } },
      { label: 'Squash...', shortcut: 'S', action: () => { selectByChangeId(changeId); enterSquashMode() } },
      { label: 'Split...', shortcut: 's', action: () => { selectByChangeId(changeId); enterSplitMode() } },
      { separator: true },
      { label: 'Set bookmark...', shortcut: 'B', action: () => { selectByChangeId(changeId); bookmarkInputOpen = true } },
    ]
    if (entry?.commit.divergent) {
      items.push(
        { separator: true },
        { label: 'Resolve divergence...', action: () => divergence.enter(entry.commit.change_id) },
      )
    }
    items.push(
      { separator: true },
      { label: `Copy change ID (${(entry?.commit.change_id ?? changeId).slice(0, 8)})`, action: () => navigator.clipboard.writeText(entry?.commit.change_id ?? changeId) },
      { label: `Copy commit ID (${commitId.slice(0, 8)})`, action: () => navigator.clipboard.writeText(commitId) },
      { separator: true },
      { label: 'Abandon', action: () => handleAbandon(changeId), danger: true },
    )
    contextMenuItems = items
    contextMenuX = x
    contextMenuY = y
    contextMenuOpen = true
  }

  // Reload diff/files when checked revisions change
  // Skip during squash/split mode — diff is intentionally frozen on source revision
  $effect(() => {
    const checked = [...checkedRevisions]
    if (checked.length === 0) return
    if (squash.active || split.active) return
    const revset = checked.join('|')
    loadDiffForRevset(revset)
    loadFilesForRevset(revset)
  })

  async function runMutation(
    fn: () => Promise<{ output: string }>,
    successMsg: string,
    opts?: { before?: () => void, after?: () => void },
  ) {
    try {
      opts?.before?.()
      const result = await fn()
      lastAction = successMsg
      commandOutput = result.output
      opts?.after?.()
      await loadLog()
    } catch (e) { showError(e) }
  }

  const handleAbandon = (id: string) =>
    runMutation(() => api.abandon([id]), `Abandoned ${id.slice(0, 8)}`)

  const handleNew = (id: string) =>
    runMutation(() => api.newRevision([id]), `Created new revision from ${id.slice(0, 8)}`)

  const handleEdit = (id: string) =>
    runMutation(() => api.edit(id), `Editing ${id.slice(0, 8)}`)

  const handleUndo = () =>
    runMutation(() => api.undo(), 'Undo successful')

  function handleAbandonChecked() {
    const revs = effectiveRevisions
    if (revs.length === 0) return
    const msg = revs.length > 1 ? `Abandoned ${revs.length} revisions` : `Abandoned ${revs[0].slice(0, 8)}`
    runMutation(() => api.abandon(revs), msg, { after: clearChecks })
  }

  function handleNewFromChecked() {
    const revs = effectiveRevisions
    if (revs.length === 0) return
    const msg = revs.length > 1 ? `Created new revision from ${revs.length} revisions` : `Created new revision from ${revs[0].slice(0, 8)}`
    runMutation(() => api.newRevision(revs), msg, { after: clearChecks })
  }

  async function handleDescribe() {
    if (!selectedRevision) return
    const eid = effectiveId(selectedRevision.commit)
    try {
      const result = await api.describe(eid, descriptionDraft)
      lastAction = `Updated description for ${eid.slice(0, 8)}`
      commandOutput = result.output
      fullDescription = descriptionDraft
      descriptionEditing = false
      describeSaved = true
      setTimeout(() => { describeSaved = false }, 1500)
      await loadLog()
    } catch (e) {
      showError(e)
    }
  }

  async function handleCommit() {
    // Open description editor in commit mode — pre-fill with current WC description
    if (!selectedRevision) return
    commitMode = true
    if (fullDescription) {
      descriptionDraft = fullDescription
    } else {
      try {
        const result = await api.description(effectiveId(selectedRevision.commit))
        descriptionDraft = result.description
      } catch {
        descriptionDraft = selectedRevision.description
      }
    }
    descriptionEditing = true
    requestAnimationFrame(() => {
      const el = document.querySelector('.desc-editor textarea') as HTMLTextAreaElement
      el?.focus()
    })
  }

  async function executeCommit() {
    try {
      const result = await api.commit(descriptionDraft)
      lastAction = 'Committed working copy'
      commandOutput = result.output
      descriptionEditing = false
      commitMode = false
      fullDescription = ''
      await loadLog()
    } catch (e) {
      showError(e)
    }
  }

  const handleGitOp = (type: 'push' | 'fetch', flags: string[]) =>
    runMutation(
      () => type === 'push' ? api.gitPush(flags) : api.gitFetch(flags),
      `Git ${type} complete`,
      { after: () => loadPullRequests() },
    )

  function handleBookmarkSet(name: string) {
    if (!selectedRevision) return
    runMutation(
      () => api.bookmarkSet(effectiveId(selectedRevision!.commit), name),
      `Set bookmark ${name}`,
      { before: () => { bookmarkInputOpen = false } },
    )
  }

  function handleBookmarkOp(op: BookmarkOp) {
    if (op.action === 'move' && !selectedRevision) return
    const changeId = selectedRevision ? effectiveId(selectedRevision.commit) : ''
    const actions: Record<BookmarkOp['action'], () => Promise<{ output: string }>> = {
      move: () => api.bookmarkMove(op.bookmark, changeId),
      delete: () => api.bookmarkDelete(op.bookmark),
      forget: () => api.bookmarkForget(op.bookmark),
      track: () => api.bookmarkTrack(op.bookmark, op.remote!),
      untrack: () => api.bookmarkUntrack(op.bookmark, op.remote!),
    }
    runMutation(
      actions[op.action],
      `${op.action} ${op.bookmark}`,
      { before: () => { bookmarkModalOpen = false } },
    )
  }

  function handleResolve(file: string, tool: ':ours' | ':theirs') {
    const revision = selectedRevision ? effectiveId(selectedRevision.commit) : undefined
    if (!revision) return
    runMutation(
      () => api.resolve(revision, file, tool),
      `Resolved ${file.split('/').pop()} with ${tool.slice(1)}`,
    )
  }

  async function handleKeepDivergent(keptCommitId: string, abandonIds: string[]) {
    try {
      // Snapshot conflicted bookmarks BEFORE abandon — --retain-bookmarks
      // may auto-resolve them by moving to the parent, losing the conflict flag
      const bookmarksBefore = await api.bookmarks()
      const conflictedNames = bookmarksBefore
        .filter(b => b.conflict && abandonIds.includes(b.commit_id))
        .map(b => b.name)

      await api.abandon(abandonIds)

      // Move all previously-conflicted bookmarks to the kept commit.
      // Serial (not Promise.all): concurrent jj mutations can produce divergent
      // op history. N is tiny (1-3) and this is a rare manual action.
      for (const name of conflictedNames) {
        await api.bookmarkSet(keptCommitId, name)
      }

      divergence.cancel()
      lastAction = `Resolved divergence — kept ${keptCommitId.slice(0, 8)}`
      await loadLog()
    } catch (e: any) {
      // Don't close panel on error — let user see state and retry
      showError(e.message || 'Failed to resolve divergence')
      await loadLog() // always refresh to show current reality
    }
  }

  function enterRebaseMode() {
    const revs = effectiveRevisions
    if (revs.length === 0) return
    cancelInlineModes()
    rebase.enter(revs)
  }

  async function executeRebase() {
    if (!selectedRevision || rebase.sources.length === 0) return
    const destination = effectiveId(selectedRevision.commit)
    if (rebase.sources.includes(destination)) {
      lastAction = 'Cannot rebase onto source revision'
      return
    }
    // Capture mode state before cancelling
    const { sources, sourceMode, targetMode } = rebase
    const modeLabel = targetModeLabel[targetMode]
    rebase.cancel()
    try {
      const result = await api.rebase(sources, destination, sourceMode, targetMode)
      lastAction = sources.length > 1
        ? `Rebased ${sources.length} revisions ${modeLabel} ${destination.slice(0, 8)}`
        : `Rebased ${sources[0].slice(0, 8)} ${modeLabel} ${destination.slice(0, 8)}`
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
    cancelInlineModes()
    // Initialize with all current changed files (source's files) and snapshot the count
    for (const f of changedFiles) squashSelectedFiles.add(f.path)
    squashTotalFiles = changedFiles.length
    squash.enter(revs)
    // Move cursor to parent of first source (default squash target)
    const sourceIdx = revisions.findIndex(r => effectiveId(r.commit) === revs[0])
    if (sourceIdx >= 0 && sourceIdx < revisions.length - 1) {
      selectRevisionCursorOnly(sourceIdx + 1)
    }
  }

  async function executeSquash() {
    if (!selectedRevision || squash.sources.length === 0) return
    const destination = effectiveId(selectedRevision.commit)
    // C2: exit mode before guard so user isn't stuck
    if (squash.sources.includes(destination)) {
      squash.cancel()
      squashSelectedFiles.clear()
      lastAction = 'Cannot squash into source revision'
      return
    }
    // C1: block execution when no files selected (empty array would squash ALL files).
    // Exception: empty commits have 0 total files — squash is still valid (moves metadata).
    if (squashSelectedFiles.size === 0 && squashTotalFiles > 0) {
      lastAction = 'Select at least one file to squash'
      return
    }
    try {
      // W3: compare against snapshotted total, not live changedFiles
      const files = squashSelectedFiles.size < squashTotalFiles
        ? [...squashSelectedFiles]
        : undefined
      const { sources, keepEmptied, useDestMsg } = squash
      const result = await api.squash(sources, destination, {
        files,
        keepEmptied: keepEmptied || undefined,
        useDestinationMessage: useDestMsg || undefined,
      })
      // W1: only exit mode after successful API call
      squash.cancel()
      squashSelectedFiles.clear()
      lastAction = sources.length > 1
        ? `Squashed ${sources.length} revisions into ${destination.slice(0, 8)}`
        : `Squashed ${sources[0].slice(0, 8)} into ${destination.slice(0, 8)}`
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
    cancelInlineModes()
    for (const f of changedFiles) squashSelectedFiles.add(f.path)
    squashTotalFiles = changedFiles.length
    split.enter(effectiveId(selectedRevision.commit))
  }

  async function executeSplit() {
    if (!split.revision) return
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
      const revision = split.revision
      const result = await api.split(revision, files, split.parallel || undefined)
      split.cancel()
      squashSelectedFiles.clear()
      lastAction = `Split ${revision.slice(0, 8)} (${files.length} files stay)`
      commandOutput = result.output
      clearChecks()
      await loadLog()
    } catch (e) {
      // Keep split mode active so user can retry or Escape
      showError(e)
    }
  }

  let squashFileCount = $derived.by(() => {
    if (!squash.active || squashTotalFiles === 0) return null
    return { selected: squashSelectedFiles.size, total: squashTotalFiles }
  })

  let splitFileCount = $derived.by(() => {
    if (!split.active || squashTotalFiles === 0) return null
    return { selected: squashSelectedFiles.size, total: squashTotalFiles }
  })

  function closeModals() {
    paletteOpen = false
    bookmarkModalOpen = false
    bookmarkInputOpen = false
    gitModalOpen = false
    contextMenuOpen = false
  }

  function cancelInlineModes() {
    rebase.cancel()
    squash.cancel()
    split.cancel()
    divergence.cancel()
    squashSelectedFiles.clear()
    squashTotalFiles = 0
  }

  function closeAllModals() {
    closeModals()
    cancelInlineModes()
  }

  function openBookmarkModal(filter?: string) {
    closeAllModals()
    bookmarkModalFilter = filter ?? ''
    bookmarkModalOpen = true
  }

  async function toggleOplog() {
    oplogOpen = !oplogOpen
    if (oplogOpen) {
      await loadOplog()
    }
  }

  async function loadOplog() {
    const gen = ++oplogGeneration
    oplogLoading = true
    try {
      const result = await api.oplog(50)
      if (gen !== oplogGeneration) return
      oplogEntries = result
    } catch (e) {
      if (gen !== oplogGeneration) return
      showError(e)
    } finally {
      if (gen === oplogGeneration) oplogLoading = false
    }
  }

  async function toggleEvolog() {
    evologOpen = !evologOpen
    if (evologOpen && selectedRevision) {
      await loadEvolog(effectiveId(selectedRevision.commit))
    }
  }

  async function loadEvolog(changeId: string) {
    const gen = ++evologGeneration
    evologLoading = true
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
    if (fullDescription) {
      descriptionDraft = fullDescription
    } else {
      try {
        const result = await api.description(effectiveId(selectedRevision.commit))
        descriptionDraft = result.description
      } catch {
        descriptionDraft = selectedRevision.description
        lastAction = 'Using cached description (could not fetch latest)'
      }
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

    // Cmd+F / Ctrl+F opens diff search
    if (e.key === 'f' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault()
      diffPanelRef?.openSearch()
      return
    }

    // Inline mode Enter/Escape must fire even when a checkbox has focus
    // (clicking file checkboxes in split/squash steals focus to the <input>)
    if (inlineMode && (e.key === 'Enter' || e.key === 'Escape')) {
      e.preventDefault()
      if (e.key === 'Enter') {
        if (split.active) executeSplit()
        else if (squash.active) executeSquash()
        else if (rebase.active) executeRebase()
      } else {
        cancelInlineModes()
      }
      return
    }

    if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA') return

    // Skip all shortcuts when any modal is open (modals handle their own keys)
    if (anyModalOpen) return

    // Split mode: no j/k (operates on fixed revision), p toggles parallel
    if (split.active) {
      if (split.handleKey(e.key)) { e.preventDefault(); return }
      return
    }

    // Squash mode: j/k navigate (cursor only, keep source diff), e/d toggles
    if (squash.active) {
      if (e.key === 'j' && selectedIndex < revisions.length - 1) { e.preventDefault(); selectRevisionCursorOnly(selectedIndex + 1); return }
      if (e.key === 'k' && selectedIndex > 0) { e.preventDefault(); selectRevisionCursorOnly(selectedIndex - 1); return }
      if (squash.handleKey(e.key)) { e.preventDefault(); return }
      return
    }

    // Rebase mode: j/k navigate, source/target mode keys
    if (rebase.active) {
      if (e.key === 'j' && selectedIndex < revisions.length - 1) { e.preventDefault(); selectRevision(selectedIndex + 1); return }
      if (e.key === 'k' && selectedIndex > 0) { e.preventDefault(); selectRevision(selectedIndex - 1); return }
      if (rebase.handleKey(e.key)) { e.preventDefault(); return }
      return
    }

    // Escape: description editor, checked revisions, errors (inline modes handled above)
    if (e.key === 'Escape') {
      if (descriptionEditing) {
        descriptionEditing = false
        commitMode = false
      } else if (checkedRevisions.size > 0) {
        clearChecksAndReload()
      } else if (error) {
        dismissError()
      }
      return
    }

    // Global shortcuts — inline modes already returned above
    switch (e.key) {
      case 't':
        e.preventDefault()
        toggleTheme()
        return
      case 'u':
        e.preventDefault()
        handleUndo()
        return
      case 'c':
        e.preventDefault()
        handleCommit()
        return
      case 'f':
        e.preventDefault()
        handleGitOp('fetch', [])
        return
      case 'p':
        e.preventDefault()
        handleGitOp('push', [])
        return
      case 'g':
        e.preventDefault()
        closeAllModals()
        gitModalOpen = true
        return
      case 'w':
        e.preventDefault()
        sidebarRef?.toggleWorkspaceDropdown()
        return
      case '1':
        e.preventDefault()
        activeView = 'log'
        return
      case '2':
        e.preventDefault()
        activeView = 'branches'
        return
      case '3':
        e.preventDefault()
        activeView = 'operations'
        loadOplog()
        return
    }

    // Log-view-only shortcuts
    if (activeView !== 'log') return

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
          toggleCheck(effectiveId(selectedRevision.commit), selectedIndex)
        }
        break
      case 'Enter':
        if (selectedRevision) {
          e.preventDefault()
          loadDiffAndFiles(effectiveId(selectedRevision.commit))
        }
        break
      case 'r':
        e.preventDefault()
        loadLog()
        break
      case 'e':
        if (selectedRevision && checkedRevisions.size <= 1) {
          e.preventDefault()
          startDescriptionEdit()
        }
        break
      case 'n':
        e.preventDefault()
        if (checkedRevisions.size > 0) {
          handleNewFromChecked()
        } else if (selectedRevision) {
          handleNew(effectiveId(selectedRevision.commit))
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
          closeAllModals()
          bookmarkInputOpen = true
        }
        break
      case '/':
        e.preventDefault()
        revisionGraphRef?.focusRevsetInput()
        break
    }
  }

  // Auto-refresh when jj state changes outside the UI (detected via op-id header).
  // Skip if a loadLog is already in progress (mutation handlers call loadLog explicitly).
  $effect(() => {
    return onStale(() => {
      if (!loading && !anyModalOpen && !inlineMode) loadLog()
    })
  })

  loadLog()
  loadWorkspaces()
  loadAliases()
  loadPullRequests()
</script>

<svelte:window onkeydown={handleKeydown} />

<div class="app">
  <Sidebar
    bind:this={sidebarRef}
    {activeView}
    onnavigate={(view) => {
      if (inlineMode) return
      activeView = view
      if (view === 'operations') loadOplog()
    }}
    onopenpalette={() => { closeModals(); paletteOpen = true }}
    onthemetoggle={toggleTheme}
    theme={darkMode ? 'dark' : 'light'}
    {inlineMode}
    onundo={() => { if (!inlineMode) handleUndo() }}
    oncommit={() => { if (!inlineMode) handleCommit() }}
    onfetch={() => { if (!inlineMode) handleGitOp('fetch', []) }}
    onpush={() => { if (!inlineMode) handleGitOp('push', []) }}
    ongitmodal={() => { if (!inlineMode) { closeAllModals(); gitModalOpen = true } }}
    {currentWorkspace}
    workspaces={workspaceList}
    onworkspaceopen={handleWorkspaceOpen}
  />

  <div class="main-content">
    {#if error}
      <div class="error-bar" role="alert">
        <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
          <path d="M8 1a7 7 0 1 0 0 14A7 7 0 0 0 8 1zm0 10.5a.75.75 0 1 1 0-1.5.75.75 0 0 1 0 1.5zM8.75 4.5v4a.75.75 0 0 1-1.5 0v-4a.75.75 0 0 1 1.5 0z"/>
        </svg>
        <span class="error-text">{error}</span>
        <button class="error-dismiss" onclick={dismissError}>Dismiss</button>
      </div>
    {/if}

    {#if activeView === 'log'}
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
          oncontextmenu={openRevisionContextMenu}
          onnewfromchecked={handleNewFromChecked}
          onabandonchecked={handleAbandonChecked}
          onclearchecks={clearChecksAndReload}
          onrevsetsubmit={handleRevsetSubmit}
          onrevsetclear={clearRevsetFilter}
          onrevsetchange={(v) => { revsetFilter = v }}
          onrevsetescaped={clearRevsetFilter}
          onviewmodechange={toggleViewMode}
          onbookmarkclick={openBookmarkModal}
          {rebase}
          {squash}
          {split}
          isDark={darkMode}
          {prByBookmark}
        />

        {#if divergence.active}
          <DivergencePanel
            changeId={divergence.changeId}
            onkeep={handleKeepDivergent}
            onclose={() => divergence.cancel()}
          />
        {:else}
          <DiffPanel
            bind:this={diffPanelRef}
            {diffContent}
            {changedFiles}
            {selectedRevision}
            {fullDescription}
            {checkedRevisions}
            {diffLoading}
            {filesLoading}
            bind:splitView
            {descriptionEditing}
            {descriptionDraft}
            {describeSaved}
            {commitMode}
            onstartdescribe={startDescriptionEdit}
            ondescribe={commitMode ? executeCommit : handleDescribe}
            oncanceldescribe={() => { descriptionEditing = false; commitMode = false }}
            ondraftchange={(v) => { descriptionDraft = v }}
            onbookmarkclick={openBookmarkModal}
            fileSelectionMode={squash.active || split.active}
            {squashSelectedFiles}
            ontogglefile={toggleSquashFile}
            splitMode={split.active}
            onresolve={inlineMode ? undefined : handleResolve}
            divergentSelected={selectedRevision?.commit.divergent ?? false}
            onresolveDivergence={() => { if (selectedRevision) divergence.enter(selectedRevision.commit.change_id) }}
            {prByBookmark}
          />
        {/if}
      </div>

      {#if evologOpen}
        <EvologPanel
          content={evologContent}
          loading={evologLoading}
          {selectedRevision}
          onrefresh={() => { if (selectedRevision) loadEvolog(effectiveId(selectedRevision.commit)) }}
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
    {:else if activeView === 'branches'}
      <div class="empty-view">
        <span class="empty-view-icon">⑂</span>
        <span class="empty-view-title">Branches</span>
        <span class="empty-view-hint">Coming soon — use <kbd>b</kbd> for bookmark operations</span>
      </div>
    {:else if activeView === 'operations'}
      <div class="fullwidth-panel">
        <OplogPanel
          entries={oplogEntries}
          loading={oplogLoading}
          onrefresh={loadOplog}
          onclose={() => { activeView = 'log' }}
        />
      </div>
    {/if}

    <StatusBar
      {statusText}
      {commandOutput}
      {rebase}
      {squash}
      {squashFileCount}
      {split}
      {splitFileCount}
      {activeView}
    />
  </div>

  <CommandPalette bind:open={paletteOpen} {commands} />

  <ContextMenu
    items={contextMenuItems}
    x={contextMenuX}
    y={contextMenuY}
    bind:open={contextMenuOpen}
  />

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
</div>

<style>
  /* --- Layout --- */
  .app {
    display: flex;
    height: 100vh;
    overflow: hidden;
  }

  .main-content {
    display: flex;
    flex-direction: column;
    flex: 1;
    overflow: hidden;
    min-width: 0;
  }

  .workspace {
    display: flex;
    flex: 1;
    overflow: hidden;
  }

  .fullwidth-panel {
    flex: 1;
    overflow: hidden;
    display: flex;
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
    animation: slide-down var(--anim-duration) var(--anim-ease);
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

  .empty-view {
    flex: 1;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 8px;
    color: var(--surface2);
  }

  .empty-view-icon {
    font-size: 32px;
    opacity: 0.4;
  }

  .empty-view-title {
    font-size: 14px;
    font-weight: 600;
    color: var(--subtext0);
  }

  .empty-view-hint {
    font-size: 12px;
  }

  .empty-view-hint kbd {
    background: var(--surface0);
    padding: 1px 4px;
    border-radius: 3px;
    font-family: inherit;
    font-size: 11px;
    border: 1px solid var(--surface1);
    color: var(--subtext0);
  }
</style>
