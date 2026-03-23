import { describe, it, expect, vi } from 'vitest'
import { render, fireEvent } from '@testing-library/svelte'
import MergePanel from './MergePanel.svelte'
import type { MergeSides } from './conflict-extract'
import { diffBlocks } from './merge-diff'

// Thin component tests — wire-up only. The position-surgery logic lives in
// merge-surgery.ts and has its own dedicated test file (50 tests including
// round-trip invariants). CM6's EditorView works in jsdom for basic rendering
// but scroll/measurement is unreliable; we test around that.

// In production, blocks come from conflict-extract's region-boundary tracking
// (no LCS). Test fixtures construct ours/theirs directly without markers, so
// compute blocks via diffBlocks — same semantic result for these small inputs,
// and keeps existing assertions valid.
function sides(ours: string, theirs: string, base = ''): MergeSides {
  return {
    ours, theirs, base, oursLabel: 'Ours', theirsLabel: 'Theirs',
    blocks: diffBlocks(ours.split('\n'), theirs.split('\n')),
  }
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
    const btns = [...container.querySelectorAll<HTMLButtonElement>('.merge-btn')]
    const byText = (t: string) => btns.find(b => b.textContent?.includes(t))!
    expect(byText('Sav').disabled).toBe(true)   // 'Save' or 'Saving…'
    expect(byText('Cancel').disabled).toBe(true)
    expect(byText('◫').disabled).toBe(false)    // cycle — pane toggle harmless during save
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

describe('MergePanel — block navigation', () => {
  // 3 differing lines → 3 blocks. Nav invariant: [/] wrap at boundaries,
  // and [/] do NOT navigate when focus is inside the editable center pane
  // (brackets are valid source characters).
  const threeBlocks = () => props({
    sides: sides('A\n1\nB\n2\nC\n3\nD', 'A\nX\nB\nY\nC\nZ\nD'),
  })

  function navPos(container: Element): string {
    return container.querySelector('.merge-nav-pos')?.textContent?.trim() ?? ''
  }

  it('nav pill shows "1 of N" initially', () => {
    const { container } = render(MergePanel, { props: threeBlocks() })
    expect(navPos(container)).toBe('1 of 3')
  })

  it('nav pill hidden when ours === theirs (zero blocks)', () => {
    const { container } = render(MergePanel, { props: props({
      sides: sides('same', 'same'),
    }) })
    expect(container.querySelector('.merge-nav')).toBeNull()
  })

  it.each([
    // [key-sequence, expected final "N of 3"]
    [[']'], '2 of 3'],
    [[']', ']'], '3 of 3'],
    [[']', ']', ']'], '1 of 3'],          // wraps forward
    [['['], '3 of 3'],                    // wraps backward from start
    [['[', '['], '2 of 3'],
    [[']', '[', ']'], '2 of 3'],          // mixed
  ])('[/] wrap-around: %j → %s', async (keys, expected) => {
    const { container } = render(MergePanel, { props: threeBlocks() })
    const panel = container.querySelector('.merge-panel')!
    for (const k of keys) {
      await fireEvent.keyDown(panel, { key: k })
    }
    expect(navPos(container)).toBe(expected)
  })

  it('[/] inside center pane do NOT navigate (valid source chars)', async () => {
    const { container } = render(MergePanel, { props: threeBlocks() })
    const center = container.querySelector('.merge-center')!
    await fireEvent.keyDown(center, { key: ']' })
    // Focus in center → bracket is a typed character, not nav. Position stays.
    expect(navPos(container)).toBe('1 of 3')
  })

  it('toolbar nav buttons advance/retreat regardless of focus', async () => {
    const { container } = render(MergePanel, { props: threeBlocks() })
    const [prev, next] = container.querySelectorAll<HTMLButtonElement>('.merge-nav-btn')
    await fireEvent.click(next)
    expect(navPos(container)).toBe('2 of 3')
    await fireEvent.click(prev)
    expect(navPos(container)).toBe('1 of 3')
  })

  it('arrow click updates currentBlockIdx (nav continuity)', async () => {
    const { container } = render(MergePanel, { props: threeBlocks() })
    // Click the 3rd ours-arrow. takeBlock(2, 'ours') should set currentBlockIdx=2.
    const oursArrows = container.querySelectorAll<HTMLButtonElement>('.merge-arrow-ours')
    expect(oursArrows.length).toBe(3)
    await fireEvent.click(oursArrows[2])
    expect(navPos(container)).toBe('3 of 3')
  })

  it('current-block ring follows navigation', async () => {
    const { container } = render(MergePanel, { props: threeBlocks() })
    const panel = container.querySelector('.merge-panel')!
    const rings = () => container.querySelectorAll('.merge-arrow-current')
    // Initially block 0: 2 arrows (ours + theirs) have the ring.
    expect(rings().length).toBe(2)
    await fireEvent.keyDown(panel, { key: ']' })
    // Still 2 — ring moved to block 1's pair.
    expect(rings().length).toBe(2)
    const oursArrows = container.querySelectorAll('.merge-arrow-ours')
    expect(oursArrows[1].classList.contains('merge-arrow-current')).toBe(true)
    expect(oursArrows[0].classList.contains('merge-arrow-current')).toBe(false)
  })
})

describe('MergePanel — minimap', () => {
  const threeBlocks = () => props({
    sides: sides('A\n1\nB\n2\nC\n3\nD', 'A\nX\nB\nY\nC\nZ\nD'),
  })

  it('renders one chip per block', () => {
    const { container } = render(MergePanel, { props: threeBlocks() })
    expect(container.querySelectorAll('.merge-minimap-chip')).toHaveLength(3)
  })

  it('chip click scrolls to block and updates currentBlockIdx', async () => {
    const { container } = render(MergePanel, { props: threeBlocks() })
    const chips = container.querySelectorAll<HTMLButtonElement>('.merge-minimap-chip')
    await fireEvent.click(chips[2])
    expect(container.querySelector('.merge-nav-pos')?.textContent?.trim()).toBe('3 of 3')
    expect(chips[2].classList.contains('merge-minimap-current')).toBe(true)
  })

  it('chips seed with theirs-source color (center seeds with theirs)', () => {
    const { container } = render(MergePanel, { props: threeBlocks() })
    const chips = container.querySelectorAll('.merge-minimap-chip')
    for (const chip of chips) {
      expect(chip.classList.contains('merge-minimap-theirs')).toBe(true)
    }
  })

  it('chip color flips to ours after takeBlock', async () => {
    const { container } = render(MergePanel, { props: threeBlocks() })
    const oursArrows = container.querySelectorAll<HTMLButtonElement>('.merge-arrow-ours')
    await fireEvent.click(oursArrows[1])
    const chips = container.querySelectorAll('.merge-minimap-chip')
    expect(chips[1].classList.contains('merge-minimap-ours')).toBe(true)
    expect(chips[0].classList.contains('merge-minimap-theirs')).toBe(true)  // unchanged
  })

  it('chip positions are proportional to line numbers (invariant: monotone top%)', () => {
    const { container } = render(MergePanel, { props: threeBlocks() })
    const chips = [...container.querySelectorAll<HTMLElement>('.merge-minimap-chip')]
    const tops = chips.map(c => parseFloat(c.style.top))
    // blocks[i].bFrom strictly increases → top% strictly increases
    for (let i = 1; i < tops.length; i++) {
      expect(tops[i]).toBeGreaterThan(tops[i - 1])
    }
  })
})

describe('MergePanel — takeAll', () => {
  // The strongest invariant: after takeAll(side), Save emits exactly that
  // side's content. This round-trips through planTake's separator-math for
  // every block, so it catches position-drift bugs the per-block tests miss.
  const threeBlocks = sides('A\n1\nB\n2\nC\n3\nD', 'A\nX\nB\nY\nC\nZ\nD')

  it.each([
    ['ours',   threeBlocks.ours],
    ['theirs', threeBlocks.theirs],
  ] as const)('takeAll(%s) → center content === sides.%s', async (side, expected) => {
    const onsave = vi.fn()
    const { container } = render(MergePanel, { props: { ...props({ onsave }), sides: threeBlocks } })
    const btn = [...container.querySelectorAll<HTMLButtonElement>('.merge-btn')]
      .find(b => b.textContent?.toLowerCase().includes(`all ${side}`))!
    await fireEvent.click(btn)
    await fireEvent.click(container.querySelector('.merge-save')!)
    expect(onsave).toHaveBeenCalledWith(expected)
  })

  it('takeAll flips every minimap chip to that side', async () => {
    const { container } = render(MergePanel, { props: { ...props(), sides: threeBlocks } })
    const allOurs = [...container.querySelectorAll<HTMLButtonElement>('.merge-btn')]
      .find(b => b.textContent?.includes('All ours'))!
    await fireEvent.click(allOurs)
    const chips = container.querySelectorAll('.merge-minimap-chip')
    for (const chip of chips) {
      expect(chip.classList.contains('merge-minimap-ours')).toBe(true)
    }
  })

  it('takeAll hidden when zero blocks (identical sides)', () => {
    const { container } = render(MergePanel, { props: props({
      sides: sides('same', 'same'),
    }) })
    expect(container.querySelector('.merge-btn-ours')).toBeNull()
    expect(container.querySelector('.merge-btn-theirs')).toBeNull()
  })

  it('takeAll buttons disabled during busy (bug_009 — no mutation mid-save)', () => {
    const { container } = render(MergePanel, { props: { ...props({ busy: true }), sides: threeBlocks } })
    const allOurs = container.querySelector<HTMLButtonElement>('.merge-btn-ours')!
    const allTheirs = container.querySelector<HTMLButtonElement>('.merge-btn-theirs')!
    expect(allOurs.disabled).toBe(true)
    expect(allTheirs.disabled).toBe(true)
  })

  it('counter reaches N/N after takeAll(ours) — every block resolved', async () => {
    const { container } = render(MergePanel, { props: { ...props(), sides: threeBlocks } })
    const allOurs = [...container.querySelectorAll<HTMLButtonElement>('.merge-btn')]
      .find(b => b.textContent?.includes('All ours'))!
    await fireEvent.click(allOurs)
    expect(container.querySelector('.merge-counter')?.textContent?.trim()).toMatch(/3\/3/)
    expect(container.querySelector('.merge-counter')?.classList.contains('merge-done')).toBe(true)
  })
})

describe('MergePanel — takeBoth', () => {
  // Dueling-imports scenario: both sides add a different line at the same spot.
  const dueling = sides('A\nimport X\nC', 'A\nimport Y\nC')

  it('b key concatenates ours+theirs at current block', async () => {
    const onsave = vi.fn()
    const { container } = render(MergePanel, { props: { ...props({ onsave }), sides: dueling } })
    const panel = container.querySelector('.merge-panel')!
    await fireEvent.keyDown(panel, { key: 'b' })
    await fireEvent.click(container.querySelector('.merge-save')!)
    // Invariant: save emits ours-line + theirs-line at the block position.
    expect(onsave).toHaveBeenCalledWith('A\nimport X\nimport Y\nC')
  })

  it('b key is a no-op inside center editor (valid identifier char)', async () => {
    const onsave = vi.fn()
    const { container } = render(MergePanel, { props: { ...props({ onsave }), sides: dueling } })
    const center = container.querySelector('.merge-center')!
    await fireEvent.keyDown(center, { key: 'b' })
    await fireEvent.click(container.querySelector('.merge-save')!)
    // Still theirs (seeded) — b was swallowed as editing, not takeBoth.
    expect(onsave).toHaveBeenCalledWith('A\nimport Y\nC')
  })

  it('minimap chip turns both-gradient after takeBoth', async () => {
    const { container } = render(MergePanel, { props: { ...props(), sides: dueling } })
    const panel = container.querySelector('.merge-panel')!
    await fireEvent.keyDown(panel, { key: 'b' })
    const chip = container.querySelector('.merge-minimap-chip')!
    expect(chip.classList.contains('merge-minimap-both')).toBe(true)
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
