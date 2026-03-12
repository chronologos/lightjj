// Hunk-level forward-patching — the pure core of per-hunk review mode.
//
// jj's diff-editor protocol (`jj split --tool X`) materializes $left (parent
// tree) and $right (current tree) as on-disk directories; the tool modifies
// $right in place; jj reads it back. Selection = "what's in $right after exit".
//
// We synthesize $right content on the FRONTEND: start from $left content,
// forward-apply only the ACCEPTED hunks. The Go tool is then a dumb file
// writer — no hunk-identity coordination, no backend patching logic. This is
// safe because the frontend's diff is commit_id-keyed and `jj split -r <cid>`
// materializes the same trees.

import type { DiffFile, DiffHunk } from './diff-parser'

/** Selection key. `#` is not a path separator on any platform jj supports
 *  and is rare in filenames (vs `:` which appears in Windows drive letters
 *  if we ever care). Matches are exact-string so collision would need a file
 *  literally named `foo.ts#0` — we accept that. */
export function hunkKey(filePath: string, idx: number): string {
  return `${filePath}#${idx}`
}

export type SelectionState = 'all' | 'none' | 'some'

/** `hunks.length === 0` → 'all'. Binary files, pure renames, mode-only changes
 *  all parse to zero hunks — they're atomic, so "all selected" is the only
 *  coherent default. File-header click can still flip to 'none' (→ revert),
 *  but there's no per-hunk granularity to offer. */
export function fileSelectionState(
  file: DiffFile,
  selected: ReadonlySet<string>,
): SelectionState {
  if (file.hunks.length === 0) return 'all'
  let n = 0
  for (let i = 0; i < file.hunks.length; i++) {
    if (selected.has(hunkKey(file.filePath, i))) n++
  }
  if (n === 0) return 'none'
  if (n === file.hunks.length) return 'all'
  return 'some'
}

/** Forward-apply a subset of hunks to the left-side content.
 *
 *  Walks leftLines, copying unchanged regions verbatim; at each accepted hunk,
 *  consumes `-`/context lines from left and emits `+`/context lines to output.
 *  `accepted` MUST be sorted by `oldStart` (callers pass a filter of
 *  `file.hunks` which is already parse-order = oldStart-order).
 *
 *  KNOWN LIMITATION — trailing newline: result inherits left's
 *  trailing-newline-ness. If an accepted hunk changes EOF newline state
 *  (diff has a `\ No newline at end of file` marker on one side only) the
 *  1-byte difference is lost. diff-parser currently types the `\` marker as
 *  context; we skip it here. Pinned by a test so it doesn't silently regress
 *  into something worse. */
export function applyHunks(leftContent: string, accepted: readonly DiffHunk[]): string {
  const left = leftContent.split('\n')
  const out: string[] = []
  let pos = 0 // 0-indexed into left[]

  let prevOldStart = -1
  for (const hunk of accepted) {
    // Out-of-order hunks silently corrupt: the gap-copy loop over-copies,
    // then wrong lines get consumed by `-`. Production path is safe (callers
    // pass a filter of file.hunks = parse-order = oldStart-order) but a
    // future caller building `accepted` from Set iteration (hash-order)
    // would get garbage with no error. Cheap to catch.
    if (hunk.oldStart < prevOldStart) {
      throw new Error(`applyHunks: unsorted hunks (oldStart ${hunk.oldStart} < ${prevOldStart})`)
    }
    prevOldStart = hunk.oldStart

    // Copy the unchanged gap before this hunk. oldStart is 1-indexed.
    while (pos < hunk.oldStart - 1) out.push(left[pos++])

    for (const line of hunk.lines) {
      // `\ No newline at end of file` — diff metadata, not content. Parser
      // types it as context; treating it as one would emit a literal `\ No...`
      // line into the output.
      if (line.content.startsWith('\\')) continue

      if (line.type === 'remove') {
        pos++
      } else if (line.type === 'add') {
        out.push(line.content.slice(1)) // strip leading `+`
      } else {
        // Context: advance left AND emit. Use left[pos] not line.content —
        // they should be identical, but left[] is the source of truth we're
        // reconstructing from; using it makes the round-trip invariant
        // (`applyHunks(left, []) === left`) structurally obvious.
        out.push(left[pos++])
      }
    }
  }

  while (pos < left.length) out.push(left[pos++])
  return out.join('\n')
}

/** Normalized file type for the decision table. jj's FileChange.type is the
 *  raw status char (`A`/`M`/`D`/`R`/`C` and occasionally others); we only
 *  care about the three cases where the left/right tree shape differs.
 *  Unknown chars → 'M' (safe: M's row never deletes, only revert/write). */
export type FileType = 'A' | 'M' | 'D'

export function normalizeFileType(raw: string): FileType {
  if (raw === 'A') return 'A'
  if (raw === 'D') return 'D'
  return 'M' // M, R, C, anything else
}

/** Spec sent to the backend. `write` carries synthesized content; `revert`
 *  and `delete` are instructions the Go tool executes against $left/$right. */
export type SpecAction =
  | { path: string; action: 'write'; content: string }
  | { path: string; action: 'revert' }
  | { path: string; action: 'delete' }

export interface HunkSpec {
  files: SpecAction[]
}

/** Intermediate plan — pure decision, no I/O. `partials` lists files that
 *  need a left-content fetch + applyHunks call; the effectful wrapper in
 *  App.svelte does those and fills the `write` actions. Everything else is
 *  fully resolved here. */
export interface HunkPlan {
  /** Fully-resolved revert/delete actions. */
  resolved: SpecAction[]
  /** Files needing synthesis. leftContent='' for additions (no $left/file). */
  partials: Array<{ path: string; accepted: DiffHunk[]; leftIsEmpty: boolean }>
}

export function planHunkSpec(
  files: readonly DiffFile[],
  selected: ReadonlySet<string>,
  typeOf: (path: string) => FileType,
): HunkPlan {
  const resolved: SpecAction[] = []
  const partials: HunkPlan['partials'] = []

  for (const file of files) {
    const state = fileSelectionState(file, selected)
    if (state === 'all') continue // omit — tool leaves $right/file alone

    const ft = typeOf(file.filePath)

    if (state === 'none') {
      // D + none is the "undo a deletion" case: $right lacks the file
      // (jj materialized the delete), $left has it → revert restores.
      // A + none is "don't add this file": $right has it, $left doesn't
      // → delete removes. M + none is a plain revert.
      resolved.push(ft === 'A' ? { path: file.filePath, action: 'delete' }
                               : { path: file.filePath, action: 'revert' })
      continue
    }

    // state === 'some'. D can't reach here (deletion is one hunk → no 'some').
    // A's left side is empty; M's needs a fetch.
    const accepted = file.hunks.filter((_, i) => selected.has(hunkKey(file.filePath, i)))
    partials.push({ path: file.filePath, accepted, leftIsEmpty: ft === 'A' })
  }

  return { resolved, partials }
}

/** Resolve a plan into a final spec given fetched left contents.
 *  `leftContents` keys must cover every `partials[i].path` where `!leftIsEmpty`. */
export function resolvePlan(
  plan: HunkPlan,
  leftContents: ReadonlyMap<string, string>,
): HunkSpec {
  const files: SpecAction[] = [...plan.resolved]
  for (const p of plan.partials) {
    const left = p.leftIsEmpty ? '' : (leftContents.get(p.path) ?? '')
    files.push({ path: p.path, action: 'write', content: applyHunks(left, p.accepted) })
  }
  return { files }
}
