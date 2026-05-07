import { describe, expect, it, vi } from 'vitest'
import { flushSync } from 'svelte'

const { cfg } = vi.hoisted(() => ({ cfg: { hiddenCommentAuthors: [] as string[] } }))
vi.mock('./config.svelte', () => ({ config: cfg }))

import { createCommentVisibility } from './comment-visibility.svelte'
import type { Review } from './review'

function withRoot<T>(fn: () => T): T {
  let r!: T
  $effect.root(() => { r = fn() })
  flushSync()
  return r
}

const mk = (over: Partial<Review> = {}): Review => ({
  id: over.id ?? 'r1',
  anchor: { kind: 'prose', filePath: 'x', selection: 's', ctxBefore: '', ctxAfter: '' },
  body: '', createdAt: 0, kind: 'note', ...over,
})

describe('renderState — precedence order is load-bearing', () => {
  it('auto: open=visible, resolved=bubbled', () => {
    const v = withRoot(createCommentVisibility)
    expect(v.renderState(mk())).toBe('visible')
    expect(v.renderState(mk({ resolution: 'addressed' }))).toBe('bubbled')
  })

  it('hide bubbles everything; show shows everything (incl. resolved)', () => {
    const v = withRoot(createCommentVisibility)
    v.mode = 'hide'
    expect(v.renderState(mk())).toBe('bubbled')
    v.mode = 'show'
    expect(v.renderState(mk({ resolution: 'addressed' }))).toBe('visible')
  })

  it('override beats mode', () => {
    const v = withRoot(createCommentVisibility)
    v.mode = 'hide'
    v.overrides.set('r1', true)
    expect(v.renderState(mk())).toBe('visible')
    v.mode = 'show'
    v.overrides.set('r1', false)
    expect(v.renderState(mk())).toBe('bubbled')
  })

  it('hiddenAuthor beats override; stub when root has visible replies', () => {
    cfg.hiddenCommentAuthors = ['bot']
    const v = withRoot(createCommentVisibility)
    v.overrides.set('r1', true)
    expect(v.renderState(mk({ author: 'bot' }))).toBe('hidden')
    expect(v.renderState(mk({ author: 'bot' }), { hasVisibleReplies: true })).toBe('stub')
    cfg.hiddenCommentAuthors = []
  })

  it('hasDraft beats everything', () => {
    cfg.hiddenCommentAuthors = ['bot']
    const v = withRoot(createCommentVisibility)
    v.mode = 'hide'
    expect(v.renderState(mk({ author: 'bot' }), { hasDraft: true })).toBe('visible')
    cfg.hiddenCommentAuthors = []
  })

  it('cycle clears overrides', () => {
    const v = withRoot(createCommentVisibility)
    v.overrides.set('r1', true)
    v.cycle()
    expect(v.mode).toBe('hide')
    expect(v.overrides.size).toBe(0)
  })

  it('toggleThread sets explicit want (no mode-derived fallback)', () => {
    const v = withRoot(createCommentVisibility)
    v.toggleThread('r1', true)
    expect(v.overrides.get('r1')).toBe(true)
    v.toggleThread('r1', false)
    expect(v.overrides.get('r1')).toBe(false)
  })
})
