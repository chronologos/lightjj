import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/svelte'
import AnnotationBubble from './AnnotationBubble.svelte'
import type { Annotation } from './api'

function defaultProps(overrides: Record<string, unknown> = {}) {
  return {
    open: true,
    x: 100,
    y: 100,
    editing: null,
    lineContext: { filePath: 'foo.go', lineNum: 42, lineContent: 'log.Println()' },
    onsave: vi.fn(),
    ondelete: undefined,
    onclose: vi.fn(),
    ...overrides,
  }
}

function mkAnn(overrides: Partial<Annotation> = {}): Annotation {
  return {
    id: 'a1', changeId: 'xyz', filePath: 'foo.go', lineNum: 42,
    lineContent: 'log.Println()', comment: 'existing comment', severity: 'must-fix',
    createdAt: 0, createdAtCommitId: 'abc', status: 'open',
    ...overrides,
  }
}

describe('AnnotationBubble', () => {
  it('renders nothing when open=false', () => {
    render(AnnotationBubble, { props: defaultProps({ open: false }) })
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('shows line context in header', () => {
    render(AnnotationBubble, { props: defaultProps() })
    expect(screen.getByText('foo.go:42')).toBeInTheDocument()
  })

  it('create mode: empty textarea, default severity, no delete button', () => {
    render(AnnotationBubble, { props: defaultProps({ editing: null }) })
    const textarea = screen.getByPlaceholderText(/Review comment/i) as HTMLTextAreaElement
    expect(textarea.value).toBe('')
    const select = screen.getByRole('combobox') as HTMLSelectElement
    expect(select.value).toBe('suggestion')
    expect(screen.queryByText('Delete')).toBeNull()
  })

  it('edit mode: populates from existing annotation', () => {
    render(AnnotationBubble, { props: defaultProps({ editing: mkAnn() }) })
    const textarea = screen.getByPlaceholderText(/Review comment/i) as HTMLTextAreaElement
    expect(textarea.value).toBe('existing comment')
    const select = screen.getByRole('combobox') as HTMLSelectElement
    expect(select.value).toBe('must-fix')
  })

  it('edit mode: shows delete button when ondelete provided', () => {
    const ondelete = vi.fn()
    render(AnnotationBubble, { props: defaultProps({ editing: mkAnn(), ondelete }) })
    expect(screen.getByText('Delete')).toBeInTheDocument()
  })

  it('save button disabled until comment has non-whitespace content', async () => {
    render(AnnotationBubble, { props: defaultProps() })
    const saveBtn = screen.getByText('Save') as HTMLButtonElement
    expect(saveBtn.disabled).toBe(true)

    const textarea = screen.getByPlaceholderText(/Review comment/i)
    await fireEvent.input(textarea, { target: { value: '   ' } })
    expect(saveBtn.disabled).toBe(true) // whitespace only

    await fireEvent.input(textarea, { target: { value: 'fix this' } })
    expect(saveBtn.disabled).toBe(false)
  })

  it('onsave fires with trimmed comment and severity', async () => {
    const onsave = vi.fn()
    render(AnnotationBubble, { props: defaultProps({ onsave }) })

    const textarea = screen.getByPlaceholderText(/Review comment/i)
    await fireEvent.input(textarea, { target: { value: '  fix this  ' } })
    const select = screen.getByRole('combobox')
    await fireEvent.change(select, { target: { value: 'must-fix' } })
    await fireEvent.click(screen.getByText('Save'))

    expect(onsave).toHaveBeenCalledWith('fix this', 'must-fix')
  })

  it('Cmd+Enter saves', async () => {
    const onsave = vi.fn()
    render(AnnotationBubble, { props: defaultProps({ onsave }) })

    const textarea = screen.getByPlaceholderText(/Review comment/i)
    await fireEvent.input(textarea, { target: { value: 'fix this' } })
    // keydown on the dialog element — handler is on the bubble div
    await fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Enter', metaKey: true })

    expect(onsave).toHaveBeenCalledWith('fix this', 'suggestion')
  })

  it('Ctrl+Enter also saves (non-mac)', async () => {
    const onsave = vi.fn()
    render(AnnotationBubble, { props: defaultProps({ onsave }) })

    const textarea = screen.getByPlaceholderText(/Review comment/i)
    await fireEvent.input(textarea, { target: { value: 'x' } })
    await fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Enter', ctrlKey: true })

    expect(onsave).toHaveBeenCalled()
  })

  it('Escape closes without saving', async () => {
    const onsave = vi.fn()
    const onclose = vi.fn()
    render(AnnotationBubble, { props: defaultProps({ onsave, onclose }) })

    const textarea = screen.getByPlaceholderText(/Review comment/i)
    await fireEvent.input(textarea, { target: { value: 'x' } })
    await fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' })

    expect(onsave).not.toHaveBeenCalled()
    expect(onclose).toHaveBeenCalled()
  })

  it('Cancel button closes without saving', async () => {
    const onsave = vi.fn()
    const onclose = vi.fn()
    render(AnnotationBubble, { props: defaultProps({ onsave, onclose }) })

    await fireEvent.input(screen.getByPlaceholderText(/Review comment/i), { target: { value: 'x' } })
    await fireEvent.click(screen.getByText('Cancel'))

    expect(onsave).not.toHaveBeenCalled()
    expect(onclose).toHaveBeenCalled()
  })

  it('Delete button fires ondelete and closes', async () => {
    const ondelete = vi.fn()
    const onclose = vi.fn()
    render(AnnotationBubble, { props: defaultProps({ editing: mkAnn(), ondelete, onclose }) })

    await fireEvent.click(screen.getByText('Delete'))

    expect(ondelete).toHaveBeenCalled()
    expect(onclose).toHaveBeenCalled()
  })

  it('backdrop click closes', async () => {
    const onclose = vi.fn()
    render(AnnotationBubble, { props: defaultProps({ onclose }) })

    // Backdrop is the first presentation-role element (before the dialog)
    const backdrop = screen.getByRole('presentation')
    await fireEvent.click(backdrop)

    expect(onclose).toHaveBeenCalled()
  })

  it('save does not fire with empty comment on Cmd+Enter', async () => {
    const onsave = vi.fn()
    render(AnnotationBubble, { props: defaultProps({ onsave }) })

    await fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Enter', metaKey: true })

    expect(onsave).not.toHaveBeenCalled()
  })

  it("severity select omits 'reviewed' (checkbox is the sole marker affordance)", () => {
    render(AnnotationBubble, { props: defaultProps() })
    const options = [...(screen.getByRole('combobox') as HTMLSelectElement).options].map(o => o.value)
    expect(options).toEqual(['must-fix', 'suggestion', 'question', 'nitpick'])
  })

  it('file-level (lineNum=0): context label shows path without :line', () => {
    render(AnnotationBubble, { props: defaultProps({
      lineContext: { filePath: 'src/a.go', lineNum: 0, lineContent: '' },
    }) })
    expect(screen.getByText('src/a.go')).toBeTruthy()
  })

  it('editing → re-open populates fresh state (reset effect)', async () => {
    // Simulate reuse: open with one annotation, close, open with another.
    // The $effect should re-populate on each open.
    const { rerender } = render(AnnotationBubble, {
      props: defaultProps({ editing: mkAnn({ comment: 'first', severity: 'must-fix' }) }),
    })
    let textarea = screen.getByPlaceholderText(/Review comment/i) as HTMLTextAreaElement
    expect(textarea.value).toBe('first')

    // Close + reopen with different editing annotation
    await rerender(defaultProps({ open: false }))
    await rerender(defaultProps({ editing: mkAnn({ comment: 'second', severity: 'nitpick' }) }))

    textarea = screen.getByPlaceholderText(/Review comment/i) as HTMLTextAreaElement
    expect(textarea.value).toBe('second')
    expect((screen.getByRole('combobox') as HTMLSelectElement).value).toBe('nitpick')
  })
})
