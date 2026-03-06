// Factory for per-file progressive diff derivations (highlights, word-diff
// LCS). Replaces hand-rolled generation-counter + $state + memo-check blocks
// in DiffPanel with a testable abstraction, same as createLoader did for
// async fetches.
//
// The pattern: process DiffFile[] → Map<filePath, R> one file at a time,
// yielding between files so the UI stays responsive. Each run aborts any prior
// run. Completed runs are memoized by cacheKey (commit_id) so revisits restore
// instantly instead of recomputing. Memoization is externalized so multiple
// derivations (highlights + wordDiffs) can share one LRU bucket and evict
// together.

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
  /** Compute one file's result. isStale lets async implementations abort
   *  mid-file (currently unused — both callers have sync bodies). */
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

  // Read helper for use inside methods called from the derivation $effect
  // in DiffPanel. Without untrack, `new Map(byFile)` establishes byFile as
  // a dep of that effect; subsequent writes to byFile then trigger
  // schedule_possible_effect_self_invalidation → effect_update_depth_exceeded.
  // (Maps aren't deep-proxied, so it's the Source-level dep that matters, not
  // iteration tracking.) Writes DON'T need untrack — Svelte's untracking flag
  // doesn't affect mark_reactions or self-invalidation scheduling for writes.
  const readByFile = () => untrack(() => byFile)

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
    byFile = cached
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
    byFile = new Map()

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

      // Branch on sync vs async compute — matches update() below. When
      // compute has a sync body (Lezer highlightFile) AND immediateBudget
      // is Infinity (no yields), run() is fully synchronous: zero awaits,
      // zero microtask suspensions. The await-on-non-Promise in the old code
      // forced a suspension per file — a 20-file diff lost ~20 microtask
      // turns to scheduling overhead for work that was already sync.
      const result = compute(file, isStale)
      done.set(file.filePath, result instanceof Promise ? await result : result)
      if (isStale()) return
      byFile = new Map(done)
    }

    if (cacheKey && writeMemo && !isStale()) {
      // `done` not `byFile` — independent reference, never aliased with the
      // Source's current value (which would make a future tryRestore no-op
      // on equality check if no intervening write happened).
      writeMemo(cacheKey, done)
    }
  }

  function update(file: DiffFile) {
    const gen = ++generation // abort any in-flight run() holding a stale snapshot
    const next = new Map(readByFile())
    if (skip(file)) {
      // e.g. context expansion pushed the file over the skip threshold —
      // drop the pre-expansion entry rather than keep stale data.
      next.delete(file.filePath)
      byFile = next
      return
    }
    const isStale = () => gen !== generation
    const result = compute(file, isStale)
    if (result instanceof Promise) {
      // Async compute: the post-await isStale check is the only abort point
      // (compute bodies are currently sync, so isStale passed to compute is
      // never actually read; kept for contract stability).
      result.then(r => {
        if (isStale()) return
        // Post-await: active_reaction is null, untrack is a no-op. But
        // readByFile() reads consistently so we don't second-guess context.
        const m = new Map(readByFile())
        m.set(file.filePath, r)
        byFile = m
      })
      return
    }
    next.set(file.filePath, result)
    byFile = next
  }

  function clear() {
    generation++
    byFile = new Map()
  }

  return {
    get byFile() { return byFile },
    run,
    update,
    clear,
    tryRestore,
  }
}
