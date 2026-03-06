import { describe, it, expect, vi } from 'vitest'
import { render, fireEvent } from '@testing-library/svelte'
import TabBar from './TabBar.svelte'
import type { TabInfo } from './api'

const tabs: TabInfo[] = [
  { id: '0', kind: 'repo', name: 'lightjj', path: '/Users/x/lightjj' },
  { id: '1', kind: 'repo', name: 'other', path: '/Users/x/other' },
]

const noop = () => {}

describe('TabBar', () => {
  it('renders tabs with active highlighted', () => {
    const { container } = render(TabBar, { tabs, activeId: '1', onswitch: noop, onopen: noop, onclose: noop })
    const btns = container.querySelectorAll('.tab')
    expect(btns).toHaveLength(2)
    expect(btns[0]).not.toHaveClass('active')
    expect(btns[1]).toHaveClass('active')
    expect(btns[0]).toHaveTextContent('lightjj')
  })

  it('clicking inactive tab fires onswitch; clicking active does not', async () => {
    const onswitch = vi.fn()
    const { container } = render(TabBar, { tabs, activeId: '0', onswitch, onopen: noop, onclose: noop })
    const btns = container.querySelectorAll('.tab')
    await fireEvent.click(btns[0]) // active
    expect(onswitch).not.toHaveBeenCalled()
    await fireEvent.click(btns[1])
    expect(onswitch).toHaveBeenCalledWith('1')
  })

  it('close × fires onclose and stops propagation (does not also switch)', async () => {
    const onswitch = vi.fn()
    const onclose = vi.fn()
    const { container } = render(TabBar, { tabs, activeId: '0', onswitch, onopen: noop, onclose })
    const close = container.querySelectorAll('.tab-close')[1]
    await fireEvent.click(close)
    expect(onclose).toHaveBeenCalledWith('1')
    expect(onswitch).not.toHaveBeenCalled()
  })

  it('hides close × when only one tab (cannot close last)', () => {
    const { container } = render(TabBar, { tabs: [tabs[0]], activeId: '0', onswitch: noop, onopen: noop, onclose: noop })
    expect(container.querySelector('.tab-close')).toBeNull()
  })

  it('+ button reveals path input; Enter submits, Escape cancels', async () => {
    const onopen = vi.fn()
    const { container } = render(TabBar, { tabs, activeId: '0', onswitch: noop, onopen, onclose: noop })
    await fireEvent.click(container.querySelector('.tab-new')!)
    const input = container.querySelector('.tab-path-input') as HTMLInputElement
    expect(input).not.toBeNull()

    input.value = '  ~/repo  '
    await fireEvent.input(input)
    await fireEvent.keyDown(input, { key: 'Enter' })
    expect(onopen).toHaveBeenCalledWith('~/repo') // trimmed

    // Escape path
    await fireEvent.click(container.querySelector('.tab-new')!)
    await fireEvent.keyDown(container.querySelector('.tab-path-input')!, { key: 'Escape' })
    expect(container.querySelector('.tab-path-input')).toBeNull()
  })

  it('Enter with only whitespace does not fire onopen', async () => {
    const onopen = vi.fn()
    const { container } = render(TabBar, { tabs, activeId: '0', onswitch: noop, onopen, onclose: noop })
    await fireEvent.click(container.querySelector('.tab-new')!)
    const input = container.querySelector('.tab-path-input') as HTMLInputElement
    input.value = '   '
    await fireEvent.input(input)
    await fireEvent.keyDown(input, { key: 'Enter' })
    expect(onopen).not.toHaveBeenCalled()
  })
})
