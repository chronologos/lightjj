import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, fireEvent, cleanup } from '@testing-library/svelte'
import { EditorView } from '@codemirror/view'
import ConfigModal from './ConfigModal.svelte'
import { createUnsaved, UNSAVED_KEY } from './unsaved'
import { waitFor } from '../testutil/wait-for'
import { parse as parseJsonc } from 'jsonc-parser'

describe('jsonc-parser integration', () => {
  it('parses JSONC with comments and trailing commas', () => {
    const text = `{
      // my comment
      "theme": "dark",
      "splitView": true, // trailing
    }`
    const obj = parseJsonc(text)
    expect(obj.theme).toBe('dark')
    expect(obj.splitView).toBe(true)
  })

  it('surfaces errors via the errors array for malformed input', () => {
    // jsonc-parser 3.3.1's default parse swallows errors and returns `{}`
    // (not undefined) on a fundamentally broken document — the save path
    // therefore MUST pass an errors array and check errors.length > 0 to
    // distinguish "valid empty object" from "broken input".
    const errors: Array<{ error: number; offset: number; length: number }> = []
    const obj = parseJsonc('{not json', errors)
    expect(obj).toEqual({})
    expect(errors.length).toBeGreaterThan(0)
  })
})

describe('closing with changed text', () => {
  let confirmSpy: ReturnType<typeof vi.spyOn>
  beforeEach(() => {
    vi.stubGlobal('fetch', async () => new Response('{"a": 1}'))
    confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false) as never
  })
  afterEach(() => { cleanup(); confirmSpy.mockRestore(); vi.unstubAllGlobals() })

  async function open(edit: boolean) {
    const onclose = vi.fn(), unsaved = createUnsaved()
    const r = render(ConfigModal, { props: { open: true, onclose, onerror: vi.fn() }, context: new Map([[UNSAVED_KEY, unsaved]]) })
    await waitFor(() => r.container.querySelector('.cm-editor') !== null)
    if (edit) EditorView.findFromDOM(r.container.querySelector('.cm-editor') as HTMLElement)!.dispatch({ changes: { from: 0, insert: ' ' } })
    const ways: [string, () => unknown][] = [
      ['backdrop', () => fireEvent.click(r.container.querySelector('.modal-backdrop')!)],
      ['Cancel', () => fireEvent.click([...r.container.querySelectorAll('button')].find(b => b.textContent === 'Cancel')!)],
      ['requestClose', () => (r.component as unknown as { requestClose(): boolean }).requestClose()],
    ]
    return { onclose, unsaved, ways }
  }

  it('asks, stays open when declined, closes when accepted; counts for tab switch and reload only', async () => {
    const { onclose, unsaved, ways } = await open(true)
    expect([unsaved.any('selection'), unsaved.any('view'), unsaved.any('tab')]).toEqual([false, false, true])
    for (const [, close] of ways) await close()
    expect(confirmSpy).toHaveBeenCalledTimes(ways.length)
    expect(onclose).not.toHaveBeenCalled()
    confirmSpy.mockReturnValue(true as never)
    await ways[0][1]()
    expect(onclose).toHaveBeenCalledTimes(1)
  })

  it('untouched text closes without asking', async () => {
    const { onclose, ways } = await open(false)
    for (const [, close] of ways) await close()
    expect(confirmSpy).not.toHaveBeenCalled()
    expect(onclose).toHaveBeenCalledTimes(ways.length)
  })
})
