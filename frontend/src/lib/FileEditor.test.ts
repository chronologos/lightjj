import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, cleanup } from '@testing-library/svelte'
import { EditorView } from '@codemirror/view'
import FileEditor from './FileEditor.svelte'

afterEach(cleanup)

const props = (over = {}) => ({
  content: 'alpha\nbeta\n', filePath: 'a.txt', changedRanges: [{ fromLine: 1, toLine: 1 }],
  onsave: vi.fn(), oncancel: vi.fn(), ...over,
})

describe('FileEditor', () => {
  // A diff refresh hands the editor fresh props (new changedRanges array every
  // time). Unsaved text must survive all of them.
  it('keeps unsaved text across prop changes', async () => {
    const { container, rerender, component } = render(FileEditor, { props: props() })
    const el = container.querySelector('.cm-editor') as HTMLElement
    EditorView.findFromDOM(el)!.dispatch({ changes: { from: 0, insert: 'MINE ' } })

    await rerender(props())
    await rerender(props({ changedRanges: [{ fromLine: 2, toLine: 2 }], content: 'changed on disk\n' }))

    expect(container.querySelector('.cm-editor')).toBe(el)
    expect((component as unknown as { getContent(): string }).getContent()).toBe('MINE alpha\nbeta\n')
  })
})
