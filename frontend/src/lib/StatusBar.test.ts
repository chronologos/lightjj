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

    it('review mode: hunk count label + j/k/Space/a/n hints, no parallel', () => {
      // Review mode is hunk-level since v1.x — splitFileCount now carries
      // hunk counts, not file counts. The label says "hunks accepted" and
      // the key hints show hunk-nav (j/k/Space/a/n) instead of parallel (p).
      const { container } = render(StatusBar, {
        props: defaultProps({ split: activeSplit(false, true), splitFileCount: { selected: 4, total: 6 } }),
      })
      const badge = container.querySelector('.mode-badge')
      expect(badge?.textContent).toBe('review')
      const fileCount = container.querySelector('.file-count')
      expect(fileCount?.textContent).toBe('4/6 hunks accepted')

      const keys = Array.from(container.querySelectorAll('.key:not(.action-key)'))
        .map(k => k.textContent)
      expect(keys).toContain('j')
      expect(keys).toContain('Space')
      expect(keys).toContain('a')
      expect(keys).not.toContain('p')
    })
  })
})
