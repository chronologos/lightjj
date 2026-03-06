import { describe, it, expect, vi } from 'vitest'
import { createDiffDerivation } from './diff-derivation.svelte'
import type { DiffFile } from './diff-parser'

// Minimal DiffFile fixture — only filePath + hunks.length matter to the factory.
function mkFile(path: string, lines = 10): DiffFile {
  return {
    header: `diff --git a/${path} b/${path}`,
    filePath: path,
    hunks: [{ header: '@@', lines: Array(lines).fill({ type: 'add', content: '+x' }) }],
  } as DiffFile
}

const macrotask = () => new Promise<void>(r => setTimeout(r, 0))
const settle = async () => { await macrotask(); await macrotask() }

describe('createDiffDerivation', () => {
  it('starts empty', () => {
    const d = createDiffDerivation({ compute: (f) => f.filePath })
    expect(d.byFile.size).toBe(0)
  })

  it('processes files progressively and publishes per-file', async () => {
    const d = createDiffDerivation({ compute: (f) => f.filePath.toUpperCase() })
    d.run([mkFile('a.ts'), mkFile('b.ts')])
    await settle()
    expect(d.byFile.get('a.ts')).toBe('A.TS')
    expect(d.byFile.get('b.ts')).toBe('B.TS')
  })

  it('skips files matching the skip predicate', async () => {
    const d = createDiffDerivation({
      compute: (f) => f.filePath,
      skip: (f) => f.filePath.endsWith('.svg'),
    })
    d.run([mkFile('a.ts'), mkFile('b.svg'), mkFile('c.ts')])
    await settle()
    expect(d.byFile.has('a.ts')).toBe(true)
    expect(d.byFile.has('b.svg')).toBe(false)
    expect(d.byFile.has('c.ts')).toBe(true)
  })

  it('aborts in-flight run when a newer run starts', async () => {
    const calls: string[] = []
    const d = createDiffDerivation({
      compute: async (f) => { calls.push(f.filePath); return f.filePath },
    })
    d.run([mkFile('old1'), mkFile('old2'), mkFile('old3')])
    // First file computes synchronously up to the await, then yields.
    // Start a new run before the yield resolves.
    d.run([mkFile('new1')])
    await settle()
    await settle()
    // Old run's files after the first yield should not have been computed.
    // (old1 may have started but its result is discarded.)
    expect(d.byFile.size).toBe(1)
    expect(d.byFile.get('new1')).toBe('new1')
    expect(d.byFile.has('old2')).toBe(false)
  })

  it('passes isStale to compute so async workers can abort mid-file', async () => {
    const staleFns: (() => boolean)[] = []
    let resolveFirst: (v: string) => void = () => {}
    const d = createDiffDerivation({
      compute: (_f, isStale) => {
        staleFns.push(isStale)
        return staleFns.length === 1
          ? new Promise<string>(r => { resolveFirst = r })
          : 'second'
      },
    })
    d.run([mkFile('a')])
    await macrotask()
    expect(staleFns[0]()).toBe(false)
    d.run([mkFile('b')]) // supersede — bumps generation
    expect(staleFns[0]()).toBe(true) // old run's isStale now reports stale
    resolveFirst('late') // old compute finishes — result must be discarded
    await settle()
    expect(d.byFile.has('a')).toBe(false)
    expect(d.byFile.get('b')).toBe('second')
  })

  it('sync compute + immediateBudget:Infinity → run() completes synchronously', () => {
    // Lezer highlightFile case: sync body, no yields needed. run() branches
    // on Promise vs sync (matches update()) so a sync compute never awaits.
    // byFile is populated before run() returns — no settle() needed.
    const d = createDiffDerivation({
      compute: (f) => f.filePath.toUpperCase(),
      immediateBudget: Infinity,
    })
    d.run([mkFile('a.ts'), mkFile('b.ts'), mkFile('c.ts')])
    // No await — all three applied synchronously.
    expect(d.byFile.get('a.ts')).toBe('A.TS')
    expect(d.byFile.get('b.ts')).toBe('B.TS')
    expect(d.byFile.get('c.ts')).toBe('C.TS')
  })

  it('sync compute with memo write — also synchronous', () => {
    const written = new Map<string, Map<string, string>>()
    const d = createDiffDerivation({
      compute: (f) => f.filePath,
      immediateBudget: Infinity,
      writeMemo: (k, v) => written.set(k, v),
    })
    d.run([mkFile('a'), mkFile('b')], 'rev1')
    expect(written.get('rev1')?.get('a')).toBe('a')
    expect(written.get('rev1')?.get('b')).toBe('b')
  })

  it('immediateBudget: does not yield until budget is spent', async () => {
    const order: string[] = []
    // async compute — per-file microtask suspension gives the test body a
    // chance to schedule its probe before run()'s budget-yield setTimeout.
    // (Sync compute, tested above, runs straight through until that yield
    // with no intervening suspension — nothing interleaves.)
    const d = createDiffDerivation({
      compute: async (f) => { order.push(`compute:${f.filePath}`); return f.filePath },
      immediateBudget: 25, // 2.5 files at 10 lines each
    })
    // Interleave a macrotask probe — it should fire after the yield.
    void d.run([mkFile('a', 10), mkFile('b', 10), mkFile('c', 10), mkFile('d', 10)])
    setTimeout(() => order.push('probe'), 0)
    await settle()
    await settle()
    // a (10) and b (20) are under budget → no yield before c.
    // After b, linesProcessed=20 < 25, so c runs without yield too.
    // After c, linesProcessed=30 ≥ 25 → yield before d.
    // The probe macrotask should land between c and d.
    const probeIdx = order.indexOf('probe')
    const cIdx = order.indexOf('compute:c')
    const dIdx = order.indexOf('compute:d')
    expect(cIdx).toBeLessThan(probeIdx)
    expect(probeIdx).toBeLessThan(dIdx)
  })

  // --- memo ---

  it('reads from memo on cacheKey hit — no compute', async () => {
    const memo = new Map([['rev1', new Map([['a.ts', 'MEMOIZED']])]])
    const compute = vi.fn((f: DiffFile) => f.filePath)
    const d = createDiffDerivation({
      compute,
      readMemo: (k) => memo.get(k),
    })
    d.run([mkFile('a.ts')], 'rev1')
    expect(d.byFile.get('a.ts')).toBe('MEMOIZED')
    expect(compute).not.toHaveBeenCalled()
  })

  it('ignores empty memo entries', async () => {
    const memo = new Map([['rev1', new Map<string, string>()]])
    const compute = vi.fn((f: DiffFile) => f.filePath)
    const d = createDiffDerivation({ compute, readMemo: (k) => memo.get(k) })
    d.run([mkFile('a.ts')], 'rev1')
    await settle()
    expect(compute).toHaveBeenCalled() // empty memo → cache miss → compute
    expect(d.byFile.get('a.ts')).toBe('a.ts')
  })

  it('writes to memo only on full completion', async () => {
    const written = new Map<string, Map<string, string>>()
    const d = createDiffDerivation({
      compute: (f) => f.filePath,
      writeMemo: (k, v) => written.set(k, v),
    })
    d.run([mkFile('a'), mkFile('b')], 'rev1')
    await settle()
    expect(written.get('rev1')?.get('a')).toBe('a')
    expect(written.get('rev1')?.get('b')).toBe('b')
  })

  it('does not write memo when aborted mid-run', async () => {
    const written = new Map<string, Map<string, string>>()
    const d = createDiffDerivation({
      compute: async (f) => f.filePath,
      writeMemo: (k, v) => written.set(k, v),
    })
    d.run([mkFile('a'), mkFile('b'), mkFile('c')], 'rev1')
    d.run([mkFile('x')]) // abort rev1 before it completes
    await settle()
    await settle()
    expect(written.has('rev1')).toBe(false)
  })

  // --- update ---

  it('update replaces one file entry, preserves others', async () => {
    const d = createDiffDerivation({ compute: (f) => `v1:${f.filePath}` })
    d.run([mkFile('a'), mkFile('b')])
    await settle()
    // Simulate context expansion: same path, new content, compute returns v2
    const d2 = createDiffDerivation({ compute: (f) => `v2:${f.filePath}` })
    // Can't change compute mid-stream in real usage, but the update path
    // should preserve b while replacing a.
    expect(d.byFile.get('b')).toBe('v1:b')
    d.update(mkFile('a'))
    expect(d.byFile.get('a')).toBe('v1:a') // same compute, same result
    expect(d.byFile.get('b')).toBe('v1:b') // preserved
    void d2 // silence unused
  })

  it('update aborts in-flight run', async () => {
    let resolveB: (v: string) => void = () => {}
    const d = createDiffDerivation({
      compute: (f) => f.filePath === 'b'
        ? new Promise<string>(r => { resolveB = r })
        : f.filePath,
    })
    d.run([mkFile('a'), mkFile('b'), mkFile('c')])
    await macrotask() // a done, b pending
    expect(d.byFile.get('a')).toBe('a')

    d.update(mkFile('a')) // should abort the pending run
    resolveB('b-late') // old run's b finishes — must be discarded
    await settle()
    expect(d.byFile.has('b')).toBe(false)
    expect(d.byFile.has('c')).toBe(false) // c never reached
  })

  it('update with skip=true deletes the entry', async () => {
    const d = createDiffDerivation({
      compute: (f) => f.filePath,
      skip: (f) => f.hunks[0].lines.length > 100,
    })
    d.run([mkFile('a', 10)])
    await settle()
    expect(d.byFile.has('a')).toBe(true)

    // Expansion pushes past threshold → should be removed
    d.update(mkFile('a', 200))
    expect(d.byFile.has('a')).toBe(false)
  })

  // --- tryRestore ---

  it('tryRestore returns true and sets byFile on memo hit', () => {
    const memo = new Map([['rev1', new Map([['a', 'CACHED']])]])
    const d = createDiffDerivation({
      compute: (f) => f.filePath,
      readMemo: (k) => memo.get(k),
    })
    expect(d.tryRestore('rev1')).toBe(true)
    expect(d.byFile.get('a')).toBe('CACHED')
  })

  it('tryRestore returns false on miss or empty memo', () => {
    const memo = new Map([['empty', new Map<string, string>()]])
    const d = createDiffDerivation({
      compute: (f) => f.filePath,
      readMemo: (k) => memo.get(k),
    })
    expect(d.tryRestore('missing')).toBe(false)
    expect(d.tryRestore('empty')).toBe(false)
    expect(d.byFile.size).toBe(0)
  })

  it('tryRestore aborts in-flight run', async () => {
    const memo = new Map([['rev2', new Map([['x', 'RESTORED']])]])
    let resolve: (v: string) => void = () => {}
    const d = createDiffDerivation({
      compute: () => new Promise<string>(r => { resolve = r }),
      readMemo: (k) => memo.get(k),
    })
    d.run([mkFile('a')]) // no cacheKey → no memo check, compute pending
    expect(d.tryRestore('rev2')).toBe(true)
    resolve('stale')
    await settle()
    expect(d.byFile.get('x')).toBe('RESTORED')
    expect(d.byFile.has('a')).toBe(false)
  })

  // --- clear ---

  it('clear aborts in-flight run and empties output', async () => {
    const d = createDiffDerivation({ compute: async (f) => f.filePath })
    d.run([mkFile('a'), mkFile('b')])
    d.clear()
    await settle()
    expect(d.byFile.size).toBe(0)
  })
})
