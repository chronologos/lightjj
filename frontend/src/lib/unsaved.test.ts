import { describe, it, expect, vi, afterEach } from 'vitest'
import { createUnsaved, type Leave } from './unsaved'

const src = (label: string, lostOn: Leave, dirty = true) => ({ label: () => label, lostOn, dirty: () => dirty })
afterEach(() => vi.restoreAllMocks())
const answer = (v: boolean) => vi.spyOn(window, 'confirm').mockReturnValue(v)

describe('createUnsaved', () => {
  it.each<[Leave, string[]]>([
    ['selection', ['file']],
    ['view', ['file', 'doc']],
    ['tab', ['file', 'doc', 'description']],
  ])('%s asks about exactly what it destroys', (leave, expected) => {
    const u = createUnsaved()
    u.register(src('file', 'selection')); u.register(src('doc', 'view')); u.register(src('description', 'tab'))
    u.register(src('untouched', 'selection', false))
    const c = answer(false)
    expect(u.confirmDiscard(leave)).toBe(false)
    expect(c).toHaveBeenCalledWith(`Discard unsaved changes to ${expected.join(', ')}?`)
  })

  it('never asks when there is nothing to lose', () => {
    const u = createUnsaved()
    u.register(src('clean', 'selection', false)); u.register(src('doc', 'view'))
    const c = answer(false)
    expect(u.confirmDiscard('selection')).toBe(true)
    expect(c).not.toHaveBeenCalled()
  })

  it('an accepted discard covers the buffer until it is edited again', () => {
    const u = createUnsaved()
    const h = u.register(src('file', 'selection'))
    const c = answer(true)
    expect(u.confirmDiscard('view')).toBe(true)
    expect(u.any('tab')).toBe(false) // not asked twice for one action
    h.touch()
    expect(u.any('selection')).toBe(true)
    expect(c).toHaveBeenCalledTimes(1)
  })

  it('a declined discard leaves everything at risk', () => {
    const u = createUnsaved()
    u.register(src('file', 'selection'))
    answer(false)
    u.confirmDiscard('selection')
    expect(u.any('selection')).toBe(true)
  })

  it('dispose unregisters once and reports the release', () => {
    const onRelease = vi.fn()
    const u = createUnsaved({ onRelease })
    const h = u.register(src('file', 'selection'))
    h.dispose(); h.dispose()
    expect(u.any('tab')).toBe(false)
    expect(onRelease).toHaveBeenCalledTimes(1)
  })
})
