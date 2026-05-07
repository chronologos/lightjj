import { describe, expect, it } from 'vitest'
import type { Annotation, DocComment } from './api'
import { anchorText, fromAnnotation, fromDocComment } from './review'

const ann: Annotation = {
  id: 'a1',
  changeId: 'wqnw',
  filePath: 'src/x.go',
  lineNum: 42,
  side: 'new',
  lineContent: 'func foo() {',
  comment: 'nit: name',
  severity: 'nitpick',
  createdAt: 1000,
  createdAtCommitId: 'abc',
  status: 'open',
}

const doc: DocComment = {
  id: 'd1',
  filePath: 'docs/x.md',
  anchor: { selection: 'the cat', contextBefore: 'see ', contextAfter: ' sat' },
  kind: 'suggestion',
  body: 'prefer "feline"',
  suggestion: { replacement: 'the feline', baseVersion: 3 },
  author: 'agent',
  createdAt: 2000,
}

describe('fromAnnotation', () => {
  it('maps to diff anchor + body', () => {
    const r = fromAnnotation(ann)
    expect(r.anchor.kind).toBe('diff')
    expect(r.anchor.kind === 'diff' && r.anchor.line).toBe(42)
    expect(r.body).toBe('nit: name')
    expect(r.severity).toBe('nitpick')
    expect(r.resolution).toBeUndefined()
    expect(anchorText(r)).toBe('func foo() {')
  })

  it('status:resolved → resolution:addressed; orphaned dropped', () => {
    expect(fromAnnotation({ ...ann, status: 'resolved' }).resolution).toBe('addressed')
    expect(fromAnnotation({ ...ann, status: 'orphaned' }).resolution).toBeUndefined()
  })

  it('prefers explicit resolution field over legacy status', () => {
    const r = fromAnnotation({ ...ann, status: 'open', resolution: 'wontfix' } as Annotation)
    expect(r.resolution).toBe('wontfix')
  })

  it('defaults side to new', () => {
    const r = fromAnnotation({ ...ann, side: undefined })
    expect(r.anchor.kind === 'diff' && r.anchor.side).toBe('new')
  })

  it('keeps reviewed as explicit severity (no sentinel inference)', () => {
    const r = fromAnnotation({ ...ann, severity: 'reviewed', comment: '', lineNum: 0 })
    expect(r.severity).toBe('reviewed')
  })
})

describe('fromDocComment', () => {
  it('maps to prose anchor; comment→note', () => {
    const r = fromDocComment({ ...doc, kind: 'comment', suggestion: undefined })
    expect(r.anchor.kind).toBe('prose')
    expect(r.kind).toBe('note')
    expect(anchorText(r)).toBe('the cat')
  })

  it('passes suggestion.baseVersion through', () => {
    const r = fromDocComment(doc)
    expect(r.kind).toBe('suggestion')
    expect(r.suggestion?.baseVersion).toBe(3)
  })

  it('preserves resolution + parentId', () => {
    const r = fromDocComment({ ...doc, resolution: 'wontfix', resolvedAt: 9, parentId: 'p1' })
    expect(r.resolution).toBe('wontfix')
    expect(r.resolvedAt).toBe(9)
    expect(r.parentId).toBe('p1')
  })
})
