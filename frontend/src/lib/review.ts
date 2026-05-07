// Unified read-model over Annotation (diff-review) + DocComment (doc-mode).
// See docs/design-notes/unified-review.md.
//
// Read-only: components render Review, but mutations go through the existing
// stores by id. No Review→wire inverse mappers — CommentCard emits intent
// callbacks and the parent surface wires them to its own store.

import { FILE_LEVEL, type Annotation, type AnnotationSeverity, type DiffSide, type DocComment } from './api'

export type ReviewAnchor =
  | {
      kind: 'diff'
      changeId: string
      filePath: string
      line: number
      side: DiffSide
      lineContent: string
      commitId: string
    }
  | {
      kind: 'prose'
      filePath: string
      selection: string
      ctxBefore: string
      ctxAfter: string
    }

export type Severity = AnnotationSeverity

export type Resolution = 'addressed' | 'wontfix'

export interface Review {
  id: string
  anchor: ReviewAnchor
  body: string
  author?: string
  createdAt: number
  parentId?: string
  severity?: Severity
  kind: 'note' | 'suggestion'
  suggestion?: { replacement: string; baseVersion?: number }
  resolution?: Resolution
  resolvedAt?: number
}

/** Per-surface placed wrapper — derived state that doesn't persist. */
export type PlacedReview = Review & {
  orphaned: boolean
  /** Post-re-anchor effective line (diff anchors). */
  line?: number
  /** PM positions (prose anchors). */
  from?: number
  to?: number
}

export function fromAnnotation(a: Annotation): Review {
  return {
    id: a.id,
    anchor: {
      kind: 'diff',
      changeId: a.changeId,
      filePath: a.filePath,
      line: a.lineNum,
      side: a.side ?? 'new',
      lineContent: a.lineContent,
      commitId: a.createdAtCommitId,
    },
    body: a.comment,
    createdAt: a.createdAt,
    severity: a.severity,
    kind: 'note',
    // Prefer the new optional field; fall back to legacy status mapping.
    resolution: a.resolution ?? (a.status === 'resolved' ? 'addressed' : undefined),
    // status:'orphaned' is dropped — recomputed into PlacedReview.orphaned.
  }
}

export function fromDocComment(d: DocComment): Review {
  return {
    id: d.id,
    anchor: {
      kind: 'prose',
      filePath: d.filePath,
      selection: d.anchor.selection,
      ctxBefore: d.anchor.contextBefore,
      ctxAfter: d.anchor.contextAfter,
    },
    body: d.body,
    author: d.author,
    createdAt: d.createdAt,
    parentId: d.parentId,
    kind: d.kind === 'comment' ? 'note' : 'suggestion',
    suggestion: d.suggestion,
    resolution: d.resolution,
    resolvedAt: d.resolvedAt,
  }
}

/** anchorText for CommentCard's quote/suggestion-del row — the text the
 *  comment is about, surface-independent. */
export function anchorText(r: Review): string {
  return r.anchor.kind === 'diff' ? r.anchor.lineContent : r.anchor.selection
}

/** Review-side equivalent of annotations.isReviewedMarker — the file-viewed
 *  checkbox sentinel. Excluded from nav, counts, and CommentCard rendering. */
export const isReviewedReview = (r: Review): boolean =>
  r.severity === 'reviewed' && r.body === '' &&
  r.anchor.kind === 'diff' && r.anchor.line === FILE_LEVEL

/** Severity rank for "worst-first" bubble color when a line has multiple. */
export const SEVERITY_RANK: Record<Severity, number> = {
  'must-fix': 0, suggestion: 1, question: 2, nitpick: 3, reviewed: 4,
}

export const SEVERITY_VAR: Record<Severity, string> = {
  'must-fix': '--red',
  suggestion: '--amber',
  question: '--blue',
  nitpick: '--overlay0',
  reviewed: '--overlay0',
}
