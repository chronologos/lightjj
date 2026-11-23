import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, fireEvent, waitFor } from '@testing-library/svelte'
import DestinationInput from './DestinationInput.svelte'

vi.mock('./api', () => ({
  api: {
    bookmarks: vi.fn(),
  },
}))

import { api } from './api'
import type { Bookmark } from './api'

const mockBookmarks = api.bookmarks as ReturnType<typeof vi.fn>

function makeBookmark(name: string, overrides: Partial<Bookmark> = {}): Bookmark {
  return {
    name,
    conflict: false,
    synced: false,
    commit_id: 'aaa111',
    ...overrides,
  }
}

function defaultProps(overrides: Record<string, unknown> = {}) {
  return {
    open: true,
    verb: 'Rebase onto',
    onsubmit: vi.fn(),
    ...overrides,
  }
}

const input = (c: HTMLElement) => c.querySelector('.bm-set-input') as HTMLInputElement
const suggestions = (c: HTMLElement) => c.querySelectorAll('.bm-set-suggestion')

describe('DestinationInput', () => {
  beforeEach(() => {
    mockBookmarks.mockReset()
  })

  it('open=false → not rendered', () => {
    mockBookmarks.mockResolvedValue([])
    const { container } = render(DestinationInput, { props: defaultProps({ open: false }) })
    expect(container.querySelector('.bm-set-modal')).not.toBeInTheDocument()
  })

  it('header shows the verb; hint uses its lowercased first word', () => {
    mockBookmarks.mockResolvedValue([])
    const { container } = render(DestinationInput, { props: defaultProps({ verb: 'Squash into' }) })
    expect(container.querySelector('.bm-set-header')?.textContent).toBe('Squash into')
    expect(container.querySelector('.bm-set-hint')?.textContent).toContain('Enter to squash')
  })

  it('raw revset/change_id passes through unmodified when nothing is highlighted', async () => {
    // The defining DestinationInput behavior: input is NOT restricted to
    // bookmark names — jj validates the revset server-side.
    const onsubmit = vi.fn()
    mockBookmarks.mockResolvedValue([makeBookmark('main')])
    const { container } = render(DestinationInput, { props: defaultProps({ onsubmit }) })

    await fireEvent.input(input(container), { target: { value: 'wlykovwr' } })
    await fireEvent.keyDown(input(container), { key: 'Enter' })
    expect(onsubmit).toHaveBeenCalledWith('wlykovwr')
  })

  it('a bookmark name is quoted even when typed in full; anything else is a revset', async () => {
    mockBookmarks.mockResolvedValue([makeBookmark('x|y')])
    for (const [typed, want] of [['x|y', '"x|y"'], ['x | y', 'x | y'], ['x|', 'x|']]) {
      const onsubmit = vi.fn()
      const { container, unmount } = render(DestinationInput, { props: defaultProps({ onsubmit }) })
      await waitFor(() => expect(suggestions(container).length).toBe(1))
      await fireEvent.input(input(container), { target: { value: typed } })
      await fireEvent.keyDown(input(container), { key: 'Enter' })
      expect(onsubmit).toHaveBeenCalledWith(want)
      unmount()
    }
  })

  it('picking closes the modal (closeOnPick) — unlike BookmarkInput, which App closes', async () => {
    const onsubmit = vi.fn()
    mockBookmarks.mockResolvedValue([])
    const { container } = render(DestinationInput, { props: defaultProps({ onsubmit }) })

    await fireEvent.input(input(container), { target: { value: 'dest' } })
    await fireEvent.keyDown(input(container), { key: 'Enter' })
    expect(onsubmit).toHaveBeenCalledWith('dest')
    expect(container.querySelector('.bm-set-modal')).toBeNull()
  })

  it('trunk-pattern bookmarks sort first on empty input; suggestions show short commit_id', async () => {
    mockBookmarks.mockResolvedValue([
      makeBookmark('zz-feature', { commit_id: 'deadbeef1234' }),
      makeBookmark('main', { commit_id: 'cafebabe5678' }),
    ])
    const { container } = render(DestinationInput, { props: defaultProps() })

    await waitFor(() => expect(suggestions(container).length).toBe(2))
    expect(suggestions(container)[0].textContent).toContain('main')
    expect(suggestions(container)[0].textContent).toContain('cafebabe')
  })

  it('ArrowDown highlights a suggestion; Enter submits its name over the typed text', async () => {
    const onsubmit = vi.fn()
    mockBookmarks.mockResolvedValue([
      makeBookmark('feature'),
      makeBookmark('fix-bug'),
    ])
    const { container } = render(DestinationInput, { props: defaultProps({ onsubmit }) })

    await fireEvent.input(input(container), { target: { value: 'f' } })
    await waitFor(() => expect(suggestions(container).length).toBe(2))

    await fireEvent.keyDown(input(container), { key: 'ArrowDown' })
    expect(suggestions(container)[0].classList.contains('active')).toBe(true)

    await fireEvent.keyDown(input(container), { key: 'Enter' })
    expect(onsubmit).toHaveBeenCalledWith('"feature"') // quoted: a name is never revset syntax
  })

  it('mouse hover is a separate dim highlight and never changes what Enter submits', async () => {
    // BookmarkPicker uses the PANEL hover pattern: delegated mousemove over
    // [data-idx] rows sets a JS-tracked .hovered (no :hover CSS rule), while
    // .active stays the keyboard cursor. Index -1 is semantic ("Enter submits
    // the raw text"), so a mouse grazing a row must not turn a typed revset
    // prefix into a bookmark pick.
    const onsubmit = vi.fn()
    mockBookmarks.mockResolvedValue([
      makeBookmark('feature'),
      makeBookmark('fix-bug'),
    ])
    const { container } = render(DestinationInput, { props: defaultProps({ onsubmit }) })

    await fireEvent.input(input(container), { target: { value: 'f' } })
    await waitFor(() => expect(suggestions(container).length).toBe(2))

    // Arrow selection is the single .active; hover is a separate .hovered
    // that clears on mouseleave.
    await fireEvent.keyDown(input(container), { key: 'ArrowDown' })
    expect(suggestions(container)[0].classList.contains('active')).toBe(true)
    await fireEvent.mouseMove(suggestions(container)[1])
    expect(suggestions(container)[1].classList.contains('hovered')).toBe(true)
    expect(suggestions(container)[1].classList.contains('active')).toBe(false)
    expect(suggestions(container)[0].classList.contains('active')).toBe(true)
    await fireEvent.mouseLeave(container.querySelector('.bm-set-suggestions')!)
    expect(container.querySelectorAll('.hovered').length).toBe(0)

    // Typing resets the arrow cursor; with a row hovered, Enter still submits
    // the typed text, not the hovered row.
    await fireEvent.input(input(container), { target: { value: 'fi' } })
    await waitFor(() => expect(suggestions(container).length).toBe(1))
    await fireEvent.mouseMove(suggestions(container)[0])
    expect(suggestions(container)[0].classList.contains('hovered')).toBe(true)
    await fireEvent.keyDown(input(container), { key: 'Enter' })
    expect(onsubmit).toHaveBeenCalledWith('fi')
  })

  it('empty input + hovered row + Enter is a no-op (hover cannot cause a mutation)', async () => {
    const onsubmit = vi.fn()
    mockBookmarks.mockResolvedValue([makeBookmark('main')])
    const { container } = render(DestinationInput, { props: defaultProps({ onsubmit }) })
    await waitFor(() => expect(suggestions(container).length).toBe(1))
    await fireEvent.mouseMove(suggestions(container)[0])
    await fireEvent.keyDown(input(container), { key: 'Enter' })
    expect(onsubmit).not.toHaveBeenCalled()
  })

  it('Escape closes without submitting', async () => {
    const onsubmit = vi.fn()
    mockBookmarks.mockResolvedValue([])
    const { container } = render(DestinationInput, { props: defaultProps({ onsubmit }) })

    await fireEvent.keyDown(input(container), { key: 'Escape' })
    expect(container.querySelector('.bm-set-modal')).toBeNull()
    expect(onsubmit).not.toHaveBeenCalled()
  })

  it('all keys stop propagation — rebase mode must not see them as mode keys', async () => {
    // Load-bearing: inline modes' handleInlineNav swallows ALL keys, so a `d`
    // typed here would otherwise flip rebase targetMode to -d.
    mockBookmarks.mockResolvedValue([])
    const { container } = render(DestinationInput, { props: defaultProps() })

    const seen: string[] = []
    const listener = (e: KeyboardEvent) => { seen.push(e.key) }
    document.addEventListener('keydown', listener)
    await fireEvent.keyDown(input(container), { key: 'd' })
    await fireEvent.keyDown(input(container), { key: 'j' })
    document.removeEventListener('keydown', listener)
    expect(seen).toEqual([])
  })
})
