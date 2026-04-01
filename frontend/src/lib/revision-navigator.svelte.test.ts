import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createRevisionNavigator } from './revision-navigator.svelte'
import { api, type LogEntry } from './api'

vi.mock('./api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./api')>()
  return {
    ...actual,
    fetchRevisionMeta: vi.fn(),
    api: {
      ...actual.api,
      diff: vi.fn(),
      files: vi.fn(),
      description: vi.fn(),
    },
  }
})

import { fetchRevisionMeta } from './api'
const mockApi = vi.mocked(api)
const mockMeta = vi.mocked(fetchRevisionMeta)

function mkCommit(commitId: string, changeId = `change-${commitId}`): LogEntry['commit'] {
  return {
    commit_id: commitId,
    change_id: changeId,
    change_prefix: 4,
    commit_prefix: 4,
    is_working_copy: false,
    hidden: false,
    immutable: false,
    conflicted: false,
    divergent: false,
    empty: false,
    mine: true,
  }
}

const noAbort = () => false

// loadDiffAndFiles fires diff.load/files.load/description.load without awaiting
// (matches App.svelte's fire-and-forget). Flush the microtask + macrotask queue
// so the loaders' internal `await fetch(...)` + result application complete.
const flush = () => new Promise(r => setTimeout(r, 0))

// Single-target commitId extraction — avoids repeating the type narrowing.
function targetCommitId(nav: ReturnType<typeof createRevisionNavigator>): string | undefined {
  const t = nav.loadedTarget
  return t?.kind === 'single' ? t.commitId : undefined
}

beforeEach(() => {
  // mockReset() alone makes the mock return undefined — a prior test's
  // leaked navigateDeferred timer (50ms debounce) firing into THIS test's
  // beforeEach would hit `undefined.then()` inside the diff loader.
  // Default to a resolved promise so the chain is always valid.
  mockMeta.mockReset().mockResolvedValue(undefined)
  mockApi.diff.mockReset().mockResolvedValue({ diff: '' } as never)
  mockApi.files.mockReset().mockResolvedValue([] as never)
  mockApi.description.mockReset().mockResolvedValue({ description: '' } as never)
})

describe('progressive rendering — loadedTarget leads, diff lags', () => {
  // The scenario these tests lock in (post-refactor):
  //
  //   loadDiffAndFiles(A)
  //     gen = ++revGen             // revGen=1
  //     loadedTarget = A           // SYNC — header renders NOW
  //     diffPending = true         // SYNC — spinner shows NOW
  //     diff.load(A)               // FIRES EAGERLY (before await!)
  //       .finally(gen-check → diffPending=false)
  //     await fetchRevisionMeta(A) // ── suspended ───────────────┐
  //                                                               │
  //        <interleaved event>         // revGen=2                │
  //                                                               │
  //     // resumed ────────────────────────────────────────────────┘
  //     if (gen !== revGen) return     // 1 !== 2 → bails ✓
  //     files.load(A)                  // ← never reached
  //
  // diff.load(A) DID fire, but loader.generation discards stale results
  // (diff.set(B) or diff.load(B) bumped it past A). revGen now guards the
  // files/description.load calls, not diff.

  it('loadedTarget + diffPending set SYNCHRONOUSLY before any await', async () => {
    const nav = createRevisionNavigator({ onError: vi.fn() })
    let resolveMeta!: () => void
    mockMeta.mockImplementation(() => new Promise<void>(r => { resolveMeta = r }))
    let resolveDiff!: (v: { diff: string }) => void
    mockApi.diff.mockImplementation(() => new Promise(r => { resolveDiff = r }))

    void nav.loadDiffAndFiles(mkCommit('A'), noAbort)
    // No await — check SYNCHRONOUS state
    expect(targetCommitId(nav)).toBe('A')  // ← header can render NOW
    expect(nav.diffPending).toBe(true)     // ← spinner gate open NOW
    expect(nav.files.value).toEqual([])    // files not yet loaded

    resolveMeta()
    await flush()
    expect(nav.diffPending).toBe(true)     // diff still pending after meta
    expect(mockApi.files).toHaveBeenCalledWith('A')  // files.load fired post-meta

    resolveDiff({ diff: 'A-diff' })
    await flush()
    expect(nav.diffPending).toBe(false)
    expect(nav.diff.value).toBe('A-diff')
  })


  it('same-change refresh (snapshot: new commitId, same changeId) → diffPending stays false, no spinner', async () => {
    const nav = createRevisionNavigator({ onError: vi.fn() })
    mockMeta.mockResolvedValue(undefined)
    mockApi.diff.mockResolvedValue({ diff: 'A-diff' })

    void nav.loadDiffAndFiles(mkCommit('A', 'ch-X'), noAbort)
    expect(nav.diffPending).toBe(true)
    await flush()
    expect(nav.diffPending).toBe(false)

    // SSE snapshot: new commit_id B, SAME change_id ch-X. isRefresh keys on
    // changeId → diffPending stays false → DiffFileViews stay mounted.
    mockApi.diff.mockReturnValue(new Promise(() => {}))
    void nav.loadDiffAndFiles(mkCommit('B', 'ch-X'), noAbort)
    expect(nav.diffPending).toBe(false)
    expect(targetCommitId(nav)).toBe('B')

    // Different change → diffPending true (full reset path)
    void nav.loadDiffAndFiles(mkCommit('C', 'ch-Y'), noAbort)
    expect(nav.diffPending).toBe(true)
  })

  it('applyCacheHit invalidates suspended loadDiffAndFiles', async () => {
    const nav = createRevisionNavigator({ onError: vi.fn() })
    let resolveA!: () => void
    mockMeta.mockImplementation(() => new Promise<void>(r => { resolveA = r }))
    mockApi.diff.mockResolvedValue({ diff: 'A-diff' })

    const loadA = nav.loadDiffAndFiles(mkCommit('A'), noAbort)
    // Suspended at await fetchRevisionMeta. diff.load(A) ALREADY FIRED.
    expect(targetCommitId(nav)).toBe('A')
    expect(nav.diffPending).toBe(true)

    // While suspended: cache hit for B. diff.set(B) bumps loader.generation
    // past A's in-flight diff.load — A's result will be discarded by the loader.
    nav.applyCacheHit(mkCommit('B'), { diff: 'B-diff', files: [], description: 'B-desc' })
    expect(targetCommitId(nav)).toBe('B')
    expect(nav.diffPending).toBe(false)  // applyCacheHit clears it

    resolveA()
    await loadA
    await flush()  // let A's diff.load settle

    // B won everywhere. A's diff resolved but loader discarded it (gen mismatch).
    // A's files/description.load never fired (revGen check bailed).
    expect(targetCommitId(nav)).toBe('B')
    expect(nav.diff.value).toBe('B-diff')
    expect(nav.description.value).toBe('B-desc')
    expect(nav.diffPending).toBe(false)  // A's finally saw stale gen, no-op
    expect(mockApi.files).not.toHaveBeenCalled()
  })

  it('second loadDiffAndFiles invalidates suspended first', async () => {
    const nav = createRevisionNavigator({ onError: vi.fn() })
    const resolvers: Record<string, () => void> = {}
    mockMeta.mockImplementation((id: string) =>
      new Promise<void>(r => { resolvers[id] = r }))
    mockApi.diff.mockResolvedValue({ diff: 'B-diff' })
    mockApi.description.mockResolvedValue({ description: 'B-desc' })

    const loadA = nav.loadDiffAndFiles(mkCommit('A'), noAbort)
    const loadB = nav.loadDiffAndFiles(mkCommit('B'), noAbort)
    expect(targetCommitId(nav)).toBe('B')  // sync overwrite

    // A resumes FIRST (stale). Should bail at revGen check → files.load(A) never fires.
    resolvers['A']()
    await loadA
    expect(mockApi.files).not.toHaveBeenCalled()

    // B resumes — current gen, files/description.load fire.
    resolvers['B']()
    await loadB
    await flush()
    expect(mockApi.files).toHaveBeenCalledWith('B')
    expect(targetCommitId(nav)).toBe('B')
    expect(nav.diff.value).toBe('B-diff')
  })

  it('cancel() invalidates suspended, preserves diffPending for switchToLogView', async () => {
    // switchToLogView reads diffPending to answer "content in flight for this
    // target?" — clearing it in cancel() made switchToLogView return true with
    // files.value=[] → enterSquashMode init fileSel([]) → silent all-files squash
    // via executeSquash's empty-commit exception.
    const nav = createRevisionNavigator({ onError: vi.fn() })
    let resolveA!: () => void
    mockMeta.mockImplementation(() => new Promise<void>(r => { resolveA = r }))
    mockApi.diff.mockResolvedValue({ diff: 'A-diff' })

    const loadA = nav.loadDiffAndFiles(mkCommit('A'), noAbort)
    expect(nav.diffPending).toBe(true)

    nav.cancel()
    expect(nav.diffPending).toBe(true)  // NOT cleared — load-bearing for switchToLogView

    resolveA()
    await loadA
    await flush()
    // files.load(A) never fired (revGen bailed). diff.load's finally sees
    // stale gen → diffPending stays true. switchToLogView's caller follows
    // with a fresh loadDiffAndFiles which takes over.
    expect(mockApi.files).not.toHaveBeenCalled()
    expect(nav.diffPending).toBe(true)
  })

  it('refresh (same commit_id) skips spinner + reset — scroll preserved', async () => {
    // Post-mutation loadLog calls loadDiffAndFiles with unchanged commit_id.
    // Setting diffPending=true → spinner → DiffFileView unmount → scrollTop=0.
    // isRefresh gate: same target = no spinner, no reset, stale content visible
    // until fresh arrives via {#each file.filePath} key stability.
    const nav = createRevisionNavigator({ onError: vi.fn() })
    mockApi.diff.mockResolvedValue({ diff: 'A-diff' })
    mockApi.files.mockResolvedValue([{ type: 'M', path: 'a.go', additions: 1, deletions: 0, conflict: false, conflict_sides: 0 }])

    // First load (new target) — spinner + reset as normal
    await nav.loadDiffAndFiles(mkCommit('A'), noAbort)
    await flush()
    expect(nav.diffPending).toBe(false)
    expect(nav.files.value).toHaveLength(1)

    // Refresh (same commit_id) — describe doesn't change the tree
    mockMeta.mockClear()
    mockApi.files.mockClear()
    void nav.loadDiffAndFiles(mkCommit('A'), noAbort)
    // Synchronous check: isRefresh branch taken — no spinner, files NOT reset
    expect(nav.diffPending).toBe(false)
    expect(nav.files.value).toHaveLength(1)
  })

  it('shouldAbort re-checked AFTER meta await — catches mid-fetch multi-check', async () => {
    const nav = createRevisionNavigator({ onError: vi.fn() })
    let resolveA!: () => void
    mockMeta.mockImplementation(() => new Promise<void>(r => { resolveA = r }))

    let aborted = false
    const loadA = nav.loadDiffAndFiles(mkCommit('A'), () => aborted)
    // User checks a revision during the meta fetch — the multi-check effect
    // already fired, so files/description should NOT clobber.
    aborted = true
    resolveA()
    await loadA
    expect(mockApi.files).not.toHaveBeenCalled()
  })
})

describe('loadDiffAndFiles happy path', () => {
  it('meta + diff resolve → all three loaders fire and apply', async () => {
    const nav = createRevisionNavigator({ onError: vi.fn() })
    mockApi.diff.mockResolvedValue({ diff: 'A-diff' })
    mockApi.files.mockResolvedValue([{ type: 'M', path: 'a.go', additions: 1, deletions: 0, conflict: false, conflict_sides: 0 }])
    mockApi.description.mockResolvedValue({ description: 'A-desc' })

    await nav.loadDiffAndFiles(mkCommit('A'), noAbort)
    await flush()

    expect(nav.loadedTarget).toEqual(expect.objectContaining({ kind: 'single', commitId: 'A' }))
    expect(nav.diff.value).toBe('A-diff')
    expect(nav.files.value).toEqual([{ type: 'M', path: 'a.go', additions: 1, deletions: 0, conflict: false, conflict_sides: 0 }])
    expect(nav.description.value).toBe('A-desc')
    expect(nav.diffPending).toBe(false)
  })

  it('meta fails → diff.load fired eagerly, files/description skip (one toast)', async () => {
    const onError = vi.fn()
    const nav = createRevisionNavigator({ onError })
    mockMeta.mockRejectedValue(new Error('meta down'))
    mockApi.diff.mockRejectedValue(new Error('diff down'))

    await nav.loadDiffAndFiles(mkCommit('A'), noAbort)
    await flush()

    // diff.load fired EAGERLY (before meta await) and errored → one toast.
    // Meta rejection caught silently → files/description never fire.
    expect(mockApi.diff).toHaveBeenCalledTimes(1)
    expect(mockApi.files).not.toHaveBeenCalled()
    expect(mockApi.description).not.toHaveBeenCalled()
    expect(onError).toHaveBeenCalledTimes(1)
  })
})

describe('applyCacheHit', () => {
  it('sets loadedTarget + three loader values synchronously', () => {
    const nav = createRevisionNavigator({ onError: vi.fn() })
    nav.applyCacheHit(mkCommit('X'), { diff: 'X-diff', files: [], description: 'X-desc' })

    expect(targetCommitId(nav)).toBe('X')
    expect(nav.diff.value).toBe('X-diff')
    expect(nav.files.value).toEqual([])
    expect(nav.description.value).toBe('X-desc')
    expect(nav.diffPending).toBe(false)  // cache hit → no spinner
  })

  it('singleTarget derives changeId via effectiveId (divergent → commit_id)', () => {
    const nav = createRevisionNavigator({ onError: vi.fn() })
    const divergent = { ...mkCommit('D'), divergent: true }
    const t = nav.singleTarget(divergent)
    expect(t.kind === 'single' && t.changeId).toBe('D') // commit_id, not change_id
  })
})

// Scheduling was previously inline in App.svelte's selectRevision (72 lines,
// untestable). navigateCached/navigateDeferred own the rAF/debounce timers
// now; cancel() clears both. These tests pin the TIMING contract — the "rAF
// runs BEFORE paint" comment in the interface docstring is what we test
// AROUND (can't test paint), but we CAN test: double-rAF means two frame
// ticks before fire, and rapid calls only fire the last.
describe('navigateCached — double-rAF paint-first deferral', () => {
  const hit = { diff: 'cached-diff', files: [], description: 'cached-desc' }

  // jsdom rAF is setTimeout(16) under the hood. Two advances = two "frames".
  const frame = () => new Promise(r => requestAnimationFrame(() => r(undefined)))

  it('fires after two frames, not one — cursor paints alone in frame N', async () => {
    const nav = createRevisionNavigator({ onError: vi.fn() })
    nav.navigateCached(mkCommit('A'), hit, () => false)

    // After one frame, nothing applied yet (outer rAF fired, inner scheduled).
    await frame()
    expect(targetCommitId(nav)).toBeUndefined()

    // After second frame, applied.
    await frame()
    expect(targetCommitId(nav)).toBe('A')
    expect(nav.diff.value).toBe('cached-diff')
  })

  it('second navigateCached cancels first — only last lands', async () => {
    // Rapid j/k through cached revisions: each press schedules, each cancels
    // prior. Only the destination's diff lands. This is what makes cached
    // j/k FASTER than uncached (no intermediate DOM builds).
    const nav = createRevisionNavigator({ onError: vi.fn() })
    nav.navigateCached(mkCommit('A'), { ...hit, diff: 'A-diff' }, () => false)
    nav.navigateCached(mkCommit('B'), { ...hit, diff: 'B-diff' }, () => false)

    await frame(); await frame()
    expect(targetCommitId(nav)).toBe('B')
    expect(nav.diff.value).toBe('B-diff')
  })

  it('abort() checked at fire — loadLog resetting selectedIndex cancels', async () => {
    // abort callback closes over App's selectedIndex. If loadLog (or
    // selectRevisionCursorOnly, or branches-view click) moves the cursor
    // WITHOUT calling selectRevision, the rAF still fires but abort()
    // sees the mismatch and bails. Without this, stale cache hit would
    // land over whatever the cursor now points at.
    const nav = createRevisionNavigator({ onError: vi.fn() })
    let aborted = false
    nav.navigateCached(mkCommit('A'), hit, () => aborted)

    await frame()
    aborted = true  // cursor moved between frames
    await frame()

    expect(targetCommitId(nav)).toBeUndefined()
  })

  it('navigateCached invalidates suspended loadDiffAndFiles BEFORE rAF fires', async () => {
    // The revGen bump at navigateCached entry (not inside the rAF callback)
    // is load-bearing: a loadDiffAndFiles suspended at its meta await could
    // resume BETWEEN schedule and fire, call files.load(stale), clobbering
    // the eventual applyCacheHit. Bumping revGen at schedule time stops it.
    const nav = createRevisionNavigator({ onError: vi.fn() })

    let resolveA!: () => void
    mockMeta.mockImplementation(() => new Promise<void>(r => { resolveA = r }))

    void nav.loadDiffAndFiles(mkCommit('A'), noAbort)
    await Promise.resolve()  // let it reach the await

    // loadedTarget=A (set sync), but navigateCached will overwrite in rAF.
    expect(targetCommitId(nav)).toBe('A')

    nav.navigateCached(mkCommit('B'), hit, () => false)  // bumps revGen NOW

    resolveA()  // A resumes — should see revGen mismatch and bail at files.load
    await flush()
    expect(mockApi.files).not.toHaveBeenCalled()

    // loadedTarget still A (rAF hasn't fired) — that's fine, applyCacheHit writes it.
    await frame(); await frame()
    expect(targetCommitId(nav)).toBe('B')
    expect(nav.diff.value).toBe('cached-diff')
  })
})

describe('navigateDeferred — 50ms debounce coalesce', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('rapid uncached j/k coalesces to CURRENT cursor at fire time', async () => {
    // getCommit is re-read at fire. Three j presses within 50ms → only
    // one load, for whatever getCommit returns THEN (the final cursor).
    const nav = createRevisionNavigator({ onError: vi.fn() })

    let current = mkCommit('A')
    nav.navigateDeferred(() => current, noAbort)
    current = mkCommit('B')
    nav.navigateDeferred(() => current, noAbort)  // cancels A's timer
    current = mkCommit('C')
    nav.navigateDeferred(() => current, noAbort)  // cancels B's timer

    // 49ms: nothing fired.
    await vi.advanceTimersByTimeAsync(49)
    expect(mockMeta).not.toHaveBeenCalled()

    // 50ms: fires once with C (what getCommit returns NOW).
    await vi.advanceTimersByTimeAsync(1)
    expect(mockMeta).toHaveBeenCalledTimes(1)
    expect(mockMeta).toHaveBeenCalledWith('C')
  })

  it('getCommit() returning null aborts — cursor cleared during debounce', async () => {
    const nav = createRevisionNavigator({ onError: vi.fn() })
    let current: ReturnType<typeof mkCommit> | null = mkCommit('A')
    nav.navigateDeferred(() => current, noAbort)

    current = null  // e.g. revisions became empty
    await vi.advanceTimersByTimeAsync(50)
    expect(mockMeta).not.toHaveBeenCalled()
  })

  it('entry-time revGen bump invalidates suspended loadDiffAndFiles', async () => {
    // /simplify quality review found the asymmetry: navigateCached bumps
    // revGen at schedule time, navigateDeferred didn't. Without the bump,
    // a suspended loadDiffAndFiles(A) resumes during the 50ms window, passes
    // its gen check, and fires files.load(A) — loader gen eventually discards
    // the stale result, but the fetch itself is wasted. Now both bump at entry.
    const nav = createRevisionNavigator({ onError: vi.fn() })
    let resolveA!: () => void
    mockMeta.mockImplementation(() => new Promise<void>(r => { resolveA = r }))

    void nav.loadDiffAndFiles(mkCommit('A'), noAbort)
    await Promise.resolve()  // reach the await

    nav.navigateDeferred(() => mkCommit('B'), noAbort)  // bumps revGen

    resolveA()
    await Promise.resolve()
    expect(mockApi.files).not.toHaveBeenCalled()  // A bailed at revGen check
  })

  it('cancel() clears pending debounce', async () => {
    // switchToLogView, handleRevsetSubmit, onDestroy all call nav.cancel().
    const nav = createRevisionNavigator({ onError: vi.fn() })
    nav.navigateDeferred(() => mkCommit('A'), noAbort)
    nav.cancel()
    await vi.advanceTimersByTimeAsync(100)
    expect(mockMeta).not.toHaveBeenCalled()
  })

  it('navigateCached cancels a pending navigateDeferred (cross-path)', async () => {
    // j (uncached, debounce scheduled) → j (cached, rAF scheduled). The
    // second must cancel the first's timer or we'd fire BOTH (debounce
    // loads stale, then rAF applies cached).
    const nav = createRevisionNavigator({ onError: vi.fn() })
    nav.navigateDeferred(() => mkCommit('A'), noAbort)
    nav.navigateCached(mkCommit('B'), { diff: 'B', files: [], description: '' }, () => false)

    await vi.advanceTimersByTimeAsync(100)
    expect(mockMeta).not.toHaveBeenCalled()  // debounce cancelled
  })
})

// Separate describe — needs REAL timers for jsdom rAF (setTimeout(16)).
describe('cancel() — rAF path', () => {
  const frame = () => new Promise(r => requestAnimationFrame(() => r(undefined)))

  it('cancel() clears pending rAF', async () => {
    const nav = createRevisionNavigator({ onError: vi.fn() })
    nav.navigateCached(mkCommit('B'), { diff: 'B', files: [], description: '' }, () => false)
    nav.cancel()
    await frame(); await frame()
    expect(targetCommitId(nav)).toBeUndefined()
  })

  it('navigateDeferred cancels a pending navigateCached (reverse cross-path)', async () => {
    // j (cached, rAF scheduled) → j (uncached, debounce scheduled).
    // clearSchedule() in navigateDeferred must cancel BOTH rAF and setTimeout.
    // If it only cleared its own timer kind, the stale rAF would fire and
    // applyCacheHit(A) would land AFTER the debounce's loadDiffAndFiles(B).
    const nav = createRevisionNavigator({ onError: vi.fn() })
    nav.navigateCached(mkCommit('A'), { diff: 'A', files: [], description: '' }, () => false)
    nav.navigateDeferred(() => mkCommit('B'), noAbort)

    await frame(); await frame()
    expect(targetCommitId(nav)).toBeUndefined()  // A's rAF cancelled
  })
})
