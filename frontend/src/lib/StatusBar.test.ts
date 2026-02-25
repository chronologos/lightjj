import { describe, it, expect } from 'vitest'
import { render } from '@testing-library/svelte'
import StatusBar from './StatusBar.svelte'

function defaultProps(overrides: Record<string, unknown> = {}) {
  return {
    statusText: 'Ready',
    commandOutput: '',
    rebaseMode: false,
    rebaseSourceMode: '-r',
    rebaseTargetMode: '-d',
    squashMode: false,
    squashKeepEmptied: false,
    squashUseDestMsg: false,
    squashFileCount: null,
    splitMode: false,
    splitParallel: false,
    splitFileCount: null,
    activeView: 'log' as const,
    ...overrides,
  }
}

describe('StatusBar', () => {
  describe('default mode', () => {
    it('shows statusText', () => {
      const { container } = render(StatusBar, { props: defaultProps({ statusText: 'All good' }) })
      const item = container.querySelector('.status-item')
      expect(item?.textContent).toBe('All good')
    })

    it('shows last line of commandOutput', () => {
      const { container } = render(StatusBar, {
        props: defaultProps({ commandOutput: 'line1\nline2\nlast line' }),
      })
      const output = container.querySelector('.status-item.output')
      expect(output?.textContent).toBe('last line')
    })

    it('shows key hints when no statusText', () => {
      const { container } = render(StatusBar, { props: defaultProps({ statusText: '' }) })
      const hints = container.querySelector('.key-hints')
      expect(hints).not.toBeNull()
    })
  })

  describe('rebase mode', () => {
    it('shows rebase mode badge', () => {
      const { container } = render(StatusBar, { props: defaultProps({ rebaseMode: true }) })
      const badge = container.querySelector('.mode-badge')
      expect(badge?.textContent).toBe('rebase')
    })

    it('shows Enter/Esc action keys', () => {
      const { container } = render(StatusBar, { props: defaultProps({ rebaseMode: true }) })
      const actionKeys = container.querySelectorAll('.action-key')
      const keyTexts = Array.from(actionKeys).map(k => k.textContent)
      expect(keyTexts).toContain('Enter')
      expect(keyTexts).toContain('Esc')
    })

    it('highlights active source key based on rebaseSourceMode', () => {
      const { container } = render(StatusBar, {
        props: defaultProps({ rebaseMode: true, rebaseSourceMode: '-r' }),
      })
      const keys = container.querySelectorAll('.key:not(.action-key)')
      const activeKeys = Array.from(keys).filter(k => k.classList.contains('key-active'))
      expect(activeKeys.length).toBeGreaterThan(0)
      expect(activeKeys[0].textContent).toBe('r')
    })

    it('highlights active target key based on rebaseTargetMode', () => {
      const { container } = render(StatusBar, {
        props: defaultProps({ rebaseMode: true, rebaseTargetMode: '--insert-after' }),
      })
      const keys = container.querySelectorAll('.key:not(.action-key)')
      const activeKeys = Array.from(keys).filter(k => k.classList.contains('key-active'))
      // Should have 'r' (source) and 'a' (target) active
      const activeTexts = activeKeys.map(k => k.textContent)
      expect(activeTexts).toContain('a')
    })

    it('has rebase-active CSS class on footer', () => {
      const { container } = render(StatusBar, { props: defaultProps({ rebaseMode: true }) })
      const footer = container.querySelector('footer')
      expect(footer?.classList.contains('rebase-active')).toBe(true)
    })
  })

  describe('squash mode', () => {
    it('shows squash mode badge', () => {
      const { container } = render(StatusBar, { props: defaultProps({ squashMode: true }) })
      const badge = container.querySelector('.mode-badge')
      expect(badge?.textContent).toBe('squash')
    })

    it('highlights e key when squashKeepEmptied=true', () => {
      const { container } = render(StatusBar, {
        props: defaultProps({ squashMode: true, squashKeepEmptied: true }),
      })
      const keys = container.querySelectorAll('.key:not(.action-key)')
      const eKey = Array.from(keys).find(k => k.textContent === 'e')
      expect(eKey?.classList.contains('key-active')).toBe(true)
    })

    it('highlights d key when squashUseDestMsg=true', () => {
      const { container } = render(StatusBar, {
        props: defaultProps({ squashMode: true, squashUseDestMsg: true }),
      })
      const keys = container.querySelectorAll('.key:not(.action-key)')
      const dKey = Array.from(keys).find(k => k.textContent === 'd')
      expect(dKey?.classList.contains('key-active')).toBe(true)
    })

    it('shows file count', () => {
      const { container } = render(StatusBar, {
        props: defaultProps({ squashMode: true, squashFileCount: { selected: 2, total: 5 } }),
      })
      const fileCount = container.querySelector('.file-count')
      expect(fileCount?.textContent).toBe('2/5 files')
    })

    it('file-count-empty class when selected=0', () => {
      const { container } = render(StatusBar, {
        props: defaultProps({ squashMode: true, squashFileCount: { selected: 0, total: 5 } }),
      })
      const fileCount = container.querySelector('.file-count')
      expect(fileCount?.classList.contains('file-count-empty')).toBe(true)
    })

    it('has squash-active CSS class', () => {
      const { container } = render(StatusBar, { props: defaultProps({ squashMode: true }) })
      const footer = container.querySelector('footer')
      expect(footer?.classList.contains('squash-active')).toBe(true)
    })
  })

  describe('split mode', () => {
    it('shows split mode badge', () => {
      const { container } = render(StatusBar, { props: defaultProps({ splitMode: true }) })
      const badge = container.querySelector('.mode-badge')
      expect(badge?.textContent).toBe('split')
    })

    it('highlights p key when splitParallel=true', () => {
      const { container } = render(StatusBar, {
        props: defaultProps({ splitMode: true, splitParallel: true }),
      })
      const keys = container.querySelectorAll('.key:not(.action-key)')
      const pKey = Array.from(keys).find(k => k.textContent === 'p')
      expect(pKey?.classList.contains('key-active')).toBe(true)
    })

    it('shows file count with stay suffix', () => {
      const { container } = render(StatusBar, {
        props: defaultProps({ splitMode: true, splitFileCount: { selected: 3, total: 7 } }),
      })
      const fileCount = container.querySelector('.file-count')
      expect(fileCount?.textContent).toBe('3/7 files stay')
    })

    it('has split-active CSS class', () => {
      const { container } = render(StatusBar, { props: defaultProps({ splitMode: true }) })
      const footer = container.querySelector('footer')
      expect(footer?.classList.contains('split-active')).toBe(true)
    })
  })
})
