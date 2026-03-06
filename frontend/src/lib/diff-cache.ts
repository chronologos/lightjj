// App-lifetime caches for DiffPanel's derived state. Previously lived in
// DiffPanel's <script module> because {#if divergence.active} unmounts the
// component. Hoisted here so clearDiffCaches() is callable from App's hard
// refresh — <script module> scope is unreachable from outside.
//
// See docs/CACHING.md §4-6 for per-cache keying and lifetime contracts.

import type { WordSpan } from './word-diff'
import { parseDiffContent, type DiffFile } from './diff-parser'
import { MAX_CACHE_SIZE } from './api'

export type DerivedCacheEntry = {
  highlights: Map<string, Map<string, string>>
  wordDiffs: Map<string, Map<string, Map<number, WordSpan[]>>>
}

export const DERIVED_CACHE_SIZE = 30
export const COLLAPSE_CACHE_SIZE = 50

// docs/CACHING.md §5 — parsedDiffCache/derivedCache evict before api.ts's
// response cache in normal navigation (each parse seeds ≥3 response-cache
// entries). Inverting the sizes would extend diff-string lifetime.
// Inverted comparison (!(x <= y), not x > y) so a mocked-out MAX_CACHE_SIZE
// → undefined → NaN comparison → false → throws, rather than silent-pass.
if (!(DERIVED_CACHE_SIZE <= MAX_CACHE_SIZE)) {
  throw new Error(`DERIVED_CACHE_SIZE (${DERIVED_CACHE_SIZE}) must be <= MAX_CACHE_SIZE (${MAX_CACHE_SIZE})`)
}

/** commit_id (or revset string) → highlight+word-diff output. */
export const derivedCache = new Map<string, DerivedCacheEntry>()

/** change_id → collapsed-file set. change_id-keyed so rewrites preserve UI state. */
export const collapseStateCache = new Map<string, Set<string>>()

/**
 * Raw diff text → parsed DiffFile[]. Keyed by text (not commit_id) so
 * context-expanded diffs (`:ctx10000` suffix in api.ts key) are distinct
 * AND cross-repo collision is cryptographically negligible.
 *
 * Ref-identity on revisit → DiffFileView's `file` prop is ref-equal →
 * `file.hunks` unchanged → split-view/line-number $derived chains stay quiet.
 */
const parsedDiffCache = new Map<string, DiffFile[]>()

export function parseDiffCached(raw: string): DiffFile[] {
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

/** LRU bump: delete first so set() moves to end (Map insertion-order). */
export function lruSet<K, V>(cache: Map<K, V>, key: K, value: V, max: number) {
  cache.delete(key)
  cache.set(key, value)
  if (cache.size > max) cache.delete(cache.keys().next().value!)
}

/**
 * Hard refresh. Call alongside api.ts's clearAllCaches().
 * Not wired into clearAllCaches() to avoid an api.ts → diff-cache import cycle
 * (diff-cache → api for MAX_CACHE_SIZE). App.svelte calls both sequentially.
 */
export function clearDiffCaches(): void {
  derivedCache.clear()
  collapseStateCache.clear()
  parsedDiffCache.clear()
}
