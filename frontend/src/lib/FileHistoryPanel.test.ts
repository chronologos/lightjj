import { describe, expect, it, vi, beforeEach, type Mock } from 'vitest'
import { fireEvent, render } from '@testing-library/svelte'
import { tick } from 'svelte'

vi.mock('./api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./api')>()
  return {
    ...actual,
    api: { ...actual.api, fileHistory: vi.fn(), diffRange: vi.fn() },
  }
})

import FileHistoryPanel from './FileHistoryPanel.svelte'
import { api, type LogEntry } from './api'

const mockHistory = api.fileHistory as Mock
const mockDiffRange = api.diffRange as Mock

function entry(id: string, desc: string, immutable = false): LogEntry {
  return {
    commit: {
      change_id: id, commit_id: `c_${id}`, change_prefix: 2, commit_prefix: 2,
      is_working_copy: false, hidden: false, immutable, conflicted: false,
      divergent: false, empty: false, mine: true,
      timestamp: '2026-03-20 10:00:00.000 +00:00',
    },
    description: desc,
    graph_lines: [],
  }
}

const REVS = [
  entry('abcdefgh', 'newest change'),
  entry('ijklmnop', 'middle change'),
  entry('qrstuvwx', 'oldest change', true),
]

beforeEach(() => {
  mockHistory.mockReset()
  mockDiffRange.mockReset()
  mockHistory.mockResolvedValue(REVS)
  mockDiffRange.mockResolvedValue({ diff: '' })
})

async function mount(onclose = vi.fn()) {
  const r = render(FileHistoryPanel, { props: { path: 'src/lib/api.ts', onclose } })
  await tick() // history.load effect fires
  await tick() // loader resolves + renders
  return { ...r, onclose }
}

const kd = (c: ReturnType<typeof render>['component'], key: string) =>
  (c as { handleKeydown: (e: KeyboardEvent) => boolean }).handleKeydown(new KeyboardEvent('keydown', { key }))

describe('FileHistoryPanel', () => {
  it('fetches history for the given path on mount', async () => {
    await mount()
    expect(mockHistory).toHaveBeenCalledWith('src/lib/api.ts')
  })

  it('j/k moves cursorB, clamps at bounds', async () => {
    const { component, container } = await mount()
    const cursorRow = () => container.querySelector('.fh-cursor')?.getAttribute('data-idx')

    expect(cursorRow()).toBe('0')
    kd(component, 'j'); await tick(); expect(cursorRow()).toBe('1')
    kd(component, 'j'); await tick(); expect(cursorRow()).toBe('2')
    kd(component, 'j'); await tick(); expect(cursorRow()).toBe('2') // clamp
    kd(component, 'k'); await tick(); expect(cursorRow()).toBe('1')
    kd(component, 'k'); await tick(); expect(cursorRow()).toBe('0')
    kd(component, 'k'); await tick(); expect(cursorRow()).toBe('0') // clamp
  })

  it('Space pins A at current cursorB position', async () => {
    const { component, container } = await mount()
    const pinnedRow = () => container.querySelector('.fh-pinned')?.getAttribute('data-idx')

    expect(pinnedRow()).toBe('0')
    kd(component, 'j')
    kd(component, 'j')
    kd(component, ' ')
    await tick()
    expect(pinnedRow()).toBe('2')
  })

  it('A===B shows empty-state message, no diffRange call', async () => {
    const { container } = await mount()
    expect(container.querySelector('.fh-empty-state')?.textContent).toContain('Same revision')
    expect(mockDiffRange).not.toHaveBeenCalled()
  })

  it('moving B away from A triggers diffRange(B→A) after 50ms debounce', async () => {
    vi.useFakeTimers()
    try {
      const { component } = await mount()
      kd(component, 'j')
      await tick()
      expect(mockDiffRange).not.toHaveBeenCalled()  // debounce not elapsed
      vi.advanceTimersByTime(50)
      // bug_001: from=B(older), to=A(newer) — green shows additions over time.
      expect(mockDiffRange).toHaveBeenCalledWith('c_ijklmnop', 'c_abcdefgh', ['src/lib/api.ts'])
    } finally {
      vi.useRealTimers()
    }
  })

  it('rapid j/k fires only ONE diffRange (debounce coalesces)', async () => {
    vi.useFakeTimers()
    try {
      const { component } = await mount()
      kd(component, 'j'); kd(component, 'j')  // B → index 2
      await tick()
      vi.advanceTimersByTime(50)
      expect(mockDiffRange).toHaveBeenCalledTimes(1)
      expect(mockDiffRange).toHaveBeenCalledWith('c_qrstuvwx', 'c_abcdefgh', ['src/lib/api.ts'])
    } finally {
      vi.useRealTimers()
    }
  })

  it('Escape calls onclose', async () => {
    const { component, onclose } = await mount()
    expect(kd(component, 'Escape')).toBe(true)
    expect(onclose).toHaveBeenCalledOnce()
  })

  it('row click sets cursorB', async () => {
    const { container } = await mount()
    const rows = container.querySelectorAll('.fh-row')
    await fireEvent.click(rows[2])
    expect(container.querySelector('.fh-cursor')?.getAttribute('data-idx')).toBe('2')
  })

  it('immutable rows are dimmed', async () => {
    const { container } = await mount()
    const rows = container.querySelectorAll('.fh-row')
    expect(rows[2].classList.contains('fh-immutable')).toBe(true)
    expect(rows[0].classList.contains('fh-immutable')).toBe(false)
  })

  it('handleKeydown returns true only for consumed keys', async () => {
    const { component } = await mount()
    expect(kd(component, 'j')).toBe(true)
    expect(kd(component, 'ArrowUp')).toBe(true)
    expect(kd(component, ' ')).toBe(true)
    expect(kd(component, 'x')).toBe(false)
  })
})
