import { describe, it, expect, vi, beforeEach } from 'vitest'
import { resolveConflictFile, isLocalOnlyError, type ResolveConflictDeps } from './conflict-resolve'

// Pure DI — no api.ts / network mocking needed. These tests are the spec for
// the strategy table both resolution surfaces (merge-controller save,
// DiffPanel quickResolve/saveMerge) rely on.

const localModeError = () => new Error('merge-resolve requires local mode')

const fileWrite = vi.fn()
const mergeResolve = vi.fn()
const edit = vi.fn()
let wcChangeId: string | undefined

function deps(over: Partial<ResolveConflictDeps> = {}): ResolveConflictDeps {
  return {
    api: { fileWrite, mergeResolve, edit },
    getWorkingCopyChangeId: () => wcChangeId,
    ...over,
  }
}

const target = { changeId: 'qqqqqqqq', revision: 'cafe1234' }

beforeEach(() => {
  wcChangeId = 'zzzzzzzz'
  fileWrite.mockReset().mockResolvedValue({ ok: true })
  mergeResolve.mockReset().mockResolvedValue({ output: '' })
  edit.mockReset().mockResolvedValue({ output: '' })
})

describe('resolveConflictFile — strategy table', () => {
  it('@ target (change_id matches working copy) → fileWrite only', async () => {
    wcChangeId = 'qqqqqqqq'
    const r = await resolveConflictFile(deps(), target, 'a.go', 'fixed')
    expect(r).toEqual({ ok: true, movedWorkingCopy: false })
    expect(fileWrite).toHaveBeenCalledWith('a.go', 'fixed')
    expect(mergeResolve).not.toHaveBeenCalled()
    expect(edit).not.toHaveBeenCalled()
  })

  it('@ comparison is by change_id — a stale/different commit_id does not break it', async () => {
    // The documented rule: fileWrite snapshots @ → new commit_id, so targets
    // captured pre-snapshot can never match by commit_id. Only change_id is
    // stable across snapshots.
    wcChangeId = 'qqqqqqqq'
    const r = await resolveConflictFile(
      deps(),
      { changeId: 'qqqqqqqq', revision: 'pre-snapshot-commit-id' },
      'a.go', 'x',
    )
    expect(r.ok).toBe(true)
    expect(fileWrite).toHaveBeenCalled()
    expect(mergeResolve).not.toHaveBeenCalled()
  })

  it('non-@ target, local mode → mergeResolve at the revision; @ never moves', async () => {
    const r = await resolveConflictFile(deps(), target, 'a.go', 'fixed')
    expect(r).toEqual({ ok: true, movedWorkingCopy: false })
    expect(mergeResolve).toHaveBeenCalledWith('cafe1234', 'a.go', 'fixed')
    expect(fileWrite).not.toHaveBeenCalled()
    expect(edit).not.toHaveBeenCalled()
  })

  it('non-@ target, SSH mode (501) → explicit jj-edit fallback, movedWorkingCopy reported', async () => {
    mergeResolve.mockRejectedValueOnce(localModeError())
    const r = await resolveConflictFile(deps(), target, 'a.go', 'fixed')
    expect(r).toEqual({ ok: true, movedWorkingCopy: true })
    expect(edit).toHaveBeenCalledWith('cafe1234')
    expect(fileWrite).toHaveBeenCalledWith('a.go', 'fixed')
    // Order matters: edit BEFORE write (the write lands in @ = the target).
    expect(edit.mock.invocationCallOrder[0]).toBeLessThan(fileWrite.mock.invocationCallOrder[0])
  })
})

describe('resolveConflictFile — race protection (isStale hook)', () => {
  it('stale before the SSH fallback → no jj edit, no write, reason "stale"', async () => {
    // The point of no return: moving @ for a target the user navigated away
    // from is worse than not resolving at all.
    mergeResolve.mockRejectedValueOnce(localModeError())
    const r = await resolveConflictFile(deps({ isStale: () => true }), target, 'a.go', 'x')
    expect(r).toEqual({ ok: false, reason: 'stale' })
    expect(edit).not.toHaveBeenCalled()
    expect(fileWrite).not.toHaveBeenCalled()
  })

  it('isStale is NOT consulted on the happy paths (@ and local non-@)', async () => {
    // Callers check staleness before calling; the first internal await is the
    // mutation itself. Consulting isStale here would let a gen bump cancel a
    // write the user already committed to.
    const isStale = vi.fn(() => true)
    wcChangeId = 'qqqqqqqq'
    expect((await resolveConflictFile(deps({ isStale }), target, 'a.go', 'x')).ok).toBe(true)
    wcChangeId = 'zzzzzzzz'
    expect((await resolveConflictFile(deps({ isStale }), target, 'a.go', 'x')).ok).toBe(true)
    expect(isStale).not.toHaveBeenCalled()
  })

  it('stale flips true only after edit ran → write still completes (no half-state)', async () => {
    // Once @ has moved, completing the write is strictly better than aborting
    // (moved @ + still-conflicted file). The caller's own post-await guards
    // handle UI side effects; the data operation finishes.
    mergeResolve.mockRejectedValueOnce(localModeError())
    let stale = false
    edit.mockImplementationOnce(async () => { stale = true })
    const r = await resolveConflictFile(deps({ isStale: () => stale }), target, 'a.go', 'x')
    expect(r).toEqual({ ok: true, movedWorkingCopy: true })
    expect(fileWrite).toHaveBeenCalled()
  })
})

describe('resolveConflictFile — error handling (never throws)', () => {
  it('@ fileWrite failure → ok:false error outcome', async () => {
    wcChangeId = 'qqqqqqqq'
    const boom = new Error('disk full')
    fileWrite.mockRejectedValueOnce(boom)
    const r = await resolveConflictFile(deps(), target, 'a.go', 'x')
    expect(r).toEqual({ ok: false, reason: 'error', error: boom })
  })

  it('non-@ mergeResolve failure that is NOT the 501 → error outcome, no fallback', async () => {
    // e.g. jj's "no conflict at path" — falling back to jj edit here would
    // move @ for an operation that was never going to succeed.
    const boom = new Error('no conflict at a.go')
    mergeResolve.mockRejectedValueOnce(boom)
    const r = await resolveConflictFile(deps(), target, 'a.go', 'x')
    expect(r).toEqual({ ok: false, reason: 'error', error: boom })
    expect(edit).not.toHaveBeenCalled()
    expect(fileWrite).not.toHaveBeenCalled()
  })

  it('SSH fallback: edit failure → error outcome, no write', async () => {
    mergeResolve.mockRejectedValueOnce(localModeError())
    const boom = new Error('jj edit failed')
    edit.mockRejectedValueOnce(boom)
    const r = await resolveConflictFile(deps(), target, 'a.go', 'x')
    expect(r).toEqual({ ok: false, reason: 'error', error: boom })
    expect(fileWrite).not.toHaveBeenCalled()
  })

  it('SSH fallback: fileWrite failure after edit → error outcome CARRIES movedWorkingCopy (@ has moved)', async () => {
    mergeResolve.mockRejectedValueOnce(localModeError())
    const boom = new Error('write failed')
    fileWrite.mockRejectedValueOnce(boom)
    const r = await resolveConflictFile(deps(), target, 'a.go', 'x')
    // The edit already ran, so the failure outcome must report the moved
    // working copy — callers append it to their error message; without the
    // flag the user is left with a silently relocated @ + a conflicted file.
    expect(r).toEqual({ ok: false, reason: 'error', error: boom, movedWorkingCopy: true })
    expect(edit).toHaveBeenCalled()
  })
})

describe('isLocalOnlyError', () => {
  it.each([
    [new Error('merge-resolve requires local mode'), true],
    [new Error('501: merge-resolve requires local mode'), true],
    [new Error('no conflict at path'), false],
    ['local mode', false],          // not an Error instance
    [undefined, false],
  ])('%s → %s', (e, expected) => {
    expect(isLocalOnlyError(e)).toBe(expected)
  })
})
