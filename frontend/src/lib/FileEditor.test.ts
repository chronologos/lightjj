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

  it.each([
    ['LF', 'a\nb\n', 'Xa\nb\n'],
    ['CRLF', 'a\r\nb\r\n', 'Xa\r\nb\r\n'],
    ['mixed', 'a\r\nb\nc\rd', 'Xa\r\nb\nc\rd'],
    ['no final newline', 'a\r\nb', 'Xa\r\nb'],
  ])('saving after a one-character edit changes only that character (%s)', (_, content, want) => {
    const onsave = vi.fn()
    const { container, component } = render(FileEditor, { props: props({ content, onsave }) })
    const view = EditorView.findFromDOM(container.querySelector('.cm-editor') as HTMLElement)!
    view.dispatch({ changes: { from: 0, insert: 'X' } })
    expect((component as unknown as { getContent(): string }).getContent()).toBe(want)
    view.contentDOM.dispatchEvent(new KeyboardEvent('keydown', { key: 's', ctrlKey: true, bubbles: true }))
    view.contentDOM.dispatchEvent(new KeyboardEvent('keydown', { key: 's', metaKey: true, bubbles: true }))
    expect(onsave).toHaveBeenCalledExactlyOnceWith(want)
  })

  it.each(['a\r\nb\r\n', 'a\r\nb\nc\rd'])('a new line in %j keeps the rest intact', (content) => {
    const { container, component } = render(FileEditor, { props: props({ content }) })
    EditorView.findFromDOM(container.querySelector('.cm-editor') as HTMLElement)!
      .dispatch({ changes: { from: 0, insert: ['N', ''].join('\n') } })
    const out = (component as unknown as { getContent(): string }).getContent()
    expect(out).toBe('N' + (content.endsWith('d') ? '\n' : '\r\n') + content)
  })
})
