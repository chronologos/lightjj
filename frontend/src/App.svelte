<script lang="ts">
  import { SvelteSet } from 'svelte/reactivity'
  import { api, effectiveId, multiRevset, computeConnectedCommitIds, getCached, diffTargetKey, prefetchRevision, prefetchFilesBatch, onStale, wireAutoRefresh, clearAllCaches, type LogEntry, type FileChange, type OpEntry, type EvologEntry, type Workspace, type Alias, type PullRequest, type DiffTarget } from './lib/api'
  import type { PaletteCommand } from './lib/CommandPalette.svelte'
  import StatusBar from './lib/StatusBar.svelte'
  import CommandPalette from './lib/CommandPalette.svelte'
  import RevisionGraph from './lib/RevisionGraph.svelte'
  import DiffPanel, { clearHighlightCache } from './lib/DiffPanel.svelte'
  import RevisionHeader from './lib/RevisionHeader.svelte'
  import EvologPanel from './lib/EvologPanel.svelte'
  import OplogPanel from './lib/OplogPanel.svelte'
  import BookmarkModal, { type BookmarkOp } from './lib/BookmarkModal.svelte'
  import BookmarkInput from './lib/BookmarkInput.svelte'
  import GitModal from './lib/GitModal.svelte'
  import ContextMenu, { type ContextMenuItem } from './lib/ContextMenu.svelte'
  import DivergencePanel, { type KeepPlan } from './lib/DivergencePanel.svelte'
  import { createRebaseMode, createSquashMode, createSplitMode, createDivergenceMode, targetModeLabel } from './lib/modes.svelte'
  import { createLoader } from './lib/loader.svelte'
  import { config } from './lib/config.svelte'
  import { APP_VERSION, parseSemver, semverMinorGt } from './lib/version'
  import { FEATURES, type TutorialFeature } from './lib/tutorial-content'
  import WelcomeModal from './lib/WelcomeModal.svelte'

  // --- Global state ---
  let selectedIndex: number = $state(-1)
  let error: string = $state('')
  let lastAction: string = $state('')
  let descriptionEditing: boolean = $state(false)
  let descriptionDraft: string = $state('')
  let commitMode: boolean = $state(false) // when true, description editor saves via commit instead of describe
  let commandOutput: string = $state('')
  let revsetFilter: string = $state('')
  let viewMode: 'log' | 'tracked' = $state('log')
  const TRACKED_REVSET = 'ancestors(@ | mutable() & mine() | trunk()..tracked_remote_bookmarks(), 2) | trunk()'
  let describeSaved: boolean = $state(false)
  let checkedRevisions = new SvelteSet<string>()
  let lastCheckedIndex: number = $state(-1)
  let navDebounceTimer: number | undefined
  let evologDebounceTimer: number | undefined
  let evologOpen: boolean = $state(false)
  let oplogOpen: boolean = $state(false)
  let welcomeOpen: boolean = $state(false)
  let welcomeFeatures: TutorialFeature[] = $state([])
  let welcomeTitle: string = $state('')

  // --- Error helpers (defined early — loaders need showError) ---
  function showError(e: unknown) {
    error = e instanceof Error ? e.message : String(e)
  }
  function dismissError() {
    error = ''
  }

  // --- Data loaders ---
  // Each loader owns its value, loading flag, and race-condition-safe generation
  // counter. See loader.svelte.ts for semantics. Aliases below preserve existing
  // names for backward-compatible reads throughout the component + templates.
  const log = createLoader((revset?: string) => api.log(revset), [] as LogEntry[], showError)
  // diff carries its DiffTarget — identity and content are one $state write,
  // structurally in phase. loadedTarget (what's displayed) is derived from here,
  // not from selectedRevision (the cursor). This closes the "activeRevisionId
  // changes 50ms before diffContent" edge that every timing bug traces to.
  type LoadedDiff = { target: DiffTarget | undefined; diff: string }
  const diff = createLoader(
    (t: DiffTarget) => api.diff(diffTargetKey(t)).then(r => ({ target: t, diff: r.diff })),
    { target: undefined, diff: '' } as LoadedDiff,
    showError,
  )
  const files = createLoader((id: string) => api.files(id), [] as FileChange[], showError)
  const description = createLoader((id: string) => api.description(id).then(r => r.description), '')
  const oplog = createLoader(() => api.oplog(50), [] as OpEntry[])
  const evolog = createLoader((id: string) => api.evolog(id), [] as EvologEntry[], showError)

  let revisions = $derived(log.value)
  let loading = $derived(log.loading)
  let diffContent = $derived(diff.value.diff)
  let diffLoading = $derived(diff.loading)
  // What's LOADED, not what's selected. Passed to DiffPanel as diffTarget.
  // Lags the cursor during cache-miss fetches — that's the point.
  let loadedTarget = $derived(diff.value.target)
  let changedFiles = $derived(files.value)
  let fullDescription = $derived(description.value)
  let oplogEntries = $derived(oplog.value)
  let oplogLoading = $derived(oplog.loading)
  let evologEntries = $derived(evolog.value)
  let evologLoading = $derived(evolog.loading)

  // --- Draggable dividers (revision panel width + evolog panel height) ---
  // Shared helper handles the listener-cleanup boilerplate; callers supply only
  // the cursor style and the per-move resize math.
  function startDrag(e: MouseEvent, cursor: string, setDragging: (v: boolean) => void, onMove: (e: MouseEvent) => void) {
    e.preventDefault()
    setDragging(true)
    document.body.style.userSelect = 'none'
    document.body.style.cursor = cursor
    function onMouseUp() {
      setDragging(false)
      document.body.style.userSelect = ''
      document.body.style.cursor = ''
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onMouseUp)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onMouseUp)
  }

  let draggingDivider = $state(false)
  function startDividerDrag(e: MouseEvent) {
    startDrag(e, 'col-resize', v => draggingDivider = v, e => {
      config.revisionPanelWidth = Math.max(280, Math.min(600, e.clientX))
    })
  }

  let draggingEvologDivider = $state(false)
  function startEvologDividerDrag(e: MouseEvent) {
    startDrag(e, 'row-resize', v => draggingEvologDivider = v, e => {
      // Height is distance from viewport bottom (dragging up = taller).
      // StatusBar offset is intentionally ignored — matches the X-axis divider
      // which uses raw clientX assuming panel edge is at viewport left.
      const maxH = Math.floor(window.innerHeight * 0.7)
      config.evologPanelHeight = Math.max(120, Math.min(maxH, window.innerHeight - e.clientY))
    })
  }

  let paletteOpen: boolean = $state(false)
  let bookmarkModalOpen: boolean = $state(false)
  let bookmarkModalFilter: string = $state('')
  let bookmarkInputOpen: boolean = $state(false)
  let gitModalOpen: boolean = $state(false)
  const rebase = createRebaseMode()
  const squash = createSquashMode()
  const split = createSplitMode()
  const divergence = createDivergenceMode()
  let selectedFiles = new SvelteSet<string>()
  let totalFileCount: number = $state(0) // snapshot of file count at entry time

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

  let anyModalOpen = $derived(paletteOpen || bookmarkModalOpen || bookmarkInputOpen || gitModalOpen || contextMenuOpen || divergence.active || welcomeOpen)
  let inlineMode = $derived(rebase.active || squash.active || split.active)
  let conflictCount = $derived(changedFiles.filter(f => f.conflict).length)

  // Mutation lock — prevents queuing ops against stale/changing state.
  // Covers the full span from mutation start through post-mutation loadLog().
  // Over SSH each call is ~440ms, so without this a double-click on Abandon
  // could fire two abandon requests against the same (now-stale) revision.
  let mutating = $state(false)

  async function withMutation<T>(fn: () => Promise<T>): Promise<T | undefined> {
    if (mutating) return
    mutating = true
    try { return await fn() }
    finally { mutating = false }
  }

  // --- Theme ---
  let darkMode = $derived(config.theme === 'dark')
  const cmdKey = typeof navigator !== 'undefined' && navigator.platform.includes('Mac') ? '⌘' : 'Ctrl+'

  function toggleTheme() {
    config.theme = darkMode ? 'light' : 'dark'
    // Module-scoped cache outlives the component — clear it even if DiffPanel
    // is unmounted (DivergencePanel showing). rehighlight() re-renders if mounted.
    clearHighlightCache()
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
  let wsDropdownOpen: boolean = $state(false)
  let wsSelectorEl: HTMLElement | undefined = $state(undefined)

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

  // checkedRevisions holds effectiveId (change_id for most); resolve once to
  // commit_ids for both multi-check diff loading AND implied-commit graph walk.
  let checkedCommitIds = $derived(
    checkedRevisions.size === 0 ? [] :
    revisions.filter(r => checkedRevisions.has(effectiveId(r.commit)))
             .map(r => r.commit.commit_id)
  )

  // Commits implicitly included in the diff via connected() gap-filling.
  // Rendered with a hollow indicator so user sees what's in scope.
  let impliedCommitIds = $derived.by(() => {
    if (checkedCommitIds.length <= 1) return new Set<string>()
    const checkedSet = new Set(checkedCommitIds)
    const connected = computeConnectedCommitIds(checkedSet, revisions)
    // Implied = in connected but NOT explicitly checked
    const implied = new Set<string>()
    for (const cid of connected) if (!checkedSet.has(cid)) implied.add(cid)
    return implied
  })

  // Scoped so it only re-scans when revisions changes, not on every loading/mutating flip.
  let workingCopyEntry = $derived(revisions.find(r => r.commit.is_working_copy))

  // Live progress line from streamMutation (git push/fetch). Takes precedence
  // over the generic "Working..." while a stream is feeding it.
  let mutationProgress: string = $state('')

  let statusText = $derived.by(() => {
    if (inlineMode) return ''
    if (mutating) return mutationProgress || 'Working...'
    if (loading) return revisions.length > 0 ? 'Refreshing...' : 'Loading revisions...'
    if (diffLoading) return 'Loading diff...'
    if (lastAction) return lastAction
    const count = revisions.length
    const wc = workingCopyEntry
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
    if (selectedRevision) loadDiffAndFiles(selectedRevision.commit)
    else { diff.reset(); files.reset() }
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
  // Split into static (allocated once) + dynamic (rebuilt only when labels change).
  // Closures capture live refs, so `when:` / `action:` can safely read mutable state.
  // `staticCommands` is $derived.by with zero reactive deps — the thunk defers
  // evaluation past TDZ for handlers defined below, and computes exactly once.
  // NB: keep all reactive reads inside closures (when:/action:) — a direct read
  // in label/shortcut would silently make this re-compute on every state change.
  const noop = () => {}
  let staticCommands = $derived.by<PaletteCommand[]>(() => [
    // Navigation
    { label: 'Move down', shortcut: 'j', category: 'Navigation', action: noop, infoOnly: true },
    { label: 'Move up', shortcut: 'k', category: 'Navigation', action: noop, infoOnly: true },
    { label: 'Toggle check', shortcut: 'Space', category: 'Navigation', action: noop, infoOnly: true },
    { label: 'Load diff', shortcut: 'Enter', category: 'Navigation', action: noop, infoOnly: true },
    { label: 'Focus revset filter', shortcut: '/', category: 'Navigation', action: () => revisionGraphRef?.focusRevsetInput() },
    { label: 'Clear revset filter', category: 'Navigation', action: clearRevsetFilter, when: () => revsetFilter !== '' },

    // Revisions
    { label: 'Refresh revisions', shortcut: 'r', category: 'Revisions', action: loadLog, when: () => !inlineMode },
    { label: 'Hard refresh (clear all caches)', category: 'Revisions', action: () => { clearAllCaches(); loadLog(true) }, when: () => !inlineMode },
    { label: 'New revision', shortcut: 'n', category: 'Revisions', action: () => {
      if (checkedRevisions.size > 0) handleNewFromChecked()
      else if (selectedRevision) handleNew(effectiveId(selectedRevision.commit))
    }, when: () => !inlineMode && (!!selectedRevision || checkedRevisions.size > 0) },
    { label: 'Edit description', shortcut: 'e', category: 'Revisions', action: startDescriptionEdit, when: () => !inlineMode && !!selectedRevision && checkedRevisions.size === 0 },
    { label: 'Edit selected revision', category: 'Revisions', action: () => handleEdit(effectiveId(selectedRevision!.commit)), when: () => !inlineMode && !!selectedRevision },
    { label: 'Abandon selected revision', category: 'Revisions', action: () => handleAbandon(effectiveId(selectedRevision!.commit)), when: () => !inlineMode && !!selectedRevision && checkedRevisions.size === 0 },
    { label: 'Rebase revision(s)', shortcut: 'R', category: 'Revisions', action: enterRebaseMode, when: () => !inlineMode && (!!selectedRevision || checkedRevisions.size > 0) },
    { label: 'Squash revision(s)', shortcut: 'S', category: 'Revisions', action: enterSquashMode, when: () => !inlineMode && (!!selectedRevision || checkedRevisions.size > 0) },
    { label: 'Split revision', shortcut: 's', category: 'Revisions', action: enterSplitMode, when: () => !inlineMode && !!selectedRevision && checkedRevisions.size === 0 },
    { label: 'Review revision (accept/reject files)', shortcut: 'v', category: 'Revisions', action: enterReviewMode, when: () => !inlineMode && !!selectedRevision && checkedRevisions.size === 0 },
    { label: 'Commit working copy', shortcut: 'c', category: 'Revisions', action: handleCommit, when: () => !inlineMode },

    // Git
    { label: 'Git fetch', shortcut: 'f', category: 'Git', action: () => handleGitOp('fetch', []), when: () => !inlineMode },
    { label: 'Git push', shortcut: 'p', category: 'Git', action: () => handleGitOp('push', []), when: () => !inlineMode },
    { label: 'Git operations (advanced)', shortcut: 'g', category: 'Git', action: () => { closeAllModals(); gitModalOpen = true }, when: () => !inlineMode },

    // Bookmarks
    { label: 'Bookmark operations', shortcut: 'b', category: 'Bookmarks', action: openBookmarkModal, when: () => !inlineMode },
    { label: 'Set bookmark', shortcut: 'B', category: 'Bookmarks', action: () => { closeAllModals(); bookmarkInputOpen = true }, when: () => !inlineMode && !!selectedRevision && checkedRevisions.size === 0 },

    // View (non-dynamic)
    { label: 'Toggle split/unified diff', category: 'View', action: () => { config.splitView = !config.splitView } },
    { label: 'Toggle operation log', category: 'View', action: toggleOplog },
    { label: 'Toggle evolution log', category: 'View', action: toggleEvolog, when: () => !!selectedRevision },
    { label: 'Show welcome / keyboard shortcuts', category: 'View', action: () => { welcomeTitle = `Welcome to lightjj v${APP_VERSION}`; welcomeFeatures = FEATURES; welcomeOpen = true } },

    // Actions
    { label: 'Undo last operation', shortcut: 'u', category: 'Actions', action: handleUndo, when: () => !inlineMode },
    { label: 'Clear checked revisions', shortcut: 'Esc', category: 'Actions', action: clearChecksAndReload, when: () => checkedRevisions.size > 0 },
    { label: 'Command palette', shortcut: '\u2318K', category: 'Actions', action: noop, infoOnly: true },

    // Annotations (agent review)
    { label: 'Export annotations (markdown → clipboard)', category: 'Annotations',
      action: () => {
        const md = diffPanelRef?.exportAnnotationsMarkdown() ?? ''
        navigator.clipboard.writeText(md)
        lastAction = md ? 'Annotations copied' : 'No annotations to export'
      },
      when: () => !inlineMode && !!diffPanelRef?.hasAnnotations(),
    },
    { label: 'Export annotations (JSON → clipboard)', category: 'Annotations',
      action: () => {
        const json = diffPanelRef?.exportAnnotationsJSON() ?? ''
        navigator.clipboard.writeText(json)
        lastAction = json ? 'Annotations JSON copied' : 'No annotations to export'
      },
      when: () => !inlineMode && !!diffPanelRef?.hasAnnotations(),
    },
  ])

  // Labels that bake reactive state into strings — only these re-allocate on Space/theme/view toggle.
  let dynamicCommands = $derived<PaletteCommand[]>([
    { label: `Abandon ${checkedRevisions.size} checked`, category: 'Revisions', action: handleAbandonChecked, when: () => !inlineMode && checkedRevisions.size > 0 },
    { label: `New from ${checkedRevisions.size} checked`, category: 'Revisions', action: handleNewFromChecked, when: () => !inlineMode && checkedRevisions.size > 0 },
    { label: darkMode ? 'Light theme' : 'Dark theme', shortcut: 't', category: 'View', action: toggleTheme },
    { label: config.reduceMotion ? 'Enable animations' : 'Reduce motion', category: 'View', action: () => { config.reduceMotion = !config.reduceMotion } },
    { label: viewMode === 'log' ? 'Switch to tracked view' : 'Switch to log view', category: 'View', action: toggleViewMode },
  ])

  let aliasCommands = $derived<PaletteCommand[]>(
    aliases
      .filter(a => !isBuiltinAlias(a))
      .map(a => ({
        label: a.name,
        hint: a.command.join(' '),
        category: 'Aliases',
        action: () => handleRunAlias(a.name),
        when: () => !inlineMode,
      })),
  )

  // Category grouping in the palette's cheatsheet view is handled by Map.groupBy
  // (CommandPalette.svelte), so spread order here doesn't affect visual grouping.
  let commands = $derived<PaletteCommand[]>([...staticCommands, ...dynamicCommands, ...aliasCommands])

  // --- API actions ---
  async function loadInfo() {
    try {
      const { hostname, repo_path } = await api.info()
      document.title = formatTitle(hostname, repo_path)
    } catch { /* static <title> fallback is fine */ }
  }

  // Visually distinct, platform-stable glyphs. No flags/people/hands (vary
  // wildly across OS/font), no skin-tone modifiers. Contiguous string iterates
  // by codepoint via spread — simpler than an array literal.
  const HOST_EMOJI = [...'🦊🐸🐙🦉🐢🦀🐝🦋🐌🦔🌵🍄🌻🍋🍉🍇🥝🥥🔥💧⚡🌈🪐⭐🎲🧩🔑🧲']

  function hostEmoji(host: string): string {
    // djb2 — we just need a stable spread, not crypto.
    let h = 5381
    for (let i = 0; i < host.length; i++) h = ((h << 5) + h + host.charCodeAt(i)) | 0
    return HOST_EMOJI[Math.abs(h) % HOST_EMOJI.length]
  }

  function formatTitle(host: string, path: string): string {
    const MAX = 10

    // Path: single-letter per component except last, then drop leading letters
    // until ≤MAX. /Users/iant/3pcode/lightjj → /U/i/3/lightjj → …/lightjj
    const parts = path.split(/[/\\]/)
    const last = parts.pop() || path
    const letters = parts.map(p => p.slice(0, 1))
    let shortPath = letters.join('/') + '/' + last
    while (shortPath.length > MAX && letters.length) {
      letters.shift()
      shortPath = '…' + letters.join('/') + '/' + last
    }

    if (!host) return `${last} — lightjj`
    return `${hostEmoji(host)} ${shortPath} — lightjj`
  }

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
    error = ''
    const revset = revsetFilter || (viewMode === 'tracked' ? TRACKED_REVSET : undefined)
    const ok = await log.load(revset)
    blurActiveInput()
    if (!ok) return // superseded or errored — don't post-process stale state

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
      const sel = revisions[selectedIndex]
      loadDiffAndFiles(sel.commit)
    }
    // Refresh open panels — oplog always reflects new operations,
    // evolog may change if the selected revision was modified
    if (oplogOpen || activeView === 'operations') oplog.load()
    if (evologOpen && selectedIndex >= 0 && revisions[selectedIndex]) {
      evolog.load(effectiveId(revisions[selectedIndex].commit))
    }

    // Pre-load file lists for a window of ~10 revisions around the selection.
    // One jj subprocess for N revs; seeds files:X cache so the file sidebar
    // shows instantly during j/k. Fire-and-forget; main diff load isn't gated.
    prefetchFilesWindow()
  }

  const FILES_PRELOAD_RADIUS = 5 // revisions on each side of selectedIndex
  function prefetchFilesWindow() {
    if (selectedIndex < 0) return
    const start = Math.max(0, selectedIndex - FILES_PRELOAD_RADIUS)
    const end = Math.min(revisions.length, selectedIndex + FILES_PRELOAD_RADIUS + 1)
    const ids = revisions.slice(start, end).map(r => r.commit.commit_id)
    prefetchFilesBatch(ids)
  }

  // Thin aliases — preserve existing call-site names across the component.
  const loadFilesForRevset = files.load
  const loadOplog = oplog.load
  const loadEvolog = evolog.load

  // Batch-fetch orchestration: api.revision() seeds all three cache keys in
  // one round-trip, then the individual loaders fire and hit cache.
  //
  // Race safety: diff.load(target) bumps loader.generation, so a prior
  // loadDiffAndFiles suspended at `await api.revision()` will have its
  // diff.load() discarded when it resumes and fires (its gen check fails).
  // But the await-before-load gap still needs revGen — the suspended call's
  // diff.load() would bump generation PAST any intervening diff.set()/load().
  // checkedRevisions guard: user checked a revision during the fetch → the
  // multi-check effect already fired; don't clobber.
  //
  // On batch failure, only diff.load fires — one error toast, not three.
  let revGen = 0
  async function loadDiffAndFiles(commit: LogEntry['commit']) {
    const gen = ++revGen
    let batchFailed = false
    await api.revision(commit.commit_id).catch(() => { batchFailed = true })
    if (gen !== revGen || checkedRevisions.size > 0) return
    diff.load(singleTarget(commit))
    if (batchFailed) return
    files.load(commit.commit_id)
    description.load(commit.commit_id)
  }

  // Move cursor without loading diff/files — used in squash mode where
  // the diff is intentionally frozen on the source revision
  function selectRevisionCursorOnly(index: number) {
    selectedIndex = index
  }

  let prevSelectedIndex = -1

  function selectRevision(index: number) {
    const moved = index !== prevSelectedIndex
    const direction = index > prevSelectedIndex ? 1 : -1
    prevSelectedIndex = index
    selectedIndex = index
    descriptionEditing = false

    const entry = revisions[index]
    if (!entry) return

    // Cache hits: synchronously set loader values in the SAME tick as
    // selectedIndex. Svelte batches both into one render → selection highlight
    // and diff content update together, no stale-content flash. loader.set()
    // is synchronous, getCached() reads the Map directly.
    //
    // Cache misses: defer with 50ms debounce. Coalesces rapid uncached j/k
    // into one network request. The browser paints the selection highlight
    // before the setTimeout fires.
    clearTimeout(navDebounceTimer)
    const hit = checkedRevisions.size === 0 ? getCached(entry.commit.commit_id) : null
    if (hit) {
      // Invalidate any in-flight loadDiffAndFiles — a suspended call's
      // diff.load() would bump generation past this set() and win.
      revGen++
      // target + diff land in one $state write → DiffPanel sees them together.
      diff.set({ target: singleTarget(entry.commit), diff: hit.diff })
      files.set(hit.files)
      description.set(hit.description)
    } else {
      navDebounceTimer = setTimeout(() => {
        const current = revisions[selectedIndex]
        if (!current) return
        if (checkedRevisions.size === 0) loadDiffAndFiles(current.commit)
      }, 50)
    }
    // Evolog is uncached — always debounce to avoid one network request per
    // keypress during rapid j/k with the panel open.
    if (evologOpen) {
      clearTimeout(evologDebounceTimer)
      evologDebounceTimer = setTimeout(() => {
        const current = revisions[selectedIndex]
        if (current) loadEvolog(effectiveId(current.commit))
      }, 50)
    }

    // Opportunistic prefetch: warm the cache for the next revision in the
    // navigation direction. Only when CURRENT is cached — during rapid uncached
    // j/k, prefetches for skipped-past revisions waste bandwidth and contend
    // with the main load. With the batch endpoint (1 req/rev) the 6-connection
    // limit is no longer reachable, but the contention argument still holds.
    if (moved && hit) {
      const next = revisions[index + direction]
      if (next) prefetchRevision(next.commit.commit_id)
      // Also re-center the files preload window. prefetchFilesBatch filters
      // to uncached internally, so repeated calls are cheap — most will be
      // all-cached no-ops; at window edges it fires one HTTP call for the
      // newly-visible revisions.
      prefetchFilesWindow()
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

  function singleTarget(c: LogEntry['commit']): DiffTarget {
    return { kind: 'single', commitId: c.commit_id, changeId: effectiveId(c), isWorkingCopy: c.is_working_copy, immutable: c.immutable }
  }

  // INTENT — what the diff panel should be showing, derived from cursor + checks.
  // Moves ahead of loadedTarget during cache-miss fetches. Used only to DRIVE
  // loads, not to describe what's on screen (that's loadedTarget above).
  let intendedTarget = $derived<DiffTarget | undefined>(
    checkedCommitIds.length > 0
      ? { kind: 'multi', revset: multiRevset(checkedCommitIds), commitIds: checkedCommitIds }
    : selectedRevision
      ? singleTarget(selectedRevision.commit)
    : undefined
  )
  // Reload diff/files when checked revisions change.
  // Skip during squash/split mode — diff is intentionally frozen on source revision.
  $effect(() => {
    if (intendedTarget?.kind !== 'multi') return
    if (squash.active || split.active) return
    diff.load(intendedTarget)
    loadFilesForRevset(intendedTarget.revset)
  })

  async function runMutation(
    fn: () => Promise<{ output: string }>,
    successMsg: string,
    opts?: { before?: () => void, after?: () => void },
  ) {
    return withMutation(async () => {
      try {
        opts?.before?.()
        const result = await fn()
        lastAction = successMsg
        commandOutput = result.output
        opts?.after?.()
        await loadLog()
      } catch (e) { showError(e) }
    })
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
    return withMutation(async () => {
      try {
        const result = await api.describe(eid, descriptionDraft)
        lastAction = `Updated description for ${eid.slice(0, 8)}`
        commandOutput = result.output
        description.set(descriptionDraft)
        descriptionEditing = false
        describeSaved = true
        setTimeout(() => { describeSaved = false }, 1500)
        await loadLog()
      } catch (e) {
        showError(e)
      }
    })
  }

  async function handleCommit() {
    // Open description editor in commit mode — pre-fill with current WC description
    if (!selectedRevision) return
    commitMode = true
    if (fullDescription) {
      descriptionDraft = fullDescription
    } else {
      try {
        const result = await api.description(selectedRevision.commit.commit_id)
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
    return withMutation(async () => {
      try {
        const result = await api.commit(descriptionDraft)
        lastAction = 'Committed working copy'
        commandOutput = result.output
        descriptionEditing = false
        commitMode = false
        description.reset()
        await loadLog()
      } catch (e) {
        showError(e)
      }
    })
  }

  const handleGitOp = (type: 'push' | 'fetch', flags: string[]) => {
    // Stream progress to status bar. mutationProgress wins over "Working..."
    // in statusText; blank lines skipped so it doesn't flash empty. .finally()
    // clears it on both resolve and reject — runMutation's `after` only runs
    // on success, which would leak a stale line into the next (non-streaming)
    // mutation's status.
    const onLine = (line: string) => { if (line.trim()) mutationProgress = line.trim() }
    mutationProgress = `git ${type}…`
    return runMutation(
      () => (type === 'push' ? api.gitPush : api.gitFetch)(flags, onLine)
              .finally(() => { mutationProgress = '' }),
      `Git ${type} complete`,
      { after: () => loadPullRequests() },
    )
  }

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

  async function handleKeepDivergent(plan: KeepPlan) {
    return withMutation(async () => {
      try {
        // Plan is computed by DivergencePanel from the classify() group
        // structure: stack-aware abandon set (all levels of losing columns +
        // empty descendants), per-change_id bookmark repoints (not stack tip).
        // Non-empty descendants already went through the panel's confirm.
        await api.abandon(plan.abandonCommitIds)

        // Serial: concurrent jj mutations can produce divergent op history.
        // N is tiny (0-3) and this is a rare manual action.
        for (const { name, targetCommitId } of plan.bookmarkRepoints) {
          await api.bookmarkSet(targetCommitId, name)
        }

        divergence.cancel()
        lastAction = `Resolved divergence — kept ${plan.keeperCommitId.slice(0, 8)}` +
          (plan.abandonCommitIds.length > 1 ? ` (abandoned ${plan.abandonCommitIds.length})` : '')
        await loadLog()
      } catch (e: any) {
        // Don't close panel on error — let user see state and retry
        showError(e.message || 'Failed to resolve divergence')
        await loadLog()
      }
    })
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
    const { sources, sourceMode, targetMode, skipEmptied, ignoreImmutable } = rebase
    const modeLabel = targetModeLabel[targetMode]
    rebase.cancel()
    return withMutation(async () => {
      try {
        const result = await api.rebase(sources, destination, sourceMode, targetMode, {
          skipEmptied: skipEmptied || undefined,
          ignoreImmutable: ignoreImmutable || undefined,
        })
        lastAction = sources.length > 1
          ? `Rebased ${sources.length} revisions ${modeLabel} ${destination.slice(0, 8)}`
          : `Rebased ${sources[0].slice(0, 8)} ${modeLabel} ${destination.slice(0, 8)}`
        commandOutput = result.output
        clearChecks()
        await loadLog()
      } catch (e) {
        showError(e)
      }
    })
  }

  function enterSquashMode() {
    const revs = effectiveRevisions
    if (revs.length === 0) return
    cancelInlineModes()
    // Initialize with all current changed files (source's files) and snapshot the count
    for (const f of changedFiles) selectedFiles.add(f.path)
    totalFileCount = changedFiles.length
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
      cancelInlineModes()
      lastAction = 'Cannot squash into source revision'
      return
    }
    // C1: block execution when no files selected (empty array would squash ALL files).
    // Exception: empty commits have 0 total files — squash is still valid (moves metadata).
    if (selectedFiles.size === 0 && totalFileCount > 0) {
      lastAction = 'Select at least one file to squash'
      return
    }
    return withMutation(async () => {
      try {
        // W3: compare against snapshotted total, not live changedFiles
        const files = selectedFiles.size < totalFileCount
          ? [...selectedFiles]
          : undefined
        const { sources, keepEmptied, useDestMsg, ignoreImmutable } = squash
        const result = await api.squash(sources, destination, {
          files,
          keepEmptied: keepEmptied || undefined,
          useDestinationMessage: useDestMsg || undefined,
          ignoreImmutable: ignoreImmutable || undefined,
        })
        // W1: only exit mode after successful API call
        cancelInlineModes()
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
    })
  }

  function toggleFileSelection(path: string) {
    if (selectedFiles.has(path)) {
      selectedFiles.delete(path)
    } else {
      selectedFiles.add(path)
    }
  }

  function enterSplitMode(asReview = false) {
    if (!selectedRevision || checkedRevisions.size > 0) return
    cancelInlineModes()
    for (const f of changedFiles) selectedFiles.add(f.path)
    totalFileCount = changedFiles.length
    split.enter(effectiveId(selectedRevision.commit), asReview)
  }
  const enterReviewMode = () => enterSplitMode(true)

  async function executeSplit() {
    if (!split.revision) return
    const reviewing = split.review
    // Validate: at least one file must stay (checked) and one must move (unchecked)
    if (selectedFiles.size === totalFileCount) {
      error = reviewing ? 'Uncheck at least one file to reject' : 'Uncheck at least one file to split out'
      return
    }
    if (selectedFiles.size === 0) {
      error = reviewing ? 'Accept at least one file' : 'Select at least one file to keep'
      return
    }
    return withMutation(async () => {
      try {
        const files = [...selectedFiles]
        const revision = split.revision
        const result = await api.split(revision, files, split.parallel || undefined)
        cancelInlineModes()
        lastAction = reviewing
          ? `Reviewed ${revision.slice(0, 8)} (${files.length} accepted)`
          : `Split ${revision.slice(0, 8)} (${files.length} files stay)`
        commandOutput = result.output
        clearChecks()
        await loadLog()
      } catch (e) {
        // Keep split mode active so user can retry or Escape
        showError(e)
      }
    })
  }

  let squashFileCount = $derived.by(() => {
    if (!squash.active || totalFileCount === 0) return null
    return { selected: selectedFiles.size, total: totalFileCount }
  })

  let splitFileCount = $derived.by(() => {
    if (!split.active || totalFileCount === 0) return null
    return { selected: selectedFiles.size, total: totalFileCount }
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
    selectedFiles.clear()
    totalFileCount = 0
    // Restore focus to the revision list so j/k keys work immediately
    blurActiveInput()
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
    if (oplogOpen) await oplog.load()
  }

  async function toggleEvolog() {
    evologOpen = !evologOpen
    if (evologOpen && selectedRevision) {
      await evolog.load(effectiveId(selectedRevision.commit))
    }
  }

  async function startDescriptionEdit() {
    if (!selectedRevision) return
    if (fullDescription) {
      descriptionDraft = fullDescription
    } else {
      try {
        const result = await api.description(selectedRevision.commit.commit_id)
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
    diff.reset()
    files.reset()
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

    // Inline mode Enter/Escape must fire even when focusable elements in the
    // diff panel have focus (e.g. file selection items during split/squash).
    // But let CodeMirror and text inputs handle their own Enter/Escape.
    if (inlineMode && (e.key === 'Enter' || e.key === 'Escape')) {
      if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.closest('.cm-editor')) return
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

    if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.closest('.cm-editor')) return

    // Let unhandled Cmd/Ctrl combos (Cmd+C, Cmd+V, Cmd+A, Cmd+Z, etc.)
    // pass through to the browser. Only Cmd+K and Cmd+F are intercepted above.
    if (e.metaKey || e.ctrlKey) return

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
        if (workspaceList.length > 1) wsDropdownOpen = !wsDropdownOpen
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
          loadDiffAndFiles(selectedRevision.commit)
        }
        break
      case 'r':
        e.preventDefault()
        loadLog()
        break
      case 'e':
        if (selectedRevision && checkedRevisions.size === 0) {
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
      case 'v':
        if (selectedRevision && checkedRevisions.size === 0) {
          e.preventDefault()
          enterReviewMode()
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
  // Skip if a mutation is in flight — mutation handlers call loadLog explicitly,
  // and the stale callback fires as a microtask BEFORE res.json() resolves (i.e.
  // while we're still inside await fn() with mutating=true, loading=false).
  // Without !mutating, every mutation over SSH fires a redundant ~440ms loadLog.
  // If stale events occur during inline mode, refresh when mode exits.
  let staleWhileInMode = false
  $effect(() => {
    return onStale(() => {
      if (!loading && !mutating && !anyModalOpen && !inlineMode) loadLog()
      else if (inlineMode) staleWhileInMode = true
    })
  })
  // Auto-refresh sources: SSE push (fsnotify/inotifywait) + tab-focus snapshot.
  // Both route through notifyOpId → onStale so the guards above apply. The
  // body reads no reactive state → runs once on mount, cleanup on unmount.
  $effect(() => wireAutoRefresh())
  $effect(() => {
    if (!inlineMode && staleWhileInMode) {
      staleWhileInMode = false
      loadLog()
    }
  })

  loadLog()
  loadInfo()
  loadWorkspaces()
  loadAliases()
  loadPullRequests()

  // --- Tutorial / What's New ---
  // Must await config.ready so we read the disk-persisted tutorialVersion, not
  // the localStorage default (which is empty on a fresh origin/port).
  config.ready.then(() => {
    const currentSemver = parseSemver(APP_VERSION)
    const storedVersion = config.tutorialVersion
    const storedSemver = parseSemver(storedVersion)

    if (!storedVersion) {
      welcomeTitle = `Welcome to lightjj v${APP_VERSION}`
      welcomeFeatures = FEATURES
      welcomeOpen = true
    } else if (currentSemver && storedSemver && semverMinorGt(currentSemver, storedSemver)) {
      const newFeatures = FEATURES.filter(f => {
        const fv = parseSemver(f.version)
        return fv && semverMinorGt(fv, storedSemver)
      })
      if (newFeatures.length > 0) {
        welcomeTitle = `What's New in lightjj v${APP_VERSION}`
        welcomeFeatures = newFeatures
        welcomeOpen = true
      } else {
        config.tutorialVersion = APP_VERSION
      }
    } else if (storedVersion !== APP_VERSION) {
      config.tutorialVersion = APP_VERSION
    }
  })

  function dismissWelcome() {
    welcomeOpen = false
    config.tutorialVersion = APP_VERSION
  }
</script>

<svelte:window onkeydown={handleKeydown} onclick={(e: MouseEvent) => {
  if (wsDropdownOpen && wsSelectorEl && !wsSelectorEl.contains(e.target as Node)) wsDropdownOpen = false
}} />

<div class="app">
  <div class="main-content">
    <!-- Top toolbar: replaces sidebar -->
    <div class="toolbar">
      <div class="toolbar-left">
        <span class="toolbar-logo">
          <img
            src={darkMode ? '/logo.svg' : '/logo-light.svg'}
            alt=""
            width="16"
            height="16"
          />
          <span class="toolbar-logo-text">lightjj</span>
        </span>
        {#if currentWorkspace}
          <span class="toolbar-divider"></span>
          <div class="toolbar-workspace" bind:this={wsSelectorEl}>
            <button
              class="toolbar-ws-btn"
              onclick={() => { if (workspaceList.length > 1) wsDropdownOpen = !wsDropdownOpen }}
              title={workspaceList.length > 1 ? 'Switch workspace (w)' : currentWorkspace}
            >
              <span class="toolbar-ws-glyph">◇</span>
              <span class="toolbar-ws-name">{currentWorkspace}</span>
              {#if workspaceList.length > 1}
                <span class="toolbar-ws-chevron">{wsDropdownOpen ? '▴' : '▾'}</span>
              {/if}
            </button>
            {#if wsDropdownOpen && workspaceList.length > 1}
              <div class="toolbar-ws-dropdown">
                {#each workspaceList as ws (ws.name)}
                  {#if ws.name === currentWorkspace}
                    <div class="toolbar-ws-option toolbar-ws-active">
                      <span class="toolbar-ws-glyph">◇</span>
                      <span>{ws.name}</span>
                    </div>
                  {:else}
                    <button class="toolbar-ws-option" onclick={() => { handleWorkspaceOpen(ws.name); wsDropdownOpen = false }}>
                      <span class="toolbar-ws-glyph">◇</span>
                      <span>{ws.name}</span>
                      <span class="toolbar-ws-open">↗</span>
                    </button>
                  {/if}
                {/each}
              </div>
            {/if}
          </div>
        {/if}
        <span class="toolbar-divider"></span>
        <nav class="toolbar-nav">
          <button
            class="toolbar-nav-btn"
            class:toolbar-nav-active={activeView === 'log'}
            onclick={() => { if (!inlineMode) activeView = 'log' }}
            disabled={inlineMode}
            title="Revisions (1)"
          >◉ Revisions</button>
          <button
            class="toolbar-nav-btn"
            class:toolbar-nav-active={activeView === 'branches'}
            onclick={() => { if (!inlineMode) activeView = 'branches' }}
            disabled={inlineMode}
            title="Branches (2)"
          >⑂ Branches</button>
          <button
            class="toolbar-nav-btn"
            class:toolbar-nav-active={activeView === 'operations'}
            onclick={() => { if (!inlineMode) { activeView = 'operations'; loadOplog() } }}
            disabled={inlineMode}
            title="Operations (3)"
          >⟲ Operations</button>
        </nav>
        <span class="toolbar-divider"></span>
        <button class="toolbar-search" onclick={() => { closeModals(); paletteOpen = true }} title="Command palette ({cmdKey}K)">
          <span class="toolbar-search-text">Search…</span>
          <kbd class="toolbar-search-kbd">{cmdKey}K</kbd>
        </button>
      </div>
      <div class="toolbar-right">
        <button class="toolbar-btn" onclick={() => { if (!inlineMode) handleUndo() }} disabled={inlineMode || mutating} title="Undo (u)">
          Undo
        </button>
        <button class="toolbar-btn" onclick={() => { if (!inlineMode) handleCommit() }} disabled={inlineMode || mutating} title="Commit (c)">
          Commit
        </button>
        <span class="toolbar-divider"></span>
        <button class="toolbar-btn" onclick={() => { if (!inlineMode) handleGitOp('fetch', []) }} disabled={inlineMode || mutating} title="Fetch (f)">
          Fetch
        </button>
        <button class="toolbar-btn" onclick={() => { if (!inlineMode) handleGitOp('push', []) }} disabled={inlineMode || mutating} title="Push (p)">
          Push
        </button>
        <button class="toolbar-btn" onclick={() => { if (!inlineMode) { closeAllModals(); gitModalOpen = true } }} disabled={inlineMode || mutating} title="Git operations (g)">
          Git…
        </button>
        <span class="toolbar-divider"></span>
        <button
          class="toolbar-btn toolbar-theme"
          onclick={toggleTheme}
          title="Toggle theme (t)"
        >
          {darkMode ? '☀' : '●'}
        </button>
      </div>
    </div>

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
        <div class="revision-panel-wrapper" style="width: {config.revisionPanelWidth}px">
          <RevisionGraph
            bind:this={revisionGraphRef}
            {revisions}
            {selectedIndex}
            {checkedRevisions}
            {loading}
            {mutating}
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
            {impliedCommitIds}
          />
        </div>

        <!-- svelte-ignore a11y_no_static_element_interactions -->
        <div class="panel-divider" class:divider-active={draggingDivider} onmousedown={startDividerDrag}></div>

        {#if divergence.active}
          <!-- {#key} enforces what DivergencePanel assumes: changeId never
               changes in-place. createDivergenceMode.enter() doesn't guard
               against re-entry; the key does. Fresh mount = no stale-promise
               races, no gen counter needed in the version-load path. -->
          {#key divergence.changeId}
            <DivergencePanel
              changeId={divergence.changeId}
              onkeep={handleKeepDivergent}
              onclose={() => divergence.cancel()}
            />
          {/key}
        {:else}
          <DiffPanel
            bind:this={diffPanelRef}
            {diffContent}
            {changedFiles}
            diffTarget={loadedTarget}
            {diffLoading}
            bind:splitView={() => config.splitView, (v) => config.splitView = v}
            fileSelectionMode={squash.active ? 'squash' : split.active ? (split.review ? 'review' : 'split') : false}
            {selectedFiles}
            ontogglefile={toggleFileSelection}
            onresolve={inlineMode ? undefined : handleResolve}
            onfilesaved={() => withMutation(loadLog)}
            onjjmutation={withMutation}
          >
            {#snippet header()}
              <!-- {#key} resets RevisionHeader local state (descExpanded) on nav.
                   Replaces the manual previous-value reset effect that Svelte
                   5.50+ flags as state_referenced_locally. -->
              {#key effectiveId(selectedRevision!.commit)}
              <RevisionHeader
                revision={selectedRevision!}
                {fullDescription}
                {describeSaved}
                {descriptionEditing}
                {descriptionDraft}
                {commitMode}
                {prByBookmark}
                onstartdescribe={startDescriptionEdit}
                ondescribe={commitMode ? executeCommit : handleDescribe}
                oncanceldescribe={() => { descriptionEditing = false; commitMode = false }}
                ondraftchange={(v) => { descriptionDraft = v }}
                onbookmarkclick={openBookmarkModal}
                onresolveDivergence={() => { if (selectedRevision) divergence.enter(selectedRevision.commit.change_id) }}
              />
              {/key}
            {/snippet}
          </DiffPanel>
        {/if}
      </div>

      {#if evologOpen}
        <!-- svelte-ignore a11y_no_static_element_interactions -->
        <div
          class="evolog-divider"
          class:dragging={draggingEvologDivider}
          onmousedown={startEvologDividerDrag}
        ></div>
        {#key selectedRevision?.commit.change_id}
          <EvologPanel
            entries={evologEntries}
            loading={evologLoading}
            {selectedRevision}
            height={config.evologPanelHeight}
            onrefresh={() => { if (selectedRevision) loadEvolog(effectiveId(selectedRevision.commit)) }}
            onclose={() => { evologOpen = false }}
          />
        {/key}
      {/if}

      {#if oplogOpen}
        <OplogPanel
          entries={oplogEntries}
          loading={oplogLoading}
          error={oplog.error}
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
          error={oplog.error}
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

  {#if welcomeOpen}
    <WelcomeModal version={APP_VERSION} features={welcomeFeatures} title={welcomeTitle} onclose={dismissWelcome} />
  {/if}
</div>

<style>
  /* --- Layout --- */
  .app {
    display: flex;
    flex-direction: column;
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

  .revision-panel-wrapper {
    flex-shrink: 0;
    min-width: 280px;
    max-width: 600px;
    display: flex;
    overflow: hidden;
  }

  .panel-divider {
    width: 4px;
    flex-shrink: 0;
    cursor: col-resize;
    position: relative;
    z-index: 1;
  }

  .panel-divider::after {
    content: '';
    position: absolute;
    top: 0;
    bottom: 0;
    left: 1px;
    width: 1px;
    background: transparent;
    transition: background var(--anim-duration) var(--anim-ease);
  }

  .panel-divider:hover::after,
  .panel-divider.divider-active::after {
    background: var(--surface2);
  }

  .evolog-divider {
    height: 4px;
    flex-shrink: 0;
    cursor: row-resize;
    position: relative;
    z-index: 1;
  }

  .evolog-divider::after {
    content: '';
    position: absolute;
    left: 0;
    right: 0;
    top: 1px;
    height: 1px;
    background: transparent;
    transition: background var(--anim-duration) var(--anim-ease);
  }

  .evolog-divider:hover::after,
  .evolog-divider.dragging::after {
    background: var(--surface2);
  }

  .fullwidth-panel {
    flex: 1;
    overflow: hidden;
    display: flex;
  }

  /* --- Toolbar (replaces sidebar) --- */
  .toolbar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    height: 34px;
    padding: 0 10px;
    background: var(--crust);
    border-bottom: 1px solid var(--surface1);
    flex-shrink: 0;
    user-select: none;
    gap: 8px;
  }

  .toolbar-left,
  .toolbar-right {
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .toolbar-logo {
    display: flex;
    align-items: center;
    gap: 6px;
  }

  .toolbar-logo-text {
    font-weight: 600;
    font-size: 12px;
    color: var(--subtext0);
    letter-spacing: -0.01em;
  }

  .toolbar-divider {
    width: 1px;
    height: 14px;
    background: var(--surface1);
  }

  .toolbar-workspace {
    position: relative;
  }

  .toolbar-ws-btn {
    display: flex;
    align-items: center;
    gap: 5px;
    padding: 3px 8px;
    background: transparent;
    border: 1px solid var(--surface1);
    border-radius: 4px;
    font-family: var(--font-mono);
    font-size: 11px;
    color: var(--subtext0);
    cursor: pointer;
  }

  .toolbar-ws-btn:hover {
    background: var(--bg-hover);
    border-color: var(--surface2);
  }

  .toolbar-ws-glyph {
    color: var(--subtext0);
    font-size: 10px;
  }

  .toolbar-ws-name {
    color: var(--text);
  }

  .toolbar-ws-chevron {
    font-size: 9px;
    color: var(--surface2);
  }

  .toolbar-ws-dropdown {
    position: absolute;
    top: calc(100% + 4px);
    left: 0;
    min-width: 160px;
    background: var(--mantle);
    border: 1px solid var(--surface1);
    border-radius: 5px;
    padding: 3px;
    z-index: 100;
    box-shadow: var(--shadow-heavy);
  }

  .toolbar-ws-option {
    display: flex;
    align-items: center;
    gap: 6px;
    width: 100%;
    padding: 5px 8px;
    background: transparent;
    border: none;
    border-radius: 4px;
    color: var(--subtext0);
    font-family: var(--font-mono);
    font-size: 11px;
    cursor: pointer;
    text-align: left;
  }

  .toolbar-ws-option:not(.toolbar-ws-active):hover {
    background: var(--bg-hover);
    color: var(--text);
  }

  .toolbar-ws-active {
    color: var(--amber);
    cursor: default;
  }

  .toolbar-ws-active .toolbar-ws-glyph {
    color: var(--amber);
  }

  .toolbar-ws-open {
    font-size: 10px;
    color: var(--surface2);
    margin-left: auto;
    opacity: 0;
  }

  .toolbar-ws-option:hover .toolbar-ws-open {
    opacity: 1;
  }

  .toolbar-btn {
    padding: 3px 10px;
    background: transparent;
    border: 1px solid var(--surface1);
    border-radius: 4px;
    color: var(--subtext0);
    font-family: inherit;
    font-size: 11px;
    cursor: pointer;
    line-height: 1.4;
  }

  .toolbar-btn:hover:not(:disabled) {
    background: var(--bg-hover);
    color: var(--text);
    border-color: var(--surface2);
  }

  .toolbar-btn:disabled {
    opacity: 0.35;
    cursor: default;
  }

  .toolbar-theme {
    border: none;
    font-size: 13px;
    padding: 3px 6px;
  }

  .toolbar-nav {
    display: flex;
    align-items: center;
    gap: 1px;
  }

  .toolbar-nav-btn {
    padding: 3px 8px;
    background: transparent;
    border: none;
    border-radius: 4px;
    color: var(--subtext0);
    font-family: inherit;
    font-size: 11px;
    cursor: pointer;
    line-height: 1.4;
  }

  .toolbar-nav-btn:hover:not(.toolbar-nav-active) {
    background: var(--bg-hover);
    color: var(--text);
  }

  .toolbar-nav-active {
    color: var(--amber);
    font-weight: 600;
  }

  .toolbar-search {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 3px 8px;
    background: var(--surface0);
    border: none;
    border-radius: 4px;
    color: var(--surface2);
    font-family: inherit;
    font-size: 11px;
    cursor: pointer;
  }

  .toolbar-search:hover {
    color: var(--subtext0);
  }

  .toolbar-search-kbd {
    font-family: var(--font-mono);
    font-size: 9px;
    color: var(--surface2);
    background: none;
    border: 1px solid var(--surface1);
    padding: 0 4px;
    border-radius: 3px;
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
