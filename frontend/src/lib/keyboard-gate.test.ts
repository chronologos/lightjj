import { describe, it, expect } from 'vitest'
import { routeKeydown, type GateCtx, type GateHandlers } from './keyboard-gate'

// Spy-handler harness: each handler records its name when called. `handled`
// maps handler-name → return value so tests can model "X doesn't handle,
// falls through to Y".
function harness(handled: Partial<Record<keyof GateHandlers, boolean>> = {}) {
  const calls: string[] = []
  const spy = <K extends keyof GateHandlers>(name: K): GateHandlers[K] =>
    (() => { calls.push(name); return handled[name] ?? false }) as GateHandlers[K]
  const h: GateHandlers = {
    globalOverrides: spy('globalOverrides'),
    inlineCommit: spy('inlineCommit'),
    delegateFileHistory: spy('delegateFileHistory'),
    inlineNav: spy('inlineNav'),
    delegateBranches: spy('delegateBranches'),
    mergeEscape: spy('mergeEscape'),
    delegateConflictQueue: spy('delegateConflictQueue'),
    escapeStack: spy('escapeStack'),
    globalKeys: spy('globalKeys'),
    logKeys: spy('logKeys'),
  }
  return { h, calls }
}

const base: GateCtx = {
  key: 'j', hasModifier: false, inInput: false, defaultPrevented: false,
  fileHistoryOpen: false, anyModalOpen: false, inlineMode: false, activeView: 'log',
}

const ctx = (over: Partial<GateCtx>): GateCtx => ({ ...base, ...over })

describe('routeKeydown — gate priority', () => {
  // The ORDER invariants from the :1742-1750 comment. Each row asserts the
  // LAST handler called — earlier handlers in the chain return false (default).
  it.each<[string, Partial<GateCtx>, keyof GateHandlers]>([
    ['plain j in log view → logKeys', {}, 'logKeys'],
    ['j in branches → globalKeys (after delegate falls through)', { activeView: 'branches' }, 'globalKeys'],
    ['j in merge → globalKeys (after delegate falls through)', { activeView: 'merge' }, 'globalKeys'],
    ['Escape in log → escapeStack', { key: 'Escape' }, 'escapeStack'],
    ['Escape in merge → mergeEscape (NOT escapeStack)', { key: 'Escape', activeView: 'merge' }, 'mergeEscape'],
    ['j in inline mode → inlineNav (swallows, never reaches logKeys)', { inlineMode: true }, 'inlineNav'],
  ])('%s', (_, over, terminal) => {
    const { h, calls } = harness()
    routeKeydown(ctx(over), h)
    expect(calls.at(-1)).toBe(terminal)
  })

  // Swallow gates — no handler called past the try-handlers.
  it.each<[string, Partial<GateCtx>]>([
    ['j in input → swallowed', { inInput: true }],
    ['Cmd+j → swallowed (modifier passthrough)', { hasModifier: true }],
    ['j behind modal → swallowed', { anyModalOpen: true }],
    ['j in branches with defaultPrevented → swallowed', { activeView: 'branches', defaultPrevented: true }],
    ['j in merge with defaultPrevented → swallowed', { activeView: 'merge', defaultPrevented: true }],
  ])('%s', (_, over) => {
    const { h, calls } = harness()
    routeKeydown(ctx(over), h)
    // Only the try-handlers (globalOverrides, inlineCommit) fire before swallow.
    expect(calls).toEqual(['globalOverrides', 'inlineCommit'])
  })

  // The load-bearing orderings — these are the regression locks.
  describe('ordering invariants', () => {
    it('globalOverrides BEFORE inInput — Cmd+K works in text fields', () => {
      const { h, calls } = harness({ globalOverrides: true })
      routeKeydown(ctx({ hasModifier: true, key: 'k', inInput: true }), h)
      expect(calls).toEqual(['globalOverrides'])
    })

    it('inlineCommit BEFORE inInput — Enter executes squash while FileSelectionPanel focused', () => {
      const { h, calls } = harness({ inlineCommit: true })
      routeKeydown(ctx({ key: 'Enter', inInput: true, inlineMode: true }), h)
      expect(calls).toEqual(['globalOverrides', 'inlineCommit'])
    })

    it('hasModifier AFTER globalOverrides — Cmd+C passes through to browser', () => {
      const { h, calls } = harness()
      routeKeydown(ctx({ hasModifier: true, key: 'c' }), h)
      expect(calls).toEqual(['globalOverrides', 'inlineCommit'])  // neither handles → hasModifier swallows
    })

    it('inlineNav swallows EVERYTHING — t does not toggle theme in rebase mode', () => {
      const { h, calls } = harness()
      routeKeydown(ctx({ key: 't', inlineMode: true }), h)
      expect(calls.at(-1)).toBe('inlineNav')
      expect(calls).not.toContain('globalKeys')
    })

    it('fileHistory delegate BEFORE anyModalOpen — j/k work in overlay', () => {
      const { h, calls } = harness({ delegateFileHistory: true })
      routeKeydown(ctx({ fileHistoryOpen: true, anyModalOpen: true }), h)
      expect(calls.at(-1)).toBe('delegateFileHistory')
    })

    it('fileHistory delegate falls through to modal swallow on non-handled key', () => {
      const { h, calls } = harness({ delegateFileHistory: false })
      routeKeydown(ctx({ fileHistoryOpen: true, anyModalOpen: true }), h)
      expect(calls).toEqual(['globalOverrides', 'inlineCommit', 'delegateFileHistory'])  // then swallowed
    })

    it('merge Escape BEFORE conflictQueue delegate — Escape always exits', () => {
      const { h, calls } = harness({ delegateConflictQueue: true })
      routeKeydown(ctx({ key: 'Escape', activeView: 'merge' }), h)
      expect(calls.at(-1)).toBe('mergeEscape')
      expect(calls).not.toContain('delegateConflictQueue')
    })

    it('branches delegate BEFORE globalKeys — d/f/t handled by panel, not theme-toggle', () => {
      const { h, calls } = harness({ delegateBranches: true })
      routeKeydown(ctx({ key: 't', activeView: 'branches' }), h)
      expect(calls.at(-1)).toBe('delegateBranches')
      expect(calls).not.toContain('globalKeys')
    })
  })

  describe('fall-through chains', () => {
    it('log view: globalKeys handles → logKeys NOT called', () => {
      const { h, calls } = harness({ globalKeys: true })
      routeKeydown(ctx({ key: '2' }), h)
      expect(calls.at(-1)).toBe('globalKeys')
      expect(calls).not.toContain('logKeys')
    })

    it('branches: delegate falls through → globalKeys terminal (no logKeys)', () => {
      const { h, calls } = harness()
      routeKeydown(ctx({ activeView: 'branches' }), h)
      expect(calls).toEqual(['globalOverrides', 'inlineCommit', 'delegateBranches', 'globalKeys'])
    })

    it('merge: delegate falls through → globalKeys terminal', () => {
      const { h, calls } = harness()
      routeKeydown(ctx({ activeView: 'merge' }), h)
      expect(calls).toEqual(['globalOverrides', 'inlineCommit', 'delegateConflictQueue', 'globalKeys'])
    })
  })
})
