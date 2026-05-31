import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { flushSync } from 'svelte'

// config.svelte.ts delegates recentActions to the recent-actions store; mock
// it so this test exercises config persistence only (no api.ts in the graph).
vi.mock('./recent-actions.svelte', () => ({
  recentActionsStore: { all: {} },
}))

interface FetchCall { url: string; method: string; body?: string }

let fetchCalls: FetchCall[]
let remoteConfig: Record<string, unknown>

// vi.resetModules() per test → fresh config singleton (the module hydrates at
// load time via fetch('/api/config')).
async function loadConfig() {
  const mod = await import('./config.svelte')
  await mod.config.ready
  flushSync() // run the post-hydration save effect
  return mod.config
}

beforeEach(() => {
  vi.resetModules()
  vi.useFakeTimers()
  fetchCalls = []
  remoteConfig = { theme: 'nord', splitView: true, fontSize: 15 }
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET'
    fetchCalls.push({ url: String(url), method, body: init?.body as string | undefined })
    return {
      ok: true,
      status: 200,
      headers: { get: () => null },
      json: () => Promise.resolve(method === 'GET' ? remoteConfig : {}),
    }
  }))
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

const posts = () => fetchCalls.filter(c => c.method === 'POST')

describe('config dirty-key saves (cross-instance lost-update fix)', () => {
  it('hydration applies remote values without POSTing anything back', async () => {
    const config = await loadConfig()
    expect(config.theme).toBe('nord')
    expect(config.splitView).toBe(true)

    await vi.advanceTimersByTimeAsync(1000) // let any debounced flush fire
    expect(posts()).toHaveLength(0)
  })

  it('POSTs only the locally-changed key, never the full snapshot', async () => {
    const config = await loadConfig()

    config.theme = 'dark'
    flushSync()
    await vi.advanceTimersByTimeAsync(1000)

    expect(posts()).toHaveLength(1)
    const body = JSON.parse(posts()[0].body!) as Record<string, unknown>
    // The core property: a flush carries ONLY this instance's changes.
    // A second instance's concurrent change to splitView/fontSize/etc. can no
    // longer be reverted by this instance's stale hydrated values.
    expect(body).toEqual({ theme: 'dark' })
  })

  it('accumulates multiple changed keys into one partial flush', async () => {
    const config = await loadConfig()

    config.theme = 'dark'
    config.fontSize = 12
    flushSync()
    await vi.advanceTimersByTimeAsync(1000)

    expect(posts()).toHaveLength(1)
    const body = JSON.parse(posts()[0].body!) as Record<string, unknown>
    expect(Object.keys(body).sort()).toEqual(['fontSize', 'theme'])
    expect(body.theme).toBe('dark')
    expect(body.fontSize).toBe(12)
  })

  it('keys dirtied after a flush start a fresh dirty set', async () => {
    const config = await loadConfig()

    config.theme = 'dark'
    flushSync()
    await vi.advanceTimersByTimeAsync(1000)

    config.revisionPanelWidth = 500
    flushSync()
    await vi.advanceTimersByTimeAsync(1000)

    expect(posts()).toHaveLength(2)
    const second = JSON.parse(posts()[1].body!) as Record<string, unknown>
    expect(second).toEqual({ revisionPanelWidth: 500 }) // theme NOT re-sent
  })

  it('applyPartial (ConfigModal live-apply / hydration path) does not POST', async () => {
    const config = await loadConfig()

    config.applyPartial({ theme: 'gruvbox-dark', fontSize: 13 })
    flushSync()
    await vi.advanceTimersByTimeAsync(1000)

    expect(config.theme).toBe('gruvbox-dark')
    expect(posts()).toHaveLength(0) // values are already on disk — no echo
  })
})
