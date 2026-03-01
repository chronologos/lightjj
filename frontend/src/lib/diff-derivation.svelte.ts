// Factory for per-file progressive diff derivations (Shiki highlighting,
// word-diff LCS). Replaces hand-rolled generation-counter + $state + memo-check
// blocks in DiffPanel with a testable abstraction, same as createLoader did
// for async fetches.
//
// The pattern: process DiffFile[] → Map<filePath, R> one file at a time,
// yielding between files so the UI stays responsive. Each run aborts any prior
// run. Completed runs are memoized by cacheKey (commit_id) so revisits restore
// instantly instead of re-running Shiki/LCS. Memoization is externalized so
// multiple derivations (highlights + wordDiffs) can share one LRU bucket and
// evict together.

import { untrack } from 'svelte'
import type { DiffFile } from './diff-parser'

type MaybePromise<T> = T | Promise<T>

export interface DiffDerivation<R> {
  /** Per-file results. Replaced with a fresh Map on each file completion so
   *  Svelte sees the change; inner per-file values are stable refs. */
  readonly byFile: Map<string, R>
  /**
   * Process all files, publishing per-file as each completes. Aborts any
   * in-flight run. On memo hit, restores the full map synchronously and
   * returns without computing.
   */
  run(files: DiffFile[], cacheKey?: string): void
  /**
   * Recompute a single file in-place, preserving all other entries. Aborts
   * any in-flight run (which holds a pre-update file snapshot and would
   * clobber this write on completion). For context expansion.
   */
  update(file: DiffFile): void
  /** Abort in-flight run and clear output. Does not touch the memo. */
  clear(): void
  /**
   * Synchronously restore from memo without scheduling a run. Returns true
   * on hit. For call sites that defer run() via setTimeout but want memo
   * hits to apply instantly (zero-frame restoration instead of one-tick
   * stale-content flash).
   */
  tryRestore(cacheKey: string): boolean
}

export interface DerivationOptions<R> {
  /** Compute one file's result. Receives isStale so async implementations
   *  (Shiki chunking) can abort mid-file. */
  compute: (file: DiffFile, isStale: () => boolean) => MaybePromise<R>
  /** Skip predicate — return true to exclude a file from processing. */
  skip?: (file: DiffFile) => boolean
  /** Lines to process before the first yield. Files are processed whole, so
   *  the budget is approximate — the first yield comes after the file that
   *  crosses the threshold. 0 (default) yields before every file. */
  immediateBudget?: number
  /** Read a memoized result for cacheKey. Return undefined on miss. */
  readMemo?: (cacheKey: string) => Map<string, R> | undefined
  /** Persist a completed run. Only called when all files finished without abort. */
  writeMemo?: (cacheKey: string, value: Map<string, R>) => void
}

export function createDiffDerivation<R>(opts: DerivationOptions<R>): DiffDerivation<R> {
  const { compute, skip = () => false, immediateBudget = 0, readMemo, writeMemo } = opts

  let byFile = $state<Map<string, R>>(new Map())
  let generation = 0

  // Imperative setter — methods are called from $effect bodies in DiffPanel,
  // and Svelte 5.44+ batching (PR #17145) folds the template effect that
  // reads byFile into the same flush pass. Without untrack(), the sync write
  // here + template read + effectiveFiles/expandedDiffs cycle accumulates
  // depth past MAX → effect_update_depth_exceeded. untrack() severs the
  // tracking link: callers own the reactive dependencies (effectiveFiles,
  // activeRevisionId), not the internal output state they're populating.
  const setByFile = (m: Map<string, R>) => untrack(() => { byFile = m })

  function fileLineCount(file: DiffFile): number {
    let n = 0
    for (const h of file.hunks) n += h.lines.length
    return n
  }

  function tryRestore(cacheKey: string): boolean {
    if (!readMemo) return false
    const cached = readMemo(cacheKey)
    if (!cached || cached.size === 0) return false
    generation++ // abort any in-flight run
    setByFile(cached)
    return true
  }

  async function run(files: DiffFile[], cacheKey?: string) {
    const gen = ++generation
    const isStale = () => gen !== generation

    if (cacheKey && tryRestore(cacheKey)) {
      // tryRestore bumped generation past ours; bail before touching byFile.
      return
    }

    // Clear stale output immediately so downstream consumers (DiffFileView)
    // don't render old-revision colors against new-revision text while the
    // first file is computing.
    setByFile(new Map())

    const done = new Map<string, R>()
    let linesProcessed = 0
    let firstYield = true

    for (let i = 0; i < files.length; i++) {
      const file = files[i]
      if (skip(file)) continue

      // Yield once the immediate budget is spent. firstYield gates the
      // i>0 case so a single large file doesn't yield before itself.
      if (linesProcessed >= immediateBudget && !firstYield) {
        await new Promise<void>(r => setTimeout(r, 0))
        if (isStale()) return
      }
      firstYield = false
      linesProcessed += fileLineCount(file)

      done.set(file.filePath, await compute(file, isStale))
      if (isStale()) return
      setByFile(new Map(done))
    }

    if (cacheKey && writeMemo && !isStale()) {
      writeMemo(cacheKey, untrack(() => byFile))
    }
  }

  function update(file: DiffFile) {
    const gen = ++generation // abort any in-flight run() holding a stale snapshot
    // untrack the read — update() is called from the derivation $effect in
    // DiffPanel; tracking byFile here would make the effect depend on its
    // own output.
    const next = new Map(untrack(() => byFile))
    if (skip(file)) {
      // e.g. context expansion pushed the file over the skip threshold —
      // drop the pre-expansion entry rather than keep stale data.
      next.delete(file.filePath)
      setByFile(next)
      return
    }
    const isStale = () => gen !== generation
    const result = compute(file, isStale)
    if (result instanceof Promise) {
      // Async single-file update (Shiki on context expansion). isStale lets
      // highlightLines' chunk loop abort mid-file if the user navigates away
      // — without it, a 1000-line expanded file processes all 34 chunks even
      // when superseded.
      result.then(r => {
        if (isStale()) return
        const m = new Map(untrack(() => byFile))
        m.set(file.filePath, r)
        setByFile(m)
      })
      return
    }
    next.set(file.filePath, result)
    setByFile(next)
  }

  function clear() {
    generation++
    setByFile(new Map())
  }

  return {
    get byFile() { return byFile },
    run,
    update,
    clear,
    tryRestore,
  }
}
