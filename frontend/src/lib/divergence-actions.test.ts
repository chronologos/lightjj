import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest'

// Mock api BEFORE module import — importOriginal keeps types + pure exports.
vi.mock('./api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./api')>()
  return {
    ...actual,
    api: {
      ...actual.api,
      rebase: vi.fn(),
      abandon: vi.fn(),
      bookmarkSet: vi.fn(),
      metaeditChangeId: vi.fn(),
      squash: vi.fn(),
    },
  }
})

import { api } from './api'
import { executeKeepPlan, splitIdentity, squashDivergent, abandonMutable } from './divergence-actions'
import type { KeepPlan } from './divergence'

const mockRebase = api.rebase as Mock
const mockAbandon = api.abandon as Mock
const mockBookmarkSet = api.bookmarkSet as Mock
const mockMetaedit = api.metaeditChangeId as Mock
const mockSquash = api.squash as Mock

const ok = (output = ''): { output: string; warnings?: string } => ({ output })

beforeEach(() => {
  mockRebase.mockReset().mockResolvedValue(ok())
  mockAbandon.mockReset().mockResolvedValue(ok())
  mockBookmarkSet.mockReset().mockResolvedValue(ok())
  mockMetaedit.mockReset().mockResolvedValue(ok())
  mockSquash.mockReset().mockResolvedValue(ok())
})

function plan(overrides: Partial<KeepPlan> = {}): KeepPlan {
  return {
    keeperCommitId: 'keeper00aabbccdd',
    abandonCommitIds: ['loser000aabbccdd'],
    bookmarkRepoints: [],
    nonEmptyDescendants: [],
    rebaseSources: [],
    ...overrides,
  }
}

describe('executeKeepPlan', () => {
  // The load-bearing invariant. If abandon ran first, jj would auto-rebase
  // descendants onto trunk (the loser-stack's parent), and then our explicit
  // rebase would hit a twice-rebased tree.
  it('rebase → abandon → bookmarkSet order', async () => {
    const order: string[] = []
    mockRebase.mockImplementation(async () => { order.push('rebase'); return ok() })
    mockAbandon.mockImplementation(async () => { order.push('abandon'); return ok() })
    mockBookmarkSet.mockImplementation(async () => { order.push('bookmark'); return ok() })

    await executeKeepPlan(plan({
      rebaseSources: ['desc0000'],
      bookmarkRepoints: [{ name: 'feat', targetCommitId: 'keeper00aabbccdd' }],
    }))

    expect(order).toEqual(['rebase', 'abandon', 'bookmark'])
  })

  it('rebase passes -s (not -r) so descendants follow', async () => {
    await executeKeepPlan(plan({ rebaseSources: ['desc0000', 'desc1111'] }))
    expect(mockRebase).toHaveBeenCalledWith(['desc0000', 'desc1111'], 'keeper00aabbccdd', '-s', '-d')
  })

  it('skips rebase when rebaseSources is empty', async () => {
    await executeKeepPlan(plan({ rebaseSources: [] }))
    expect(mockRebase).not.toHaveBeenCalled()
    expect(mockAbandon).toHaveBeenCalledOnce()
  })

  it('bookmarkSet called once per repoint, serially', async () => {
    await executeKeepPlan(plan({
      bookmarkRepoints: [
        { name: 'a', targetCommitId: 'ta000000' },
        { name: 'b', targetCommitId: 'tb000000' },
      ],
    }))
    expect(mockBookmarkSet).toHaveBeenCalledTimes(2)
    expect(mockBookmarkSet).toHaveBeenNthCalledWith(1, 'ta000000', 'a')
    expect(mockBookmarkSet).toHaveBeenNthCalledWith(2, 'tb000000', 'b')
  })

  // Divergence rebase is MORE likely than average to conflict (moving commits
  // between stacks) — that warning must not get lost when abandon returns
  // clean after it.
  it('accumulates results from every step', async () => {
    mockRebase.mockResolvedValue({ output: '', warnings: 'Warning: conflict in foo.go' })
    mockAbandon.mockResolvedValue(ok('abandoned'))
    mockBookmarkSet.mockResolvedValue(ok('moved'))

    const { results } = await executeKeepPlan(plan({
      rebaseSources: ['desc'],
      bookmarkRepoints: [{ name: 'feat', targetCommitId: 't' }],
    }))

    expect(results).toHaveLength(3)
    expect(results[0].warnings).toBe('Warning: conflict in foo.go')
    expect(results[1].output).toBe('abandoned')
    expect(results[2].output).toBe('moved')
  })

  it('text reflects what actually ran', async () => {
    const { text: minimal } = await executeKeepPlan(plan({ abandonCommitIds: ['x'] }))
    expect(minimal).toBe('Resolved divergence — kept keeper00')

    const { text: full } = await executeKeepPlan(plan({
      rebaseSources: ['a', 'b'],
      abandonCommitIds: ['x', 'y', 'z'],
    }))
    expect(full).toBe('Resolved divergence — kept keeper00, rebased 2, abandoned 3')
  })

  it('propagates rejection (caller keeps panel open)', async () => {
    mockAbandon.mockRejectedValue(new Error('immutable'))
    await expect(executeKeepPlan(plan())).rejects.toThrow('immutable')
  })
})

describe('splitIdentity', () => {
  it('calls metaeditChangeId and wraps result', async () => {
    mockMetaedit.mockResolvedValue(ok('new change_id: xyz'))
    const { text, results } = await splitIdentity('abc12345deadbeef')
    expect(mockMetaedit).toHaveBeenCalledWith('abc12345deadbeef')
    expect(text).toBe('Split identity — abc12345 now has a new change_id')
    expect(results).toEqual([ok('new change_id: xyz')])
  })
})

describe('squashDivergent', () => {
  it('wraps from in an array and passes no opts', async () => {
    await squashDivergent('from0000aabbccdd', 'into0000aabbccdd')
    expect(mockSquash).toHaveBeenCalledWith(['from0000aabbccdd'], 'into0000aabbccdd')
  })

  it('text shows from → into', async () => {
    const { text } = await squashDivergent('from0000aabbccdd', 'into0000aabbccdd')
    expect(text).toBe('Squashed from0000 → into0000')
  })
})

describe('abandonMutable', () => {
  it('wraps id in an array', async () => {
    await abandonMutable('mut00000aabbccdd')
    expect(mockAbandon).toHaveBeenCalledWith(['mut00000aabbccdd'])
  })

  it('text says accepting trunk', async () => {
    const { text } = await abandonMutable('mut00000aabbccdd')
    expect(text).toBe("Abandoned mutable mut00000 — accepting trunk's version")
  })
})
