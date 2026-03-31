// Fetch orchestration for the revision diff/files/description triple.
// Extracted from App.svelte to make the revGen await-gap race testable
// (docs/CACHING.md "Race-safety layer"). Owns the three content loaders;
// App.svelte wires selectedIndex/checkedRevisions/debounce around it.

import { createLoader, type Loader } from './loader.svelte'
import { api, effectiveId, diffTargetKey, fetchRevisionMeta, type LogEntry, type FileChange, type DiffTarget } from './api'

type Commit = LogEntry['commit']
type CacheHit = { diff: string; files: FileChange[]; description: string }

export interface RevisionNavigator {
  readonly diff: Loader<string, [DiffTarget]>
  readonly files: Loader<FileChange[], [string]>
  readonly description: Loader<string, [string]>
  /** What's rendered in DiffPanel. Decoupled from diff content for progressive
   *  rendering: set SYNCHRONOUSLY at navigate-time, before any fetch resolves.
   *  The diff loader holds content only — it lags loadedTarget during fetch. */
  readonly loadedTarget: DiffTarget | undefined
  /** True from navigate until diff.load() resolves. Explicit signal for the
   *  spinner gate — diff.loading alone has a one-macrotask gap (setTimeout 0
   *  defer in loader.svelte.ts, which is correct for cache-hit flicker). */
  readonly diffPending: boolean
  singleTarget(c: Commit): DiffTarget
  /**
   * Progressive load: sets loadedTarget + diffPending SYNC (header renders,
   * spinner shows), fires diff.load eager (long pole), awaits meta (~20ms),
   * then fires files/description (cache hits — file list renders). `shouldAbort`
   * re-checked after the meta await — e.g. "user checked a revision while we
   * were fetching, the multi-check effect already fired, don't clobber".
   */
  loadDiffAndFiles(commit: Commit, shouldAbort: () => boolean): Promise<void>
  /**
   * Synchronous cache-hit application. Bumps revGen so any suspended
   * loadDiffAndFiles bails before firing its `files.load()` — without this,
   * the resumed call's `files.load(stale)` would bump loader.generation PAST
   * the `files.set()` here and win. diff races handled by loader.generation
   * directly (diff.load fires eager, before the await). See docs/CACHING.md.
   */
  applyCacheHit(commit: Commit, hit: CacheHit): void
  /**
   * Invalidate any in-flight loadDiffAndFiles AND any pending navigate*
   * schedule without changing loader values. For App-level "stop whatever's
   * pending" cases (clear-checks, mode entry, switchToLogView).
   */
  cancel(): void
  /**
   * Schedule applyCacheHit past the next paint (double-rAF). Cancels any
   * prior navigate* schedule. `abort()` re-checked at fire — guards against
   * cursor moving via a path that doesn't call navigate* (loadLog's
   * selectedIndex reset, selectRevisionCursorOnly).
   *
   * Double-rAF: rAF callbacks run BEFORE paint in the same frame (event →
   * microtasks → rAF → style → layout → paint). Outer rAF = frame N pre-paint;
   * inner = frame N+1 pre-paint. Frame N paints the cursor move alone; the
   * diff DOM lands in frame N+1. Single rAF would batch cursor + diff into
   * one frame, making cached j/k feel SLOWER than uncached.
   */
  navigateCached(commit: Commit, hit: CacheHit, abort: () => boolean): void
  /**
   * Schedule loadDiffAndFiles after a 50ms debounce. Cancels any prior
   * navigate* schedule. `getCommit()` is re-read at fire — rapid uncached
   * j/k coalesces to whatever the cursor points at WHEN the debounce expires,
   * not what it pointed at when scheduled. Return null to abort.
   */
  navigateDeferred(getCommit: () => Commit | null, abort: () => boolean): void
}

export function createRevisionNavigator(opts: {
  onError: (e: unknown) => void
}): RevisionNavigator {
  const diff = createLoader(
    (t: DiffTarget) => api.diff(diffTargetKey(t)).then(r => r.diff),
    '',
    opts.onError,
  )
  const files = createLoader((id: string) => api.files(id), [] as FileChange[], opts.onError)
  const description = createLoader((id: string) => api.description(id).then(r => r.description), '')

  let loadedTarget: DiffTarget | undefined = $state(undefined)
  let diffPending = $state(false)

  // revGen guards the gap between the meta await and files/description.load().
  // loader.generation alone isn't enough: it invalidates in-flight load()
  // calls, but a suspended loadDiffAndFiles hasn't CALLED files.load() yet —
  // when it resumes and calls it, that call bumps loader.generation past any
  // intervening set()/load() and wins. revGen catches it before the call.
  let revGen = 0

  function singleTarget(c: Commit): DiffTarget {
    return {
      kind: 'single',
      commitId: c.commit_id,
      changeId: effectiveId(c),
      isWorkingCopy: c.is_working_copy,
      immutable: c.immutable,
    }
  }

  async function loadDiffAndFiles(commit: Commit, shouldAbort: () => boolean): Promise<void> {
    const gen = ++revGen
    const target = singleTarget(commit)
    // Refresh (post-mutation loadLog, same commit_id): keep stale content
    // visible — no spinner, no reset, scroll preserved via DiffFileView key
    // stability. New target: spinner + reset so the wrong revision's data
    // doesn't sit under the new changeId during the ~440ms SSH meta wait.
    const isRefresh = loadedTarget?.kind === 'single' && loadedTarget.commitId === commit.commit_id
    loadedTarget = target
    if (!isRefresh) {
      diffPending = true
      files.reset()
      description.reset()
    }
    // Diff is the long pole (~200ms+ for large commits). Fire independently;
    // template shows spinner until this resolves.
    diff.load(target).finally(() => {
      if (gen === revGen) diffPending = false
    })
    // Meta (~20ms) resolves first → file list + description render while
    // spinner covers the diff area. Error-silent: diff.load's error handling
    // already surfaces the visible toast, and meta failing alone is rare.
    try {
      await fetchRevisionMeta(commit.commit_id)
    } catch { return }
    if (gen !== revGen || shouldAbort()) return
    files.load(commit.commit_id)
    description.load(commit.commit_id)
  }

  function applyCacheHit(commit: Commit, hit: CacheHit): void {
    revGen++
    loadedTarget = singleTarget(commit)
    diffPending = false
    diff.set(hit.diff)
    files.set(hit.files)
    description.set(hit.description)
  }

  // Scheduling timers — previously App.svelte instance state (navRafId,
  // navDebounceTimer). Owning them here means cancel() clears everything
  // in one call, and the double-rAF timing is testable via fake timers.
  let navRafId = 0
  let navDebounceTimer: ReturnType<typeof setTimeout> | undefined

  function clearSchedule(): void {
    cancelAnimationFrame(navRafId)
    clearTimeout(navDebounceTimer)
  }

  function navigateCached(commit: Commit, hit: CacheHit, abort: () => boolean): void {
    clearSchedule()
    // revGen bump NOW: a loadDiffAndFiles suspended at its meta await could
    // resume after the rAF fires, call files.load(stale), clobbering
    // applyCacheHit's files.set(). Bump here invalidates it before it races.
    revGen++
    navRafId = requestAnimationFrame(() => {
      navRafId = requestAnimationFrame(() => {
        if (abort()) return
        applyCacheHit(commit, hit)
      })
    })
  }

  function navigateDeferred(getCommit: () => Commit | null, abort: () => boolean): void {
    clearSchedule()
    // Same entry-time bump as navigateCached: a suspended loadDiffAndFiles
    // could otherwise resume during the 50ms window, pass its revGen check,
    // and fire files.load(stale). Bumping here stops it before it fires.
    revGen++
    navDebounceTimer = setTimeout(() => {
      const commit = getCommit()
      if (!commit || abort()) return
      loadDiffAndFiles(commit, abort)
    }, 50)
  }

  function cancel(): void {
    clearSchedule()
    revGen++
    // diffPending deliberately NOT cleared: switchToLogView uses it to detect
    // "loadedTarget set but content still in flight" (returns false → caller
    // retries after load settles). All cancel() callers follow with either
    // unmount or a fresh loadDiffAndFiles, so spinner never actually sticks.
  }

  return {
    diff, files, description, singleTarget,
    get loadedTarget() { return loadedTarget },
    get diffPending() { return diffPending },
    loadDiffAndFiles, applyCacheHit, cancel,
    navigateCached, navigateDeferred,
  }
}
