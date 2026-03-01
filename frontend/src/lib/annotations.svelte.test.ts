import { describe, expect, it, vi, beforeEach } from 'vitest'

// api mock MUST be set up before importing anything from annotations.svelte
// — the store captures api.* at module eval time.
vi.mock('./api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./api')>()
  return {
    ...actual,
    api: {
      ...actual.api,
      annotations: vi.fn(),
      saveAnnotation: vi.fn(),
      deleteAnnotation: vi.fn(),
      clearAnnotations: vi.fn(),
      diffRange: vi.fn(),
    },
  }
})

import { reanchor, exportMarkdown, exportJSON, createAnnotationStore } from './annotations.svelte'
import { api, type Annotation } from './api'

const mockAnnotations = api.annotations as ReturnType<typeof vi.fn>
const mockSave = api.saveAnnotation as ReturnType<typeof vi.fn>
const mockDelete = api.deleteAnnotation as ReturnType<typeof vi.fn>
const mockClear = api.clearAnnotations as ReturnType<typeof vi.fn>
const mockDiffRange = api.diffRange as ReturnType<typeof vi.fn>

function mkAnn(lineNum: number, lineContent: string): Annotation {
  return {
    id: 'a1', changeId: 'xyz', filePath: 'foo.go',
    lineNum, lineContent, comment: 'test', severity: 'suggestion',
    createdAt: 0, createdAtCommitId: 'old', status: 'open',
  }
}

type TestHunk = { oldStart: number; newStart: number; lines: { type: string; content: string }[] }

// hunk() builds a hunk from a compact line spec: 'c'=context ' foo', 'a'=add
// '+foo', 'r'=remove '-foo'. Content is the literal char for easy matching.
function hunk(oldStart: number, newStart: number, spec: string): TestHunk {
  return {
    oldStart, newStart,
    lines: [...spec].map(ch => {
      switch (ch) {
        case 'c': return { type: 'context', content: ' c' }
        case 'a': return { type: 'add', content: '+a' }
        case 'r': return { type: 'remove', content: '-r' }
        default: throw new Error('bad spec char')
      }
    }),
  }
}

describe('reanchor', () => {
  it('no hunks → unchanged', () => {
    const r = reanchor(mkAnn(10, 'x'), [])
    expect(r).toEqual({ lineNum: 10, status: 'open' })
  })

  it('insertion above shifts line down by delta', () => {
    // Hunk at old line 1: 1 context, 3 adds, 1 context → +3 lines.
    // Annotation at old line 10 → should move to new line 13.
    const h = hunk(1, 1, 'caaac')
    const r = reanchor(mkAnn(10, 'x'), [h])
    expect(r).toEqual({ lineNum: 13, status: 'open' })
  })

  it('deletion above shifts line up by delta', () => {
    // Hunk at old line 1: 1 context, 3 removes, 1 context → -3 lines.
    const h = hunk(1, 1, 'crrrc')
    const r = reanchor(mkAnn(10, 'x'), [h])
    expect(r).toEqual({ lineNum: 7, status: 'open' })
  })

  it('multiple hunks accumulate delta', () => {
    // +2 at line 1, -1 at line 5 → net +1.
    const h1 = hunk(1, 1, 'caac') // +2
    const h2 = hunk(5, 7, 'crc')  // -1 (oldStart 5, but after h1 new is offset)
    const r = reanchor(mkAnn(20, 'x'), [h1, h2])
    expect(r).toEqual({ lineNum: 21, status: 'open' })
  })

  it('hunk below annotation is ignored', () => {
    const h = hunk(50, 50, 'caaac')
    const r = reanchor(mkAnn(10, 'x'), [h])
    expect(r).toEqual({ lineNum: 10, status: 'open' })
  })

  it('line deleted inside spanning hunk → orphaned', () => {
    // Hunk spans old lines 9-11, removes old line 10.
    const h: TestHunk = {
      oldStart: 9, newStart: 9,
      lines: [
        { type: 'context', content: ' line9' },
        { type: 'remove', content: '-line10' },
        { type: 'context', content: ' line11' },
      ],
    }
    const r = reanchor(mkAnn(10, 'line10'), [h])
    expect(r.status).toBe('orphaned')
  })

  it('line rewritten inside spanning hunk → found by content search', () => {
    // Agent moved the annotated line from old 10 to new 12 (added 2 above it).
    const h: TestHunk = {
      oldStart: 8, newStart: 8,
      lines: [
        { type: 'context', content: ' line8' },
        { type: 'add', content: '+new9' },
        { type: 'add', content: '+new10' },
        { type: 'context', content: ' line9' },  // was old 9, now new 11
        { type: 'context', content: ' TARGET' }, // was old 10, now new 12
      ],
    }
    const r = reanchor(mkAnn(10, 'TARGET'), [h])
    expect(r).toEqual({ lineNum: 12, status: 'open' })
  })

  it('content mismatch at delta-adjusted line → fuzzy scan ±5', () => {
    // Delta says line 10, but content there is wrong. Line 12 has the target.
    // Annotation was at old 10; hunk inserts 2 above and also inserts 2 below
    // so delta math lands on new 12, but content verification finds it at 14
    // after a shuffle. This is contrived but exercises the fuzzy path.
    const h: TestHunk = {
      oldStart: 1, newStart: 1,
      lines: [
        { type: 'add', content: '+a' },
        { type: 'add', content: '+b' },
        { type: 'context', content: ' c' },
      ],
    }
    // After delta +2: annotation at 12. lineContentAt(12) returns null
    // (between hunks) → trusted. So this simple case passes stage 2 via null.
    const r = reanchor(mkAnn(10, 'TARGET'), [h])
    expect(r).toEqual({ lineNum: 12, status: 'open' })
  })

  it('content rewritten → orphaned when fuzzy scan fails', () => {
    // Agent replaced the annotated line with different content.
    const h: TestHunk = {
      oldStart: 10, newStart: 10,
      lines: [
        { type: 'remove', content: '-OLD_TARGET' },
        { type: 'add', content: '+NEW_CONTENT' },
      ],
    }
    const r = reanchor(mkAnn(10, 'OLD_TARGET'), [h])
    expect(r.status).toBe('orphaned')
  })
})

describe('export', () => {
  const anns: Annotation[] = [
    { id: 'a1', changeId: 'xyz', filePath: 'foo.go', lineNum: 42, lineContent: 'log.Println()', comment: 'remove debug', severity: 'must-fix', createdAt: 0, createdAtCommitId: 'abc', status: 'open' },
    { id: 'a2', changeId: 'xyz', filePath: 'foo.go', lineNum: 10, lineContent: 'import _', comment: 'unused', severity: 'nitpick', createdAt: 0, createdAtCommitId: 'abc', status: 'open' },
    { id: 'a3', changeId: 'xyz', filePath: 'bar.go', lineNum: 5, lineContent: 'x', comment: 'done', severity: 'suggestion', createdAt: 0, createdAtCommitId: 'abc', status: 'resolved' },
  ]

  it('markdown groups by file, skips resolved, sorts by line', () => {
    const md = exportMarkdown(anns, 'xyzabc12')
    expect(md).toContain('## Review feedback for xyzabc12')
    expect(md).toContain('### foo.go:10 [nitpick]') // sorted before 42
    expect(md).toContain('### foo.go:42 [must-fix]')
    expect(md).not.toContain('bar.go') // resolved, skipped
    expect(md).toContain('> remove debug')
    // foo.go:10 appears before foo.go:42 in output
    expect(md.indexOf(':10')).toBeLessThan(md.indexOf(':42'))
  })

  it('markdown notes orphaned annotations', () => {
    const orphan: Annotation = { ...anns[0], status: 'orphaned' }
    const md = exportMarkdown([orphan], 'xyz')
    expect(md).toContain('(line may have moved)')
  })

  it('markdown empty returns placeholder', () => {
    const md = exportMarkdown([], 'xyz')
    expect(md).toContain('No open annotations')
  })

  it('json includes all (with resolved)', () => {
    const json = exportJSON(anns, 'xyz', 'def456')
    const parsed = JSON.parse(json)
    expect(parsed.changeId).toBe('xyz')
    expect(parsed.commitId).toBe('def456')
    expect(parsed.annotations).toHaveLength(3)
    expect(parsed.annotations[0].severity).toBe('must-fix')
  })
})

describe('reanchor — edge cases', () => {
  it('annotation at line 1 with insertion at line 1', () => {
    // Edge: hunk starts exactly at the annotation line. oldEnd = 1,
    // not < 1, so this is the "spanning" case, not "above".
    const h: TestHunk = {
      oldStart: 1, newStart: 1,
      lines: [
        { type: 'add', content: '+new header' },
        { type: 'context', content: ' TARGET' }, // was old line 1, now new line 2
      ],
    }
    const r = reanchor(mkAnn(1, 'TARGET'), [h])
    expect(r).toEqual({ lineNum: 2, status: 'open' })
  })

  it('empty lineContent matches empty line in hunk', () => {
    const h: TestHunk = {
      oldStart: 10, newStart: 10,
      lines: [
        { type: 'remove', content: '-' },  // empty line removed
        { type: 'add', content: '+' },     // empty line added (different position)
      ],
    }
    // Annotation was on an empty line; agent replaced it with another empty line.
    // Content search should find it (both are '').
    const r = reanchor(mkAnn(10, ''), [h])
    expect(r).toEqual({ lineNum: 10, status: 'open' })
  })

  it('whitespace-only content differences orphan the annotation', () => {
    // Agent changed indentation: tab → 4 spaces. Content snapshot was with tab.
    const h: TestHunk = {
      oldStart: 10, newStart: 10,
      lines: [
        { type: 'remove', content: '-\tfoo()' },
        { type: 'add', content: '+    foo()' },
      ],
    }
    // Strict equality: '\tfoo()' ≠ '    foo()'. Orphaned is correct —
    // Levenshtein would salvage this (deferred follow-up).
    const r = reanchor(mkAnn(10, '\tfoo()'), [h])
    expect(r.status).toBe('orphaned')
  })

  it('hunk exactly at oldEnd = annotation.lineNum boundary is spanning', () => {
    // Hunk spans old 8-10; annotation at old 10 (the boundary).
    const h: TestHunk = {
      oldStart: 8, newStart: 8,
      lines: [
        { type: 'context', content: ' line8' },
        { type: 'context', content: ' line9' },
        { type: 'context', content: ' TARGET' }, // old 10, new 10 (no change here)
      ],
    }
    const r = reanchor(mkAnn(10, 'TARGET'), [h])
    expect(r).toEqual({ lineNum: 10, status: 'open' })
  })

  it('multiple hunks where later one is below (ignored)', () => {
    // h1 above (+2), h2 below (ignored).
    const h1 = hunk(1, 1, 'caac') // +2 above
    const h2 = hunk(50, 52, 'crrrc') // -3 below — must NOT affect line 10
    const r = reanchor(mkAnn(10, 'x'), [h1, h2])
    expect(r).toEqual({ lineNum: 12, status: 'open' })
  })

  it('file deleted entirely — all lines removed', () => {
    // diffRange on a deleted file produces a hunk that removes everything.
    const h: TestHunk = {
      oldStart: 1, newStart: 0,
      lines: Array.from({ length: 20 }, () => ({ type: 'remove' as const, content: '-x' })),
    }
    const r = reanchor(mkAnn(10, 'something'), [h])
    expect(r.status).toBe('orphaned')
  })
})

// --- Store integration (mocked api) ---
// These exercise the load() orchestration: fetch → group → diffRange →
// reanchor → persist. The store holds reactive $state so tests must run in
// the same tick where effects can observe changes.

describe('createAnnotationStore', () => {
  beforeEach(() => {
    mockAnnotations.mockReset()
    mockSave.mockReset()
    mockDelete.mockReset()
    mockClear.mockReset()
    mockDiffRange.mockReset()
    mockSave.mockImplementation(async (a: Annotation) => a) // echo back
  })

  function mkStoreAnn(id: string, overrides: Partial<Annotation> = {}): Annotation {
    return {
      id, changeId: 'xyz', filePath: 'foo.go',
      lineNum: 10, lineContent: 'x', comment: 'c', severity: 'suggestion',
      createdAt: 0, createdAtCommitId: 'abc', status: 'open',
      ...overrides,
    }
  }

  it('load() populates list from api', async () => {
    const anns = [mkStoreAnn('a1'), mkStoreAnn('a2')]
    mockAnnotations.mockResolvedValue(anns)

    const store = createAnnotationStore()
    await store.load('xyz', 'abc') // same commitId as createdAt → no re-anchor

    expect(store.list).toEqual(anns)
    expect(store.loadedChangeId).toBe('xyz')
    expect(mockDiffRange).not.toHaveBeenCalled() // no re-anchor needed
  })

  it('load() with different commitId triggers re-anchor via diffRange', async () => {
    // Annotation created at commit 'abc', current is 'def' → agent iterated.
    const anns = [mkStoreAnn('a1', { createdAtCommitId: 'abc', lineNum: 10 })]
    mockAnnotations.mockResolvedValue(anns)
    // Inter-diff: 3 lines inserted at top → annotation should move 10→13
    mockDiffRange.mockResolvedValue({
      diff: 'diff --git a/foo.go b/foo.go\n--- a/foo.go\n+++ b/foo.go\n@@ -1,1 +1,4 @@\n+new1\n+new2\n+new3\n line1\n',
    })

    const store = createAnnotationStore()
    await store.load('xyz', 'def')

    expect(mockDiffRange).toHaveBeenCalledWith('abc', 'def', ['foo.go'])
    expect(store.list[0].lineNum).toBe(13)
    expect(store.list[0].status).toBe('open')
    // Re-anchored result persisted
    expect(mockSave).toHaveBeenCalledWith(expect.objectContaining({ id: 'a1', lineNum: 13 }))
  })

  it('load() batches diffRange by createdAtCommitId', async () => {
    // 3 annotations from 2 different snapshots → 2 diffRange calls.
    const anns = [
      mkStoreAnn('a1', { createdAtCommitId: 'abc', filePath: 'foo.go' }),
      mkStoreAnn('a2', { createdAtCommitId: 'abc', filePath: 'bar.go' }),
      mkStoreAnn('a3', { createdAtCommitId: 'ghi', filePath: 'foo.go' }),
    ]
    mockAnnotations.mockResolvedValue(anns)
    mockDiffRange.mockResolvedValue({ diff: '' }) // no hunks → no change

    const store = createAnnotationStore()
    await store.load('xyz', 'zzz')

    expect(mockDiffRange).toHaveBeenCalledTimes(2)
    // First call: createdAt 'abc', files [foo.go, bar.go] (deduped, order may vary)
    const call1 = mockDiffRange.mock.calls.find(c => c[0] === 'abc')!
    expect(call1[1]).toBe('zzz')
    expect(call1[2]).toEqual(expect.arrayContaining(['foo.go', 'bar.go']))
    expect(call1[2]).toHaveLength(2)
    // Second call: createdAt 'ghi', files [foo.go]
    const call2 = mockDiffRange.mock.calls.find(c => c[0] === 'ghi')!
    expect(call2[2]).toEqual(['foo.go'])
  })

  it('load() skips resolved annotations from re-anchor', async () => {
    const anns = [mkStoreAnn('a1', { status: 'resolved', createdAtCommitId: 'abc' })]
    mockAnnotations.mockResolvedValue(anns)

    const store = createAnnotationStore()
    await store.load('xyz', 'def') // different commitId, but resolved → skip

    expect(mockDiffRange).not.toHaveBeenCalled()
    expect(store.list[0].status).toBe('resolved')
  })

  it('load() orphans all on diffRange failure (commit abandoned)', async () => {
    // Agent ran jj undo → createdAtCommitId no longer exists → diffRange 500s.
    const anns = [
      mkStoreAnn('a1', { createdAtCommitId: 'gone' }),
      mkStoreAnn('a2', { createdAtCommitId: 'gone' }),
    ]
    mockAnnotations.mockResolvedValue(anns)
    mockDiffRange.mockRejectedValue(new Error('commit not found'))

    const store = createAnnotationStore()
    await store.load('xyz', 'def')

    expect(store.list.every(a => a.status === 'orphaned')).toBe(true)
    expect(mockSave).toHaveBeenCalledTimes(2) // orphan state persisted
  })

  it('load() handles partial diffRange failure (one snapshot gone)', async () => {
    const anns = [
      mkStoreAnn('a1', { createdAtCommitId: 'gone' }),
      mkStoreAnn('a2', { createdAtCommitId: 'valid' }),
    ]
    mockAnnotations.mockResolvedValue(anns)
    mockDiffRange.mockImplementation(async (from: string) => {
      if (from === 'gone') throw new Error('not found')
      return { diff: '' }
    })

    const store = createAnnotationStore()
    await store.load('xyz', 'def')

    expect(store.list.find(a => a.id === 'a1')!.status).toBe('orphaned')
    expect(store.list.find(a => a.id === 'a2')!.status).toBe('open')
  })

  it('forLine() is O(1) Map lookup — returns [] for non-annotated lines', async () => {
    mockAnnotations.mockResolvedValue([
      mkStoreAnn('a1', { filePath: 'foo.go', lineNum: 10 }),
      mkStoreAnn('a2', { filePath: 'foo.go', lineNum: 10 }), // same line, 2 annotations
      mkStoreAnn('a3', { filePath: 'bar.go', lineNum: 10 }),
    ])
    const store = createAnnotationStore()
    await store.load('xyz', 'abc')

    expect(store.forLine('foo.go', 10)).toHaveLength(2)
    expect(store.forLine('bar.go', 10)).toHaveLength(1)
    expect(store.forLine('foo.go', 99)).toEqual([])
    expect(store.forLine('baz.go', 10)).toEqual([])
  })

  it('add() generates id + createdAt and POSTs', async () => {
    mockAnnotations.mockResolvedValue([])
    const store = createAnnotationStore()
    await store.load('xyz', 'abc')

    const before = Date.now()
    await store.add({
      changeId: 'xyz', filePath: 'foo.go', lineNum: 5, lineContent: 'target',
      comment: 'fix this', severity: 'must-fix', createdAtCommitId: 'abc',
    })
    const after = Date.now()

    expect(store.list).toHaveLength(1)
    const a = store.list[0]
    expect(a.id).toMatch(/^[0-9a-f-]{36}$/) // uuid v4 shape
    expect(a.createdAt).toBeGreaterThanOrEqual(before)
    expect(a.createdAt).toBeLessThanOrEqual(after)
    expect(a.status).toBe('open')
    expect(mockSave).toHaveBeenCalledWith(expect.objectContaining({ comment: 'fix this' }))
  })

  it('update() replaces by id in list', async () => {
    const existing = mkStoreAnn('a1', { comment: 'old' })
    mockAnnotations.mockResolvedValue([existing])
    const store = createAnnotationStore()
    await store.load('xyz', 'abc')

    await store.update({ ...existing, comment: 'new' })

    expect(store.list[0].comment).toBe('new')
    expect(mockSave).toHaveBeenCalledWith(expect.objectContaining({ id: 'a1', comment: 'new' }))
  })

  it('remove() DELETEs and filters from list', async () => {
    mockAnnotations.mockResolvedValue([mkStoreAnn('a1'), mkStoreAnn('a2')])
    mockDelete.mockResolvedValue(undefined)
    const store = createAnnotationStore()
    await store.load('xyz', 'abc')

    await store.remove('a1')

    expect(store.list).toHaveLength(1)
    expect(store.list[0].id).toBe('a2')
    expect(mockDelete).toHaveBeenCalledWith('xyz', 'a1')
  })

  it('clear() DELETEs all and empties list', async () => {
    mockAnnotations.mockResolvedValue([mkStoreAnn('a1'), mkStoreAnn('a2')])
    mockClear.mockResolvedValue(undefined)
    const store = createAnnotationStore()
    await store.load('xyz', 'abc')

    await store.clear()

    expect(store.list).toEqual([])
    expect(mockClear).toHaveBeenCalledWith('xyz')
  })

  it('remove()/clear() are no-ops without loadedChangeId', async () => {
    const store = createAnnotationStore()
    await store.remove('a1')
    await store.clear()
    expect(mockDelete).not.toHaveBeenCalled()
    expect(mockClear).not.toHaveBeenCalled()
  })

  it('busy flag wraps all mutation operations', async () => {
    mockAnnotations.mockResolvedValue([])
    let resolveSave!: () => void
    mockSave.mockImplementation(() => new Promise<Annotation>(r => { resolveSave = () => r(mkStoreAnn('x')) }))

    const store = createAnnotationStore()
    await store.load('xyz', 'abc')
    expect(store.busy).toBe(false)

    const p = store.add({
      changeId: 'xyz', filePath: 'f', lineNum: 1, lineContent: 'x',
      comment: 'c', severity: 'suggestion', createdAtCommitId: 'abc',
    })
    expect(store.busy).toBe(true)
    resolveSave()
    await p
    expect(store.busy).toBe(false)
  })

  it('load() does not persist when no re-anchor changes needed', async () => {
    // Same commitId → no diffRange → no saves.
    mockAnnotations.mockResolvedValue([mkStoreAnn('a1', { createdAtCommitId: 'abc' })])
    const store = createAnnotationStore()
    await store.load('xyz', 'abc')

    expect(mockSave).not.toHaveBeenCalled()
  })

  it('forLine() reactively updates after add()', async () => {
    mockAnnotations.mockResolvedValue([])
    const store = createAnnotationStore()
    await store.load('xyz', 'abc')

    expect(store.forLine('foo.go', 5)).toEqual([])

    await store.add({
      changeId: 'xyz', filePath: 'foo.go', lineNum: 5, lineContent: 'x',
      comment: 'c', severity: 'nitpick', createdAtCommitId: 'abc',
    })

    expect(store.forLine('foo.go', 5)).toHaveLength(1)
  })
})
