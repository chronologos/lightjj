import { describe, it, expect, vi } from 'vitest'
import { render, fireEvent } from '@testing-library/svelte'
import EvologPanel from './EvologPanel.svelte'
import type { EvologEntry } from './api'

function makeEntry(commit_id: string, preds: string[] = [], diff = ''): EvologEntry {
  return {
    commit_id,
    time: '2026-02-27 15:03:07.123456789 +00:00',
    operation: 'snapshot working copy',
    predecessor_ids: preds,
    diff,
  }
}

function defaultProps(overrides: Record<string, unknown> = {}) {
  return {
    entries: [] as EvologEntry[],
    loading: false,
    selectedRevision: null,
    height: 360,
    onrefresh: vi.fn(),
    onclose: vi.fn(),
    ...overrides,
  }
}

describe('EvologPanel', () => {
  describe('rendering', () => {
    it('shows spinner when loading with no entries', () => {
      const { container } = render(EvologPanel, { props: defaultProps({ loading: true }) })
      expect(container.querySelector('.spinner')).toBeInTheDocument()
    })

    it('renders entries', () => {
      const entries = [makeEntry('aaa111', ['bbb222']), makeEntry('bbb222', [])]
      const { container } = render(EvologPanel, { props: defaultProps({ entries }) })
      const rows = container.querySelectorAll('.evolog-entry')
      expect(rows).toHaveLength(2)
      expect(rows[0].classList.contains('current')).toBe(true)
      expect(rows[1].classList.contains('origin')).toBe(true)
    })

    it('applies height prop', () => {
      const { container } = render(EvologPanel, { props: defaultProps({ height: 500 }) })
      const panel = container.querySelector('.evolog-panel') as HTMLElement
      expect(panel.style.height).toBe('500px')
    })
  })

  describe('keyboard navigation', () => {
    const entries = [
      makeEntry('aaa', ['bbb']),
      makeEntry('bbb', ['ccc']),
      makeEntry('ccc', []),
    ]

    it('ArrowDown selects first entry when nothing is selected', async () => {
      const { container } = render(EvologPanel, { props: defaultProps({ entries }) })
      const list = container.querySelector('.entry-list')!
      await fireEvent.keyDown(list, { key: 'ArrowDown' })
      const rows = container.querySelectorAll('.evolog-entry')
      expect(rows[0].classList.contains('selected')).toBe(true)
    })

    it('ArrowUp selects first entry when nothing is selected', async () => {
      const { container } = render(EvologPanel, { props: defaultProps({ entries }) })
      const list = container.querySelector('.entry-list')!
      await fireEvent.keyDown(list, { key: 'ArrowUp' })
      const rows = container.querySelectorAll('.evolog-entry')
      expect(rows[0].classList.contains('selected')).toBe(true)
    })

    it('ArrowDown advances selection and clamps at last entry', async () => {
      const { container } = render(EvologPanel, { props: defaultProps({ entries }) })
      const list = container.querySelector('.entry-list')!
      for (let i = 0; i < 5; i++) await fireEvent.keyDown(list, { key: 'ArrowDown' })
      const rows = container.querySelectorAll('.evolog-entry')
      expect(rows[2].classList.contains('selected')).toBe(true)
      expect(rows[0].classList.contains('selected')).toBe(false)
    })

    it('ArrowUp retreats selection and clamps at first entry', async () => {
      const { container } = render(EvologPanel, { props: defaultProps({ entries }) })
      const list = container.querySelector('.entry-list')!
      await fireEvent.keyDown(list, { key: 'ArrowDown' })
      await fireEvent.keyDown(list, { key: 'ArrowDown' })
      for (let i = 0; i < 5; i++) await fireEvent.keyDown(list, { key: 'ArrowUp' })
      const rows = container.querySelectorAll('.evolog-entry')
      expect(rows[0].classList.contains('selected')).toBe(true)
    })

    it('no-op when entries is empty', async () => {
      const { container } = render(EvologPanel, { props: defaultProps({ entries: [] }) })
      const list = container.querySelector('.entry-list')!
      await fireEvent.keyDown(list, { key: 'ArrowDown' })
      expect(container.querySelector('.evolog-entry.selected')).toBeNull()
    })
  })

  describe('diff display', () => {
    it('shows "click an entry" prompt when nothing selected', () => {
      const entries = [makeEntry('aaa', ['bbb'])]
      const { container } = render(EvologPanel, { props: defaultProps({ entries }) })
      expect(container.querySelector('.diff-area')?.textContent).toContain('Click an entry')
    })

    it('shows "initial entry" message for origin entry', async () => {
      const entries = [makeEntry('aaa', [])]
      const { container } = render(EvologPanel, { props: defaultProps({ entries }) })
      const list = container.querySelector('.entry-list')!
      await fireEvent.keyDown(list, { key: 'ArrowDown' })
      expect(container.querySelector('.diff-area')?.textContent).toContain('Initial entry')
    })

    it('shows "no changes" for metadata-only op (empty diff)', async () => {
      const entries = [makeEntry('aaa', ['bbb'], '')]
      const { container } = render(EvologPanel, { props: defaultProps({ entries }) })
      const list = container.querySelector('.entry-list')!
      await fireEvent.keyDown(list, { key: 'ArrowDown' })
      expect(container.querySelector('.diff-area')?.textContent).toContain('No changes')
    })
  })
})
