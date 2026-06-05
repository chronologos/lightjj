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
    /** Cursor identity (effectiveId of the selected revision), not an index —
     *  the log can shift under a backgrounded tab, and an index snapshot would
     *  silently re-bind to whatever row lands at that position. */
    selectedId: string | null
    revsetFilter: string
    activeView: 'log' | 'branches'
    diffScrollTop: number
  }
</script>

<script lang="ts">
  import type { Snippet } from 'svelte'
  import { untrack, onDestroy, tick } from 'svelte'
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

  import { api, effectiveId, multiRevset, computeConnectedCommitIds, getCached, prefetchRevision, prefetchFilesBatch, onStale, onStaleWC, onPollFail, onSSEState, onNavigate, wireAutoRefresh, clearAllCaches, bookmarkPushFlags, agentBaseURL, type LogEntry, type FileChange, type OpEntry, type EvologEntry, type Workspace, type Alias, type PullRequest, type DiffTarget, type Bookmark, type MutationResult, type StaleImmutableGroup, type NavigatePayload } from './lib/api'
  import { setDetectedJJVersion, missingJJFeatures } from './lib/jj-features.svelte'
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
  import DestinationInput from './lib/DestinationInput.svelte'
  import GitModal from './lib/GitModal.svelte'
  import ContextMenu, { type ContextMenuItem } from './lib/ContextMenu.svelte'
  import DivergencePanel from './lib/DivergencePanel.svelte'
  import { executeKeepPlan, splitIdentity, squashDivergent, abandonMutable, type DivergenceActionResult } from './lib/divergence-actions'
  import { createRebaseMode, createSquashMode, createSplitMode, createDivergenceMode, createFileSelection, targetModeLabel, type ModeKind } from './lib/modes.svelte'
  import { planRecoverAll, recoverAllMessage } from './lib/workspace-recovery'
  import { routeKeydown, type ActiveView } from './lib/keyboard-gate'
  import { computeSlide, type SlideDir } from './lib/slide'
  import { createLoader } from './lib/loader.svelte'
  import { createOpSync, type OpSyncOptions } from './lib/op-sync.svelte'
  import { createRevisionNavigator } from './lib/revision-navigator.svelte'
  import { createCommentVisibility } from './lib/comment-visibility.svelte'
  import { config, FONT_SIZE_MIN, FONT_SIZE_MAX, FONT_SIZE_DEFAULT } from './lib/config.svelte'
  import { THEMES, isThemeDark, loadGhosttyThemes, applyGhosttyTheme, type GhosttyTheme } from './lib/themes'
  import { APP_VERSION, CURRENT_RELEASE_URL, RELEASES_URL, parseSemver, semverMinorGt, checkForUpdate, type UpdateInfo } from './lib/version'
  import { FEATURES, type TutorialFeature } from './lib/tutorial-content'
  import WelcomeModal from './lib/WelcomeModal.svelte'
  import ConfigModal from './lib/ConfigModal.svelte'
  import { buildVisibilityRevset, revsetQuote, syncVisibility } from './lib/remote-visibility'
  import ConflictQueue from './lib/ConflictQueue.svelte'
  import FileHistoryPanel from './lib/FileHistoryPanel.svelte'
  import { createMergeController } from './lib/merge-controller.svelte'
  import type { DocSession } from './lib/doc-session.svelte'

  // --- Global state ---
  // initialState-hydrated vars: restored on tab-switch-back via AppShell's
  // snapshot. Everything else starts fresh on mount.
  //
  // Cursor IDENTITY — effectiveId (change_id; commit_id for divergent/hidden)
  // of the selected revision. The index is DERIVED from this (`selectedIndex`
  // in the Derived section below): a refresh that inserts/removes rows shifts
  // positions, but the cursor stays on the same revision and the diff panel
  // never silently re-binds to a different one. All selection writes go
  // through selectRevision/selectRevisionCursorOnly/loadLog reconciliation.
  let selectedId: string | null = $state(init?.selectedId ?? null)
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

  // Persistent poll/snapshot-failure state. String = failing with that error
  // text; null = healthy. Set via onPollFail (server broadcasts after ≥ 5
  // consecutive errors in either snapshotLoop or sshPollLoop). Surfaced as a
  // MessageBar warning; when the error text mentions index.lock, the warning
  // includes a "Delete git lockfile" action. Auto-clears on recovery.
  let pollFailError = $state<string | null>(null)

  // Stale immutable detection — force-push leftovers. Refreshed after git
  // fetch/push (handleGitOp's after hook) and by staleImmSync's throttled
  // op-id staleness; cleared optimistically after cleanup. keepValueOnError:
  // detection is best-effort, a failed scan keeps the last known groups.
  const staleImm = createLoader(() => api.staleImmutable(), [] as StaleImmutableGroup[], undefined, { keepValueOnError: true })
  let staleImmutableGroups = $derived(staleImm.value)

  let updateInfo: UpdateInfo | null = $state(null)
  checkForUpdate().then(info => { updateInfo = info })

  let descriptionEditing: boolean = $state(false)
  let descriptionDraft: string = $state('')
  let commitMode: boolean = $state(false) // when true, description editor saves via commit instead of describe

  let checkedRevisions = new SvelteSet<string>()
  let lastCheckedIndex: number = $state(-1)
  // navDebounceTimer + navRafId moved to revision-navigator — nav.cancel()
  // clears both. App keeps evologDebounceTimer (separate panel, separate timer).
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
  const commentVis = createCommentVisibility()
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
  // Ordered scope-narrow → scope-broad (WIP ⊂ My work ⊂ Default ⊂ All), then
  // the two triage filters, then the dynamic PRs chip (rendered after this
  // list). desc is the human-readable half of the tooltip; the revset is
  // appended on a second line so power users can copy/learn the syntax.
  const STATIC_PRESETS = [
    { key: 'wip',       label: 'WIP',       revset: 'trunk()..@',
      desc: 'Your current stack — commits between trunk and the working copy' },
    { key: 'mine',      label: 'My work',   revset: 'mine() & mutable()',
      desc: 'All mutable commits you authored, across stacks' },
    // jj's built-in default (what you get with no revsets.log config).
    // Config-independent — useful when a custom revsets.log uses mine() and
    // a bot-authored commit holding your bookmark drops out.
    { key: 'default',   label: 'Default',   revset: 'present(@) | ancestors(immutable_heads().., 2) | present(trunk())',
      desc: "jj's built-in log view (trunk + working copy + recent heads), ignoring any custom revsets.log" },
    // ~ root() drops the virtual root commit. Bounded by the backend's 500-row
    // limit; all() is set enumeration (no per-commit predicate) so it stays
    // fast even on huge histories.
    { key: 'all',       label: 'All',       revset: 'all() ~ root()',
      desc: 'Every visible commit (most recent 500)' },
    // & mutable() is a 60× speedup on large repos (conflicts() alone is
    // O(commits×tree-check) — see internal/jj/commands.go ConflictList for the
    // same gate on the backend). Semantically lossless: an immutable conflict
    // can't be resolved anyway.
    { key: 'conflicts', label: 'Conflicts', revset: 'conflicts() & mutable()',
      desc: 'Mutable commits with unresolved merge conflicts' },
    { key: 'divergent', label: 'Divergent', revset: '(divergent() & mutable())::',
      desc: 'Divergent changes (same change_id, different commit_ids) and their descendants' },
  ] as const

  // The only dynamic preset. Empty list → '' (chip hidden by {#if}, never
  // hits jj). revsetQuote escapes revset operators in bookmark names.
  // $derived.by thunk sidesteps TDZ (pullRequests declared at ~:286).
  // present() wraps each — a PR can outlive its local bookmark (deleted
  // after merge, or the bookmark only exists @origin). Without present(),
  // one missing bookmark → "Revision X doesn't exist" → whole chip errors.
  const prsRevset = $derived.by(() =>
    pullRequests.length === 0
      ? ''
      : `ancestors(${pullRequests.map(p => `present(${revsetQuote(p.bookmark)})`).join(' | ')}, 3) | @`
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
  // Sync revsetFilter to visibility toggles. Decision logic extracted to
  // syncVisibility() (remote-visibility.ts) for table-driven testing — the
  // state machine has enough edges (mount, null→determinate, user-cleared,
  // user-tracking, toggle-while-custom) that inline reasoning was producing
  // bugs. See remote-visibility.test.ts for the full transition table.
  let prevVisibilityRevset: string | undefined = undefined
  $effect(() => {
    const vr = visibilityRevset
    untrack(() => {
      const { nextPrev, apply } = syncVisibility(vr, prevVisibilityRevset, revsetFilter)
      prevVisibilityRevset = nextPrev
      if (apply !== null) { revsetFilter = apply; handleRevsetSubmit() }
    })
  })

  // Abort predicate for nav.loadDiffAndFiles — re-checked after its await.
  // User checking a revision during the fetch means the multi-check $effect
  // below already fired; don't clobber it.
  const hasChecked = () => checkedRevisions.size > 0

  let revisions = $derived(log.value)
  let loading = $derived(log.loading)
  let diffContent = $derived(diff.value)
  let diffLoading = $derived(diff.loading)
  // What's LOADED, not what's selected. Passed to DiffPanel as diffTarget.
  // Set SYNCHRONOUSLY at navigate — leads the diff content (progressive render).
  let loadedTarget = $derived(nav.loadedTarget)
  let diffPending = $derived(nav.diffPending)
  let diffContentKey = $derived(nav.diffContentKey)
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
  // `/` in rebase/squash mode → type a destination (off-revset bookmark or
  // change_id) instead of j/k cursor. Submit calls executeRebase/Squash
  // directly with the typed value; no state survives close.
  let destInputOpen: boolean = $state(false)
  let gitModalOpen: boolean = $state(false)
  let configModalOpen: boolean = $state(false)
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
  let activeView: ActiveView = $state(
    init?.activeView === 'branches' ? 'branches' : 'log'
  )

  // Merge mode — extracted to merge-controller.svelte.ts so the gen-counter
  // race invariants (bug_009/013/039/040/047/048/051) are unit-testable.
  // conflictQueueRef stays here: bind:this needs direct write access.
  let conflictQueueRef: ConflictQueue | undefined = $state()
  const merge = createMergeController({
    onError: e => setMessage(errorMessage(e)),
    onWarning: text => setMessage({ kind: 'warning', text }),
    withMutation,
    reload: () => logSync.refresh(),
    getWorkingCopyChangeId: () => workingCopyEntry?.commit.change_id,
  })

  // File history overlay — right-click file → "View history". Null = closed.
  // {#key fileHistoryPath} remounts per path (fresh cursors free).
  let fileHistoryPath: string | null = $state(null)
  let fileHistoryPin: string | null = $state(null)
  let fileHistoryRef: FileHistoryPanel | undefined = $state()

  function openFileHistory(path: string) {
    fileHistoryPath = path
    fileHistoryPin = diffTarget?.kind === 'single' ? diffTarget.commitId : null
  }

  // Doc mode — ProseMirror view of a single .md with range-anchored comments.
  // Per-file like FileHistory, but as an activeView (full-width, hides graph)
  // not an overlay. {#key docFilePath} remounts the lazy-loaded view per path.
  let docFilePath: string | null = $state(null)
  let docSession: DocSession | null = $state(null)
  let docViewRef: { scrollTo: (pos: number) => void; applyReplace: (f: number, t: number, s: string) => void } | undefined = $state()
  let docRailRef: { stepComment: (dir: 1 | -1) => boolean } | undefined = $state()
  let docEditable = $state(false)
  let docStale = $state(false)
  let docAgentPopover = $state(false)
  let docFocusedComment: string | null = $state(null)
  // Poll for agent-posted comments while doc-mode is open. refreshComments()
  // re-places against the current doc (no version reset, safe while dirty) and
  // skips while a local mutation is in flight, so this never clobbers user
  // state. 4s — well under SSE-level latency expectations for review iteration.
  $effect(() => {
    if (activeView !== 'doc' || !docSession) return
    const s = docSession
    const t = setInterval(() => void s.refreshComments(), 4000)
    return () => clearInterval(t)
  })
  // Route session errors to the single MessageBar surface instead of an inline
  // span that blows out the 34px header on long jj output.
  $effect(() => {
    const err = docSession?.error
    if (err) setMessage(errorMessage(err))
  })
  let docAgentHint = $derived.by(() => {
    if (!docFilePath) return { url: '', remote: '' }
    const base = agentBaseURL()
    const port = window.location.port || '80'
    const local = /^(localhost|127\.0\.0\.1|\[::1\])$/.test(window.location.hostname)
    // tabPath is "/tab/N" — the part of the base URL the CLI needs (it
    // discovers host:port itself). Lead with `lightjj api` (works in
    // curl-denylisted harnesses, auto-discovers the port); curl as fallback.
    const tabPath = base.slice(base.indexOf('/tab/'))
    const docPath = `${tabPath}/api/doc-comments?path=${encodeURIComponent(docFilePath)}`
    return {
      url: `lightjj doc API. Run \`lightjj api GET ${tabPath}/api/agent\` for the contract. This file: \`lightjj api GET '${docPath}'\` (or curl ${base}/api/doc-comments?path=${encodeURIComponent(docFilePath)} if lightjj isn't on PATH).`,
      remote: local ? `ssh -R 8080:localhost:${port} user@agent-host  # then: lightjj api --addr 127.0.0.1:8080 GET ${tabPath}/api/agent` : '',
    }
  })
  // Add-comment bubble state. AnnotationBubble is annotation-coupled (severity
  // select, lineContext, Annotation type) so doc-mode uses a small dedicated
  // input. {x,y} are viewport coords (DocView emits view.coordsAtPos result).
  let docCommentDraft = $state<{ from: number; to: number; x: number; y: number } | null>(null)
  let docCommentDraftBody = $state('')
  let docCommentDraftEl: HTMLTextAreaElement | undefined = $state()
  $effect(() => {
    if (docCommentDraft) tick().then(() => docCommentDraftEl?.focus())
  })

  function submitDocComment() {
    const body = docCommentDraftBody.trim()
    if (!body || !docCommentDraft || !docSession) return
    void docSession.addComment(docCommentDraft.from, docCommentDraft.to, body)
    docCommentDraft = null
  }

  async function handleDocCommit() {
    if (!docSession) return
    const result = await withMutation(() => docSession!.commitBack())
    if (result === 'stale') docStale = true
    else if (result === 'ok') {
      setMessage({ kind: 'success', text: `Saved ${docFilePath}` })
      // Explicit reload (DiffPanel.onfilesaved precedent) — withMutation doesn't
      // call loadLog, and waiting for the SSE round-trip leaves the diff stale
      // for the moment the user Escapes back to log.
      void logSync.refresh()
    }
  }

  async function handleDocOverwrite() {
    if (!docSession) return
    await withMutation(() => docSession!.overwrite())
    docStale = false
    setMessage({ kind: 'success', text: `Saved ${docFilePath} (overwrote external change)` })
    void logSync.refresh()
  }

  async function handleDocReload() {
    if (!docSession) return
    await docSession.reload()
    docStale = false
  }

  async function switchToDocView(path: string) {
    descriptionEditing = false
    cancelInlineModes()
    docFilePath = path
    activeView = 'doc'
    // Lazy import keeps prosemirror (~31KB gzip) out of the main bundle —
    // doc-session pulls pm-schema → prosemirror-{model,state}.
    const { createDocSession } = await import('./lib/doc-session.svelte')
    if (activeView !== 'doc' || docFilePath !== path) return
    docEditable = false
    docStale = false
    docAgentPopover = false
    docFocusedComment = null
    docCommentDraft = null
    docSession = createDocSession(path, () => workingCopyEntry?.commit.commit_id)
    void docSession.import_().catch(e => setMessage(errorMessage(e)))
  }

  function closeDocView() {
    docFilePath = null
    docSession = null
    docStale = false
    docAgentPopover = false
    docFocusedComment = null
    docCommentDraft = null
    switchToLogView()
  }

  // Server-state mirrors, each a loader + (further down) an op-sync that owns its
  // refresh policy. keepValueOnError everywhere: these are best-effort enrichments
  // (SSH mode / missing gh / single workspace all fail their fetches routinely) and
  // a transient failure must not blank what the user already sees.
  const workspaces = createLoader(
    () => api.workspaces(),
    { current: '', workspaces: [] as Workspace[] },
    undefined,
    { keepValueOnError: true },
  )
  // Tri-state on current: '' means UNKNOWN (initial value until the first fetch
  // resolves; stays there if it fails) — see openWorkspaceContextMenu.
  let currentWorkspace = $derived(workspaces.value.current)
  let workspaceList = $derived(workspaces.value.workspaces)
  const aliasesLoader = createLoader(() => api.aliases(), [] as Alias[], undefined, { keepValueOnError: true })
  let aliases = $derived(aliasesLoader.value)
  const prs = createLoader(() => api.pullRequests(), [] as PullRequest[], undefined, { keepValueOnError: true })
  let pullRequests = $derived(prs.value)
  let prByBookmark = $derived(new Map(pullRequests.map(pr => [pr.bookmark, pr])))

  let contextMenu: { items: ContextMenuItem[]; x: number; y: number } | null = $state(null)
  const showContextMenu = (items: ContextMenuItem[], x: number, y: number) => {
    contextMenu = { items, x, y }
  }

  // Open-in-editor is enabled iff the mode-appropriate editorArgs config field
  // is set. Derived from reactive config so a ConfigModal save takes effect
  // immediately (no hard refresh). sshMode comes from api.info() at startup
  // and never flips for the session. Tri-state: undefined until loadInfo
  // resolves so a configured-user with a transient info() failure doesn't see
  // a menu item that 400s on click (the old fail-safe assumed empty editorArgs).
  let sshMode = $state<boolean | undefined>(undefined)
  let editorConfigured = $derived(
    sshMode === undefined ? false
      : sshMode ? config.editorArgsRemote.length > 0
      : config.editorArgs.length > 0
  )

  let anyModalOpen = $derived(paletteOpen || bookmarkModalOpen || bookmarkInputOpen || gitModalOpen || configModalOpen || !!contextMenu || divergence.active || welcomeOpen || !!fileHistoryPath)
  let inlineMode = $derived(rebase.active || squash.active || split.active)
  // Which mode (if any). `inlineMode` answers "is ANY mode active?" for
  // toolbar gates; `activeInlineMode.diffFollows` answers the per-mode
  // question — whether nav should reload the diff or freeze it. onselect
  // previously read `inlineMode` and conflated these.
  let activeInlineMode = $derived(rebase.active ? rebase : squash.active ? squash : split.active ? split : null)
  let diffFrozen = $derived(activeInlineMode ? !activeInlineMode.diffFollows : false)
  let conflictCount = $derived(changedFiles.filter(f => f.conflict).length)

  // Mutation lock — prevents queuing ops against stale/changing state.
  // Covers the full span from mutation start through the post-mutation log refresh.
  // Over SSH each call is ~440ms, so without this a double-click on Abandon
  // could fire two abandon requests against the same (now-stale) revision.
  let mutating = $state(false)

  async function withMutation<T>(fn: () => Promise<T>): Promise<T | undefined> {
    if (mutating) {
      setMessage({ kind: 'warning', text: 'Operation in progress — wait for it to finish' })
      return
    }
    mutating = true
    setMessage(null)
    try { return await fn() }
    finally { mutating = false }
  }

  // --- Theme ---
  // ghosttyThemes dep: isThemeDark reads non-reactive module state, so a
  // saved light ghostty theme on reload would compute darkMode=true (?? true
  // fallback) and never re-derive when the chunk lands.
  let darkMode = $derived((void ghosttyThemes, isThemeDark(config.theme)))
  const cmdKey = typeof navigator !== 'undefined' && navigator.platform.includes('Mac') ? '⌘' : 'Ctrl+'

  // 't' key cycles current ↔ the opposite-luminance default. Per-theme
  // selection is via Cmd+K → "Theme: …". Highlight HTML uses tok-* class
  // names (not inline styles), so a swap is pure CSS — no cache invalidation.
  function toggleTheme() {
    config.theme = darkMode ? 'light' : 'dark'
  }

  let ghosttyThemes = $state<GhosttyTheme[]>([])

  // Own $derived — keyed only on config.theme + ghosttyThemes so the 493
  // children DON'T rebuild on Space-spam / pullRequests (dynamicCommands deps).
  let themeSubmenuCommand = $derived<PaletteCommand>({
    label: 'Theme…', category: 'View', showInCheatsheet: true,
    hint: [...THEMES, ...ghosttyThemes].find(t => t.id === config.theme)?.label,
    action: () => { if (!ghosttyThemes.length) loadGhosttyThemes().then(ts => { ghosttyThemes = ts }) },
    children: [...THEMES, ...ghosttyThemes].map(t => ({
      label: t.label, swatch: t.swatch, action: () => { config.theme = t.id },
      hint: config.theme === t.id ? 'current' : t.dark ? 'dark' : 'light',
    })),
  })

  // `void ghosttyThemes` re-fires after lazy load (applyGhosttyTheme reads
  // non-reactive module state). .theme-switching for one frame suppresses
  // .btn/.seg color transitions animating old→new theme values.
  $effect(() => {
    void ghosttyThemes
    const root = document.documentElement
    root.classList.add('theme-switching')
    applyGhosttyTheme(config.theme)
    root.dataset.theme = config.theme
    root.classList.toggle('light', !darkMode)
    // Double-rAF: single rAF fires BEFORE style recalc in the same frame
    // (event→microtask→rAF→style→paint), so the class would be removed
    // before the browser observes the new theme + suppression together.
    requestAnimationFrame(() => requestAnimationFrame(() =>
      root.classList.remove('theme-switching')))
  })
  // Typography. setProperty on :root overrides the theme.css defaults (inline
  // style > stylesheet); removeProperty falls back to them. Empty string = "use
  // default", so a hand-edited config.json with the key absent and one with ""
  // behave identically. Clamping lives in the config.fontSize getter.
  // The four --font-md-* vars form a fallback chain in theme.css :root
  // (display → heading → body; code → mono). Empty config → removeProperty →
  // the theme.css default var() chain takes over, so a one-face config sets
  // only fontMdBody and the rest cascade.
  const FONT_VARS = [
    ['--font-ui',         () => config.fontUI],
    ['--font-mono',       () => config.fontMono],
    ['--font-md-body',    () => config.fontMdBody],
    ['--font-md-heading', () => config.fontMdHeading],
    ['--font-md-display', () => config.fontMdDisplay],
    ['--font-md-code',    () => config.fontMdCode],
  ] as const
  $effect(() => {
    const s = document.documentElement.style
    s.setProperty('--font-size', `${config.fontSize}px`)
    for (const [cssVar, get] of FONT_VARS) {
      const v = get()
      v ? s.setProperty(cssVar, v) : s.removeProperty(cssVar)
    }
  })

  // Saved config.theme might be a ghostty id — load eagerly so the first
  // paint after hydration has the vars. On load failure, fall back to a
  // builtin so the UI isn't unstyled (catch in loadGhosttyThemes returns []).
  $effect(() => {
    if (!THEMES.some(t => t.id === config.theme)) {
      loadGhosttyThemes().then(ts => {
        ghosttyThemes = ts
        if (!ts.some(t => t.id === config.theme)) config.theme = 'dark'
      })
    }
  })

  // --- Refs ---
  let revisionGraphRef: ReturnType<typeof RevisionGraph> | undefined = $state(undefined)
  let diffPanelRef: ReturnType<typeof DiffPanel> | undefined = $state(undefined)
  let bookmarksPanelRef: ReturnType<typeof BookmarksPanel> | undefined = $state(undefined)
  let revsetInputEl: HTMLInputElement | undefined = $state(undefined)
  let wsDropdownOpen: boolean = $state(false)
  let wsSelectorEl: HTMLElement | undefined = $state(undefined)

  // --- Derived ---
  // Scoped so it only re-scans when revisions changes, not on every loading/mutating flip.
  // Index-based so the '@' key and post-load reset share the same scan.
  let workingCopyIndex = $derived(revisions.findIndex(r => r.commit.is_working_copy))
  let workingCopyEntry = $derived(workingCopyIndex >= 0 ? revisions[workingCopyIndex] : undefined)

  // Cursor INDEX, derived from the identity (selectedId). Existing consumers
  // (j/k bounds, mode destination targeting, RevisionGraph prop, slide) keep
  // reading a number under the same name. Falls back to the working-copy row
  // when the id isn't in the current list (external abandon, narrower revset);
  // -1 only when the list is empty or has no working copy either. loadLog's
  // reconciliation rewrites selectedId on fallback so the two stay consistent.
  let selectedIndex = $derived.by(() => {
    if (selectedId !== null) {
      const id = selectedId
      const idx = revisions.findIndex(r => effectiveId(r.commit) === id)
      if (idx >= 0) return idx
    }
    return workingCopyIndex
  })

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

  // Live progress line from streamMutation (git push/fetch). Takes precedence
  // over the generic "Working..." while a stream is feeding it.
  let mutationProgress: string = $state('')

  let statusText = $derived.by(() => {
    if (inlineMode) return ''
    if (mutating) return mutationProgress || 'Working...'
    if (loading) return revisions.length > 0 ? 'Refreshing...' : 'Loading revisions...'
    if (diffLoading) return 'Loading diff...'
    if (activeView === 'branches') {
      const bms = bookmarksPanel.value
      const local = bms.filter(b => b.local).length
      const remoteOnly = bms.length - local
      return `${bms.length} bookmark${bms.length !== 1 ? 's' : ''} · ${local} local · ${remoteOnly} remote-only`
    }
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
      // the single-rev diff — loadedTarget would stay on the multi target.
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
    { label: 'Next / Previous hunk', shortcut: '] / [', category: 'Navigation', action: noop, infoOnly: true },
    { label: 'Next / Previous annotation', shortcut: '} / {', category: 'Navigation', action: noop, infoOnly: true },
    { label: 'Toggle markdown preview', shortcut: 'm', category: 'Navigation', action: () => diffPanelRef?.togglePreviewActive(), when: () => !inlineMode },
    { label: 'Open file as document…', category: 'Navigation', action: () => {
      const p = prompt('Open as document (repo-relative .md path):')
      if (p) void switchToDocView(p)
    }, when: () => !inlineMode },

    // Revisions — !inlineMode comes from INLINE_GATED_CATEGORIES; when() here
    // only adds the per-entry conditions.
    { label: 'Refresh revisions', shortcut: 'r', category: 'Revisions', action: userRefresh },
    { label: 'Hard refresh (clear all caches)', category: 'Revisions', action: () => { clearAllCaches(); clearDiffCaches(); userRefresh(true) } },
    { label: 'New revision', shortcut: 'n', category: 'Revisions', action: () => {
      if (checkedRevisions.size > 0) handleNewFromChecked()
      else if (selectedRevision) handleNew(effectiveId(selectedRevision.commit))
    }, when: () => !!selectedRevision || checkedRevisions.size > 0 },
    { label: 'Edit description', shortcut: 'e', category: 'Revisions', action: startDescriptionEdit, when: () => !!selectedRevision && checkedRevisions.size === 0 },
    { label: 'Edit selected revision', category: 'Revisions', action: () => handleEdit(effectiveId(selectedRevision!.commit)), when: () => !!selectedRevision },
    { label: 'Abandon selected revision', category: 'Revisions', action: () => handleAbandon(effectiveId(selectedRevision!.commit)), when: () => !!selectedRevision && checkedRevisions.size === 0 },
    { label: 'Rebase revision(s)', shortcut: 'R', category: 'Revisions', action: enterRebaseMode, when: () => !!selectedRevision || checkedRevisions.size > 0 },
    { label: 'Squash revision(s)', shortcut: 'S', category: 'Revisions', action: enterSquashMode, when: () => !!selectedRevision || checkedRevisions.size > 0 },
    { label: 'Split revision', shortcut: 's', category: 'Revisions', action: enterSplitMode, when: () => !!selectedRevision && checkedRevisions.size === 0 },
    { label: 'Slide revision down (swap with parent)', shortcut: '⇧J', category: 'Revisions', action: () => handleSlide('down'), when: () => !!selectedRevision && checkedRevisions.size === 0 },
    { label: 'Slide revision up (swap with child)', shortcut: '⇧K', category: 'Revisions', action: () => handleSlide('up'), when: () => !!selectedRevision && checkedRevisions.size === 0 },
    { label: 'Review revision (accept/reject files)', shortcut: 'v', category: 'Revisions', action: enterReviewMode, when: () => !!selectedRevision && checkedRevisions.size === 0 },
    { label: 'Commit working copy', shortcut: 'c', category: 'Revisions', action: handleCommit },

    // Git
    { label: 'Git fetch', shortcut: 'f', category: 'Git', action: () => handleGitOp('fetch', []) },
    { label: 'Git push', shortcut: 'p', category: 'Git', action: () => handleGitOp('push', []) },
    { label: 'Git operations (advanced)', shortcut: 'g', category: 'Git', action: () => openModal('git') },

    // Bookmarks
    { label: 'Bookmark operations', shortcut: 'b', category: 'Bookmarks', action: openBookmarkModal },
    { label: 'Set bookmark', shortcut: 'B', category: 'Bookmarks', action: () => openModal('bookmarkInput'), when: () => !!selectedRevision && checkedRevisions.size === 0 },

    // Workspaces
    { label: 'New workspace…', category: 'Workspace', action: handleWorkspaceAdd, when: () => sshMode === false },
    // Rename is otherwise only reachable by right-clicking the current-workspace
    // badge, which doesn't render in single-workspace repos. currentWorkspace
    // !== '' = workspace info loaded (tri-state: '' means unknown).
    { label: 'Rename workspace…', category: 'Workspace', action: renameWorkspace, when: () => currentWorkspace !== '' },
    // Recover every workspace's working copy after a rebase across branches
    // (issue #21). Only meaningful with multiple workspaces.
    { label: 'Update all workspaces (recover stale)', category: 'Workspace', action: updateAllStaleWorkspaces, when: () => workspaceList.length > 1 },

    // View (non-dynamic)
    { label: 'Edit config (JSON)…', category: 'View', hint: 'theme, fonts, editorArgs', action: () => { closeAllModals(); configModalOpen = true } },
    // Route through DiffPanel's toggleSplitView when it's mounted — its confirm
    // guards an open FileEditor's buffer (unified unmounts the editor); a direct
    // config.splitView write would bypass that and silently discard edits. No
    // DiffPanel (branches/merge view) → nothing can be editing → plain toggle.
    { label: 'Toggle split/unified diff', category: 'View', action: () => {
      if (diffPanelRef) diffPanelRef.toggleSplitView()
      else config.splitView = !config.splitView
    } },
    { label: 'Toggle operation log', shortcut: 'O', category: 'View', action: toggleOplog },
    { label: 'Toggle evolution log', shortcut: 'E', category: 'View', action: toggleEvolog, when: () => !!selectedRevision },
    // Help — showInCheatsheet lets shortcut-less entries appear in the empty-query grid
    { label: 'Show welcome / keyboard shortcuts', category: 'Help', showInCheatsheet: true, action: () => { welcomeTitle = `Welcome to lightjj v${APP_VERSION}`; welcomeFeatures = FEATURES; welcomeOpen = true } },
    { label: `Changelog for v${APP_VERSION}`, category: 'Help', showInCheatsheet: true, action: () => window.open(CURRENT_RELEASE_URL, '_blank', 'noopener') },
    { label: 'Full changelog (all releases)', category: 'Help', showInCheatsheet: true, action: () => window.open(RELEASES_URL, '_blank', 'noopener') },
    { label: `About lightjj v${APP_VERSION}`, category: 'Help', showInCheatsheet: true, action: () => { welcomeTitle = `lightjj v${APP_VERSION}`; welcomeFeatures = FEATURES; welcomeOpen = true } },

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
      when: () => !!diffPanelRef?.hasAnnotations(),
    },
    { label: 'Export annotations (JSON → clipboard)', category: 'Annotations',
      action: () => {
        const json = diffPanelRef?.exportAnnotationsJSON() ?? ''
        navigator.clipboard.writeText(json)
        setMessage(json ? { kind: 'success', text: 'Annotations JSON copied' } : { kind: 'warning', text: 'No annotations to export' })
      },
      when: () => !!diffPanelRef?.hasAnnotations(),
    },
    { label: 'Clear all annotations on this revision', category: 'Annotations',
      action: () => {
        diffPanelRef?.clearAnnotations()
        setMessage({ kind: 'success', text: 'Annotations cleared' })
      },
      when: () => !!diffPanelRef?.hasAnnotations(),
    },
  ])

  // Labels that bake reactive state into strings — only these re-allocate on Space/theme/view toggle.
  let dynamicCommands = $derived<PaletteCommand[]>([
    { label: `Abandon ${checkedRevisions.size} checked`, category: 'Revisions', action: handleAbandonChecked, when: () => checkedRevisions.size > 0 },
    { label: `New from ${checkedRevisions.size} checked`, category: 'Revisions', action: handleNewFromChecked, when: () => checkedRevisions.size > 0 },
    { label: darkMode ? 'Light theme' : 'Dark theme', shortcut: 't', category: 'View', action: toggleTheme },
    themeSubmenuCommand,
    { label: `Font size: increase (${config.fontSize}px)`, category: 'View', action: () => { config.fontSize += 1 }, when: () => config.fontSize < FONT_SIZE_MAX },
    { label: `Font size: decrease (${config.fontSize}px)`, category: 'View', action: () => { config.fontSize -= 1 }, when: () => config.fontSize > FONT_SIZE_MIN },
    { label: 'Font size: reset', category: 'View', action: () => { config.fontSize = FONT_SIZE_DEFAULT }, when: () => config.fontSize !== FONT_SIZE_DEFAULT },
    { label: `View: Open PRs (${pullRequests.length})`, hint: prsRevset, category: 'Navigation', action: () => applyRevsetExample(prsRevset), when: () => pullRequests.length > 0 },
  ])

  let aliasCommands = $derived<PaletteCommand[]>(
    aliases
      .filter(a => !isBuiltinAlias(a))
      .map(a => ({
        label: a.name,
        // Prefer the author's description (table-form `doc`) over the raw
        // command body when present; fall back to the command otherwise.
        hint: a.doc || a.command.join(' '),
        category: 'Aliases',
        action: () => handleRunAlias(a.name),
      })),
  )

  // Category-level inline-mode gate. Every command in these categories mutates
  // the repo, enters a mode, or opens a modal — none are valid while a
  // rebase/squash/split is in progress. The gate is injected HERE (not spelled
  // per-entry) so a new entry can't forget it; per-entry when() only expresses
  // ADDITIONAL conditions. Categories outside this set (Navigation, View, Help,
  // Actions) gate individual entries explicitly where needed.
  const INLINE_GATED_CATEGORIES = new Set(['Revisions', 'Git', 'Bookmarks', 'Workspace', 'Annotations', 'Aliases'])

  // Category grouping in the palette's cheatsheet view is handled by Map.groupBy
  // (CommandPalette.svelte), so spread order here doesn't affect visual grouping.
  let commands = $derived<PaletteCommand[]>(
    [...staticCommands, ...dynamicCommands, ...aliasCommands].map(c =>
      INLINE_GATED_CATEGORIES.has(c.category ?? '')
        ? { ...c, when: () => !inlineMode && (c.when?.() ?? true) }
        : c,
    ),
  )

  // --- API actions ---
  async function loadInfo() {
    try {
      const { hostname, repo_path, ssh_mode, default_remote, log_revset, jj_version, watchman_snapshot_trigger } = await api.info()
      pageTitle = formatTitle(hostname, repo_path)
      sshMode = ssh_mode
      defaultRemote = default_remote
      repoPath = repo_path
      configuredLogRevset = log_revset
      setDetectedJJVersion(jj_version)
      const missing = missingJJFeatures()
      if (missing.length > 0) {
        setMessage({ kind: 'warning',
          text: `jj ${jj_version.replace(/^jj\s*/, '')} — missing: ${missing.join(', ')}` })
      } else if (watchman_snapshot_trigger) {
        // lightjj's snapshot loop already covers on-save visibility AND pauses
        // for UI-triggered mutations. The watchman trigger does neither — it
        // races `jj git push` (Concurrent checkout). Advisory only; dismissable.
        setMessage({
          kind: 'warning',
          text: 'jj watchman register-snapshot-trigger is on — redundant with lightjj and races git push',
          details: 'Set fsmonitor.watchman.register-snapshot-trigger = false (keep fsmonitor.backend = "watchman").\n' +
                   'Then once per repo: watchman trigger-del "$(jj root)" jj-background-monitor',
        })
      }
    } catch { /* static <title> fallback + sshMode stays undefined → editorConfigured=false */ }
  }

  // Backend resolves this per-tab from --default-remote flag > jj config
  // git.push > "origin". Pre-load fallback until loadInfo() completes.
  let defaultRemote: string = $state('origin')
  // User's revsets.log config — empty filter bar applies this. Shown in the
  // placeholder so "why is X missing" is visible without opening jj config.
  let configuredLogRevset: string = $state('')
  // Full remote list — session-memoized in api.ts. Used by BookmarksPanel/Modal
  // for multi-remote track/untrack submenus.
  const remotes = createLoader(() => api.remotes(), [] as string[], undefined, { keepValueOnError: true })
  let allRemotes = $derived(remotes.value)

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
    const folder = path.split(/[/\\]/).filter(Boolean).pop() || path
    if (!host) return folder
    return `${hostEmoji(host)} ${host.slice(0, 8)} ${folder}`
  }

  // Cmd+K → "New workspace" and revision-menu → "Add workspace here…". Backend
  // creates a sibling dir <repo>-<name> and adds it via `jj workspace add`.
  // revision (optional) is the change_id of a revision the new workspace's @
  // should sit atop (`-r` → `jj new` parent semantics). After success, reload
  // the workspace list (picks up the new path from the workspace_store index)
  // and open it as a tab.
  async function handleWorkspaceAdd(revision?: string) {
    const base = 'New workspace name (creates sibling directory <repo>-<name>)'
    const promptMsg = revision ? `${base}, based on ${revision.slice(0, 8)}:` : `${base}:`
    // eslint-disable-next-line no-alert
    const name = prompt(promptMsg)?.trim()
    if (!name) return
    try {
      const res = await withMutation(() => api.workspaceAdd(name, revision))
      if (!res) return
      // refresh() resolves only after the new list is applied — openWorkspaceTab
      // reads workspaceList right after this await.
      await workspacesSync.refresh()
      openWorkspaceTab(name)
    } catch (e) {
      setMessage(errorMessage(e))
    }
  }

  // Right-click workspace badge → "Forget". jj stops tracking the workspace but
  // leaves its directory on disk. Gated to NON-current workspaces in the menu
  // (forgetting the one you're viewing orphans the tab). Reload the list after
  // so the dropdown + badges drop the entry.
  const forgetWorkspace = (wsName: string) =>
    runMutation(
      () => api.workspaceForget(wsName),
      `Forgot workspace '${wsName}'`,
      { after: () => { void workspacesSync.refresh() } },
    )

  // Right-click the CURRENT workspace badge → "Rename". jj renames whichever
  // workspace `-R` points at (no name arg), so this only targets the current
  // one — the menu hides it on other badges.
  async function renameWorkspace() {
    // eslint-disable-next-line no-alert
    const name = prompt(`Rename current workspace '${currentWorkspace}' to:`, currentWorkspace)?.trim()
    if (!name || name === currentWorkspace) return
    await runMutation(
      () => api.workspaceRename(name),
      `Renamed workspace to '${name}'`,
      { after: () => { void workspacesSync.refresh() } },
    )
  }

  // Shared by the toolbar dropdown options and RevisionGraph workspace badges.
  // jj's command shapes decide what's offered: rename/update-stale act only on
  // the CURRENT workspace; forget takes a name so it works on others. Every
  // shown item works — no dead disabled entries.
  //
  // Tri-state on currentWorkspace: '' means UNKNOWN (initial value until the
  // workspaces fetch resolves; stays there if it fails), not "some
  // other workspace". While unknown, fail safe: offer only non-destructive
  // items. A plain equality check would route the user's OWN badge to the
  // other-workspace menu, whose headline item is the destructive Forget.
  function openWorkspaceContextMenu(wsName: string, x: number, y: number) {
    const items: ContextMenuItem[] = []
    const wsKnown = currentWorkspace !== ''
    if (wsKnown && wsName === currentWorkspace) {
      items.push(
        { label: 'Rename…', disabled: inlineMode, action: () => renameWorkspace() },
        { label: 'Update if stale', disabled: inlineMode, action: () => handleUpdateStale() },
      )
    } else {
      const ws = workspaceList.find(w => w.name === wsName)
      // inlineMode gate: opening a tab remounts App ({#key} in AppShell), which
      // drops a half-configured rebase/squash/split by design.
      items.push(
        { label: 'Open in new tab', shortcut: '↗', disabled: inlineMode || !ws?.path, action: () => openWorkspaceTab(wsName) },
        // Recover this sibling's working copy without switching to it (issue
        // #21). Same path gate as Open-in-new-tab (no resolvable root → can't
        // target it). Safe even if it isn't actually stale.
        { label: 'Update if stale', disabled: inlineMode || !ws?.path, action: () => recoverWorkspace(wsName) },
      )
      // Forget only when we KNOW this isn't the current workspace — forgetting
      // the workspace being viewed orphans the tab.
      if (wsKnown) {
        items.push(
          { separator: true },
          { label: 'Forget', danger: true, disabled: inlineMode, action: () => forgetWorkspace(wsName) },
        )
      }
    }
    contextMenu = { items, x, y }
  }

  // Shared by toolbar dropdown + RevisionGraph workspace badges. Distinguish
  // "list not loaded yet" (badges render from log data which can land before
  // /api/workspaces — silent no-op, badge click will work in a moment) from
  // "in list but no path" (workspace predates jj's workspace_store index —
  // genuinely unopenable, warn with the manual recipe).
  function openWorkspaceTab(wsName: string) {
    const ws = workspaceList.find(w => w.name === wsName)
    if (!ws) return
    if (ws.path) {
      onOpenTab?.(ws.path)
    } else {
      setMessage({
        kind: 'warning',
        text: `Workspace '${wsName}' path unknown — predates jj's workspace_store index`,
        details: 'Open manually with: lightjj -R <path>',
      })
    }
  }

  function handleRunAlias(name: string) {
    // Streamed like handleGitOp: aliases can wrap slow network ops. Progress
    // lines feed mutationProgress; .finally() clears it on resolve and reject.
    const onLine = (line: string) => { if (line.trim()) mutationProgress = line.trim() }
    runMutation(
      // Seed INSIDE the wrapped fn: if the mutation gate rejects (another op in
      // flight), nothing runs and nothing needs clearing — seeding outside would
      // leave a stale "Running alias…" line that .finally() never removes.
      () => { mutationProgress = `Running alias: ${name}…`; return api.runAlias(name, onLine).finally(() => { mutationProgress = '' }) },
      `Ran alias: ${name}`,
    )
  }


  // ── Op-synced server state ─────────────────────────────────────────────────
  // "Is this data stale?" is DERIVED per resource: stale ⟺ the op-id the backend
  // last reported (currentOpId) differs from the op-id that resource's value
  // reflects. Each createOpSync owns that comparison plus the refresh policy for
  // one loader: gate/enabled suppression (with re-fire when the suppressing
  // condition clears — staleness can never be dropped), throttling, and
  // explicit-vs-auto dedup. See lib/op-sync.svelte.ts and docs/CACHING.md.
  //
  // currentOpId is written ONLY by the onStale subscription (further down); it
  // stays null until the first op-id CHANGE (api.ts treats the first observation
  // as the baseline), which is why the mount-time explicit refresh()es below
  // don't double-fetch when the first response's op-id header lands.
  let currentOpId = $state<string | null>(null)

  // Today's suppression gate. Each sync reads it only while its resource is
  // stale (dependency hygiene: when fresh, the only effect deps are op-ids).
  const opSyncGate = () => loading || mutating || anyModalOpen || !!inlineMode

  const opSync = (opts: Omit<OpSyncOptions, 'opId' | 'gate'>) =>
    createOpSync({ opId: () => currentOpId, gate: opSyncGate, ...opts })

  // Deferred-intent flag: userRefresh(true)/handleRevsetSubmit set it, the next
  // log run consumes it. Same pattern as pendingSelectCommitId — refresh() takes
  // no arguments, so explicit intent travels via App state.
  let pendingResetSelection = false

  const logSync = opSync({ run: () => loadLog() })
  const workspacesSync = opSync({ run: () => workspaces.load() })
  const oplogSync = opSync({ run: () => oplog.load(), enabled: () => oplogOpen })
  const bookmarksSync = opSync({
    run: () => bookmarksPanel.load(),
    enabled: () => activeView === 'branches',
  })
  // Evolog has NO op-sync — it is selection-scoped per-revision data, the other
  // identity granularity. Op-ids don't change when the cursor moves, and every
  // op-id change refreshes the log, whose loadLog chains the evolog AFTER cursor
  // reconciliation (so it always follows the post-refresh selection — an op-sync
  // run thunk would read the PRE-reconciliation selection and stamp the wrong
  // load as fresh). Its three explicit load sites: toggleEvolog (open),
  // selectRevision's 50ms debounce (cursor follow), loadLog's chain (log refresh).
  // Slow mirrors — throttled. TWO of these are genuinely expensive and must
  // never run unthrottled on the op-id-change path: the PR fetch (a `gh`
  // network call, possibly rate-limited) and the stale-immutable check (a
  // `divergent() & immutable()` revset scan — seconds of CPU on monorepo-scale
  // repos; it can't use the `mutable() &` index speedup because it targets
  // immutable commits by definition). aliases/remotes ride the same throttle:
  // api.ts drops their session memos on op-id change, so refreshes here hit
  // the network only when an operation could actually have changed them.
  // Both expensive ones keep explicit post-git-op refreshes (handleGitOp's
  // after hook) for immediacy when WE caused the change.
  const SLOW_MIRROR_MS = 60_000
  const prsSync = opSync({ run: () => prs.load(), throttleMs: SLOW_MIRROR_MS })
  const aliasesSync = opSync({ run: () => aliasesLoader.load(), throttleMs: SLOW_MIRROR_MS })
  const remotesSync = opSync({ run: () => remotes.load(), throttleMs: SLOW_MIRROR_MS })
  // startFresh: the scan never runs at mount or tab-switch — only in reaction
  // to operations that happen while the app is open.
  const staleImmSync = opSync({ run: () => staleImm.load(), throttleMs: SLOW_MIRROR_MS, startFresh: true })

  async function loadLog(): Promise<boolean> {
    const resetRequested = pendingResetSelection
    pendingResetSelection = false

    const revset = revsetFilter || undefined
    const ok = await log.load(revset)
    blurActiveInput()
    if (!ok) return false // superseded or errored — don't post-process stale state
    let resetSelection = resetRequested

    // pendingSelectCommitId: jumpToBookmark's deferred selection. Consume
    // here; on hit suppress resetSelection (which handleRevsetSubmit requests
    // via pendingResetSelection).
    let pending = pendingSelectCommitId
    pendingSelectCommitId = null
    if (pending) {
      const entry = revisions.find(r => r.commit.commit_id === pending)
      if (entry) { selectedId = effectiveId(entry.commit); resetSelection = false }
    }
    // Identity reconciliation: if the selected revision still exists, the
    // cursor stays on it (selectedIndex re-derives its possibly-shifted
    // position). If it disappeared (external abandon, narrower revset) — or a
    // reset was requested — fall back to the working copy.
    const stillExists = selectedId !== null &&
      revisions.some(r => effectiveId(r.commit) === selectedId)
    if (resetSelection || !stillExists) {
      selectedId = workingCopyEntry ? effectiveId(workingCopyEntry.commit) : null
    }
    if (checkedRevisions.size > 0) {
      const validIds = new Set(revisions.map(r => effectiveId(r.commit)))
      for (const id of [...checkedRevisions]) {
        if (!validIds.has(id)) checkedRevisions.delete(id)
      }
    }
    lastCheckedIndex = -1
    if (selectedIndex >= 0 && checkedRevisions.size === 0) {
      // Same revision after a refresh → navigator's isRefresh path + the
      // commit_id cache make this a no-op render-wise (no spinner, no fetch
      // unless the commit was actually rewritten). Different/fallback
      // revision → real load.
      const sel = revisions[selectedIndex]
      nav.loadDiffAndFiles(sel.commit, hasChecked)
    }
    // Oplog/bookmarks panels are NOT chained here — their op-syncs notice the
    // same op-id change that triggered this load and refresh themselves (and
    // panel-open / userRefresh call their refresh() explicitly). The EVOLOG is
    // chained, after reconciliation: it follows the selection, which the lines
    // above may have just moved — an op-sync can't know that.
    if (evologOpen && selectedIndex >= 0 && revisions[selectedIndex]) {
      void evolog.load(effectiveId(revisions[selectedIndex].commit))
    }

    // Pre-load file lists for a window of ~10 revisions around the selection.
    // One jj subprocess for N revs; seeds files:X cache so the file sidebar
    // shows instantly during j/k. Fire-and-forget; main diff load isn't gated.
    prefetchFilesWindow()
    return true
  }

  const FILES_PRELOAD_RADIUS = 5 // revisions on each side of selectedIndex
  function prefetchFilesWindow() {
    if (selectedIndex < 0) return
    const start = Math.max(0, selectedIndex - FILES_PRELOAD_RADIUS)
    const end = Math.min(revisions.length, selectedIndex + FILES_PRELOAD_RADIUS + 1)
    const ids = revisions.slice(start, end).map(r => r.commit.commit_id)
    prefetchFilesBatch(ids)
  }

  // Move cursor without loading diff/files — used in squash mode where
  // the diff is intentionally frozen on the source revision
  function selectRevisionCursorOnly(index: number) {
    const entry = revisions[index]
    if (entry) selectedId = effectiveId(entry.commit)
  }

  let prevSelectedIndex = -1

  function selectRevision(index: number) {
    const moved = index !== prevSelectedIndex
    const direction = index > prevSelectedIndex ? 1 : -1
    prevSelectedIndex = index

    const entry = revisions[index]
    // Callers bounds-check (navKey, '@', jumpToBookmark, RevisionGraph rows),
    // so a missing entry only means an empty list — leave selection unchanged.
    if (!entry) return
    const id = effectiveId(entry.commit)
    selectedId = id
    descriptionEditing = false

    // Clicking away from the divergent change closes the panel (intent =
    // "done looking at this"). Clicking the SAME change is a no-op — panel
    // stays open. j/k doesn't reach here (anyModalOpen gates it) so only
    // mouse clicks trigger this path.
    if (divergence.active && entry.commit.change_id !== divergence.changeId) {
      divergence.cancel()
    }

    // Scheduling (rAF/debounce/cancel) lives in navigator now. abort covers
    // the cursor moving on via any path before the schedule fires (loadLog's
    // working-copy fallback, selectRevisionCursorOnly in branches view).
    // IDENTITY comparison — a row-shifting refresh that leaves the cursor on
    // this same revision must NOT abort the scheduled apply.
    const hit = checkedRevisions.size === 0 ? getCached(entry.commit.commit_id) : null
    if (hit) {
      nav.navigateCached(entry.commit, hit, () => selectedId !== id)
    } else {
      // getCommit re-read at fire — rapid uncached j/k coalesces to CURRENT
      // cursor, not scheduled-time cursor.
      nav.navigateDeferred(() => revisions[selectedIndex]?.commit ?? null, hasChecked)
    }
    // Evolog is uncached — always debounce to avoid one network request per
    // keypress during rapid j/k with the panel open.
    if (evologOpen) {
      clearTimeout(evologDebounceTimer)
      evologDebounceTimer = setTimeout(() => {
        // Re-read at fire time so rapid j/k coalesces to wherever the cursor ends up.
        const current = revisions[selectedIndex]
        if (current) void evolog.load(effectiveId(current.commit))
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

  function selectByChangeId(changeId: string): boolean {
    const idx = revisions.findIndex(r => effectiveId(r.commit) === changeId)
    if (idx >= 0) selectRevision(idx)
    return idx >= 0
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
      { label: 'Jump to revision', shortcut: '⏎', disabled: !actions.jump,
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
    // "Set to <remote>" — conflict-resolution shortcut. Empty array on
    // non-conflict (computeActions only populates on conflict + has local),
    // so this loop no-ops then. Multiple items if multiple tracked remotes;
    // user picks the canonical one. Not flagged danger — it's recovery
    // (snap to known-good remote state), and jj op undo reverses it.
    for (const remote of actions.setToRemote) {
      items.push({
        label: `Set to ${remote}`,
        action: () => handleBookmarkOp({ action: 'set-to-remote', bookmark: bm.name, remote }),
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
    // Conflict gate dropped — BookmarksPanel now supplies overrideCommitId
    // (= added_targets[0]) for conflicted rows. !commitId alone catches the
    // unjumpable case (no override passed AND no bm.commit_id).
    if (!commitId) return
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
    const idx = revisions.findIndex(r => effectiveId(r.commit) === changeId)
    const entry = idx >= 0 ? revisions[idx] : undefined
    const commitId = entry?.commit.commit_id ?? ''
    const slideUp = computeSlide(revisions, idx, 'up')
    const slideDown = computeSlide(revisions, idx, 'down')
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
      { label: 'Slide up', shortcut: '⇧K', disabled: inlineMode || !slideUp.ok, action: () => { selectByChangeId(changeId); handleSlide('up') } },
      { label: 'Slide down', shortcut: '⇧J', disabled: inlineMode || !slideDown.ok, action: () => { selectByChangeId(changeId); handleSlide('down') } },
      { separator: true },
      { label: 'Set bookmark...', shortcut: 'B', disabled: inlineMode, action: () => { selectByChangeId(changeId); openModal('bookmarkInput') } },
      { separator: true },
      // Add-here passes the change_id as the new workspace's parent revision
      // (`-r` → `jj new` semantics). Local-fs only (handleWorkspaceAdd derives a
      // sibling dir on disk); disabled in SSH mode, same as the palette command.
      { label: 'Add workspace here…', disabled: inlineMode || sshMode !== false, action: () => handleWorkspaceAdd(changeId) },
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
  // Skip when diffFrozen — diff is intentionally frozen on source revision.
  // Routed through nav.loadMulti so loadedTarget+diffContentKey advance with
  // diff.value (the contentMatchesTarget invariant in DiffPanel).
  $effect(() => {
    if (intendedTarget?.kind !== 'multi') return
    if (diffFrozen) return
    nav.loadMulti(intendedTarget)
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
        await logSync.refresh()
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

  // Recover a stale working copy of ANOTHER workspace by name (issue #21).
  // update-stale is a safe no-op when the workspace is already fresh, so we
  // run it unconditionally — no detection needed.
  const recoverWorkspace = (name: string) =>
    runMutation(
      () => api.updateStaleWorkspace(name),
      // Neutral wording: update-stale is a no-op when the workspace is already
      // fresh (jj exits 0 either way), so we must NOT claim it "updated" it.
      `Ran update-stale on '${name}'`,
    )

  // "Update all workspaces" (issue #21: "after a rebase across branches, update
  // my stale workspaces"). Runs update-stale across every workspace with a
  // known path; the current one goes through its own endpoint (clears the
  // watcher). withMutation gates against concurrent ops; the summary IS the
  // signal (no passive staleness detection). Workspaces predating jj's
  // workspace_store index (no path) are skipped and named.
  function updateAllStaleWorkspaces() {
    const { targets, skipped } = planRecoverAll(workspaceList, currentWorkspace)
    if (targets.length === 0) return
    return withMutation(async () => {
      let ran = 0
      const failed: string[] = []
      for (const ws of targets) {
        try {
          await (ws.name === currentWorkspace ? api.workspaceUpdateStale() : api.updateStaleWorkspace(ws.name))
          ran++
        } catch { failed.push(ws.name) }
      }
      workspaceStale = false
      await logSync.refresh()
      setMessage(recoverAllMessage(ran, failed, skipped))
    })
  }

  // Stale warning is lower-priority than a mutation error the user just
  // triggered, so `message` wins. Non-dismissable (the problem persists until
  // fixed); the ✕ only dismisses real messages.
  //
  // This only appears when jj's `snapshot.auto-update-stale` is OFF — with
  // the default (true), jj recovers transparently inside the snapshot
  // subprocess and the stale error never surfaces. Mention the config so
  // users who keep hitting this know how to make it permanent.
  const staleWCMessage: Message = {
    kind: 'warning',
    text: 'Working copy is stale — another workspace rewrote shared history',
    details: 'Set jj config `snapshot.auto-update-stale = true` (default) to recover automatically.',
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

  // Config file has a JSONC syntax error (backend returned 422). Non-dismissable
  // until the user fixes their file — reseeding silently would destroy their
  // comments on the next panel-drag write, so we leave the file alone and
  // surface a warning with an "Edit config" action that opens the JSONC modal.
  const configErrorMessage: Message | null = $derived(config.lastError ? {
    kind: 'warning' as const,
    text: 'Config has a syntax error — open the editor to fix',
    details: config.lastError,
    action: { label: 'Edit config', onClick: () => { configModalOpen = true } },
  } : null)

  // Persistent auto-refresh failure — poll loop hit ≥ 5 consecutive errors.
  // Ranked ABOVE staleWC: when polling itself is broken, stale-WC detection
  // is also impaired (no snapshot → no transition → no fresh-wc either way),
  // so pollfail is the more truthful condition to surface.
  // Remediation button gated on error text matching index.lock (the common
  // "colocated git left a lockfile after crashed process" case); otherwise
  // offer "Retry snapshot" — success clears pollfail via server recovery,
  // failure surfaces the real error through runMutation's toast. Both
  // branches MUST set `action`: MessageBar renders ✕ dismiss when absent,
  // but dismissMessage→setMessage(null) is a no-op while displayMessage
  // falls through to pollFailMessage, leaving a dead button.
  const handleUnlockRepo = () =>
    runMutation(
      () => api.unlockRepo(),
      'Deleted .git/index.lock',
      { after: () => { pollFailError = null } },
    )
  const handleRetrySnapshot = () =>
    runMutation(
      () => api.snapshot(),
      'Snapshot succeeded — auto-refresh restored',
      { after: () => { pollFailError = null } },
    )
  const pollFailMessage: Message | null = $derived(pollFailError ? (
    pollFailError.includes('index.lock') ? {
      kind: 'warning' as const,
      text: 'Auto-refresh failing — stale .git/index.lock detected',
      details: pollFailError,
      action: { label: 'Delete git lockfile', onClick: handleUnlockRepo },
    } : {
      kind: 'warning' as const,
      text: 'Auto-refresh failing — repo may be locked',
      details: pollFailError,
      action: { label: 'Retry snapshot', onClick: handleRetrySnapshot },
    }
  ) : null)

  let displayMessage = $derived(
    message
      ?? pollFailMessage
      ?? configErrorMessage
      ?? (workspaceStale ? staleWCMessage : staleImmutableMessage),
  )

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
        // Mutation already succeeded; the log refresh below reloads either way.
        if (selectedRevision?.commit.commit_id === cid) {
          description.set(descriptionDraft)
          descriptionEditing = false
        }
        await logSync.refresh()
      } catch (e) {
        showError(e)
      }
    })
  }

  // Shared by handleCommit + startDescriptionEdit. Always fetches —
  // api.description is commit_id-cached so the hot path is instant.
  // Don't read fullDescription here: context-menu Describe calls this
  // synchronously after selectByChangeId, before the loader's deferred rAF
  // fires, so fullDescription still holds the PREVIOUS revision's text.
  async function fetchPrefillDescription(): Promise<string> {
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
        await logSync.refresh()
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
    return runMutation(
      // Seeded inside the wrapped fn so a gate-rejected call leaves no stale line.
      () => { mutationProgress = `git ${type}…`
              return (type === 'push' ? api.gitPush : api.gitFetch)(flags, onLine)
              .finally(() => { mutationProgress = '' }) },
      `Git ${type} complete`,
      // We caused the change — refresh both immediately, bypassing the throttle.
      { after: () => { void prsSync.refresh(); void staleImmSync.refresh() } },
    )
  }

  function handleCleanupStaleImmutable() {
    const staleIds = staleImmutableGroups.map(g => g.stale.commit_id)
    runMutation(
      () => api.abandon(staleIds, true),
      `Cleaned up ${staleIds.length} stale immutable commit${staleIds.length !== 1 ? 's' : ''}`,
      // Optimistic clear + markFresh: the abandon made the groups empty; without
      // the stamp, the mutation's own op-id advance would re-run the expensive
      // scan just to learn that.
      { after: () => { staleImm.set([]); staleImmSync.markFresh() } },
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
    // Per-bookmark push (ahead-state sync-label click) and delete-staged
    // completion (tracked remote-only) both go through handleGitOp — push is a
    // slow network op and the streaming path handles mutationProgress + PR
    // reload. Same jj command underneath; the action enum split is for the
    // toast/menu wording, not behaviour.
    if (op.action === 'push' || op.action === 'push-delete') {
      return handleGitOp('push', bookmarkPushFlags(op.bookmark, op.remote!))
    }
    if ((op.action === 'move' || op.action === 'advance') && !selectedRevision) return
    const changeId = selectedRevision ? effectiveId(selectedRevision.commit) : ''
    const actions: Record<Exclude<BookmarkOp['action'], 'push' | 'push-delete'>, () => Promise<MutationResult>> = {
      move: () => api.bookmarkMove(op.bookmark, changeId),
      advance: () => api.bookmarkAdvance(op.bookmark, changeId),
      delete: () => api.bookmarkDelete(op.bookmark),
      forget: () => api.bookmarkForget(op.bookmark),
      track: () => api.bookmarkTrack(op.bookmark, op.remote!),
      untrack: () => api.bookmarkUntrack(op.bookmark, op.remote!),
      'set-to-remote': () => api.bookmarkSetToRemote(op.bookmark, op.remote!),
    }
    // Default toast = `<action> <bookmark>` (move/delete/forget/track/etc are
    // already verb-led). 'set-to-remote' is a slug not a verb, and the remote
    // is the load-bearing detail (multi-remote case picks one) — render it
    // explicitly to match the menu label "Set to <remote>".
    const label = op.action === 'set-to-remote'
      ? `Set ${op.bookmark} to ${op.remote}`
      : `${op.action} ${op.bookmark}`
    runMutation(actions[op.action], label)
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
        await logSync.refresh()
      } catch (e) {
        // Don't close panel on error — let user see state and retry
        showError(e)
        await logSync.refresh()
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
    // Cancel any queued navigate* schedule — the direct load below supersedes
    // it. Otherwise context-menu → selectByChangeId → selectRevision schedules,
    // then this fires another; revGen makes it correct but it's wasteful.
    nav.cancel()
    const sel = revisions[selectedIndex]
    if (!sel || checkedRevisions.size > 0) return true
    const loaded = nav.loadedTarget
    // diffPending = "loadedTarget set sync but content still fetching". Without
    // this check, enterSquashMode during the ~440ms SSH meta wait would init
    // fileSel from files.value=[] (reset at navigate) → executeSquash's
    // empty-commit exception (total===0) → undefined file filter → squash ALL.
    if (loaded?.kind === 'single' && loaded.commitId === sel.commit.commit_id && !nav.diffPending) return true
    nav.loadDiffAndFiles(sel.commit, hasChecked)
    return false
  }

  // Mirror of switchToLogView — the descriptionEditing clear is the payload.
  // DiffPanel (and the editor in its header slot) unmount in branches view,
  // but descriptionEditing/descriptionDraft are App-level state; without the
  // clear they survive a branches-view excursion and reattach over whatever
  // revision the cursor landed on.
  function switchToBranchesView() {
    descriptionEditing = false
    // Explicit refresh on entry (not re-entry): bypasses the op-sync gate so the
    // panel never shows a false "No bookmarks" while the log/a mutation is in
    // flight. The sync still owns op-id staleness while the view stays open.
    if (activeView !== 'branches') void bookmarksSync.refresh()
    activeView = 'branches'
  }

  async function switchToMergeView() {
    descriptionEditing = false
    activeView = 'merge'
    const ok = await merge.enter()
    // bug_013: only bounce if user is STILL in merge (didn't nav away mid-await)
    if (!ok && activeView === 'merge') activeView = 'log'
  }

  function enterRebaseMode() {
    const revs = effectiveRevisions
    if (revs.length === 0) return
    cancelInlineModes()
    switchToLogView()
    rebase.enter(revs)
  }

  // typedDest: from DestinationInput (`/` in rebase mode) — bookmark name,
  // change_id, or revset. Overrides the j/k cursor; lets you target commits
  // not in the current revset (the freshly-synced-upstream-main case). The
  // sources.includes() self-target guard still works for change_ids; for
  // bookmark names it's a no-op (different namespace) but jj rejects with a
  // clear error if you try to rebase X onto a bookmark pointing at X.
  async function executeRebase(typedDest?: string) {
    if (rebase.sources.length === 0) return
    if (!typedDest && !selectedRevision) return
    const destination = typedDest ?? effectiveId(selectedRevision!.commit)
    if (rebase.sources.includes(destination)) {
      setMessage({ kind: 'warning', text: 'Cannot rebase onto source revision' })
      return
    }
    // Capture mode state before cancelling
    const { sources, sourceMode, targetMode, skipEmptied, ignoreImmutable, simplifyParents } = rebase
    const modeLabel = targetModeLabel[targetMode]
    rebase.cancel()
    return withMutation(async () => {
      try {
        const result = await api.rebase(sources, destination, sourceMode, targetMode, {
          skipEmptied: skipEmptied || undefined,
          ignoreImmutable: ignoreImmutable || undefined,
          simplifyParents: simplifyParents || undefined,
        })
        const msg = sources.length > 1
          ? `Rebased ${sources.length} revisions ${modeLabel} ${destination.slice(0, 8)}`
          : `Rebased ${sources[0].slice(0, 8)} ${modeLabel} ${destination.slice(0, 8)}`
        setMessage(mutationMessage(msg, result))
        clearChecks()
        await logSync.refresh()
      } catch (e) {
        showError(e)
      }
    })
  }

  // Shift+J/K: jj-arrange-style single-step swap with topological neighbor.
  // Gate logic lives in slide.ts (pure, tested). Cursor follows the moved
  // change_id post-reload — commit_id changes, so loadLog's index-preservation
  // alone would land on the swapped neighbor.
  async function handleSlide(dir: SlideDir) {
    const s = computeSlide(revisions, selectedIndex, dir)
    if (!s.ok) return setMessage({ kind: 'warning', text: s.reason })
    const changeId = effectiveId(revisions[selectedIndex].commit)
    return withMutation(async () => {
      try {
        const r = await api.rebase([changeId], s.dest, '-r', s.targetMode)
        setMessage(mutationMessage(`Slid ${changeId.slice(0, 8)} ${dir}`, r))
        await logSync.refresh()
        selectByChangeId(changeId)
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

  async function executeSquash(typedDest?: string) {
    if (squash.sources.length === 0) return
    if (!typedDest && !selectedRevision) return
    const destination = typedDest ?? effectiveId(selectedRevision!.commit)
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
        const { sources, keepEmptied, ignoreImmutable, descMode } = squash
        // Order sources by graph position so multi-source "combine" composes a
        // DETERMINISTIC description — `sources` arrives in checkbox-click order,
        // which would otherwise make the combined message depend on click order.
        const orderedSources = [...sources].sort((a, b) =>
          revisions.findIndex(r => effectiveId(r.commit) === a) - revisions.findIndex(r => effectiveId(r.commit) === b))
        const result = await api.squash(orderedSources, destination, {
          files,
          keepEmptied: keepEmptied || undefined,
          ignoreImmutable: ignoreImmutable || undefined,
          // Default 'destination' = jj's --use-destination-message; omit it so
          // the wire stays minimal and the backend default path is unchanged.
          descriptionMode: descMode !== 'destination' ? descMode : undefined,
        })
        // W1: only exit mode after successful API call
        cancelInlineModes()
        const msg = sources.length > 1
          ? `Squashed ${sources.length} revisions into ${destination.slice(0, 8)}`
          : `Squashed ${sources[0].slice(0, 8)} into ${destination.slice(0, 8)}`
        setMessage(mutationMessage(msg, result))
        clearChecks()
        await logSync.refresh()
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
        await logSync.refresh()
      } catch (e) {
        showError(e)
      }
    })
  }

  async function executeHunkReview() {
    const total = allHunks.length
    const accepted = selectedHunks.size
    if (accepted === total) {
      setMessage({ kind: 'warning', text: 'Reject at least one hunk (Space to toggle)' })
      return
    }
    if (accepted === 0) {
      setMessage({ kind: 'warning', text: 'Accept at least one hunk' })
      return
    }

    const revision = split.revision
    // Look up the source commit by split.revision (frozen at mode entry).
    // selectedRevision tracks the CURSOR, which mouse clicks can move during
    // split mode (diffFrozen → selectRevisionCursorOnly) — reading its
    // parent_ids or description here would use the wrong commit's data.
    const sourceEntry = revisions.find(r => effectiveId(r.commit) === revision)
    const sourceDesc = fullDescription
    const typeOf = (path: string) => normalizeFileType(
      changedFiles.find(f => f.path === path)?.type ?? 'M'
    )
    const plan = planHunkSpec(reviewParsedDiff, selectedHunks, typeOf)

    // No partials → every file is all-or-none → file-level split is exact
    // AND works in SSH. Free optimization; also the only path SSH can take.
    if (plan.partials.length === 0) {
      const acceptedPaths = reviewParsedDiff
        .filter(f => fileSelectionState(f, selectedHunks) === 'all')
        .map(f => f.filePath)
      return withMutation(async () => {
        try {
          const result = await api.split(revision, acceptedPaths)
          cancelInlineModes()
          setMessage(mutationMessage(`Reviewed ${revision.slice(0, 8)} (${accepted}/${total} hunks)`, result))
          clearChecks()
          await logSync.refresh()
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
    const parents = sourceEntry?.commit.parent_ids ?? []
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
        const result = await api.splitHunks(revision, spec, sourceDesc)
        cancelInlineModes()
        setMessage(mutationMessage(`Reviewed ${revision.slice(0, 8)} (${accepted}/${total} hunks)`, result))
        clearChecks()
        await logSync.refresh()
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
    fileHistoryPath = null
    paletteOpen = false
    bookmarkModalOpen = false
    bookmarkInputOpen = false
    gitModalOpen = false
    configModalOpen = false
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
    destInputOpen = false
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

  function toggleOplog() {
    oplogOpen = !oplogOpen
    // Explicit refresh on open: bypasses the op-sync gate so the panel never
    // shows a false "No operations" while the log/a mutation is in flight.
    // The sync's enabled-flip alone would defer the fetch until the gate clears.
    if (oplogOpen) void oplogSync.refresh()
  }

  async function toggleEvolog() {
    evologOpen = !evologOpen
    // Always load on open: the selection may have moved while the panel was closed.
    if (evologOpen && selectedRevision) await evolog.load(effectiveId(selectedRevision.commit))
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
  // refreshes (runMutation's post-mutation logSync.refresh(), the op-syncs)
  // preserve the message they just set.
  function userRefresh(resetSelection = false) {
    setMessage(null)
    if (resetSelection) pendingResetSelection = true
    // Escape hatch ('r' = "I think the watcher missed something"): refresh open
    // panels explicitly too. Their op-syncs can't help here — the premise is
    // that the op-id signal itself was missed or never fired. (The evolog is
    // covered by loadLog's post-reconciliation chain.)
    if (oplogOpen) void oplogSync.refresh()
    if (activeView === 'branches') void bookmarksSync.refresh()
    return logSync.refresh()
  }

  function handleRevsetSubmit() {
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
  // Gate priority lives in keyboard-gate.ts (routeKeydown) so the ORDER can
  // be table-tested — gate placement has been the highest-regression surface.
  // Handlers below encode their own entry conditions; routeKeydown encodes
  // only the try-then-fall-through sequence.

  function isInInput(t: HTMLElement) {
    return t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable || !!t.closest('.cm-editor')
  }

  function handleKeydown(e: KeyboardEvent) {
    const target = e.target as HTMLElement
    routeKeydown(
      {
        key: e.key,
        hasModifier: e.metaKey || e.ctrlKey,
        inInput: isInInput(target),
        defaultPrevented: e.defaultPrevented,
        fileHistoryOpen: !!fileHistoryPath,
        anyModalOpen,
        inlineMode,
        activeView,
      },
      {
        globalOverrides: () => handleGlobalOverrides(e),
        inlineCommit: () => handleInlineCommit(e, target),
        diffScroll: () => handleDiffScroll(e),
        delegateFileHistory: () => {
          if (fileHistoryRef?.handleKeydown(e)) { e.preventDefault(); return true }
          return false
        },
        inlineNav: () => handleInlineNav(e),
        // Branches panel is focus-independent: delegate via bind:this ref
        // (not element onkeydown, which silently breaks when focus drifts to
        // toolbar → d/f/t fall through to global → t=theme-toggle). Panel's
        // own Escape tiering (disarm → clear filter → close) wins because
        // routeKeydown's escapeStack gate is below the branches block.
        delegateBranches: () => {
          bookmarksPanelRef?.handleKeydown(e)
          return e.defaultPrevented
        },
        // bug_005: MergePanel's swallowKeydown handles its own Escape
        // (confirm-if-dirty) when focused — routeKeydown's defaultPrevented
        // pre-check gates that. This catches no-panel / queue-focused cases.
        mergeEscape: () => { switchToLogView(); e.preventDefault() },
        delegateConflictQueue: () => {
          if (conflictQueueRef?.handleKeydown(e)) { e.preventDefault(); return true }
          return false
        },
        docEscape: () => { closeDocView(); e.preventDefault() },
        docKeys: () => {
          if (e.key === '}' || e.key === '{') {
            e.preventDefault()
            if (docRailRef?.stepComment(e.key === '}' ? 1 : -1) === false) {
              setMessage({ kind: 'warning', text: 'No open comments on this document' })
            }
            return true
          }
          return false
        },
        escapeStack: handleEscapeStack,
        globalKeys: () => handleGlobalKeys(e),
        logKeys: () => handleLogKeys(e),
      },
    )
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
    // Gate preventDefault on diffPanelRef + !overlay — otherwise branches view
    // eats the browser's native find shortcut without opening any search UI,
    // and file-history overlay would open DiffPanel's search BEHIND itself
    // (bug_030 — steals focus, invisible input). Falling through to native
    // Cmd+F lets the user search the overlay's visible diff text.
    if (e.key === 'f' && diffPanelRef && !fileHistoryPath) {
      e.preventDefault()
      diffPanelRef.openSearch()
      return true
    }
    return false
  }

  const SCROLL_KEYS: Record<string, ['line' | 'half', 1 | -1]> = {
    e: ['line', 1], y: ['line', -1], d: ['half', 1], u: ['half', -1],
  }
  function handleDiffScroll(e: KeyboardEvent): boolean {
    // diffPanelRef gates same as Cmd+F (undefined in branches/merge → fall
    // through to hasModifier passthrough so the browser default still wins).
    if (!e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return false
    if (!diffPanelRef || fileHistoryPath || anyModalOpen) return false
    const step = SCROLL_KEYS[e.key]
    if (!step) return false
    e.preventDefault()
    diffPanelRef.scrollByStep(...step)
    return true
  }

  // Kind-keyed execute dispatch — Enter (handleInlineCommit) and the
  // DestinationInput submit both route through this instead of re-spelling
  // `split.active ? executeSplit : squash.active ? ...` chains. executeSplit
  // ignores the typedDest arg (split has no destination).
  const executeInlineMode: Record<ModeKind, (typedDest?: string) => unknown> = {
    rebase: executeRebase,
    squash: executeSquash,
    split: executeSplit,
  }

  // Header verb for the `/` DestinationInput, per mode kind. Split never opens
  // it (hasDestination=false gates the `/` key in handleInlineNav).
  const destinationVerb: Record<ModeKind, () => string> = {
    rebase: () => `Rebase ${targetModeLabel[rebase.targetMode]}`,
    squash: () => 'Squash into',
    split: () => '',
  }

  // Inline mode Enter/Escape — must fire even when FileSelectionPanel holds
  // focus (it's a <div tabindex=-1> inside the diff panel). But cm-editor and
  // text inputs handle their own Enter/Escape, so sub-filter on those.
  function handleInlineCommit(e: KeyboardEvent, target: HTMLElement): boolean {
    if (!inlineMode || (e.key !== 'Enter' && e.key !== 'Escape')) return false
    // Stop the dispatcher — input handles natively. routeKeydown already
    // computed ctx.inInput, but this path reads `target` directly (the ctx
    // isn't plumbed through). Duplicate-but-cheap; unified if it matters.
    if (isInInput(target)) return true
    e.preventDefault()
    if (e.key === 'Enter') {
      if (activeInlineMode) executeInlineMode[activeInlineMode.kind]()
    } else {
      cancelInlineModes()
    }
    return true
  }

  // j/k (per-mode semantics) + delegate to mode.handleKey(). Swallows ALL
  // keys — normal-mode shortcuts (t/u/b/r/...) deliberately don't leak through.
  //
  // j/k semantics come from the mode's own ModeBase contract:
  //   no destination cursor        → no j/k at all (split — in-place op)
  //   destination + diff follows   → full selectRevision (rebase: dest preview)
  //   destination + diff frozen    → selectRevisionCursorOnly (squash)
  function handleInlineNav(e: KeyboardEvent): void {
    // Hunk-review j/k/Space/a/n/A/N take over. Routed here (not in
    // split.handleKey) because allHunks is derived from parseDiffCached
    // (App-owned); the mode factory can't see it.
    if (split.review && handleReviewKey(e.key)) { e.preventDefault(); return }

    const mode = activeInlineMode
    if (!mode) return  // unreachable: routeKeydown only calls this when inlineMode
    const jk = !mode.hasDestination ? undefined
             : mode.diffFollows ? selectRevision
             : selectRevisionCursorOnly
    // `/` opens DestinationInput for off-revset targets — only modes with a
    // destination get it. Handled HERE (not in mode.handleKey) because opening
    // a modal is an App-level concern; the mode factory has no access to
    // destInputOpen.
    if (e.key === '/' && mode.hasDestination) {
      e.preventDefault()
      destInputOpen = true
      return
    }
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
      case '2': e.preventDefault(); switchToBranchesView(); return true
      // 4/5 open bottom drawers. Switch to log first so the drawer actually
      // renders (evolog/oplog are gated on activeView==='log' — they'd steal
      // vertical space from the bookmarks panel otherwise).
      case '3': e.preventDefault(); switchToMergeView(); return true
      case '4': e.preventDefault(); switchToLogView(); toggleOplog(); return true
      case '5': e.preventDefault(); switchToLogView(); toggleEvolog(); return true
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
      case ']': e.preventDefault(); diffPanelRef?.stepHunk(1); break
      case '[': e.preventDefault(); diffPanelRef?.stepHunk(-1); break
      case '}': e.preventDefault(); if (diffPanelRef?.stepAnnotation(1) === false) setMessage({ kind: 'warning', text: 'No annotations on this revision' }); break
      case '{': e.preventDefault(); if (diffPanelRef?.stepAnnotation(-1) === false) setMessage({ kind: 'warning', text: 'No annotations on this revision' }); break
      case 'C': e.preventDefault(); diffPanelRef?.cycleVisibility(); break
      case 'm': e.preventDefault(); diffPanelRef?.togglePreviewActive(); break
      case 'E': e.preventDefault(); switchToLogView(); toggleEvolog(); break
      case 'O': e.preventDefault(); switchToLogView(); toggleOplog(); break
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
      case 'J': if (singleOnly) { e.preventDefault(); handleSlide('down') } break
      case 'K': if (singleOnly) { e.preventDefault(); handleSlide('up') } break
    }
  }

  // ── Staleness model ────────────────────────────────────────────────────────
  // The subscription only records the op-id. ALL refresh policy — the per-
  // resource stale comparison, gate/enabled suppression with re-fire, throttling,
  // explicit-vs-auto dedup — lives in the op-syncs declared above (see the
  // "Op-synced server state" block and lib/op-sync.svelte.ts). currentOpId stays
  // null until the first op-id CHANGE: api.ts treats the first observed op-id as
  // the baseline, so a fresh mount never refreshes what it just loaded.
  $effect(() => onStale((opId) => { currentOpId = opId }))
  // Auto-refresh sources: SSE push (fsnotify/inotifywait) + tab-focus snapshot.
  // Both route through notifyOpId → onStale → currentOpId, so the staleness
  // effect's gates apply. The body reads no reactive state → runs once on
  // mount, cleanup on unmount.
  $effect(() => wireAutoRefresh())
  $effect(() => onStaleWC((s) => { workspaceStale = s }))
  $effect(() => onPollFail((err) => { pollFailError = err }))

  // Agent-driven navigate (POST /api/navigate → SSE). Gated so an agent can't
  // yank the user out of half-complete rebase/squash, an unsaved 3-pane
  // resolution, or unsaved doc-mode edits.
  let pendingNavScroll: { changeId: string; path: string } | null = $state(null)
  $effect(() => onNavigate(async (p: NavigatePayload) => {
    if (inlineMode || mutating || activeView === 'merge' || activeView === 'doc') {
      setMessage({ kind: 'warning', text: 'Agent navigate ignored — finish or Esc current mode' })
      return
    }
    // comment_id → position resolution. Agents reference comments by id (the
    // only stable handle they have). Two stores, distinguished by the OTHER
    // field the agent supplies:
    //   {comment_id, change_id}  → annotation (line-keyed inline review note)
    //   {comment_id, file_path}  → doc-comment (range-keyed markdown comment)
    // Best-effort — on miss, fall through to whatever fields were supplied.
    if (p.comment_id && p.change_id) {
      try {
        const anns = await api.annotations.list(p.change_id)
        const ann = anns.find(a => a.id === p.comment_id)
        if (ann) p = { ...p, file_path: p.file_path ?? ann.filePath, line: p.line ?? ann.lineNum }
      } catch { /* best-effort — proceed with the agent's raw payload */ }
      // Re-gate after the await — user could have entered a mode mid-fetch.
      if (inlineMode || mutating || activeView === 'merge' || activeView === 'doc') return
    } else if (p.comment_id && p.file_path && !p.change_id) {
      // Doc-comment path: open doc mode on the file and focus the comment in
      // the rail. The top gate already rejected if the user is mid-doc-edit
      // (`activeView === 'doc'`), so this only fires when entering fresh.
      try {
        const dcs = await api.docComments.list(p.file_path)
        const dc = dcs.find(c => c.id === p.comment_id)
        if (dc) {
          // Re-gate after the await.
          if (inlineMode || mutating || activeView === 'merge' || activeView === 'doc') return
          await switchToDocView(p.file_path)
          // switchToDocView resets docFocusedComment to null on its success
          // path before returning, so this write is the final one. On its
          // early-bail path (a competing view-switch raced in during the lazy
          // import) this leaves a stale id — benign, nothing reads
          // docFocusedComment while activeView !== 'doc', and the next
          // switchToDocView/closeDocView clears it.
          docFocusedComment = p.comment_id
          return // doc-mode navigation is terminal — skip the diff-view path.
        }
      } catch { /* best-effort */ }
      if (inlineMode || mutating || activeView === 'merge' || activeView === 'doc') return
    }
    pendingNavScroll = null
    switchToLogView()
    if (p.change_id) {
      if (!selectByChangeId(p.change_id)) {
        setMessage({ kind: 'warning', text: `Agent navigate: ${p.change_id} not in current revset` })
        return
      }
      // Defer file scroll until that revision's diff is the loadedTarget. The
      // effect below identity-checks changeId so a user j/k between now and
      // diff-load (or selectByChangeId being a no-op for already-selected)
      // doesn't apply the scroll to the wrong diff.
      if (p.file_path) pendingNavScroll = { changeId: p.change_id, path: p.file_path }
    } else if (p.file_path) {
      // No change_id → scroll within whatever's currently shown; no async wait.
      diffPanelRef?.scrollToFile(p.file_path)
    }
  }))
  $effect(() => {
    if (!pendingNavScroll || !diffPanelRef) return
    // User navigated away from the agent's target → drop the pending scroll
    // rather than fire it whenever they happen to return. Distinguishes from
    // "loadedTarget hasn't caught up yet" (cursor matches, lt doesn't).
    // effectiveId — selectByChangeId matched via effectiveId (commit_id for
    // divergent), so pendingNavScroll.changeId may be a commit_id; raw
    // change_id comparison would never match for divergent targets.
    if (!selectedRevision || effectiveId(selectedRevision.commit) !== pendingNavScroll.changeId) {
      pendingNavScroll = null
      return
    }
    if (diffLoading) return
    const lt = loadedTarget
    if (lt?.kind !== 'single' || lt.changeId !== pendingNavScroll.changeId) return
    const { path } = pendingNavScroll
    pendingNavScroll = null
    requestAnimationFrame(() => diffPanelRef?.scrollToFile(path))
  })

  // Focus heartbeat — POST /api/focus on cursor/view change so an agent
  // polling GET /api/focus sees what the human is currently looking at.
  // Debounced 500ms so rapid j/k coalesces to one POST. setFocus is
  // fire-and-forget (swallows errors, never touches state) — no untrack needed.
  let focusTimer: ReturnType<typeof setTimeout> | undefined
  $effect(() => {
    const payload = {
      change_id: selectedRevision?.commit?.change_id,
      commit_id: selectedRevision?.commit?.commit_id,
      // Drawers layer over the log view (oplogOpen/evologOpen are booleans,
      // not activeView values) but ARE what the user is looking at — report
      // them so an agent steering a review knows. Backend whitelists both.
      active_view: oplogOpen ? 'oplog' : evologOpen ? 'evolog' : activeView,
      doc_file_path: activeView === 'doc' ? (docFilePath ?? undefined) : undefined,
    }
    // Debounced report on change + low-frequency heartbeat while visible.
    // The heartbeat is what makes `updated_at` a real liveness signal: a user
    // reading one diff for 60s without moving the cursor produces no view
    // changes; without the heartbeat an agent would conclude "tab closed."
    focusTimer = setTimeout(() => { void api.setFocus(payload) }, 500)
    const heartbeat = setInterval(() => {
      if (document.visibilityState === 'visible') void api.setFocus(payload)
    }, 20_000)
    return () => {
      clearTimeout(focusTimer)
      clearInterval(heartbeat)
    }
  })

  let sseConnected = $state(true)
  let pageTitle = $state('lightjj')
  $effect(() => onSSEState((c) => { sseConnected = c }))
  $effect(() => {
    document.title = sseConnected ? pageTitle : `⚠ ${pageTitle} — disconnected`
  })

  // Raw setTimeout escapes {#key} remount — clear on tab-switch unmount so
  // stale closures don't keep the old instance's signals alive. nav.cancel()
  // clears the navigator-owned rAF + debounce.
  onDestroy(() => {
    clearTimeout(messageClearTimer)
    clearTimeout(evologDebounceTimer)
    nav.cancel()
  })

  // Initial loads — explicit refresh() calls. A never-fetched sync IS stale by
  // definition (op-sync's !hasApplied rule), so the eager syncs below would
  // auto-fetch one effect flush + one macrotask later anyway; calling refresh()
  // here starts the fetches synchronously (startup latency) and pre-empts that
  // deferred auto pass (the attempted/inFlight stamps make its re-check a no-op).
  // staleImmSync is deliberately absent (startFresh: created already-applied, so
  // the expensive scan never runs at mount); loadInfo is not op-id state at all
  // (repo identity can't change for a running server).
  void logSync.refresh()
  loadInfo()
  void workspacesSync.refresh()
  void aliasesSync.refresh()
  void prsSync.refresh()
  void remotesSync.refresh()

  // --- Tab-switch state preservation ---
  // AppShell calls getState() before the {#key} remount destroys this instance.
  export function getState(): TabState {
    return {
      // Identity, not index: the backgrounded tab's log can shift before the
      // user switches back (SSE keeps flowing into the new instance).
      selectedId,
      revsetFilter,
      // Merge/doc modes are NOT preserved across tabs — half-done conflict
      // resolution or in-progress doc edit across tab-switch is a footgun.
      activeView: activeView === 'merge' || activeView === 'doc' ? 'log' : activeView,
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
        {#if updateInfo}
          <a class="toolbar-logo" href={updateInfo.url} target="_blank" rel="noopener" title="lightjj v{updateInfo.latest} available">
            <span class="logo-icon">
              <img src={darkMode ? '/logo.svg' : '/logo-light.svg'} alt="lightjj" width="16" height="16" />
              <span class="update-dot"></span>
            </span>
          </a>
        {:else}
          <span class="toolbar-logo" title="lightjj v{APP_VERSION}">
            <span class="logo-icon">
              <img src={darkMode ? '/logo.svg' : '/logo-light.svg'} alt="lightjj" width="16" height="16" />
            </span>
          </span>
        {/if}
        {#if currentWorkspace}
          <span class="toolbar-divider"></span>
          <div class="toolbar-workspace" bind:this={wsSelectorEl}>
            <button
              class="toolbar-ws-btn"
              onclick={() => { if (workspaceList.length > 1) wsDropdownOpen = !wsDropdownOpen }}
              title={workspaceList.length > 1 ? `Workspace: ${currentWorkspace} — switch (w)` : `Workspace: ${currentWorkspace}`}
            >
              <span class="toolbar-ws-glyph">◇</span>
              <span class="toolbar-ws-name">{currentWorkspace}</span>
              {#if workspaceList.length > 1}
                <span class="toolbar-ws-chevron">{wsDropdownOpen ? '▴' : '▾'}</span>
              {/if}
            </button>
            {#if wsDropdownOpen && workspaceList.length > 1}
              <div class="toolbar-ws-dropdown">
                <!-- Recover every workspace at once (issue #21) — the bulk
                     answer to "after a rebase, update my stale workspaces". -->
                <button
                  class="toolbar-ws-option toolbar-ws-action"
                  disabled={inlineMode}
                  title="Run update-stale across all workspaces"
                  onclick={() => { wsDropdownOpen = false; updateAllStaleWorkspaces() }}
                >
                  <span class="toolbar-ws-glyph">⟳</span>
                  <span>Update all workspaces (recover stale)</span>
                </button>
                <div class="toolbar-ws-sep"></div>
                {#each workspaceList as ws (ws.name)}
                  {#if ws.name === currentWorkspace}
                    <!-- svelte-ignore a11y_no_static_element_interactions -->
                    <div
                      class="toolbar-ws-option toolbar-ws-active"
                      title="Current workspace — right-click to rename or recover"
                      oncontextmenu={(e: MouseEvent) => { e.preventDefault(); wsDropdownOpen = false; openWorkspaceContextMenu(ws.name, e.clientX, e.clientY) }}
                    >
                      <span class="toolbar-ws-glyph">◇</span>
                      <span>{ws.name}</span>
                    </div>
                  {:else}
                    <!-- Workspaces are just repo paths — open as a tab. Path absent
                         when the workspace predates jj's workspace_store index
                         (additive-only; no backfill). Click-to-warn instead of
                         disabled+title — title is keyboard-inaccessible.
                         Right-click → forget. -->
                    <button
                      class="toolbar-ws-option"
                      class:toolbar-ws-unavailable={!ws.path}
                      onclick={() => { wsDropdownOpen = false; openWorkspaceTab(ws.name) }}
                      oncontextmenu={(e: MouseEvent) => { e.preventDefault(); wsDropdownOpen = false; openWorkspaceContextMenu(ws.name, e.clientX, e.clientY) }}
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
        <nav class="seg">
          <button
            class="seg-btn"
            class:active={activeView === 'log'}
            onclick={() => { if (!inlineMode) switchToLogView() }}
            disabled={inlineMode}
            title="Revision graph — main working view (1)"
          >◉ Revisions <kbd class="nav-hint">1</kbd></button>
          <button
            class="seg-btn"
            class:active={activeView === 'branches'}
            onclick={() => { if (!inlineMode) switchToBranchesView() }}
            disabled={inlineMode}
            title="Bookmarks panel — sync state at a glance (2)"
          >⑂ Branches <kbd class="nav-hint">2</kbd></button>
          <button
            class="seg-btn"
            class:active={activeView === 'merge'}
            onclick={() => { if (!inlineMode) switchToMergeView() }}
            disabled={inlineMode}
            title="Merge view — 3-pane conflict resolver (3)"
          >⧉ Merge <kbd class="nav-hint">3</kbd></button>
          {#if activeView === 'doc' && docFilePath}
            <button class="seg-btn active" onclick={closeDocView} title="Doc mode — click or Esc to close">
              ▤ {docFilePath.split('/').pop()}
            </button>
          {/if}
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
          title="Operation log — undo/restore any op (4)"
        >⟲ Oplog <kbd class="nav-hint">4</kbd></button>
        <!-- Not gated on selectedRevision — toggleEvolog already handles the
             null case (panel opens empty, populates once a revision is
             selected). Disabled-during-initial-load was confusing. -->
        <button
          class="toolbar-nav-btn"
          class:toolbar-nav-active={evologOpen}
          onclick={() => { if (!inlineMode) { switchToLogView(); toggleEvolog() } }}
          disabled={inlineMode}
          title="Evolution log — how this change evolved (5)"
        >◐ Evolog <kbd class="nav-hint">5</kbd></button>
        <span class="toolbar-divider"></span>
        <button class="toolbar-search" onclick={() => { closeModals(); paletteOpen = true }} title="Command palette ({cmdKey}K)">
          <span class="toolbar-search-text">Search…</span>
          <kbd class="toolbar-search-kbd">{cmdKey}K</kbd>
        </button>
      </div>
      <div class="toolbar-right">
        <button
          class="btn toolbar-theme"
          onclick={toggleTheme}
          title="Toggle theme (t)"
        >
          {darkMode ? '☀' : '●'}
        </button>
      </div>
    </div>

    {@render tabBar?.()}

    <div class="workspace">
      {#if activeView !== 'merge' && activeView !== 'doc'}
        <!-- Merge/doc modes hide the graph entirely — ConflictQueue + 3-pane
             MergePanel and DocView + comment-rail both need the full width.
             Branches keeps the graph (right-column sibling that references
             graph selection via the graphCommitId amber tint). -->
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
              placeholder={configuredLogRevset || "revset filter (press / to focus)"}
              onkeydown={(e: KeyboardEvent) => {
                if (e.key === 'Enter') {
                  e.preventDefault()
                  handleRevsetSubmit()
                  revsetInputEl?.blur()
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
            {#snippet chip(revset: string, label: string, desc: string, count?: number)}
              {@const active = revsetFilter === revset}
              <!-- Active chip → toggle off. Re-applying the same revset would
                   fire handleRevsetSubmit → diff.reset + clearChecks + reload,
                   wiping nav position for a no-op. -->
              <!-- title: human description first, raw revset second (\n is the
                   only multiline native tooltips support) — the description is
                   what most users need; the revset is for learning the syntax. -->
              <button
                class="preset-chip"
                class:active={active}
                onclick={() => applyRevsetExample(active ? '' : revset)}
                title={`${desc}\n${revset}`}
              >{label}{#if count !== undefined} <span class="chip-count">{count}</span>{/if}</button>
            {/snippet}
            {#each STATIC_PRESETS as p (p.key)}
              {@render chip(p.revset, p.label, p.desc)}
            {/each}
            {#if pullRequests.length > 0}
              {@render chip(prsRevset, 'PRs', 'Open pull requests and their stacks', pullRequests.length)}
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
            onselect={diffFrozen || activeView !== 'log' ? selectRevisionCursorOnly : selectRevision}
            ontogglecheck={toggleCheck}
            onrangecheck={rangeCheck}
            oncontextmenu={openRevisionContextMenu}
            onresolvedivergence={(cid) => divergence.enter(cid)}
            onnewfromchecked={handleNewFromChecked}
            onabandonchecked={handleAbandonChecked}
            onclearchecks={clearChecksAndReload}
            onbookmarkclick={openBookmarkModal}
            onworkspaceclick={openWorkspaceTab}
            onworkspacecontextmenu={openWorkspaceContextMenu}
            {currentWorkspace}
            {rebase}
            {squash}
            {split}
            theme={config.theme}
            themeEpoch={ghosttyThemes.length}
            {prByBookmark}
            {impliedCommitIds}
            remoteVisibility={repoVisibility}
          />
        </div>

        <!-- svelte-ignore a11y_no_static_element_interactions -->
        <div class="panel-divider" class:divider-active={draggingDivider} onmousedown={startDividerDrag}></div>
      {/if}

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
            onrefresh={() => bookmarksSync.refresh()}
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
        {:else if activeView === 'merge'}
          <div class="merge-mode-layout">
            <ConflictQueue
              bind:this={conflictQueueRef}
              entries={merge.queue}
              loading={merge.queueLoading}
              resolved={merge.resolved}
              current={merge.current}
              onselect={merge.selectFile}
              oncontextmenu={showContextMenu}
              onopenfile={editorConfigured ? handleOpenFile : undefined}
            />
            {#if merge.sides && merge.current}
              {#key `${merge.current.commitId}:${merge.current.path}`}
                <!-- No :catch — chunks are //go:embed'd in the binary, served
                     same-origin. The only failure is server-down = whole UI dead. -->
                {#await import('./lib/MergePanel.svelte') then { default: MergePanel }}
                  <MergePanel
                    sides={merge.sides}
                    filePath={merge.current.path}
                    busy={merge.busy}
                    onsave={merge.save}
                    oncancel={() => switchToLogView()}
                  />
                {/await}
              {/key}
            {:else if merge.current && merge.busy}
              <div class="merge-mode-empty">Loading conflict…</div>
            {:else if merge.current}
              <!-- bug_049: sides null + not busy = reconstructSides returned null.
                   Inner <div> because .merge-mode-empty is display:flex (centering) —
                   inline text + <br> + <code> get flex-item-ified and reorder. -->
              <div class="merge-mode-empty">
                <div>
                  <code>{merge.current.path}</code>
                  {#if merge.current.sides > 2}
                    <p><strong>{merge.current.sides}-way conflict</strong> — the 3-pane editor only handles 2-sided conflicts.</p>
                    <p>This usually means an unresolved 2-way conflict earlier in the stack propagated here. Resolve it at the <em>earliest</em> conflicted commit — descendants often auto-resolve.</p>
                  {:else}
                    <p><strong>Unsupported marker format</strong> — this 2-sided conflict uses git-style markers (<code>=======</code>) rather than jj's native format.</p>
                  {/if}
                  <p>Alternatively: edit the file directly, or use <code>jj resolve</code>.</p>
                </div>
              </div>
            {:else}
              <div class="merge-mode-empty">Select a conflict from the queue.</div>
            {/if}
          </div>
        {:else if activeView === 'doc' && docSession && docFilePath}
          <div class="doc-mode-layout">
            <div class="doc-mode-header panel-header">
              <span class="doc-mode-path truncate" title={docFilePath}>{docFilePath}{#if docSession.dirty}<span class="doc-dirty"> ●</span>{/if}</span>
              <div class="seg">
                <button class="seg-btn" class:active={!docEditable} onclick={() => docEditable = false}>View</button>
                <button class="seg-btn" class:active={docEditable} onclick={() => docEditable = true}>Edit</button>
              </div>
              <div class="doc-mode-actions">
                {#if docSession.busy}<span class="placeholder-text">Loading…</span>{/if}
                <button class="btn btn-sm" onclick={() => void docSession?.refreshComments()} title="Refresh comments now (auto-polls every 4s)">↻</button>
                <button class="btn btn-sm" onclick={() => docAgentPopover = !docAgentPopover} title="Agent API hint for this file">
                  Agent hint
                </button>
                <button class="btn btn-sm" disabled={!docSession.dirty || docSession.saving} onclick={handleDocCommit} title="Save to working copy (⌘S)">
                  {docSession.saving ? 'Saving…' : 'Save'}
                </button>
                <button class="close-btn" onclick={closeDocView} title="Close (Esc)">×</button>
              </div>
            </div>
            {#if docAgentPopover}
              <div class="doc-banner doc-agent-popover">
                <div>
                  <div>Paste into your agent:</div>
                  <code class="doc-agent-url">{docAgentHint.url}</code>
                  {#if docAgentHint.remote}
                    <div class="placeholder-text">Remote agent? Forward the port from this machine first:</div>
                    <code class="doc-agent-url">{docAgentHint.remote}</code>
                  {/if}
                </div>
                <button class="btn btn-sm btn-primary" onclick={() => {
                  navigator.clipboard.writeText(docAgentHint.url)
                  setMessage({ kind: 'success', text: 'Agent hint copied' })
                  docAgentPopover = false
                }}>Copy</button>
              </div>
            {/if}
            {#if docStale}
              <div class="doc-banner">
                File changed on disk since you opened it.
                <button class="btn btn-sm" onclick={handleDocReload}>Reload from disk</button>
                <button class="btn btn-sm btn-danger" onclick={handleDocOverwrite}>Overwrite anyway</button>
                <span class="placeholder-text">Overwriting is recoverable via <code>jj evolog</code>.</span>
              </div>
            {:else if docSession.normalizationDiff && !docSession.dirty}
              <div class="doc-banner">
                Formatting will be normalized on first save (list markers, escaping — no content change).
                <button class="btn btn-sm" onclick={() => { docEditable = true }}>Edit anyway</button>
              </div>
            {/if}
            {#key docFilePath}
              {#await Promise.all([import('./lib/DocView.svelte'), import('./lib/DocCommentRail.svelte')]) then [{ default: DocView }, { default: DocCommentRail }]}
                <div class="doc-mode-body">
                  <DocView
                    bind:this={docViewRef}
                    session={docSession}
                    editable={docEditable}
                    focusedComment={docFocusedComment}
                    onsave={handleDocCommit}
                    onaddcomment={(from, to, x, y) => {
                      docCommentDraft = { from, to, x, y }
                      docCommentDraftBody = ''
                    }}
                  />
                  <DocCommentRail
                    bind:this={docRailRef}
                    session={docSession}
                    vis={commentVis}
                    onhover={(id) => docFocusedComment = id}
                    onjump={(pos) => docViewRef?.scrollTo(pos)}
                    onaccept={(id) => {
                      const spec = docSession?.acceptSuggestion(id)
                      if (!spec) return
                      docViewRef?.applyReplace(spec.from, spec.to, spec.replacement)
                      void docSession?.resolveComment(id, 'addressed')
                    }}
                  />
                </div>
              {/await}
            {/key}
            {#if docCommentDraft}
              <div
                class="doc-comment-bubble"
                style:left="{Math.min(docCommentDraft.x, window.innerWidth - 350)}px"
                style:top="{docCommentDraft.y + 6}px"
              >
                <textarea
                  bind:this={docCommentDraftEl}
                  bind:value={docCommentDraftBody}
                  class="modal-input"
                  rows="3"
                  placeholder="Comment… (⌘Enter to add)"
                  onkeydown={(e) => {
                    e.stopPropagation()
                    if (e.key === 'Escape') { docCommentDraft = null }
                    else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); submitDocComment() }
                  }}
                ></textarea>
                <div class="doc-comment-bubble-actions">
                  <button class="btn" onclick={() => docCommentDraft = null}>Cancel</button>
                  <button class="btn btn-primary" disabled={!docCommentDraftBody.trim()} onclick={submitDocComment}>Add</button>
                </div>
              </div>
            {/if}
          </div>
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
            {diffPending}
            {diffLoading}
            {diffContentKey}
            bind:splitView={() => config.splitView, (v) => config.splitView = v}
            vis={commentVis}
            fileSelectionMode={squash.active ? 'squash' : (split.active && !split.review) ? 'split' : false}
            {hunkReview}
            selectedFiles={fileSel.set}
            ontogglefile={fileSel.toggle}
            onfilesaved={() => logSync.refresh()}
            onjjmutation={withMutation}
            oncontextmenu={showContextMenu}
            onopenfile={editorConfigured ? handleOpenFile : undefined}
            onfilehistory={openFileHistory}
            onopendoc={switchToDocView}
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
            onrefresh={() => { if (selectedRevision) void evolog.load(effectiveId(selectedRevision.commit)) }}
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
          onrefresh={() => oplogSync.refresh()}
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
    currentBookmarks={selectedRevision?.bookmarks?.map(b => b.name) ?? []}
    onexecute={handleGitOp}
  />

  <BookmarkInput
    bind:open={bookmarkInputOpen}
    onsave={handleBookmarkSet}
  />

  <DestinationInput
    bind:open={destInputOpen}
    verb={activeInlineMode ? destinationVerb[activeInlineMode.kind]() : ''}
    onsubmit={(dest) => { if (activeInlineMode) executeInlineMode[activeInlineMode.kind](dest) }}
  />

  <BookmarkModal
    bind:open={bookmarkModalOpen}
    currentCommitId={selectedRevision?.commit.commit_id ?? null}
    filterBookmark={bookmarkModalFilter}
    logOrder={revisions.map((r) => r.commit.commit_id)}
    onexecute={handleBookmarkOp}
    ontrackmenu={showTrackMenu}
  />

  {#if welcomeOpen}
    <WelcomeModal version={APP_VERSION} features={welcomeFeatures} title={welcomeTitle} onclose={dismissWelcome} />
  {/if}

  <ConfigModal
    open={configModalOpen}
    onclose={() => configModalOpen = false}
    onerror={(e) => setMessage(errorMessage(e))}
  />


  {#if fileHistoryPath}
    <div class="file-history-overlay">
      {#key fileHistoryPath}
        <FileHistoryPanel
          bind:this={fileHistoryRef}
          path={fileHistoryPath}
          initialPin={fileHistoryPin}
          onclose={() => { fileHistoryPath = null; fileHistoryPin = null }}
        />
      {/key}
    </div>
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
    color: var(--text-faint);
    font-size: var(--fs-md);
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
    font-size: var(--fs-md);
    outline: none;
    transition: border-color var(--anim-duration) var(--anim-ease);
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
    font-size: var(--fs-sm);
    padding: 2px 8px;
    border-radius: 3px;
    background: var(--surface0);
    color: var(--subtext0);
    border: 1px solid transparent;
    cursor: pointer;
    transition: all var(--anim-duration) var(--anim-ease);
  }
  .preset-chip:hover { background: var(--surface1); color: var(--text); }
  .preset-chip.active { border-color: var(--amber); color: var(--amber); background: var(--surface0); }
  .chip-count { opacity: 0.6; margin-left: 2px; }

  .revset-clear {
    background: transparent;
    border: none;
    color: var(--text-faint);
    cursor: pointer;
    font-family: inherit;
    font-size: var(--fs-lg);
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
    font-size: var(--fs-xs);
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
    font-size: var(--fs-md);
    line-height: 1.5;
  }
  .revset-help-popover p { margin: 0 0 8px; }
  .revset-help-popover p:last-child { margin: 0; }
  .revset-help-popover :is(code, kbd, .help-ex) {
    font-family: var(--font-mono);
    border-radius: 3px;
  }
  .revset-help-popover code {
    font-size: var(--fs-sm);
    background: var(--surface0);
    padding: 1px 4px;
  }
  .help-ex {
    font-size: var(--fs-sm);
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
    font-size: var(--fs-xs);
    border: 1px solid var(--surface1);
    padding: 0 3px;
  }
  .help-examples { color: var(--subtext0); font-size: var(--fs-sm); }

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

  .toolbar-left {
    display: flex;
    align-items: center;
    gap: 8px;
    min-width: 0;
    flex: 1;
  }

  .toolbar-right {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-shrink: 0;
  }

  .toolbar-logo {
    display: flex;
    align-items: center;
    gap: 6px;
    text-decoration: none;
  }

  .logo-icon {
    position: relative;
    display: flex;
    overflow: visible;
  }

  .update-dot {
    position: absolute;
    top: -3px;
    right: -4px;
    width: 9px;
    height: 9px;
    border-radius: 50%;
    background: var(--red);
    border: 1.5px solid var(--crust);
    box-shadow: 0 0 0 1px color-mix(in srgb, var(--red) 30%, transparent);
    z-index: 1;
    pointer-events: none;
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
    font-size: var(--fs-sm);
    color: var(--subtext0);
    cursor: pointer;
  }

  .toolbar-ws-btn:hover {
    background: var(--bg-hover);
    border-color: var(--surface2);
  }

  .toolbar-ws-glyph {
    color: var(--subtext0);
    font-size: var(--fs-xs);
  }

  .toolbar-ws-name {
    color: var(--text);
  }

  .toolbar-ws-chevron {
    font-size: var(--fs-2xs);
    color: var(--text-faint);
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
    font-size: var(--fs-sm);
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
    font-size: var(--fs-xs);
    color: var(--text-faint);
    margin-left: auto;
    opacity: 0;
  }

  .toolbar-ws-option:hover .toolbar-ws-open {
    opacity: 1;
  }

  .toolbar-ws-unavailable {
    opacity: 0.5;
  }

  /* "Update all" header action — same row chrome as an option, dimmed glyph,
     disabled while an inline mode is active. */
  .toolbar-ws-action {
    color: var(--text-faint);
  }
  .toolbar-ws-action:disabled {
    opacity: 0.4;
    cursor: default;
  }
  .toolbar-ws-sep {
    height: 1px;
    margin: 3px 4px;
    background: var(--surface1);
  }

  .toolbar-theme {
    border: none;
    font-size: var(--font-size);
    padding: 3px 6px;
  }

  .toolbar-nav-btn {
    padding: 3px 8px;
    background: transparent;
    border: none;
    border-radius: 4px;
    color: var(--subtext0);
    font-family: inherit;
    font-size: var(--fs-sm);
    cursor: pointer;
    line-height: 1.4;
    white-space: nowrap;
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
    color: var(--text-faint);
    font-family: inherit;
    font-size: var(--fs-sm);
    cursor: pointer;
  }

  .toolbar-search:hover {
    color: var(--subtext0);
  }

  .toolbar-search-kbd {
    font-family: var(--font-mono);
    font-size: var(--fs-2xs);
    color: var(--text-faint);
    background: none;
    border: 1px solid var(--surface1);
    padding: 0 4px;
    border-radius: 3px;
  }

  .merge-mode-layout,
  .doc-mode-layout {
    display: flex;
    flex: 1;
    min-width: 0;
    height: 100%;
    overflow: hidden;
  }
  .doc-mode-layout {
    flex-direction: column;
  }
  .doc-mode-body {
    display: flex;
    flex: 1;
    min-height: 0;
    overflow: hidden;
  }
  .doc-mode-body > :global(:first-child) {
    flex: 1;
    min-width: 0;
    overflow: auto;
  }
  .doc-mode-header {
    gap: 12px;
  }
  .doc-mode-path {
    font-family: var(--font-mono);
    font-size: var(--fs-sm);
    color: var(--subtext1);
    min-width: 0;
  }
  .doc-mode-actions {
    margin-left: auto;
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .doc-agent-popover {
    align-items: flex-start;
  }
  .doc-agent-popover > div {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .doc-agent-url {
    display: block;
    font-family: var(--font-mono);
    font-size: var(--fs-xs);
    word-break: break-all;
    background: var(--surface0);
    padding: 4px 6px;
    border-radius: 4px;
  }
  .doc-dirty {
    color: var(--amber);
    margin-left: 4px;
  }
  .doc-banner {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 6px 12px;
    background: var(--bg-warning);
    border-bottom: 1px solid var(--surface1);
    font-size: var(--fs-sm);
  }
  .doc-comment-bubble {
    position: fixed;
    z-index: 91;
    width: 340px;
    background: var(--mantle);
    border: 1px solid var(--surface1);
    border-radius: 6px;
    box-shadow: var(--shadow-heavy);
    padding: 8px;
  }
  .doc-comment-bubble textarea { width: 100%; resize: vertical; }
  .doc-comment-bubble-actions { display: flex; justify-content: flex-end; gap: 6px; margin-top: 6px; }
  .merge-mode-layout > :global(.merge-panel) {
    flex: 1;
    min-width: 0;
  }
  .merge-mode-empty {
    flex: 1;
    display: flex;
    align-items: center;
    justify-content: center;
    color: var(--subtext0);
  }

  .file-history-overlay {
    position: fixed;
    inset: 0;
    background: var(--base);
    z-index: 20;
    display: flex;
  }

</style>
