// Generic async loader with built-in generation counter for race-condition-free
// state management. Each load() call supersedes any in-flight call; only the
// latest-started load's result is ever applied. Resolves the "stale fetch
// overwrites fresh state" problem once, testably.

export interface Loader<T, A extends unknown[]> {
  /** Current loaded value. Starts at `initial`, resets to `initial` on error. */
  readonly value: T
  /** True while a load is in flight and is still the latest generation. */
  readonly loading: boolean
  /** Message from the last failed load, or '' if the last load succeeded. */
  readonly error: string
  /**
   * Fetch and assign. Returns true if this call's result was applied,
   * false if superseded by a newer load() or if fetch threw.
   */
  load(...args: A): Promise<boolean>
  /** Cancel in-flight loads and reset value to initial. */
  reset(): void
  /** Direct write — for optimistic updates after a mutation, without refetching. */
  set(v: T): void
}

export function createLoader<T, A extends unknown[]>(
  fetch: (...args: A) => Promise<T>,
  initial: T,
  onError?: (e: unknown) => void,
): Loader<T, A> {
  let value = $state<T>(initial)
  let loading = $state(false)
  let error = $state('')
  let generation = 0
  let loadingTimer: ReturnType<typeof setTimeout> | undefined

  async function load(...args: A): Promise<boolean> {
    const gen = ++generation
    // Defer loading = true to the next macrotask. Cache hits resolve within
    // the microtask queue, so this timer gets cleared before firing — meaning
    // cached loads never flip the loading flag and trigger zero reactive
    // updates. This is critical for fast j/k navigation through cached
    // revisions; without it, every keypress cascades through statusText and
    // DiffPanel prop updates.
    clearTimeout(loadingTimer)
    loadingTimer = setTimeout(() => {
      if (gen === generation) loading = true
    }, 0)
    try {
      const result = await fetch(...args)
      if (gen !== generation) return false
      clearTimeout(loadingTimer)
      // Reference-equality guard: skip assignment on cache hits returning
      // the same value, so downstream $derived chains don't re-run.
      if (value !== result) value = result
      if (error) error = '' // clear prior error on successful load
      return true
    } catch (e) {
      if (gen !== generation) return false
      clearTimeout(loadingTimer)
      value = initial
      error = e instanceof Error ? e.message : String(e)
      onError?.(e)
      return false
    } finally {
      // No-op if loading was never set true (Svelte $state assignment of
      // the same value doesn't trigger reactivity).
      if (gen === generation) loading = false
    }
  }

  function set(v: T) {
    // Bump generation so any in-flight load() is invalidated. Without this,
    // a load started before set() could overwrite the authoritative value
    // when it resolves (its gen check would pass against the old generation).
    generation++
    clearTimeout(loadingTimer)
    loading = false
    value = v
    error = ''
  }

  const reset = () => set(initial)

  return {
    get value() { return value },
    get loading() { return loading },
    get error() { return error },
    load,
    reset,
    set,
  }
}
