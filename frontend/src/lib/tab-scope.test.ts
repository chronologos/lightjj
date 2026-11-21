import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { bindTab, requestBase, setActiveBase } from './tab-scope'
import { api, onStale, setActiveTab, workspacesForTab, _testInternals } from './api'

beforeEach(() => setActiveBase('/tab/0'))
afterEach(() => vi.unstubAllGlobals())

describe('bindTab', () => {
  it('pins calls to the tab active at bind time; unbound calls follow the active tab', async () => {
    const seen: string[] = []
    const client = { go: () => { seen.push(requestBase()) }, ns: { go: () => { seen.push(requestBase()) } } }
    const bound = bindTab(client)
    setActiveBase('/tab/1')
    bound.go(); bound.ns.go(); client.go()
    expect(seen).toEqual(['/tab/0', '/tab/0', '/tab/1'])
  })

  it('restores the scope when the call throws', () => {
    const bound = bindTab({ boom() { throw new Error('x') } })
    setActiveBase('/tab/1')
    expect(() => bound.boom()).toThrow('x')
    expect(requestBase()).toBe('/tab/1')
  })

  // The proxy relies on api methods resolving their URL before the first await.
  it('real api: a two-request flow that outlives a tab switch stays in its tab', async () => {
    const urls: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (u: string) => {
      urls.push(u)
      return new Response(JSON.stringify({ content: 'x', output: '' }), { status: 200 })
    }))
    const bound = bindTab(api)
    const flow = (async () => {
      await bound.fileShow('c-bind-test', 'README.md')
      await bound.fileWrite('README.md', 'x')
      await bound.annotations.list('zzz')
    })()
    setActiveTab('1')
    await flow
    expect(urls).toHaveLength(3)
    expect(urls.every(u => u.startsWith('/tab/0/'))).toBe(true)
  })
})

describe('op-ids come only from the active tab', () => {
  it('a background tab\'s response does not mark this tab stale', async () => {
    vi.stubGlobal('fetch', vi.fn(async (u: string) => new Response('{}', {
      status: 200, headers: { 'X-JJ-Op-Id': u.startsWith('/tab/5') ? 'op-other-repo' : 'op-mine' },
    })))
    const cb = vi.fn()
    const off = onStale(cb)
    _testInternals.lastOpId = 'op-mine'
    await workspacesForTab('5')
    await Promise.resolve()
    expect(cb).not.toHaveBeenCalled()
    expect(_testInternals.lastOpId).toBe('op-mine')
    off()
  })

  it('a response from the previous tab cannot reseed the new one', async () => {
    let release!: () => void
    vi.stubGlobal('fetch', vi.fn(() => new Promise(r => {
      release = () => r(new Response('[]', { status: 200, headers: { 'X-JJ-Op-Id': 'op-old-tab' } }))
    })))
    const p = api.log()
    setActiveTab('1')
    release()
    await p
    expect(_testInternals.lastOpId).toBeNull()
  })
})
