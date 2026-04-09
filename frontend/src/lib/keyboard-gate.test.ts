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
    diffScroll: spy('diffScroll'),
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

// Try-handlers that fire before each swallow gate. PRE_INPUT = before inInput
// returns; PRE_MOD = before hasModifier returns (adds diffScroll, which sits
// between the two).
const PRE_INPUT = ['globalOverrides', 'inlineCommit']
const PRE_MOD = [...PRE_INPUT, 'diffScroll']

describe('routeKeydown — gate priority', () => {
  // The ORDER invariants from the :1742-1750 comment. Each row asserts the
  // LAST handler called — earlier handlers in the chain return false (default).
  it.each<[string, Partial<GateCtx>, keyof GateHandlers]>([
    ['plain j in log view → logKeys', {}, 'logKeys'],
    ['j in branches → logKeys (delegate + globalKeys fall through)', { activeView: 'branches' }, 'logKeys'],
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
  it.each<[string, Partial<GateCtx>, string[]]>([
    ['j in input → swallowed', { inInput: true }, PRE_INPUT],
    ['Cmd+j → swallowed (modifier passthrough)', { hasModifier: true }, PRE_MOD],
    ['j behind modal → swallowed', { anyModalOpen: true }, PRE_MOD],
    ['j in branches with defaultPrevented → swallowed', { activeView: 'branches', defaultPrevented: true }, PRE_MOD],
    ['j in merge with defaultPrevented → swallowed', { activeView: 'merge', defaultPrevented: true }, PRE_MOD],
  ])('%s', (_, over, expected) => {
    const { h, calls } = harness()
    routeKeydown(ctx(over), h)
    expect(calls).toEqual(expected)
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
      expect(calls).toEqual(PRE_MOD)  // none handle → hasModifier swallows
    })

    it('diffScroll AFTER inInput — Ctrl+E in a text field is readline end-of-line, not diff scroll', () => {
      const { h, calls } = harness({ diffScroll: true })
      routeKeydown(ctx({ hasModifier: true, key: 'e', inInput: true }), h)
      expect(calls).toEqual(PRE_INPUT)
    })

    it('diffScroll BEFORE hasModifier — Ctrl+E claims the key instead of passthrough', () => {
      const { h, calls } = harness({ diffScroll: true })
      routeKeydown(ctx({ hasModifier: true, key: 'e' }), h)
      expect(calls.at(-1)).toBe('diffScroll')
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
      expect(calls).toEqual([...PRE_MOD, 'delegateFileHistory'])  // then swallowed
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

    it('branches: delegate falls through → globalKeys → logKeys (Space on visible graph)', () => {
      const { h, calls } = harness()
      routeKeydown(ctx({ activeView: 'branches' }), h)
      expect(calls).toEqual([...PRE_MOD, 'delegateBranches', 'globalKeys', 'logKeys'])
    })

    it('branches: globalKeys handles → logKeys NOT called', () => {
      const { h, calls } = harness({ globalKeys: true })
      routeKeydown(ctx({ key: '2', activeView: 'branches' }), h)
      expect(calls.at(-1)).toBe('globalKeys')
      expect(calls).not.toContain('logKeys')
    })

    it('merge: delegate falls through → globalKeys terminal', () => {
      const { h, calls } = harness()
      routeKeydown(ctx({ activeView: 'merge' }), h)
      expect(calls).toEqual([...PRE_MOD, 'delegateConflictQueue', 'globalKeys'])
    })
  })
})
