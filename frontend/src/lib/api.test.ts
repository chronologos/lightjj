import { describe, it, expect, vi, beforeEach } from 'vitest'
import { api, isCached, onStale, multiRevset, computeConnectedCommitIds, prefetchRevision, _testInternals, type LogEntry } from './api'

// Mock fetch globally
const mockFetch = vi.fn()
vi.stubGlobal('fetch', mockFetch)

function mockResponse(data: unknown, opId: string | null = 'op1', ok = true, status = 200) {
  const headers = new Map<string, string>()
  if (opId) headers.set('X-JJ-Op-Id', opId)
  return {
    ok,
    status,
    headers: { get: (k: string) => headers.get(k) ?? null },
    json: () => Promise.resolve(data),
  }
}

beforeEach(() => {
  mockFetch.mockReset()
  _testInternals.lastOpId = null
  _testInternals.cache.clear()
  _testInternals.immutableCache.clear()
  _testInternals.staleCallbacks.clear()
  _testInternals.refreshQueued = false
  _testInternals.resetSessionCaches()
})

describe('response cache', () => {
  it('caches diff response and returns from cache on second call', async () => {
    const diffData = { diff: '+added line' }
    mockFetch.mockResolvedValue(mockResponse(diffData, 'op1'))

    // First call: seeds lastOpId and fetches
    const result1 = await api.diff('abc')
    expect(result1).toEqual(diffData)
    expect(mockFetch).toHaveBeenCalledTimes(1)

    // Second call: should hit cache, no fetch
    const result2 = await api.diff('abc')
    expect(result2).toEqual(diffData)
    expect(mockFetch).toHaveBeenCalledTimes(1) // still 1
  })

  it('does not cache when op-id is unknown', async () => {
    const diffData = { diff: '+line' }
    // Response without op-id header
    mockFetch.mockResolvedValue(mockResponse(diffData, null))

    await api.diff('abc')
    await api.diff('abc')
    // Both should fetch since no op-id to key against
    expect(mockFetch).toHaveBeenCalledTimes(2)
  })

  it('clears cache when op-id changes (detected by a non-cached request)', async () => {
    const diffData1 = { diff: '+v1' }
    const diffData2 = { diff: '+v2' }
    mockFetch.mockResolvedValueOnce(mockResponse(diffData1, 'op1'))

    await api.diff('abc')
    expect(mockFetch).toHaveBeenCalledTimes(1)
    expect(_testInternals.cache.size).toBe(1)

    // A non-cached request (e.g. log) comes back with a new op-id,
    // which triggers trackOpId → cache.clear()
    const logData: never[] = []
    mockFetch.mockResolvedValueOnce(mockResponse(logData, 'op2'))
    await api.log()
    expect(_testInternals.cache.size).toBe(0) // cache was cleared

    // Now the cached diff endpoint fetches fresh data
    mockFetch.mockResolvedValueOnce(mockResponse(diffData2, 'op2'))
    const result = await api.diff('abc')
    expect(result).toEqual(diffData2)
    expect(mockFetch).toHaveBeenCalledTimes(3)
    expect(_testInternals.cache.size).toBe(1) // new entry cached
  })

  it('caches files and evolog separately', async () => {
    const filesData = [{ type: 'M', path: 'a.go', additions: 1, deletions: 0 }]
    const evologData = { output: 'evolog content' }
    mockFetch
      .mockResolvedValueOnce(mockResponse(filesData, 'op1'))
      .mockResolvedValueOnce(mockResponse(evologData, 'op1'))

    await api.files('abc')
    await api.evolog('abc')
    expect(mockFetch).toHaveBeenCalledTimes(2)

    // Both should be cached now
    await api.files('abc')
    await api.evolog('abc')
    expect(mockFetch).toHaveBeenCalledTimes(2) // no new fetches
  })

  it('caches diff with different file arguments separately', async () => {
    const diff1 = { diff: '+file1' }
    const diff2 = { diff: '+file2' }
    mockFetch
      .mockResolvedValueOnce(mockResponse(diff1, 'op1'))
      .mockResolvedValueOnce(mockResponse(diff2, 'op1'))

    await api.diff('abc', 'file1.go')
    await api.diff('abc', 'file2.go')
    expect(mockFetch).toHaveBeenCalledTimes(2)

    // Both should be cached
    const r1 = await api.diff('abc', 'file1.go')
    const r2 = await api.diff('abc', 'file2.go')
    expect(r1).toEqual(diff1)
    expect(r2).toEqual(diff2)
    expect(mockFetch).toHaveBeenCalledTimes(2)
  })

  it('does not cache mutation (POST) requests', async () => {
    const result = { output: 'done' }
    // Seed the op-id first
    _testInternals.lastOpId = 'op1'
    mockFetch
      .mockResolvedValueOnce(mockResponse(result, 'op1'))
      .mockResolvedValueOnce(mockResponse(result, 'op1'))

    await api.abandon(['abc'])
    await api.abandon(['abc'])
    // POST requests always go through, no caching
    expect(mockFetch).toHaveBeenCalledTimes(2)
  })

  it('does not cache log requests', async () => {
    const logData: never[] = []
    mockFetch
      .mockResolvedValueOnce(mockResponse(logData, 'op1'))
      .mockResolvedValueOnce(mockResponse(logData, 'op1'))

    await api.log()
    await api.log()
    expect(mockFetch).toHaveBeenCalledTimes(2)
  })

  it('rebase passes source_mode and target_mode in request body', async () => {
    const result = { output: 'rebased' }
    mockFetch.mockResolvedValueOnce(mockResponse(result, 'op1'))

    await api.rebase(['abc'], 'def', '-s', '--insert-after')

    expect(mockFetch).toHaveBeenCalledTimes(1)
    const [, init] = mockFetch.mock.calls[0]
    const body = JSON.parse(init.body)
    expect(body.revisions).toEqual(['abc'])
    expect(body.destination).toBe('def')
    expect(body.source_mode).toBe('-s')
    expect(body.target_mode).toBe('--insert-after')
  })

  it('rebase works without optional mode params', async () => {
    const result = { output: 'rebased' }
    mockFetch.mockResolvedValueOnce(mockResponse(result, 'op1'))

    await api.rebase(['abc'], 'def')

    expect(mockFetch).toHaveBeenCalledTimes(1)
    const [, init] = mockFetch.mock.calls[0]
    const body = JSON.parse(init.body)
    expect(body.revisions).toEqual(['abc'])
    expect(body.destination).toBe('def')
    expect(body.source_mode).toBeUndefined()
    expect(body.target_mode).toBeUndefined()
  })

  it('clears cache when exceeding MAX_CACHE_SIZE', async () => {
    _testInternals.lastOpId = 'op1'

    // Fill cache to the limit
    for (let i = 0; i < _testInternals.MAX_CACHE_SIZE; i++) {
      _testInternals.cache.set(`entry${i}@op1`, { data: i })
    }
    expect(_testInternals.cache.size).toBe(_testInternals.MAX_CACHE_SIZE)

    // Next cachedRequest should trigger clear + re-add
    const diffData = { diff: '+overflow' }
    mockFetch.mockResolvedValueOnce(mockResponse(diffData, 'op1'))
    await api.diff('overflow-rev')

    // Cache was cleared, then 1 new entry added
    expect(_testInternals.cache.size).toBe(1)
  })
})

describe('immutable cache', () => {
  it('preserves immutable entries across op-id changes', async () => {
    // Cache an immutable diff — goes to immutableCache, not responseCache
    const immutableDiff = { diff: '+immutable content' }
    mockFetch.mockResolvedValueOnce(mockResponse(immutableDiff, 'op1'))
    await api.diff('immutable-rev', undefined, undefined, true)
    expect(_testInternals.immutableCache.size).toBe(1)
    expect(_testInternals.cache.size).toBe(0)

    // Cache a mutable diff — goes to responseCache
    const mutableDiff = { diff: '+mutable content' }
    mockFetch.mockResolvedValueOnce(mockResponse(mutableDiff, 'op1'))
    await api.diff('mutable-rev')
    expect(_testInternals.cache.size).toBe(1)

    // Op-id changes — mutable entry evicted, immutable preserved
    mockFetch.mockResolvedValueOnce(mockResponse([], 'op2'))
    await api.log()
    expect(_testInternals.cache.size).toBe(0)
    expect(_testInternals.immutableCache.size).toBe(1)

    // Immutable diff still cached — no fetch needed
    const result = await api.diff('immutable-rev', undefined, undefined, true)
    expect(result).toEqual(immutableDiff)
    // 3 fetches total: immutable diff, mutable diff, log. No 4th fetch for immutable.
    expect(mockFetch).toHaveBeenCalledTimes(3)
  })

  it('stores immutable entries under bare cacheId (no opId suffix)', async () => {
    const immutableDiff = { diff: '+immutable' }
    mockFetch.mockResolvedValueOnce(mockResponse(immutableDiff, 'op1'))
    await api.diff('imm-rev', undefined, undefined, true)

    const keys = [..._testInternals.immutableCache.keys()]
    expect(keys).toEqual(['diff:imm-rev'])
  })

  it('serves immutable entries even when lastOpId is null', async () => {
    // Immutable data doesn't depend on opId, so it should serve even before
    // any opId is established (e.g., first request is for an immutable commit).
    const immutableDiff = { diff: '+immutable' }
    mockFetch.mockResolvedValueOnce(mockResponse(immutableDiff, null))
    await api.diff('imm-rev', undefined, undefined, true)

    _testInternals.lastOpId = null // simulate fresh session
    const result = await api.diff('imm-rev', undefined, undefined, true)
    expect(result).toEqual(immutableDiff)
    expect(mockFetch).toHaveBeenCalledTimes(1) // second call hit cache
  })

  it('bounds immutable cache size, evicting the oldest entry only', async () => {
    const MAX = _testInternals.MAX_IMMUTABLE_CACHE_SIZE
    mockFetch.mockImplementation(() => Promise.resolve(mockResponse({ diff: '+x' }, 'op1')))

    // Fill to MAX
    for (let i = 0; i < MAX; i++) {
      await api.diff(`rev${i}`, undefined, undefined, true)
    }
    expect(_testInternals.immutableCache.size).toBe(MAX)

    // One more insert evicts ONLY the oldest — verify survivors to distinguish
    // "evict one" from "clear all + reinsert" (which would also pass .size === MAX)
    await api.diff('revNew', undefined, undefined, true)
    expect(_testInternals.immutableCache.size).toBe(MAX)
    expect(_testInternals.immutableCache.has('diff:rev0')).toBe(false) // evicted
    expect(_testInternals.immutableCache.has('diff:rev1')).toBe(true)  // survivor
    expect(_testInternals.immutableCache.has(`diff:rev${MAX - 1}`)).toBe(true) // survivor
    expect(_testInternals.immutableCache.has('diff:revNew')).toBe(true)
  })

  it('bumps accessed entries to end of eviction order (LRU)', async () => {
    const MAX = _testInternals.MAX_IMMUTABLE_CACHE_SIZE
    mockFetch.mockImplementation(() => Promise.resolve(mockResponse({ diff: '+x' }, 'op1')))

    for (let i = 0; i < MAX; i++) {
      await api.diff(`rev${i}`, undefined, undefined, true)
    }
    // Access rev0 (cache hit — no fetch). This should bump it to end.
    await api.diff('rev0', undefined, undefined, true)
    expect(mockFetch).toHaveBeenCalledTimes(MAX) // no extra fetch

    // Next insert should evict rev1 (now oldest), not rev0
    await api.diff('revNew', undefined, undefined, true)
    expect(_testInternals.immutableCache.has('diff:rev0')).toBe(true)  // bumped, survived
    expect(_testInternals.immutableCache.has('diff:rev1')).toBe(false) // now oldest, evicted
  })

  it('serves from immutable cache even when caller passes immutable=false', async () => {
    // Regression guard for the ◆→○ transition: if a commit's immutability
    // flag changes but its data is in immutableCache, we should still serve
    // it rather than refetching. The cached diff is still correct.
    const immutableDiff = { diff: '+x' }
    mockFetch.mockResolvedValueOnce(mockResponse(immutableDiff, 'op1'))
    await api.diff('rev', undefined, undefined, true)

    // Later call with immutable=false should still hit immutable cache
    const result = await api.diff('rev', undefined, undefined, false)
    expect(result).toEqual(immutableDiff)
    expect(mockFetch).toHaveBeenCalledTimes(1)
  })
})

describe('onStale', () => {
  it('fires callback when op-id changes', async () => {
    const cb = vi.fn()
    onStale(cb)

    // Seed op-id
    mockFetch.mockResolvedValueOnce(mockResponse([], 'op1'))
    await api.log()
    expect(cb).not.toHaveBeenCalled()

    // Op-id changes → callback should fire via microtask
    mockFetch.mockResolvedValueOnce(mockResponse([], 'op2'))
    await api.log()
    await Promise.resolve() // drain microtask queue
    expect(cb).toHaveBeenCalledTimes(1)
  })

  it('does not fire callback when op-id stays the same', async () => {
    const cb = vi.fn()
    onStale(cb)

    mockFetch.mockResolvedValue(mockResponse([], 'op1'))
    await api.log()
    await api.log()
    await Promise.resolve()
    expect(cb).not.toHaveBeenCalled()
  })

  it('supports multiple callbacks', async () => {
    const cb1 = vi.fn()
    const cb2 = vi.fn()
    onStale(cb1)
    onStale(cb2)

    mockFetch.mockResolvedValueOnce(mockResponse([], 'op1'))
    await api.log()
    mockFetch.mockResolvedValueOnce(mockResponse([], 'op2'))
    await api.log()
    await Promise.resolve()

    expect(cb1).toHaveBeenCalledTimes(1)
    expect(cb2).toHaveBeenCalledTimes(1)
  })

  it('returns unsubscribe function', async () => {
    const cb = vi.fn()
    const unsub = onStale(cb)

    mockFetch.mockResolvedValueOnce(mockResponse([], 'op1'))
    await api.log()

    unsub() // unsubscribe before op-id change

    mockFetch.mockResolvedValueOnce(mockResponse([], 'op2'))
    await api.log()
    await Promise.resolve()
    expect(cb).not.toHaveBeenCalled()
  })
})

describe('isCached', () => {
  it('returns false when lastOpId is null', () => {
    expect(isCached('abc')).toBe(false)
  })

  it('returns true when diff + files + desc are all cached', () => {
    _testInternals.lastOpId = 'op1'
    _testInternals.cache.set('diff:abc@op1', { diff: '+x' })
    _testInternals.cache.set('files:abc@op1', [])
    _testInternals.cache.set('desc:abc@op1', { description: 'msg' })
    expect(isCached('abc')).toBe(true)
  })

  it('returns false when description is missing', () => {
    // Regression guard: isCached() must check desc too — otherwise after an
    // op-id change the debounce skip path fires a desc fetch on every keypress.
    _testInternals.lastOpId = 'op1'
    _testInternals.cache.set('diff:abc@op1', { diff: '+x' })
    _testInternals.cache.set('files:abc@op1', [])
    expect(isCached('abc')).toBe(false)
  })

  it('returns false when only diff is cached', () => {
    _testInternals.lastOpId = 'op1'
    _testInternals.cache.set('diff:abc@op1', { diff: '+x' })
    expect(isCached('abc')).toBe(false)
  })

  it('returns true when all three are in immutable cache', () => {
    // No opId required for immutable cache hits
    _testInternals.immutableCache.set('diff:abc', { diff: '+x' })
    _testInternals.immutableCache.set('files:abc', [])
    _testInternals.immutableCache.set('desc:abc', { description: 'msg' })
    expect(isCached('abc')).toBe(true)
  })

  it('returns false when entries are split across tiers', () => {
    // isCached checks each tier all-or-nothing. cachedRequest() DOES handle
    // mixed tiers correctly (checks immutable first, falls through to mutable),
    // so this is deliberately conservative — a false-negative costs 50ms debounce,
    // a false-positive costs the perf budget. Documented rather than optimized.
    _testInternals.lastOpId = 'op1'
    _testInternals.immutableCache.set('diff:abc', { diff: '+x' })
    _testInternals.immutableCache.set('files:abc', [])
    _testInternals.cache.set('desc:abc@op1', { description: 'msg' })
    expect(isCached('abc')).toBe(false)
  })
})

describe('squash request body', () => {
  it('sends correct body shape with all options', async () => {
    const result = { output: 'squashed' }
    _testInternals.lastOpId = 'op1'
    mockFetch.mockResolvedValueOnce(mockResponse(result, 'op1'))

    await api.squash(['src1', 'src2'], 'dest1', {
      files: ['a.go', 'b.go'],
      keepEmptied: true,
      useDestinationMessage: true,
    })

    expect(mockFetch).toHaveBeenCalledTimes(1)
    const [, init] = mockFetch.mock.calls[0]
    const body = JSON.parse(init.body)
    expect(body.revisions).toEqual(['src1', 'src2'])
    expect(body.destination).toBe('dest1')
    expect(body.files).toEqual(['a.go', 'b.go'])
    expect(body.keep_emptied).toBe(true)
    expect(body.use_destination_message).toBe(true)
  })

  it('omits undefined fields from request body', async () => {
    const result = { output: 'squashed' }
    _testInternals.lastOpId = 'op1'
    mockFetch.mockResolvedValueOnce(mockResponse(result, 'op1'))

    await api.squash(['src1'], 'dest1')

    const [, init] = mockFetch.mock.calls[0]
    const body = JSON.parse(init.body)
    expect(body.revisions).toEqual(['src1'])
    expect(body.destination).toBe('dest1')
    expect(body.files).toBeUndefined()
    expect(body.keep_emptied).toBeUndefined()
    expect(body.use_destination_message).toBeUndefined()
  })
})

describe('diff with context param', () => {
  it('URL includes context parameter', async () => {
    const diffData = { diff: '+ctx' }
    mockFetch.mockResolvedValueOnce(mockResponse(diffData, 'op1'))

    await api.diff('abc', undefined, 5)

    const [url] = mockFetch.mock.calls[0]
    expect(url).toContain('context=5')
  })

  it('cache key includes context', async () => {
    const diffData = { diff: '+ctx3' }
    mockFetch
      .mockResolvedValueOnce(mockResponse(diffData, 'op1'))
      .mockResolvedValueOnce(mockResponse({ diff: '+ctx10' }, 'op1'))

    await api.diff('abc', undefined, 3)
    await api.diff('abc', undefined, 10)

    // Both should fetch — different context values = different cache keys
    expect(mockFetch).toHaveBeenCalledTimes(2)
  })
})

describe('fileShow', () => {
  it('fetches file content with revision and path params', async () => {
    const result = { content: 'file contents here' }
    mockFetch.mockResolvedValueOnce(mockResponse(result, 'op1'))

    const resp = await api.fileShow('abc', 'src/main.go')

    expect(resp).toEqual(result)
    expect(mockFetch).toHaveBeenCalledTimes(1)
    const [url] = mockFetch.mock.calls[0]
    expect(url).toContain('/api/file-show')
    expect(url).toContain('revision=abc')
    expect(url).toContain('path=src%2Fmain.go')
  })

  it('does not cache responses (always fetches fresh)', async () => {
    const result = { content: 'file contents' }
    mockFetch
      .mockResolvedValueOnce(mockResponse(result, 'op1'))
      .mockResolvedValueOnce(mockResponse(result, 'op1'))

    await api.fileShow('abc', 'src/main.go')
    await api.fileShow('abc', 'src/main.go')

    // fileShow uses request() not cachedRequest(), so both calls hit fetch
    expect(mockFetch).toHaveBeenCalledTimes(2)
  })
})

describe('resolve request body', () => {
  async function callResolve(revision: string, file: string, tool: ':ours' | ':theirs') {
    _testInternals.lastOpId = 'op1'
    mockFetch.mockResolvedValueOnce(mockResponse({ output: 'resolved' }, 'op2'))
    await api.resolve(revision, file, tool)
    const [url, init] = mockFetch.mock.calls[0]
    return { url, init, body: JSON.parse(init.body) }
  }

  it('sends revision, file, and tool', async () => {
    const { url, init, body } = await callResolve('abc', 'src/main.go', ':ours')
    expect(url).toBe('/api/resolve')
    expect(init.method).toBe('POST')
    expect(body).toEqual({ revision: 'abc', file: 'src/main.go', tool: ':ours' })
  })

  it('sends :theirs tool', async () => {
    const { body } = await callResolve('xyz', 'README.md', ':theirs')
    expect(body.tool).toBe(':theirs')
  })

  it('clears cache and fires stale callbacks on op-id change', async () => {
    // Seed cache with a diff entry
    _testInternals.lastOpId = 'op1'
    _testInternals.cache.set('diff:abc@op1', { diff: '+cached' })

    const staleCb = vi.fn()
    onStale(staleCb)

    // Resolve returns a new op-id → should clear cache and fire stale
    mockFetch.mockResolvedValueOnce(mockResponse({ output: 'resolved' }, 'op2'))
    await api.resolve('abc', 'file.go', ':ours')
    await Promise.resolve() // drain microtask queue for stale callback

    expect(_testInternals.cache.size).toBe(0)
    expect(staleCb).toHaveBeenCalledTimes(1)
  })
})

describe('error handling', () => {
  it('throws error with server error message on non-ok response', async () => {
    mockFetch.mockResolvedValueOnce(mockResponse({ error: 'jj failed' }, 'op1', false, 500))
    await expect(api.log()).rejects.toThrow('jj failed')
  })

  it('throws fallback error when no error field in response', async () => {
    mockFetch.mockResolvedValueOnce(mockResponse({}, 'op1', false, 400))
    await expect(api.log()).rejects.toThrow('HTTP 400')
  })

  it('tracks op-id even on error responses', async () => {
    mockFetch.mockResolvedValueOnce(mockResponse([], 'op1'))
    await api.log()

    // Error response with a new op-id
    mockFetch.mockResolvedValueOnce(mockResponse({ error: 'fail' }, 'op2', false, 500))
    await api.log().catch(() => {}) // swallow the error
    expect(_testInternals.lastOpId).toBe('op2')
  })
})

describe('timeout', () => {
  it('GET request that takes too long throws Request timed out', async () => {
    vi.useFakeTimers()
    try {
      // Mock fetch that checks signal.aborted synchronously (like real fetch does)
      mockFetch.mockImplementation((_url: string, init?: RequestInit) => {
        return new Promise((resolve, reject) => {
          // Poll signal state -- in real browsers, fetch rejects immediately on abort
          const check = () => {
            if (init?.signal?.aborted) {
              reject(new DOMException('The operation was aborted', 'AbortError'))
            }
          }
          init?.signal?.addEventListener('abort', check)
        })
      })

      // Attach the rejection handler immediately so it's never "unhandled"
      const promise = api.log().catch((e: Error) => e)
      // Advance past the READ_TIMEOUT_MS (30s)
      await vi.advanceTimersByTimeAsync(31_000)

      const error = await promise
      expect(error).toBeInstanceOf(Error)
      expect((error as Error).message).toBe('Request timed out')
    } finally {
      vi.useRealTimers()
    }
  })

  it('POST request has no timeout', async () => {
    // POST requests should not create an AbortController
    _testInternals.lastOpId = 'op1'
    mockFetch.mockResolvedValue(mockResponse({ output: 'done' }, 'op1'))

    await api.abandon(['abc'])
    expect(mockFetch).toHaveBeenCalledTimes(1)
    // Verify no signal was added by the internal timeout logic
    const [, init] = mockFetch.mock.calls[0]
    expect(init?.signal).toBeUndefined()
  })
})

describe('prefetchRevision', () => {
  it('fires diff+files+description fetches for uncached revision', () => {
    _testInternals.lastOpId = 'op1'
    mockFetch.mockResolvedValue(mockResponse({}, 'op1'))
    prefetchRevision('abc')
    expect(mockFetch).toHaveBeenCalledTimes(3)
  })

  it('skips fetch when already cached', () => {
    _testInternals.lastOpId = 'op1'
    _testInternals.cache.set('diff:abc@op1', { diff: '' })
    _testInternals.cache.set('files:abc@op1', [])
    _testInternals.cache.set('desc:abc@op1', { description: '' })
    prefetchRevision('abc')
    expect(mockFetch).not.toHaveBeenCalled()
  })

  it('swallows fetch errors silently', async () => {
    _testInternals.lastOpId = 'op1'
    mockFetch.mockRejectedValue(new Error('network'))
    // Should not throw
    prefetchRevision('abc')
    await new Promise(r => setTimeout(r, 0)) // let rejections settle
    expect(mockFetch).toHaveBeenCalledTimes(3)
  })
})

describe('session-cached endpoints', () => {
  it('caches remotes() — second call does not fetch', async () => {
    mockFetch.mockResolvedValue(mockResponse(['origin', 'upstream']))
    const r1 = await api.remotes()
    const r2 = await api.remotes()
    expect(r1).toEqual(['origin', 'upstream'])
    expect(r2).toBe(r1) // same promise resolution
    expect(mockFetch).toHaveBeenCalledTimes(1)
  })

  it('retries remotes() after failure', async () => {
    mockFetch.mockRejectedValueOnce(new Error('fail'))
    await expect(api.remotes()).rejects.toThrow('fail')
    mockFetch.mockResolvedValueOnce(mockResponse(['origin']))
    const r = await api.remotes()
    expect(r).toEqual(['origin'])
    expect(mockFetch).toHaveBeenCalledTimes(2)
  })
})

describe('multiRevset', () => {
  it('returns bare ID for single revision', () => {
    expect(multiRevset(['abc'])).toBe('abc')
  })
  it('wraps multiple in connected()', () => {
    expect(multiRevset(['abc', 'def', 'ghi'])).toBe('connected(abc|def|ghi)')
  })
  it('returns empty for empty input', () => {
    expect(multiRevset([])).toBe('')
  })
})

describe('computeConnectedCommitIds', () => {
  const entry = (cid: string, parents: string[]): LogEntry => ({
    commit: {
      commit_id: cid, parent_ids: parents, change_id: cid,
      change_prefix: 1, commit_prefix: 1,
      is_working_copy: false, hidden: false, immutable: false,
      conflicted: false, divergent: false,
    },
    description: '', graph_lines: [],
  })

  it('returns a fresh set for <=1 checked', () => {
    const checked = new Set(['a1'])
    const result = computeConnectedCommitIds(checked, [entry('a1', [])])
    expect(result).toEqual(checked)
    expect(result).not.toBe(checked) // no aliasing
  })

  it('returns empty set for 0 checked', () => {
    expect(computeConnectedCommitIds(new Set(), [])).toEqual(new Set())
  })

  it('fills linear gap', () => {
    const revs = [entry('a', ['b']), entry('b', ['c']), entry('c', [])]
    const result = computeConnectedCommitIds(new Set(['a', 'c']), revs)
    expect(result).toEqual(new Set(['a', 'b', 'c']))
  })

  it('does not pull in common ancestor of sibling heads', () => {
    // a → c, b → c (two heads sharing ancestor c)
    // c is NOT in descendants({a,b}) since a,b are heads — matches jj's connected()
    const revs = [entry('a', ['c']), entry('b', ['c']), entry('c', [])]
    const result = computeConnectedCommitIds(new Set(['a', 'b']), revs)
    expect(result).toEqual(new Set(['a', 'b']))
  })

  it('fills gap on one branch when checking across a merge', () => {
    // m has parents a,b; a→c, b→c. Check m and c: gap is a+b.
    const revs = [entry('m', ['a', 'b']), entry('a', ['c']), entry('b', ['c']), entry('c', [])]
    const result = computeConnectedCommitIds(new Set(['m', 'c']), revs)
    expect(result).toEqual(new Set(['m', 'a', 'b', 'c']))
  })

  it('ignores parents outside the visible log', () => {
    const revs = [entry('a', ['b']), entry('b', ['invisible'])]
    const result = computeConnectedCommitIds(new Set(['a', 'b']), revs)
    expect(result).toEqual(new Set(['a', 'b'])) // 'invisible' not added
  })
})
