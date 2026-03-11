import { describe, it, expect } from 'vitest'
import { createConfirmGate } from './confirm-gate.svelte'

// confirm-gate is a $state-backed factory. Vitest's Svelte plugin handles the
// rune; no flushSync needed since we read `armed` synchronously (no $effect).

describe('createConfirmGate', () => {
  it('first press arms; returns true (do not fire)', () => {
    const g = createConfirmGate<'d' | 'f'>()
    expect(g.gate('d', true)).toBe(true)
    expect(g.armed).toBe('d')
  })

  it('second press of SAME key fires; disarms; returns false', () => {
    const g = createConfirmGate<'d' | 'f'>()
    g.gate('d', true)
    expect(g.gate('d', true)).toBe(false)
    expect(g.armed).toBe(null)
  })

  it('different key while armed → disarms first, arms second (cross-key steals the arm)', () => {
    // Pressing `f` while armed for `d` is NOT the confirm — it's a different
    // intent. The gate re-arms for `f` rather than firing `d` or rejecting.
    // This matches the code: `armed === key` check is per-key.
    const g = createConfirmGate<'d' | 'f'>()
    g.gate('d', true)
    expect(g.gate('f', true)).toBe(true)   // arms f, does not fire
    expect(g.armed).toBe('f')
    expect(g.gate('f', true)).toBe(false)  // now fires f
  })

  it('destructive=false bypasses (fires immediately) AND disarms any pending', () => {
    // Single-remote track (non-destructive) after an armed `d` should fire
    // immediately and clear the `d` arm — user changed intent.
    const g = createConfirmGate<'d' | 't'>()
    g.gate('d', true)
    expect(g.gate('t', false)).toBe(false) // fires
    expect(g.armed).toBe(null)             // d no longer armed
  })

  it('disarm() clears pending without firing', () => {
    const g = createConfirmGate<'d'>()
    g.gate('d', true)
    g.disarm()
    expect(g.armed).toBe(null)
    // Next press is a FRESH first-press, not the stale second-press.
    expect(g.gate('d', true)).toBe(true)
  })

  it('triple-press re-arms (fire is a one-shot, not a toggle)', () => {
    // Second press fires and disarms; a third press is a fresh first-press.
    // This is what prevents accidental double-fire on key-repeat.
    const g = createConfirmGate<'d'>()
    g.gate('d', true)         // arm
    g.gate('d', true)         // fire + disarm
    expect(g.gate('d', true)).toBe(true)  // re-arm, not fire
    expect(g.armed).toBe('d')
  })
})
