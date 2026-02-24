import { describe, it, expect, vi, beforeEach } from 'vitest'
import { api, isCached, onStale, _testInternals } from './api'

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

  it('returns true when both diff and files are cached', () => {
    _testInternals.lastOpId = 'op1'
    _testInternals.cache.set('diff:abc@op1', { diff: '+x' })
    _testInternals.cache.set('files:abc@op1', [])
    expect(isCached('abc')).toBe(true)
  })

  it('returns false when only diff is cached', () => {
    _testInternals.lastOpId = 'op1'
    _testInternals.cache.set('diff:abc@op1', { diff: '+x' })
    expect(isCached('abc')).toBe(false)
  })

  it('returns false when only files are cached', () => {
    _testInternals.lastOpId = 'op1'
    _testInternals.cache.set('files:abc@op1', [])
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
