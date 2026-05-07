// Tri-state comment visibility + per-thread overrides. Per-App-instance —
// tabs are separate repos via {#key activeTabId} remount; a module singleton
// would make ⇧C in one tab flip another. hiddenAuthors lives in config.svelte.ts
// (the single localStorage surface), not here.
//
// See docs/design-notes/unified-review.md §Visibility model.

import { SvelteMap } from 'svelte/reactivity'
import { config } from './config.svelte'
import type { Review } from './review'

export type CommentMode = 'auto' | 'hide' | 'show'
export type RenderState = 'visible' | 'bubbled' | 'stub' | 'hidden'

const ORDER: CommentMode[] = ['auto', 'hide', 'show']

export function createCommentVisibility() {
  let mode = $state<CommentMode>('auto')
  // true = force-visible, false = force-bubbled, absent = follow mode.
  const overrides = new SvelteMap<string, boolean>()
  let scrollGen = $state(0)

  const hiddenAuthors = $derived(new Set(config.hiddenCommentAuthors))

  function renderState(r: Review, opts?: { hasDraft?: boolean; hasVisibleReplies?: boolean }): RenderState {
    if (opts?.hasDraft) return 'visible'
    if (r.author && hiddenAuthors.has(r.author)) {
      return opts?.hasVisibleReplies ? 'stub' : 'hidden'
    }
    const ov = overrides.get(r.id)
    if (ov !== undefined) return ov ? 'visible' : 'bubbled'
    if (mode === 'hide') return 'bubbled'
    if (mode === 'show') return 'visible'
    return r.resolution ? 'bubbled' : 'visible'
  }

  return {
    get mode() { return mode },
    set mode(m: CommentMode) { mode = m },
    overrides,
    get hiddenAuthors() { return hiddenAuthors },
    renderState,
    isVisible: (r: Review, opts?: Parameters<typeof renderState>[1]) =>
      renderState(r, opts) === 'visible',
    cycle() {
      mode = ORDER[(ORDER.indexOf(mode) + 1) % ORDER.length]
      overrides.clear()
    },
    toggleThread(id: string, want?: boolean) {
      const next = want ?? !(overrides.get(id) ?? mode !== 'hide')
      overrides.set(id, next)
    },
    hideAuthor(a: string) {
      if (!config.hiddenCommentAuthors.includes(a)) {
        config.hiddenCommentAuthors = [...config.hiddenCommentAuthors, a]
      }
    },
    showAuthor(a: string) {
      config.hiddenCommentAuthors = config.hiddenCommentAuthors.filter((x) => x !== a)
    },
    bumpScrollGen: () => ++scrollGen,
    get scrollGen() { return scrollGen },
  }
}

export type CommentVisibility = ReturnType<typeof createCommentVisibility>
