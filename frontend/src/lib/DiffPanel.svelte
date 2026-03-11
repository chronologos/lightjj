<script lang="ts">
  import { tick, untrack } from 'svelte'
  import type { Snippet } from 'svelte'
  import { SvelteSet } from 'svelte/reactivity'
  import { api, diffTargetKey, type FileChange, type DiffTarget } from './api'
  import { parseDiffContent, type DiffFile, type DiffLine } from './diff-parser'
  import type { WordSpan } from './word-diff'
  import {
    derivedCache, collapseStateCache, parseDiffCached, lruSet,
    DERIVED_CACHE_SIZE, COLLAPSE_CACHE_SIZE, type DerivedCacheEntry,
  } from './diff-cache'
  import { groupByWithIndex } from './group-by'
  import { computeWordDiffs } from './word-diff'
  import { highlightLines, detectLanguage } from './highlighter'
  import { createDiffDerivation } from './diff-derivation.svelte'
  import DiffFileView, { type DiffLineInfo } from './DiffFileView.svelte'
  import MergePanel from './MergePanel.svelte'
  import { reconstructSides, type MergeSides } from './conflict-extract'
  import FileSelectionPanel from './FileSelectionPanel.svelte'
  import type { ContextMenuItem, ContextMenuHandler } from './ContextMenu.svelte'
  import AnnotationBubble from './AnnotationBubble.svelte'
  import { createAnnotationStore, exportMarkdown, exportJSON } from './annotations.svelte'
  import type { Annotation, AnnotationSeverity } from './api'

  interface Props {
    diffContent: string
    changedFiles: FileChange[]
    /** What's LOADED — derived from diff.value.target in App, in phase with
     *  diffContent by construction (same $state write). Not the cursor position.
     *  During squash mode the cursor moves but this stays frozen, by design. */
    diffTarget: DiffTarget | undefined
    diffLoading: boolean
    splitView: boolean
    /** Revision metadata header (change_id, description, bookmarks, describe
     *  editor). Rendered in single-rev mode; multi-check shows a simpler
     *  built-in header. Extracted to a snippet because the describe/bookmark/
     *  divergence flow is App's concern — DiffPanel just provides a slot. */
    header?: Snippet
    /** When truthy, shows the file-selection panel (checkbox list). The string
     *  value drives title/count labels. `false` = normal diff view. */
    fileSelectionMode: 'squash' | 'split' | 'review' | false
    selectedFiles: SvelteSet<string>
    ontogglefile: (path: string) => void
    onfilesaved?: () => Promise<void> | void
    /** App's withMutation wrapper — serializes jj mutations across the app.
     *  Returns undefined if blocked (another mutation in flight). */
    onjjmutation?: <T>(fn: () => Promise<T>) => Promise<T | undefined>
    /** Singleton context-menu dispatcher — items built here (component owns
     *  domain data), rendered by App's single <ContextMenu>. */
    oncontextmenu?: ContextMenuHandler
    /** Open a repo-relative path in the user's $EDITOR. undefined = disabled
     *  (SSH mode, no local fs). Used by file-header + diff-line menus. */
    onopenfile?: (path: string, line?: number) => void
  }

  let {
    diffContent, changedFiles, diffTarget,
    diffLoading, splitView = $bindable(false), header,
    fileSelectionMode, selectedFiles, ontogglefile,
    onfilesaved, onjjmutation, oncontextmenu, onopenfile,
  }: Props = $props()

  // Stable string key for derivedCache + lastActiveRevId tracking.
  // commit_id for single-rev; revset string for multi-check.
  let activeRevisionId = $derived(diffTarget && diffTargetKey(diffTarget))

  // --- Local state ---
  let panelContentEl: HTMLElement | undefined = $state(undefined)
  let activeFilePath: string | null = $state(null)
  let collapsedFiles = new SvelteSet<string>()

  // Expanded files: store full-context DiffFile per file path
  let expandedDiffs: Map<string, DiffFile> = $state(new Map())

  // --- Inline editing state ---
  let editingFiles = new SvelteSet<string>()
  let editFileContents = $state(new Map<string, string>())
  let editBusy = new SvelteSet<string>()  // concurrency guard + loading indicator
  let editError = $state('')  // last error message (shown in status bar area)

  // 3-pane merge — when set, MergePanel takes over .panel-content entirely
  // (vs FileEditor which slots into split-view's right column per-file).
  let mergeSides: MergeSides | null = $state(null)
  let mergingPath: string | null = $state(null)

  // --- Diff line context menu ---
  function openDiffLineContextMenu(e: MouseEvent, info: DiffLineInfo): void {
    if (!oncontextmenu) return
    const nums = info.lines.map(l => l.lineNum).filter((n): n is number => n !== null)
    const start = nums.length > 0 ? Math.min(...nums) : null
    const end = nums.length > 0 ? Math.max(...nums) : null
    // In multi-check mode the line could be from ANY commit in the revset —
    // omit the @ changeId suffix rather than attribute it to the wrong one.
    const changeId = diffTarget?.kind === 'single' ? diffTarget.changeId : ''

    // Build reference: path:line(-end) @ changeId
    let ref = info.filePath
    if (start !== null) {
      ref += end !== null && end !== start ? `:${start}-${end}` : `:${start}`
    }
    if (changeId) ref += ` @ ${changeId}`

    const content = info.lines.map(l => l.content).join('\n')
    const fullRef = `${ref}\n${content}`

    const items: ContextMenuItem[] = [
      { label: 'Copy file path', action: () => navigator.clipboard.writeText(info.filePath) },
      onopenfile
        ? { label: 'Open in editor', action: () => onopenfile(info.filePath, start ?? undefined) }
        : { label: 'Open in editor (not configured)', disabled: true },
      { separator: true },
      { label: 'Copy reference', action: () => navigator.clipboard.writeText(fullRef) },
    ]
    // Annotate only makes sense in single-rev mode (needs a stable changeId)
    // and when selection is a single line (annotations are per-line).
    if (diffTarget?.kind === 'single' && start !== null && start === end) {
      items.push({ separator: true })
      items.push({
        label: '💬 Annotate',
        action: () => openAnnotationBubble(info.filePath, start, info.lines[0].content, e.clientX, e.clientY),
      })
    }

    oncontextmenu(items, e.clientX, e.clientY)
  }

  // --- Annotations ---
  // Store is instance-scoped — annotations are per-changeId, loaded when
  // diffTarget changes. Multi-check mode (revset) doesn't support annotations
  // (which commit would they belong to?).
  const annotations = createAnnotationStore()

  interface AnnotationBubbleState {
    open: boolean
    x: number
    y: number
    editing: Annotation | null
    // changeId/createdAtCommitId are captured at open time — diffTarget is a
    // fresh $derived object on every nav, so reading it at SAVE time would
    // attach the annotation to whatever revision is now displayed.
    lineContext: { filePath: string; lineNum: number; lineContent: string; changeId: string; createdAtCommitId: string } | null
  }
  let annBubble = $state<AnnotationBubbleState>({
    open: false, x: 0, y: 0, editing: null, lineContext: null,
  })

  // Load + re-anchor whenever the displayed revision changes (single-rev only).
  // Agent iteration = same change_id, new commit_id. After loadLog() runs
  // (via SSE → onStale), diffTarget.commitId updates → this effect fires →
  // annotations.load() diffRange-adjusts line numbers. The commitId guard
  // prevents redundant loads during the cache-hit j/k path where diffTarget
  // is a fresh object but the strings inside are unchanged.
  let lastAnnCommitId: string | undefined
  $effect(() => {
    if (diffTarget?.kind !== 'single') return
    const { changeId, commitId } = diffTarget
    if (annotations.loadedChangeId === changeId && lastAnnCommitId === commitId) return
    lastAnnCommitId = commitId
    annotations.load(changeId, commitId).catch(() => {
      // Annotation load failure shouldn't block diff viewing — degrade silently.
    })
  })

  function openAnnotationBubble(filePath: string, lineNum: number, lineContent: string, x: number, y: number) {
    if (diffTarget?.kind !== 'single') return
    const existing = annotations.forLine(filePath, lineNum)
    annBubble = {
      open: true, x, y,
      editing: existing[0] ?? null,
      lineContext: {
        filePath, lineNum, lineContent,
        changeId: diffTarget.changeId,
        createdAtCommitId: diffTarget.commitId,
      },
    }
  }

  function handleAnnotationClick(filePath: string, lineNum: number, lineContent: string, e: MouseEvent) {
    openAnnotationBubble(filePath, lineNum, lineContent, e.clientX, e.clientY)
  }

  async function saveAnnotation(comment: string, severity: AnnotationSeverity) {
    if (!annBubble.lineContext) return
    if (annBubble.editing) {
      await annotations.update({ ...annBubble.editing, comment, severity })
    } else {
      await annotations.add({ ...annBubble.lineContext, comment, severity })
    }
  }

  // Per-file lookup closures — one per DiffFileView so the hot per-line path
  // stays O(1). The store's forLine() is already Map-backed; this just
  // captures filePath so the component doesn't need to pass it.
  function annotationsForFile(filePath: string) {
    return (lineNum: number) => annotations.forLine(filePath, lineNum)
  }

  // Summary counts — shown in a compact bar below the file list when non-zero.
  let openAnns = $derived(annotations.list.filter(a => a.status === 'open'))
  let orphanedAnns = $derived(annotations.list.filter(a => a.status === 'orphaned'))

  function scrollToAnnotation(ann: Annotation) {
    // Scroll to the file then to its approximate line position. DiffFileView
    // doesn't expose per-line scrolling; this gets close enough.
    scrollToFile(ann.filePath)
  }

  // Export helpers for command palette (bound via bind:this in App)
  export function exportAnnotationsMarkdown(): string {
    if (diffTarget?.kind !== 'single') return ''
    return exportMarkdown(annotations.list, diffTarget.changeId)
  }
  export function exportAnnotationsJSON(): string {
    if (diffTarget?.kind !== 'single') return ''
    return exportJSON(annotations.list, diffTarget.changeId, diffTarget.commitId)
  }
  export function hasAnnotations(): boolean {
    return annotations.list.some(a => a.status !== 'resolved')
  }

  // Capability gate for per-file mutations (Edit, Discard). Derived to
  // `undefined` when the button shouldn't render — DiffFileView's
  // `{#if ondiscard}` then hides it. Gates: single-rev only (multi-check
  // diff = which commit would we restore into?), mutable only (jj rejects
  // restore on immutable; hide, don't invite the error).
  let canMutateFiles = $derived(diffTarget?.kind === 'single' && !diffTarget.immutable)

  async function discardFile(path: string, sourcePath?: string) {
    // editBusy guard: startEdit releases the mutation lock after api.edit,
    // then awaits fileShow (holding only editBusy). Without this guard a
    // Discard click during that window races: restore succeeds, then the
    // resumed startEdit populates editFileContents with pre-discard content.
    if (diffTarget?.kind !== 'single' || editBusy.has(path)) return
    const revId = diffTarget.changeId
    // Renames need both paths: `jj restore -c X root-file:"dest"` only matches
    // the new path → rename would become a delete of the source.
    const files = sourcePath ? [sourcePath, path] : [path]
    editBusy.add(path)
    editError = ''
    try {
      const result = onjjmutation
        ? await onjjmutation(() => api.restore(revId, files))
        : await api.restore(revId, files)
      if (result === undefined && onjjmutation) {
        editError = 'Operation in progress — try again'
      }
      // No manual refresh: runMutation → op-id change → SSE → log refresh →
      // new commit_id → diff/files re-fetched. Same flow as abandon/squash.
    } catch (e) {
      editError = `Discard failed: ${e instanceof Error ? e.message : String(e)}`
    } finally {
      editBusy.delete(path)
    }
  }

  /** Shared prologue for startEdit/startMerge: guard, auto-jj-edit non-WC,
   *  fetch file content, post-await identity guards. Returns undefined on any
   *  bail (concurrent op, navigation during await, network error). The tricky
   *  post-await guards live here so a race fix lands in one place. */
  async function fetchFileForEdit(path: string, errorPrefix: string): Promise<string | undefined> {
    if (diffTarget?.kind !== 'single' || editBusy.has(path)) return undefined
    const { changeId: revId, isWorkingCopy } = diffTarget
    editBusy.add(path)
    editError = ''
    try {
      if (!isWorkingCopy) {
        // api.edit is a jj mutation — goes through App's mutation lock to
        // prevent races with keyboard-triggered mutations (e.g. 'u' undo).
        const result = onjjmutation
          ? await onjjmutation(() => api.edit(revId))
          : await api.edit(revId)
        if (result === undefined && onjjmutation) {
          editError = 'Operation in progress — try again'
          return undefined
        }
      }
      // Post-await identity guard — j/k navigation is possible during await.
      if (diffTarget?.kind !== 'single' || diffTarget.changeId !== revId) return undefined
      const resp = await api.fileShow(revId, path)
      if (diffTarget?.kind !== 'single' || diffTarget.changeId !== revId) return undefined
      return resp.content
    } catch (e) {
      editError = `${errorPrefix} failed: ${e instanceof Error ? e.message : String(e)}`
      return undefined
    } finally {
      editBusy.delete(path)
    }
  }

  function openFileEditor(path: string, content: string): void {
    // Editor lives in the right split column — switch if coming from unified.
    if (!splitView) splitView = true
    editFileContents = new Map(editFileContents).set(path, content)
    editingFiles.add(path)
  }

  async function startEdit(path: string) {
    const content = await fetchFileForEdit(path, 'Edit')
    if (content === undefined) return
    openFileEditor(path, content)
  }

  async function startMerge(path: string) {
    // MergePanel takes over .panel-content → all FileEditors unmount → CM6
    // state destroyed → unsaved edits lost. Editing the SAME file is fine (user
    // is switching edit modes); OTHER files might have unsaved work. Confirm
    // before any await — no post-await identity-guard complexity for this.
    const otherEdits = [...editingFiles].filter(p => p !== path)
    if (otherEdits.length > 0) {
      const names = otherEdits.length === 1 ? otherEdits[0] : `${otherEdits.length} files`
      if (!confirm(`Discard unsaved edits in ${names}?`)) return
    }
    const content = await fetchFileForEdit(path, 'Merge')
    if (content === undefined) return
    const sides = reconstructSides(content)
    // Unparseable (N-way, git-style) OR auto-resolved race (conflict_sides
    // said 2 but jj resolved between /api/files and here → all identical)
    // → fall back to raw FileEditor.
    if (!sides || sides.ours === sides.theirs) {
      openFileEditor(path, content)
      return
    }
    // Entering merge clears ALL in-progress file editors — MergePanel takes
    // over .panel-content entirely. User was warned via confirm() above.
    editingFiles.clear()
    editFileContents = new Map()
    mergeSides = sides
    mergingPath = path
  }

  function closeMerge() {
    mergeSides = null
    mergingPath = null
  }

  async function saveMerge(content: string) {
    const path = mergingPath
    if (!path || editBusy.has(path) || diffTarget?.kind !== 'single') return
    const revId = diffTarget.changeId
    editBusy.add(path)
    editError = ''
    try {
      await api.fileWrite(path, content)
      if (diffTarget?.kind !== 'single' || diffTarget.changeId !== revId) return
      closeMerge()
      await onfilesaved?.()
    } catch (e) {
      editError = `Save failed: ${e instanceof Error ? e.message : String(e)}`
    } finally {
      editBusy.delete(path)
    }
  }

  function clearEditState(path: string): void {
    editingFiles.delete(path)
    const next = new Map(editFileContents)
    next.delete(path)
    editFileContents = next
  }

  async function saveFile(path: string, content: string) {
    if (editBusy.has(path) || diffTarget?.kind !== 'single') return
    const revId = diffTarget.changeId
    editBusy.add(path)
    editError = ''
    try {
      await api.fileWrite(path, content)
      // Guard: display target may have changed during the await (navigation)
      if (diffTarget?.kind !== 'single' || diffTarget.changeId !== revId) return
      clearEditState(path)
      // Reload to show updated diff. Scroll position is preserved by the
      // stale-while-revalidate pattern in the panel-content {#if} — it keeps
      // showing the old diff until the new one arrives, and the keyed {#each}
      // maintains DiffFileView component instances across the swap.
      await onfilesaved?.()
    } catch (e) {
      editError = `Save failed: ${e instanceof Error ? e.message : String(e)}`
    } finally {
      editBusy.delete(path)
    }
  }

  function cancelEdit(path: string) {
    clearEditState(path)
  }

  let parsedDiff = $derived(parseDiffCached(diffContent))

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

  let conflictFileDiffs: Map<string, DiffFile> = $state(new Map())

  $effect(() => {
    const files = conflictOnlyFiles
    // untrack: .size/.has() reads would register conflictFileDiffs as a dep;
    // the async .then() write would then re-trigger this effect → O(n²) fetches.
    if (files.length === 0) {
      if (untrack(() => conflictFileDiffs.size) > 0) conflictFileDiffs = new Map()
      return
    }
    // `jj file show -r 'connected(a|b)' path` is undefined — gate on single.
    if (diffTarget?.kind !== 'single') return
    const revId = diffTarget.commitId
    // NO gen-counter. The old pattern (++gen here, gen check in callback) raced
    // with the reset effect: effects run in declaration order, so this fetch
    // fired FIRST on diffTarget change, then reset bumped gen → callback's gen
    // check failed → discarded → NO retry (reset's writes aren't tracked deps).
    // commitId alone is the correct invariant: it's a content hash, never
    // recycles, and IS what the fetch was keyed to. If diffTarget.commitId
    // still matches when fetch resolves, the data is provably valid.
    const already = untrack(() => conflictFileDiffs)
    for (const f of files) {
      if (already.has(f.path)) continue
      api.fileShow(revId, f.path).then(result => {
        if (diffTarget?.kind !== 'single' || diffTarget.commitId !== revId) return
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
  // Auto-collapse ALL files when total lines exceed this. Catches the
  // "many moderate files" case (e.g. 20 files × 100 lines) that per-file
  // AUTO_COLLAPSE_LINE_LIMIT misses. Collapsed files render header-only
  // (~1 DOM subtree vs ~lines×2 nodes each). Expand-all is one click.
  const AUTO_COLLAPSE_TOTAL_LINES = 2000
  // Per-file char limit — catches huge one-liners (minified JS, lock files
  // with one 800k-char line). Line-count triggers miss these entirely.
  // ~100 screen-widths of content is the threshold.
  const AUTO_COLLAPSE_CHAR_LIMIT = 20_000

  function fileLineCount(file: DiffFile): number {
    return file.hunks.reduce((sum, h) => sum + h.lines.length, 0)
  }

  // isOversize() is called 3× per file per navigation (wordDiffs.skip,
  // highlights.skip, auto-collapse). DiffFile objects have stable identity
  // within a nav (parseDiffCached) → WeakMap memo avoids the redundant walks.
  const charCountMemo = new WeakMap<DiffFile, number>()
  function fileCharCount(file: DiffFile): number {
    const cached = charCountMemo.get(file)
    if (cached !== undefined) return cached
    let n = 0
    for (const h of file.hunks) for (const l of h.lines) n += l.content.length
    charCountMemo.set(file, n)
    return n
  }

  // Shared threshold for skipping both word-diff AND highlighting. These run
  // synchronously over all files (highlights has immediateBudget:Infinity) —
  // a single 800k-char line freezes the UI for Lezer parse + LCS both, even
  // when the file is collapsed in the UI. Collapsed ≠ skipped compute.
  function isOversize(file: DiffFile): boolean {
    return fileCharCount(file) > AUTO_COLLAPSE_CHAR_LIMIT
  }

  function shouldSkipWordDiff(file: DiffFile): boolean {
    // Suffix check first — cheap, and most oversize files are .min.js anyway.
    const lower = file.filePath.toLowerCase()
    if (SKIP_WORD_DIFF_SUFFIXES.some(suffix => lower.endsWith(suffix))) return true
    if (fileLineCount(file) > WORD_DIFF_LINE_LIMIT) return true
    return isOversize(file)
  }

  // Per-file word diff maps. Each file's entry is a Map from "hunkIdx" to
  // Map<lineIdx, WordSpan[]>.
  const EMPTY_WD: Map<string, Map<number, WordSpan[]>> = new Map()

  function computeWordDiffsForFile(file: DiffFile): Map<string, Map<number, WordSpan[]>> {
    const fileMap = new Map<string, Map<number, WordSpan[]>>()
    for (let hunkIdx = 0; hunkIdx < file.hunks.length; hunkIdx++) {
      fileMap.set(String(hunkIdx), computeWordDiffs(file.hunks[hunkIdx]))
    }
    return fileMap
  }

  // Memo accessors wire the factories to the shared module-scoped derivedCache.
  // Both derivations share one LRU bucket so they evict together — viewing
  // revision X caches both, evicting X frees both.
  function readDerived<K extends keyof DerivedCacheEntry>(field: K) {
    return (cacheKey: string) => {
      const entry = derivedCache.get(cacheKey)
      if (!entry) return undefined
      lruSet(derivedCache, cacheKey, entry, DERIVED_CACHE_SIZE) // LRU bump on read
      return entry[field]
    }
  }
  function writeDerived<K extends keyof DerivedCacheEntry>(field: K) {
    return (cacheKey: string, value: DerivedCacheEntry[K]) => {
      const entry = derivedCache.get(cacheKey) ?? { highlights: new Map(), wordDiffs: new Map() }
      entry[field] = value
      lruSet(derivedCache, cacheKey, entry, DERIVED_CACHE_SIZE)
    }
  }

  const wordDiffs = createDiffDerivation({
    compute: computeWordDiffsForFile,
    skip: shouldSkipWordDiff,
    readMemo: readDerived('wordDiffs'),
    writeMemo: writeDerived('wordDiffs'),
  })

  const highlights = createDiffDerivation({
    compute: highlightFile,
    // skip oversize files: Lezer parse of a single 800k-char line is ~sec;
    // the file is auto-collapsed anyway (no visual benefit). If user expands,
    // they see unhighlighted content — correct tradeoff.
    skip: isOversize,
    // Sync compute + immediateBudget:Infinity → run() never awaits → fully
    // synchronous loop. The outer setTimeout(0) at the effect below provides
    // paint-first; run() itself has zero scheduling overhead.
    immediateBudget: Infinity,
    readMemo: readDerived('highlights'),
    writeMemo: writeDerived('highlights'),
  })

  let highlightTimer: number | undefined

  // Highlight a single file's hunks → Map of line keys → HTML. Sync — Lezer
  // parse+highlight for 500 lines is ~9ms, no yield/abort needed. run()
  // branches on Promise vs sync return (diff-derivation.svelte.ts) so a sync
  // body here means zero microtask suspensions per file.
  //
  // All hunk lines (add/remove/context mixed) feed one parse call. Context
  // lines provide the syntax scaffolding that per-type grouping would discard:
  // ` type Foo struct {\n- X int\n+ X string\n}` as one block → `X` parses as
  // tok-propertyName, `int` as tok-typeName. Same lines grouped by type →
  // orphan `X int` → `X` is tok-variableName, `int` unstyled.
  function highlightFile(file: DiffFile): Map<string, string> {
    const lang = detectLanguage(file.filePath)
    const fileMap = new Map<string, string>()
    for (let hunkIdx = 0; hunkIdx < file.hunks.length; hunkIdx++) {
      const hunk = file.hunks[hunkIdx]
      const highlighted = highlightLines(hunk.lines.map(l => l.content.slice(1)), lang)
      hunk.lines.forEach((line, i) => {
        fileMap.set(
          `${file.filePath}:${hunkIdx}:${i}`,
          `<span class="diff-prefix">${line.content[0]}</span>${highlighted[i]}`,
        )
      })
    }
    return fileMap
  }

  // Build effective file list that substitutes expanded versions.
  // Short-circuit to parsedDiff when nothing is expanded — .map() allocates
  // a fresh array, so without this the derivation $effect re-runs on every
  // revisit even though parsedDiffCache returned the same DiffFile[].
  let effectiveFiles = $derived(
    expandedDiffs.size === 0
      ? parsedDiff
      : parsedDiff.map(f => expandedDiffs.get(f.filePath) ?? f)
  )

  // Drive both derivations from one effect. Keyed by activeRevisionId
  // (commit_id or revset) so rewrites auto-invalidate (new commit_id → memo
  // miss). The factory's run() handles memo check, abort, progressive publish,
  // and memo write — see diff-derivation.svelte.ts.
  //
  // Highlight start is deferred one macrotask so the browser paints the
  // selection highlight before any sync work runs. Less critical post-Lezer
  // (~9ms vs Shiki's ~200ms) but still guarantees selection-first paint.
  // Word-diff isn't deferred — LCS is cheaper and has no immediate phase.
  // activeRevisionId is derived from diffTarget which is in phase with
  // diffContent (same $state write in App) — reading it here is safe.
  // Context-expansion handling: expandFile mutates expandedDiffs →
  // effectiveFiles recomputes with one substituted entry → call update()
  // for that file only, preserving all other highlighted/word-diffed entries.
  let lastDerivationFiles: DiffFile[] | undefined
  $effect(() => {
    const files = effectiveFiles
    const cacheKey = activeRevisionId
    clearTimeout(highlightTimer)

    if (files.length === 0) {
      lastDerivationFiles = undefined
      highlights.clear()
      wordDiffs.clear()
      return
    }

    // Single-file delta: everything ref-equal except one file. Only context
    // expansion produces this (navigation replaces the whole array via new
    // parsedDiff). update() preserves other entries and aborts in-flight run.
    if (lastDerivationFiles?.length === files.length) {
      const changedIdx = files.findIndex((f, i) => f !== lastDerivationFiles![i])
      if (changedIdx >= 0 && files.every((f, i) => i === changedIdx || f === lastDerivationFiles![i])) {
        lastDerivationFiles = files
        wordDiffs.update(files[changedIdx])
        highlights.update(files[changedIdx])
        return
      }
    }
    lastDerivationFiles = files

    wordDiffs.run(files, cacheKey)
    // Synchronous memo check — on revisit, restores highlights in the same
    // tick as the diff content update (no one-frame stale-color flash). Only
    // the miss path pays the setTimeout deferral.
    if (cacheKey && highlights.tryRestore(cacheKey)) return
    highlightTimer = setTimeout(() => highlights.run(files, cacheKey), 0)
    return () => clearTimeout(highlightTimer)
  })

  // Per-diff-identity reset — fires when the diff CONTENT being shown changes,
  // keyed by activeRevisionId (commit_id for single-rev, revset string for
  // multi-check). Cursor movement (j/k) in multi-check mode changes
  // selectedRevision but NOT activeRevisionId → this effect does not fire,
  // so expandedDiffs/editing state/search query correctly persist.
  //
  // collapseStateCache is keyed by change_id (survives rewrites) when in
  // single-rev mode; multi-check collapse state is ephemeral (not saved).
  let lastActiveRevId: string | undefined = undefined
  let lastCollapseCacheKey: string | null = null
  $effect(() => {
    if (activeRevisionId === lastActiveRevId) return

    // Save collapse state for the OUTGOING diff (single-rev only — multi-check
    // state is ephemeral). Must happen before collapsedFiles.clear().
    if (lastCollapseCacheKey && collapsedFiles.size > 0) {
      lruSet(collapseStateCache, lastCollapseCacheKey, new Set(collapsedFiles), COLLAPSE_CACHE_SIZE)
    }

    lastActiveRevId = activeRevisionId
    // Compute cache key for the INCOMING diff. Null for multi-check.
    // changeId (not commitId) — collapse preferences should survive rewrites.
    lastCollapseCacheKey = diffTarget?.kind === 'single' ? diffTarget.changeId : null

    collapsedFiles.clear()
    expandedDiffs = new Map()
    editingFiles.clear()
    editFileContents = new Map()
    editBusy.clear()
    editError = ''
    mergeSides = null
    mergingPath = null
    activeFilePath = null
    conflictFileDiffs = new Map()
    if (searchOpen) { searchQuery = ''; currentMatchIdx = 0 }

    // Suppress chevron transition during diff switch (prevents j/k flapping)
    panelContentEl?.classList.add('skip-transitions')
    requestAnimationFrame(() => panelContentEl?.classList.remove('skip-transitions'))

    // Restore collapse state for the INCOMING diff
    const saved = lastCollapseCacheKey ? collapseStateCache.get(lastCollapseCacheKey) : null
    if (saved) {
      for (const path of saved) collapsedFiles.add(path)
      // Suppress auto-collapse — user's manual choices are in the cache
      lastAutoCollapseDiff = diffContent
    }
  })

  // Auto-collapse large files to prevent DOM flooding
  let lastAutoCollapseDiff = ''
  $effect(() => {
    if (!diffContent || diffContent === lastAutoCollapseDiff) return
    lastAutoCollapseDiff = diffContent
    let total = 0
    for (const file of parsedDiff) {
      const n = fileLineCount(file)
      total += n
      if (n > AUTO_COLLAPSE_LINE_LIMIT || isOversize(file)) {
        collapsedFiles.add(file.filePath)
      }
    }
    // Many-moderate-files flooding: collapse everything, let user expand.
    // The per-file check above is now redundant when this fires, but it runs
    // first so we don't compute total when a single early file already trips it.
    if (total > AUTO_COLLAPSE_TOTAL_LINES) {
      for (const file of parsedDiff) collapsedFiles.add(file.filePath)
    }
  })

  // --- Expand context ---
  async function expandFile(filePath: string) {
    const capturedId = activeRevisionId
    if (!capturedId) return
    try {
      const result = await api.diff(capturedId, filePath, 10000)
      // Guard: navigation during the await would clear expandedDiffs via the
      // reset effect; writing now would re-add a stale-revision entry.
      if (activeRevisionId !== capturedId) return
      const parsed = parseDiffContent(result.diff)
      if (parsed.length > 0) {
        // Changing expandedDiffs triggers effectiveFiles → the derivation
        // $effect's single-file-delta path handles highlights + word-diffs.
        expandedDiffs = new Map(expandedDiffs).set(filePath, parsed[0])
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

  function scrollToFile(path: string, opts: { expand?: boolean; smooth?: boolean } = {}) {
    const { expand = true, smooth = true } = opts
    if (expand) collapsedFiles.delete(path)
    requestAnimationFrame(() => {
      const el = document.querySelector(`[data-file-path="${CSS.escape(path)}"]`)
      el?.scrollIntoView({ block: 'start', behavior: smooth ? 'smooth' : 'auto' })
    })
  }

  // Keyboard [/] step. Uses changedFiles order (same as file-tab bar).
  // Clamps at ends (no wrap). Writes activeFilePath DIRECTLY — the
  // IntersectionObserver callback is async (fires after layout) so rapid ]
  // spam would read a stale path and re-step to the same file. Manual scroll
  // still works: observer overwrites activeFilePath when headers cross the
  // top-20% zone. found<0 handles both null and truthy-but-unmatched.
  // expand=false: auto-collapsed huge files stay collapsed during [/] spam.
  export function stepFile(dir: 1 | -1) {
    if (changedFiles.length === 0) return
    const found = activeFilePath ? changedFiles.findIndex(f => f.path === activeFilePath) : -1
    const curIdx = found >= 0 ? found : (dir > 0 ? -1 : changedFiles.length)
    const next = Math.max(0, Math.min(changedFiles.length - 1, curIdx + dir))
    const path = changedFiles[next].path
    activeFilePath = path // sync write — observer would set this async, too late for spam
    scrollToFile(path, { expand: false, smooth: false })
  }

  // Reset collapsed files when diff changes significantly (e.g., multi-select)
  export function resetCollapsed() {
    collapsedFiles.clear()
    if (lastCollapseCacheKey) collapseStateCache.delete(lastCollapseCacheKey)
  }

  // Scroll position capture/restore for tab-switch state preservation.
  // AppShell snapshots on switch-away, App restores after next mount's diff loads.
  export function getScrollTop(): number {
    return panelContentEl?.scrollTop ?? 0
  }
  export function setScrollTop(v: number) {
    if (panelContentEl) panelContentEl.scrollTop = v
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

  export function openSearch() {
    if (!diffTarget) return
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

  // Track visible file via IntersectionObserver on file headers.
  // Defers DOM query with rAF so Svelte can flush new elements first.
  $effect(() => {
    const container = panelContentEl
    const diff = parsedDiff // track dependency
    if (!container || diff.length === 0) { activeFilePath = null; return }

    let observer: IntersectionObserver | null = null
    const raf = requestAnimationFrame(() => {
      const headers = container.querySelectorAll('.diff-file-header')
      if (headers.length === 0) return

      observer = new IntersectionObserver(
        (entries) => {
          let topEntry: IntersectionObserverEntry | null = null
          for (const entry of entries) {
            if (entry.isIntersecting) {
              if (!topEntry || entry.boundingClientRect.top < topEntry.boundingClientRect.top) {
                topEntry = entry
              }
            }
          }
          if (topEntry) {
            const fileEl = topEntry.target.closest('[data-file-path]')
            if (fileEl) activeFilePath = fileEl.getAttribute('data-file-path')
          }
        },
        { root: container, rootMargin: '0px 0px -80% 0px', threshold: 0 }
      )

      headers.forEach(h => observer!.observe(h))
    })
    return () => { cancelAnimationFrame(raf); observer?.disconnect() }
  })

</script>

<div class="panel diff-panel">
  {#if header && diffTarget?.kind === 'single'}
    {@render header()}
  {:else if diffTarget?.kind === 'multi'}
    <div class="panel-header">
      <span class="panel-title">
        Changes in
        <span class="header-change-id">{diffTarget.commitIds.length === 1 ? diffTarget.commitIds[0].slice(0, 12) : `${diffTarget.commitIds.length} revisions`}</span>
      </span>
    </div>
  {:else}
    <div class="panel-header">
      <span class="panel-title">Diff Viewer</span>
    </div>
  {/if}
  {#if fileSelectionMode}
    <FileSelectionPanel mode={fileSelectionMode} files={changedFiles} selected={selectedFiles} ontoggle={ontogglefile} {oncontextmenu} />
  {/if}
  {#if diffTarget && changedFiles.length > 0 && !fileSelectionMode}
    <div class="file-list-bar">
      <span class="file-list-label">Files <kbd class="nav-hint">[</kbd><kbd class="nav-hint">]</kbd> ({changedFiles.length}){#if conflictCount > 0}<span class="conflict-count-label"> · {conflictCount} conflict{conflictCount !== 1 ? 's' : ''}</span>{/if}</span>
      {#if totalStats.add > 0 || totalStats.del > 0}
        <span class="total-stats">
          {#if totalStats.add > 0}<span class="stat-add">+{totalStats.add}</span>{/if}
          {#if totalStats.del > 0}<span class="stat-del">-{totalStats.del}</span>{/if}
        </span>
      {/if}
      <div class="file-tabs" role="navigation" aria-label="Changed files">
        {#each changedFiles as file (file.path)}
          <button
            class="file-tab"
            class:file-tab-active={activeFilePath === file.path}
            onclick={() => scrollToFile(file.path)}
            title={file.path}
            aria-current={activeFilePath === file.path ? 'true' : undefined}
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
  {#if diffTarget?.kind === 'single' && (openAnns.length > 0 || orphanedAnns.length > 0)}
    <div class="annotations-bar">
      <span class="annotations-label">💬 {openAnns.length} open{#if orphanedAnns.length > 0} · <span class="orphaned-count">{orphanedAnns.length} possibly addressed</span>{/if}</span>
      <div class="annotations-chips">
        {#each openAnns as ann (ann.id)}
          <button class="ann-chip severity-{ann.severity}" onclick={() => scrollToAnnotation(ann)} title="{ann.filePath}:{ann.lineNum} — {ann.comment}">
            {ann.filePath.split('/').pop()}:{ann.lineNum}
          </button>
        {/each}
        {#each orphanedAnns as ann (ann.id)}
          <button class="ann-chip orphaned" onclick={() => openAnnotationBubble(ann.filePath, ann.lineNum, ann.lineContent, 200, 200)} title="(possibly addressed) {ann.comment}">
            {ann.filePath.split('/').pop()}:?
          </button>
        {/each}
      </div>
      <button class="ann-export" onclick={() => navigator.clipboard.writeText(exportAnnotationsMarkdown())} title="Copy markdown for agent prompt">
        Export ↗
      </button>
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
  <div class="panel-content" bind:this={panelContentEl}>
    {#if mergeSides && mergingPath}
      <!-- {#key} enforces fresh-mount per file — MergePanel's $effect has no
           centerView guard and relies on this for props-never-change-mid-mount. -->
      {#key mergingPath}
        <MergePanel sides={mergeSides} filePath={mergingPath}
          busy={editBusy.has(mergingPath)} error={editError}
          onsave={saveMerge} oncancel={closeMerge} />
      {/key}
    {:else if diffLoading && parsedDiff.length === 0}
      <!-- Spinner only on INITIAL load. For refreshes (parsedDiff populated),
           keep showing stale content until fresh arrives — prevents scroll
           jump from unmounting all DiffFileViews. The keyed {#each} preserves
           component instances across the content swap. -->
      <div class="empty-state">
        <div class="spinner"></div>
        <span>Loading diff...</span>
      </div>
    {:else if !diffTarget}
      <div class="empty-state">
        <span class="empty-hint">Select a revision to view changes</span>
        <span class="empty-subhint">Use <kbd>j</kbd>/<kbd>k</kbd> to navigate, <kbd>Enter</kbd> to select</span>
      </div>
    {:else if parsedDiff.length === 0 && changedFiles.length === 0 && conflictOnlyFiles.length === 0}
      <div class="empty-state">
        <span class="empty-hint">No changes in this revision</span>
      </div>
    {:else}
      {#if editError}
        <div class="edit-error-banner" role="alert">
          {editError}
          <button class="edit-error-dismiss" onclick={() => editError = ''}>×</button>
        </div>
      {/if}
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
            highlightedLines={highlights.byFile.get(filePath) ?? EMPTY_HL}
            wordDiffs={wordDiffs.byFile.get(filePath) ?? EMPTY_WD}
            ontoggle={toggleFile}
            onexpand={expandFile}
            searchMatches={matchesByFile.get(filePath) ?? EMPTY_MATCHES}
            {currentMatchIdx}
            editing={editingFiles.has(filePath)}
            editContent={editFileContents.get(filePath)}
            editBusy={editBusy.has(filePath)}
            onedit={canMutateFiles ? startEdit : undefined}
            onmerge={canMutateFiles ? startMerge : undefined}
            ondiscard={canMutateFiles ? discardFile : undefined}
            onsavefile={saveFile}
            oncanceledit={cancelEdit}
            onlinecontext={openDiffLineContextMenu}
            {oncontextmenu}
            {onopenfile}
            annotationsForLine={diffTarget?.kind === 'single' ? annotationsForFile(filePath) : undefined}
            onannotationclick={(ln, content, e) => handleAnnotationClick(filePath, ln, content, e)}
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
              wordDiffs={EMPTY_WD}
              ontoggle={toggleFile}
              onexpand={expandFile}
              onmerge={canMutateFiles ? startMerge : undefined}
              searchMatches={matchesByFile.get(cf.path) ?? EMPTY_MATCHES}
              {currentMatchIdx}
              onlinecontext={openDiffLineContextMenu}
              {oncontextmenu}
              {onopenfile}
            />
          {:else}
            <div class="diff-file" data-file-path={cf.path}>
              <div class="conflict-file-header">
                <span class="file-type-badge badge-C">C</span>
                <span class="diff-file-path">{cf.path}</span>
                <span class="conflict-loading">Loading...</span>
              </div>
            </div>
          {/if}
        {/each}
      </div>
    {/if}
  </div>
</div>

<AnnotationBubble
  bind:open={annBubble.open}
  x={annBubble.x}
  y={annBubble.y}
  editing={annBubble.editing}
  lineContext={annBubble.lineContext ?? undefined}
  onsave={saveAnnotation}
  ondelete={annBubble.editing ? () => annotations.remove(annBubble.editing!.id) : undefined}
  onclose={() => { annBubble.editing = null; annBubble.lineContext = null }}
/>

<style>
  /* NO transform/filter/will-change/contain on .panel — would trap the
     fixed-position AnnotationBubble (creates a new containing block). */
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

  /* Suppress transitions during revision switch to prevent j/k flapping.
     Fully :global() because skip-transitions is toggled via classList (not
     class: directive) so Svelte's compiler can't see it matches. */
  :global(.panel-content.skip-transitions .collapse-icon) {
    transition: none !important;
  }

  .panel-content {
    flex: 1;
    overflow-y: auto;
    overflow-x: hidden;
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
    transition: all var(--anim-duration) var(--anim-ease);
  }

  .file-tab:hover {
    color: var(--text);
    background: var(--bg-hover);
  }

  .file-tab-active {
    color: var(--text);
    border-bottom-color: var(--amber);
  }

  .file-tab-active .file-tab-name {
    font-weight: 600;
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

  /* --- Annotations summary bar --- */
  .annotations-bar {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 4px 12px;
    background: rgba(from var(--amber) r g b / 0.04);
    border-bottom: 1px solid var(--surface0);
    font-size: 11px;
    flex-shrink: 0;
  }
  .annotations-label { color: var(--subtext0); white-space: nowrap; }
  .orphaned-count { color: var(--green); }
  .annotations-chips {
    display: flex;
    gap: 4px;
    overflow-x: auto;
    flex: 1;
  }
  .ann-chip {
    background: var(--surface0);
    border: 1px solid var(--surface1);
    border-left-width: 3px;
    border-radius: 3px;
    padding: 1px 6px;
    font-size: 10px;
    font-family: var(--font-mono);
    cursor: pointer;
    white-space: nowrap;
  }
  .ann-chip:hover { background: var(--surface1); }
  .ann-chip.severity-must-fix { border-left-color: var(--red); }
  .ann-chip.severity-suggestion { border-left-color: var(--amber); }
  .ann-chip.severity-question { border-left-color: var(--blue); }
  .ann-chip.severity-nitpick { border-left-color: var(--surface2); }
  .ann-chip.orphaned { opacity: 0.6; border-style: dashed; }
  .ann-export {
    background: transparent;
    border: 1px solid var(--surface1);
    color: var(--subtext0);
    border-radius: 3px;
    padding: 2px 8px;
    font-size: 10px;
    cursor: pointer;
  }
  .ann-export:hover { color: var(--text); border-color: var(--surface2); }

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

  .edit-error-banner {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 6px 12px;
    background: var(--bg-error);
    border-bottom: 1px solid var(--red);
    color: var(--red);
    font-size: 12px;
    font-weight: 600;
  }
  .edit-error-dismiss {
    margin-left: auto;
    background: none;
    border: none;
    color: inherit;
    font-size: 16px;
    cursor: pointer;
    padding: 0 4px;
    opacity: 0.7;
  }
  .edit-error-dismiss:hover {
    opacity: 1;
  }
</style>
