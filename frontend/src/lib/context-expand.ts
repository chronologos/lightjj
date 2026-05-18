import type { DiffFile, DiffHunk, DiffLine } from './diff-parser'

/** Extract context lines for newLine range [from, to) from the full-context
 *  fetch. Walks each hunk's lines with a running newLine counter (remove lines
 *  don't advance newLine). Only context lines are returned — add/remove lines
 *  in the range belong to an original hunk, not a gap.
 *
 *  Iterates ALL hunks: `--context 10000` collapses to one hunk for typical
 *  files, but a file with two change clusters >20000 lines apart yields a
 *  multi-hunk result. Reading only `hunks[0]` would silently return [] for
 *  any gap that falls in a later hunk's range — the gap would still be marked
 *  revealed, the surrounding hunks would merge with zero lines between them,
 *  and the expand button would vanish without showing anything. */
function sliceContext(fullHunks: DiffHunk[], from: number, to: number): DiffLine[] {
  const out: DiffLine[] = []
  for (const full of fullHunks) {
    if (full.newStart >= to) break
    if (full.newStart + full.newCount <= from) continue
    let newLine = full.newStart
    for (const line of full.lines) {
      if (newLine >= to) return out
      if (line.type === 'context' && newLine >= from) out.push(line)
      if (line.type !== 'remove') newLine++
    }
  }
  return out
}

export interface ExpandedDiff {
  file: DiffFile
  /** gapMap[i] = ORIGINAL gap index for effective (post-merge) gap i.
   *  When hunks merge, effective indices shift; DiffFileView uses this to
   *  call onexpand with the right original index. Length = file.hunks.length+1. */
  gapMap: number[]
}

/** Merge revealed gaps into the original diff.
 *  Gap i sits BEFORE hunk[i]; gap hunks.length is after the last hunk.
 *  A revealed gap fills with context from `full` and MERGES the hunks on
 *  either side into one — revealing all gaps yields the full-context diff. */
export function expandGaps(
  original: DiffFile,
  full: DiffFile,
  gaps: ReadonlySet<number>,
): ExpandedDiff {
  const N = original.hunks.length
  const identityMap = Array.from({ length: N + 1 }, (_, i) => i)
  if (gaps.size === 0 || full.hunks.length === 0) {
    return { file: original, gapMap: identityMap }
  }
  const merged: DiffHunk[] = []
  const gapMap: number[] = []
  let cur: DiffHunk | null = null

  // Gap 0's start is the FIRST line of context jj returned, not line 1.
  // `--context 10000` clamps to `max(1, firstChangeLine - 10000)` — for a
  // file whose first change is >10000 lines in, `full.hunks[0].newStart > 1`.
  // Hardcoding 1 would build a merged hunk claiming `newStart: 1` whose first
  // gap line is actually `full.newStart`, shifting every gutter number,
  // copy-reference range, and annotation key by `full.newStart - 1`.
  // (gap 0 is pure context, so old/new line numbers coincide and the same
  // value serves oldStart.)
  const prevEnd = (i: number) =>
    i === 0 ? full.hunks[0].newStart : original.hunks[i - 1].newStart + original.hunks[i - 1].newCount

  for (let i = 0; i < N; i++) {
    const h = original.hunks[i]
    const from = prevEnd(i)
    const to = h.newStart
    const wantGap = gaps.has(i)
    // Gap regions are pure context (no add/remove between original hunks), so
    // a fully-covered gap yields exactly `to - from` lines. Fewer means the
    // full fetch can't cover this range — most commonly an inter-hunk void
    // (changes >20000 lines apart → `--context 10000` can't bridge them), but
    // also a stale `full` from a prior commit_id whose gap region shifted
    // (refreshExpandedDiffs shrinks that window but doesn't close it). Either
    // way, merging would assign sequential line numbers across the
    // discontinuity, shifting every gutter number, copy-ref, and annotation
    // key after it. Keep the hunk unmerged instead. UX gap: the gap-button
    // render in DiffFileView is line-arithmetic-only and doesn't consult
    // revealedGaps, so the button persists as a no-op (clicking re-adds an
    // already-present index). Persistent-but-correct beats vanished-and-wrong;
    // surfacing per-gap unfillable status is a future enhancement.
    // `wantGap` gates both — `to === from` (adjacent hunks) trivially has
    // gap.length === 0, but auto-merging a never-clicked gap would be wrong.
    const gap = wantGap ? sliceContext(full.hunks, from, to) : []
    const covered = wantGap && gap.length === to - from
    if (covered) {
      if (cur) {
        cur.lines.push(...gap, ...h.lines)
        cur.newCount += gap.length + h.newCount
      } else {
        const start = from
        // Gap-i revealed with no prior hunk — this new merged hunk starts at
        // the gap. The gap BEFORE it is still gap-i conceptually, but since
        // gap-i is revealed it won't render a button. Map to i so clicking
        // would be idempotent (already revealed).
        gapMap.push(i)
        cur = {
          header: `@@ -${start} +${start} @@`,
          oldStart: start,
          newStart: start,
          newCount: gap.length + h.newCount,
          lines: [...gap, ...h.lines],
        }
        merged.push(cur)
      }
    } else {
      gapMap.push(i)
      cur = { ...h, lines: [...h.lines] }
      merged.push(cur)
    }
  }

  gapMap.push(N)  // trailing gap always maps to N

  // The trailing gap deliberately has no `covered` guard: with `to=Infinity`
  // there's no inter-hunk line-number shift possible — every line after the
  // last original hunk has a stable number. Worst case (file extends >10000
  // lines past the last change) the slice is truncated, never misaligned.
  if (gaps.has(N) && cur) {
    const last = original.hunks[N - 1]
    const trailing = sliceContext(full.hunks, last.newStart + last.newCount, Infinity)
    cur.lines.push(...trailing)
    cur.newCount += trailing.length
  }

  return { file: { ...original, hunks: merged }, gapMap }
}
