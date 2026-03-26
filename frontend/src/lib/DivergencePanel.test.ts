import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest'
import { render, fireEvent } from '@testing-library/svelte'

// Mock api BEFORE component import — DivergencePanel's $effect captures api.*
// at module eval time. importOriginal keeps pure helpers (types, diffTargetKey).
vi.mock('./api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./api')>()
  return {
    ...actual,
    api: {
      ...actual.api,
      divergence: vi.fn(),
      files: vi.fn(),
      diffRange: vi.fn().mockResolvedValue({ diff: '' }),
    },
  }
})

import DivergencePanel from './DivergencePanel.svelte'
import { api } from './api'
import { entry as e } from './divergence.fixtures'

const mockDivergence = api.divergence as Mock
const mockFiles = api.files as Mock
const mockDiffRange = api.diffRange as Mock

// settle: two macrotasks — covers the chained .then in the mount $effect.
const settle = async () => {
  await new Promise(r => setTimeout(r, 0))
  await new Promise(r => setTimeout(r, 0))
}

function handlers() {
  return {
    onkeep: vi.fn().mockResolvedValue(undefined),
    onsplit: vi.fn().mockResolvedValue(undefined),
    onsquash: vi.fn().mockResolvedValue(undefined),
    onabandon: vi.fn().mockResolvedValue(undefined),
    onclose: vi.fn(),
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  mockDiffRange.mockResolvedValue({ diff: '' })
  mockFiles.mockResolvedValue([])
})

// Simple 2-column same-parent group. The workhorse fixture.
const twoColumn = [
  e({ change_id: 'X', commit_id: 'x0', parent_commit_ids: ['p'], parent_change_ids: ['P'] }),
  e({ change_id: 'X', commit_id: 'x1', parent_commit_ids: ['p'], parent_change_ids: ['P'] }),
]

describe('DivergencePanel — mount flow', () => {
  it('loads and shows 2 columns for simple 2-way divergence', async () => {
    mockDivergence.mockResolvedValue(twoColumn)
    const { container } = render(DivergencePanel, { props: { changeId: 'X', ...handlers() } })
    await settle()
    expect(container.querySelectorAll('.version-col')).toHaveLength(2)
  })

  it('finds group when changeId is a MID-stack member (not root)', async () => {
    // Stack root=A, chain=[A,B]. User clicked B. Panel must find B in changeIds.
    mockDivergence.mockResolvedValue([
      e({ change_id: 'A', commit_id: 'a0', parent_commit_ids: ['t0'], parent_change_ids: ['T'] }),
      e({ change_id: 'A', commit_id: 'a1', parent_commit_ids: ['t1'], parent_change_ids: ['T'] }),
      e({ change_id: 'B', commit_id: 'b0', parent_commit_ids: ['a0'], parent_change_ids: ['A'] }),
      e({ change_id: 'B', commit_id: 'b1', parent_commit_ids: ['a1'], parent_change_ids: ['A'] }),
    ])
    const { container } = render(DivergencePanel, { props: { changeId: 'B', ...handlers() } })
    await settle()
    expect(container.querySelectorAll('.version-col')).toHaveLength(2)
    expect(container.querySelector('.error-message')).toBeNull()
  })

  it('immutable-sibling (1-copy group): hardcoded buttons, no columns', async () => {
    // The other copy was filtered by `& mutable()` — only 1 entry returned.
    mockDivergence.mockResolvedValue([
      e({ change_id: 'X', commit_id: 'x_mut', parent_commit_ids: ['p'], parent_change_ids: ['P'] }),
    ])
    const { container } = render(DivergencePanel, { props: { changeId: 'X', ...handlers() } })
    await settle()
    expect(container.querySelectorAll('.version-col')).toHaveLength(0)
    expect(container.textContent).toContain('immutable')
    // Split-identity is the primary card (via immutableSiblingCopy)
    expect(container.querySelector('.strategy-apply')).not.toBeNull()
  })

  it('no matching group → error message', async () => {
    mockDivergence.mockResolvedValue(twoColumn)  // group for X, not Y
    const { container } = render(DivergencePanel, { props: { changeId: 'Y', ...handlers() } })
    await settle()
    expect(container.querySelector('.error-message')?.textContent).toContain('No actionable')
  })

  it('api.divergence failure → error message (not silent)', async () => {
    mockDivergence.mockRejectedValue(new Error('backend 500'))
    const { container } = render(DivergencePanel, { props: { changeId: 'X', ...handlers() } })
    await settle()
    expect(container.querySelector('.error-message')?.textContent).toContain('backend 500')
  })

  it('api.files failure → bubbles to error (NOT silent empty fileUnion)', async () => {
    // DivergencePanel.svelte:141-144: silently-empty fileUnion would make
    // refineRebaseKind → pure-rebase → HIGH-confidence WRONG recommendation.
    // Failure must bubble to the outer catch → panel error.
    mockDivergence.mockResolvedValue(twoColumn)
    mockFiles.mockRejectedValue(new Error('files API down'))
    const { container } = render(DivergencePanel, { props: { changeId: 'X', ...handlers() } })
    await settle()
    expect(container.querySelector('.error-message')?.textContent).toContain('files API down')
    expect(container.querySelectorAll('.version-col')).toHaveLength(0)  // group never set
  })
})

describe('DivergencePanel — fileUnion ordering', () => {
  it('diffRange called exactly once, WITH fileUnion filter', async () => {
    // Observable effect of the ordering invariant (fileUnion set BEFORE group):
    // the diff effect fires once with a non-undefined filter. If ordering were
    // wrong, either (a) 2 calls (first unfiltered, second filtered after
    // fileUnion lands), or (b) 1 call with undefined filter (fileUnion never
    // reached diffRange). Both would fail this assertion.
    mockDivergence.mockResolvedValue(twoColumn)
    // The panel only reads f.path — other FileChange fields are irrelevant here.
    mockFiles.mockResolvedValue([{ path: 'f.go' }])
    render(DivergencePanel, { props: { changeId: 'X', ...handlers() } })
    await settle()
    expect(mockDiffRange).toHaveBeenCalledTimes(1)
    expect(mockDiffRange.mock.calls[0][2]).toEqual(['f.go'])
  })
})

describe('DivergencePanel — confirm flow', () => {
  // Group with a non-empty descendant on the loser column. Keep should NOT
  // execute immediately — it should stash a pendingPlan and show confirm.
  const withDescendant = [
    ...twoColumn,
    e({ change_id: 'D', commit_id: 'desc', parent_commit_ids: ['x0'], parent_change_ids: ['X'], divergent: false, empty: false, description: 'user work' }),
  ]

  it('non-empty descendant → Keep opens confirm overlay, does NOT call onkeep', async () => {
    mockDivergence.mockResolvedValue(withDescendant)
    const h = handlers()
    const { container } = render(DivergencePanel, { props: { changeId: 'X', ...h } })
    await settle()
    // Click Keep on column 1 (keeper=x1, loser=x0, desc is on x0 → collateral)
    const keepBtns = container.querySelectorAll('.keep-btn')
    await fireEvent.click(keepBtns[1])
    expect(h.onkeep).not.toHaveBeenCalled()
    expect(container.querySelector('.confirm-overlay')).not.toBeNull()
    expect(container.textContent).toContain('user work')
  })

  it('empty descendant → Keep executes immediately (silent abandon, no confirm)', async () => {
    mockDivergence.mockResolvedValue([
      ...twoColumn,
      e({ change_id: 'D', commit_id: 'desc', parent_commit_ids: ['x0'], parent_change_ids: ['X'], divergent: false, empty: true }),
    ])
    const h = handlers()
    const { container } = render(DivergencePanel, { props: { changeId: 'X', ...h } })
    await settle()
    await fireEvent.click(container.querySelectorAll('.keep-btn')[1])
    expect(container.querySelector('.confirm-overlay')).toBeNull()
    expect(h.onkeep).toHaveBeenCalledOnce()
    // Descendant goes straight to abandon (it's empty = warm-merge noise)
    const plan = h.onkeep.mock.calls[0][0]
    expect(plan.abandonCommitIds).toContain('desc')
    expect(plan.nonEmptyDescendants).toEqual([])
  })

  it('confirmAbandon: descendants folded into abandonCommitIds', async () => {
    mockDivergence.mockResolvedValue(withDescendant)
    const h = handlers()
    const { container } = render(DivergencePanel, { props: { changeId: 'X', ...h } })
    await settle()
    await fireEvent.click(container.querySelectorAll('.keep-btn')[1])
    await fireEvent.click(container.querySelector('.dp-btn-abandon')!)  // "Abandon anyway"
    expect(h.onkeep).toHaveBeenCalledOnce()
    const plan = h.onkeep.mock.calls[0][0]
    expect(plan.abandonCommitIds).toContain('desc')
    expect(plan.nonEmptyDescendants).toEqual([])
    expect(plan.rebaseSources).toEqual([])  // NOT in rebase — mutual exclusion
  })

  it('confirmRebase: descendants moved to rebaseSources, NOT abandoned', async () => {
    mockDivergence.mockResolvedValue(withDescendant)
    const h = handlers()
    const { container } = render(DivergencePanel, { props: { changeId: 'X', ...h } })
    await settle()
    await fireEvent.click(container.querySelectorAll('.keep-btn')[1])
    await fireEvent.click(container.querySelector('.dp-btn-confirm')!)  // "Rebase onto keeper"
    expect(h.onkeep).toHaveBeenCalledOnce()
    const plan = h.onkeep.mock.calls[0][0]
    expect(plan.rebaseSources).toEqual(['desc'])
    expect(plan.abandonCommitIds).not.toContain('desc')  // mutual exclusion
    expect(plan.nonEmptyDescendants).toEqual([])
  })

  it('confirm Cancel: clears pendingPlan, no onkeep call', async () => {
    mockDivergence.mockResolvedValue(withDescendant)
    const h = handlers()
    const { container } = render(DivergencePanel, { props: { changeId: 'X', ...h } })
    await settle()
    await fireEvent.click(container.querySelectorAll('.keep-btn')[1])
    await fireEvent.click(container.querySelector('.dp-btn-cancel')!)  // "Cancel"
    expect(h.onkeep).not.toHaveBeenCalled()
    expect(container.querySelector('.confirm-overlay')).toBeNull()
  })
})

describe('DivergencePanel — Keep', () => {
  it('Keep col 0: onkeep receives plan with keeper=x0, abandon=[x1]', async () => {
    mockDivergence.mockResolvedValue(twoColumn)
    const h = handlers()
    const { container } = render(DivergencePanel, { props: { changeId: 'X', ...h } })
    await settle()
    await fireEvent.click(container.querySelectorAll('.keep-btn')[0])
    expect(h.onkeep).toHaveBeenCalledOnce()
    const plan = h.onkeep.mock.calls[0][0]
    expect(plan.keeperCommitId).toBe('x0')
    expect(plan.abandonCommitIds).toEqual(['x1'])
  })

  it('double-click Keep: second click is a no-op (keepingIdx re-entry guard)', async () => {
    mockDivergence.mockResolvedValue(twoColumn)
    const h = handlers()
    // Make onkeep hang so keepingIdx stays set during second click
    let resolve!: () => void
    h.onkeep.mockImplementation(() => new Promise<void>(r => { resolve = r }))
    const { container } = render(DivergencePanel, { props: { changeId: 'X', ...h } })
    await settle()
    const keepBtns = container.querySelectorAll('.keep-btn')
    await fireEvent.click(keepBtns[0])
    await fireEvent.click(keepBtns[1])  // second click while first is in flight
    resolve()
    await settle()
    expect(h.onkeep).toHaveBeenCalledTimes(1)  // second blocked
  })

  it('Keep disabled when !alignable (compound via column alignment failure)', async () => {
    // Arity mismatch — A has 2 copies, B has 3. alignColumns → null.
    mockDivergence.mockResolvedValue([
      e({ change_id: 'A', commit_id: 'a0', parent_commit_ids: ['t0'], parent_change_ids: ['T'] }),
      e({ change_id: 'A', commit_id: 'a1', parent_commit_ids: ['t1'], parent_change_ids: ['T'] }),
      e({ change_id: 'B', commit_id: 'b0', parent_commit_ids: ['a0'], parent_change_ids: ['A'] }),
      e({ change_id: 'B', commit_id: 'b1', parent_commit_ids: ['a1'], parent_change_ids: ['A'] }),
      e({ change_id: 'B', commit_id: 'b2', parent_commit_ids: ['a0'], parent_change_ids: ['A'] }),
    ])
    const h = handlers()
    const { container } = render(DivergencePanel, { props: { changeId: 'A', ...h } })
    await settle()
    // Keep buttons should be disabled. Click attempt → no onkeep call.
    const keepBtns = container.querySelectorAll('.keep-btn')
    for (const btn of keepBtns) {
      expect((btn as HTMLButtonElement).disabled).toBe(true)
    }
  })
})

describe('DivergencePanel — cross-column merge warning', () => {
  it('shows warning when a descendant merges both tip commits', async () => {
    mockDivergence.mockResolvedValue([
      ...twoColumn,
      e({ change_id: 'M', commit_id: 'merge123', parent_commit_ids: ['x0', 'x1'], parent_change_ids: ['X', 'X'], divergent: false, empty: false }),
    ])
    const { container } = render(DivergencePanel, { props: { changeId: 'X', ...handlers() } })
    await settle()
    expect(container.querySelector('.merge-warning')).not.toBeNull()
    expect(container.querySelector('.warn-id')?.textContent).toBe('merge123')
  })

  it('NO warning for ordinary single-parent descendant', async () => {
    mockDivergence.mockResolvedValue([
      ...twoColumn,
      e({ change_id: 'D', commit_id: 'd', parent_commit_ids: ['x0'], parent_change_ids: ['X'], divergent: false }),
    ])
    const { container } = render(DivergencePanel, { props: { changeId: 'X', ...handlers() } })
    await settle()
    expect(container.querySelector('.merge-warning')).toBeNull()
  })
})

describe('DivergencePanel — immutable-sibling actions', () => {
  const immSib = [
    e({ change_id: 'X', commit_id: 'x_mut', parent_commit_ids: ['p'], parent_change_ids: ['P'] }),
  ]

  it('Apply (split-identity) → onsplit with mutable commit_id', async () => {
    mockDivergence.mockResolvedValue(immSib)
    const h = handlers()
    const { container } = render(DivergencePanel, { props: { changeId: 'X', ...h } })
    await settle()
    await fireEvent.click(container.querySelector('.strategy-apply')!)
    expect(h.onsplit).toHaveBeenCalledWith('x_mut')
  })

  it('Abandon mutable → onabandon with mutable commit_id', async () => {
    mockDivergence.mockResolvedValue(immSib)
    const h = handlers()
    const { container } = render(DivergencePanel, { props: { changeId: 'X', ...h } })
    await settle()
    await fireEvent.click(container.querySelector('.strategy-pill')!)
    expect(h.onabandon).toHaveBeenCalledWith('x_mut')
  })

  it('strategyBusy: double-click blocked while split in flight', async () => {
    mockDivergence.mockResolvedValue(immSib)
    const h = handlers()
    let resolve!: () => void
    h.onsplit.mockImplementation(() => new Promise<void>(r => { resolve = r }))
    const { container } = render(DivergencePanel, { props: { changeId: 'X', ...h } })
    await settle()
    await fireEvent.click(container.querySelector('.strategy-apply')!)
    await fireEvent.click(container.querySelector('.strategy-apply')!)  // blocked
    resolve()
    await settle()
    expect(h.onsplit).toHaveBeenCalledTimes(1)
  })
})
