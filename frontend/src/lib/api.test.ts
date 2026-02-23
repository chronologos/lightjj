import { describe, it, expect, vi, beforeEach } from 'vitest'
import { api, _testInternals } from './api'

// Mock fetch globally
const mockFetch = vi.fn()
vi.stubGlobal('fetch', mockFetch)

function mockResponse(data: unknown, opId: string | null = 'op1') {
  const headers = new Map<string, string>()
  if (opId) headers.set('X-JJ-Op-Id', opId)
  return {
    ok: true,
    status: 200,
    headers: { get: (k: string) => headers.get(k) ?? null },
    json: () => Promise.resolve(data),
  }
}

beforeEach(() => {
  mockFetch.mockReset()
  _testInternals.lastOpId = null
  _testInternals.cache.clear()
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
