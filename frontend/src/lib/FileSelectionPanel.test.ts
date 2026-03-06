import { describe, it, expect, vi } from 'vitest'
import { render, fireEvent } from '@testing-library/svelte'
import { SvelteSet } from 'svelte/reactivity'
import FileSelectionPanel from './FileSelectionPanel.svelte'
import type { FileChange } from './api'

function mkFile(path: string, overrides: Partial<FileChange> = {}): FileChange {
  return { type: 'M', path, additions: 3, deletions: 1, conflict: false, conflict_sides: 0, ...overrides }
}

function props(overrides: Record<string, unknown> = {}) {
  return {
    mode: 'squash' as const,
    files: [mkFile('a.go'), mkFile('b.go'), mkFile('c.go')],
    selected: new SvelteSet<string>(),
    ontoggle: vi.fn(),
    ...overrides,
  }
}

const list = (c: HTMLElement) => c.querySelector('.file-selection-list')!
const rows = (c: HTMLElement) => c.querySelectorAll('.file-select-row')
const activeRow = (c: HTMLElement) => c.querySelector('.file-select-active')

describe('FileSelectionPanel', () => {
  describe('rendering', () => {
    it('renders one row per file with add/del stats', () => {
      const { container } = render(FileSelectionPanel, { props: props() })
      expect(rows(container)).toHaveLength(3)
      expect(container.textContent).toContain('a.go')
      expect(container.textContent).toContain('+3')
      expect(container.textContent).toContain('-1')
    })

    it('labels: squash → "to move", split → "stay", review → "accepted"', () => {
      let { container } = render(FileSelectionPanel, { props: props({ mode: 'squash' }) })
      expect(container.querySelector('.file-selection-count')?.textContent).toContain('to move')
      ;({ container } = render(FileSelectionPanel, { props: props({ mode: 'split' }) }))
      expect(container.querySelector('.file-selection-count')?.textContent).toContain('stay')
      ;({ container } = render(FileSelectionPanel, { props: props({ mode: 'review' }) }))
      expect(container.querySelector('.file-selection-count')?.textContent).toContain('accepted')
    })

    it('checked rows get aria-selected + ✓ indicator', () => {
      const { container } = render(FileSelectionPanel, {
        props: props({ selected: new SvelteSet(['b.go']) }),
      })
      const r = rows(container)
      expect(r[0].getAttribute('aria-selected')).toBe('false')
      expect(r[1].getAttribute('aria-selected')).toBe('true')
      expect(r[1].querySelector('.file-check-indicator')?.textContent).toBe('✓')
    })

    it('conflict file shows dot-C', () => {
      const { container } = render(FileSelectionPanel, {
        props: props({ files: [mkFile('x.go', { conflict: true })] }),
      })
      expect(container.querySelector('.file-dot.dot-C')).toBeInTheDocument()
    })
  })

  describe('keyboard', () => {
    it('j/ArrowDown move cursor down; k/ArrowUp up; clamps at bounds', async () => {
      const { container } = render(FileSelectionPanel, { props: props() })
      expect(activeRow(container)?.textContent).toContain('a.go')

      await fireEvent.keyDown(list(container), { key: 'j' })
      expect(activeRow(container)?.textContent).toContain('b.go')
      await fireEvent.keyDown(list(container), { key: 'ArrowDown' })
      expect(activeRow(container)?.textContent).toContain('c.go')
      await fireEvent.keyDown(list(container), { key: 'j' }) // clamp
      expect(activeRow(container)?.textContent).toContain('c.go')

      await fireEvent.keyDown(list(container), { key: 'k' })
      expect(activeRow(container)?.textContent).toContain('b.go')
      await fireEvent.keyDown(list(container), { key: 'ArrowUp' })
      expect(activeRow(container)?.textContent).toContain('a.go')
      await fireEvent.keyDown(list(container), { key: 'k' }) // clamp
      expect(activeRow(container)?.textContent).toContain('a.go')
    })

    it('Space toggles cursor file', async () => {
      const ontoggle = vi.fn()
      const { container } = render(FileSelectionPanel, { props: props({ ontoggle }) })
      await fireEvent.keyDown(list(container), { key: 'j' }) // cursor → b.go
      await fireEvent.keyDown(list(container), { key: ' ' })
      expect(ontoggle).toHaveBeenCalledWith('b.go')
    })

    it('a selects all unchecked; n deselects all checked — via ontoggle callback', async () => {
      const ontoggle = vi.fn()
      const { container } = render(FileSelectionPanel, {
        props: props({ selected: new SvelteSet(['b.go']), ontoggle }),
      })

      await fireEvent.keyDown(list(container), { key: 'a' })
      // a.go + c.go are unchecked → toggled. b.go already checked → not toggled.
      expect(ontoggle).toHaveBeenCalledWith('a.go')
      expect(ontoggle).toHaveBeenCalledWith('c.go')
      expect(ontoggle).toHaveBeenCalledTimes(2)
      ontoggle.mockClear()

      await fireEvent.keyDown(list(container), { key: 'n' })
      // Only b.go is in the (unchanged) selected set → only it toggles.
      // (This test's `selected` prop is static — ontoggle is parent's job.)
      expect(ontoggle).toHaveBeenCalledWith('b.go')
      expect(ontoggle).toHaveBeenCalledTimes(1)
    })

    it('Enter/Escape NOT handled — bubbles to global handler', async () => {
      const { container } = render(FileSelectionPanel, { props: props() })
      const handler = vi.fn()
      document.addEventListener('keydown', handler)
      await fireEvent.keyDown(list(container), { key: 'Enter' })
      await fireEvent.keyDown(list(container), { key: 'Escape' })
      expect(handler).toHaveBeenCalledTimes(2)
      expect(handler.mock.calls[0][0].defaultPrevented).toBe(false)
      expect(handler.mock.calls[1][0].defaultPrevented).toBe(false)
      document.removeEventListener('keydown', handler)
    })
  })

  describe('mouse', () => {
    it('click sets cursor + toggles; mouseenter sets cursor only', async () => {
      const ontoggle = vi.fn()
      const { container } = render(FileSelectionPanel, { props: props({ ontoggle }) })
      const r = rows(container)

      await fireEvent.mouseEnter(r[2])
      expect(activeRow(container)?.textContent).toContain('c.go')
      expect(ontoggle).not.toHaveBeenCalled()

      await fireEvent.click(r[1])
      expect(activeRow(container)?.textContent).toContain('b.go')
      expect(ontoggle).toHaveBeenCalledWith('b.go')
    })

    it('All/None buttons fire ontoggle for each matching file', async () => {
      const ontoggle = vi.fn()
      const { getByText } = render(FileSelectionPanel, {
        props: props({ selected: new SvelteSet(['a.go']), ontoggle }),
      })
      await fireEvent.click(getByText('All'))
      expect(ontoggle).toHaveBeenCalledTimes(2) // b.go + c.go
    })
  })
})
