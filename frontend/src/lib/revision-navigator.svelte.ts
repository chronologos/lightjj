// What the diff panel shows: one target, plus content and metadata that each
// carry the target they belong to. App.svelte decides WHICH revision (cursor,
// checks, debounce inputs); this module owns loading it.
//
// Every loaded value is tagged with its own target, so "does this content belong
// to what's displayed?" is a comparison, never bookkeeping that each code path has
// to keep in step. Everything else (spinner, content key, readiness) is derived.

import { createLoader } from './loader.svelte'
import { api, effectiveId, diffTargetKey, fetchRevisionMeta, type LogEntry, type FileChange, type DiffTarget } from './api'

type Commit = LogEntry['commit']
type CacheHit = { diff: string; files: FileChange[]; description: string }

// Classes, not object literals: $state proxies plain objects, which would give a
// cache hit a new identity and re-run everything downstream.
class Content {
  constructor(readonly target: DiffTarget, readonly text: string) {}
}
class Meta {
  constructor(readonly target: DiffTarget, readonly files: FileChange[], readonly description: string) {}
}

const NO_FILES: FileChange[] = []

/** Same revision, possibly at a different commit (snapshot, describe): content for
 *  `a` may stay on screen while `b` loads. Keyed on change_id, not commit_id — a
 *  snapshot mints a new commit_id and a spinner there would unmount every
 *  DiffFileView (scroll, previews, open editors). */
function sameSubject(a: DiffTarget, b: DiffTarget): boolean {
  if (a.kind === 'single' && b.kind === 'single') return a.changeId === b.changeId
  return diffTargetKey(a) === diffTargetKey(b)
}

export interface RevisionNavigator {
  /** What's rendered in DiffPanel. Set SYNCHRONOUSLY at navigate-time; content
   *  catches up (progressive rendering). */
  readonly loadedTarget: DiffTarget | undefined
  /** Diff text on hand. May belong to an older target — see diffContentKey. */
  readonly diffText: string
  /** diffTargetKey of the target `diffText` belongs to ('' = none). "Content
   *  matches target" is `diffContentKey === diffTargetKey(loadedTarget)`. */
  readonly diffContentKey: string
  /** Show the spinner: nothing presentable for this target yet. False during a
   *  same-change refresh (stale content stays up) and after a failed load. */
  readonly diffPending: boolean
  /** A diff fetch is in flight (deferred one macrotask; cache hits never flip it). */
  readonly diffLoading: boolean
  readonly files: FileChange[]
  readonly description: string
  /** `files` is exactly the displayed target's list and its diff has settled — the
   *  only state from which a mode may snapshot the file list. */
  readonly ready: boolean
  singleTarget(c: Commit): Extract<DiffTarget, { kind: 'single' }>
  /** Display one revision now. Supersedes any pending navigate* schedule. */
  loadDiffAndFiles(commit: Commit): Promise<void>
  /** Display a multi-revision diff now. */
  loadMulti(target: DiffTarget & { kind: 'multi' }): Promise<void>
  /** Display one revision from cache, synchronously. */
  applyCacheHit(commit: Commit, hit: CacheHit): void
  /**
   * applyCacheHit past the next paint (double-rAF). `abort()` is checked at fire.
   *
   * Double-rAF: rAF callbacks run BEFORE paint in the same frame (event →
   * microtasks → rAF → style → layout → paint). Outer rAF = frame N pre-paint;
   * inner = frame N+1 pre-paint. Frame N paints the cursor move alone; the
   * diff DOM lands in frame N+1. Single rAF would batch cursor + diff into
   * one frame, making cached j/k feel SLOWER than uncached.
   */
  navigateCached(commit: Commit, hit: CacheHit, abort: () => boolean): void
  /**
   * loadDiffAndFiles after a 50ms debounce. `getCommit()` is re-read at fire —
   * rapid uncached j/k coalesces to wherever the cursor is WHEN it expires.
   */
  navigateDeferred(getCommit: () => Commit | null, abort: () => boolean): void
  /** Drop a pending navigate* schedule. In-flight loads are left alone: they
   *  belong to the displayed target. */
  cancelSchedule(): void
  /** Show nothing (empty log, nothing selected). */
  reset(): void
  /** Optimistic description for `commitId` after a describe. No-op if it isn't
   *  what's displayed. */
  setDescription(commitId: string, text: string): void
}

export function createRevisionNavigator(opts: {
  onError: (e: unknown) => void
}): RevisionNavigator {
  let target = $state.raw<DiffTarget | undefined>(undefined)
  // The target object whose diff load failed (identity: each load has its own).
  let failed = $state.raw<DiffTarget | undefined>(undefined)

  // keepValueOnError: a transient refresh failure must not blank the panel and
  // unmount open editors. Content for a different target is hidden by diffText.
  const diff = createLoader<Content | null, [DiffTarget]>(
    async t => new Content(t, (await api.diff(diffTargetKey(t))).diff),
    null, opts.onError, { keepValueOnError: true },
  )
  // Error-silent: a failing diff load already shows the toast.
  const meta = createLoader<Meta | null, [DiffTarget]>(
    async t => {
      if (t.kind === 'multi') return new Meta(t, await api.files(t.revset), '')
      await fetchRevisionMeta(t.commitId) // seeds both keys below in one request
      const [files, { description }] = await Promise.all([api.files(t.commitId), api.description(t.commitId)])
      return new Meta(t, files, description)
    },
    null, undefined, { keepValueOnError: true },
  )

  const targetKey = $derived(target && diffTargetKey(target))
  const contentShown = $derived(!!target && !!diff.value && sameSubject(diff.value.target, target))
  const diffContentKey = $derived(diff.value ? diffTargetKey(diff.value.target) : '')
  const diffFailed = $derived(!!target && failed === target)

  // Scheduling. While a schedule is pending, the displayed target is about to be
  // replaced: if it was still loading, keep the spinner rather than mount a diff
  // that will be thrown away (rapid j/k renders only the destination). Every way a
  // schedule ends goes through endSchedule, so this can't outlive it.
  let navRafId = 0
  let navDebounceTimer: ReturnType<typeof setTimeout> | undefined
  let holdSpinner = $state(false)

  const diffPending = $derived(!!target && ((!contentShown && !diffFailed) || holdSpinner))

  function endSchedule(): void {
    cancelAnimationFrame(navRafId)
    clearTimeout(navDebounceTimer)
    holdSpinner = false
  }

  function beginSchedule(): void {
    const pending = diffPending
    endSchedule()
    holdSpinner = pending
  }

  function singleTarget(c: Commit): Extract<DiffTarget, { kind: 'single' }> {
    return {
      kind: 'single',
      commitId: c.commit_id,
      changeId: effectiveId(c),
      isWorkingCopy: c.is_working_copy,
      immutable: c.immutable,
      parentIds: c.parent_ids,
    }
  }

  async function show(t: DiffTarget): Promise<void> {
    endSchedule()
    target = t
    // Both fire now; the loaders drop superseded results. Meta usually lands first
    // (header + file list render while the spinner covers the diff).
    const [applied] = await Promise.all([diff.load(t), meta.load(t)])
    // Not applied and still the displayed target = it failed (a newer load would
    // have replaced `target`).
    if (!applied && target === t) failed = t
  }

  function applyCacheHit(commit: Commit, hit: CacheHit): void {
    endSchedule()
    const t = singleTarget(commit)
    target = t
    diff.set(new Content(t, hit.diff))
    meta.set(new Meta(t, hit.files, hit.description))
  }

  return {
    get loadedTarget() { return target },
    get diffText() { return !diff.value || (diffFailed && !contentShown) ? '' : diff.value.text },
    get diffContentKey() { return diffContentKey },
    get diffPending() { return diffPending },
    get diffLoading() { return diff.loading },
    get files() {
      if (!meta.value || !target) return NO_FILES
      // Multi keeps the previous list until its own lands (no file-bar flicker on
      // each check); `ready` is what gates acting on it.
      return target.kind === 'multi' || sameSubject(meta.value.target, target) ? meta.value.files : NO_FILES
    },
    get description() {
      return meta.value && target?.kind === 'single' && sameSubject(meta.value.target, target) ? meta.value.description : ''
    },
    get ready() {
      return !!targetKey && !!meta.value && diffTargetKey(meta.value.target) === targetKey
        && (diffContentKey === targetKey || diffFailed)
    },
    singleTarget,
    loadDiffAndFiles: (commit) => show(singleTarget(commit)),
    loadMulti: show,
    applyCacheHit,
    navigateCached(commit, hit, abort) {
      beginSchedule()
      navRafId = requestAnimationFrame(() => {
        navRafId = requestAnimationFrame(() => {
          endSchedule()
          if (!abort()) applyCacheHit(commit, hit)
        })
      })
    },
    navigateDeferred(getCommit, abort) {
      beginSchedule()
      navDebounceTimer = setTimeout(() => {
        endSchedule()
        const commit = getCommit()
        if (commit && !abort()) void show(singleTarget(commit))
      }, 50)
    },
    cancelSchedule: endSchedule,
    reset() {
      endSchedule()
      target = undefined
      diff.reset()
      meta.reset()
    },
    setDescription(commitId, text) {
      const m = meta.value
      if (m?.target.kind === 'single' && m.target.commitId === commitId) meta.set(new Meta(m.target, m.files, text))
    },
  }
}
