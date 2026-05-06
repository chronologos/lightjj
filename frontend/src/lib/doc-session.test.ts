import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { DocComment } from './api'

// In-memory backend stub. Declared inside the factory so vi.mock hoisting
// doesn't reference uninitialized module-scope vars.
vi.mock('./api', () => {
  let stored: DocComment[] = []
  let content = ''
  return {
    api: {
      fileShow: vi.fn(async () => ({ content })),
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
      __reset: () => { stored = []; content = '' },
    },
  }
})

import { createDocSession } from './doc-session.svelte'
import { api } from './api'

const mockApi = api as typeof api & { __setContent: (s: string) => void; __reset: () => void }

const MD = `# Design

This is the first paragraph with a distinctive phrase here.

## Section two

Another paragraph follows.`

beforeEach(() => mockApi.__reset())

describe('createDocSession', () => {
  it('import_ populates state from fileShow', async () => {
    mockApi.__setContent(MD)
    const s = createDocSession('docs/DESIGN.md', () => 'abc123')
    await s.import_()
    expect(s.state).not.toBeNull()
    expect(s.state!.doc.textContent).toContain('distinctive phrase')
    expect(s.error).toBe('')
    expect(s.baseCommitId).toBe('abc123')
  })

  it('import_ surfaces error when working copy unavailable', async () => {
    const s = createDocSession('x.md', () => undefined)
    await s.import_()
    expect(s.state).toBeNull()
    expect(s.error).toContain('working copy')
  })

  it('addComment captures anchor and persists', async () => {
    mockApi.__setContent(MD)
    const s = createDocSession('docs/DESIGN.md', () => 'abc123')
    await s.import_()
    // Find PM positions for "distinctive phrase" by scanning textContent.
    const flat = s.state!.doc.textContent
    const tFrom = flat.indexOf('distinctive')
    expect(tFrom).toBeGreaterThan(0)
    // textContent offsets ≠ PM positions, so we use the public API: select by
    // searching the doc. For the test, walk to find the text node.
    let pmFrom = -1
    s.state!.doc.descendants((node, pos) => {
      if (node.isText && node.text?.includes('distinctive')) {
        pmFrom = pos + node.text.indexOf('distinctive')
        return false
      }
    })
    expect(pmFrom).toBeGreaterThan(0)
    const pmTo = pmFrom + 'distinctive phrase'.length

    await s.addComment(pmFrom, pmTo, 'please clarify')
    expect(s.comments).toHaveLength(1)
    const c = s.comments[0]
    expect(c.anchor.selection).toBe('distinctive phrase')
    expect(c.anchor.contextBefore.endsWith('with a ')).toBe(true)
    expect(c.from).toBe(pmFrom)
    expect(c.orphaned).toBe(false)
    expect(api.docComments.upsert).toHaveBeenCalledOnce()
  })

  it('round-trip: comment re-found at same PM position after re-import', async () => {
    mockApi.__setContent(MD)
    const s = createDocSession('docs/DESIGN.md', () => 'abc123')
    await s.import_()
    let pmFrom = -1
    s.state!.doc.descendants((node, pos) => {
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
    s.state!.doc.descendants((node, pos) => {
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

  it('resolveComment + removeComment', async () => {
    mockApi.__setContent(MD)
    const s = createDocSession('docs/DESIGN.md', () => 'abc123')
    await s.import_()
    let pmFrom = -1
    s.state!.doc.descendants((node, pos) => {
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
})
