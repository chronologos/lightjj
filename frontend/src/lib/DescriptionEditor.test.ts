import { describe, it, expect, vi } from 'vitest'
import { render, fireEvent } from '@testing-library/svelte'
import DescriptionEditor from './DescriptionEditor.svelte'
import type { LogEntry } from './api'

function makeRevision(): LogEntry {
  return {
    commit: {
      change_id: 'abcdef123456',
      commit_id: 'xyz789',
      change_prefix: 3,
      commit_prefix: 3,
      is_working_copy: false,
      hidden: false,
      immutable: false,
      conflicted: false,
      divergent: false,
      empty: false,
    },
    description: 'test commit',
    graph_lines: [],
  }
}

function defaultProps(overrides: Record<string, unknown> = {}) {
  return {
    revision: makeRevision(),
    draft: 'initial draft',
    onsave: vi.fn(),
    oncancel: vi.fn(),
    ondraftchange: vi.fn(),
    ...overrides,
  }
}

describe('DescriptionEditor', () => {
  describe('rendering', () => {
    it('shows label with truncated change_id', () => {
      const { container } = render(DescriptionEditor, { props: defaultProps() })
      const label = container.querySelector('.desc-label')
      expect(label?.textContent).toContain('abcdef123456')
    })

    it('shows textarea with draft value', () => {
      const { container } = render(DescriptionEditor, { props: defaultProps() })
      const textarea = container.querySelector('textarea') as HTMLTextAreaElement
      expect(textarea.value).toBe('initial draft')
    })

    it('shows Save and Cancel buttons', () => {
      const { container } = render(DescriptionEditor, { props: defaultProps() })
      const primary = container.querySelector('.btn-primary')
      const secondary = container.querySelector('.btn-secondary')
      expect(primary?.textContent).toContain('Save')
      expect(secondary?.textContent).toBe('Cancel')
    })
  })

  describe('keyboard shortcuts', () => {
    it('Cmd+Enter calls onsave', async () => {
      const onsave = vi.fn()
      const { container } = render(DescriptionEditor, { props: defaultProps({ onsave }) })
      const textarea = container.querySelector('textarea')!
      await fireEvent.keyDown(textarea, { key: 'Enter', metaKey: true })
      expect(onsave).toHaveBeenCalledTimes(1)
    })

    it('Ctrl+Enter calls onsave', async () => {
      const onsave = vi.fn()
      const { container } = render(DescriptionEditor, { props: defaultProps({ onsave }) })
      const textarea = container.querySelector('textarea')!
      await fireEvent.keyDown(textarea, { key: 'Enter', ctrlKey: true })
      expect(onsave).toHaveBeenCalledTimes(1)
    })

    it('Escape calls oncancel', async () => {
      const oncancel = vi.fn()
      const { container } = render(DescriptionEditor, { props: defaultProps({ oncancel }) })
      const textarea = container.querySelector('textarea')!
      await fireEvent.keyDown(textarea, { key: 'Escape' })
      expect(oncancel).toHaveBeenCalledTimes(1)
    })
  })

  describe('buttons', () => {
    it('clicking Save calls onsave', async () => {
      const onsave = vi.fn()
      const { container } = render(DescriptionEditor, { props: defaultProps({ onsave }) })
      const btn = container.querySelector('.btn-primary')!
      await fireEvent.click(btn)
      expect(onsave).toHaveBeenCalledTimes(1)
    })

    it('clicking Cancel calls oncancel', async () => {
      const oncancel = vi.fn()
      const { container } = render(DescriptionEditor, { props: defaultProps({ oncancel }) })
      const btn = container.querySelector('.btn-secondary')!
      await fireEvent.click(btn)
      expect(oncancel).toHaveBeenCalledTimes(1)
    })
  })

  describe('input', () => {
    it('typing calls ondraftchange', async () => {
      const ondraftchange = vi.fn()
      const { container } = render(DescriptionEditor, { props: defaultProps({ ondraftchange }) })
      const textarea = container.querySelector('textarea')!
      await fireEvent.input(textarea, { target: { value: 'new text' } })
      expect(ondraftchange).toHaveBeenCalledTimes(1)
    })
  })
})
