import { describe, it, expect, vi } from 'vitest'
import { render, fireEvent } from '@testing-library/svelte'
import OplogPanel from './OplogPanel.svelte'
import type { OpEntry } from './api'

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
})
