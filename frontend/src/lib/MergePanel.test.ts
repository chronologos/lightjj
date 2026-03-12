import { describe, it, expect, vi } from 'vitest'
import { render, fireEvent } from '@testing-library/svelte'
import MergePanel from './MergePanel.svelte'
import type { MergeSides } from './conflict-extract'

// Thin component tests — wire-up only. The position-surgery logic lives in
// merge-surgery.ts and has its own dedicated test file (50 tests including
// round-trip invariants). CM6's EditorView works in jsdom for basic rendering
// but scroll/measurement is unreliable; we test around that.

function sides(ours: string, theirs: string, base = ''): MergeSides {
  return { ours, theirs, base, oursLabel: 'Ours', theirsLabel: 'Theirs' }
}

function props(over: Record<string, unknown> = {}) {
  return {
    sides: sides('A\nOURS\nC', 'A\nTHEIRS\nC'),
    filePath: 'f.go',
    onsave: vi.fn(),
    oncancel: vi.fn(),
    ...over,
  }
}

describe('MergePanel — toolbar', () => {
  it('renders file path in title', () => {
    const { container } = render(MergePanel, { props: props({ filePath: 'pkg/thing.go' }) })
    expect(container.querySelector('.merge-title code')?.textContent).toBe('pkg/thing.go')
  })

  it('shows N/N counter based on block count', () => {
    // 1 differing line → 1 block. Initially 0 resolved (all seeded with theirs).
    const { container } = render(MergePanel, { props: props() })
    expect(container.querySelector('.merge-counter')?.textContent?.trim()).toMatch(/0\/1/)
  })

  it('identical ours/theirs → no counter (zero blocks)', () => {
    const { container } = render(MergePanel, { props: props({
      sides: sides('same\ncontent', 'same\ncontent'),
    }) })
    expect(container.querySelector('.merge-counter')).toBeNull()
  })

  it('error prop renders in toolbar', () => {
    const { container } = render(MergePanel, { props: props({ error: 'save failed: disk full' }) })
    expect(container.querySelector('.merge-error')?.textContent).toContain('save failed')
  })

  it('busy prop disables Save and Cancel buttons (cycle stays enabled)', () => {
    const { container } = render(MergePanel, { props: props({ busy: true }) })
    // Template order: [cycle, save, cancel] — see MergePanel.svelte toolbar.
    const [cycle, save, cancel] = container.querySelectorAll<HTMLButtonElement>('.merge-btn')
    expect(save.disabled).toBe(true)
    expect(cancel.disabled).toBe(true)
    expect(cycle.disabled).toBe(false)  // pane toggle is harmless during save
  })

  it('Save button fires onsave with center content (seeded = theirs)', async () => {
    const onsave = vi.fn()
    const { container } = render(MergePanel, { props: props({ onsave }) })
    await fireEvent.click(container.querySelector('.merge-save')!)
    // Center seeds with theirs → save should emit theirs content.
    expect(onsave).toHaveBeenCalledWith('A\nTHEIRS\nC')
  })

  it('Save does NOT fire when busy', async () => {
    const onsave = vi.fn()
    const { container } = render(MergePanel, { props: props({ onsave, busy: true }) })
    await fireEvent.click(container.querySelector('.merge-save')!)
    expect(onsave).not.toHaveBeenCalled()
  })

  it('Cancel fires oncancel when not dirty (no confirm)', async () => {
    const oncancel = vi.fn()
    const { container } = render(MergePanel, { props: props({ oncancel }) })
    const cancelBtn = [...container.querySelectorAll('.merge-btn')].find(b => b.textContent === 'Cancel')!
    await fireEvent.click(cancelBtn)
    expect(oncancel).toHaveBeenCalledOnce()
  })
})

describe('MergePanel — keyboard swallowing', () => {
  // swallowKeydown prevents App's global keydown handler from firing j/k
  // navigation while merge editing (which would remount and lose work).

  it('stops propagation of unmodified keys (j/k navigation guard)', () => {
    const { container } = render(MergePanel, { props: props() })
    const panel = container.querySelector('.merge-panel')!
    const ev = new KeyboardEvent('keydown', { key: 'j', bubbles: true })
    const spy = vi.spyOn(ev, 'stopPropagation')
    panel.dispatchEvent(ev)
    expect(spy).toHaveBeenCalled()
  })

  it('passes through Cmd+R (browser-level shortcuts allowed)', () => {
    const { container } = render(MergePanel, { props: props() })
    const panel = container.querySelector('.merge-panel')!
    const ev = new KeyboardEvent('keydown', { key: 'r', metaKey: true, bubbles: true })
    const spy = vi.spyOn(ev, 'stopPropagation')
    panel.dispatchEvent(ev)
    expect(spy).not.toHaveBeenCalled()
  })

  it('Cmd+S with focus outside CM6: fires onsave (fallback path)', () => {
    // When focus is on a toolbar button (not CM6), the keymap doesn't fire.
    // swallowKeydown's Cmd+S branch covers this.
    const onsave = vi.fn()
    const { container } = render(MergePanel, { props: props({ onsave }) })
    const panel = container.querySelector('.merge-panel')!
    panel.dispatchEvent(new KeyboardEvent('keydown', { key: 's', metaKey: true, bubbles: true }))
    expect(onsave).toHaveBeenCalledWith('A\nTHEIRS\nC')
  })

  it('Escape at panel level fires oncancel (fallback when not in CM6)', () => {
    const oncancel = vi.fn()
    const { container } = render(MergePanel, { props: props({ oncancel }) })
    const panel = container.querySelector('.merge-panel')!
    panel.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    expect(oncancel).toHaveBeenCalled()
  })

  it('defaultPrevented key: only stops propagation, no double-fire', () => {
    // CM6's keymap preventDefault()s handled keys. swallowKeydown should
    // stopPropagation but NOT re-handle Escape (no double-cancel).
    const oncancel = vi.fn()
    const { container } = render(MergePanel, { props: props({ oncancel }) })
    const panel = container.querySelector('.merge-panel')!
    const ev = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
    ev.preventDefault()  // simulate CM6 having handled it
    const spy = vi.spyOn(ev, 'stopPropagation')
    panel.dispatchEvent(ev)
    expect(spy).toHaveBeenCalled()
    expect(oncancel).not.toHaveBeenCalled()  // CM6 already handled; don't re-fire
  })
})

describe('MergePanel — headers', () => {
  it('shows ours/theirs labels from sides', () => {
    const { container } = render(MergePanel, { props: props({
      sides: { ...sides('a', 'b'), oursLabel: 'my feature', theirsLabel: 'main' },
    }) })
    expect(container.querySelector('.merge-header-ours')?.textContent).toContain('my feature')
    expect(container.querySelector('.merge-header-theirs')?.textContent).toContain('main')
  })

  it('falls back to default labels when empty', () => {
    const { container } = render(MergePanel, { props: props({
      sides: { ...sides('a', 'b'), oursLabel: '', theirsLabel: '' },
    }) })
    expect(container.querySelector('.merge-header-ours')?.textContent).toContain('Ours (side #1)')
    expect(container.querySelector('.merge-header-theirs')?.textContent).toContain('Theirs (side #2)')
  })
})
