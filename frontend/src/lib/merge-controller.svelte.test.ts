import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createMergeController, type MergeControllerDeps, type MergeQueueItem } from './merge-controller.svelte'
import { api } from './api'

vi.mock('./api', async (orig) => {
  const actual = await orig<typeof import('./api')>()
  return { ...actual, api: { ...actual.api, conflicts: vi.fn(), fileShow: vi.fn(), fileWrite: vi.fn(), mergeResolve: vi.fn(), edit: vi.fn() } }
})
vi.mock('./conflict-extract', () => ({
  reconstructSides: vi.fn((c: string) => c.startsWith('UNSUPPORTED') ? null : { base: 'b', ours: 'o', theirs: 't', oursRef: null, theirsRef: null }),
}))

const mockApi = vi.mocked(api)

// Manual resolver capture — the revision-navigator test pattern for
// deterministic race reproduction.
function deferred<T>() {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const p = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { p, resolve, reject }
}

const flush = () => new Promise(r => setTimeout(r, 0))

const item = (path: string, changeId = 'zzz'): MergeQueueItem =>
  ({ commitId: `c_${path}`, changeId, path, sides: 2 })

const onError = vi.fn()
const onWarning = vi.fn()
const withMutation = vi.fn((fn: () => Promise<unknown>) => fn()) as MergeControllerDeps['withMutation'] & ReturnType<typeof vi.fn>
const reload = vi.fn().mockResolvedValue(undefined)
let wcChangeId: string | undefined
const deps: MergeControllerDeps = {
  onError, onWarning, withMutation, reload,
  getWorkingCopyChangeId: () => wcChangeId,
}

beforeEach(() => {
  wcChangeId = 'zzz'
  onError.mockClear()
  onWarning.mockClear()
  withMutation.mockClear()
  reload.mockClear()
  mockApi.conflicts.mockReset().mockResolvedValue([])
  mockApi.fileShow.mockReset().mockResolvedValue({ content: 'ok' })
  mockApi.fileWrite.mockReset().mockResolvedValue({ ok: true })
  mockApi.mergeResolve.mockReset().mockResolvedValue({ output: '', warnings: '' })
  mockApi.edit.mockReset().mockResolvedValue({ output: '', warnings: '' })
})

describe('enter()', () => {
  it('bug_039: resets current/sides but preserves resolved', async () => {
    const mc = createMergeController(deps)
    mc.selectFile(item('a.go'))
    await flush()
    expect(mc.current).not.toBeNull()
    expect(mc.sides).not.toBeNull()
    await mc.save('fixed')
    expect(mc.resolved.has('c_a.go:a.go')).toBe(true)

    await mc.enter()
    expect(mc.current).toBeNull()
    expect(mc.sides).toBeNull()
    expect(mc.resolved.has('c_a.go:a.go')).toBe(true)  // survives
  })

  it('bug_009: double enter() — first resolve does not clear second loading', async () => {
    const mc = createMergeController(deps)
    const d1 = deferred<[]>()
    const d2 = deferred<[]>()
    mockApi.conflicts.mockImplementationOnce(() => d1.p).mockImplementationOnce(() => d2.p)

    mc.enter()
    mc.enter()
    expect(mc.queueLoading).toBe(true)

    d1.resolve([])
    await flush()
    expect(mc.queueLoading).toBe(true)  // still loading — second in flight

    d2.resolve([])
    await flush()
    expect(mc.queueLoading).toBe(false)
  })

  it('bug_013: enter() rejects → returns false (caller decides activeView)', async () => {
    const mc = createMergeController(deps)
    mockApi.conflicts.mockRejectedValueOnce(new Error('boom'))
    const ok = await mc.enter()
    expect(ok).toBe(false)
    expect(onError).toHaveBeenCalled()
  })

  it('bug_013: superseded reject returns true (not an error — stale)', async () => {
    const mc = createMergeController(deps)
    const d = deferred<never>()
    mockApi.conflicts.mockImplementationOnce(() => d.p).mockResolvedValueOnce([])

    const p1 = mc.enter()
    mc.enter()  // supersedes
    d.reject(new Error('stale'))
    expect(await p1).toBe(true)
    expect(onError).not.toHaveBeenCalled()
  })
})

describe('selectFile()', () => {
  it('bug_047: clears sides synchronously before await', async () => {
    const mc = createMergeController(deps)
    mc.selectFile(item('a.go'))
    await flush()
    expect(mc.sides).not.toBeNull()

    const d = deferred<{ content: string }>()
    mockApi.fileShow.mockImplementationOnce(() => d.p)
    mc.selectFile(item('b.go'))
    expect(mc.sides).toBeNull()  // cleared BEFORE resolve
    expect(mc.busy).toBe(true)

    d.resolve({ content: 'ok' })
    await flush()
    expect(mc.sides).not.toBeNull()
  })

  it('rapid j/k: out-of-order resolve — A then B started, A resolves late → B wins', async () => {
    const mc = createMergeController(deps)
    const dA = deferred<{ content: string }>()
    mockApi.fileShow
      .mockImplementationOnce(() => dA.p)
      .mockResolvedValueOnce({ content: 'B-content' })

    mc.selectFile(item('a.go'))
    mc.selectFile(item('b.go'))
    await flush()
    expect(mc.current?.path).toBe('b.go')
    expect(mc.busy).toBe(false)  // B's finally cleared it

    dA.resolve({ content: 'A-content' })
    await flush()
    expect(mc.current?.path).toBe('b.go')  // A bounced, didn't clobber
    expect(mc.busy).toBe(false)
  })

  it('unsupported format → onWarning, sides stays null', async () => {
    const mc = createMergeController(deps)
    mockApi.fileShow.mockResolvedValueOnce({ content: 'UNSUPPORTED' })
    mc.selectFile(item('a.go'))
    await flush()
    expect(mc.sides).toBeNull()
    expect(onWarning).toHaveBeenCalledWith(expect.stringContaining('unsupported'))
  })
})

describe('save()', () => {
  it('@ branch (change_id matches wc) → fileWrite', async () => {
    // bug_040: gates on change_id, not commit_id (fileWrite snapshots @).
    const mc = createMergeController(deps)
    mc.selectFile(item('a.go', 'zzz'))  // changeId matches wc
    await flush()
    const ok = await mc.save('fixed')
    expect(ok).toBe(true)
    expect(mockApi.fileWrite).toHaveBeenCalledWith('a.go', 'fixed')
    expect(mockApi.mergeResolve).not.toHaveBeenCalled()
  })

  it('non-@ branch (change_id mismatch) → mergeResolve with commit_id', async () => {
    // Replaces the old "warning, no write" — non-@ now resolves via
    // jj resolve --tool cp. commit_id (not change_id) so divergent change_ids
    // don't make `jj resolve -r` ambiguous.
    const mc = createMergeController(deps)
    mc.selectFile(item('a.go', 'aaa'))  // NOT wc's change_id
    await flush()
    const ok = await mc.save('fixed')
    expect(ok).toBe(true)
    expect(mockApi.fileWrite).not.toHaveBeenCalled()
    expect(mockApi.mergeResolve).toHaveBeenCalledWith('c_a.go', 'a.go', 'fixed')
  })

  it('non-@ SSH 501 → explicit jj-edit fallback: resolves, warns "working copy moved"', async () => {
    // Strategy unification (conflict-resolve.ts): instead of bouncing with a
    // "run jj edit yourself" hint, the SSH fallback runs jj edit + fileWrite
    // and REPORTS the moved working copy — same semantics as DiffPanel's
    // resolution path, never silent.
    mockApi.mergeResolve.mockRejectedValueOnce(
      new Error('501: merge-resolve requires local mode'),
    )
    const mc = createMergeController(deps)
    mc.selectFile(item('a.go', 'aaa'))
    await flush()
    const ok = await mc.save('fixed')
    expect(ok).toBe(true)
    expect(mockApi.edit).toHaveBeenCalledWith('c_a.go')
    expect(mockApi.fileWrite).toHaveBeenCalledWith('a.go', 'fixed')
    expect(onError).not.toHaveBeenCalled()
    expect(onWarning).toHaveBeenCalledWith(expect.stringContaining('working copy moved'))
    expect(mc.resolved.has('c_a.go:a.go')).toBe(true)
    expect(reload).toHaveBeenCalled()
  })

  it('non-@ SSH 501 + superseding selectFile during save → fallback does NOT move @ (stale)', async () => {
    // The isStale hook (shared gen) gates the fallback's jj edit — the point
    // of no return. A nav during the failed mergeResolve await must not let
    // the fallback move @ for a target the user already left.
    const dResolve = deferred<never>()
    mockApi.mergeResolve.mockImplementationOnce(() => dResolve.p)
    const mc = createMergeController(deps)
    mc.selectFile(item('a.go', 'aaa'))
    await flush()

    const savePromise = mc.save('fixed')
    await flush()
    mc.selectFile(item('b.go', 'bbb'))  // bumps shared gen mid-save
    await flush()

    dResolve.reject(new Error('501: merge-resolve requires local mode'))
    expect(await savePromise).toBe(false)
    expect(mockApi.edit).not.toHaveBeenCalled()
    expect(mc.resolved.has('c_a.go:a.go')).toBe(false)
  })

  it('non-@ SSH 501 + supersede AFTER the fallback edit ran → moved @ is still reported', async () => {
    // Once the fallback's `jj edit` has run, the working copy HAS moved on
    // the remote — a gen bump (user navigated to the next conflict) cannot
    // undo that. The supersede early-return must not swallow the
    // movedWorkingCopy warning: it goes to App's MessageBar, which is
    // app-level, not selection-level.
    mockApi.mergeResolve.mockRejectedValueOnce(
      new Error('501: merge-resolve requires local mode'),
    )
    const dWrite = deferred<{ ok: boolean }>()
    mockApi.fileWrite.mockImplementationOnce(() => dWrite.p)

    const mc = createMergeController(deps)
    mc.selectFile(item('a.go', 'aaa'))
    await flush()

    const savePromise = mc.save('fixed')
    await flush()  // mergeResolve 501s → isStale passes → edit runs → fileWrite pending
    expect(mockApi.edit).toHaveBeenCalledWith('c_a.go')  // @ has already moved

    mc.selectFile(item('b.go', 'bbb'))  // supersede AFTER the point of no return
    await flush()

    dWrite.resolve({ ok: true })
    expect(await savePromise).toBe(false)  // superseded — no resolved-add, no reload for it
    // ...but the relocated working copy is reported, never silent:
    expect(onWarning).toHaveBeenCalledWith(expect.stringContaining('working copy moved'))
    expect(mc.resolved.has('c_a.go:a.go')).toBe(false)
  })

  it('bug_051: save goes through withMutation', async () => {
    const mc = createMergeController(deps)
    mc.selectFile(item('a.go'))
    await flush()
    await mc.save('x')
    expect(withMutation).toHaveBeenCalledOnce()
  })

  it('bug_048: selectFile during save → stale save bounces (no resolved-add, no stuck busy)', async () => {
    const mc = createMergeController(deps)
    mc.selectFile(item('a.go'))
    await flush()

    const dWrite = deferred<{ ok: boolean }>()
    mockApi.fileWrite.mockImplementationOnce(() => dWrite.p)
    const savePromise = mc.save('fixed')
    await flush()  // withMutation entered, busy=true
    expect(mc.busy).toBe(true)

    mc.selectFile(item('b.go'))  // bumps shared gen
    await flush()

    dWrite.resolve({ ok: true })
    await savePromise
    expect(mc.resolved.has('c_a.go:a.go')).toBe(false)  // stale bounced
    expect(mc.busy).toBe(false)  // selectFile's finally cleared; save's didn't stick
  })

  it('save marks resolved and triggers reload', async () => {
    const mc = createMergeController(deps)
    mc.selectFile(item('a.go'))
    await flush()
    await mc.save('fixed')
    expect(mc.resolved.has('c_a.go:a.go')).toBe(true)
    expect(reload).toHaveBeenCalledOnce()
  })

  it('issue #24: save refetches queue so next file targets the rewritten commit_id', async () => {
    // Non-@ commit with two conflicted files. First save rewrites C0 → C1.
    // Without the post-save refresh, queue still holds C0; the second
    // selectFile+save would `jj resolve -r C0` → divergent rewrite.
    const mc = createMergeController(deps)
    mockApi.conflicts.mockResolvedValueOnce([
      { commit_id: 'C0', change_id: 'aaa', description: 'feat', files: [
        { path: 'a.go', sides: 2 }, { path: 'b.go', sides: 2 },
      ] },
    ])
    await mc.enter()
    expect(mc.queue[0].commit_id).toBe('C0')

    mc.selectFile({ commitId: 'C0', changeId: 'aaa', path: 'a.go', sides: 2 })
    await flush()
    // Post-save refetch: a.go resolved → gone; commit rewritten C0→C1.
    mockApi.conflicts.mockResolvedValueOnce([
      { commit_id: 'C1', change_id: 'aaa', description: 'feat', files: [
        { path: 'b.go', sides: 2 },
      ] },
    ])
    expect(await mc.save('fixed-a')).toBe(true)
    expect(mockApi.mergeResolve).toHaveBeenCalledWith('C0', 'a.go', 'fixed-a')
    // Queue refreshed → b.go now carries C1. ConflictQueue derives flat from
    // this; the next click hands selectFile a C1 item, not stale C0.
    expect(mc.queue).toHaveLength(1)
    expect(mc.queue[0].commit_id).toBe('C1')
    expect(mc.queue[0].files).toEqual([{ path: 'b.go', sides: 2 }])
    // current is NOT remapped — panel keeps showing the just-saved result;
    // remapping would re-key MergePanel against sides still loaded from C0.
    expect(mc.current?.commitId).toBe('C0')
  })

  it('issue #24: nav during post-save queue refresh → stale queue write bounces, queueLoading clears', async () => {
    const mc = createMergeController(deps)
    mc.selectFile({ commitId: 'C0', changeId: 'aaa', path: 'a.go', sides: 2 })
    await flush()
    const dQ = deferred<typeof mc.queue>()
    mockApi.conflicts.mockImplementationOnce(() => dQ.p)
    const savePromise = mc.save('fixed')
    await flush()  // mergeResolve resolved; refreshQueue pending
    expect(mc.queueLoading).toBe(true)
    mc.selectFile({ commitId: 'C0', changeId: 'aaa', path: 'b.go', sides: 2 })  // bumps gen, NOT queueGen
    await flush()
    dQ.resolve([{ commit_id: 'C1', change_id: 'aaa', description: '', files: [{ path: 'a.go', sides: 2 }] }])
    expect(await savePromise).toBe(true)   // resolution itself succeeded
    expect(mc.queue).toEqual([])           // gen-guarded queue write bounced
    expect(mc.current?.path).toBe('b.go')
    // queueLoading uses its OWN counter — selectFile's gen bump must not strand it.
    expect(mc.queueLoading).toBe(false)
  })

  it('save() returns false when withMutation is blocked', async () => {
    const mc = createMergeController({ ...deps, withMutation: async () => undefined })
    mc.selectFile(item('a.go'))
    await flush()
    expect(await mc.save('x')).toBe(false)
  })

  it('save() catches fileWrite errors → onError, returns false, no unhandled rejection', async () => {
    const mc = createMergeController(deps)
    mc.selectFile(item('a.go'))
    await flush()
    mockApi.fileWrite.mockRejectedValueOnce(new Error('disk full'))
    expect(await mc.save('x')).toBe(false)
    expect(onError).toHaveBeenCalled()
    expect(mc.resolved.size).toBe(0)
  })
})

describe('shared gen — cross-op invalidation', () => {
  it('enter() invalidates in-flight selectFile', async () => {
    const mc = createMergeController(deps)
    const d = deferred<{ content: string }>()
    mockApi.fileShow.mockImplementationOnce(() => d.p)

    mc.selectFile(item('a.go'))
    expect(mc.busy).toBe(true)

    await mc.enter()
    d.resolve({ content: 'stale' })
    await flush()
    expect(mc.sides).toBeNull()  // enter cleared it; stale resolve bounced
    expect(mc.busy).toBe(false)  // enter's gen bump means selectFile finally is no-op
  })

})
