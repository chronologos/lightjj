import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { DocComment } from './api'
import { ApiError } from './api-error'

// In-memory backend stub. Declared inside the factory so vi.mock hoisting
// doesn't reference uninitialized module-scope vars.
vi.mock('./api', () => {
  let stored: DocComment[] = []
  let content = ''
  return {
    api: {
      fileShow: vi.fn(async () => ({ content })),
      fileWrite: vi.fn(async () => ({ output: '', commit_id: 'cid2' })),
      docComments: {
        list: vi.fn(async () => [...stored]),
        upsert: vi.fn(async (c: DocComment) => {
          const i = stored.findIndex((x) => x.id === c.id)
          if (i >= 0) stored[i] = c
          else stored.push(c)
          return c
        }),
        remove: vi.fn(async (_p: string, id: string) => {
          stored = stored.filter((x) => x.id !== id)
        }),
      },
      __setContent: (s: string) => { content = s },
      __setStored: (cs: DocComment[]) => { stored = cs },
      __reset: () => { stored = []; content = '' },
    },
  }
})

import { createDocSession } from './doc-session.svelte'
import { anchorText } from './review'
import { api } from './api'
import { EditorState, type Transaction } from 'prosemirror-state'
import { docSchema } from './pm-schema'

const mockApi = api as typeof api & {
  __setContent: (s: string) => void
  __setStored: (cs: DocComment[]) => void
  __reset: () => void
}

const MD = `# Design

This is the first paragraph with a distinctive phrase here.

## Section two

Another paragraph follows.`

beforeEach(() => {
  mockApi.__reset()
  vi.clearAllMocks()
})

describe('createDocSession', () => {
  it('import_ populates state from fileShow', async () => {
    mockApi.__setContent(MD)
    const s = createDocSession('docs/DESIGN.md', () => 'abc123')
    await s.import_()
    expect(s.doc).not.toBeNull()
    expect(s.doc!.textContent).toContain('distinctive phrase')
    expect(s.error).toBe('')
    expect(s.baseCommitId).toBe('abc123')
  })

  it('import_ surfaces error when working copy unavailable', async () => {
    const s = createDocSession('x.md', () => undefined)
    await s.import_()
    expect(s.doc).toBeNull()
    expect(s.error).toContain('working copy')
  })

  it('addComment captures anchor and persists', async () => {
    mockApi.__setContent(MD)
    const s = createDocSession('docs/DESIGN.md', () => 'abc123')
    await s.import_()
    // Find PM positions for "distinctive phrase" by scanning textContent.
    const flat = s.doc!.textContent
    const tFrom = flat.indexOf('distinctive')
    expect(tFrom).toBeGreaterThan(0)
    // textContent offsets ≠ PM positions, so we use the public API: select by
    // searching the doc. For the test, walk to find the text node.
    let pmFrom = -1
    s.doc!.descendants((node, pos) => {
      if (node.isText && node.text?.includes('distinctive')) {
        pmFrom = pos + node.text.indexOf('distinctive')
        return false
      }
    })
    expect(pmFrom).toBeGreaterThan(0)
    const pmTo = pmFrom + 'distinctive phrase'.length

    await s.addComment(pmFrom, pmTo, 'please clarify')
    expect(s.comments).toHaveLength(1)
    // comments[] is the PlacedReview projection (review.ts) — prose anchor
    // fields are selection/ctxBefore/ctxAfter.
    const c = s.comments[0]
    expect(anchorText(c)).toBe('distinctive phrase')
    expect(c.anchor.kind === 'prose' && c.anchor.ctxBefore.endsWith('with a ')).toBe(true)
    expect(c.from).toBe(pmFrom)
    expect(c.orphaned).toBe(false)
    expect(api.docComments.upsert).toHaveBeenCalledOnce()
    // Wire shape is unchanged: the persisted DocComment still carries
    // contextBefore/contextAfter (the agent API contract).
    const wire = (api.docComments.upsert as ReturnType<typeof vi.fn>).mock.calls[0][0] as DocComment
    expect(wire.anchor.contextBefore.endsWith('with a ')).toBe(true)
  })

  it('round-trip: comment re-found at same PM position after re-import', async () => {
    mockApi.__setContent(MD)
    const s = createDocSession('docs/DESIGN.md', () => 'abc123')
    await s.import_()
    let pmFrom = -1
    s.doc!.descendants((node, pos) => {
      if (node.isText && node.text?.includes('distinctive')) {
        pmFrom = pos + node.text.indexOf('distinctive')
        return false
      }
    })
    const pmTo = pmFrom + 'distinctive phrase'.length
    await s.addComment(pmFrom, pmTo, 'x')

    // Fresh session, same content — refind should land at the same PM positions.
    const s2 = createDocSession('docs/DESIGN.md', () => 'abc123')
    await s2.import_()
    expect(s2.comments).toHaveLength(1)
    expect(s2.comments[0].orphaned).toBe(false)
    expect(s2.comments[0].from).toBe(pmFrom)
    expect(s2.comments[0].to).toBe(pmTo)
  })

  it('refind orphans when selection text removed', async () => {
    mockApi.__setContent(MD)
    const s = createDocSession('docs/DESIGN.md', () => 'abc123')
    await s.import_()
    let pmFrom = -1
    s.doc!.descendants((node, pos) => {
      if (node.isText && node.text?.includes('distinctive')) {
        pmFrom = pos + node.text.indexOf('distinctive')
        return false
      }
    })
    await s.addComment(pmFrom, pmFrom + 18, 'x')

    // Content changes: the phrase is gone AND its surrounding context is gone.
    mockApi.__setContent('# Design\n\nUnrelated.\n')
    const s2 = createDocSession('docs/DESIGN.md', () => 'def456')
    await s2.import_()
    expect(s2.comments).toHaveLength(1)
    expect(s2.comments[0].orphaned).toBe(true)
    expect(s2.comments[0].from).toBeUndefined()
  })

  it('refreshComments places agent-posted comments without resetting dirty state', async () => {
    mockApi.__setContent(MD)
    const s = createDocSession('docs/DESIGN.md', () => 'abc123')
    await s.import_()
    expect(s.dirty).toBe(false)
    applyEdit(s, tr => tr.insertText('X', 1, 1))
    expect(s.dirty).toBe(true)
    // Agent posts a comment out-of-band (server store changes; session unaware).
    mockApi.__setStored([{
      id: 'agent-1', filePath: 'docs/DESIGN.md', kind: 'comment',
      anchor: { selection: 'distinctive phrase', contextBefore: '', contextAfter: '' },
      body: 'from agent', author: 'bot', createdAt: 1,
    }])
    await s.refreshComments()
    expect(s.comments).toHaveLength(1)
    expect(s.comments[0].orphaned).toBe(false)
    expect(s.comments[0].from).toBeGreaterThan(0)
    // Crucially: refresh did not reset the doc — user's unsaved edit survives.
    expect(s.dirty).toBe(true)
  })

  it('refreshComments preserves local placement for known ids (accepted-suggestion stays anchored)', async () => {
    mockApi.__setContent(MD)
    mockApi.__setStored([{
      id: 's1', filePath: 'docs/DESIGN.md', kind: 'suggestion',
      anchor: { selection: 'distinctive phrase', contextBefore: '', contextAfter: '' },
      suggestion: { replacement: 'replaced text', baseVersion: 0 },
      body: '', author: 'agent', createdAt: 1,
    }])
    const s = createDocSession('docs/DESIGN.md', () => 'cid')
    await s.import_()
    expect(s.comments[0].orphaned).toBe(false)
    const origFrom = s.comments[0].from
    // Accept: replace the selection — stored anchor now points at vanished text.
    const spec = s.acceptSuggestion('s1')!
    applyEdit(s, tr => tr.insertText(spec.replacement, spec.from, spec.to))
    // Poll tick: must NOT orphan — local from/to (remapped via onTransaction)
    // are authoritative for known ids.
    await s.refreshComments()
    expect(s.comments[0].orphaned).toBe(false)
    expect(s.comments[0].from).toBe(origFrom)
  })

  it('normalizationDiff: null when round-trip identical, populated otherwise', async () => {
    mockApi.__setContent('# H\n\npara\n')
    const s = createDocSession('a.md', () => 'cid')
    await s.import_()
    expect(s.normalizationDiff).toBeNull()

    mockApi.__setContent('* star bullet\n')
    const s2 = createDocSession('a.md', () => 'cid')
    await s2.import_()
    expect(s2.normalizationDiff).toBe('- star bullet\n')
  })

  it('a CRLF file is written back as CRLF, and an unedited one is not "normalized"', async () => {
    mockApi.__setContent('# H\r\n\r\npara\r\n')
    const s = createDocSession('a.md', () => 'cid')
    await s.import_()
    expect(s.normalizationDiff).toBeNull()
    applyEdit(s, tr => tr.insertText('X', 1, 1))
    await s.commitBack()
    expect(vi.mocked(api.fileWrite).mock.lastCall![1]).toBe('# XH\r\n\r\npara\r\n')
  })

  it('mixed line endings surface as a normalization before anything is written', async () => {
    mockApi.__setContent('# H\r\n\npara\n')
    const s = createDocSession('a.md', () => 'cid')
    await s.import_()
    expect(s.normalizationDiff).toBe('# H\n\npara\n')
  })

  it('a file that is not valid UTF-8 is refused', async () => {
    vi.mocked(api.fileShow).mockResolvedValueOnce({ content: '# caf\uFFFD\n', lossy: true })
    const s = createDocSession('a.md', () => 'cid')
    await s.import_()
    expect(s.error).toContain('not valid UTF-8')
    expect(await s.commitBack()).toBe('noop')
    expect(api.fileWrite).not.toHaveBeenCalled()
  })

  it('commitBack: noop when not dirty', async () => {
    mockApi.__setContent('# H\n')
    const s = createDocSession('a.md', () => 'cid')
    await s.import_()
    expect(s.dirty).toBe(false)
    expect(await s.commitBack()).toBe('noop')
    expect(api.fileWrite).not.toHaveBeenCalled()
  })

  it('acceptSuggestion in table cell: from/to stay within the target cell', async () => {
    // Adjacent text nodes from different cells share a flat-text boundary;
    // toPM at that boundary must prefer the LATER segment or insertText spans
    // the cell boundary and the table restructures.
    const md = '| A | B |\n|---|---|\n| [link](u) | Folded |\n'
    mockApi.__setContent(md)
    mockApi.__setStored([{
      id: 's1', filePath: 'x.md', kind: 'suggestion',
      anchor: { selection: 'Folded', contextBefore: '', contextAfter: '' },
      suggestion: { replacement: 'Archived', baseVersion: 0 },
      body: '', author: 'agent', createdAt: 1,
    }])
    const s = createDocSession('x.md', () => 'cid')
    await s.import_()
    const spec = s.acceptSuggestion('s1')!
    applyEdit(s, tr => tr.insertText(spec.replacement, spec.from, spec.to))
    // Cell B has the replacement; cell A's link text untouched.
    const out = s.serialize()
    expect(out).toContain('| [link](u) | Archived |')
    expect(out).not.toContain('linkArchived')
  })

  it('acceptSuggestion at end of paragraph: replacement does not consume following heading', async () => {
    // `to` at a segment boundary must bias LEFT (end of prev segment), or
    // insertText spans into the heading and PM merges them.
    mockApi.__setContent('intro `code` tail.\n\n## Heading\n')
    mockApi.__setStored([{
      id: 's1', filePath: 'x.md', kind: 'suggestion',
      anchor: { selection: 'tail.', contextBefore: '', contextAfter: '' },
      suggestion: { replacement: 'tail (extended).', baseVersion: 0 },
      body: '', author: 'a', createdAt: 1,
    }])
    const s = createDocSession('x.md', () => 'cid')
    await s.import_()
    const spec = s.acceptSuggestion('s1')!
    applyEdit(s, tr => tr.insertText(spec.replacement, spec.from, spec.to))
    const out = s.serialize()
    expect(out).toContain('intro `code` tail (extended).')
    expect(out).toContain('## Heading')
    expect(out).not.toMatch(/extended\)\.Heading/)
  })

  // Helper: simulate DocView's dispatchTransaction for commitBack tests.
  // Session no longer owns EditorState (DocView does), so tests create one.
  function applyEdit(s: ReturnType<typeof createDocSession>, fn: (tr: Transaction) => Transaction) {
    const st = EditorState.create({ schema: docSchema, doc: s.doc! })
    const tr = fn(st.tr)
    const ns = st.apply(tr)
    s.onTransaction(tr, ns.doc)
  }

  it('commitBack: ok writes serialized doc and clears dirty', async () => {
    mockApi.__setContent('# H\n\npara\n')
    const s = createDocSession('a.md', () => 'cid')
    await s.import_()
    applyEdit(s, tr => tr.insertText('X', 1, 1))
    expect(s.dirty).toBe(true)
    expect(await s.commitBack()).toBe('ok')
    expect(api.fileWrite).toHaveBeenCalledWith('a.md', s.serialize(), { baseCommitId: 'cid' })
    expect(s.dirty).toBe(false)
    expect(s.normalizationDiff).toBeNull()
    // The write's own commit is the base of the next one.
    applyEdit(s, tr => tr.insertText('Y', 1, 1))
    expect(await s.commitBack()).toBe('ok')
    expect(api.fileWrite).toHaveBeenLastCalledWith('a.md', s.serialize(), { baseCommitId: 'cid2' })
  })

  it('commitBack: stale when file changed externally; overwrite forces write', async () => {
    mockApi.__setContent('# H\n\npara\n')
    const s = createDocSession('a.md', () => 'cid')
    await s.import_()
    applyEdit(s, tr => tr.insertText('X', 1, 1))
    vi.mocked(api.fileWrite).mockRejectedValueOnce(new ApiError('changed', 409, 'content_changed'))
    expect(await s.commitBack()).toBe('stale')
    expect(s.dirty).toBe(true)
    await s.overwrite()
    expect(api.fileWrite).toHaveBeenLastCalledWith('a.md', s.serialize(), undefined)
    expect(s.dirty).toBe(false)
  })

  it('reload re-imports and resets dirty', async () => {
    mockApi.__setContent('# H\n')
    const s = createDocSession('a.md', () => 'cid')
    await s.import_()
    applyEdit(s, tr => tr.insertText('X', 1, 1))
    expect(s.dirty).toBe(true)
    mockApi.__setContent('# Different\n')
    await s.reload()
    expect(s.dirty).toBe(false)
    expect(s.doc!.textContent).toBe('Different')
  })

  it('resolveComment + removeComment', async () => {
    mockApi.__setContent(MD)
    const s = createDocSession('docs/DESIGN.md', () => 'abc123')
    await s.import_()
    let pmFrom = -1
    s.doc!.descendants((node, pos) => {
      if (node.isText && node.text?.includes('Another')) {
        pmFrom = pos
        return false
      }
    })
    await s.addComment(pmFrom, pmFrom + 7, 'a')
    const id = s.comments[0].id
    await s.resolveComment(id, 'addressed')
    expect(s.comments[0].resolution).toBe('addressed')
    await s.removeComment(id)
    expect(s.comments).toHaveLength(0)
  })

  it('acceptSuggestion: returns edit spec for placed suggestion, null otherwise', async () => {
    mockApi.__setContent(MD)
    mockApi.__setStored([
      {
        id: 'sg1',
        filePath: 'docs/DESIGN.md',
        anchor: { selection: 'distinctive phrase', contextBefore: 'with a ', contextAfter: ' here' },
        kind: 'suggestion',
        body: 'rephrase',
        suggestion: { replacement: 'memorable wording', baseVersion: 0 },
        author: 'agent',
        createdAt: 1,
      },
      {
        id: 'sg2',
        filePath: 'docs/DESIGN.md',
        anchor: { selection: 'NOWHERE_IN_DOC', contextBefore: '', contextAfter: '' },
        kind: 'suggestion',
        body: 'x',
        suggestion: { replacement: 'y', baseVersion: 0 },
        author: 'agent',
        createdAt: 2,
      },
      {
        id: 'cm1',
        filePath: 'docs/DESIGN.md',
        anchor: { selection: 'distinctive phrase', contextBefore: 'with a ', contextAfter: ' here' },
        kind: 'comment',
        body: 'just a comment',
        author: 'user',
        createdAt: 3,
      },
    ])
    const s = createDocSession('docs/DESIGN.md', () => 'abc123')
    await s.import_()

    const spec = s.acceptSuggestion('sg1')
    expect(spec).not.toBeNull()
    expect(spec!.replacement).toBe('memorable wording')
    expect(s.doc!.textBetween(spec!.from, spec!.to)).toBe('distinctive phrase')

    expect(s.acceptSuggestion('sg2')).toBeNull() // orphaned
    expect(s.acceptSuggestion('cm1')).toBeNull() // not a suggestion
    expect(s.acceptSuggestion('nope')).toBeNull() // unknown id
  })
})
