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
    activeView: 'log' | 'branches'
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

  import { api, effectiveId, multiRevset, computeConnectedCommitIds, getCached, prefetchRevision, prefetchFilesBatch, onStale, onStaleWC, wireAutoRefresh, clearAllCaches, type LogEntry, type FileChange, type OpEntry, type EvologEntry, type Workspace, type Alias, type PullRequest, type DiffTarget, type Bookmark, type MutationResult, type StaleImmutableGroup } from './lib/api'
  import MessageBar, { errorMessage, type Message } from './lib/MessageBar.svelte'
  import { clearDiffCaches, parseDiffCached } from './lib/diff-cache'
  import { hunkKey, fileSelectionState, planHunkSpec, resolvePlan, normalizeFileType } from './lib/hunk-apply'
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
  import DivergencePanel from './lib/DivergencePanel.svelte'
  import { executeKeepPlan, splitIdentity, squashDivergent, abandonMutable, type DivergenceActionResult } from './lib/divergence-actions'
  import { createRebaseMode, createSquashMode, createSplitMode, createDivergenceMode, createFileSelection, targetModeLabel } from './lib/modes.svelte'
  import { createLoader } from './lib/loader.svelte'
  import { createRevisionNavigator } from './lib/revision-navigator.svelte'
  import { config } from './lib/config.svelte'
  import { APP_VERSION, CURRENT_RELEASE_URL, RELEASES_URL, parseSemver, semverMinorGt } from './lib/version'
  import { FEATURES, type TutorialFeature } from './lib/tutorial-content'
  import WelcomeModal from './lib/WelcomeModal.svelte'
  import { buildVisibilityRevset, revsetQuote } from './lib/remote-visibility'

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

  // Server's snapshotLoop detects stale-WC and pushes SSE; SSH mode detects
  // via api.snapshot() error. Either way onStaleWC fires. Non-dismissable —
  // the bar is a fixed overlay (doesn't block the graph), and the condition
  // persists until fixed. "Update stale" button or CLI recovery clears it.
  let workspaceStale = $state(false)

  // Stale immutable detection — force-push leftovers. Set after git fetch/push,
  // cleared after cleanup or if resolved externally.
  let staleImmutableGroups = $state<StaleImmutableGroup[]>([])

  let descriptionEditing: boolean = $state(false)
  let descriptionDraft: string = $state('')
  let commitMode: boolean = $state(false) // when true, description editor saves via commit instead of describe

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
  // Mirrors isStaleWCError server-side. Mutation-failure detection: if the
  // user tries abandon/rebase/etc. while the WC is stale, jj fails with this
  // error. Without this hook the user sees a generic red error and no
  // "Update stale" button (workspaceStale only gets set via the snapshot
  // paths — 5s loop in local mode, tab-focus in SSH). After dismissing the
  // error, displayMessage shows staleWCMessage → button appears.
  const STALE_WC_PATTERNS = [
    'working copy is stale',
    "Could not read working copy's operation",
  ]
  function showError(e: unknown) {
    const msg = errorMessage(e)
    if (STALE_WC_PATTERNS.some(p => msg.text.includes(p))) workspaceStale = true
    setMessage(msg)
  }
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

  // config.remoteVisibility is keyed by repo_path so tab A's toggles don't
  // bleed into tab B. repoPath arrives via loadInfo() — until then the slice
  // reads {} (no-remotes-visible) which is the feature's default anyway.
  let repoPath = $state('')
  let repoVisibility = $derived(config.remoteVisibility[repoPath] ?? {})
  let visibilityRevset = $derived(buildVisibilityRevset(repoVisibility, bookmarksPanel.value))

  // Smart views — preset chips below the revset input. Click → applyRevsetExample.
  // Module-const: zero reactive deps, viewLabel loop adds no tracking.
  const STATIC_PRESETS = [
    { key: 'mine',      label: 'My work',   revset: 'mine() & mutable()' },
    { key: 'wip',       label: 'WIP',       revset: 'trunk()..@' },
    { key: 'conflicts', label: 'Conflicts', revset: 'conflicts()' },
    { key: 'divergent', label: 'Divergent', revset: '(divergent() & mutable())::' },
  ] as const

  // The only dynamic preset. Empty list → '' (chip hidden by {#if}, never
  // hits jj). revsetQuote escapes revset operators in bookmark names.
  // $derived.by thunk sidesteps TDZ (pullRequests declared at ~:286).
  const prsRevset = $derived.by(() =>
    pullRequests.length === 0
      ? ''
      : `ancestors(${pullRequests.map(p => revsetQuote(p.bookmark)).join(' | ')}, 3) | @`
  )

  // Label for RevisionGraph's header badge. null = default log (no badge).
  // Pure string-match on revsetFilter — a preset's identity IS its revset
  // string. No separate appliedPresetKey: every revsetFilter write site
  // (oninput, clearRevsetFilter, visibility effect, jumpToBookmark, tab-restore)
  // would be a desync bug site. Editing the applied revset → 'Custom' is
  // correct: user is customizing.
  const viewLabel = $derived.by(() => {
    if (revsetFilter === '' || revsetFilter === visibilityRevset) return null
    for (const p of STATIC_PRESETS) if (revsetFilter === p.revset) return p.label
    if (prsRevset !== '' && revsetFilter === prsRevset) return 'PRs'
    return 'Custom'
  })
  // When visibilityRevset changes and the user hasn't typed a custom filter,
  // update revsetFilter to reflect the new visibility config and reload.
  // The guard compares against prevVisibilityRevset (the value that THIS effect
  // previously wrote), NOT viewLabel — reading viewLabel inside the effect lazily
  // recomputes it with NEW visibilityRevset + OLD revsetFilter → 'custom' →
  // guard fails on every toggle after the first. untrack() blocks dep tracking,
  // not $derived lazy recomputation.
  //
  // prev=undefined skips the FIRST fire: loadLog() at mount handles the initial
  // load; firing handleRevsetSubmit here too is a wasted request. Subsequent
  // fires (repoPath arriving with saved visibility, user toggle) work normally.
  let prevVisibilityRevset: string | undefined = undefined
  $effect(() => {
    const vr = visibilityRevset
    untrack(() => {
      if (prevVisibilityRevset === undefined) { prevVisibilityRevset = vr; return }
      if (revsetFilter === '' || revsetFilter === prevVisibilityRevset) {
        revsetFilter = vr
        handleRevsetSubmit()
      }
      prevVisibilityRevset = vr
    })
  })

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
  const fileSel = createFileSelection()

  // Hunk-level review state (split.review=true). Keys are hunkKey(path, idx).
  // Lives here (not in modes.svelte.ts) — hunk selection needs allHunks
  // (derived from parseDiffCached), which App owns. fileSel above is the
  // file-level analogue; both are cleared together in cancelInlineModes.
  let selectedHunks = new SvelteSet<string>()
  let hunkCursor: number = $state(0)

  // Runtime guard: TabState is in-memory (AppShell), not disk, so stale
  // 'operations' from before the type narrowing can only occur via HMR.
  // The === check costs nothing and prevents an invalid union value.
  let activeView: 'log' | 'branches' = $state(
    init?.activeView === 'branches' ? 'branches' : 'log'
  )

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
  let revsetInputEl: HTMLInputElement | undefined = $state(undefined)
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
    { label: 'Focus revset filter', shortcut: '/', category: 'Navigation', action: () => revsetInputEl?.focus() },
    { label: 'Clear revset filter', category: 'Navigation', action: clearRevsetFilter, when: () => revsetFilter !== '' },
    ...STATIC_PRESETS.map(p => ({ label: `View: ${p.label}`, hint: p.revset, category: 'Navigation', action: () => applyRevsetExample(p.revset) })),
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
    { label: `View: Open PRs (${pullRequests.length})`, hint: prsRevset, category: 'Navigation', action: () => applyRevsetExample(prsRevset), when: () => pullRequests.length > 0 },
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
      const { hostname, repo_path, editor_configured, default_remote } = await api.info()
      document.title = formatTitle(hostname, repo_path)
      editorConfigured = editor_configured
      defaultRemote = default_remote
      repoPath = repo_path
    } catch { /* static <title> fallback + editorConfigured stays false (fail-safe) */ }
  }

  // Backend resolves this per-tab from --default-remote flag > jj config
  // git.push > "origin". Pre-load fallback until loadInfo() completes.
  let defaultRemote: string = $state('origin')
  // Full remote list — session-memoized. Used by BookmarksPanel/Modal for
  // multi-remote track/untrack submenus.
  let allRemotes: string[] = $state([])
  api.remotes().then(r => { allRemotes = r }).catch(() => {})

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
    if (oplogOpen) oplog.load()
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

    // Clicking away from the divergent change closes the panel (intent =
    // "done looking at this"). Clicking the SAME change is a no-op — panel
    // stays open. j/k doesn't reach here (anyModalOpen gates it) so only
    // mouse clicks trigger this path.
    if (divergence.active && entry.commit.change_id !== divergence.changeId) {
      divergence.cancel()
    }

    // Cache hits: double-rAF defers loader writes past the FIRST paint so
    // the browser renders the cursor move (selectedIndex) before building
    // the diff panel DOM. Single rAF isn't enough — rAF callbacks run
    // BEFORE paint in the same frame (event → microtasks → rAF → style →
    // layout → paint). Double-rAF: outer fires pre-paint in frame N,
    // inner fires pre-paint in frame N+1 — frame N paints cursor-only.
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
        // Outer rAF: frame N (pre-paint). Schedule inner for frame N+1.
        navRafId = requestAnimationFrame(() => {
          // Guard: rapid j/k may have moved past this revision already.
          if (selectedIndex !== index) return
          nav.applyCacheHit(commit, hit)
        })
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

  function showBookmarkContextMenu(bm: Bookmark, actions: BookmarkRowActions, x: number, y: number, jumpTarget?: string) {
    const pd = actions.pushDelete
    const delOp: BookmarkOp = pd[0]
      ? { action: 'push-delete', bookmark: bm.name, remote: pd[0] }
      : { action: 'delete', bookmark: bm.name }
    const delLabel = pd[0]
      ? `Push delete → ${pd[0]}${pd.length > 1 ? ` (+${pd.length - 1})` : ''}`
      : 'Delete'
    const items: ContextMenuItem[] = [
      { label: 'Jump to revision', shortcut: '⏎', disabled: !actions.jump && !jumpTarget,
        action: () => jumpToBookmark(bm, jumpTarget) },
      { separator: true },
      { label: delLabel, shortcut: 'd', danger: true, disabled: !actions.del && !pd[0],
        action: () => handleBookmarkOp(delOp) },
      { label: 'Forget', shortcut: 'f', danger: true,
        action: () => handleBookmarkOp({ action: 'forget', bookmark: bm.name }) },
    ]
    for (const t of actions.track) {
      items.push({
        label: t.action === 'track' ? `Track @${t.remote}` : `Untrack @${t.remote}`,
        shortcut: actions.track.length === 1 ? 't' : undefined,
        action: () => handleBookmarkOp({ action: t.action, bookmark: bm.name, remote: t.remote }),
      })
    }
    items.push(
      { separator: true },
      { label: `Copy name (${bm.name})`, action: () => navigator.clipboard.writeText(bm.name) },
    )
    contextMenu = { items, x, y }
  }

  // Keyboard-triggered track submenu — used when `t` is pressed on a
  // bookmark with multiple remotes. Reuses the ContextMenu component.
  function showTrackMenu(bm: Bookmark, opts: import('./lib/bookmark-sync').TrackOption[], x: number, y: number) {
    contextMenu = {
      items: opts.map(t => ({
        label: t.action === 'track' ? `Track @${t.remote}` : `Untrack @${t.remote}`,
        action: () => handleBookmarkOp({ action: t.action, bookmark: bm.name, remote: t.remote }),
      })),
      x, y,
    }
  }

  // overrideCommitId: when jumping from a BookmarksPanel remote-group row,
  // bm.commit_id is the "primary" (local if exists, else defaultRemote) but
  // the row DISPLAYED the scoped remote's commit_id — display and click must
  // agree. The override is passed through from row.jumpTarget.
  //
  // Does NOT switch activeView — the branches panel stays open in the right
  // column so the selection highlight appears in the graph on the left. In
  // branches view, skip diff load (panel occupies the diff slot).
  function jumpToBookmark(bm: Bookmark, overrideCommitId?: string) {
    const commitId = overrideCommitId ?? bm.commit_id
    if (bm.conflict || !commitId) return
    const select = activeView === 'branches' ? selectRevisionCursorOnly : selectRevision
    const idx = revisions.findIndex(r => r.commit.commit_id === commitId)
    if (idx >= 0) { select(idx); return }
    // Not loaded: reload with a context-preserving revset. | @ keeps the
    // working copy visible for @-jump-back. commit_id is hex-safe unquoted;
    // bookmark names can contain revset operators (@ in git refs) → revsetQuote.
    pendingSelectCommitId = commitId
    const target = (bm.local && !overrideCommitId) ? revsetQuote(bm.name) : commitId
    revsetFilter = `ancestors(${target}, 20) | @`
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

  // One-click stale-WC recovery. `after` clears optimistically — server also
  // clears its flag, but the fresh-wc SSE event only fires on the NEXT
  // snapshot (up to 5s later); without this the success toast auto-clears
  // at 3s and the stale warning flashes back for ~2s.
  const handleUpdateStale = () =>
    runMutation(
      () => api.workspaceUpdateStale(),
      'Working copy updated',
      { after: () => { workspaceStale = false } },
    )

  // Stale warning is lower-priority than a mutation error the user just
  // triggered, so `message` wins. Non-dismissable (the problem persists until
  // fixed); the ✕ only dismisses real messages.
  const staleWCMessage: Message = {
    kind: 'warning',
    text: 'Working copy is stale — another workspace rewrote shared history',
    action: { label: 'Update stale', onClick: handleUpdateStale },
  }
  const staleImmutableMessage: Message | null = $derived(staleImmutableGroups.length > 0 ? {
    kind: 'warning' as const,
    text: `${staleImmutableGroups.length} stale immutable commit${staleImmutableGroups.length !== 1 ? 's' : ''} (likely force-pushed remotely)`,
    details: staleImmutableGroups.map(g =>
      `${g.stale.commit_id.slice(0, 8)} "${g.stale.description}" — keeper: ${g.keeper.commit_id.slice(0, 8)} (${g.keeper.local_bookmarks.concat(g.keeper.remote_bookmarks).join(', ')})`
    ).join('\n'),
    action: { label: 'Clean up', onClick: handleCleanupStaleImmutable },
  } : null)

  let displayMessage = $derived(message ?? (workspaceStale ? staleWCMessage : staleImmutableMessage))

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
    const cid = selectedRevision.commit.commit_id
    return withMutation(async () => {
      try {
        const result = await api.describe(eid, descriptionDraft)
        setMessage(mutationMessage(`Updated description for ${eid.slice(0, 8)}`, result))
        // Only poke the loader if selection unchanged — otherwise we'd write
        // the old revision's draft into the new selection's description loader.
        // Mutation already succeeded; loadLog() will refresh either way.
        if (selectedRevision?.commit.commit_id === cid) {
          description.set(descriptionDraft)
          descriptionEditing = false
        }
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
    const prefill = await fetchPrefillDescription()
    // j/k during fetch → bail. commitMode is set AFTER the guard so a
    // nav-during-await doesn't leak it to the next describe operation
    // (next `e` press would call executeCommit instead of handleDescribe).
    if (selectedRevision?.commit.commit_id !== cid) return
    commitMode = true
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
      { after: () => { loadPullRequests(); checkStaleImmutable() } },
    )
  }

  function checkStaleImmutable() {
    api.staleImmutable().then(groups => {
      // Guard: skip [] → [] to avoid no-op reactivity on every fetch/push.
      if (groups.length > 0 || staleImmutableGroups.length > 0) {
        staleImmutableGroups = groups
      }
    }).catch(() => {
      // Silent — detection is best-effort. Don't block the user with
      // an error about a background check.
    })
  }

  function handleCleanupStaleImmutable() {
    const staleIds = staleImmutableGroups.map(g => g.stale.commit_id)
    runMutation(
      () => api.abandon(staleIds, true),
      `Cleaned up ${staleIds.length} stale immutable commit${staleIds.length !== 1 ? 's' : ''}`,
      { after: () => { staleImmutableGroups = [] } },
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
    bookmarkModalOpen = false
    // Delete-staged completion (tracked remote-only): pushing IS the delete.
    // Delegate to handleGitOp — push is a slow network op and the streaming
    // path handles mutationProgress + PR reload.
    if (op.action === 'push-delete') {
      // exact: prefix — jj git push -b uses glob matching by default; a
      // bookmark literally named "*" would otherwise match everything.
      return handleGitOp('push', ['--bookmark', `exact:${op.bookmark}`, '--remote', op.remote!])
    }
    if ((op.action === 'move' || op.action === 'advance') && !selectedRevision) return
    const changeId = selectedRevision ? effectiveId(selectedRevision.commit) : ''
    const actions: Record<Exclude<BookmarkOp['action'], 'push-delete'>, () => Promise<MutationResult>> = {
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
    )
  }

  // Wraps divergence-actions.ts executors in App's withMutation→close→log
  // cycle. The catch-but-don't-close-panel is why this can't be runMutation
  // (which has no error path — it closes nothing, but divergence.cancel()
  // on success / NOT on error is the point: user sees state and retries).
  async function runDivergenceResolution(run: () => Promise<DivergenceActionResult>) {
    return withMutation(async () => {
      try {
        const { text, results } = await run()
        divergence.cancel()
        const warnings = results.map(r => r.warnings).filter(Boolean).join('\n')
        const outputs = results.map(r => r.output).filter(Boolean).join('\n')
        setMessage(mutationMessage(text, { output: outputs, warnings: warnings || undefined }))
        await loadLog()
      } catch (e) {
        // Don't close panel on error — let user see state and retry
        showError(e)
        await loadLog()
      }
    })
  }

  // Returning to log view after graph clicks in branches view (which use
  // selectRevisionCursorOnly) leaves the diff loader pointing at whatever
  // was loaded BEFORE branches view. This resyncs. Returns true if the
  // LOADED diff matches the CURSOR — enter*Mode callers gate on this to
  // avoid initializing fileSel from a stale changedFiles snapshot.
  //
  // checkedRevisions guard is load-bearing: multi-check diff (what
  // enterSquashMode needs for fileSel.init) must not be clobbered by a
  // single-revision reload. Returns true in that case — the loaded multi
  // diff IS the state enter*Mode wants.
  function switchToLogView(): boolean {
    activeView = 'log'
    // Cancel any queued selectRevision debounce/rAF — the direct load below
    // supersedes it. Otherwise context-menu → selectByChangeId → selectRevision
    // schedules a load, then switchToLogView fires another, then 50ms later
    // the debounce fires a third. revGen makes it correct but it's wasteful.
    clearTimeout(navDebounceTimer)
    cancelAnimationFrame(navRafId)
    const sel = revisions[selectedIndex]
    if (!sel || checkedRevisions.size > 0) return true
    const loaded = diff.value.target
    if (loaded?.kind === 'single' && loaded.commitId === sel.commit.commit_id) return true
    nav.loadDiffAndFiles(sel.commit, hasChecked)
    return false
  }

  function enterRebaseMode() {
    const revs = effectiveRevisions
    if (revs.length === 0) return
    cancelInlineModes()
    switchToLogView()
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
    // false = diff was stale, load just fired, changedFiles is still the
    // OLD revision's file list. User retries once the load settles (visible
    // in diff panel). Reachable via palette/context-menu from branches view.
    if (!switchToLogView()) return
    fileSel.init(changedFiles)
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
    if (fileSel.set.size === 0 && fileSel.total > 0) {
      setMessage({ kind: 'warning', text: 'Select at least one file to squash' })
      return
    }
    return withMutation(async () => {
      try {
        // W3: compare against snapshotted total, not live changedFiles
        const files = fileSel.set.size < fileSel.total
          ? [...fileSel.set]
          : undefined
        const { sources, keepEmptied, ignoreImmutable } = squash
        const result = await api.squash(sources, destination, {
          files,
          keepEmptied: keepEmptied || undefined,
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

  // ── Hunk-level review support ────────────────────────────────────────────
  // parseDiffCached keys by diffContent string — same object instance as
  // DiffPanel's parse, zero cost. Gated on split.review so normal nav never
  // derives this. Flat list for j/k bounds + Space target.
  let reviewParsedDiff = $derived(split.review ? parseDiffCached(diffContent) : [])
  let allHunks = $derived(reviewParsedDiff.flatMap(f =>
    f.hunks.map((_, i) => ({ path: f.filePath, idx: i, key: hunkKey(f.filePath, i) }))
  ))

  // Passed to DiffPanel → DiffFileView. Bundled object (not 4 loose props)
  // follows the mode-objects convention — RevisionGraph gets {rebase,squash,split}
  // the same way.
  let hunkReview = $derived(split.review ? {
    selected: selectedHunks,
    cursor: allHunks[hunkCursor] ?? null,
    toggle: (path: string, idx: number) => {
      const k = hunkKey(path, idx)
      selectedHunks.has(k) ? selectedHunks.delete(k) : selectedHunks.add(k)
    },
    toggleFile: (path: string) => {
      // Tri-state cycle: all→none, none→all, some→all (gather remaining)
      const file = reviewParsedDiff.find(f => f.filePath === path)
      if (!file) return
      const st = fileSelectionState(file, selectedHunks)
      for (let i = 0; i < file.hunks.length; i++) {
        const k = hunkKey(path, i)
        st === 'all' ? selectedHunks.delete(k) : selectedHunks.add(k)
      }
    },
  } : null)

  // Swallows EVERYTHING — returning false would let unhandled keys fall
  // through to split.handleKey (which toggles 'p' parallel — meaningless in
  // review and confusing when the StatusBar indicator silently flips).
  function handleReviewKey(key: string): boolean {
    const cur = allHunks[hunkCursor]
    switch (key) {
      case 'j': if (hunkCursor < allHunks.length - 1) hunkCursor++; break
      case 'k': if (hunkCursor > 0) hunkCursor--; break
      case ' ': {
        if (!cur) break
        const k = cur.key
        selectedHunks.has(k) ? selectedHunks.delete(k) : selectedHunks.add(k)
        break
      }
      case 'a': case 'n': {
        if (!cur) break
        for (const h of allHunks) {
          if (h.path !== cur.path) continue
          key === 'a' ? selectedHunks.add(h.key) : selectedHunks.delete(h.key)
        }
        break
      }
      case 'A': for (const h of allHunks) selectedHunks.add(h.key); break
      case 'N': selectedHunks.clear(); break
    }
    return true
  }

  // SSE-triggered diff reload during review → allHunks recomputes → keys no
  // longer correspond to the same hunks (different hunk count, different
  // oldStart positions). Half-complete selection against a moved target is
  // the same footgun as "inline modes not preserved across tabs". Kick out.
  let reviewDiffSnapshot: string = $state('')
  $effect(() => {
    if (!split.review) { reviewDiffSnapshot = ''; return }
    if (reviewDiffSnapshot === '') { reviewDiffSnapshot = diffContent; return }
    if (reviewDiffSnapshot !== diffContent) {
      cancelInlineModes()
      setMessage({ kind: 'warning', text: 'Review cancelled — revision changed underneath' })
    }
  })

  function enterSplitMode(asReview = false) {
    if (!selectedRevision || checkedRevisions.size > 0 || files.loading) return
    cancelInlineModes()
    if (!switchToLogView()) return
    if (asReview) {
      // Seed all-accepted. parseDiffCached is already warm (DiffPanel parsed
      // this diff when the user navigated here). reviewParsedDiff isn't
      // derived yet (split.review still false), so parse directly.
      for (const f of parseDiffCached(diffContent)) {
        for (let i = 0; i < f.hunks.length; i++) selectedHunks.add(hunkKey(f.filePath, i))
      }
      hunkCursor = 0
    } else {
      fileSel.init(changedFiles)
    }
    split.enter(effectiveId(selectedRevision.commit), asReview)
  }
  const enterReviewMode = () => enterSplitMode(true)

  async function executeSplit() {
    if (!split.revision) return
    if (split.review) return executeHunkReview()

    // File-level split (unchanged)
    if (fileSel.set.size === fileSel.total) {
      setMessage({ kind: 'warning', text: 'Uncheck at least one file to split out' })
      return
    }
    if (fileSel.set.size === 0) {
      setMessage({ kind: 'warning', text: 'Select at least one file to keep' })
      return
    }
    return withMutation(async () => {
      try {
        const files = [...fileSel.set]
        const revision = split.revision
        const result = await api.split(revision, files, split.parallel || undefined)
        cancelInlineModes()
        setMessage(mutationMessage(`Split ${revision.slice(0, 8)} (${files.length} files stay)`, result))
        clearChecks()
        await loadLog()
      } catch (e) {
        showError(e)
      }
    })
  }

  async function executeHunkReview() {
    const total = allHunks.length
    if (selectedHunks.size === total) {
      setMessage({ kind: 'warning', text: 'Reject at least one hunk (Space to toggle)' })
      return
    }
    if (selectedHunks.size === 0) {
      setMessage({ kind: 'warning', text: 'Accept at least one hunk' })
      return
    }

    const revision = split.revision
    const typeOf = (path: string) => normalizeFileType(
      changedFiles.find(f => f.path === path)?.type ?? 'M'
    )
    const plan = planHunkSpec(reviewParsedDiff, selectedHunks, typeOf)

    // No partials → every file is all-or-none → file-level split is exact
    // AND works in SSH. Free optimization; also the only path SSH can take.
    if (plan.partials.length === 0) {
      const accepted = reviewParsedDiff
        .filter(f => fileSelectionState(f, selectedHunks) === 'all')
        .map(f => f.filePath)
      return withMutation(async () => {
        try {
          const result = await api.split(revision, accepted)
          cancelInlineModes()
          setMessage(mutationMessage(`Reviewed ${revision.slice(0, 8)} (${selectedHunks.size}/${total} hunks)`, result))
          clearChecks()
          await loadLog()
        } catch (e) { showError(e) }
      })
    }

    // Partials need left-content for forward-patching. For single-parent
    // commits, jj's $left === parent tree === api.fileShow(parentId) — safe.
    //
    // Merge commits: jj's $left is the AUTO-MERGED tree (tree-merge of all
    // parents, possibly with conflict markers), NOT parent[0]. Verified by
    // probe — `jj split --tool` on a merge materializes $left with `<<<<<<<`
    // markers when the auto-merge conflicts. api.fileShow(parents[0]) returns
    // a DIFFERENT tree → applyHunks aligns hunks computed against an N-line
    // auto-merge onto a K-line parent → silently corrupt output. Block it.
    // File-level (no-partials fallback above) still works for merges.
    const parents = selectedRevision?.commit.parent_ids ?? []
    if (parents.length > 1) {
      setMessage({ kind: 'warning',
        text: "Per-hunk review on merge commits isn't supported. Use a/n to toggle whole files." })
      return
    }
    const parentId = parents[0]
    if (!parentId) {
      setMessage({ kind: 'error', text: 'Cannot review root commit at hunk level' })
      return
    }

    return withMutation(async () => {
      try {
        const lefts = new Map<string, string>()
        await Promise.all(plan.partials
          .filter(p => !p.leftIsEmpty)
          .map(p => api.fileShow(parentId, p.path)
            .then(r => lefts.set(p.path, r.content))))

        const spec = resolvePlan(plan, lefts)
        // `jj split -m X` sets the FIRST (selected=accepted) commit's
        // description; the second keeps the original. `-m ""` would wipe the
        // accepted commit's description → user loses their message on the
        // half that matters. Pass what we already have loaded.
        const result = await api.splitHunks(revision, spec, fullDescription)
        cancelInlineModes()
        setMessage(mutationMessage(`Reviewed ${revision.slice(0, 8)} (${selectedHunks.size}/${total} hunks)`, result))
        clearChecks()
        await loadLog()
      } catch (e) {
        // 501 in SSH lands here with a clear backend message. User can
        // a/n to whole-file granularity and Enter again.
        showError(e)
      }
    })
  }

  let squashFileCount = $derived.by(() => {
    if (!squash.active || fileSel.total === 0) return null
    return { selected: fileSel.set.size, total: fileSel.total }
  })

  let splitFileCount = $derived.by(() => {
    if (!split.active) return null
    if (split.review) {
      return allHunks.length > 0
        ? { selected: selectedHunks.size, total: allHunks.length }
        : null
    }
    return fileSel.total > 0
      ? { selected: fileSel.set.size, total: fileSel.total }
      : null
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
    fileSel.clear()
    selectedHunks.clear()
    hunkCursor = 0
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

  // --- Revset help popover ---
  let revsetHelpOpen = $state(false)
  let revsetHelpPopoverEl: HTMLElement | undefined = $state(undefined)

  function applyRevsetExample(revset: string) {
    revsetHelpOpen = false
    revsetFilter = revset
    handleRevsetSubmit()
  }

  // Click-outside + Escape close for the help popover.
  $effect(() => {
    if (!revsetHelpOpen) return
    const close = (e: Event) => {
      if (e instanceof KeyboardEvent && e.key !== 'Escape') return
      if (e instanceof MouseEvent && revsetHelpPopoverEl?.contains(e.target as Node)) return
      revsetHelpOpen = false
    }
    const id = setTimeout(() => {
      document.addEventListener('click', close)
      document.addEventListener('keydown', close)
    }, 0)
    return () => {
      clearTimeout(id)
      document.removeEventListener('click', close)
      document.removeEventListener('keydown', close)
    }
  })

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
    // Gate preventDefault on diffPanelRef — otherwise branches view eats
    // the browser's native find shortcut without opening any search UI.
    if (e.key === 'f' && diffPanelRef) {
      e.preventDefault()
      diffPanelRef.openSearch()
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
    // Hunk-review j/k/Space/a/n/A/N take over. Routed here (not in
    // split.handleKey) because allHunks is derived from parseDiffCached
    // (App-owned); the mode factory can't see it.
    if (split.review && handleReviewKey(e.key)) { e.preventDefault(); return }

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
      case '1': e.preventDefault(); switchToLogView(); return true
      case '2': e.preventDefault(); activeView = 'branches'; return true
      // 3/4 open bottom drawers. Switch to log first so the drawer actually
      // renders (evolog/oplog are gated on activeView==='log' — they'd steal
      // vertical space from the bookmarks panel otherwise).
      case '3': e.preventDefault(); switchToLogView(); toggleOplog(); return true
      case '4': e.preventDefault(); switchToLogView(); toggleEvolog(); return true
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
      case '/': e.preventDefault(); revsetInputEl?.focus(); break
      case ']': e.preventDefault(); diffPanelRef?.stepFile(1); break
      case '[': e.preventDefault(); diffPanelRef?.stepFile(-1); break
      case 'E': e.preventDefault(); toggleEvolog(); break
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
  // If stale events occur during inline mode OR a modal, defer refresh to
  // when the suppressing condition clears. Same variable for both — the
  // deferred-refresh effect below fires when neither is active.
  let staleWhileSuppressed = false
  $effect(() => {
    return onStale(() => {
      if (!loading && !mutating && !anyModalOpen && !inlineMode) loadLog()
      else if (inlineMode || anyModalOpen) staleWhileSuppressed = true
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
  $effect(() => onStaleWC((s) => { workspaceStale = s }))

  // Raw setTimeout escapes {#key} remount — clear on tab-switch unmount so
  // stale closures don't keep the old instance's signals alive.
  onDestroy(() => {
    clearTimeout(messageClearTimer)
    clearTimeout(navDebounceTimer)
    clearTimeout(evologDebounceTimer)
    cancelAnimationFrame(navRafId)
  })
  $effect(() => {
    if (!inlineMode && !anyModalOpen && staleWhileSuppressed) {
      staleWhileSuppressed = false
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
  // Gate on loadedTarget — at mount diffLoading starts false (loader initial),
  // so without this the effect would fire on an empty panel, scroll clamp to 0,
  // and consume the saved position before content arrives.
  $effect(() => {
    if (pendingScrollRestore == null || diffLoading || !diffPanelRef || !loadedTarget) return
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
            onclick={() => { if (!inlineMode) switchToLogView() }}
            disabled={inlineMode}
          >◉ Revisions <kbd class="nav-hint">1</kbd></button>
          <button
            class="toolbar-nav-btn"
            class:toolbar-nav-active={activeView === 'branches'}
            onclick={() => { if (!inlineMode) activeView = 'branches' }}
            disabled={inlineMode}
          >⑂ Branches <kbd class="nav-hint">2</kbd></button>
        </nav>
        <span class="toolbar-divider"></span>
        <!-- Drawer toggles — semantically distinct from the nav tabs above
             (they open bottom panels, not swap the right column). Active state
             reflects drawer visibility, not current view. -->
        <button
          class="toolbar-nav-btn"
          class:toolbar-nav-active={oplogOpen}
          onclick={() => { if (!inlineMode) { switchToLogView(); toggleOplog() } }}
          disabled={inlineMode}
        >⟲ Oplog <kbd class="nav-hint">3</kbd></button>
        <!-- Not gated on selectedRevision — toggleEvolog already handles the
             null case (panel opens empty, populates once a revision is
             selected). Disabled-during-initial-load was confusing. -->
        <button
          class="toolbar-nav-btn"
          class:toolbar-nav-active={evologOpen}
          onclick={() => { if (!inlineMode) { switchToLogView(); toggleEvolog() } }}
          disabled={inlineMode}
        >◐ Evolog <kbd class="nav-hint">4</kbd></button>
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

    <div class="workspace">
        <div class="revision-panel-wrapper" style="width: {config.revisionPanelWidth}px">
          <!-- Revset filter input — owned by App so programmatic revset changes
               (bookmark click, visibility toggle, smart views) are direct assignments.
               Previously lived inside RevisionGraph with 4 callback props threading
               control back up; extracted to eliminate the ownership inversion. -->
          <div class="revset-filter-bar">
            <span class="revset-icon">$</span>
            <input
              bind:this={revsetInputEl}
              value={revsetFilter}
              oninput={(e: Event) => { revsetFilter = (e.target as HTMLInputElement).value }}
              class="revset-input"
              type="text"
              placeholder="revset filter (press / to focus)"
              onkeydown={(e: KeyboardEvent) => {
                if (e.key === 'Enter') {
                  e.preventDefault()
                  handleRevsetSubmit()
                } else if (e.key === 'Escape') {
                  e.preventDefault()
                  clearRevsetFilter()
                  revsetInputEl?.blur()
                }
              }}
            />
            {#if revsetFilter}
              <button class="revset-clear" onclick={clearRevsetFilter} title="Clear filter (Escape)">x</button>
            {/if}
            <button class="revset-help" onclick={() => revsetHelpOpen = !revsetHelpOpen} title="Revset help">?</button>
            {#if revsetHelpOpen}
              <div class="revset-help-popover" bind:this={revsetHelpPopoverEl}>
                {#snippet ex(revset: string)}
                  <button class="help-ex" onclick={() => applyRevsetExample(revset)}>{revset}</button>
                {/snippet}
                <p><b>Default</b>: when empty, jj uses your <code>revsets.log</code> config — typically your WIP stack + recent mutable work, <i>not</i> all history.</p>
                <p><b>Remote toggles</b>: eye icons in the Branches view (<kbd>2</kbd>) add remote bookmarks to the visible set. <i>Only applies when this box is empty or auto-set</i> — they won't override a custom query you typed.</p>
                <p><b>See everything</b>: {@render ex('all()')} or {@render ex('::')} (capped at 500)</p>
                <p class="help-examples">
                  Common: {@render ex('mine()')} · {@render ex('trunk()..@')} · {@render ex('ancestors(@, 20)')}
                </p>
              </div>
            {/if}
          </div>
          <!-- Smart-view preset chips. Same mechanism as the (?) popover's
               examples — direct revsetFilter assignment + submit. No when()
               gates: Conflicts/Divergent always render; clicking on a clean
               repo → empty graph is self-explanatory. A gate reading
               `revisions.some(conflicted)` would see only what's LOADED
               (circularly hides the chip that would find them). -->
          <div class="preset-chips">
            {#snippet chip(revset: string, label: string, count?: number)}
              {@const active = revsetFilter === revset}
              <!-- Active chip → toggle off. Re-applying the same revset would
                   fire handleRevsetSubmit → diff.reset + clearChecks + reload,
                   wiping nav position for a no-op. -->
              <button
                class="preset-chip"
                class:active={active}
                onclick={() => applyRevsetExample(active ? '' : revset)}
                title={revset}
              >{label}{#if count !== undefined} <span class="chip-count">{count}</span>{/if}</button>
            {/snippet}
            {#each STATIC_PRESETS as p (p.key)}
              {@render chip(p.revset, p.label)}
            {/each}
            {#if pullRequests.length > 0}
              {@render chip(prsRevset, 'PRs', pullRequests.length)}
            {/if}
          </div>
          <RevisionGraph
            bind:this={revisionGraphRef}
            {revisions}
            {selectedIndex}
            {checkedRevisions}
            {loading}
            {mutating}
            {viewLabel}
            {lastCheckedIndex}
            onselect={activeView === 'branches' ? selectRevisionCursorOnly : selectRevision}
            oncheck={toggleCheck}
            onrangecheck={rangeCheck}
            oncontextmenu={openRevisionContextMenu}
            onnewfromchecked={handleNewFromChecked}
            onabandonchecked={handleAbandonChecked}
            onclearchecks={clearChecksAndReload}
            onbookmarkclick={openBookmarkModal}
            {rebase}
            {squash}
            {split}
            isDark={darkMode}
            {prByBookmark}
            {impliedCommitIds}
            remoteVisibility={repoVisibility}
          />
        </div>

        <!-- svelte-ignore a11y_no_static_element_interactions -->
        <div class="panel-divider" class:divider-active={draggingDivider} onmousedown={startDividerDrag}></div>

        {#if activeView === 'branches'}
          <!-- Branches view: graph stays visible on the left so clicking a
               bookmark shows its position immediately. jumpToBookmark updates
               selectedIndex without switching view. -->
          <BookmarksPanel
            bind:this={bookmarksPanelRef}
            bookmarks={bookmarksPanel.value}
            loading={bookmarksPanel.loading}
            error={bookmarksPanel.error}
            {defaultRemote}
            {allRemotes}
            remoteVisibility={repoVisibility}
            {prByBookmark}
            graphCommitId={selectedRevision?.commit.commit_id}
            onjump={jumpToBookmark}
            onexecute={handleBookmarkOp}
            onrefresh={() => bookmarksPanel.load()}
            onclose={switchToLogView}
            onvisibilitychange={async (vis) => {
              // loadInfo() may have failed at mount (SSH slow-start); retry once
              // here so toggles work after recovery instead of silently dropping.
              if (!repoPath) await loadInfo()
              if (!repoPath) return  // still failed — drop rather than write under '' key
              config.remoteVisibility = { ...config.remoteVisibility, [repoPath]: vis }
            }}
            oncontextmenu={showBookmarkContextMenu}
            ontrackmenu={showTrackMenu}
          />
        {:else if divergence.active}
          <!-- {#key} enforces what DivergencePanel assumes: changeId never
               changes in-place. createDivergenceMode.enter() doesn't guard
               against re-entry; the key does. Fresh mount = no stale-promise
               races, no gen counter needed in the version-load path. -->
          {#key divergence.changeId}
            <DivergencePanel
              changeId={divergence.changeId}
              onkeep={plan => runDivergenceResolution(() => executeKeepPlan(plan))}
              onsplit={id => runDivergenceResolution(() => splitIdentity(id))}
              onsquash={(from, into) => runDivergenceResolution(() => squashDivergent(from, into))}
              onabandon={id => runDivergenceResolution(() => abandonMutable(id))}
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
            fileSelectionMode={squash.active ? 'squash' : (split.active && !split.review) ? 'split' : false}
            {hunkReview}
            selectedFiles={fileSel.set}
            ontogglefile={fileSel.toggle}
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

      {#if activeView === 'log' && evologOpen}
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

      {#if activeView === 'log' && oplogOpen}
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

  {#if displayMessage}
    <MessageBar message={displayMessage} expanded={messageExpanded}
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
    ontrackmenu={showTrackMenu}
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
    flex-direction: column;
    overflow: hidden;
  }

  /* --- Revset filter --- */
  .revset-filter-bar {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 4px 8px;
    background: var(--mantle);
    border-bottom: 1px solid var(--surface0);
    flex-shrink: 0;
    position: relative; /* anchor for help popover */
  }

  .revset-icon {
    color: var(--surface2);
    font-size: 12px;
    font-weight: 700;
    flex-shrink: 0;
  }

  .revset-input {
    flex: 1;
    background: var(--base);
    color: var(--text);
    border: 1px solid var(--surface1);
    border-radius: 3px;
    padding: 3px 6px;
    font-family: inherit;
    font-size: 12px;
    outline: none;
    transition: border-color 0.15s ease;
  }

  .revset-input:focus {
    border-color: var(--amber);
  }

  .revset-input::placeholder {
    color: var(--surface1);
  }

  .preset-chips {
    display: flex;
    gap: 4px;
    flex-wrap: wrap;
    padding: 0 8px 4px;
    background: var(--mantle);
    border-bottom: 1px solid var(--surface0);
    flex-shrink: 0;
  }
  .preset-chip {
    font-family: inherit;
    font-size: 11px;
    padding: 2px 8px;
    border-radius: 3px;
    background: var(--surface0);
    color: var(--subtext0);
    border: 1px solid transparent;
    cursor: pointer;
    transition: all 0.15s ease;
  }
  .preset-chip:hover { background: var(--surface1); color: var(--text); }
  .preset-chip.active { border-color: var(--amber); color: var(--amber); background: var(--surface0); }
  .chip-count { opacity: 0.6; margin-left: 2px; }

  .revset-clear {
    background: transparent;
    border: none;
    color: var(--surface2);
    cursor: pointer;
    font-family: inherit;
    font-size: 14px;
    padding: 0 4px;
    line-height: 1;
    flex-shrink: 0;
  }

  .revset-clear:hover {
    color: var(--red);
  }

  .revset-help {
    background: transparent;
    border: 1px solid var(--surface1);
    border-radius: 50%;
    width: 16px;
    height: 16px;
    padding: 0;
    color: var(--overlay0);
    cursor: pointer;
    font-family: inherit;
    font-size: 10px;
    font-weight: 600;
    line-height: 14px;
    flex-shrink: 0;
  }
  .revset-help:hover { color: var(--subtext0); border-color: var(--surface2); }

  .revset-help-popover {
    position: absolute;
    top: 100%;
    right: 4px;
    margin-top: 4px;
    width: 320px;
    padding: 12px 14px;
    background: var(--mantle);
    border: 1px solid var(--surface1);
    border-radius: 6px;
    box-shadow: 0 4px 16px rgba(0,0,0,0.25);
    z-index: 10;
    font-size: 12px;
    line-height: 1.5;
  }
  .revset-help-popover p { margin: 0 0 8px; }
  .revset-help-popover p:last-child { margin: 0; }
  .revset-help-popover :is(code, kbd, .help-ex) {
    font-family: var(--font-mono);
    border-radius: 3px;
  }
  .revset-help-popover code {
    font-size: 11px;
    background: var(--surface0);
    padding: 1px 4px;
  }
  .help-ex {
    font-size: 11px;
    background: var(--surface0);
    color: var(--text);
    border: 1px solid var(--surface1);
    padding: 1px 5px;
    cursor: pointer;
  }
  .help-ex:hover {
    background: var(--bg-selected);
    border-color: var(--amber);
    color: var(--amber);
  }
  .revset-help-popover kbd {
    font-size: 10px;
    border: 1px solid var(--surface1);
    padding: 0 3px;
  }
  .help-examples { color: var(--subtext0); font-size: 11px; }

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

  /* Toolbar kbd hints use the global .nav-hint base; this just adds the
     active-amber tint. Keeps the kbd styling single-source. */
  .toolbar-nav-active .nav-hint {
    color: var(--amber);
    border-color: color-mix(in srgb, var(--amber) 30%, transparent);
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
