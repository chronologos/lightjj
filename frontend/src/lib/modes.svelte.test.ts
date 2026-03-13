import { describe, it, expect } from 'vitest'
import { createRebaseMode, createSquashMode, createSplitMode, createFileSelection, targetModeLabel } from './modes.svelte'

describe('targetModeLabel', () => {
  it('maps all target modes to labels', () => {
    expect(targetModeLabel['-d']).toBe('onto')
    expect(targetModeLabel['--insert-after']).toBe('after')
    expect(targetModeLabel['--insert-before']).toBe('before')
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
    expect(mode.useDestMsg).toBe(false)
  })

  it('enter activates and resets toggles', () => {
    const mode = createSquashMode()
    mode.handleKey('e') // toggle keepEmptied on
    mode.enter(['abc'])
    expect(mode.active).toBe(true)
    expect(mode.sources).toEqual(['abc'])
    expect(mode.keepEmptied).toBe(false) // reset
    expect(mode.useDestMsg).toBe(false)
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

    it('toggles useDestMsg with d', () => {
      const mode = createSquashMode()
      expect(mode.handleKey('d')).toBe(true)
      expect(mode.useDestMsg).toBe(true)
      expect(mode.handleKey('d')).toBe(true)
      expect(mode.useDestMsg).toBe(false)
    })

    it('toggles ignoreImmutable with x', () => {
      const mode = createSquashMode()
      expect(mode.handleKey('x')).toBe(true)
      expect(mode.ignoreImmutable).toBe(true)
      expect(mode.handleKey('x')).toBe(true)
      expect(mode.ignoreImmutable).toBe(false)
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
