import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// Mock the api module: the store must talk to the machine-state endpoints
// (api.recentActions / api.saveRecentActions) and nothing else.
const { mockGet, mockSave } = vi.hoisted(() => ({
  mockGet: vi.fn(),
  mockSave: vi.fn(),
}))

vi.mock('./api', () => ({
  api: {
    recentActions: mockGet,
    saveRecentActions: mockSave,
  },
}))

// vi.resetModules() per test → fresh store singleton (the module hydrates at
// load time, so per-test module state is the only way to vary hydration).
async function load() {
  return await import('./recent-actions.svelte')
}

beforeEach(() => {
  vi.resetModules()
  vi.useFakeTimers()
  mockGet.mockReset()
  mockSave.mockReset()
  mockGet.mockResolvedValue({})
  mockSave.mockResolvedValue(undefined)
})

afterEach(() => {
  vi.useRealTimers()
})

describe('recentActions factory', () => {
  it('record + snapshot round trip', async () => {
    const { recentActions } = await load()
    const h = recentActions('test-ns')
    h.record('main')
    expect(h.snapshot()).toHaveProperty('main')
  })

  it('namespaces are independent', async () => {
    const { recentActions } = await load()
    recentActions('a').record('x')
    recentActions('b').record('y')
    expect(recentActions('a').snapshot()).toHaveProperty('x')
    expect(recentActions('a').snapshot()).not.toHaveProperty('y')
  })

  it('clear removes only its namespace', async () => {
    const { recentActions } = await load()
    recentActions('a').record('x')
    recentActions('b').record('y')
    recentActions('a').clear()
    expect(recentActions('a').snapshot()).toEqual({})
    expect(recentActions('b').snapshot()).toHaveProperty('y')
  })

  it('caps entries at 200, evicting the oldest', async () => {
    const { recentActions } = await load()
    const h = recentActions('cap')
    for (let i = 0; i < 205; i++) {
      vi.setSystemTime(1_000_000 + i)
      h.record(`key-${i}`)
    }
    const snap = h.snapshot()
    expect(Object.keys(snap)).toHaveLength(200)
    expect(snap).not.toHaveProperty('key-0')   // oldest evicted
    expect(snap).toHaveProperty('key-204')     // newest kept
  })
})

describe('persistence (state.json via api)', () => {
  it('debounces saves through api.saveRecentActions', async () => {
    const { recentActions } = await load()
    const h = recentActions('ns')
    h.record('a')
    h.record('b')
    expect(mockSave).not.toHaveBeenCalled() // still inside the debounce window

    await vi.advanceTimersByTimeAsync(600)
    expect(mockSave).toHaveBeenCalledTimes(1) // one flush for both records
    const saved = mockSave.mock.calls[0][0] as Record<string, Record<string, number>>
    expect(Object.keys(saved.ns).sort()).toEqual(['a', 'b'])
  })

  it('hydrates from api.recentActions at module load', async () => {
    mockGet.mockResolvedValue({ 'bookmark-modal': { main: 123 } })
    const { recentActions } = await load()
    await vi.advanceTimersByTimeAsync(0) // flush hydration microtasks
    expect(recentActions('bookmark-modal').snapshot()).toEqual({ main: 123 })
  })

  it('late hydration does not clobber local writes', async () => {
    let resolveGet!: (v: unknown) => void
    mockGet.mockReturnValue(new Promise(r => { resolveGet = r }))
    const { recentActions } = await load()

    const h = recentActions('ns')
    h.record('local-key')

    // Server response arrives AFTER the local write.
    resolveGet({ ns: { 'server-key': 1 } })
    await vi.advanceTimersByTimeAsync(0)

    expect(h.snapshot()).toHaveProperty('local-key')
    expect(h.snapshot()).not.toHaveProperty('server-key')
  })

  it('sanitizes malformed hydration payloads', async () => {
    // A partially-mocked api (e.g. a generic mutation stub) can resolve with
    // a non-RecentActions shape; only well-formed entries may be applied.
    mockGet.mockResolvedValue({ output: '', valid: { k: 5 }, alsoBad: [1, 2] })
    const { recentActions } = await load()
    await vi.advanceTimersByTimeAsync(0)
    expect(recentActions('valid').snapshot()).toEqual({ k: 5 })
    expect(recentActions('output').snapshot()).toEqual({})
    expect(recentActions('alsoBad').snapshot()).toEqual({})
  })

  it('survives an api without state methods (partial component-test mocks)', async () => {
    // BookmarkModal.test.ts mocks './api' with only { bookmarks } — the store
    // loads through that graph and must not throw or reject unhandled.
    mockGet.mockImplementation(() => { throw new TypeError('api.recentActions is not a function') })
    mockSave.mockImplementation(() => { throw new TypeError('api.saveRecentActions is not a function') })

    const { recentActions } = await load()
    const h = recentActions('ns')
    h.record('k') // must not throw
    await vi.advanceTimersByTimeAsync(600) // debounced save must swallow the error
    expect(h.snapshot()).toHaveProperty('k')
  })
})

describe('recentActionsStore (config.svelte.ts back-compat surface)', () => {
  it('whole-map set is readable through factories and schedules a save', async () => {
    const mod = await load()
    mod.recentActionsStore.all = { 'bookmark-modal': { beta: 42 } }
    expect(mod.recentActions('bookmark-modal').snapshot()).toEqual({ beta: 42 })

    await vi.advanceTimersByTimeAsync(600)
    expect(mockSave).toHaveBeenCalledWith({ 'bookmark-modal': { beta: 42 } })
  })
})
