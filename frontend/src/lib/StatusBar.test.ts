import { describe, it, expect } from 'vitest'
import { render } from '@testing-library/svelte'
import StatusBar from './StatusBar.svelte'
import { createRebaseMode, createSquashMode, createSplitMode } from './modes.svelte'

function activeRebase(sourceKey?: string, targetKey?: string) {
  const m = createRebaseMode()
  m.enter(['x'])
  if (sourceKey) m.handleKey(sourceKey)
  if (targetKey) m.handleKey(targetKey)
  return m
}

function activeSquash(toggle?: 'e' | 'd') {
  const m = createSquashMode()
  m.enter(['x'])
  if (toggle) m.handleKey(toggle)
  return m
}

function activeSplit(parallel = false, review = false) {
  const m = createSplitMode()
  m.enter('x', review)
  if (parallel) m.handleKey('p')
  return m
}

function defaultProps(overrides: Record<string, unknown> = {}) {
  return {
    statusText: 'Ready',
    commandOutput: '',
    rebase: createRebaseMode(),
    squash: createSquashMode(),
    squashFileCount: null,
    split: createSplitMode(),
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
      const { container } = render(StatusBar, { props: defaultProps({ rebase: activeRebase() }) })
      const badge = container.querySelector('.mode-badge')
      expect(badge?.textContent).toBe('rebase')
    })

    it('shows Enter/Esc action keys', () => {
      const { container } = render(StatusBar, { props: defaultProps({ rebase: activeRebase() }) })
      const actionKeys = container.querySelectorAll('.action-key')
      const keyTexts = Array.from(actionKeys).map(k => k.textContent)
      expect(keyTexts).toContain('Enter')
      expect(keyTexts).toContain('Esc')
    })

    it('highlights active source key based on rebase.sourceMode', () => {
      const { container } = render(StatusBar, {
        props: defaultProps({ rebase: activeRebase() }),
      })
      const keys = container.querySelectorAll('.key:not(.action-key)')
      const activeKeys = Array.from(keys).filter(k => k.classList.contains('key-active'))
      expect(activeKeys.length).toBeGreaterThan(0)
      expect(activeKeys[0].textContent).toBe('r')
    })

    it('highlights active target key based on rebase.targetMode', () => {
      const { container } = render(StatusBar, {
        props: defaultProps({ rebase: activeRebase(undefined, 'a') }),
      })
      const keys = container.querySelectorAll('.key:not(.action-key)')
      const activeKeys = Array.from(keys).filter(k => k.classList.contains('key-active'))
      const activeTexts = activeKeys.map(k => k.textContent)
      expect(activeTexts).toContain('a')
    })

    it('has rebase-active CSS class on footer', () => {
      const { container } = render(StatusBar, { props: defaultProps({ rebase: activeRebase() }) })
      const footer = container.querySelector('footer')
      expect(footer?.classList.contains('rebase-active')).toBe(true)
    })
  })

  describe('squash mode', () => {
    it('shows squash mode badge', () => {
      const { container } = render(StatusBar, { props: defaultProps({ squash: activeSquash() }) })
      const badge = container.querySelector('.mode-badge')
      expect(badge?.textContent).toBe('squash')
    })

    it('highlights e key when keepEmptied is toggled', () => {
      const { container } = render(StatusBar, {
        props: defaultProps({ squash: activeSquash('e') }),
      })
      const keys = container.querySelectorAll('.key:not(.action-key)')
      const eKey = Array.from(keys).find(k => k.textContent === 'e')
      expect(eKey?.classList.contains('key-active')).toBe(true)
    })

    it('highlights d key when useDestMsg is toggled', () => {
      const { container } = render(StatusBar, {
        props: defaultProps({ squash: activeSquash('d') }),
      })
      const keys = container.querySelectorAll('.key:not(.action-key)')
      const dKey = Array.from(keys).find(k => k.textContent === 'd')
      expect(dKey?.classList.contains('key-active')).toBe(true)
    })

    it('shows file count', () => {
      const { container } = render(StatusBar, {
        props: defaultProps({ squash: activeSquash(), squashFileCount: { selected: 2, total: 5 } }),
      })
      const fileCount = container.querySelector('.file-count')
      expect(fileCount?.textContent).toBe('2/5 files to move')
    })

    it('file-count-empty class when selected=0', () => {
      const { container } = render(StatusBar, {
        props: defaultProps({ squash: activeSquash(), squashFileCount: { selected: 0, total: 5 } }),
      })
      const fileCount = container.querySelector('.file-count')
      expect(fileCount?.classList.contains('file-count-empty')).toBe(true)
    })

    it('has squash-active CSS class', () => {
      const { container } = render(StatusBar, { props: defaultProps({ squash: activeSquash() }) })
      const footer = container.querySelector('footer')
      expect(footer?.classList.contains('squash-active')).toBe(true)
    })
  })

  describe('split mode', () => {
    it('shows split mode badge', () => {
      const { container } = render(StatusBar, { props: defaultProps({ split: activeSplit() }) })
      const badge = container.querySelector('.mode-badge')
      expect(badge?.textContent).toBe('split')
    })

    it('highlights p key when parallel is toggled', () => {
      const { container } = render(StatusBar, {
        props: defaultProps({ split: activeSplit(true) }),
      })
      const keys = container.querySelectorAll('.key:not(.action-key)')
      const pKey = Array.from(keys).find(k => k.textContent === 'p')
      expect(pKey?.classList.contains('key-active')).toBe(true)
    })

    it('shows file count with stay suffix', () => {
      const { container } = render(StatusBar, {
        props: defaultProps({ split: activeSplit(), splitFileCount: { selected: 3, total: 7 } }),
      })
      const fileCount = container.querySelector('.file-count')
      expect(fileCount?.textContent).toBe('3/7 files stay')
    })

    it('has split-active CSS class', () => {
      const { container } = render(StatusBar, { props: defaultProps({ split: activeSplit() }) })
      const footer = container.querySelector('footer')
      expect(footer?.classList.contains('split-active')).toBe(true)
    })

    it('shows review badge and accepted suffix when split.review is true', () => {
      const { container } = render(StatusBar, {
        props: defaultProps({ split: activeSplit(false, true), splitFileCount: { selected: 4, total: 6 } }),
      })
      const badge = container.querySelector('.mode-badge')
      expect(badge?.textContent).toBe('review')
      const fileCount = container.querySelector('.file-count')
      expect(fileCount?.textContent).toBe('4/6 files accepted')
      // parallel hint hidden in review mode — semantically unclear what "parallel review" means
      const keys = container.querySelectorAll('.key:not(.action-key)')
      const pKey = Array.from(keys).find(k => k.textContent === 'p')
      expect(pKey).toBeUndefined()
    })
  })
})
