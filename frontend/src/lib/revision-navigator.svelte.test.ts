import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createRevisionNavigator } from './revision-navigator.svelte'
import { api, fetchRevisionMeta, type FileChange, type LogEntry } from './api'

vi.mock('./api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./api')>()
  return {
    ...actual,
    fetchRevisionMeta: vi.fn(),
    api: { ...actual.api, diff: vi.fn(), files: vi.fn(), description: vi.fn() },
  }
})

const mockApi = vi.mocked(api)
const mockMeta = vi.mocked(fetchRevisionMeta)

function mkCommit(commitId: string, changeId = `change-${commitId}`): LogEntry['commit'] {
  return {
    commit_id: commitId, change_id: changeId, change_prefix: 4, commit_prefix: 4,
    is_working_copy: false, hidden: false, immutable: false, conflicted: false,
    divergent: false, empty: false, mine: true,
  }
}
const file = (path: string): FileChange => ({ type: 'M', path, additions: 1, deletions: 0, conflict: false, conflict_sides: 0 })
const multi = (...ids: string[]) => ({ kind: 'multi' as const, revset: `connected(${ids.join('|')})`, commitIds: ids })
const noAbort = () => false
const flush = () => new Promise(r => setTimeout(r, 0))

type Nav = ReturnType<typeof createRevisionNavigator>
const mk = (onError = vi.fn()): Nav => createRevisionNavigator({ onError })
const shownId = (nav: Nav) => nav.loadedTarget?.kind === 'single' ? nav.loadedTarget.commitId : undefined

/** api.diff / fetchRevisionMeta under manual control, per id. */
function manual() {
  const diff: Record<string, { ok: () => void; fail: () => void }> = {}
  const meta: Record<string, { ok: () => void; fail: () => void }> = {}
  mockApi.diff.mockImplementation((id: string) => new Promise((res, rej) => {
    diff[id] = { ok: () => res({ diff: `${id}-diff` }), fail: () => rej(new Error('diff down')) }
  }) as never)
  mockMeta.mockImplementation((id: string) => new Promise<void>((res, rej) => {
    meta[id] = { ok: () => res(), fail: () => rej(new Error('meta down')) }
  }))
  return { diff, meta }
}

beforeEach(() => {
  mockMeta.mockReset().mockResolvedValue(undefined)
  mockApi.diff.mockReset().mockImplementation((async (id: string) => ({ diff: `${id}-diff` })) as never)
  mockApi.files.mockReset().mockImplementation((async (id: string) => [file(`${id}.go`)]) as never)
  mockApi.description.mockReset().mockImplementation((async (id: string) => ({ description: `${id}-desc` })) as never)
})
afterEach(() => vi.useRealTimers())

describe('onSettled', () => {
  it('reports a single revision once it is all there, loaded or cached — never a superseded, failed or multi load', async () => {
    const { diff, meta } = manual()
    const settled: string[] = []
    const nav = createRevisionNavigator({ onError: vi.fn(), onSettled: id => settled.push(id) })
    void nav.loadDiffAndFiles(mkCommit('A'))
    diff.A.ok()
    await flush()
    expect(settled).toEqual([]) // files still to come
    meta.A.ok()
    await flush()
    expect(settled).toEqual(['A'])

    void nav.loadDiffAndFiles(mkCommit('B'))
    void nav.loadDiffAndFiles(mkCommit('C'))
    diff.B.ok(); meta.B.ok(); diff.C.fail(); meta.C.ok()
    await flush()
    void nav.loadMulti(multi('A', 'B'))
    await flush()
    expect(settled).toEqual(['A'])

    nav.applyCacheHit(mkCommit('D'), { diff: 'd', files: [], description: '' })
    expect(settled).toEqual(['A', 'D'])
  })
})

describe('progressive load', () => {
  it('target and spinner are synchronous; content, files and description land with their own target', async () => {
    const { diff, meta } = manual()
    const nav = mk()
    void nav.loadDiffAndFiles(mkCommit('A'))
    expect([shownId(nav), nav.diffPending, nav.ready]).toEqual(['A', true, false])
    expect([nav.files, nav.description]).toEqual([[], ''])

    meta.A.ok()
    await flush()
    expect(nav.files.map(f => f.path)).toEqual(['A.go'])
    expect([nav.description, nav.diffPending, nav.ready]).toEqual(['A-desc', true, false])

    diff.A.ok()
    await flush()
    expect([nav.diffText, nav.diffContentKey, nav.diffPending, nav.ready]).toEqual(['A-diff', 'A', false, true])
  })

  it('not ready until the FILE LIST lands, even when the diff landed first', async () => {
    // The squash-everything bug: diff done, meta pending → "not loading", zero files.
    const { diff, meta } = manual()
    const nav = mk()
    void nav.loadDiffAndFiles(mkCommit('A'))
    diff.A.ok()
    await flush()
    expect([nav.diffPending, nav.files.length, nav.ready]).toEqual([false, 0, false])
    meta.A.ok()
    await flush()
    expect(nav.ready).toBe(true)
  })

  it('a failed file list is never ready, and reloading recovers', async () => {
    const nav = mk()
    mockMeta.mockRejectedValueOnce(new Error('meta down'))
    await nav.loadDiffAndFiles(mkCommit('A'))
    expect(nav.ready).toBe(false)
    await nav.loadDiffAndFiles(mkCommit('A'))
    expect(nav.ready).toBe(true)
  })

  it('both fail → one toast, spinner cleared, nothing shown', async () => {
    const onError = vi.fn()
    const nav = mk(onError)
    mockMeta.mockRejectedValue(new Error('meta down'))
    mockApi.diff.mockRejectedValue(new Error('diff down'))
    await nav.loadDiffAndFiles(mkCommit('A'))
    expect(onError).toHaveBeenCalledTimes(1)
    expect([nav.diffPending, nav.diffText, nav.ready]).toEqual([false, '', false])
  })

  it('a later load wins whatever order responses arrive in', async () => {
    const { diff, meta } = manual()
    const nav = mk()
    void nav.loadDiffAndFiles(mkCommit('A'))
    void nav.loadDiffAndFiles(mkCommit('B'))
    diff.B.ok(); meta.B.ok()
    await flush()
    diff.A.ok(); meta.A.ok()
    await flush()
    expect([shownId(nav), nav.diffText, nav.diffContentKey, nav.description]).toEqual(['B', 'B-diff', 'B', 'B-desc'])
    expect(nav.files.map(f => f.path)).toEqual(['B.go'])
  })

  it('a load started after a failure shows the spinner again', async () => {
    const nav = mk()
    mockApi.diff.mockRejectedValueOnce(new Error('down'))
    await nav.loadDiffAndFiles(mkCommit('A'))
    void nav.loadDiffAndFiles(mkCommit('B'))
    expect(nav.diffPending).toBe(true)
  })

  it('singleTarget uses effectiveId (divergent → commit_id)', () => {
    expect(mk().singleTarget({ ...mkCommit('D'), divergent: true }).changeId).toBe('D')
  })
})

describe('same-change refresh keeps content on screen', () => {
  it('new commit_id, same change: no spinner, stale content up, but not ready', async () => {
    const nav = mk()
    await nav.loadDiffAndFiles(mkCommit('A1', 'x'))
    const { diff, meta } = manual()
    void nav.loadDiffAndFiles(mkCommit('A2', 'x'))
    expect([nav.diffPending, nav.diffText, nav.diffContentKey]).toEqual([false, 'A1-diff', 'A1'])
    expect(nav.files.map(f => f.path)).toEqual(['A1.go'])
    // A mode entered now would snapshot A1's files for A2.
    expect(nav.ready).toBe(false)
    diff.A2.ok(); meta.A2.ok()
    await flush()
    expect([nav.diffText, nav.ready]).toEqual(['A2-diff', true])
  })

  it('unchanged commit_id: still ready throughout', async () => {
    const nav = mk()
    await nav.loadDiffAndFiles(mkCommit('A'))
    manual()
    void nav.loadDiffAndFiles(mkCommit('A'))
    expect([nav.diffPending, nav.ready, nav.files.length]).toEqual([false, true, 1])
  })

  it('a failed refresh keeps the old content (blanking it would unmount open editors)', async () => {
    const nav = mk()
    await nav.loadDiffAndFiles(mkCommit('A1', 'x'))
    mockApi.diff.mockRejectedValueOnce(new Error('blip'))
    await nav.loadDiffAndFiles(mkCommit('A2', 'x'))
    expect([nav.diffText, nav.diffPending, nav.diffContentKey]).toEqual(['A1-diff', false, 'A1'])
  })

  it('a failed load of a DIFFERENT change never shows the previous diff under it', async () => {
    const nav = mk()
    await nav.loadDiffAndFiles(mkCommit('A'))
    mockApi.diff.mockRejectedValueOnce(new Error('down'))
    await nav.loadDiffAndFiles(mkCommit('B'))
    expect([nav.diffText, nav.diffPending]).toEqual(['', false])
  })
})

describe('applyCacheHit', () => {
  const hit = { diff: 'X-diff', files: [file('x.go')], description: 'X-desc' }

  it('everything synchronous, no spinner, ready', () => {
    const nav = mk()
    nav.applyCacheHit(mkCommit('X'), hit)
    expect([shownId(nav), nav.diffText, nav.diffContentKey, nav.description, nav.diffPending, nav.ready])
      .toEqual(['X', 'X-diff', 'X', 'X-desc', false, true])
    expect(nav.files).toBe(hit.files) // identity preserved: no downstream re-run
  })

  it('beats an in-flight load', async () => {
    const { diff, meta } = manual()
    const nav = mk()
    void nav.loadDiffAndFiles(mkCommit('A'))
    nav.applyCacheHit(mkCommit('X'), hit)
    diff.A.ok(); meta.A.ok()
    await flush()
    expect([shownId(nav), nav.diffText, nav.description, nav.ready]).toEqual(['X', 'X-diff', 'X-desc', true])
  })
})

describe('loadMulti', () => {
  it('spinner until its content lands; previous file list stays up but is not ready', async () => {
    const nav = mk()
    await nav.loadDiffAndFiles(mkCommit('A'))
    const { diff } = manual()
    const t = multi('A', 'B')
    void nav.loadMulti(t)
    expect([nav.diffPending, nav.files.length, nav.description, nav.ready]).toEqual([true, 1, '', false])
    diff[t.revset].ok()
    await flush()
    expect([nav.diffPending, nav.diffContentKey, nav.ready]).toEqual([false, t.revset, true])
    expect(mockApi.files).toHaveBeenCalledWith(t.revset)
  })

  it('checking a single revision already on screen does not flash the spinner', async () => {
    // multiRevset of one id IS that id: identical content, so the body must not
    // unmount (its observers would re-attach to nothing).
    const nav = mk()
    await nav.loadDiffAndFiles(mkCommit('A'))
    void nav.loadMulti({ kind: 'multi', revset: 'A', commitIds: ['A'] })
    expect(nav.diffPending).toBe(false)
  })
})

describe('schedules', () => {
  const hit = (id: string) => ({ diff: `${id}-cached`, files: [], description: '' })
  const frame = () => new Promise(r => requestAnimationFrame(() => r(undefined)))

  it('navigateCached lands after two frames; only the last of a burst lands', async () => {
    const nav = mk()
    nav.navigateCached(mkCommit('A'), hit('A'), noAbort)
    nav.navigateCached(mkCommit('B'), hit('B'), noAbort)
    await frame()
    expect(shownId(nav)).toBeUndefined()
    await frame()
    expect([shownId(nav), nav.diffText]).toEqual(['B', 'B-cached'])
  })

  it('abort is checked at fire', async () => {
    const nav = mk()
    let aborted = false
    nav.navigateCached(mkCommit('A'), hit('A'), () => aborted)
    await frame()
    aborted = true
    await frame()
    expect(shownId(nav)).toBeUndefined()
  })

  it('navigateDeferred debounces 50ms and re-reads the commit at fire', () => {
    vi.useFakeTimers()
    const nav = mk()
    let cur = mkCommit('A')
    nav.navigateDeferred(() => cur, noAbort)
    vi.advanceTimersByTime(30)
    cur = mkCommit('B')
    nav.navigateDeferred(() => cur, noAbort)
    vi.advanceTimersByTime(49)
    expect(shownId(nav)).toBeUndefined()
    vi.advanceTimersByTime(1)
    expect(shownId(nav)).toBe('B')
    expect(mockApi.diff).toHaveBeenCalledTimes(1)
  })

  it('cancelSchedule and reset drop a pending schedule', () => {
    vi.useFakeTimers()
    for (const stop of ['cancelSchedule', 'reset'] as const) {
      const nav = mk()
      nav.navigateDeferred(() => mkCommit('A'), noAbort)
      nav[stop]()
      vi.advanceTimersByTime(200)
      expect(shownId(nav)).toBeUndefined()
    }
  })

  it('a direct load supersedes a pending schedule — the older cached diff cannot land on top', async () => {
    const nav = mk()
    nav.navigateCached(mkCommit('v1', 'x'), hit('v1'), noAbort)
    await nav.loadDiffAndFiles(mkCommit('v2', 'x'))
    await frame(); await frame(); await frame()
    expect([shownId(nav), nav.diffText]).toEqual(['v2', 'v2-diff'])
  })

  it('moving on mid-load keeps the spinner instead of mounting a diff about to be replaced', async () => {
    const { diff, meta } = manual()
    const nav = mk()
    void nav.loadDiffAndFiles(mkCommit('A'))
    nav.navigateDeferred(() => mkCommit('B'), noAbort)
    diff.A.ok(); meta.A.ok()
    await flush()
    expect(nav.diffPending).toBe(true)
  })

  // Regressions: the spinner used to be a flag that some paths invalidated without
  // taking over, leaving "Loading diff..." up forever.
  it.each<[string, (nav: Nav) => void | Promise<void>]>([
    ['a schedule that aborts', async nav => {
      nav.navigateDeferred(() => mkCommit('B'), () => true)
      await new Promise(r => setTimeout(r, 60))
    }],
    ['a schedule that finds no commit', async nav => {
      nav.navigateDeferred(() => null, noAbort)
      await new Promise(r => setTimeout(r, 60))
    }],
    ['cancelSchedule', nav => nav.cancelSchedule()],
  ])('%s during a load leaves the load to finish and clear its spinner', async (_, interrupt) => {
    const { diff } = manual()
    const nav = mk()
    const t = multi('A', 'B')
    void nav.loadMulti(t)
    await interrupt(nav)
    expect(nav.diffPending).toBe(true)
    diff[t.revset].ok()
    await flush()
    expect([nav.diffPending, nav.diffContentKey]).toEqual([false, t.revset])
  })
})

describe('reset / setDescription', () => {
  it('reset shows nothing, and a late response cannot bring it back', async () => {
    const { diff, meta } = manual()
    const nav = mk()
    void nav.loadDiffAndFiles(mkCommit('A'))
    nav.reset()
    diff.A.ok(); meta.A.ok()
    await flush()
    expect([nav.loadedTarget, nav.diffText, nav.files.length, nav.diffPending, nav.ready]).toEqual([undefined, '', 0, false, false])
  })

  it('setDescription touches only the commit it names', async () => {
    const nav = mk()
    await nav.loadDiffAndFiles(mkCommit('A'))
    nav.setDescription('B', 'nope')
    expect(nav.description).toBe('A-desc')
    nav.setDescription('A', 'new')
    expect(nav.description).toBe('new')
    expect(nav.files.map(f => f.path)).toEqual(['A.go'])
  })
})
