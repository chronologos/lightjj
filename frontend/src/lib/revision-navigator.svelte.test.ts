import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createRevisionNavigator } from './revision-navigator.svelte'
import { api, type LogEntry } from './api'

vi.mock('./api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./api')>()
  return {
    ...actual,
    api: {
      ...actual.api,
      revision: vi.fn(),
      diff: vi.fn(),
      files: vi.fn(),
      description: vi.fn(),
    },
  }
})

const mockApi = vi.mocked(api)

function mkCommit(commitId: string): LogEntry['commit'] {
  return {
    commit_id: commitId,
    change_id: `change-${commitId}`,
    change_prefix: 4,
    commit_prefix: 4,
    is_working_copy: false,
    hidden: false,
    immutable: false,
    conflicted: false,
    divergent: false,
    empty: false,
  }
}

const noAbort = () => false

// loadDiffAndFiles fires diff.load/files.load/description.load without awaiting
// (matches App.svelte's fire-and-forget). Flush the microtask + macrotask queue
// so the loaders' internal `await fetch(...)` + result application complete.
const flush = () => new Promise(r => setTimeout(r, 0))

// Single-target commitId extraction — avoids repeating the type narrowing.
function targetCommitId(nav: ReturnType<typeof createRevisionNavigator>): string | undefined {
  const t = nav.diff.value.target
  return t?.kind === 'single' ? t.commitId : undefined
}

beforeEach(() => {
  mockApi.revision.mockReset()
  mockApi.diff.mockReset()
  mockApi.files.mockReset()
  mockApi.description.mockReset()
})

describe('revGen await-gap race', () => {
  // The scenario these tests lock in:
  //
  //   loadDiffAndFiles(A)
  //     gen = ++revGen         // revGen=1
  //     await api.revision(A)  // ── suspended ──────────────────┐
  //                                                              │
  //        <interleaved event>        // revGen=2                │
  //                                                              │
  //     // resumed ───────────────────────────────────────────────┘
  //     if (gen !== revGen) return    // 1 !== 2 → bails ✓
  //     diff.load(A)                  // ← never reached
  //
  // Without revGen, the resumed call's diff.load(A) bumps loader.generation
  // PAST whatever the interleaved event set, and A wins. See docs/CACHING.md.

  it('applyCacheHit invalidates suspended loadDiffAndFiles', async () => {
    const nav = createRevisionNavigator({ onError: vi.fn() })

    let resolveA!: () => void
    mockApi.revision.mockImplementation(() => new Promise<void>(r => { resolveA = r }))

    // Spy the loader to verify diff.load(A) never fires
    const diffLoadSpy = vi.spyOn(nav.diff, 'load')

    const loadA = nav.loadDiffAndFiles(mkCommit('A'), noAbort)
    // loadA is now suspended at `await api.revision('A')`.

    // While suspended: user j/k's to B, cache hit applies synchronously
    nav.applyCacheHit(mkCommit('B'), { diff: 'B-diff', files: [], description: 'B-desc' })
    expect(targetCommitId(nav)).toBe('B')
    expect(nav.description.value).toBe('B-desc')

    // Resume A. It should see revGen !== gen and bail.
    resolveA()
    await loadA

    // diff.load(singleTarget(A)) was NEVER called — that's the whole point.
    // If it had been, loader.generation would bump past the set(B) above,
    // and once api.diff('A') resolved (cache hit or not), A would overwrite B.
    expect(diffLoadSpy).not.toHaveBeenCalled()

    // State still shows B.
    expect(targetCommitId(nav)).toBe('B')
    expect(nav.description.value).toBe('B-desc')
  })

  it('second loadDiffAndFiles invalidates suspended first', async () => {
    const nav = createRevisionNavigator({ onError: vi.fn() })

    const resolvers: Record<string, () => void> = {}
    mockApi.revision.mockImplementation((id: string) =>
      new Promise<void>(r => { resolvers[id] = r }))
    mockApi.diff.mockResolvedValue({ diff: 'B-diff' })
    mockApi.files.mockResolvedValue([])
    mockApi.description.mockResolvedValue({ description: 'B-desc' })

    const loadA = nav.loadDiffAndFiles(mkCommit('A'), noAbort)
    // Suspended at await api.revision('A')

    const loadB = nav.loadDiffAndFiles(mkCommit('B'), noAbort)
    // Suspended at await api.revision('B') — revGen is now 2

    // A resumes FIRST (stale). Should bail at the gen check.
    resolvers['A']()
    await loadA
    expect(mockApi.diff).not.toHaveBeenCalled()
    expect(nav.diff.value.target).toBeUndefined() // still initial

    // B resumes — current gen, proceeds to diff.load
    resolvers['B']()
    await loadB
    await flush() // diff.load is fire-and-forget; flush its internal await chain
    expect(mockApi.diff).toHaveBeenCalledWith('B') // diffTargetKey(single(B)) === commitId
    expect(targetCommitId(nav)).toBe('B')
  })

  it('cancel() invalidates suspended loadDiffAndFiles', async () => {
    const nav = createRevisionNavigator({ onError: vi.fn() })

    let resolveA!: () => void
    mockApi.revision.mockImplementation(() => new Promise<void>(r => { resolveA = r }))

    const diffLoadSpy = vi.spyOn(nav.diff, 'load')

    const loadA = nav.loadDiffAndFiles(mkCommit('A'), noAbort)
    nav.cancel()
    resolveA()
    await loadA

    expect(diffLoadSpy).not.toHaveBeenCalled()
    // cancel() doesn't touch loader values — still initial.
    expect(nav.diff.value.target).toBeUndefined()
  })

  it('shouldAbort re-checked AFTER await — catches mid-fetch state changes', async () => {
    const nav = createRevisionNavigator({ onError: vi.fn() })

    let resolveA!: () => void
    mockApi.revision.mockImplementation(() => new Promise<void>(r => { resolveA = r }))

    let aborted = false
    const diffLoadSpy = vi.spyOn(nav.diff, 'load')

    const loadA = nav.loadDiffAndFiles(mkCommit('A'), () => aborted)
    // User checks a revision during the fetch — the multi-check effect already
    // fired via the intendedTarget $effect, so loadDiffAndFiles should NOT clobber.
    aborted = true

    resolveA()
    await loadA

    expect(diffLoadSpy).not.toHaveBeenCalled()
  })
})

describe('loadDiffAndFiles happy path', () => {
  it('batch succeeds → all three loaders fire and apply', async () => {
    const nav = createRevisionNavigator({ onError: vi.fn() })
    mockApi.revision.mockResolvedValue(undefined)
    mockApi.diff.mockResolvedValue({ diff: 'A-diff' })
    mockApi.files.mockResolvedValue([{ type: 'M', path: 'a.go', additions: 1, deletions: 0, conflict: false, conflict_sides: 0 }])
    mockApi.description.mockResolvedValue({ description: 'A-desc' })

    await nav.loadDiffAndFiles(mkCommit('A'), noAbort)
    await flush() // loaders are fire-and-forget

    expect(nav.diff.value).toEqual({
      target: expect.objectContaining({ kind: 'single', commitId: 'A' }),
      diff: 'A-diff',
    })
    expect(nav.files.value).toEqual([{ type: 'M', path: 'a.go', additions: 1, deletions: 0, conflict: false, conflict_sides: 0 }])
    expect(nav.description.value).toBe('A-desc')
  })

  it('batch fails → only diff loader fires (one error toast, not three)', async () => {
    const onError = vi.fn()
    const nav = createRevisionNavigator({ onError })

    mockApi.revision.mockRejectedValue(new Error('batch down'))
    mockApi.diff.mockRejectedValue(new Error('diff down'))

    await nav.loadDiffAndFiles(mkCommit('A'), noAbort)
    await flush() // let diff.load's rejection propagate

    // diff.load fired (and errored), files/description did NOT fire
    expect(mockApi.diff).toHaveBeenCalledTimes(1)
    expect(mockApi.files).not.toHaveBeenCalled()
    expect(mockApi.description).not.toHaveBeenCalled()
    expect(onError).toHaveBeenCalledTimes(1)
  })
})

describe('applyCacheHit', () => {
  it('sets all three loader values synchronously', () => {
    const nav = createRevisionNavigator({ onError: vi.fn() })
    nav.applyCacheHit(mkCommit('X'), { diff: 'X-diff', files: [], description: 'X-desc' })

    expect(targetCommitId(nav)).toBe('X')
    expect(nav.diff.value.diff).toBe('X-diff')
    expect(nav.files.value).toEqual([])
    expect(nav.description.value).toBe('X-desc')
  })

  it('singleTarget derives changeId via effectiveId (divergent → commit_id)', () => {
    const nav = createRevisionNavigator({ onError: vi.fn() })
    const divergent = { ...mkCommit('D'), divergent: true }
    const t = nav.singleTarget(divergent)
    expect(t.kind === 'single' && t.changeId).toBe('D') // commit_id, not change_id
  })
})
