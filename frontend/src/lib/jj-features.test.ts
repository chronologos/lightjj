import { describe, it, expect } from 'vitest'
import { setDetectedJJVersion, jjSupports, missingJJFeatures, detectedJJVersion } from './jj-features.svelte'

// Module-level $state means tests share `features`/`detected`; each test sets
// them explicitly (via setDetectedJJVersion's test-injection second arg) so
// order doesn't matter.
//
// Gating reads the BACKEND's feature map (GET /api/info `features`) — the
// version string is display-only. These tests inject the map directly; in
// prod it comes from resolvedInfo() (the memoized info response).
describe('jj-features', () => {
  it('reads supported/unsupported from the backend feature map', () => {
    setDetectedJJVersion('jj 0.39.0', { indexChangedPaths: true, workspaceRootTmpl: false })
    expect(detectedJJVersion()).toEqual([0, 39])
    expect(jjSupports('indexChangedPaths')).toBe(true)
    expect(jjSupports('workspaceRootTmpl')).toBe(false)
    expect(missingJJFeatures()).toEqual(['complete workspace paths'])
  })

  it('all gates supported → no missing features', () => {
    setDetectedJJVersion('jj 0.40.0', { indexChangedPaths: true, workspaceRootTmpl: true })
    expect(jjSupports('indexChangedPaths')).toBe(true)
    expect(jjSupports('workspaceRootTmpl')).toBe(true)
    expect(missingJJFeatures()).toEqual([])
  })

  it('all gates unsupported → all listed as missing', () => {
    setDetectedJJVersion('jj 0.29.0', { indexChangedPaths: false, workspaceRootTmpl: false })
    expect(jjSupports('indexChangedPaths')).toBe(false)
    expect(jjSupports('workspaceRootTmpl')).toBe(false)
    const missing = missingJJFeatures()
    expect(missing).toContain('file-history index')
    expect(missing).toContain('complete workspace paths')
  })

  it('no feature map (info not loaded / backend predates it) → optimistic', () => {
    // No injected map and no resolved info in tests → features stays null.
    setDetectedJJVersion('jj 0.29.0')
    expect(jjSupports('indexChangedPaths')).toBe(true)
    expect(jjSupports('workspaceRootTmpl')).toBe(true)
    expect(missingJJFeatures()).toEqual([])
  })

  it('gate name absent from backend map → optimistic for that gate only', () => {
    setDetectedJJVersion('jj 0.41.0', { workspaceRootTmpl: true })
    expect(jjSupports('indexChangedPaths')).toBe(true) // absent ≠ false
    expect(jjSupports('workspaceRootTmpl')).toBe(true)
    expect(missingJJFeatures()).toEqual([])
  })

  it('nightly suffix parses for the display version', () => {
    setDetectedJJVersion('jj 0.41.0-nightly+abc', {})
    expect(detectedJJVersion()).toEqual([0, 41])
  })

  it('unparseable version string → null detected; gating still follows the map', () => {
    setDetectedJJVersion('garbage', { indexChangedPaths: false, workspaceRootTmpl: true })
    expect(detectedJJVersion()).toBeNull()
    expect(jjSupports('indexChangedPaths')).toBe(false)
    expect(jjSupports('workspaceRootTmpl')).toBe(true)
  })
})
