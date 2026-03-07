import { describe, it, expect, vi, beforeEach } from 'vitest'
import { api, isCached, getCached, onStale, multiRevset, computeConnectedCommitIds, prefetchRevision, prefetchFilesBatch, setActiveTab, listTabs, MAX_CACHE_SIZE, _testInternals, type LogEntry } from './api'

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
  _testInternals.staleCallbacks.clear()
  _testInternals.refreshQueued = false
  _testInternals.resetSessionCaches()
  _testInternals.basePath = '/tab/0'
})

describe('tab routing', () => {
  it('/api/* URLs get basePath prefix; others do not', async () => {
    mockFetch.mockResolvedValue(mockResponse({ diff: '' }))
    await api.diff('abc')
    expect(mockFetch).toHaveBeenCalledWith('/tab/0/api/diff?revision=abc', expect.anything())

    mockFetch.mockResolvedValue(mockResponse([]))
    await listTabs()
    // /tabs is host-level — no prefix
    expect(mockFetch).toHaveBeenLastCalledWith('/tabs', expect.anything())
  })

  it('setActiveTab changes prefix and clears per-repo memos but NOT commit_id cache', async () => {
    mockFetch.mockResolvedValue(mockResponse({ diff: 'tab0-diff' }))
    await api.diff('sha256abc')
    expect(_testInternals.cache.has('diff:sha256abc')).toBe(true)

    mockFetch.mockResolvedValue(mockResponse(['origin']))
    await api.remotes()

    setActiveTab('1')

    // commit_id cache survives — SHA-256 is globally unique across repos
    expect(_testInternals.cache.has('diff:sha256abc')).toBe(true)
    // per-repo memo cleared
    mockFetch.mockResolvedValue(mockResponse(['upstream']))
    const r = await api.remotes()
    expect(r).toEqual(['upstream']) // refetched, not the tab-0 memo
    expect(mockFetch).toHaveBeenLastCalledWith('/tab/1/api/remotes', expect.anything())
  })

  it('setActiveTab resets lastOpId so first response from new tab does not fire onStale', async () => {
    const cb = vi.fn()
    onStale(cb)
    _testInternals.lastOpId = 'tab0-op' // seeded by tab 0's last response

    setActiveTab('1')
    expect(_testInternals.lastOpId).toBeNull()

    // Tab 1's first response sets lastOpId but changed=false (was null)
    mockFetch.mockResolvedValue(mockResponse({ diff: '' }, 'tab1-op'))
    await api.diff('x')
    await Promise.resolve() // flush microtask
    expect(cb).not.toHaveBeenCalled()
    expect(_testInternals.lastOpId).toBe('tab1-op')
  })
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

  it('caches even when op-id is unknown — commit_id keying is independent of op-id', async () => {
    const diffData = { diff: '+line' }
    mockFetch.mockResolvedValue(mockResponse(diffData, null))

    await api.diff('abc')
    await api.diff('abc')
    // Second call hits cache — op-id is irrelevant to cache validity
    expect(mockFetch).toHaveBeenCalledTimes(1)
  })

  it('cache SURVIVES op-id change — commit_id is content-addressed', async () => {
    // This is the core behavioral change: jj new / jj abandon / jj undo
    // advance the op-id but leave existing commit_ids unchanged. Their
    // cached data is still valid and should still serve.
    const diffData = { diff: '+v1' }
    mockFetch.mockResolvedValueOnce(mockResponse(diffData, 'op1'))

    await api.diff('abc')
    expect(mockFetch).toHaveBeenCalledTimes(1)
    expect(_testInternals.cache.size).toBe(1)

    // Op-id advances (e.g. jj new). Cache is NOT cleared.
    mockFetch.mockResolvedValueOnce(mockResponse([], 'op2'))
    await api.log()
    expect(_testInternals.cache.size).toBe(1) // still cached!

    // Same commit_id → cache hit, no fetch
    const result = await api.diff('abc')
    expect(result).toEqual(diffData)
    expect(mockFetch).toHaveBeenCalledTimes(2) // only log fetched
  })

  it('caches files; evolog is NOT cached (op-dependent)', async () => {
    const filesData = [{ type: 'M', path: 'a.go', additions: 1, deletions: 0 }]
    const evologData = [{ commit_id: 'abc', time: 't', operation: 'snapshot', predecessor_ids: [] }]
    mockFetch
      .mockResolvedValueOnce(mockResponse(filesData, 'op1'))
      .mockResolvedValueOnce(mockResponse(evologData, 'op1'))
      .mockResolvedValueOnce(mockResponse(evologData, 'op1'))

    await api.files('abc')
    await api.evolog('abc')
    expect(mockFetch).toHaveBeenCalledTimes(2)

    // files cached, evolog uncached (it grows with each operation)
    await api.files('abc')
    await api.evolog('abc')
    expect(mockFetch).toHaveBeenCalledTimes(3) // evolog refetched
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

  it('bounds cache size with LRU eviction — evicts oldest, not all', async () => {
    const MAX = MAX_CACHE_SIZE
    mockFetch.mockImplementation(() => Promise.resolve(mockResponse({ diff: '+x' }, 'op1')))

    // Fill to MAX
    for (let i = 0; i < MAX; i++) {
      await api.diff(`rev${i}`)
    }
    expect(_testInternals.cache.size).toBe(MAX)

    // One more insert evicts ONLY the oldest — verify survivors to distinguish
    // "evict one" from "clear all + reinsert" (which would also pass .size === MAX)
    await api.diff('revNew')
    expect(_testInternals.cache.size).toBe(MAX)
    expect(_testInternals.cache.has('diff:rev0')).toBe(false) // evicted
    expect(_testInternals.cache.has('diff:rev1')).toBe(true)  // survivor
    expect(_testInternals.cache.has(`diff:rev${MAX - 1}`)).toBe(true) // survivor
    expect(_testInternals.cache.has('diff:revNew')).toBe(true)
  })

  it('re-storing an existing key at capacity bumps it (no spurious eviction)', async () => {
    // Regression: Map.set() on an existing key does NOT move it in insertion
    // order. Without delete-first in storeInCache, the old pre-check
    // `if (size >= MAX)` would evict rev0 even when the key being stored
    // (diff:target) is already present — no net growth, wrong entry killed.
    //
    // Happens in practice when api.revision() seeds diff:X while diff:X is
    // already cached but files:X / desc:X aren't (partial cache state).
    const MAX = MAX_CACHE_SIZE
    mockFetch.mockImplementation(() => Promise.resolve(mockResponse({ diff: '+x' }, 'op1')))

    // Fill to MAX - 2 (leave room for files: + desc: seeds)
    for (let i = 0; i < MAX - 2; i++) {
      await api.diff(`rev${i}`)
    }
    // diff:target is already in cache; files:target and desc:target are not.
    // isCached('target') → false → api.revision() will fetch and seed all three.
    const target = `rev${MAX - 3}`
    expect(_testInternals.cache.has(`diff:${target}`)).toBe(true)
    expect(_testInternals.cache.size).toBe(MAX - 2)

    mockFetch.mockResolvedValueOnce(mockResponse({
      diff: '+x', files: [], description: '',
    }, 'op1'))
    await api.revision(target)

    // Now at MAX (added files:target + desc:target). diff:target was re-stored.
    // With delete-first: diff:target was bumped to newest, no eviction.
    // rev0 (oldest) must still be present — net growth was only +2, within cap.
    expect(_testInternals.cache.size).toBe(MAX)
    expect(_testInternals.cache.has('diff:rev0')).toBe(true)
    // diff:target should now be at the END (bumped), verified by adding one
    // more entry and checking it's NOT evicted:
    await api.diff('overflow')
    expect(_testInternals.cache.has(`diff:${target}`)).toBe(true) // bumped, survives
    expect(_testInternals.cache.has('diff:rev0')).toBe(false)     // oldest, evicted
  })

  it('bumps accessed entries to end of eviction order (LRU)', async () => {
    const MAX = MAX_CACHE_SIZE
    mockFetch.mockImplementation(() => Promise.resolve(mockResponse({ diff: '+x' }, 'op1')))

    for (let i = 0; i < MAX; i++) {
      await api.diff(`rev${i}`)
    }
    // Access rev0 (cache hit — no fetch). This should bump it to end.
    await api.diff('rev0')
    expect(mockFetch).toHaveBeenCalledTimes(MAX) // no extra fetch

    // Next insert should evict rev1 (now oldest), not rev0
    await api.diff('revNew')
    expect(_testInternals.cache.has('diff:rev0')).toBe(true)  // bumped, survived
    expect(_testInternals.cache.has('diff:rev1')).toBe(false) // now oldest, evicted
  })

  it('stores entries under bare cacheId (no opId suffix)', async () => {
    const diffData = { diff: '+x' }
    mockFetch.mockResolvedValueOnce(mockResponse(diffData, 'op1'))
    await api.diff('abc')

    expect([..._testInternals.cache.keys()]).toEqual(['diff:abc'])
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
  it('returns false when nothing cached', () => {
    expect(isCached('abc')).toBe(false)
  })

  it('returns true when diff + files + desc are all cached', () => {
    _testInternals.cache.set('diff:abc', { diff: '+x' })
    _testInternals.cache.set('files:abc', [])
    _testInternals.cache.set('desc:abc', { description: 'msg' })
    expect(isCached('abc')).toBe(true)
  })

  it('returns false when description is missing', () => {
    // Regression guard: isCached() must check all three — a partial hit
    // defeats the debounce by firing the missing fetch on every keypress.
    _testInternals.cache.set('diff:abc', { diff: '+x' })
    _testInternals.cache.set('files:abc', [])
    expect(isCached('abc')).toBe(false)
  })

  it('returns false when only diff is cached', () => {
    _testInternals.cache.set('diff:abc', { diff: '+x' })
    expect(isCached('abc')).toBe(false)
  })

  it('is independent of lastOpId — works before op-id is established', () => {
    // lastOpId is null at startup, but cache can still serve.
    expect(_testInternals.lastOpId).toBeNull()
    _testInternals.cache.set('diff:abc', { diff: '+x' })
    _testInternals.cache.set('files:abc', [])
    _testInternals.cache.set('desc:abc', { description: 'msg' })
    expect(isCached('abc')).toBe(true)
  })
})

describe('getCached', () => {
  it('returns null when nothing cached', () => {
    expect(getCached('abc')).toBeNull()
  })

  it('returns null when only partially cached', () => {
    _testInternals.cache.set('diff:abc', { diff: '+x' })
    _testInternals.cache.set('files:abc', [{ type: 'M', path: 'a.ts' }])
    expect(getCached('abc')).toBeNull()
  })

  it('returns unwrapped values when fully cached', () => {
    _testInternals.cache.set('diff:abc', { diff: '+x' })
    _testInternals.cache.set('files:abc', [{ type: 'M', path: 'a.ts' }])
    _testInternals.cache.set('desc:abc', { description: 'msg' })
    const result = getCached('abc')
    expect(result).toEqual({
      diff: '+x',
      files: [{ type: 'M', path: 'a.ts' }],
      description: 'msg',
    })
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
    expect(url).toBe('/tab/0/api/resolve')
    expect(init.method).toBe('POST')
    expect(body).toEqual({ revision: 'abc', file: 'src/main.go', tool: ':ours' })
  })

  it('sends :theirs tool', async () => {
    const { body } = await callResolve('xyz', 'README.md', ':theirs')
    expect(body.tool).toBe(':theirs')
  })

  it('fires stale callbacks on op-id change but does NOT clear cache', async () => {
    // Seed cache with a diff entry keyed by commit_id
    _testInternals.lastOpId = 'op1'
    _testInternals.cache.set('diff:abc', { diff: '+cached' })

    const staleCb = vi.fn()
    onStale(staleCb)

    // Resolve returns a new op-id → fires stale callback (triggers loadLog)
    // but does NOT clear the cache — commit_id-keyed entries are still valid.
    mockFetch.mockResolvedValueOnce(mockResponse({ output: 'resolved' }, 'op2'))
    await api.resolve('abc', 'file.go', ':ours')
    await Promise.resolve() // drain microtask queue for stale callback

    expect(_testInternals.cache.size).toBe(1) // NOT cleared
    expect(_testInternals.cache.get('diff:abc')).toEqual({ diff: '+cached' })
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
  it('fires single batch fetch for uncached revision', () => {
    mockFetch.mockResolvedValue(mockResponse({ diff: '', files: [], description: '' }, 'op1'))
    prefetchRevision('abc')
    expect(mockFetch).toHaveBeenCalledTimes(1)
    expect(mockFetch.mock.calls[0][0]).toContain('/api/revision?revision=abc')
  })

  it('skips fetch when already cached', () => {
    _testInternals.cache.set('diff:abc', { diff: '' })
    _testInternals.cache.set('files:abc', [])
    _testInternals.cache.set('desc:abc', { description: '' })
    prefetchRevision('abc')
    expect(mockFetch).not.toHaveBeenCalled()
  })

  it('swallows fetch errors silently', async () => {
    mockFetch.mockRejectedValue(new Error('network'))
    // Should not throw
    prefetchRevision('abc')
    await new Promise(r => setTimeout(r, 0)) // let rejections settle
    expect(mockFetch).toHaveBeenCalledTimes(1)
  })
})

describe('api.revision (batch endpoint)', () => {
  it('seeds all three cache keys from one fetch', async () => {
    mockFetch.mockResolvedValue(mockResponse({
      diff: 'diff output',
      files: [{ type: 'M', path: 'a.go', additions: 1, deletions: 0, conflict: false, conflict_sides: 0 }],
      description: 'msg',
    }, 'op1'))

    await api.revision('xyz')

    expect(mockFetch).toHaveBeenCalledTimes(1)
    // Individual cache keys are now populated with shapes matching the
    // individual endpoints' responses. No op-id suffix.
    expect(_testInternals.cache.get('diff:xyz')).toEqual({ diff: 'diff output' })
    expect(_testInternals.cache.get('files:xyz')).toEqual([
      { type: 'M', path: 'a.go', additions: 1, deletions: 0, conflict: false, conflict_sides: 0 },
    ])
    expect(_testInternals.cache.get('desc:xyz')).toEqual({ description: 'msg' })
  })

  it('skips fetch when all three keys are already cached', async () => {
    _testInternals.cache.set('diff:xyz', { diff: 'cached' })
    _testInternals.cache.set('files:xyz', [])
    _testInternals.cache.set('desc:xyz', { description: 'cached' })

    await api.revision('xyz')
    expect(mockFetch).not.toHaveBeenCalled()
  })

  it('seeded keys are hit by subsequent individual api calls', async () => {
    mockFetch.mockResolvedValue(mockResponse({
      diff: 'batch diff', files: [], description: 'batch desc',
    }, 'op1'))

    await api.revision('seed')
    expect(mockFetch).toHaveBeenCalledTimes(1)

    // These should be cache hits — no additional fetches.
    const d = await api.diff('seed')
    const f = await api.files('seed')
    const desc = await api.description('seed')

    expect(mockFetch).toHaveBeenCalledTimes(1)
    expect(d).toEqual({ diff: 'batch diff' })
    expect(f).toEqual([])
    expect(desc).toEqual({ description: 'batch desc' })
  })

  it('seeds cache even when op-id advances during fetch — commit_id is immutable', async () => {
    _testInternals.lastOpId = 'op1'
    // Response carries a newer op-id → trackOpId bumps lastOpId mid-flight.
    // Under the old model this would skip caching. Now: commit_id content-
    // addresses the data, so the fetch result is valid regardless of what
    // op-ids advanced while it was in flight.
    mockFetch.mockResolvedValue(mockResponse({
      diff: 'still valid', files: [], description: 'still valid',
    }, 'op2'))

    await api.revision('concurrent')

    expect(_testInternals.cache.get('diff:concurrent')).toEqual({ diff: 'still valid' })
  })
})

describe('prefetchFilesBatch', () => {
  it('seeds files: cache keys for non-conflicted revisions', async () => {
    mockFetch.mockResolvedValue(mockResponse({
      'abc': { conflict: false, files: [{ type: 'M', path: 'a.go', additions: 1, deletions: 0, conflict: false, conflict_sides: 0 }] },
      'def': { conflict: false, files: [] },
    }, 'op1'))

    await prefetchFilesBatch(['abc', 'def'])

    expect(mockFetch).toHaveBeenCalledTimes(1)
    expect(mockFetch.mock.calls[0][0]).toContain('/api/files-batch?revisions=abc%2Cdef')
    expect(_testInternals.cache.has('files:abc')).toBe(true)
    expect(_testInternals.cache.has('files:def')).toBe(true)
  })

  it('skips seeding conflicted revisions — they need full /api/files', async () => {
    mockFetch.mockResolvedValue(mockResponse({
      'clean': { conflict: false, files: [] },
      'conflicted': { conflict: true, files: [{ type: 'M', path: 'x', additions: 0, deletions: 0, conflict: false, conflict_sides: 0 }] },
    }, 'op1'))

    await prefetchFilesBatch(['clean', 'conflicted'])

    expect(_testInternals.cache.has('files:clean')).toBe(true)
    expect(_testInternals.cache.has('files:conflicted')).toBe(false)
  })

  it('filters to uncached — empty fetch if all cached', async () => {
    _testInternals.cache.set('files:abc', [])
    _testInternals.cache.set('files:def', [])

    await prefetchFilesBatch(['abc', 'def'])
    expect(mockFetch).not.toHaveBeenCalled()
  })

  it('only sends uncached ids', async () => {
    _testInternals.cache.set('files:abc', [])
    mockFetch.mockResolvedValue(mockResponse({ 'def': { conflict: false, files: [] } }, 'op1'))

    await prefetchFilesBatch(['abc', 'def'])

    expect(mockFetch).toHaveBeenCalledTimes(1)
    // Only 'def' in the request
    expect(mockFetch.mock.calls[0][0]).toContain('revisions=def')
    expect(mockFetch.mock.calls[0][0]).not.toContain('abc')
  })

  it('swallows fetch errors silently', async () => {
    mockFetch.mockRejectedValue(new Error('network'))
    await prefetchFilesBatch(['abc']) // should not throw
    expect(_testInternals.cache.has('files:abc')).toBe(false)
  })

  it('seeded files: key is hit by subsequent api.files()', async () => {
    const filesData = [{ type: 'M', path: 'a.go', additions: 1, deletions: 0, conflict: false, conflict_sides: 0 }]
    mockFetch.mockResolvedValue(mockResponse({
      'seeded': { conflict: false, files: filesData },
    }, 'op1'))

    await prefetchFilesBatch(['seeded'])
    expect(mockFetch).toHaveBeenCalledTimes(1)

    const result = await api.files('seeded')
    expect(mockFetch).toHaveBeenCalledTimes(1) // cache hit
    expect(result).toEqual(filesData)
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
  it('wraps multiple in connected() — sorted for stable cache keys', () => {
    expect(multiRevset(['abc', 'def', 'ghi'])).toBe('connected(abc|def|ghi)')
    expect(multiRevset(['ghi', 'abc', 'def'])).toBe('connected(abc|def|ghi)')
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
      conflicted: false, divergent: false, empty: false,
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

describe('request() empty-body handling', () => {
  // DELETE /api/annotations returns 200 with no body. Before the
  // Content-Length check, res.json() threw SyntaxError → deleteAnnotation
  // failed silently → store's `list = list.filter()` never ran → badge stuck.

  function emptyBodyResponse() {
    return {
      ok: true,
      status: 200,
      headers: {
        get: (k: string) => k === 'Content-Length' ? '0' : null,
      },
      json: () => Promise.reject(new SyntaxError('Unexpected end of JSON input')),
    }
  }

  it('deleteAnnotation resolves on 200 + empty body', async () => {
    mockFetch.mockResolvedValue(emptyBodyResponse())
    await expect(api.deleteAnnotation('abc', 'a1')).resolves.toBeUndefined()
    expect(mockFetch).toHaveBeenCalledWith(
      '/tab/0/api/annotations?changeId=abc&id=a1',
      expect.objectContaining({ method: 'DELETE' }),
    )
  })

  it('clearAnnotations resolves on 200 + empty body', async () => {
    mockFetch.mockResolvedValue(emptyBodyResponse())
    await expect(api.clearAnnotations('abc')).resolves.toBeUndefined()
  })

  it('falls back gracefully when Content-Length header missing', async () => {
    // Some middleware/proxies strip Content-Length. The .catch(() => undefined)
    // fallback should handle an empty body that lacks the header.
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      headers: { get: () => null },
      json: () => Promise.reject(new SyntaxError('Unexpected end of JSON input')),
    })
    await expect(api.deleteAnnotation('abc', 'a1')).resolves.toBeUndefined()
  })

  it('GET with real JSON body still parses normally', async () => {
    // Regression guard: the empty-body handling must not break valid JSON responses.
    mockFetch.mockResolvedValue(mockResponse([{ id: 'a1' }]))
    const result = await api.annotations('abc')
    expect(result).toEqual([{ id: 'a1' }])
  })
})
