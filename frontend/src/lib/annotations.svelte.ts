// Reactive annotation store for agent-review workflows. Annotations are
// per-change_id review comments; the agent iterates on the same change (same
// change_id, new commit_id per edit, captured in evolog). When the agent
// iterates, line numbers drift — re-anchoring keeps comments attached.
//
// Storage: server-side at $XDG_CONFIG_HOME/lightjj/annotations/{changeId}.json
// via /api/annotations. NOT localStorage — spawned workspace tabs run on
// different ports (separate origins) and would have isolated stores.
//
// Re-anchoring: two-stage. (1) diffRange(createdAtCommitId, currentCommitId)
// gives the inter-diff; count line-delta for hunks above the annotation's
// lineNum. (2) If the adjusted line's content doesn't match the snapshot,
// scan ±N lines for an exact match (handles block moves). If both fail,
// mark orphaned — likely means the agent addressed the feedback.
//
// The result is SESSION state (`placement`), never written back: lineNum is only
// meaningful relative to createdAtCommitId, so persisting a moved line against an
// unmoved baseline re-applies the same delta on every load. Same stored/placement
// split as doc-session.svelte.ts.

import { api, FILE_LEVEL, type Annotation, type AnnotationSeverity, type DiffSide } from './api'
import { parseDiffContent, expandTabs } from './diff-parser'
import { fromAnnotation, isReviewedReview, type PlacedReview, type Resolution } from './review'
import { createReviewMutations } from './review-mutations.svelte'

/** A file-level annotation that exists purely as a "viewed" checkbox state —
 *  green severity, no comment body. Excluded from export + chip bar (it's
 *  progress tracking, not feedback). File-level annotations WITH a comment
 *  are real feedback and export normally.
 *
 *  Wire-type wrapper over review.ts isReviewedReview — that's the single
 *  definition of the sentinel; this just projects Annotation through
 *  fromAnnotation so wire-shape call sites (exports, setReviewed) can use it. */
export const isReviewedMarker = (a: Annotation) => isReviewedReview(fromAnnotation(a))

const FUZZY_WINDOW = 5 // ±lines to search for content match
const NO_ANN: readonly PlacedReview[] = [] // shared empty result for forLine misses

// Hunk header format: @@ -oldStart,oldCount +newStart,newCount @@
// For a hunk entirely ABOVE an annotation's line, the net effect on that
// line's number is (newCount - oldCount). Using the diff-parser's DiffHunk
// shape: it has oldStart/newStart/newCount but not oldCount — so recompute
// oldCount from line types (removes + contexts = oldCount).
function hunkDelta(hunk: { lines: { type: string }[] }): number {
  let adds = 0, removes = 0
  for (const l of hunk.lines) {
    if (l.type === 'add') adds++
    else if (l.type === 'remove') removes++
  }
  return adds - removes
}

// Line content as it appears in the new-side of the diff at newLineNum.
// Walks hunks counting context/add lines (which exist in the new file);
// remove lines don't advance newLine. Returns null if the line isn't
// covered by any hunk (between hunks = unchanged = no content available
// from the diff alone).
function lineContentAt(hunks: { newStart: number; lines: { type: string; content: string }[] }[], newLineNum: number): string | null {
  for (const h of hunks) {
    let n = h.newStart
    for (const l of h.lines) {
      if (l.type === 'remove') continue
      if (n === newLineNum) {
        // Diff content includes the +/- /space prefix — strip for comparison.
        return l.content.slice(1)
      }
      n++
    }
  }
  return null
}

// Re-anchor a single annotation using the inter-diff between when it was
// created and now. Returns {lineNum, status} — 'open' with adjusted lineNum
// if anchored, 'orphaned' if the line was deleted/rewritten.
export function reanchor(
  ann: Annotation,
  interDiffHunks: { newStart: number; oldStart: number; lines: { type: string; content: string }[] }[],
): { lineNum: number; status: 'open' | 'orphaned' } {
  // Stage 1: diff-delta adjustment. For each hunk entirely above the
  // annotation's original line (in the OLD side = createdAt snapshot),
  // accumulate line-count delta.
  // DiffLine.content is tab-expanded (issue #9); normalize the stored
  // snapshot so annotations persisted before that change still re-anchor.
  const annContent = expandTabs(ann.lineContent)
  let adjusted = ann.lineNum
  for (const h of interDiffHunks) {
    const oldEnd = h.oldStart + h.lines.filter(l => l.type !== 'add').length - 1
    if (oldEnd < ann.lineNum) {
      adjusted += hunkDelta(h)
    } else if (h.oldStart <= ann.lineNum) {
      // Hunk spans the annotation's line — it may have been deleted or
      // rewritten. Check for exact content within this hunk's new-side.
      // Duplicated content (blank lines, `}`, `return null`) can match at
      // multiple positions; prefer the one closest to the delta-adjusted
      // line so positionally-correct matches win over first-match.
      let n = h.newStart
      let best = -1
      for (const l of h.lines) {
        if (l.type === 'remove') continue
        if (l.content.slice(1) === annContent) {
          if (best < 0 || Math.abs(n - adjusted) < Math.abs(best - adjusted)) {
            best = n
          }
        }
        n++
      }
      if (best >= 0) return { lineNum: best, status: 'open' }
      // Not found in the spanning hunk → likely deleted.
      return { lineNum: adjusted, status: 'orphaned' }
    }
    // Hunk entirely below → doesn't affect this annotation.
  }

  // Stage 2: content verification. If the line at the adjusted position
  // doesn't match the snapshot, the delta math was off (overlapping changes)
  // or the content was edited. Scan ±FUZZY_WINDOW for exact match.
  const contentHere = lineContentAt(interDiffHunks, adjusted)
  if (contentHere === null || contentHere === annContent) {
    // null = line is between hunks (unchanged) → trust delta arithmetic.
    // equal = perfect match.
    return { lineNum: adjusted, status: 'open' }
  }
  for (let d = 1; d <= FUZZY_WINDOW; d++) {
    if (lineContentAt(interDiffHunks, adjusted + d) === annContent) {
      return { lineNum: adjusted + d, status: 'open' }
    }
    if (lineContentAt(interDiffHunks, adjusted - d) === annContent) {
      return { lineNum: adjusted - d, status: 'open' }
    }
  }
  return { lineNum: adjusted, status: 'orphaned' }
}

// --- Export formatters ---

// Markdown for text-prompt agents. Groups by file, skips resolved.
export function exportMarkdown(anns: Annotation[], changeId: string): string {
  // !== 'resolved', not === 'open': agent-posted records may omit status.
  const open = anns.filter(a => a.status !== 'resolved' && !isReviewedMarker(a))
  if (open.length === 0) return `No open annotations for ${changeId}.`

  const byFile = new Map<string, Annotation[]>()
  for (const a of open) {
    if (!byFile.has(a.filePath)) byFile.set(a.filePath, [])
    byFile.get(a.filePath)!.push(a)
  }

  let out = `## Review feedback for ${changeId.slice(0, 8)}\n\n`
  for (const [file, fileAnns] of byFile) {
    fileAnns.sort((a, b) => a.lineNum - b.lineNum)
    for (const a of fileAnns) {
      const sideNote = a.side === 'old' ? ' (deleted line)' : ''
      const loc = a.lineNum === FILE_LEVEL ? file : `${file}:${a.lineNum}${sideNote}`
      const orphanNote = a.status === 'orphaned' ? ' (line may have moved)' : ''
      out += `### ${loc} [${a.severity}]${orphanNote}\n`
      if (a.lineContent) out += '```\n' + a.lineContent + '\n```\n'
      out += `> ${a.comment}\n\n`
    }
  }
  return out
}

// JSON for programmatic agent consumption. Includes resolved (for context).
export function exportJSON(anns: Annotation[], changeId: string, commitId: string): string {
  return JSON.stringify({
    changeId,
    commitId,
    annotations: anns.filter(a => !isReviewedMarker(a)).map(a => ({
      file: a.filePath,
      line: a.lineNum,
      side: a.side ?? 'new',
      context: a.lineContent,
      comment: a.comment,
      severity: a.severity,
      status: a.status,
    })),
  }, null, 2)
}

// --- Reactive store ---

interface AnnotationStore {
  /** Annotations for the currently-loaded changeId, exactly as stored (lineNum
   *  is relative to createdAtCommitId). For mutation; never render positions
   *  from it — use `placed`, or `effective` for wire-shape consumers. */
  readonly list: Annotation[]
  /** `list` with this session's placement overlaid — current line and orphan
   *  status. For export; do NOT save these back. */
  readonly effective: Annotation[]
  /** Read-model projection of `list` (see review.ts). */
  readonly placed: PlacedReview[]
  /** changeId of the currently-loaded set (for stale-check). */
  readonly loadedChangeId: string | null
  /** True while a load/save/delete request is in flight. */
  readonly busy: boolean
  /** Wire-shape annotation by id. PlacedReview shares ids with Annotation, so
   *  call sites holding a projection can recover the wire object without
   *  `list.find(a => a.id === ...)` round-trips. */
  byId(id: string): Annotation | undefined
  /** Lookup annotations for a specific line (for gutter badge). Multiple
   *  annotations may share a line if the user annotated it twice. */
  forLine(filePath: string, lineNum: number, side?: DiffSide): readonly PlacedReview[]
  /** File-level annotations (lineNum=0). */
  forFile(filePath: string): readonly PlacedReview[]
  /** Whether the file has a "reviewed" marker (the viewed-checkbox state). */
  isReviewed(filePath: string): boolean
  /** Toggle the reviewed marker for a file. Resolves true if state changed,
   *  false if dropped (in-flight, wrong changeId, or already at target). */
  setReviewed(filePath: string, reviewed: boolean, ctx: { changeId: string; createdAtCommitId: string }): Promise<boolean>
  /** Load annotations for changeId. If commitId differs from any
   *  createdAtCommitId, re-anchors via diffRange. Pass the current revision's
   *  commitId so the store can detect agent iterations. */
  load(changeId: string, commitId: string): Promise<void>
  /** Create a new annotation. Generates id + createdAt. */
  add(opts: {
    changeId: string
    filePath: string
    lineNum: number
    side?: DiffSide
    lineContent: string
    comment: string
    severity: AnnotationSeverity
    createdAtCommitId: string
  }): Promise<void>
  /** Update comment/severity/status. Pass a `list`/`byId` object (stored
   *  coordinates), never an `effective` one. */
  update(ann: Annotation): Promise<void>
  /** Resolve by id — writes both legacy `status:'resolved'` and the new
   *  `resolution` so older readers and the unified model agree. */
  resolveAs(id: string, resolution: Resolution): Promise<void>
  remove(id: string): Promise<void>
  clear(): Promise<void>
}

export function createAnnotationStore(): AnnotationStore {
  let list = $state<Annotation[]>([])
  let loadedChangeId = $state<string | null>(null)

  // Re-anchor results by annotation id. Items with no entry (just added,
  // file-level, old-side, resolved) sit at their stored line.
  let placement = $state.raw<ReadonlyMap<string, { line: number; orphaned: boolean }>>(new Map())

  // Read-model projection of stored list + placement.
  let placed = $derived(list.map((a): PlacedReview => {
    const p = placement.get(a.id)
    return {
      ...fromAnnotation(a),
      orphaned: p?.orphaned ?? a.status === 'orphaned',
      line: p?.line ?? a.lineNum,
    }
  }))

  let effective = $derived(list.map((a): Annotation => {
    const p = placement.get(a.id)
    return p ? { ...a, lineNum: p.line, status: p.orphaned ? 'orphaned' : 'open' } : a
  }))

  // Cache: (filePath + side + lineNum) → PlacedReview[]. Rebuilt on every
  // list change. forLine() is called per-diff-line during render; O(1) lookup
  // keeps the DiffFileView hot path fast. `side ?? 'new'` so pre-side stored
  // entries (no `side` field) bucket with new-side and existing 2-arg
  // forLine() calls (MarkdownPreview) keep working.
  const lineKey = (path: string, side: DiffSide, line: number) => `${path}:${side}:${line}`
  let byLine = $derived.by(() => {
    const m = new Map<string, PlacedReview[]>()
    for (const r of placed) {
      if (r.anchor.kind !== 'diff') continue
      const k = lineKey(r.anchor.filePath, r.anchor.side, r.line!)
      if (!m.has(k)) m.set(k, [])
      m.get(k)!.push(r)
    }
    return m
  })

  // filePath → has-reviewed-marker. Backs isReviewed() O(1) lookup for the
  // per-file checkbox + DiffPanel's reviewedCount intersection.
  let reviewedFiles = $derived.by(() => {
    const s = new Set<string>()
    for (const a of list) if (isReviewedMarker(a)) s.add(a.filePath)
    return s
  })

  // Shared concurrency policy (review-mutations.svelte.ts): optimistic
  // mutations + generation counter + busy bookkeeping. The gen invalidates
  // in-flight load() when navigation or a write makes its pending final
  // `list = ...` assignment stale. Without the write-side bump, add()
  // completing mid-reanchor gets overwritten by load's final map():
  // annotation saved on backend but invisible in UI until next nav.
  const mutations = createReviewMutations()

  // No negative caching of empty changeIds: agents POST annotations out-of-band
  // (other tabs, the agent CLI), so a "known empty" memo would make those
  // comments permanently invisible here. One cheap GET per revisit of an
  // annotation-free revision is the price of correctness.
  // Load-vs-load ordering for the placement write. Separate from `mutations`'
  // gen: placement is keyed by id, so an add/resolve landing mid-re-anchor must
  // not discard it (that would leave every other comment unadjusted).
  let loadGen = 0

  async function load(changeId: string, commitId: string) {
    const gen = mutations.bump()
    const thisLoad = ++loadGen
    return mutations.track(async () => {
      let raw: Annotation[]
      try {
        raw = await api.annotations.list(changeId)
      } catch (e) {
        // Never leave another change's comments on screen under this one.
        if (mutations.current(gen) && loadedChangeId !== changeId) {
          list = []
          placement = new Map()
          loadedChangeId = null
        }
        throw e
      }
      if (!mutations.current(gen)) return
      // Same change → keep the previous placement until the new one is ready, so
      // a snapshot doesn't flash comments back to their stored lines.
      if (loadedChangeId !== changeId) placement = new Map()
      loadedChangeId = changeId
      list = raw
      if (raw.length === 0) return

      // Re-anchor pass: for annotations whose createdAtCommitId ≠ current,
      // fetch inter-diff and adjust. Group by createdAtCommitId to batch
      // diffRange calls (N annotations from one iteration → 1 fetch).
      const needsReanchor = new Map<string, Annotation[]>()
      const next = new Map<string, { line: number; orphaned: boolean }>()
      for (const a of raw) {
        if (a.lineNum === FILE_LEVEL) continue
        if (a.status === 'resolved') continue
        // Old-side annotations index into the change's PARENT, not the change
        // itself. The diffRange(createdAtCommitId, current) inter-diff doesn't
        // tell us how the parent moved (that needs diffRange between the two
        // parents). Common case: agent edits without rebasing → parent unchanged
        // → old-side line numbers stable. Skip reanchor; stale on rebase is the
        // documented limitation.
        if (a.side === 'old') continue
        // No baseline (agents may omit it) → nothing to diff from; the stored
        // line is the best available position.
        if (!a.createdAtCommitId || a.createdAtCommitId === commitId) {
          next.set(a.id, { line: a.lineNum, orphaned: false })
          continue
        }
        if (!needsReanchor.has(a.createdAtCommitId)) needsReanchor.set(a.createdAtCommitId, [])
        needsReanchor.get(a.createdAtCommitId)!.push(a)
      }

      for (const [fromCommit, anns] of needsReanchor) {
        // One diffRange per createdAt snapshot, scoped to affected files.
        const files = [...new Set(anns.map(a => a.filePath))]
        let hunksByFile: Map<string, ReturnType<typeof parseDiffContent>[number]['hunks']>
        try {
          const { diff } = await api.diffRange(fromCommit, commitId, files)
          if (thisLoad !== loadGen) return
          const parsed = parseDiffContent(diff)
          hunksByFile = new Map(parsed.map(f => [f.filePath, f.hunks]))
        } catch {
          // diffRange can fail if the createdAt commit was abandoned
          // (agent's jj undo). Mark all as orphaned rather than block load —
          // for this session only: a timeout must not orphan them for good.
          if (thisLoad !== loadGen) return
          for (const a of anns) next.set(a.id, { line: a.lineNum, orphaned: true })
          continue
        }
        for (const a of anns) {
          const hunks = hunksByFile.get(a.filePath) ?? []
          const { lineNum, status } = reanchor(a, hunks)
          next.set(a.id, { line: lineNum, orphaned: status === 'orphaned' })
        }
      }
      placement = next
    })
  }

  // Mutations are optimistic (apply → persist → rollback on error) via the
  // shared core. Rollback shapes:
  // - add/setReviewed(true): surgical filter-by-id — always safe, even if a
  //   nav/load replaced the list mid-flight (the filter is then a no-op).
  // - update/remove/clear: gen-guarded snapshot restore — restoring a stale
  //   snapshot after a competing load would resurrect another revision's list.
  // Failures rethrow (DiffPanel's callers catch). Wire writes go through the
  // namespaced client (api.annotations.list/save/remove/clear).
  function byId(id: string): Annotation | undefined {
    return list.find(a => a.id === id)
  }

  async function add(opts: Parameters<AnnotationStore['add']>[0]) {
    const ann: Annotation = {
      id: crypto.randomUUID(),
      ...opts,
      createdAt: Date.now(),
      status: 'open',
    }
    return mutations.track(() => mutations.run({
      apply: () => { list = [...list, ann] },
      persist: () => api.annotations.save(ann),
      rollback: () => { list = list.filter(a => a.id !== ann.id) },
    }))
  }

  async function update(ann: Annotation) {
    const snapshot = list
    return mutations.track(() => mutations.run({
      apply: () => { list = list.map(a => a.id === ann.id ? ann : a) },
      persist: () => api.annotations.save(ann),
      rollback: (stillCurrent) => { if (stillCurrent) list = snapshot },
    }))
  }

  async function resolveAs(id: string, resolution: Resolution) {
    const a = byId(id)
    if (!a) return
    return update({ ...a, status: 'resolved', resolution })
  }

  async function remove(id: string) {
    if (!loadedChangeId) return
    const changeId = loadedChangeId
    const snapshot = list
    return mutations.track(() => mutations.run({
      apply: () => { list = list.filter(a => a.id !== id) },
      persist: () => api.annotations.remove(changeId, id),
      rollback: (stillCurrent) => { if (stillCurrent) list = snapshot },
    }))
  }

  // setReviewed does NOT go through track() — checkbox toggles are
  // cross-file-concurrent + high-frequency, and flipping the store-level busy
  // flag for them would couple unrelated UI. The per-file reviewBusy set is
  // the only dedup gate. mutations.run() still bumps the shared gen (so an
  // in-flight load()'s stale snapshot won't clobber the optimistic write), and
  // its rollbacks deliberately ignore stillCurrent: cross-file toggles each
  // bump the gen, but neither may skip the other's rollback.
  const reviewBusy = new Set<string>()

  async function setReviewed(filePath: string, reviewed: boolean, ctx: { changeId: string; createdAtCommitId: string }): Promise<boolean> {
    if (reviewBusy.has(filePath) || ctx.changeId !== loadedChangeId) return false
    const existing = list.filter(a => a.filePath === filePath && isReviewedMarker(a))
    if (reviewed === existing.length > 0) return false
    reviewBusy.add(filePath)
    try {
      if (reviewed) {
        const ann: Annotation = {
          id: crypto.randomUUID(), ...ctx, filePath,
          lineNum: FILE_LEVEL, lineContent: '', comment: '', severity: 'reviewed',
          createdAt: Date.now(), status: 'open',
        }
        await mutations.run({
          apply: () => { list = [...list, ann] },
          persist: () => api.annotations.save(ann),
          // Surgical: removing the phantom marker by id is always safe.
          rollback: () => { list = list.filter(a => a.id !== ann.id) },
        })
      } else {
        const ids = new Set(existing.map(m => m.id))
        await mutations.run({
          apply: () => { list = list.filter(a => !ids.has(a.id)) },
          persist: async () => {
            for (const m of existing) await api.annotations.remove(ctx.changeId, m.id)
          },
          // Rollback only if still on the same changeId — appending old-rev
          // markers onto a navigated-to rev's list would render phantom ✓s.
          rollback: () => {
            if (ctx.changeId === loadedChangeId) list = [...list, ...existing]
          },
        })
      }
      return true
    } finally {
      reviewBusy.delete(filePath)
    }
  }

  async function clear() {
    if (!loadedChangeId) return
    const changeId = loadedChangeId
    const snapshot = list
    return mutations.track(() => mutations.run({
      apply: () => { list = [] },
      persist: () => api.annotations.clear(changeId),
      rollback: (stillCurrent) => { if (stillCurrent) list = snapshot },
    }))
  }

  return {
    get list() { return list },
    get effective() { return effective },
    get placed() { return placed },
    get loadedChangeId() { return loadedChangeId },
    get busy() { return mutations.busy },
    byId,
    // forLine excludes FILE_LEVEL — split-view's right column for deleted files
    // yields annLine===0; without this guard the file-level annotation would
    // leak into the gutter as a line badge.
    forLine: (filePath, lineNum, side = 'new') =>
      lineNum === FILE_LEVEL ? NO_ANN : byLine.get(lineKey(filePath, side, lineNum)) ?? NO_ANN,
    forFile: (filePath) => byLine.get(lineKey(filePath, 'new', FILE_LEVEL)) ?? NO_ANN,
    isReviewed: (filePath) => reviewedFiles.has(filePath),
    load, add, update, resolveAs, remove, clear, setReviewed,
  }
}
