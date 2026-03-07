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

import { api, type Annotation, type AnnotationSeverity } from './api'
import { parseDiffContent } from './diff-parser'

const FUZZY_WINDOW = 5 // ±lines to search for content match
const NO_ANN: readonly Annotation[] = [] // shared empty result for forLine misses

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
  let adjusted = ann.lineNum
  for (const h of interDiffHunks) {
    const oldEnd = h.oldStart + h.lines.filter(l => l.type !== 'add').length - 1
    if (oldEnd < ann.lineNum) {
      adjusted += hunkDelta(h)
    } else if (h.oldStart <= ann.lineNum) {
      // Hunk spans the annotation's line — it may have been deleted or
      // rewritten. Check for exact content within this hunk's new-side.
      let n = h.newStart
      for (const l of h.lines) {
        if (l.type === 'remove') continue
        if (l.content.slice(1) === ann.lineContent) {
          return { lineNum: n, status: 'open' }
        }
        n++
      }
      // Not found in the spanning hunk → likely deleted.
      return { lineNum: adjusted, status: 'orphaned' }
    }
    // Hunk entirely below → doesn't affect this annotation.
  }

  // Stage 2: content verification. If the line at the adjusted position
  // doesn't match the snapshot, the delta math was off (overlapping changes)
  // or the content was edited. Scan ±FUZZY_WINDOW for exact match.
  const contentHere = lineContentAt(interDiffHunks, adjusted)
  if (contentHere === null || contentHere === ann.lineContent) {
    // null = line is between hunks (unchanged) → trust delta arithmetic.
    // equal = perfect match.
    return { lineNum: adjusted, status: 'open' }
  }
  for (let d = 1; d <= FUZZY_WINDOW; d++) {
    if (lineContentAt(interDiffHunks, adjusted + d) === ann.lineContent) {
      return { lineNum: adjusted + d, status: 'open' }
    }
    if (lineContentAt(interDiffHunks, adjusted - d) === ann.lineContent) {
      return { lineNum: adjusted - d, status: 'open' }
    }
  }
  return { lineNum: adjusted, status: 'orphaned' }
}

// --- Export formatters ---

// Markdown for text-prompt agents. Groups by file, skips resolved.
export function exportMarkdown(anns: Annotation[], changeId: string): string {
  const open = anns.filter(a => a.status === 'open' || a.status === 'orphaned')
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
      const orphanNote = a.status === 'orphaned' ? ' (line may have moved)' : ''
      out += `### ${file}:${a.lineNum} [${a.severity}]${orphanNote}\n`
      out += '```\n' + a.lineContent + '\n```\n'
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
    annotations: anns.map(a => ({
      file: a.filePath,
      line: a.lineNum,
      context: a.lineContent,
      comment: a.comment,
      severity: a.severity,
      status: a.status,
    })),
  }, null, 2)
}

// --- Reactive store ---

interface AnnotationStore {
  /** Annotations for the currently-loaded changeId. */
  readonly list: Annotation[]
  /** changeId of the currently-loaded set (for stale-check). */
  readonly loadedChangeId: string | null
  /** True while a load/save/delete request is in flight. */
  readonly busy: boolean
  /** Lookup annotations for a specific line (for gutter badge). Multiple
   *  annotations may share a line if the user annotated it twice. */
  forLine(filePath: string, lineNum: number): readonly Annotation[]
  /** Load annotations for changeId. If commitId differs from any
   *  createdAtCommitId, re-anchors via diffRange. Pass the current revision's
   *  commitId so the store can detect agent iterations. */
  load(changeId: string, commitId: string): Promise<void>
  /** Create a new annotation. Generates id + createdAt. */
  add(opts: {
    changeId: string
    filePath: string
    lineNum: number
    lineContent: string
    comment: string
    severity: AnnotationSeverity
    createdAtCommitId: string
  }): Promise<void>
  /** Update comment/severity/status. Re-anchored lineNum is set via load(). */
  update(ann: Annotation): Promise<void>
  remove(id: string): Promise<void>
  clear(): Promise<void>
}

export function createAnnotationStore(): AnnotationStore {
  let list = $state<Annotation[]>([])
  let loadedChangeId = $state<string | null>(null)
  let busy = $state(false)

  // Cache: (changeId + filePath + lineNum) → Annotation[]. Rebuilt on every
  // list change. forLine() is called per-diff-line during render; O(1) lookup
  // keeps the DiffFileView hot path fast.
  let byLine = $derived.by(() => {
    const m = new Map<string, Annotation[]>()
    for (const a of list) {
      const k = `${a.filePath}:${a.lineNum}`
      if (!m.has(k)) m.set(k, [])
      m.get(k)!.push(a)
    }
    return m
  })

  async function withBusy<T>(fn: () => Promise<T>): Promise<T> {
    busy = true
    try { return await fn() } finally { busy = false }
  }

  let loadGen = 0
  async function load(changeId: string, commitId: string) {
    const gen = ++loadGen
    return withBusy(async () => {
      const raw = await api.annotations(changeId)
      if (gen !== loadGen) return
      loadedChangeId = changeId

      // Re-anchor pass: for annotations whose createdAtCommitId ≠ current,
      // fetch inter-diff and adjust. Group by createdAtCommitId to batch
      // diffRange calls (N annotations from one iteration → 1 fetch).
      const needsReanchor = new Map<string, Annotation[]>()
      for (const a of raw) {
        if (a.status === 'resolved') continue
        if (a.createdAtCommitId === commitId) continue
        if (!needsReanchor.has(a.createdAtCommitId)) needsReanchor.set(a.createdAtCommitId, [])
        needsReanchor.get(a.createdAtCommitId)!.push(a)
      }

      const updates: Annotation[] = []
      for (const [fromCommit, anns] of needsReanchor) {
        // One diffRange per createdAt snapshot, scoped to affected files.
        const files = [...new Set(anns.map(a => a.filePath))]
        let hunksByFile: Map<string, ReturnType<typeof parseDiffContent>[number]['hunks']>
        try {
          const { diff } = await api.diffRange(fromCommit, commitId, files)
          if (gen !== loadGen) return
          const parsed = parseDiffContent(diff)
          hunksByFile = new Map(parsed.map(f => [f.filePath, f.hunks]))
        } catch {
          // diffRange can fail if the createdAt commit was abandoned
          // (agent's jj undo). Mark all as orphaned rather than block load.
          for (const a of anns) updates.push({ ...a, status: 'orphaned' })
          continue
        }
        for (const a of anns) {
          const hunks = hunksByFile.get(a.filePath) ?? []
          const { lineNum, status } = reanchor(a, hunks)
          if (lineNum !== a.lineNum || status !== a.status) {
            updates.push({ ...a, lineNum, status })
          }
        }
      }

      // Persist re-anchor results so the next load is a no-op (and so a
      // workspace tab opened later sees the anchored positions).
      for (const u of updates) {
        await api.saveAnnotation(u)
        if (gen !== loadGen) return
      }

      // Apply updates in-memory (saves returned the same objects).
      const byId = new Map(updates.map(u => [u.id, u]))
      list = raw.map(a => byId.get(a.id) ?? a)
    })
  }

  async function add(opts: Parameters<AnnotationStore['add']>[0]) {
    const ann: Annotation = {
      id: crypto.randomUUID(),
      ...opts,
      createdAt: Date.now(),
      status: 'open',
    }
    return withBusy(async () => {
      await api.saveAnnotation(ann)
      list = [...list, ann]
    })
  }

  async function update(ann: Annotation) {
    return withBusy(async () => {
      await api.saveAnnotation(ann)
      list = list.map(a => a.id === ann.id ? ann : a)
    })
  }

  async function remove(id: string) {
    if (!loadedChangeId) return
    return withBusy(async () => {
      await api.deleteAnnotation(loadedChangeId!, id)
      list = list.filter(a => a.id !== id)
    })
  }

  async function clear() {
    if (!loadedChangeId) return
    return withBusy(async () => {
      await api.clearAnnotations(loadedChangeId!)
      list = []
    })
  }

  return {
    get list() { return list },
    get loadedChangeId() { return loadedChangeId },
    get busy() { return busy },
    forLine: (filePath, lineNum) => byLine.get(`${filePath}:${lineNum}`) ?? NO_ANN,
    load, add, update, remove, clear,
  }
}
