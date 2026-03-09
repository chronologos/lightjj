<script module lang="ts">
  // Module-scope: survives the {#key activeTabId} remount in AppShell.
  // Without this guard, switching tabs re-runs the welcome check and re-opens
  // the modal if tutorialVersion hasn't been persisted yet (user hasn't clicked).
  let welcomeCheckDone = false

  /** Snapshot of App's UI state, captured on tab-switch-away and rehydrated
   *  into a fresh mount. The {#key} remount still fires (SSE/lifecycle stay
   *  correct); this just restores cursor position + scroll. Inline modes
   *  (rebase/squash/split/describe) are intentionally NOT preserved — a
   *  half-complete operation across tabs is a footgun. */
  export interface TabState {
    selectedIndex: number
    revsetFilter: string
    activeView: 'log' | 'branches' | 'operations'
    diffScrollTop: number
  }
</script>

<script lang="ts">
  import type { Snippet } from 'svelte'
  import { untrack, onDestroy } from 'svelte'
  import { SvelteSet } from 'svelte/reactivity'

  let { tabBar, onOpenTab, initialState }: {
    tabBar?: Snippet
    onOpenTab?: (path: string) => void
    initialState?: TabState
  } = $props()

  // initialState is passed inside {#key activeTabId} — it never changes
  // mid-lifetime (key change = remount). untrack() silences Svelte's
  // state_referenced_locally warning; we DO want the mount-time snapshot.
  const init = untrack(() => initialState)

  import { api, effectiveId, multiRevset, computeConnectedCommitIds, getCached, prefetchRevision, prefetchFilesBatch, onStale, wireAutoRefresh, clearAllCaches, type LogEntry, type FileChange, type OpEntry, type EvologEntry, type Workspace, type Alias, type PullRequest, type DiffTarget, type Bookmark, type MutationResult } from './lib/api'
  import MessageBar, { errorMessage, type Message } from './lib/MessageBar.svelte'
  import { clearDiffCaches } from './lib/diff-cache'
  import type { PaletteCommand } from './lib/CommandPalette.svelte'
  import StatusBar from './lib/StatusBar.svelte'
  import CommandPalette from './lib/CommandPalette.svelte'
  import RevisionGraph from './lib/RevisionGraph.svelte'
  import DiffPanel from './lib/DiffPanel.svelte'
  import RevisionHeader from './lib/RevisionHeader.svelte'
  import EvologPanel from './lib/EvologPanel.svelte'
  import OplogPanel from './lib/OplogPanel.svelte'
  import BookmarkModal, { type BookmarkOp } from './lib/BookmarkModal.svelte'
  import BookmarksPanel, { type BookmarkRowActions } from './lib/BookmarksPanel.svelte'
  import BookmarkInput from './lib/BookmarkInput.svelte'
  import GitModal from './lib/GitModal.svelte'
  import ContextMenu, { type ContextMenuItem } from './lib/ContextMenu.svelte'
  import DivergencePanel, { type KeepPlan } from './lib/DivergencePanel.svelte'
  import { createRebaseMode, createSquashMode, createSplitMode, createDivergenceMode, targetModeLabel } from './lib/modes.svelte'
  import { createLoader } from './lib/loader.svelte'
  import { createRevisionNavigator } from './lib/revision-navigator.svelte'
  import { config } from './lib/config.svelte'
  import { APP_VERSION, CURRENT_RELEASE_URL, RELEASES_URL, parseSemver, semverMinorGt } from './lib/version'
  import { FEATURES, type TutorialFeature } from './lib/tutorial-content'
  import WelcomeModal from './lib/WelcomeModal.svelte'

  // --- Global state ---
  // initialState-hydrated vars: restored on tab-switch-back via AppShell's
  // snapshot. Everything else starts fresh on mount.
  let selectedIndex: number = $state(init?.selectedIndex ?? -1)
  let revsetFilter: string = $state(init?.revsetFilter ?? '')
  let pendingScrollRestore: number | null = init?.diffScrollTop ?? null

  // Single user-facing message surface. Replaces error/lastAction/commandOutput.
  let message: Message | null = $state(null)
  let messageExpanded: boolean = $state(false)
  let messageClearTimer: number | undefined

  let descriptionEditing: boolean = $state(false)
  let descriptionDraft: string = $state('')
  let commitMode: boolean = $state(false) // when true, description editor saves via commit instead of describe
  const TRACKED_REVSET = 'ancestors(@ | mutable() & mine() | trunk()..tracked_remote_bookmarks(), 2) | trunk()'
  // viewMode is a discretization of revsetFilter, not independent state — the
  // toggle just writes a preset string into the textbox. Typing anything else
  // auto-surfaces a third "Custom" tab.
  const viewMode = $derived(
    revsetFilter === '' ? 'log'
    : revsetFilter === TRACKED_REVSET ? 'tracked'
    : 'custom'
  )
  let checkedRevisions = new SvelteSet<string>()
  let lastCheckedIndex: number = $state(-1)
  let navDebounceTimer: number | undefined
  let evologDebounceTimer: number | undefined
  let evologOpen: boolean = $state(false)
  let oplogOpen: boolean = $state(false)
  let welcomeOpen: boolean = $state(false)
  let welcomeFeatures: TutorialFeature[] = $state([])
  let welcomeTitle: string = $state('')

  // --- Message helpers (defined early — loaders need showError) ---
  // Single message at a time; next mutation clears via withMutation.
  // Success auto-clears after 3s unless expanded (user is reading details).
  function setMessage(m: Message | null) {
    clearTimeout(messageClearTimer)
    message = m
    messageExpanded = false
    if (m?.kind === 'success') {
      messageClearTimer = setTimeout(() => { if (!messageExpanded) message = null }, 3000)
    }
  }
  const showError = (e: unknown) => setMessage(errorMessage(e))
  const dismissMessage = () => setMessage(null)

  // --- Data loaders ---
  // Each loader owns its value, loading flag, and race-condition-safe generation
  // counter. See loader.svelte.ts for semantics. Aliases below preserve existing
  // names for backward-compatible reads throughout the component + templates.
  const log = createLoader((revset?: string) => api.log(revset), [] as LogEntry[], showError)
  // The diff/files/description triple + their batch-fetch orchestration (incl.
  // the revGen await-gap guard) live in revision-navigator.svelte.ts. Local
  // aliases preserve the existing references across the component.
  const nav = createRevisionNavigator({ onError: showError })
  const { diff, files, description, singleTarget } = nav
  const oplog = createLoader(() => api.oplog(50), [] as OpEntry[])
  const evolog = createLoader((id: string) => api.evolog(id), [] as EvologEntry[], showError)
  const bookmarksPanel = createLoader(() => api.bookmarks(), [] as Bookmark[])

  // Abort predicate for nav.loadDiffAndFiles — re-checked after its await.
  // User checking a revision during the fetch means the multi-check $effect
  // below already fired; don't clobber it.
  const hasChecked = () => checkedRevisions.size > 0

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

  let activeView: 'log' | 'branches' | 'operations' = $state(init?.activeView ?? 'log')

  let currentWorkspace: string = $state('')
  let workspaceList: Workspace[] = $state([])
  let aliases: Alias[] = $state([])
  let pullRequests: PullRequest[] = $state([])
  let prByBookmark = $derived(new Map(pullRequests.map(pr => [pr.bookmark, pr])))

  let contextMenu: { items: ContextMenuItem[]; x: number; y: number } | null = $state(null)
  const showContextMenu = (items: ContextMenuItem[], x: number, y: number) => {
    contextMenu = { items, x, y }
  }

  // Open-in-editor is enabled iff the mode-appropriate editorArgs config field
  // is set (backend reports this). Default false = hide the menu item until
  // loadInfo() confirms — a brief info() failure would otherwise enable a
  // feature that 400s on click. See docs/CONFIG.md for the invariant.
  let editorConfigured = $state(false)

  let anyModalOpen = $derived(paletteOpen || bookmarkModalOpen || bookmarkInputOpen || gitModalOpen || !!contextMenu || divergence.active || welcomeOpen)
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
    setMessage(null)
    try { return await fn() }
    finally { mutating = false }
  }

  // --- Theme ---
  let darkMode = $derived(config.theme === 'dark')
  const cmdKey = typeof navigator !== 'undefined' && navigator.platform.includes('Mac') ? '⌘' : 'Ctrl+'

  // Highlight HTML uses tok-* class names (not inline styles), so theme
  // toggle is a pure CSS var swap — no cache invalidation, no re-render.
  function toggleTheme() {
    config.theme = darkMode ? 'light' : 'dark'
  }

  // Sync theme class + reduce-motion class to <html>
  $effect(() => {
    document.documentElement.classList.toggle('light', !darkMode)
    document.documentElement.classList.toggle('reduce-motion', config.reduceMotion)
  })

  // --- Refs ---
  let revisionGraphRef: ReturnType<typeof RevisionGraph> | undefined = $state(undefined)
  let diffPanelRef: ReturnType<typeof DiffPanel> | undefined = $state(undefined)
  let bookmarksPanelRef: ReturnType<typeof BookmarksPanel> | undefined = $state(undefined)
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
  // Index-based so the '@' key and post-load reset share the same scan.
  let workingCopyIndex = $derived(revisions.findIndex(r => r.commit.is_working_copy))
  let workingCopyEntry = $derived(workingCopyIndex >= 0 ? revisions[workingCopyIndex] : undefined)

  // Live progress line from streamMutation (git push/fetch). Takes precedence
  // over the generic "Working..." while a stream is feeding it.
  let mutationProgress: string = $state('')

  let statusText = $derived.by(() => {
    if (inlineMode) return ''
    if (mutating) return mutationProgress || 'Working...'
    if (loading) return revisions.length > 0 ? 'Refreshing...' : 'Loading revisions...'
    if (diffLoading) return 'Loading diff...'
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
      // Unchecking the last one: multi→single transition. The multi-check
      // $effect returns early on kind !== 'multi', so nothing else reloads
      // the single-rev diff — loadedTarget stays stale on multi content.
      if (checkedRevisions.size === 0 && selectedRevision) {
        nav.loadDiffAndFiles(selectedRevision.commit, hasChecked)
      }
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
    if (selectedRevision) nav.loadDiffAndFiles(selectedRevision.commit, hasChecked)
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
    { label: 'Jump to working copy (@)', shortcut: '@', category: 'Navigation', action: () => { if (workingCopyIndex >= 0) selectRevision(workingCopyIndex) }, when: () => workingCopyIndex >= 0 },
    { label: 'Next file / Previous file', shortcut: '] / [', category: 'Navigation', action: noop, infoOnly: true },

    // Revisions
    { label: 'Refresh revisions', shortcut: 'r', category: 'Revisions', action: userRefresh, when: () => !inlineMode },
    { label: 'Hard refresh (clear all caches)', category: 'Revisions', action: () => { clearAllCaches(); clearDiffCaches(); userRefresh(true) }, when: () => !inlineMode },
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
    { label: 'Git operations (advanced)', shortcut: 'g', category: 'Git', action: () => openModal('git'), when: () => !inlineMode },

    // Bookmarks
    { label: 'Bookmark operations', shortcut: 'b', category: 'Bookmarks', action: openBookmarkModal, when: () => !inlineMode },
    { label: 'Set bookmark', shortcut: 'B', category: 'Bookmarks', action: () => openModal('bookmarkInput'), when: () => !inlineMode && !!selectedRevision && checkedRevisions.size === 0 },

    // View (non-dynamic)
    { label: 'Toggle split/unified diff', category: 'View', action: () => { config.splitView = !config.splitView } },
    { label: 'Toggle operation log', shortcut: 'O', category: 'View', action: toggleOplog },
    { label: 'Toggle evolution log', shortcut: 'E', category: 'View', action: toggleEvolog, when: () => !!selectedRevision },
    // Help — showInCheatsheet lets shortcut-less entries appear in the empty-query grid
    { label: 'Show welcome / keyboard shortcuts', category: 'Help', showInCheatsheet: true, action: () => { welcomeTitle = `Welcome to lightjj v${APP_VERSION}`; welcomeFeatures = FEATURES; welcomeOpen = true } },
    { label: `Changelog for v${APP_VERSION}`, category: 'Help', showInCheatsheet: true, action: () => window.open(CURRENT_RELEASE_URL, '_blank', 'noopener') },
    { label: 'Full changelog (all releases)', category: 'Help', showInCheatsheet: true, action: () => window.open(RELEASES_URL, '_blank', 'noopener') },

    // Actions
    { label: 'Undo last operation', shortcut: 'u', category: 'Actions', action: handleUndo, when: () => !inlineMode },
    { label: 'Clear checked revisions', shortcut: 'Esc', category: 'Actions', action: clearChecksAndReload, when: () => checkedRevisions.size > 0 },
    { label: 'Command palette', shortcut: '\u2318K', category: 'Actions', action: noop, infoOnly: true },

    // Annotations (agent review)
    { label: 'Export annotations (markdown → clipboard)', category: 'Annotations',
      action: () => {
        const md = diffPanelRef?.exportAnnotationsMarkdown() ?? ''
        navigator.clipboard.writeText(md)
        setMessage(md ? { kind: 'success', text: 'Annotations copied' } : { kind: 'warning', text: 'No annotations to export' })
      },
      when: () => !inlineMode && !!diffPanelRef?.hasAnnotations(),
    },
    { label: 'Export annotations (JSON → clipboard)', category: 'Annotations',
      action: () => {
        const json = diffPanelRef?.exportAnnotationsJSON() ?? ''
        navigator.clipboard.writeText(json)
        setMessage(json ? { kind: 'success', text: 'Annotations JSON copied' } : { kind: 'warning', text: 'No annotations to export' })
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
    { label: viewMode === 'tracked' ? 'Switch to log view' : 'Switch to tracked view', category: 'View', action: () => setViewMode(viewMode === 'tracked' ? 'log' : 'tracked') },
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
      const { hostname, repo_path, editor_configured } = await api.info()
      document.title = formatTitle(hostname, repo_path)
      editorConfigured = editor_configured
    } catch { /* static <title> fallback + editorConfigured stays false (fail-safe) */ }
  }

  // api.remotes() is session-memoized; first element is the default remote
  // (backend sorts it to front). Used by BookmarksPanel's track-action label.
  let defaultRemote: string = $state('origin')
  api.remotes().then(r => { if (r[0]) defaultRemote = r[0] }).catch(() => {})

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
    // until ≤MAX. /home/alice/src/lightjj → /U/i/3/lightjj → …/lightjj
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


  async function loadLog(resetSelection = false) {
    const revset = revsetFilter || undefined
    const ok = await log.load(revset)
    blurActiveInput()
    if (!ok) return // superseded or errored — don't post-process stale state

    // pendingSelectCommitId: jumpToBookmark's deferred selection. Consume
    // here; on hit suppress resetSelection (which handleRevsetSubmit passes).
    let pending = pendingSelectCommitId
    pendingSelectCommitId = null
    if (pending) {
      const idx = revisions.findIndex(r => r.commit.commit_id === pending)
      if (idx >= 0) { selectedIndex = idx; resetSelection = false }
    }
    if (resetSelection || selectedIndex < 0 || selectedIndex >= revisions.length) {
      selectedIndex = workingCopyIndex
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
      nav.loadDiffAndFiles(sel.commit, hasChecked)
    }
    // Refresh open panels — oplog always reflects new operations,
    // evolog may change if the selected revision was modified
    if (oplogOpen || activeView === 'operations') oplog.load()
    if (activeView === 'branches') bookmarksPanel.load()
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

  // Move cursor without loading diff/files — used in squash mode where
  // the diff is intentionally frozen on the source revision
  function selectRevisionCursorOnly(index: number) {
    selectedIndex = index
  }

  let prevSelectedIndex = -1
  let navRafId = 0

  function selectRevision(index: number) {
    const moved = index !== prevSelectedIndex
    const direction = index > prevSelectedIndex ? 1 : -1
    prevSelectedIndex = index
    selectedIndex = index
    descriptionEditing = false

    const entry = revisions[index]
    if (!entry) return

    // Cache hits: defer loader writes to rAF so the browser paints the
    // cursor move (selectedIndex) first, then applies diff content in the
    // next frame. Previously this was synchronous (one batch), but large
    // diffs blocked the cursor highlight from painting until the entire
    // diff DOM was built — revisits felt slower than first visits.
    //
    // Cache misses: defer with 50ms debounce. Coalesces rapid uncached j/k
    // into one network request. The browser paints the selection highlight
    // before the setTimeout fires.
    clearTimeout(navDebounceTimer)
    cancelAnimationFrame(navRafId)
    const hit = checkedRevisions.size === 0 ? getCached(entry.commit.commit_id) : null
    if (hit) {
      const commit = entry.commit
      navRafId = requestAnimationFrame(() => {
        // Guard: rapid j/k may have moved past this revision already.
        if (selectedIndex !== index) return
        nav.applyCacheHit(commit, hit)
      })
    } else {
      navDebounceTimer = setTimeout(() => {
        const current = revisions[selectedIndex]
        if (!current) return
        if (checkedRevisions.size === 0) nav.loadDiffAndFiles(current.commit, hasChecked)
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

  // BookmarksPanel jump: consumed by loadLog's post-load selection when the
  // bookmark's commit isn't in the current revset. Set BEFORE revsetFilter
  // write so the effect-triggered loadLog sees it.
  let pendingSelectCommitId: string | null = null

  function showBookmarkContextMenu(bm: Bookmark, actions: BookmarkRowActions, x: number, y: number) {
    const items: ContextMenuItem[] = [
      { label: 'Jump to revision', shortcut: '⏎', disabled: !actions.jump,
        action: () => jumpToBookmark(bm) },
      { separator: true },
      { label: 'Delete', shortcut: 'd', danger: true, disabled: !actions.del,
        action: () => handleBookmarkOp({ action: 'delete', bookmark: bm.name }) },
      { label: 'Forget', shortcut: 'f', danger: true,
        action: () => handleBookmarkOp({ action: 'forget', bookmark: bm.name }) },
    ]
    if (actions.track) {
      const t = actions.track
      items.push({ label: t.action === 'track' ? `Track @${t.remote}` : `Untrack @${t.remote}`,
        shortcut: 't',
        action: () => handleBookmarkOp({ action: t.action, bookmark: bm.name, remote: t.remote }) })
    }
    items.push(
      { separator: true },
      { label: `Copy name (${bm.name})`, action: () => navigator.clipboard.writeText(bm.name) },
    )
    contextMenu = { items, x, y }
  }

  function jumpToBookmark(bm: Bookmark) {
    if (bm.conflict || !bm.commit_id) return
    activeView = 'log'
    const idx = revisions.findIndex(r => r.commit.commit_id === bm.commit_id)
    if (idx >= 0) { selectRevision(idx); return }
    // Not loaded: reload with bookmark revset. Bare name only works for
    // local refs — remote-only needs name@remote. Use commit_id as fallback
    // revset (always valid, resolves to a single commit).
    pendingSelectCommitId = bm.commit_id
    revsetFilter = bm.local ? bm.name : bm.commit_id
    handleRevsetSubmit()
  }

  function openRevisionContextMenu(changeId: string, x: number, y: number) {
    const entry = revisions.find(r => effectiveId(r.commit) === changeId)
    const commitId = entry?.commit.commit_id ?? ''
    // Mode-transition items (Rebase/Squash/Split/Describe/New/Edit) are gated
    // on !inlineMode — clicking Split while already in squash mode would call
    // cancelInlineModes() + split.enter() in one tick, leaving FileSelectionPanel
    // mounted but unfocused (BACKLOG #30). Abandon stays enabled — it's a
    // straight mutation, no mode entry.
    const items: ContextMenuItem[] = [
      { label: 'Edit working copy', disabled: inlineMode, action: () => handleEdit(changeId) },
      { label: 'New revision', shortcut: 'n', disabled: inlineMode, action: () => handleNew(changeId) },
      { label: 'Describe', shortcut: 'e', disabled: inlineMode, action: () => { selectByChangeId(changeId); startDescriptionEdit() } },
      { separator: true },
      { label: 'Rebase...', shortcut: 'R', disabled: inlineMode, action: () => { selectByChangeId(changeId); enterRebaseMode() } },
      { label: 'Squash...', shortcut: 'S', disabled: inlineMode, action: () => { selectByChangeId(changeId); enterSquashMode() } },
      { label: 'Split...', shortcut: 's', disabled: inlineMode, action: () => { selectByChangeId(changeId); enterSplitMode() } },
      { separator: true },
      { label: 'Set bookmark...', shortcut: 'B', disabled: inlineMode, action: () => { selectByChangeId(changeId); openModal('bookmarkInput') } },
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
    contextMenu = { items, x, y }
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

  // Builds the unified Message for a successful mutation. Warnings demote
  // kind to 'warning' and surface as first-line suffix; full warning text +
  // jj's stdout land in details for [+N] expansion.
  function mutationMessage(successMsg: string, result: MutationResult): Message {
    // server.go: runMutationWithInput only populates warnings when hasWarningLine()
    // found a "Warning:"-prefixed line — but stderr may have informational preamble
    // before it (e.g. "Rebased 3 commits\nWarning: conflict in foo.go"). Show the
    // first Warning: line in the toast, not the informational one.
    const warn = result.warnings
    const details = [warn, result.output].filter(Boolean).join('\n') || undefined
    if (!warn) return { kind: 'success', text: successMsg, details }
    const firstWarn = warn.split('\n').find(l => l.startsWith('Warning:')) ?? warn.split('\n')[0]
    return { kind: 'warning', text: `${successMsg} — ${firstWarn}`, details }
  }

  async function runMutation(
    fn: () => Promise<MutationResult>,
    successMsg: string,
    opts?: { before?: () => void, after?: () => void },
  ) {
    return withMutation(async () => {
      try {
        opts?.before?.()
        const result = await fn()
        setMessage(mutationMessage(successMsg, result))
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

  const handleOpUndo = (id: string) =>
    runMutation(() => api.opUndo(id), `Undid operation ${id.slice(0, 8)}`)

  const handleOpRestore = (id: string) =>
    runMutation(() => api.opRestore(id), `Restored to operation ${id.slice(0, 8)}`)

  function handleRestoreVersion(fromCommitId: string) {
    if (!selectedRevision) return
    const to = effectiveId(selectedRevision.commit)
    runMutation(() => api.restoreFrom(fromCommitId, to), `Restored version ${fromCommitId.slice(0, 8)}`)
  }

  function handleOpenFile(path: string, line?: number) {
    api.openFile(path, line).catch(showError)
  }

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
        setMessage(mutationMessage(`Updated description for ${eid.slice(0, 8)}`, result))
        description.set(descriptionDraft)
        descriptionEditing = false
        await loadLog()
      } catch (e) {
        showError(e)
      }
    })
  }

  // Shared by handleCommit + startDescriptionEdit: prefer the already-loaded
  // fullDescription, fall back to a fetch, fall back to the graph-row stub.
  async function fetchPrefillDescription(): Promise<string> {
    if (fullDescription) return fullDescription
    if (!selectedRevision) return ''
    try {
      return (await api.description(selectedRevision.commit.commit_id)).description
    } catch {
      return selectedRevision.description
    }
  }

  function focusDescEditor() {
    requestAnimationFrame(() => {
      (document.querySelector('.desc-editor textarea') as HTMLTextAreaElement | null)?.focus()
    })
  }

  async function handleCommit() {
    if (!selectedRevision) return
    const cid = selectedRevision.commit.commit_id
    commitMode = true
    const prefill = await fetchPrefillDescription()
    // j/k during fetch → selectRevision() set descriptionEditing=false and
    // commitMode=false (via oncanceldescribe if editor was up, or just moved
    // cursor). Bail so we don't re-open the editor over the NEW revision.
    if (selectedRevision?.commit.commit_id !== cid) return
    descriptionDraft = prefill
    descriptionEditing = true
    focusDescEditor()
  }

  async function executeCommit() {
    return withMutation(async () => {
      try {
        const result = await api.commit(descriptionDraft)
        setMessage(mutationMessage('Committed working copy', result))
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
    if ((op.action === 'move' || op.action === 'advance') && !selectedRevision) return
    const changeId = selectedRevision ? effectiveId(selectedRevision.commit) : ''
    const actions: Record<BookmarkOp['action'], () => Promise<MutationResult>> = {
      move: () => api.bookmarkMove(op.bookmark, changeId),
      advance: () => api.bookmarkAdvance(op.bookmark, changeId),
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
        // Plan computed by DivergencePanel from the classify() group. Order:
        //   1. Rebase — moves non-empty descendants to the keeper tip first.
        //      If abandon ran first, jj would auto-rebase D onto the loser-
        //      stack's parent (trunk); our explicit rebase would then hit a
        //      twice-rebased tree. -s (not -r) so D's descendants follow.
        //   2. Abandon — losing columns + empty descendants. Stale stack now
        //      has no children pinning it visible.
        //   3. Bookmarks — per-change_id repoint, not stack tip.
        // Serial throughout: concurrent jj mutations → divergent op history.
        // Accumulate warnings from each step — divergence rebase is MORE
        // likely than average to conflict (moving commits between stacks).
        const results: MutationResult[] = []
        if (plan.rebaseSources.length > 0) {
          results.push(await api.rebase(plan.rebaseSources, plan.keeperCommitId, '-s', '-d'))
        }
        results.push(await api.abandon(plan.abandonCommitIds))
        for (const { name, targetCommitId } of plan.bookmarkRepoints) {
          results.push(await api.bookmarkSet(targetCommitId, name))
        }

        divergence.cancel()
        const parts = [`kept ${plan.keeperCommitId.slice(0, 8)}`]
        if (plan.rebaseSources.length > 0) parts.push(`rebased ${plan.rebaseSources.length}`)
        if (plan.abandonCommitIds.length > 1) parts.push(`abandoned ${plan.abandonCommitIds.length}`)
        const text = `Resolved divergence — ${parts.join(', ')}`
        const warnings = results.map(r => r.warnings).filter(Boolean).join('\n')
        const outputs = results.map(r => r.output).filter(Boolean).join('\n')
        setMessage(mutationMessage(text, { output: outputs, warnings: warnings || undefined }))
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
      setMessage({ kind: 'warning', text: 'Cannot rebase onto source revision' })
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
        const msg = sources.length > 1
          ? `Rebased ${sources.length} revisions ${modeLabel} ${destination.slice(0, 8)}`
          : `Rebased ${sources[0].slice(0, 8)} ${modeLabel} ${destination.slice(0, 8)}`
        setMessage(mutationMessage(msg, result))
        clearChecks()
        await loadLog()
      } catch (e) {
        showError(e)
      }
    })
  }

  function enterSquashMode() {
    const revs = effectiveRevisions
    if (revs.length === 0 || files.loading) return
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
      setMessage({ kind: 'warning', text: 'Cannot squash into source revision' })
      return
    }
    // C1: block execution when no files selected (empty array would squash ALL files).
    // Exception: empty commits have 0 total files — squash is still valid (moves metadata).
    if (selectedFiles.size === 0 && totalFileCount > 0) {
      setMessage({ kind: 'warning', text: 'Select at least one file to squash' })
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
        const msg = sources.length > 1
          ? `Squashed ${sources.length} revisions into ${destination.slice(0, 8)}`
          : `Squashed ${sources[0].slice(0, 8)} into ${destination.slice(0, 8)}`
        setMessage(mutationMessage(msg, result))
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
    if (!selectedRevision || checkedRevisions.size > 0 || files.loading) return
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
      setMessage({ kind: 'warning', text: reviewing ? 'Uncheck at least one file to reject' : 'Uncheck at least one file to split out' })
      return
    }
    if (selectedFiles.size === 0) {
      setMessage({ kind: 'warning', text: reviewing ? 'Accept at least one file' : 'Select at least one file to keep' })
      return
    }
    return withMutation(async () => {
      try {
        const files = [...selectedFiles]
        const revision = split.revision
        const result = await api.split(revision, files, split.parallel || undefined)
        cancelInlineModes()
        const msg = reviewing
          ? `Reviewed ${revision.slice(0, 8)} (${files.length} accepted)`
          : `Split ${revision.slice(0, 8)} (${files.length} files stay)`
        setMessage(mutationMessage(msg, result))
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
    contextMenu = null
    // dismissWelcome (not welcomeOpen=false) — persist tutorialVersion so it
    // doesn't re-show next launch. Guarded: Cmd+K path calls this frequently.
    if (welcomeOpen) dismissWelcome()
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

  // Close-then-open. Keyboard callers have provably passed !anyModalOpen +
  // !inlineMode gates (closeAllModals is a no-op there); palette/context-menu
  // callers haven't. One helper means both paths get the guard.
  //
  // Palette is NOT here — Cmd+K uses closeModals() (not closeAllModals()) so
  // inline modes survive palette open/close. The other modals don't want that.
  type ModalName = 'git' | 'bookmark' | 'bookmarkInput'
  function openModal(name: ModalName) {
    closeAllModals()
    switch (name) {
      case 'git': gitModalOpen = true; break
      case 'bookmark': bookmarkModalOpen = true; break
      case 'bookmarkInput': bookmarkInputOpen = true; break
    }
  }

  function openBookmarkModal(filter?: string) {
    bookmarkModalFilter = filter ?? ''
    openModal('bookmark')
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
    const cid = selectedRevision.commit.commit_id
    const prefill = await fetchPrefillDescription()
    if (selectedRevision?.commit.commit_id !== cid) return
    descriptionDraft = prefill
    descriptionEditing = true
    focusDescEditor()
  }

  // User-intent refresh — dismisses any stale error/warning. Background
  // refreshes (runMutation's post-mutation loadLog, SSE onStale, mode-exit
  // effect) call loadLog() directly and preserve the message they just set.
  function userRefresh(resetSelection = false) {
    setMessage(null)
    return loadLog(resetSelection)
  }

  function handleRevsetSubmit() {
    clearTimeout(navDebounceTimer)
    nav.cancel()
    diff.reset()
    files.reset()
    clearChecks()
    userRefresh(true)
  }

  function clearRevsetFilter() {
    revsetFilter = ''
    handleRevsetSubmit()
  }

  function setViewMode(mode: 'log' | 'tracked') {
    revsetFilter = mode === 'tracked' ? TRACKED_REVSET : ''
    handleRevsetSubmit()
  }

  // --- Keyboard shortcuts ---
  //
  // Dispatcher reads as policy:
  //   globalOverrides → inlineCommit → isInInput → modifier → modal →
  //   inlineNav → escape → global → logView
  //
  // Ordering is load-bearing. Each gate's placement is deliberate:
  //   - globalOverrides (Cmd+K/F) BEFORE isInInput: work inside text fields.
  //   - inlineCommit BEFORE isInInput: FileSelectionPanel holds focus during
  //     squash/split; Enter still executes. (cm-editor sub-filter inside.)
  //   - modifier AFTER globalOverrides: Cmd+C etc. pass through to browser.
  //   - inlineNav swallows EVERYTHING: no normal-mode keys leak into modes.

  function isInInput(t: HTMLElement) {
    return t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || !!t.closest('.cm-editor')
  }

  function handleKeydown(e: KeyboardEvent) {
    const target = e.target as HTMLElement
    if (handleGlobalOverrides(e)) return
    if (handleInlineCommit(e, target)) return
    if (isInInput(target)) return
    if (e.metaKey || e.ctrlKey) return
    if (anyModalOpen) return
    if (inlineMode) return handleInlineNav(e)
    // Branches panel is focus-independent: delegate directly via bind:this
    // ref (not element onkeydown, which silently breaks when focus drifts
    // to toolbar → d/f/t fall through to global → t=theme-toggle).
    // defaultPrevented catches element-level dispatch if focus IS in-panel
    // (avoids double-handling). handleEscapeStack is below this block so
    // panel's own Escape tiering (disarm → clear filter → close) wins.
    if (activeView === 'branches') {
      if (e.defaultPrevented) return
      bookmarksPanelRef?.handleKeydown(e)
      if (e.defaultPrevented) return
      handleGlobalKeys(e)
      return
    }
    if (e.key === 'Escape') return handleEscapeStack()
    if (handleGlobalKeys(e)) return
    if (activeView !== 'log') return
    handleLogKeys(e)
  }

  // Cmd+K / Cmd+F — fire regardless of input focus, mode, or open modals.
  function handleGlobalOverrides(e: KeyboardEvent): boolean {
    if (!(e.metaKey || e.ctrlKey)) return false
    if (e.key === 'k') {
      e.preventDefault()
      // closeModals not closeAllModals — Cmd+K during rebase opens the palette
      // WITHOUT cancelling the rebase; closing it returns you to rebase mode.
      closeModals()
      paletteOpen = true
      return true
    }
    if (e.key === 'f') {
      e.preventDefault()
      diffPanelRef?.openSearch()
      return true
    }
    return false
  }

  // Inline mode Enter/Escape — must fire even when FileSelectionPanel holds
  // focus (it's a <div tabindex=-1> inside the diff panel). But cm-editor and
  // text inputs handle their own Enter/Escape, so sub-filter on those.
  function handleInlineCommit(e: KeyboardEvent, target: HTMLElement): boolean {
    if (!inlineMode || (e.key !== 'Enter' && e.key !== 'Escape')) return false
    // Stop the dispatcher — input handles natively. Returning true here also
    // dedups the isInInput call the dispatcher would make next.
    if (isInInput(target)) return true
    e.preventDefault()
    if (e.key === 'Enter') {
      if (split.active) executeSplit()
      else if (squash.active) executeSquash()
      else executeRebase()  // inlineMode && !split && !squash ⇒ rebase
    } else {
      cancelInlineModes()
    }
    return true
  }

  // j/k (per-mode semantics) + delegate to mode.handleKey(). Swallows ALL
  // keys — normal-mode shortcuts (t/u/b/r/...) deliberately don't leak through.
  //
  // j/k semantics differ: squash uses selectRevisionCursorOnly (cursor moves,
  // diff stays frozen on source — that's what you're squashing). Rebase uses
  // full selectRevision (diff follows — destination preview). Split has NO j/k
  // (operates on a fixed revision).
  function handleInlineNav(e: KeyboardEvent): void {
    const [mode, jk] = split.active ? [split, undefined] as const
                     : squash.active ? [squash, selectRevisionCursorOnly] as const
                     : [rebase, selectRevision] as const
    if (jk && navKey(e, jk)) return
    if (mode.handleKey(e.key)) e.preventDefault()
  }

  // j/k bounds-checked navigation. Returns true if handled.
  function navKey(e: KeyboardEvent, select: (idx: number) => void): boolean {
    if (e.key === 'j' && selectedIndex < revisions.length - 1) {
      e.preventDefault(); select(selectedIndex + 1); return true
    }
    if (e.key === 'k' && selectedIndex > 0) {
      e.preventDefault(); select(selectedIndex - 1); return true
    }
    return false
  }

  // Escape backs out of the most-nested thing. Priority stack:
  // inline modes (handled in handleInlineCommit) > description editor >
  // checked revisions > message-expand > message > nothing.
  function handleEscapeStack(): void {
    if (descriptionEditing) { descriptionEditing = false; commitMode = false }
    else if (checkedRevisions.size > 0) clearChecksAndReload()
    else if (messageExpanded) messageExpanded = false
    else if (message) dismissMessage()
  }

  // View-independent keys. `false` = not ours, fall through to log-view.
  function handleGlobalKeys(e: KeyboardEvent): boolean {
    switch (e.key) {
      case 't': e.preventDefault(); toggleTheme(); return true
      case 'u': e.preventDefault(); handleUndo(); return true
      case 'c': e.preventDefault(); handleCommit(); return true
      case 'f': e.preventDefault(); handleGitOp('fetch', []); return true
      case 'p': e.preventDefault(); handleGitOp('push', []); return true
      case 'g': e.preventDefault(); openModal('git'); return true
      case 'w':
        e.preventDefault()
        if (workspaceList.length > 1) wsDropdownOpen = !wsDropdownOpen
        return true
      case '1': e.preventDefault(); activeView = 'log'; return true
      case '2': e.preventDefault(); activeView = 'branches'; return true
      case '3': e.preventDefault(); activeView = 'operations'; loadOplog(); return true
    }
    return false
  }

  // Log-view keys. Sub-gates:
  //   singleOnly  — action is semantically single-revision (e/s/v/B)
  //   oneOrMany   — works on cursor OR checks (R/S)
  //   selection   — cursor only, check-agnostic (Space/Enter)
  // These mirror the enter*Mode functions' internal gates — keyboard gate
  // avoids preventDefault on disallowed state; function gate protects
  // palette/context-menu callers.
  function handleLogKeys(e: KeyboardEvent): void {
    if (navKey(e, selectRevision)) return

    const singleOnly = selectedRevision && checkedRevisions.size === 0
    const oneOrMany = selectedRevision || checkedRevisions.size > 0

    switch (e.key) {
      case ' ':
        if (selectedRevision) {
          e.preventDefault()
          toggleCheck(effectiveId(selectedRevision.commit), selectedIndex)
        }
        break
      case 'Enter':
        if (selectedRevision) {
          e.preventDefault()
          nav.loadDiffAndFiles(selectedRevision.commit, hasChecked)
        }
        break
      case 'r': e.preventDefault(); userRefresh(); break
      case 'b': e.preventDefault(); openBookmarkModal(); break
      case '/': e.preventDefault(); revisionGraphRef?.focusRevsetInput(); break
      case ']': e.preventDefault(); diffPanelRef?.stepFile(1); break
      case '[': e.preventDefault(); diffPanelRef?.stepFile(-1); break
      case 'E': if (selectedRevision) { e.preventDefault(); toggleEvolog() } break
      case 'O': e.preventDefault(); toggleOplog(); break
      case '@': e.preventDefault(); if (workingCopyIndex >= 0) selectRevision(workingCopyIndex); break
      case 'n':
        e.preventDefault()
        if (checkedRevisions.size > 0) handleNewFromChecked()
        else if (selectedRevision) handleNew(effectiveId(selectedRevision.commit))
        break
      case 'e': if (singleOnly) { e.preventDefault(); startDescriptionEdit() } break
      case 's': if (singleOnly) { e.preventDefault(); enterSplitMode() } break
      case 'v': if (singleOnly) { e.preventDefault(); enterReviewMode() } break
      case 'B': if (singleOnly) { e.preventDefault(); openModal('bookmarkInput') } break
      case 'R': if (oneOrMany) { e.preventDefault(); enterRebaseMode() } break
      case 'S': if (oneOrMany) { e.preventDefault(); enterSquashMode() } break
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
      // Panel's stale data is harmless during mutation (rows just look one op
      // behind); no need for the loadLog guards. Fire-and-forget.
      if (activeView === 'branches') bookmarksPanel.load()
    })
  })
  // Load on view entry. Covers key '2' + toolbar click + any future path.
  // loadLog also refreshes if branches view is open (mutations via this tab).
  $effect(() => {
    if (activeView === 'branches') bookmarksPanel.load()
  })
  // Auto-refresh sources: SSE push (fsnotify/inotifywait) + tab-focus snapshot.
  // Both route through notifyOpId → onStale so the guards above apply. The
  // body reads no reactive state → runs once on mount, cleanup on unmount.
  $effect(() => wireAutoRefresh())

  // Raw setTimeout escapes {#key} remount — clear on tab-switch unmount so
  // stale closures don't keep the old instance's signals alive.
  onDestroy(() => {
    clearTimeout(messageClearTimer)
    clearTimeout(navDebounceTimer)
    clearTimeout(evologDebounceTimer)
  })
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

  // --- Tab-switch state preservation ---
  // AppShell calls getState() before the {#key} remount destroys this instance.
  export function getState(): TabState {
    return {
      selectedIndex,
      revsetFilter,
      activeView,
      diffScrollTop: diffPanelRef?.getScrollTop() ?? 0,
    }
  }

  // One-shot scroll restore: after the first diff finishes loading post-mount,
  // apply the saved position. pendingScrollRestore nulls itself so subsequent
  // diffLoading cycles (nav to another revision) don't re-apply a stale scroll.
  $effect(() => {
    if (pendingScrollRestore == null || diffLoading || !diffPanelRef) return
    const v = pendingScrollRestore
    pendingScrollRestore = null
    // rAF so the diff content DOM is painted before we scroll.
    requestAnimationFrame(() => diffPanelRef?.setScrollTop(v))
  })

  // --- Tutorial / What's New ---
  // Must await config.ready so we read the disk-persisted tutorialVersion, not
  // the localStorage default (which is empty on a fresh origin/port).
  // Guard set BEFORE the async — two tab-switches before config.ready resolves
  // would otherwise both see false and both queue .then() callbacks.
  if (!welcomeCheckDone) {
    welcomeCheckDone = true
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
  }

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
                    <!-- Workspaces are just repo paths — open as a tab. Path absent
                         when the workspace predates jj's workspace_store index
                         (additive-only; no backfill). Click-to-warn instead of
                         disabled+title — title is keyboard-inaccessible. -->
                    <button
                      class="toolbar-ws-option"
                      class:toolbar-ws-unavailable={!ws.path}
                      onclick={() => {
                        wsDropdownOpen = false
                        if (ws.path) {
                          onOpenTab?.(ws.path)
                        } else {
                          setMessage({
                            kind: 'warning',
                            text: `Workspace '${ws.name}' path unknown — predates jj's workspace_store index`,
                            details: 'Open manually with: lightjj -R <path>',
                          })
                        }
                      }}
                    >
                      <span class="toolbar-ws-glyph">◇</span>
                      <span>{ws.name}</span>
                      {#if ws.path}<span class="toolbar-ws-open">↗</span>{/if}
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
        <button class="toolbar-btn" onclick={() => { if (!inlineMode) openModal('git') }} disabled={inlineMode || mutating} title="Git operations (g)">
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

    {@render tabBar?.()}

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
            onviewmodechange={setViewMode}
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
            onfilesaved={loadLog}
            onjjmutation={withMutation}
            oncontextmenu={showContextMenu}
            onopenfile={editorConfigured ? handleOpenFile : undefined}
          >
            {#snippet header()}
              <!-- {#key} resets RevisionHeader local state (descExpanded) on nav.
                   Replaces the manual previous-value reset effect that Svelte
                   5.50+ flags as state_referenced_locally.
                   Guard: loadedTarget.kind==='single' renders this, but
                   selectedRevision (cursor) can be null when a custom revset
                   excludes @ → workingCopyIndex=-1. Key on loadedTarget.changeId
                   (what's actually displayed) so the remount tracks the DIFF,
                   not the cursor. -->
              {#if selectedRevision}
              {#key loadedTarget?.kind === 'single' ? loadedTarget.changeId : ''}
              <RevisionHeader
                revision={selectedRevision}
                {fullDescription}
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
              {/if}
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
            onrestoreversion={handleRestoreVersion}
            oncontextmenu={showContextMenu}
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
          onopundo={handleOpUndo}
          onoprestore={handleOpRestore}
          oncontextmenu={showContextMenu}
        />
      {/if}
    {:else if activeView === 'branches'}
      <div class="fullwidth-panel">
        <BookmarksPanel
          bind:this={bookmarksPanelRef}
          bookmarks={bookmarksPanel.value}
          loading={bookmarksPanel.loading}
          error={bookmarksPanel.error}
          {defaultRemote}
          {prByBookmark}
          onjump={jumpToBookmark}
          onexecute={handleBookmarkOp}
          onrefresh={() => bookmarksPanel.load()}
          onclose={() => { activeView = 'log' }}
          oncontextmenu={showBookmarkContextMenu}
        />
      </div>
    {:else if activeView === 'operations'}
      <div class="fullwidth-panel">
        <OplogPanel
          entries={oplogEntries}
          loading={oplogLoading}
          error={oplog.error}
          onrefresh={loadOplog}
          onclose={() => { activeView = 'log' }}
          onopundo={handleOpUndo}
          onoprestore={handleOpRestore}
          oncontextmenu={showContextMenu}
        />
      </div>
    {/if}

    <StatusBar
      {statusText}
      {rebase}
      {squash}
      {squashFileCount}
      {split}
      {splitFileCount}
      {activeView}
    />
  </div>

  {#if message}
    <MessageBar {message} expanded={messageExpanded}
      onDismiss={dismissMessage}
      onExpandToggle={() => messageExpanded = !messageExpanded}
    />
  {/if}

  <CommandPalette bind:open={paletteOpen} {commands} />

  {#if contextMenu}
    <ContextMenu
      items={contextMenu.items}
      x={contextMenu.x}
      y={contextMenu.y}
      bind:open={() => true, (v) => { if (!v) contextMenu = null }}
    />
  {/if}

  <GitModal
    bind:open={gitModalOpen}
    currentChangeId={selectedRevision?.commit.change_id ?? null}
    onexecute={handleGitOp}
  />

  <BookmarkInput
    bind:open={bookmarkInputOpen}
    onsave={handleBookmarkSet}
  />

  <BookmarkModal
    bind:open={bookmarkModalOpen}
    currentCommitId={selectedRevision?.commit.commit_id ?? null}
    filterBookmark={bookmarkModalFilter}
    onexecute={handleBookmarkOp}
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

  .toolbar-ws-unavailable {
    opacity: 0.5;
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

</style>
