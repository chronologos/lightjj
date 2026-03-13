import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest'
import { render, fireEvent } from '@testing-library/svelte'
import { tick } from 'svelte'

// Mock api BEFORE component import — OplogPanel's toggleExpand calls api.opShow
// at event time. importOriginal keeps pure helpers + types.
vi.mock('./api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./api')>()
  return {
    ...actual,
    api: { ...actual.api, opShow: vi.fn() },
  }
})

import OplogPanel from './OplogPanel.svelte'
import { api, type OpEntry } from './api'

const mockOpShow = api.opShow as Mock
beforeEach(() => mockOpShow.mockReset())

function defaultProps(overrides: Record<string, unknown> = {}) {
  return {
    entries: [] as OpEntry[],
    loading: false,
    error: '',
    onrefresh: vi.fn(),
    onclose: vi.fn(),
    ...overrides,
  }
}

function makeEntry(id: string, current = false): OpEntry {
  return { id, description: `op ${id}`, time: '2 hours ago', is_current: current }
}

describe('OplogPanel', () => {
  it('shows spinner when loading', () => {
    const { container } = render(OplogPanel, { props: defaultProps({ loading: true }) })
    expect(container.querySelector('.spinner')).toBeInTheDocument()
    expect(container.textContent).toContain('Loading operations')
  })

  it('renders entries when not loading', () => {
    const entries = [makeEntry('abc123', true), makeEntry('def456')]
    const { container } = render(OplogPanel, { props: defaultProps({ entries }) })
    const rows = container.querySelectorAll('.oplog-entry')
    expect(rows).toHaveLength(2)
    expect(rows[0].classList.contains('oplog-current')).toBe(true)
    expect(rows[1].classList.contains('oplog-current')).toBe(false)
  })

  it('shows inline error instead of entries when error is set', () => {
    const entries = [makeEntry('abc123')] // would normally render
    const { container } = render(OplogPanel, {
      props: defaultProps({ entries, error: 'connection refused' }),
    })
    expect(container.querySelector('.error-state')).toBeInTheDocument()
    expect(container.textContent).toContain('connection refused')
    // Entries should be hidden while error is shown
    expect(container.querySelectorAll('.oplog-entry')).toHaveLength(0)
  })

  it('error state includes retry button that calls onrefresh', async () => {
    const onrefresh = vi.fn()
    const { container } = render(OplogPanel, {
      props: defaultProps({ error: 'timeout', onrefresh }),
    })
    const retryBtn = [...container.querySelectorAll('button')].find(b => b.textContent?.includes('Retry'))
    expect(retryBtn).toBeDefined()
    await fireEvent.click(retryBtn!)
    expect(onrefresh).toHaveBeenCalledOnce()
  })

  it('clearing error reveals entries again', async () => {
    const entries = [makeEntry('abc')]
    const { container, rerender } = render(OplogPanel, {
      props: defaultProps({ entries, error: 'boom' }),
    })
    expect(container.querySelectorAll('.oplog-entry')).toHaveLength(0)

    await rerender(defaultProps({ entries, error: '' }))
    expect(container.querySelectorAll('.oplog-entry')).toHaveLength(1)
    expect(container.querySelector('.error-state')).toBeNull()
  })

  it('shows "No operations" empty state', () => {
    const { container } = render(OplogPanel, { props: defaultProps({ entries: [] }) })
    expect(container.textContent).toContain('No operations')
  })

  describe('keyboard navigation', () => {
    const entries = [makeEntry('a', true), makeEntry('b'), makeEntry('c')]
    const list = (c: HTMLElement) => c.querySelector('.oplog-content')!

    it('j selects first entry when nothing is selected', async () => {
      const { container } = render(OplogPanel, { props: defaultProps({ entries }) })
      await fireEvent.keyDown(list(container), { key: 'j' })
      expect(container.querySelectorAll('.oplog-entry')[0].classList.contains('selected')).toBe(true)
    })

    it('j/k advance and clamp at boundaries', async () => {
      const { container } = render(OplogPanel, { props: defaultProps({ entries }) })
      for (let i = 0; i < 5; i++) await fireEvent.keyDown(list(container), { key: 'j' })
      const rows = container.querySelectorAll('.oplog-entry')
      expect(rows[2].classList.contains('selected')).toBe(true)
      for (let i = 0; i < 5; i++) await fireEvent.keyDown(list(container), { key: 'k' })
      expect(rows[0].classList.contains('selected')).toBe(true)
    })

    it('Escape fires onclose even when entries is empty', async () => {
      // Guard order: Escape checked BEFORE entries.length === 0 bail.
      const onclose = vi.fn()
      const { container } = render(OplogPanel, { props: defaultProps({ entries: [], onclose }) })
      await fireEvent.keyDown(list(container), { key: 'Escape' })
      expect(onclose).toHaveBeenCalledOnce()
    })

    it('click syncs selectedIdx', async () => {
      const { container } = render(OplogPanel, { props: defaultProps({ entries }) })
      const rows = container.querySelectorAll('.oplog-entry')
      await fireEvent.click(rows[1])
      expect(rows[1].classList.contains('selected')).toBe(true)
      expect(rows[0].classList.contains('selected')).toBe(false)
    })

    it('entries change resets selection (index-based, prepend would shift)', async () => {
      const { container, rerender } = render(OplogPanel, { props: defaultProps({ entries }) })
      await fireEvent.keyDown(list(container), { key: 'j' })
      await fireEvent.keyDown(list(container), { key: 'j' })  // select idx 1
      expect(container.querySelectorAll('.oplog-entry')[1].classList.contains('selected')).toBe(true)

      await rerender(defaultProps({ entries: [makeEntry('new'), ...entries] }))
      expect(container.querySelector('.oplog-entry.selected')).toBeNull()
    })

    it('Enter fetches op show and expands below the selected row', async () => {
      mockOpShow.mockResolvedValue({ output: 'Changed commits:\n+ abc\n- def' })
      const { container } = render(OplogPanel, { props: defaultProps({ entries }) })
      await fireEvent.keyDown(list(container), { key: 'j' })   // select idx 0 = 'a'
      await fireEvent.keyDown(list(container), { key: 'Enter' })
      expect(mockOpShow).toHaveBeenCalledWith('a')
      await tick()
      const expand = container.querySelector('.oplog-expand')
      expect(expand?.textContent).toContain('Changed commits')
      // Second Enter collapses — no refetch
      await fireEvent.keyDown(list(container), { key: 'Enter' })
      expect(mockOpShow).toHaveBeenCalledOnce()
      expect(container.querySelector('.oplog-expand')).toBeNull()
    })

    it('Enter is no-op when nothing selected', async () => {
      const { container } = render(OplogPanel, { props: defaultProps({ entries }) })
      await fireEvent.keyDown(list(container), { key: 'Enter' })
      expect(mockOpShow).not.toHaveBeenCalled()
      expect(container.querySelector('.oplog-expand')).toBeNull()
    })

    it('stale fetch does not overwrite newer expansion', async () => {
      // Post-await guard: user expands A, then B while A's fetch is in flight.
      // A's late resolution must not clobber B's output.
      let resolveA!: (v: { output: string }) => void
      mockOpShow
        .mockImplementationOnce(() => new Promise(r => { resolveA = r }))
        .mockResolvedValueOnce({ output: 'B output' })

      const { container } = render(OplogPanel, { props: defaultProps({ entries }) })
      await fireEvent.keyDown(list(container), { key: 'j' })       // idx 0 = 'a'
      await fireEvent.keyDown(list(container), { key: 'Enter' })   // A fetch hangs
      await fireEvent.keyDown(list(container), { key: 'j' })       // idx 1 = 'b'
      await fireEvent.keyDown(list(container), { key: 'Enter' })   // B fetch resolves
      await tick()
      expect(container.querySelector('.oplog-expand')?.textContent).toBe('B output')

      resolveA({ output: 'A output (stale)' })
      await tick()
      expect(container.querySelector('.oplog-expand')?.textContent).toBe('B output')
    })

    it('entries change wipes expansion', async () => {
      mockOpShow.mockResolvedValue({ output: 'details' })
      const { container, rerender } = render(OplogPanel, { props: defaultProps({ entries }) })
      await fireEvent.keyDown(list(container), { key: 'j' })
      await fireEvent.keyDown(list(container), { key: 'Enter' })
      await tick()
      expect(container.querySelector('.oplog-expand')).not.toBeNull()

      await rerender(defaultProps({ entries: [makeEntry('new'), ...entries] }))
      expect(container.querySelector('.oplog-expand')).toBeNull()
    })

    it('right-click opens context menu; first item is Show details', async () => {
      const oncontextmenu = vi.fn()
      const { container } = render(OplogPanel, { props: defaultProps({ entries, oncontextmenu }) })
      const rows = container.querySelectorAll('.oplog-entry')
      await fireEvent.contextMenu(rows[0], { clientX: 10, clientY: 20 })
      expect(oncontextmenu).toHaveBeenCalledOnce()
      const [items] = oncontextmenu.mock.calls[0]
      expect(items[0].label).toBe('Show details')
      expect(items[0].shortcut).toBe('Enter')
    })
  })
})
