// Who holds unsaved work, and what would destroy it.
//
// Every surface with an edit buffer registers here for as long as it is mounted;
// every action that unmounts buffers asks confirmDiscard() first. Before this each
// exit had its own confirm() or none: five editors, two guarded exits.

import { getContext, setContext, onDestroy } from 'svelte'

/** What the user is about to do, weakest first. Each destroys everything the one
 *  before it does. */
export type Leave = 'selection' | 'view' | 'tab'
const RANK: Record<Leave, number> = { selection: 0, view: 1, tab: 2 }

export interface UnsavedSource {
  /** Shown in the prompt: "Discard unsaved changes to <label>?" */
  label: () => string
  /** Weakest action that destroys this buffer. */
  lostOn: Leave
  dirty: () => boolean
}

export interface UnsavedHandle {
  /** The buffer changed again — a previously accepted discard no longer covers it. */
  touch(): void
  dispose(): void
}

export interface Unsaved {
  register(s: UnsavedSource): UnsavedHandle
  /** Would `leave` destroy anything? Imperative — not reactive. */
  any(leave: Leave): boolean
  /** True when `leave` may proceed: nothing to lose, or the user agreed. */
  confirmDiscard(leave: Leave): boolean
}

export function createUnsaved(opts: { onRelease?: () => void } = {}): Unsaved {
  const sources = new Map<UnsavedSource, { discarded: boolean }>()
  const atRisk = (leave: Leave) => [...sources].filter(([s, st]) =>
    !st.discarded && RANK[s.lostOn] <= RANK[leave] && s.dirty())

  return {
    register(s) {
      const st = { discarded: false }
      sources.set(s, st)
      return {
        touch() { st.discarded = false },
        dispose() { if (sources.delete(s)) opts.onRelease?.() },
      }
    },
    any: (leave) => atRisk(leave).length > 0,
    confirmDiscard(leave) {
      const lost = atRisk(leave)
      if (lost.length === 0) return true
      if (!confirm(`Discard unsaved changes to ${lost.map(([s]) => s.label()).join(', ')}?`)) return false
      // Agreed to: the action that follows may take a moment to unmount them.
      for (const [, st] of lost) st.discarded = true
      return true
    },
  }
}

export const UNSAVED_KEY = Symbol('unsaved')
export const provideUnsaved = (u: Unsaved) => setContext(UNSAVED_KEY, u)

/** Register the calling component's buffer until it unmounts. No-op handle when no
 *  registry is provided (isolated component tests). */
export function registerUnsaved(s: UnsavedSource): UnsavedHandle {
  const handle = getContext<Unsaved | undefined>(UNSAVED_KEY)?.register(s) ?? { touch() {}, dispose() {} }
  onDestroy(() => handle.dispose())
  return handle
}
/** The registry itself, for components that perform a destroying action. */
export const useUnsaved = (): Unsaved | undefined => getContext<Unsaved | undefined>(UNSAVED_KEY)
