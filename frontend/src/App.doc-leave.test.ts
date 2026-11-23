// Leaving doc mode with unsaved edits. Separate file: it swaps the ProseMirror
// session for a stub, which must not leak into App.interactions.test.ts.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, fireEvent, cleanup } from '@testing-library/svelte'

const doc = vi.hoisted(() => ({ dirty: true, sessions: 0 }))
vi.mock('./lib/api', async (orig) => {
  const real = await orig<typeof import('./lib/api')>()
  const m = await import('./testutil/mock-api')
  return { ...real, ...m.netStubs }
})
vi.mock('./lib/doc-session.svelte', () => ({
  createDocSession: () => {
    doc.sessions++
    return {
      doc: null, comments: [], openComments: [], orphanedComments: [], saving: false, error: '', busy: false,
      normalizationDiff: null, baseCommitId: '', get dirty() { return doc.dirty },
      import_: async () => {}, refreshComments: async () => {}, commitBack: async () => 'ok', overwrite: async () => {}, reload: async () => {},
    }
  },
}))
vi.stubGlobal('fetch', async () => new Response(null, { status: 204 }))

import App from './App.svelte'
import { resetMockApi, setFixtures, defaultFixtures, mkFileChange, triggerNavigate } from './testutil/mock-api'
import { waitFor } from './testutil/wait-for'

const qs = (s: string) => document.querySelector(s)
const inDoc = () => qs('.doc-mode-layout') !== null
const press = (key: string) => fireEvent.keyDown(document.body, { key })
const button = (root: string, text: string) =>
  [...document.querySelectorAll(`${root} button`)].find(b => b.textContent?.includes(text)) as HTMLElement | undefined
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

let confirmSpy: ReturnType<typeof vi.spyOn>
beforeEach(async () => {
  resetMockApi(); cleanup()
  doc.dirty = true; doc.sessions = 0
  confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false) as never
})
afterEach(() => confirmSpy.mockRestore())

async function openDoc() {
  const f = defaultFixtures()
  setFixtures({
    diffs: { ...f.diffs, kwc: 'diff --git a/d.md b/d.md\n--- a/d.md\n+++ b/d.md\n@@ -1 +1 @@\n-a\n+b\n' },
    files: { ...f.files, kwc: [mkFileChange({ path: 'd.md' })] },
  })
  const r = render(App)
  await waitFor(() => button('.diff-file', 'Doc') !== undefined)
  if (qs('.welcome-modal')) await fireEvent.keyDown(qs('.welcome-modal')!, { key: 'Escape' }) // first mount only
  await fireEvent.click(button('.diff-file', 'Doc')!)
  await waitFor(inDoc)
  return r
}

const exits: [string, () => unknown][] = [
  ['Escape', () => press('Escape')],
  ['1', () => press('1')],
  ['2', () => press('2')],
  ['3', () => press('3')],
  ['5 (evolog)', () => press('5')],
  ['× button', () => fireEvent.click(qs('.doc-mode-header .close-btn')!)],
  ['Revisions tab', () => fireEvent.click(button('body', 'Revisions')!)],
]

describe('leaving doc mode', () => {
  it.each(exits)('%s: declining stays in the document', async (_, exit) => {
    await openDoc()
    await exit()
    await sleep(40)
    expect(confirmSpy).toHaveBeenCalledTimes(1)
    expect(confirmSpy).toHaveBeenCalledWith('Discard unsaved changes to d.md?')
    expect(inDoc()).toBe(true)
    expect(doc.sessions).toBe(1)
    expect(qs('.evolog-panel')).toBeNull() // and doesn't half-apply
  })

  it.each(exits)('%s: a clean document leaves without asking', async (_, exit) => {
    await openDoc()
    doc.dirty = false
    await exit()
    await waitFor(() => !inDoc())
    expect(confirmSpy).not.toHaveBeenCalled()
  })

  it('accepting tears the session down: nothing is left to prompt about', async () => {
    const { component } = await openDoc()
    confirmSpy.mockReturnValue(true as never)
    await press('1')
    await waitFor(() => !inDoc())
    expect(component.confirmLeaveTab()).toBe(true)
    expect(confirmSpy).toHaveBeenCalledTimes(1)
  })

  it('guards tab switch; agent navigate is refused without a prompt', async () => {
    const { component } = await openDoc()
    triggerNavigate({ change_id: 'cmid' })
    await waitFor(() => qs('.message-text')?.textContent?.includes('Agent navigate ignored') === true)
    expect(confirmSpy).not.toHaveBeenCalled()
    expect(component.confirmLeaveTab()).toBe(false)
    expect(inDoc()).toBe(true)
  })
})
