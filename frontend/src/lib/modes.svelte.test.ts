import { describe, it, expect } from 'vitest'
import { createRebaseMode, createSquashMode, createSplitMode, createMegamergeMode, createFileSelection, targetModeLabel, type ModeBase } from './modes.svelte'

describe('targetModeLabel', () => {
  it('maps all target modes to labels', () => {
    expect(targetModeLabel['-d']).toBe('onto')
    expect(targetModeLabel['--insert-after']).toBe('after')
    expect(targetModeLabel['--insert-before']).toBe('before')
  })
})

// diffFollows is what App derives `diffFrozen` from. It answers "does j/k
// in this mode reload the diff?" — the question `inlineMode` (binary gate)
// can't answer. App used to spell `squash.active || split.active` at each
// site that needed this; the /bughunt regression was writing `inlineMode`
// there instead. New modes MUST appear in this table so the per-mode
// question is answered at definition time, not at each call site.
describe('diffFollows — per-mode nav semantics', () => {
  it.each([
    ['rebase',    createRebaseMode,    true,  'destination preview — diff shows what you land on'],
    ['squash',    createSquashMode,    false, 'frozen on source — that is what you are squashing'],
    ['split',     createSplitMode,     false, 'frozen on source — that is what you are splitting'],
    ['megamerge', createMegamergeMode, false, 'frozen on target — you are editing its parents'],
  ] as const)('%s → diffFollows=%s (%s)', (_name, create, expected, _why) => {
    const mode: ModeBase = create()
    expect(mode.diffFollows).toBe(expected)
  })
})

// ModeBase unification: kind/sources/hasDestination are the shared contract
// that lets RevisionGraph badges, StatusBar, and App's execute dispatch stay
// generic instead of branching per-mode. New modes MUST fill all three.
describe('ModeBase — kind/sources/hasDestination', () => {
  it.each([
    ['rebase',    createRebaseMode,    true],
    ['squash',    createSquashMode,    true],
    ['split',     createSplitMode,     false],
    ['megamerge', createMegamergeMode, true],
  ] as const)('%s → kind=%s, hasDestination=%s', (kind, create, hasDestination) => {
    const mode: ModeBase = create()
    expect(mode.kind).toBe(kind)
    expect(mode.hasDestination).toBe(hasDestination)
    expect(mode.sources).toEqual([])  // inactive → empty for every mode
  })

  it('split.sources mirrors revision as a single-element array', () => {
    const mode = createSplitMode()
    expect(mode.sources).toEqual([])
    mode.enter('abc123')
    expect(mode.sources).toEqual(['abc123'])
    expect(mode.revision).toBe('abc123')  // alias preserved for existing call sites
    mode.cancel()
    expect(mode.sources).toEqual([])
  })

  it('rebase/squash sources stay the entered revisions (unchanged contract)', () => {
    const rebase = createRebaseMode()
    rebase.enter(['a', 'b'])
    expect(rebase.sources).toEqual(['a', 'b'])
    const squash = createSquashMode()
    squash.enter(['c'])
    expect(squash.sources).toEqual(['c'])
  })
})

describe('createRebaseMode', () => {
  it('starts inactive', () => {
    const mode = createRebaseMode()
    expect(mode.active).toBe(false)
    expect(mode.sources).toEqual([])
    expect(mode.sourceMode).toBe('-r')
    expect(mode.targetMode).toBe('-d')
  })

  it('enter activates with given revisions and resets modes', () => {
    const mode = createRebaseMode()
    mode.handleKey('s') // change source mode
    mode.enter(['abc', 'def'])
    expect(mode.active).toBe(true)
    expect(mode.sources).toEqual(['abc', 'def'])
    expect(mode.sourceMode).toBe('-r') // reset to default
    expect(mode.targetMode).toBe('-d') // reset to default
  })

  it('cancel deactivates and clears sources', () => {
    const mode = createRebaseMode()
    mode.enter(['abc'])
    mode.cancel()
    expect(mode.active).toBe(false)
    expect(mode.sources).toEqual([])
  })

  describe('handleKey', () => {
    it('sets source mode with r/s/b', () => {
      const mode = createRebaseMode()
      expect(mode.handleKey('s')).toBe(true)
      expect(mode.sourceMode).toBe('-s')
      expect(mode.handleKey('b')).toBe(true)
      expect(mode.sourceMode).toBe('-b')
      expect(mode.handleKey('r')).toBe(true)
      expect(mode.sourceMode).toBe('-r')
    })

    it('sets target mode with a/i/o/d', () => {
      const mode = createRebaseMode()
      expect(mode.handleKey('a')).toBe(true)
      expect(mode.targetMode).toBe('--insert-after')
      expect(mode.handleKey('i')).toBe(true)
      expect(mode.targetMode).toBe('--insert-before')
      expect(mode.handleKey('o')).toBe(true)
      expect(mode.targetMode).toBe('-d')
      expect(mode.handleKey('d')).toBe(true)
      expect(mode.targetMode).toBe('-d')
    })

    it('toggles skipEmptied with e', () => {
      const mode = createRebaseMode()
      expect(mode.handleKey('e')).toBe(true)
      expect(mode.skipEmptied).toBe(true)
      expect(mode.handleKey('e')).toBe(true)
      expect(mode.skipEmptied).toBe(false)
    })

    it('toggles ignoreImmutable with x', () => {
      const mode = createRebaseMode()
      expect(mode.handleKey('x')).toBe(true)
      expect(mode.ignoreImmutable).toBe(true)
      expect(mode.handleKey('x')).toBe(true)
      expect(mode.ignoreImmutable).toBe(false)
    })

    it('returns false for unrecognized keys', () => {
      const mode = createRebaseMode()
      expect(mode.handleKey('z')).toBe(false)
      expect(mode.handleKey('Enter')).toBe(false)
      expect(mode.handleKey('Escape')).toBe(false)
    })
  })
})

describe('createSquashMode', () => {
  it('starts inactive', () => {
    const mode = createSquashMode()
    expect(mode.active).toBe(false)
    expect(mode.sources).toEqual([])
    expect(mode.keepEmptied).toBe(false)
  })

  it('enter activates and resets toggles', () => {
    const mode = createSquashMode()
    mode.handleKey('e') // toggle keepEmptied on
    mode.enter(['abc'])
    expect(mode.active).toBe(true)
    expect(mode.sources).toEqual(['abc'])
    expect(mode.keepEmptied).toBe(false) // reset
  })

  it('cancel deactivates and clears sources', () => {
    const mode = createSquashMode()
    mode.enter(['abc'])
    mode.cancel()
    expect(mode.active).toBe(false)
    expect(mode.sources).toEqual([])
  })

  describe('handleKey', () => {
    it('toggles keepEmptied with e', () => {
      const mode = createSquashMode()
      expect(mode.handleKey('e')).toBe(true)
      expect(mode.keepEmptied).toBe(true)
      expect(mode.handleKey('e')).toBe(true)
      expect(mode.keepEmptied).toBe(false)
    })

    it('toggles ignoreImmutable with x', () => {
      const mode = createSquashMode()
      expect(mode.handleKey('x')).toBe(true)
      expect(mode.ignoreImmutable).toBe(true)
      expect(mode.handleKey('x')).toBe(true)
      expect(mode.ignoreImmutable).toBe(false)
    })

    it('cycles descMode with m: destination → source → combine → destination', () => {
      const mode = createSquashMode()
      expect(mode.descMode).toBe('destination')
      expect(mode.handleKey('m')).toBe(true)
      expect(mode.descMode).toBe('source')
      expect(mode.handleKey('m')).toBe(true)
      expect(mode.descMode).toBe('combine')
      expect(mode.handleKey('m')).toBe(true)
      expect(mode.descMode).toBe('destination')
    })

    it('enter resets descMode to destination', () => {
      const mode = createSquashMode()
      mode.handleKey('m') // → source
      mode.enter(['abc'])
      expect(mode.descMode).toBe('destination')
    })

    it('returns false for unrecognized keys', () => {
      const mode = createSquashMode()
      expect(mode.handleKey('z')).toBe(false)
    })
  })
})

describe('createSplitMode', () => {
  it('starts inactive', () => {
    const mode = createSplitMode()
    expect(mode.active).toBe(false)
    expect(mode.revision).toBe('')
    expect(mode.parallel).toBe(false)
  })

  it('enter activates with revision and resets parallel', () => {
    const mode = createSplitMode()
    mode.handleKey('p') // toggle parallel on
    mode.enter('abc123')
    expect(mode.active).toBe(true)
    expect(mode.revision).toBe('abc123')
    expect(mode.parallel).toBe(false) // reset
  })

  it('cancel deactivates and clears all state', () => {
    const mode = createSplitMode()
    mode.enter('abc123')
    mode.handleKey('p')
    mode.cancel()
    expect(mode.active).toBe(false)
    expect(mode.revision).toBe('')
    expect(mode.parallel).toBe(false)
  })

  describe('handleKey', () => {
    it('toggles parallel with p', () => {
      const mode = createSplitMode()
      expect(mode.handleKey('p')).toBe(true)
      expect(mode.parallel).toBe(true)
      expect(mode.handleKey('p')).toBe(true)
      expect(mode.parallel).toBe(false)
    })

    it('returns false for unrecognized keys', () => {
      const mode = createSplitMode()
      expect(mode.handleKey('x')).toBe(false)
    })
  })

  it('re-enter after cancel resets cleanly', () => {
    const mode = createSplitMode()
    mode.enter('first')
    mode.handleKey('p')
    expect(mode.parallel).toBe(true)
    mode.cancel()
    mode.enter('second')
    expect(mode.revision).toBe('second')
    expect(mode.parallel).toBe(false)
    expect(mode.active).toBe(true)
  })

  it('review defaults to false; enter(id, true) sets it; cancel resets it', () => {
    const mode = createSplitMode()
    expect(mode.review).toBe(false)
    mode.enter('abc', true)
    expect(mode.review).toBe(true)
    expect(mode.active).toBe(true)
    mode.cancel()
    expect(mode.review).toBe(false)
    // Default enter without second arg clears review
    mode.enter('def')
    expect(mode.review).toBe(false)
  })
})

describe('createFileSelection', () => {
  const f = (path: string) => ({ path })

  it('starts empty', () => {
    const sel = createFileSelection()
    expect(sel.set.size).toBe(0)
    expect(sel.total).toBe(0)
  })

  it('init seeds set all-checked + snapshots total atomically', () => {
    const sel = createFileSelection()
    sel.init([f('a.ts'), f('b.ts'), f('c.ts')])
    expect(sel.total).toBe(3)
    expect(sel.set.size).toBe(3)
    expect(sel.set.has('a.ts')).toBe(true)
    expect(sel.set.has('b.ts')).toBe(true)
    expect(sel.set.has('c.ts')).toBe(true)
  })

  it('toggle flips membership', () => {
    const sel = createFileSelection()
    sel.init([f('a.ts'), f('b.ts')])
    sel.toggle('a.ts')
    expect(sel.set.has('a.ts')).toBe(false)
    expect(sel.set.size).toBe(1)
    sel.toggle('a.ts')
    expect(sel.set.has('a.ts')).toBe(true)
    expect(sel.set.size).toBe(2)
  })

  it('toggle preserves total snapshot — total is init-time, not live', () => {
    const sel = createFileSelection()
    sel.init([f('a.ts'), f('b.ts')])
    sel.toggle('a.ts')
    sel.toggle('b.ts')
    expect(sel.set.size).toBe(0)
    expect(sel.total).toBe(2) // unchanged — this is what executeSquash/Split compare against
  })

  it('clear zeroes both atomically', () => {
    const sel = createFileSelection()
    sel.init([f('a.ts'), f('b.ts')])
    sel.toggle('a.ts')
    sel.clear()
    expect(sel.set.size).toBe(0)
    expect(sel.total).toBe(0)
  })

  // The bug class the factory prevents: squash seeds 5 files, user Escapes
  // without execute, split entry re-seeds. Before: two loose declarations
  // meant a forgotten .clear() left stale state. Now init() is atomic.
  it('init after partial use fully replaces prior state (no leak)', () => {
    const sel = createFileSelection()
    sel.init([f('a.ts'), f('b.ts'), f('c.ts'), f('d.ts'), f('e.ts')])
    sel.toggle('a.ts')
    sel.toggle('b.ts')
    // Simulate mode re-entry WITHOUT clear() — init() alone must reset both.
    sel.init([f('x.ts'), f('y.ts')])
    expect(sel.total).toBe(2)
    expect(sel.set.size).toBe(2)
    expect(sel.set.has('a.ts')).toBe(false) // not leaked
    expect(sel.set.has('c.ts')).toBe(false) // not leaked
    expect(sel.set.has('x.ts')).toBe(true)
  })

  it('init on empty list — the empty-commit squash case', () => {
    const sel = createFileSelection()
    sel.init([f('a.ts')])
    sel.init([])
    expect(sel.total).toBe(0)
    expect(sel.set.size).toBe(0)
  })
})

describe('createMegamergeMode', () => {
  it('starts inactive with empty state', () => {
    const m = createMegamergeMode()
    expect(m.active).toBe(false)
    expect(m.kind).toBe('megamerge')
    expect(m.sources).toEqual([])
    expect(m.destinationIds).toEqual([])
    expect(m.parentIds).toEqual([])
  })

  // ModeBase contract: frozen diff (you're editing the target's parents, not
  // previewing a landing spot) but hasDestination=true so j/k moves the cursor.
  it('has the multi-destination ModeBase shape', () => {
    const m = createMegamergeMode()
    expect(m.diffFollows).toBe(false)
    expect(m.hasDestination).toBe(true)
  })

  it('enter seeds parent set from commit_ids and exposes target', () => {
    const m = createMegamergeMode()
    m.enter('ctarget', 'ktarget', ['kp1', 'kp2'])
    expect(m.active).toBe(true)
    expect(m.target).toBe('ctarget')
    expect(m.targetCommitId).toBe('ktarget')
    expect(m.sources).toEqual(['ctarget'])
    expect(new Set(m.parentIds)).toEqual(new Set(['kp1', 'kp2']))
    expect(new Set(m.destinationIds)).toEqual(new Set(['kp1', 'kp2']))
    expect(new Set(m.initialParentIds)).toEqual(new Set(['kp1', 'kp2']))
  })

  it('toggle adds and removes a commit_id from the parent set', () => {
    const m = createMegamergeMode()
    m.enter('ctarget', 'ktarget', ['kp1'])
    m.toggle('kp2')
    expect(new Set(m.parentIds)).toEqual(new Set(['kp1', 'kp2']))
    m.toggle('kp1')
    expect(new Set(m.parentIds)).toEqual(new Set(['kp2']))
  })

  // A commit can never be its own parent — toggling the target is a no-op.
  it('toggle ignores the target commit_id', () => {
    const m = createMegamergeMode()
    m.enter('ctarget', 'ktarget', ['kp1'])
    m.toggle('ktarget')
    expect(new Set(m.parentIds)).toEqual(new Set(['kp1']))
  })

  // initialParentIds is the no-op-exit baseline — it must NOT track live edits.
  it('initialParentIds is frozen at enter, unaffected by toggles', () => {
    const m = createMegamergeMode()
    m.enter('ctarget', 'ktarget', ['kp1'])
    m.toggle('kp2')
    expect(new Set(m.initialParentIds)).toEqual(new Set(['kp1']))
  })

  it('cancel resets to empty inactive state', () => {
    const m = createMegamergeMode()
    m.enter('ctarget', 'ktarget', ['kp1'])
    m.cancel()
    expect(m.active).toBe(false)
    expect(m.target).toBe('')
    expect(m.targetCommitId).toBe('')
    expect(m.parentIds).toEqual([])
    expect(m.initialParentIds).toEqual([])
  })
})
