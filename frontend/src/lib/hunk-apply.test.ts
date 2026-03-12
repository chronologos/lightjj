import { describe, it, expect } from 'vitest'
import {
  applyHunks, hunkKey, fileSelectionState, normalizeFileType,
  planHunkSpec, resolvePlan, type FileType, type SelectionState,
} from './hunk-apply'
import { parseDiffContent, type DiffFile, type DiffHunk } from './diff-parser'

// ─── builders ────────────────────────────────────────────────────────────────

function h(oldStart: number, newStart: number, body: string): DiffHunk {
  const lines = body.split('\n').map(content => ({
    type: content.startsWith('+') ? 'add' as const
        : content.startsWith('-') ? 'remove' as const
        : 'context' as const,
    content,
  }))
  const newCount = lines.filter(l => l.type !== 'remove' && !l.content.startsWith('\\')).length
  return { header: `@@ -${oldStart} +${newStart},${newCount} @@`, oldStart, newStart, newCount, lines }
}

function df(filePath: string, hunks: DiffHunk[]): DiffFile {
  return { header: `diff --git a/${filePath} b/${filePath}`, filePath, hunks }
}

function sel(...keys: string[]): Set<string> {
  return new Set(keys)
}

// ─── applyHunks: round-trip invariants ───────────────────────────────────────
// These are the load-bearing tests. Same spirit as merge-surgery's round-trip:
// if synthesis is off by one byte anywhere, one of these catches it before the
// Go tool writes garbage to $right.

describe('applyHunks — round-trip invariants', () => {
  // Fixture: 5-line file, two well-separated changes → parser emits 2 hunks.
  // The changes land on lines 2 and 4; with default context=3 jj would merge
  // them into one hunk, so we use context=0 headers to keep them separate —
  // that's the actual shape `jj diff --context 0` produces and is what
  // per-hunk selection operates on.
  const LEFT = 'a\nb\nc\nd\ne\n'
  const RIGHT = 'a\nBB\nc\nDD\ne\n'
  const H0 = h(2, 2, '-b\n+BB') // b → BB
  const H1 = h(4, 4, '-d\n+DD') // d → DD

  it('applyHunks(left, allHunks) === right', () => {
    expect(applyHunks(LEFT, [H0, H1])).toBe(RIGHT)
  })

  it('applyHunks(left, []) === left', () => {
    expect(applyHunks(LEFT, [])).toBe(LEFT)
  })

  it('applyHunks(left, [h0]) — only first change applied', () => {
    expect(applyHunks(LEFT, [H0])).toBe('a\nBB\nc\nd\ne\n')
  })

  it('applyHunks(left, [h1]) — only second change applied', () => {
    // Skipping h0 means the gap-copy loop runs from pos=0 to oldStart-1=3,
    // copying a,b,c verbatim. This is the case where a REJECTED earlier hunk
    // must not shift offsets for a later accepted one — oldStart is absolute
    // into LEFT, not relative to prior hunks.
    expect(applyHunks(LEFT, [H1])).toBe('a\nb\nc\nDD\ne\n')
  })

  it('chained partial application reaches right', () => {
    // applyHunks(applyHunks(left, [h0]), [h1']) === right
    // where h1' has oldStart adjusted for the intermediate doc.
    // Here h0 is a 1:1 line swap so h1' === h1 (no shift). The point is to
    // verify the intermediate is a valid left for the next apply — no
    // corruption that only manifests on second pass.
    const mid = applyHunks(LEFT, [H0])
    expect(applyHunks(mid, [H1])).toBe(RIGHT)
  })
})

describe('applyHunks — trailing newline', () => {
  it('preserves trailing newline when present', () => {
    expect(applyHunks('a\nb\n', [h(2, 2, '-b\n+B')])).toBe('a\nB\n')
  })

  it('preserves ABSENCE of trailing newline', () => {
    // "a\nb".split('\n') → ['a','b'] (no trailing ''). Tail-copy loop emits
    // nothing after the hunk consumes pos=1. join adds no trailing \n.
    expect(applyHunks('a\nb', [h(2, 2, '-b\n+B')])).toBe('a\nB')
  })

  it('KNOWN LIMITATION: hunk changes EOF-newline-ness → left\'s state wins', () => {
    // Diff says: old file ended `b` (no \n), new ends `B\n`. The `\ No newline`
    // marker after `-b` encodes this. We skip the marker → result inherits
    // left's no-trailing-\n. This is a 1-byte loss. Pinned so it doesn't
    // silently regress into emitting a literal `\ No newline...` line (which
    // WOULD happen if the skip were removed — see next test).
    const hunk = h(2, 2, '-b\n\\ No newline at end of file\n+B')
    expect(applyHunks('a\nb', [hunk])).toBe('a\nB') // not 'a\nB\n'
  })

  it('skips `\\ No newline` marker — does NOT emit it as content', () => {
    // Without the startsWith('\\') guard, the marker (typed as context by
    // diff-parser) would be emitted verbatim. Guard makes it invisible.
    const hunk = h(2, 2, '-b\n+B\n\\ No newline at end of file')
    expect(applyHunks('a\nb\n', [hunk])).not.toContain('No newline')
  })
})

describe('applyHunks — hunk shapes', () => {
  it('pure addition (no removes) — insert at position', () => {
    // @@ -2,0 +3,2 @@ — oldStart=3 means "after line 2" (git's 0-count quirk:
    // the hunk consumes zero old lines starting AT line 3, i.e. between 2 and 3).
    // Actually git uses oldStart=2 for "insert after line 2" when count=0.
    // Our algorithm: gap-copy until pos < oldStart-1, then hunk consumes
    // nothing (no removes/context), then tail-copy. So oldStart=3 with no
    // removes inserts AFTER line 2 (pos stops at 2, adds emit, tail resumes
    // from 2).
    const hunk = h(3, 3, '+X\n+Y')
    expect(applyHunks('a\nb\nc\n', [hunk])).toBe('a\nb\nX\nY\nc\n')
  })

  it('pure deletion (no adds)', () => {
    const hunk = h(2, 2, '-b\n-c')
    expect(applyHunks('a\nb\nc\nd\n', [hunk])).toBe('a\nd\n')
  })

  it('hunk at start-of-file (oldStart=1, no gap-copy)', () => {
    expect(applyHunks('a\nb\n', [h(1, 1, '-a\n+A')])).toBe('A\nb\n')
  })

  it('hunk at end-of-file (tail-copy emits nothing after)', () => {
    // Last real line is pos=2 ('c'); trailing '' is pos=3. Hunk consumes 'c',
    // tail-copy picks up the trailing '' → join adds the \n back.
    expect(applyHunks('a\nb\nc\n', [h(3, 3, '-c\n+C')])).toBe('a\nb\nC\n')
  })

  it('context lines — uses left[] not line.content (source-of-truth choice)', () => {
    // Context line content SHOULD match left[pos] exactly — but if a caller
    // passes a malformed hunk where they diverge, we trust left[]. This is
    // the "structurally obvious round-trip" choice from the impl comment.
    const hunk: DiffHunk = {
      header: '@@', oldStart: 1, newStart: 1, newCount: 3,
      lines: [
        { type: 'context', content: ' WRONG' }, // left[0] is 'a'
        { type: 'remove', content: '-b' },
        { type: 'add', content: '+B' },
        { type: 'context', content: ' ALSO WRONG' }, // left[2] is 'c'
      ],
    }
    expect(applyHunks('a\nb\nc\n', [hunk])).toBe('a\nB\nc\n')
  })

  it('adjacent hunks — gap-copy loop is a no-op between them', () => {
    // h0 consumes line 1, h1 starts at line 2. pos after h0 is 1;
    // h1.oldStart-1 is 1; while (1 < 1) doesn't run. Correct.
    const h0 = h(1, 1, '-a\n+A')
    const h1 = h(2, 2, '-b\n+B')
    expect(applyHunks('a\nb\nc\n', [h0, h1])).toBe('A\nB\nc\n')
  })

  it('unsorted input throws — silent corruption otherwise', () => {
    // Without the assert: h1-then-h0 gap-copies lines [0..3) for h1 (correct),
    // consumes line 3 for the `-d`, then h0's gap-copy `while (4 < 1)` never
    // runs, `-b` consumes line 4 (wrong — that's 'e'), `+BB` emits. Out:
    // 'a\nb\nc\nDD\nBB\n' — 'b' survived, 'e' gone, BB misplaced. No error.
    expect(() => applyHunks('a\nb\nc\nd\ne\n', [
      h(4, 4, '-d\n+DD'), h(2, 2, '-b\n+BB'),
    ])).toThrow(/unsorted/)
  })

  it('unequal line counts — add > remove (net growth)', () => {
    // 1 remove, 3 adds. oldStart for next hunk would be +1 in left-coords
    // regardless of growth — oldStart is ALWAYS left-relative.
    const hunk = h(2, 2, '-b\n+X\n+Y\n+Z')
    expect(applyHunks('a\nb\nc\n', [hunk])).toBe('a\nX\nY\nZ\nc\n')
  })

  it('empty left + pure-add hunk = new file synthesis (the A+some case)', () => {
    // This is how planHunkSpec handles partially-accepted additions:
    // leftIsEmpty=true → applyHunks('', accepted). oldStart=1 means gap-copy
    // runs while (0 < 0) — no-op. All adds emit. Tail-copy: ''.split('\n')
    // is [''], pos is still 0, so tail emits [''] → trailing \n. Hmm.
    expect(applyHunks('', [h(1, 1, '+a\n+b')])).toBe('a\nb\n')
    // Wait — ''.split('\n') = ['']. After adds, pos=0 still. Tail: push '',
    // pos=1. out = ['a','b',''], join = 'a\nb\n'. That's a new file WITH
    // trailing newline. If the real new file has no trailing \n, the last
    // hunk line would be `+b` followed by `\ No newline...` — which we skip.
    // So this is CORRECT for the with-\n case, and the KNOWN LIMITATION
    // covers the without-\n case.
  })
})

// ─── Pipeline: real jj diff → parse → applyHunks round-trip ──────────────────
// Proves the full stack (parser → applyHunks) agrees with what jj would
// materialize in $left/$right. These are the fixtures most likely to catch
// integration drift if jj's diff format shifts.

describe('applyHunks — pipeline via parseDiffContent', () => {
  // Captured from `jj diff --tool :git` on the probe repo. Multi-hunk with
  // context, the shape real review-mode will see.
  const DIFF = `diff --git a/f.txt b/f.txt
index abc..def 100644
--- a/f.txt
+++ b/f.txt
@@ -1,3 +1,3 @@
 a
-b
+BB
 c
@@ -5,3 +5,3 @@
 e
-f
+FF
 g
`
  const LEFT = 'a\nb\nc\nd\ne\nf\ng\n'
  const RIGHT = 'a\nBB\nc\nd\ne\nFF\ng\n'

  it('parser emits 2 hunks; all-apply reaches right', () => {
    const [file] = parseDiffContent(DIFF)
    expect(file.hunks).toHaveLength(2)
    expect(applyHunks(LEFT, file.hunks)).toBe(RIGHT)
  })

  it('reject hunk 1 (FF) → middle change only', () => {
    const [file] = parseDiffContent(DIFF)
    expect(applyHunks(LEFT, [file.hunks[0]])).toBe('a\nBB\nc\nd\ne\nf\ng\n')
  })

  it('reject hunk 0 (BB) → late change only, early region untouched', () => {
    const [file] = parseDiffContent(DIFF)
    // The load-bearing assertion: rejecting an EARLY hunk doesn't corrupt
    // a LATE hunk's oldStart alignment. file.hunks[1].oldStart is 5
    // regardless of whether hunks[0] was applied — it's left-absolute.
    expect(applyHunks(LEFT, [file.hunks[1]])).toBe('a\nb\nc\nd\ne\nFF\ng\n')
  })
})

// ─── fileSelectionState ──────────────────────────────────────────────────────

describe('fileSelectionState', () => {
  const file = df('x.ts', [h(1, 1, '+a'), h(5, 5, '+b'), h(9, 9, '+c')])

  it('empty set → none', () => {
    expect(fileSelectionState(file, sel())).toBe('none')
  })

  it('all keys → all', () => {
    expect(fileSelectionState(file, sel('x.ts#0', 'x.ts#1', 'x.ts#2'))).toBe('all')
  })

  it('subset → some', () => {
    expect(fileSelectionState(file, sel('x.ts#0', 'x.ts#2'))).toBe('some')
  })

  it('zero hunks → all (binary/rename/chmod — atomic, no granularity)', () => {
    // This is why the UI can offer file-level toggle for binaries without
    // a separate code path: toggling flips 'all'↔(nothing selected = still
    // 'all' because 0/0). Wait — that's wrong. With 0 hunks, the selected
    // set can't contain any keys for this file, so n is always 0, and we
    // return 'all' unconditionally via the early-return. File-level toggle
    // for binaries needs a SEPARATE mechanism (an explicit per-path
    // 'reject-whole-file' set). Noted for the UI layer; this function is
    // correct for its contract.
    expect(fileSelectionState(df('bin', []), sel())).toBe('all')
    expect(fileSelectionState(df('bin', []), sel('bin#0'))).toBe('all') // key ignored
  })

  it('ignores keys for OTHER files', () => {
    expect(fileSelectionState(file, sel('y.ts#0', 'y.ts#1', 'y.ts#2'))).toBe('none')
  })
})

// ─── hunkKey ─────────────────────────────────────────────────────────────────

describe('hunkKey', () => {
  it('path#idx — survives paths with colons (Windows drives, URLs)', () => {
    expect(hunkKey('C:/Users/x.ts', 3)).toBe('C:/Users/x.ts#3')
  })

  it('distinct indices → distinct keys', () => {
    expect(hunkKey('a', 0)).not.toBe(hunkKey('a', 1))
  })
})

// ─── normalizeFileType ───────────────────────────────────────────────────────

describe('normalizeFileType', () => {
  it.each([
    ['A', 'A'], ['D', 'D'], ['M', 'M'],
    ['R', 'M'], ['C', 'M'], ['?', 'M'], ['', 'M'],
  ])('%s → %s', (raw, want) => {
    expect(normalizeFileType(raw)).toBe(want)
  })
})

// ─── planHunkSpec: decision table ────────────────────────────────────────────
// This table IS the spec. Every (fileType × state) cell. If a new file type
// or state appears, this table forces a decision.

describe('planHunkSpec — decision table', () => {
  type Row = {
    ft: FileType
    // Which hunks of a 2-hunk file to select. Controls state indirectly —
    // we don't pass state, planHunkSpec derives it.
    pick: number[]
    wantResolved?: 'revert' | 'delete'
    wantPartial?: { leftIsEmpty: boolean; acceptedCount: number }
    wantOmit?: true
  }

  const TWO = df('f', [h(1, 1, '+a'), h(5, 5, '+b')])
  const tf = (ft: FileType) => (_: string) => ft

  const table: Row[] = [
    // ── M (modified — both trees have the file) ────────────────────────────
    { ft: 'M', pick: [0, 1], wantOmit: true },
    { ft: 'M', pick: [],     wantResolved: 'revert' },
    { ft: 'M', pick: [0],    wantPartial: { leftIsEmpty: false, acceptedCount: 1 } },

    // ── A (added — $left lacks it) ─────────────────────────────────────────
    { ft: 'A', pick: [0, 1], wantOmit: true },
    { ft: 'A', pick: [],     wantResolved: 'delete' },
    { ft: 'A', pick: [1],    wantPartial: { leftIsEmpty: true,  acceptedCount: 1 } },

    // ── D (deleted — $right lacks it). 'some' unreachable: deletions are
    //    single-hunk. Using a 2-hunk file here is artificial but proves
    //    planHunkSpec doesn't special-case D for 'some' (it'd produce a
    //    partial with leftIsEmpty=false, which is harmless-wrong — the
    //    Go tool would write synthesized content to a path jj will delete
    //    anyway). Real D-files never hit this row.
    { ft: 'D', pick: [0, 1], wantOmit: true },
    { ft: 'D', pick: [],     wantResolved: 'revert' },
  ]

  for (const row of table) {
    const state: SelectionState = row.pick.length === 0 ? 'none'
                                : row.pick.length === 2 ? 'all' : 'some'
    it(`${row.ft} × ${state}`, () => {
      const selected = sel(...row.pick.map(i => hunkKey('f', i)))
      const plan = planHunkSpec([TWO], selected, tf(row.ft))

      if (row.wantOmit) {
        expect(plan.resolved).toEqual([])
        expect(plan.partials).toEqual([])
      } else if (row.wantResolved) {
        expect(plan.resolved).toEqual([{ path: 'f', action: row.wantResolved }])
        expect(plan.partials).toEqual([])
      } else if (row.wantPartial) {
        expect(plan.resolved).toEqual([])
        expect(plan.partials).toHaveLength(1)
        expect(plan.partials[0].path).toBe('f')
        expect(plan.partials[0].leftIsEmpty).toBe(row.wantPartial.leftIsEmpty)
        expect(plan.partials[0].accepted).toHaveLength(row.wantPartial.acceptedCount)
      }
    })
  }

  it('multiple files — independent decisions, order preserved', () => {
    const files = [
      df('keep.ts', [h(1, 1, '+a')]),     // all → omit
      df('drop.ts', [h(1, 1, '+a')]),     // none → revert
      df('part.ts', [h(1, 1, '+a'), h(5, 5, '+b')]), // some → partial
    ]
    const plan = planHunkSpec(files, sel('keep.ts#0', 'part.ts#0'), () => 'M')
    expect(plan.resolved).toEqual([{ path: 'drop.ts', action: 'revert' }])
    expect(plan.partials.map(p => p.path)).toEqual(['part.ts'])
  })

  it('zero-hunk file (binary) → always omitted (state is always all)', () => {
    const plan = planHunkSpec([df('bin', [])], sel(), () => 'M')
    expect(plan.resolved).toEqual([])
    expect(plan.partials).toEqual([])
    // UI layer handles binary-file rejection separately; planHunkSpec
    // correctly reports "nothing to do" for a file with no hunks.
  })
})

// ─── resolvePlan ─────────────────────────────────────────────────────────────

describe('resolvePlan', () => {
  it('resolved actions pass through; partials get applyHunks', () => {
    const plan = {
      resolved: [{ path: 'r', action: 'revert' as const }],
      partials: [{
        path: 'p', leftIsEmpty: false,
        accepted: [h(2, 2, '-b\n+B')],
      }],
    }
    const spec = resolvePlan(plan, new Map([['p', 'a\nb\nc\n']]))
    expect(spec.files).toEqual([
      { path: 'r', action: 'revert' },
      { path: 'p', action: 'write', content: 'a\nB\nc\n' },
    ])
  })

  it('leftIsEmpty=true → applyHunks against empty string (added-file partial)', () => {
    const plan = {
      resolved: [],
      partials: [{ path: 'new', leftIsEmpty: true, accepted: [h(1, 1, '+a\n+b')] }],
    }
    // Map intentionally lacks 'new' — leftIsEmpty bypasses the lookup.
    const spec = resolvePlan(plan, new Map())
    expect(spec.files[0]).toEqual({ path: 'new', action: 'write', content: 'a\nb\n' })
  })

  it('missing left content for non-empty partial → empty-string fallback', () => {
    // Defensive: if the api.fileShow fails or the map is incomplete, we get
    // '' instead of undefined → applyHunks doesn't crash. Result is wrong
    // (adds-only output) but the Go tool writes SOMETHING, jj commits it,
    // user sees the wrong diff immediately and can undo. Better than a
    // frontend crash mid-execute.
    const plan = {
      resolved: [],
      partials: [{ path: 'p', leftIsEmpty: false, accepted: [h(1, 1, '-a\n+A')] }],
    }
    const spec = resolvePlan(plan, new Map())
    expect(spec.files[0].action).toBe('write')
    // Not asserting content — it's wrong-by-design here, just non-crashing.
  })
})

// ─── Generative sweep — invariants hold across shape combinations ────────────
// Same pattern as divergence.test.ts's genGroup sweep. Deterministic file/hunk
// IDs so failures are reproducible; every (fileCount × hunkCount × pickMask)
// combination × 3 invariants.

describe('planHunkSpec — invariant sweep', () => {
  function genFiles(fileCount: number, hunksPerFile: number): DiffFile[] {
    return Array.from({ length: fileCount }, (_, fi) =>
      df(`f${fi}`, Array.from({ length: hunksPerFile }, (_, hi) =>
        h(hi * 10 + 1, hi * 10 + 1, `+line${hi}`))))
  }

  // Bitmask → which hunks to select (bit i = hunk i of file 0; we only vary
  // file 0 to keep the combinatorial space small — other files stay all-none).
  function pickFromMask(mask: number, hunksPerFile: number): Set<string> {
    const s = new Set<string>()
    for (let i = 0; i < hunksPerFile; i++) {
      if (mask & (1 << i)) s.add(hunkKey('f0', i))
    }
    return s
  }

  const shapes = [
    { files: 1, hunks: 1 },
    { files: 1, hunks: 3 },
    { files: 3, hunks: 2 },
  ]

  for (const { files: fc, hunks: hc } of shapes) {
    for (let mask = 0; mask < (1 << hc); mask++) {
      it(`${fc}F×${hc}H mask=${mask.toString(2).padStart(hc, '0')}`, () => {
        const files = genFiles(fc, hc)
        const selected = pickFromMask(mask, hc)
        const plan = planHunkSpec(files, selected, () => 'M')

        // Invariant 1: a file appears in AT MOST ONE of {resolved, partials}.
        const resolvedPaths = new Set(plan.resolved.map(a => a.path))
        const partialPaths = new Set(plan.partials.map(p => p.path))
        for (const p of resolvedPaths) expect(partialPaths.has(p)).toBe(false)

        // Invariant 2: files with all-selected appear in NEITHER.
        // f0's state depends on mask; f1+ are always 'none' (no keys in set).
        // So f1+ are always in resolved (revert). f0 is omitted iff mask is
        // all-ones, in resolved iff mask=0, in partials otherwise.
        const allOnes = (1 << hc) - 1
        if (mask === allOnes) {
          expect(resolvedPaths.has('f0')).toBe(false)
          expect(partialPaths.has('f0')).toBe(false)
        } else if (mask === 0) {
          expect(resolvedPaths.has('f0')).toBe(true)
        } else {
          expect(partialPaths.has('f0')).toBe(true)
        }

        // Invariant 3: partials[].accepted is the exact subset selected.
        const p0 = plan.partials.find(p => p.path === 'f0')
        if (p0) {
          const expectedCount = [...Array(hc)].filter((_, i) => mask & (1 << i)).length
          expect(p0.accepted).toHaveLength(expectedCount)
        }
      })
    }
  }
})
