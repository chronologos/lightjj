<script module lang="ts">
  import type { WordSpan } from './word-diff'
  import { parseDiffContent, type DiffFile } from './diff-parser'

  // Module-scoped caches — survive component unmount. DiffPanel is replaced by
  // DivergencePanel via {#if divergence.active} in App.svelte; without module
  // scope, opening that panel destroys 30 entries of Shiki work (~15s of CPU
  // on a busy session) and the user's collapse preferences for 50 revisions.
  type DerivedCacheEntry = {
    highlights: Map<string, Map<string, string>>
    wordDiffs: Map<string, Map<string, Map<number, WordSpan[]>>>
  }
  const derivedCache = new Map<string, DerivedCacheEntry>()
  const collapseStateCache = new Map<string, Set<string>>()
  const DERIVED_CACHE_SIZE = 30

  // parsedDiff cache — keyed by raw diff text (same string reference from
  // api.ts cache, so Map key lookup is a pointer compare, not a content scan).
  // Returns identical DiffFile[] on revisit → DiffFileView's `file` prop holds
  // a stable reference → `file.hunks` unchanged → lineNumsByHunk/splitLines/
  // parsedHunkHeaders $derived chains stay quiet on A→B→A navigation. The
  // strings are already retained by api.ts's cache (500 entries), so keying on
  // them here doesn't extend their lifetime.
  const parsedDiffCache = new Map<string, DiffFile[]>()

  function parseDiffCached(raw: string): DiffFile[] {
    if (!raw) return []
    const hit = parsedDiffCache.get(raw)
    if (hit) {
      lruSet(parsedDiffCache, raw, hit, DERIVED_CACHE_SIZE)
      return hit
    }
    const result = parseDiffContent(raw)
    lruSet(parsedDiffCache, raw, result, DERIVED_CACHE_SIZE)
    return result
  }

  function lruSet<K, V>(cache: Map<K, V>, key: K, value: V, max: number) {
    // LRU bump: delete first so set() moves to end
    cache.delete(key)
    cache.set(key, value)
    if (cache.size > max) cache.delete(cache.keys().next().value!)
  }

  /** Invalidate theme-specific cached highlights. Word diffs are theme-agnostic.
   *  Called by App.toggleTheme() — must be module-level because the cache now
   *  outlives the component instance. The instance's rehighlight() (via
   *  diffPanelRef?.rehighlight()) handles re-rendering if mounted, but that ref
   *  is undefined when DivergencePanel is showing. */
  export function clearHighlightCache(): void {
    for (const entry of derivedCache.values()) entry.highlights = new Map()
  }
</script>

<script lang="ts">
  import { tick } from 'svelte'
  import type { Snippet } from 'svelte'
  import { SvelteSet } from 'svelte/reactivity'
  import { api, diffTargetKey, type FileChange, type DiffTarget } from './api'
  import { type DiffLine } from './diff-parser'
  // parseDiffContent + DiffFile imported in <script module> — module-scope
  // exports are visible to the instance script in Svelte 5.
  import { groupByWithIndex } from './group-by'
  import { computeWordDiffs } from './word-diff'
  import { highlightLines, detectLanguage } from './highlighter'
  import { createDiffDerivation } from './diff-derivation.svelte'
  import DiffFileView, { type DiffLineInfo } from './DiffFileView.svelte'
  import ContextMenu, { type ContextMenuItem } from './ContextMenu.svelte'
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
    onresolve?: (file: string, tool: ':ours' | ':theirs') => void
    onfilesaved?: () => Promise<void> | void
    /** App's withMutation wrapper — serializes jj mutations across the app.
     *  Returns undefined if blocked (another mutation in flight). */
    onjjmutation?: <T>(fn: () => Promise<T>) => Promise<T | undefined>
  }

  let {
    diffContent, changedFiles, diffTarget,
    diffLoading, splitView = $bindable(false), header,
    fileSelectionMode, selectedFiles, ontogglefile, onresolve,
    onfilesaved, onjjmutation,
  }: Props = $props()

  // Stable string key for derivedCache + lastActiveRevId tracking.
  // commit_id for single-rev; revset string for multi-check.
  let activeRevisionId = $derived(diffTarget && diffTargetKey(diffTarget))

  // --- Local state ---
  let fileSelectIdx: number = $state(0)
  let fileSelectionListEl: HTMLElement | undefined = $state(undefined)
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

  // --- Diff line context menu ---
  let diffCtx: { items: ContextMenuItem[]; x: number; y: number; open: boolean } = $state({
    items: [], x: 0, y: 0, open: false,
  })

  function openDiffLineContextMenu(e: MouseEvent, info: DiffLineInfo): void {
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
      { label: `Copy reference`, action: () => navigator.clipboard.writeText(fullRef) },
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

    diffCtx = { items, x: e.clientX, y: e.clientY, open: true }
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
    lineContext: { filePath: string; lineNum: number; lineContent: string } | null
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
      lineContext: { filePath, lineNum, lineContent },
    }
  }

  function handleAnnotationClick(filePath: string, lineNum: number, lineContent: string, e: MouseEvent) {
    openAnnotationBubble(filePath, lineNum, lineContent, e.clientX, e.clientY)
  }

  async function saveAnnotation(comment: string, severity: AnnotationSeverity) {
    if (diffTarget?.kind !== 'single' || !annBubble.lineContext) return
    if (annBubble.editing) {
      await annotations.update({ ...annBubble.editing, comment, severity })
    } else {
      await annotations.add({
        changeId: diffTarget.changeId,
        createdAtCommitId: diffTarget.commitId,
        ...annBubble.lineContext,
        comment, severity,
      })
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

  async function startEdit(path: string) {
    if (diffTarget?.kind !== 'single' || editBusy.has(path)) return
    // Editor lives in the right split column — switch if coming from unified.
    // splitView is $bindable so this persists to config and the parent.
    if (!splitView) splitView = true
    // Capture from diffTarget (what's displayed), not selectedRevision (cursor).
    // In squash mode the cursor can be elsewhere.
    const { changeId: revId, isWorkingCopy } = diffTarget
    editBusy.add(path)
    editError = ''
    try {
      if (!isWorkingCopy) {
        // api.edit is a jj mutation — must go through App's mutation lock
        // to prevent races with keyboard-triggered mutations (e.g. 'u' undo).
        // Returns undefined if blocked by a concurrent mutation.
        const result = onjjmutation
          ? await onjjmutation(() => api.edit(revId))
          : await api.edit(revId)
        if (result === undefined && onjjmutation) {
          editError = 'Operation in progress — try again'
          return
        }
      }
      // Guard against display-target change during await (navigation)
      if (diffTarget?.kind !== 'single' || diffTarget.changeId !== revId) return
      const resp = await api.fileShow(revId, path)
      if (diffTarget?.kind !== 'single' || diffTarget.changeId !== revId) return
      editFileContents = new Map(editFileContents).set(path, resp.content)
      editingFiles.add(path)
    } catch (e) {
      editError = `Edit failed: ${e instanceof Error ? e.message : String(e)}`
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
      // Guard: display target may have changed since the editor was opened
      if (diffTarget?.kind !== 'single' || diffTarget.changeId !== revId) return
      await api.fileWrite(path, content)
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
  let conflictFetchGen = 0

  $effect(() => {
    const gen = ++conflictFetchGen
    const files = conflictOnlyFiles
    if (files.length === 0) {
      if (conflictFileDiffs.size > 0) conflictFileDiffs = new Map()
      return
    }
    // `jj file show -r 'connected(a|b)' path` is undefined — gate on single.
    // Multi-check conflict-only files stay unfetched (rare; the combined diff
    // usually includes them anyway).
    if (diffTarget?.kind !== 'single') return
    const revId = diffTarget.commitId
    for (const f of files) {
      if (conflictFileDiffs.has(f.path)) continue
      api.fileShow(revId, f.path).then(result => {
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

  function fileLineCount(file: DiffFile): number {
    return file.hunks.reduce((sum, h) => sum + h.lines.length, 0)
  }

  function shouldSkipWordDiff(file: DiffFile): boolean {
    if (fileLineCount(file) > WORD_DIFF_LINE_LIMIT) return true
    const lower = file.filePath.toLowerCase()
    return SKIP_WORD_DIFF_SUFFIXES.some(suffix => lower.endsWith(suffix))
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
    // First ~100 lines process without yield to prevent plain-text flicker
    // on navigation. Yields thereafter.
    immediateBudget: 100,
    readMemo: readDerived('highlights'),
    writeMemo: writeDerived('highlights'),
  })

  let highlightTimer: number | undefined

  // Highlight a single file's hunks and return a Map of line keys → HTML.
  // isStale lets highlightLines abort between chunks when the user navigates
  // mid-highlight — the previous revision's in-flight Shiki work shouldn't
  // block the next j/k keypress's paint.
  async function highlightFile(file: DiffFile, isStale: () => boolean): Promise<Map<string, string>> {
    const lang = detectLanguage(file.filePath)
    const fileMap = new Map<string, string>()
    for (let hunkIdx = 0; hunkIdx < file.hunks.length; hunkIdx++) {
      if (isStale()) return fileMap
      const hunk = file.hunks[hunkIdx]
      const groups = new Map<DiffLine['type'], { idx: number; content: string }[]>()
      hunk.lines.forEach((line, i) => {
        const list = groups.get(line.type) ?? []
        list.push({ idx: i, content: line.content.slice(1) })
        groups.set(line.type, list)
      })
      for (const [type, group] of groups) {
        const highlighted = await highlightLines(group.map(g => g.content), lang, isStale)
        if (isStale()) return fileMap
        const prefix = type === 'add' ? '+' : type === 'remove' ? '-' : ' '
        group.forEach((g, j) => {
          fileMap.set(
            `${file.filePath}:${hunkIdx}:${g.idx}`,
            `<span class="diff-prefix">${prefix}</span>${highlighted[j]}`,
          )
        })
      }
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
  // selection highlight before Shiki runs (~5-20ms for the immediate budget).
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
      lruSet(collapseStateCache, lastCollapseCacheKey, new Set(collapsedFiles), 50)
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
    activeFilePath = null
    conflictFetchGen++ // invalidate in-flight fileShow requests
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
    for (const file of parsedDiff) {
      if (fileLineCount(file) > AUTO_COLLAPSE_LINE_LIMIT) collapsedFiles.add(file.filePath)
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
    if (lastCollapseCacheKey) collapseStateCache.delete(lastCollapseCacheKey)
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

  function scrollFileSelectIntoView() {
    requestAnimationFrame(() => {
      fileSelectionListEl?.querySelector('.file-select-active')?.scrollIntoView({ block: 'nearest' })
    })
  }

  // Enter/Escape are intentionally NOT handled here — they bubble to
  // App.svelte's global keydown handler which executes/cancels the inline mode.
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
          if (!selectedFiles.has(f.path)) ontogglefile(f.path)
        }
        break
      case 'n':
        e.preventDefault()
        for (const f of changedFiles) {
          if (selectedFiles.has(f.path)) ontogglefile(f.path)
        }
        break
    }
  }

  // Auto-focus file selection list when entering split/squash mode,
  // blur when exiting to prevent j/k from being swallowed
  $effect(() => {
    if (fileSelectionMode && fileSelectionListEl) {
      fileSelectIdx = 0
      fileSelectionListEl.focus()
    } else if (!fileSelectionMode) {
      fileSelectionListEl?.blur()
    }
  })

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

  export function rehighlight() {
    clearHighlightCache() // module-level — see <script module>
    clearTimeout(highlightTimer)
    highlights.clear() // abort in-flight + clear output
    if (parsedDiff.length > 0) {
      // effectiveFiles (not parsedDiff) — preserves expanded-context highlights.
      // clearHighlightCache() emptied all .highlights entries → readMemo sees
      // size===0 → miss → recompute → writeMemo persists new-theme results.
      highlightTimer = setTimeout(() => highlights.run(effectiveFiles, activeRevisionId), 50)
    }
  }
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
    {@const selectionLabels = {
      squash: { title: 'Squash', countSuffix: 'to move' },
      split:  { title: 'Split',  countSuffix: 'stay' },
      review: { title: 'Review', countSuffix: 'accepted' },
    }[fileSelectionMode]}
    <div class="file-selection-panel" class:split-selection={fileSelectionMode !== 'squash'}>
      <div class="file-selection-header">
        <span class="file-selection-title">{selectionLabels.title} — <kbd>Space</kbd> toggle · <kbd>↑↓</kbd> navigate · <kbd>Enter</kbd> apply</span>
        <span class="file-selection-actions">
          <button class="file-select-action" onclick={() => { for (const f of changedFiles) { if (!selectedFiles.has(f.path)) ontogglefile(f.path) } }}>All</button>
          <button class="file-select-action" onclick={() => { for (const f of changedFiles) { if (selectedFiles.has(f.path)) ontogglefile(f.path) } }}>None</button>
        </span>
        <span class="file-selection-count">{selectedFiles.size}/{changedFiles.length} {selectionLabels.countSuffix}</span>
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
            class:file-checked={selectedFiles.has(file.path)}
            onclick={() => { fileSelectIdx = i; ontogglefile(file.path) }}
            onmouseenter={() => { fileSelectIdx = i }}
            role="option"
            tabindex="-1"
            aria-selected={selectedFiles.has(file.path)}
          >
            <span class="file-check-indicator">{selectedFiles.has(file.path) ? '✓' : ' '}</span>
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
  {#if diffTarget && changedFiles.length > 0 && !fileSelectionMode}
    <div class="file-list-bar">
      <span class="file-list-label">Files ({changedFiles.length}){#if conflictCount > 0}<span class="conflict-count-label"> · {conflictCount} conflict{conflictCount !== 1 ? 's' : ''}</span>{/if}</span>
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
    {#if diffLoading && parsedDiff.length === 0}
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
            {onresolve}
            searchMatches={matchesByFile.get(filePath) ?? EMPTY_MATCHES}
            {currentMatchIdx}
            editing={editingFiles.has(filePath)}
            editContent={editFileContents.get(filePath)}
            editBusy={editBusy.has(filePath)}
            onedit={startEdit}
            onsavefile={saveFile}
            oncanceledit={cancelEdit}
            onlinecontext={openDiffLineContextMenu}
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
              {onresolve}
              searchMatches={matchesByFile.get(cf.path) ?? EMPTY_MATCHES}
              {currentMatchIdx}
              onlinecontext={openDiffLineContextMenu}
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

<ContextMenu items={diffCtx.items} x={diffCtx.x} y={diffCtx.y} bind:open={diffCtx.open} />

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

  /* --- File selection panel (split/squash) --- */
  .file-selection-panel {
    border-bottom: 1px solid var(--amber);
    flex-shrink: 0;
    animation: slide-down var(--anim-duration) var(--anim-ease);
  }

  .file-selection-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 6px 12px;
    background: var(--bg-selected);
    font-size: 11px;
    font-weight: 600;
    color: var(--amber);
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

  .file-selection-actions {
    display: flex;
    gap: 6px;
    margin-left: auto;
    margin-right: 8px;
  }

  .file-select-action {
    background: none;
    border: none;
    color: var(--subtext0);
    font-family: inherit;
    font-size: 11px;
    font-weight: 500;
    cursor: pointer;
    padding: 0;
    text-decoration: underline;
    text-underline-offset: 2px;
  }

  .file-select-action:hover {
    color: var(--text);
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
    color: var(--amber);
    transform: scale(1.15);
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
    border-color: var(--conflict-side2-border);
    color: var(--red);
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
