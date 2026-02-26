// Generic async loader with built-in generation counter for race-condition-free
// state management. Each load() call supersedes any in-flight call; only the
// latest-started load's result is ever applied. Resolves the "stale fetch
// overwrites fresh state" problem once, testably.

export interface Loader<T, A extends unknown[]> {
  /** Current loaded value. Starts at `initial`, resets to `initial` on error. */
  readonly value: T
  /** True while a load is in flight and is still the latest generation. */
  readonly loading: boolean
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
  let generation = 0

  async function load(...args: A): Promise<boolean> {
    const gen = ++generation
    loading = true
    try {
      const result = await fetch(...args)
      if (gen !== generation) return false
      // Reference-equality guard: skip assignment on cache hits returning
      // the same value, so downstream $derived chains don't re-run.
      if (value !== result) value = result
      return true
    } catch (e) {
      if (gen !== generation) return false
      value = initial
      onError?.(e)
      return false
    } finally {
      if (gen === generation) loading = false
    }
  }

  function reset() {
    generation++
    value = initial
    loading = false
  }

  function set(v: T) {
    value = v
  }

  return {
    get value() { return value },
    get loading() { return loading },
    load,
    reset,
    set,
  }
}
