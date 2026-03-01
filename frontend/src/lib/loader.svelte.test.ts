import { describe, it, expect, vi } from 'vitest'
import { createLoader } from './loader.svelte'

// Yield to the macrotask queue — lets setTimeout(0) timers fire.
const macrotask = () => new Promise(r => setTimeout(r, 0))

describe('createLoader', () => {
  it('starts with initial value and not loading', () => {
    const loader = createLoader(async () => 42, 0)
    expect(loader.value).toBe(0)
    expect(loader.loading).toBe(false)
  })

  it('applies result of successful fetch and returns true', async () => {
    const loader = createLoader(async (x: number) => x * 2, 0)
    const ok = await loader.load(21)
    expect(ok).toBe(true)
    expect(loader.value).toBe(42)
    expect(loader.loading).toBe(false)
  })

  it('defers loading = true to next macrotask, clears after fetch', async () => {
    let resolve!: (v: number) => void
    const promise = new Promise<number>(r => { resolve = r })
    const loader = createLoader(() => promise, 0)
    const loadPromise = loader.load()
    expect(loader.loading).toBe(false) // deferred — not set yet
    await macrotask()
    expect(loader.loading).toBe(true)  // timer fired
    resolve(42)
    await loadPromise
    expect(loader.loading).toBe(false)
  })

  it('never flips loading for microtask-fast resolves (cache hits)', async () => {
    // api.ts cache hits return within one microtask (async function with
    // synchronous return). The loading timer schedules for the next macrotask,
    // which is AFTER microtasks drain — so it gets cleared before firing.
    const loader = createLoader(async () => 42, 0) // resolves in one microtask
    const p = loader.load()
    expect(loader.loading).toBe(false)
    await p
    expect(loader.loading).toBe(false) // never flipped
    expect(loader.value).toBe(42)
    // Verify timer was truly cancelled — wait a macrotask, still false
    await macrotask()
    expect(loader.loading).toBe(false)
  })

  it('forwards variadic args to fetch', async () => {
    const fetch = vi.fn(async (a: string, b: number) => `${a}-${b}`)
    const loader = createLoader(fetch, '')
    await loader.load('foo', 42)
    expect(fetch).toHaveBeenCalledWith('foo', 42)
    expect(loader.value).toBe('foo-42')
  })

  // --- Race conditions ---

  it('discards superseded result when older load resolves first', async () => {
    const resolves: ((v: number) => void)[] = []
    const fetch = () => new Promise<number>(r => resolves.push(r))
    const loader = createLoader(fetch, 0)

    const p1 = loader.load()
    const p2 = loader.load()

    resolves[0](111) // stale resolves first
    resolves[1](222)

    expect(await p1).toBe(false)
    expect(await p2).toBe(true)
    expect(loader.value).toBe(222)
  })

  it('discards superseded result even when it resolves last', async () => {
    const resolves: ((v: number) => void)[] = []
    const fetch = () => new Promise<number>(r => resolves.push(r))
    const loader = createLoader(fetch, 0)

    const p1 = loader.load()
    const p2 = loader.load()

    resolves[1](222) // newer resolves first
    expect(await p2).toBe(true)
    expect(loader.value).toBe(222)

    resolves[0](111) // stale resolves after
    expect(await p1).toBe(false)
    expect(loader.value).toBe(222) // unchanged
  })

  it('does not clear loading when superseded call finishes', async () => {
    // Scenario: p1 starts, p2 starts, p1 finishes (stale) — loading must stay true
    // because p2 is still in flight.
    const resolves: ((v: number) => void)[] = []
    const fetch = () => new Promise<number>(r => resolves.push(r))
    const loader = createLoader(fetch, 0)

    const p1 = loader.load()
    loader.load()
    await macrotask() // let p2's loading timer fire
    expect(loader.loading).toBe(true)
    resolves[0](111)
    await p1
    expect(loader.loading).toBe(true) // p2 still in flight
  })

  // --- Error handling ---

  it('resets value to initial on error and calls onError', async () => {
    const onError = vi.fn()
    const err = new Error('boom')
    const loader = createLoader(async () => { throw err }, 99, onError)

    const ok = await loader.load()
    expect(ok).toBe(false)
    expect(loader.value).toBe(99)
    expect(loader.loading).toBe(false)
    expect(loader.error).toBe('boom')
    expect(onError).toHaveBeenCalledExactlyOnceWith(err)
  })

  it('clears error on subsequent successful load', async () => {
    let shouldThrow = true
    const loader = createLoader(async () => {
      if (shouldThrow) throw new Error('boom')
      return 42
    }, 0)

    await loader.load()
    expect(loader.error).toBe('boom')

    shouldThrow = false
    await loader.load()
    expect(loader.error).toBe('')
    expect(loader.value).toBe(42)
  })

  it('reset clears error state', async () => {
    const loader = createLoader(async () => { throw new Error('boom') }, 0)
    await loader.load()
    expect(loader.error).toBe('boom')
    loader.reset()
    expect(loader.error).toBe('')
  })

  it('set clears error state (set means "I have a known-good value")', async () => {
    const loader = createLoader(async (): Promise<number> => { throw new Error('boom') }, 0)
    await loader.load()
    expect(loader.error).toBe('boom')
    loader.set(42)
    expect(loader.error).toBe('')
    expect(loader.value).toBe(42)
  })

  it('ignores superseded errors (no onError call, no reset)', async () => {
    const onError = vi.fn()
    let reject!: (e: unknown) => void
    let resolve!: (v: number) => void
    const promises = [
      new Promise<number>((_, rej) => { reject = rej }),
      new Promise<number>(res => { resolve = res }),
    ]
    let i = 0
    const loader = createLoader(() => promises[i++], 0, onError)

    const p1 = loader.load()
    const p2 = loader.load()

    reject(new Error('stale error'))
    expect(await p1).toBe(false)
    expect(onError).not.toHaveBeenCalled()
    expect(loader.value).toBe(0) // NOT reset by stale error

    resolve(42)
    expect(await p2).toBe(true)
    expect(loader.value).toBe(42)
  })

  it('swallows error silently when no onError provided', async () => {
    const loader = createLoader(async () => { throw new Error('boom') }, 0)
    expect(await loader.load()).toBe(false)
    expect(loader.value).toBe(0)
  })

  // --- reset() ---

  it('reset cancels in-flight load and restores initial', async () => {
    let resolve!: (v: number) => void
    const promise = new Promise<number>(r => { resolve = r })
    const loader = createLoader(() => promise, 0)

    const p = loader.load()
    await macrotask()
    expect(loader.loading).toBe(true)

    loader.reset()
    expect(loader.loading).toBe(false)
    expect(loader.value).toBe(0)

    resolve(42)
    expect(await p).toBe(false)
    expect(loader.value).toBe(0) // unchanged — in-flight was superseded by reset
  })

  it('reset clears pending loading timer', async () => {
    let resolve!: (v: number) => void
    const promise = new Promise<number>(r => { resolve = r })
    const loader = createLoader(() => promise, 0)

    loader.load() // timer scheduled
    loader.reset() // should clear timer
    await macrotask()
    expect(loader.loading).toBe(false) // timer never fired

    resolve(42) // cleanup
  })

  it('reset after successful load restores initial', async () => {
    const loader = createLoader(async () => 42, 0)
    await loader.load()
    expect(loader.value).toBe(42)
    loader.reset()
    expect(loader.value).toBe(0)
  })

  // --- set() ---

  it('set performs optimistic direct write', () => {
    const loader = createLoader(async () => 1, 0)
    loader.set(99)
    expect(loader.value).toBe(99)
  })

  it('set invalidates in-flight load (authoritative write wins)', async () => {
    // set() bumps generation so any in-flight load is discarded. This prevents
    // a race where cache-hit set() is overwritten by a stale network response.
    let resolve!: (v: number) => void
    const promise = new Promise<number>(r => { resolve = r })
    const loader = createLoader(() => promise, 0)

    const p = loader.load()
    loader.set(77) // authoritative write — invalidates in-flight load
    expect(loader.value).toBe(77)

    resolve(42)
    await p
    expect(loader.value).toBe(77) // set wins — load result discarded
  })

  // --- Reference equality guard ---

  it('equality guard works for primitive values (strings)', async () => {
    // Guard matters for strings (diffContent) where === is value equality.
    // Svelte 5 proxies objects/arrays so proxy !== raw — guard is a no-op
    // for those, matching existing App.svelte behavior.
    const loader = createLoader(async () => 'same', 'init')
    await loader.load()
    expect(loader.value).toBe('same')
    await loader.load() // returns identical string
    expect(loader.value).toBe('same')
  })
})
