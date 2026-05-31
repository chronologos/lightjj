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
    expect(onsubmit).toHaveBeenCalledWith('feature')
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
