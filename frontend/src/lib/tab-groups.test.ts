import { describe, it, expect } from 'vitest'
import { groupTabs, tabGroupKey, colorFor } from './tab-groups'
import type { TabInfo } from './api'

const t = (id: string, extra: Partial<TabInfo> = {}): TabInfo =>
  ({ id, kind: 'repo', name: 'x', path: '/p' + id, ...extra })

describe('groupTabs', () => {
  it('groups tabs sharing repoRoot; key/label/tabs reflect the group', () => {
    const tabs = [
      t('0', { path: '/x/proj', repoRoot: '/x/proj', wsName: 'default' }),
      t('1', { path: '/x/proj-ws', repoRoot: '/x/proj', wsName: 'feature' }),
    ]
    const g = groupTabs(tabs)
    expect(g).toHaveLength(1)
    expect(g[0].key).toBe('/x/proj')
    expect(g[0].label).toBe('proj')
    expect(g[0].tabs).toHaveLength(2)
  })

  it('missing repoRoot falls back to path — each tab is its own group', () => {
    const g = groupTabs([t('0'), t('1')])
    expect(g).toHaveLength(2)
    expect(g[0].key).toBe('/p0')
    expect(g[1].key).toBe('/p1')
  })

  it('preserves first-seen order for interleaved [A, B, A]', () => {
    const g = groupTabs([
      t('0', { repoRoot: '/rA' }),
      t('1', { repoRoot: '/rB' }),
      t('2', { repoRoot: '/rA' }),
    ])
    expect(g.map(x => x.key)).toEqual(['/rA', '/rB'])
    expect(g[0].tabs).toHaveLength(2)
  })

  it('marks a group stale if any member tab is stale', () => {
    const g = groupTabs([
      t('0', { repoRoot: '/r' }),
      t('1', { repoRoot: '/r', stale: true }),
    ])
    expect(g[0].stale).toBe(true)
  })
})

describe('tabGroupKey', () => {
  it('is repoRoot when set, else path', () => {
    expect(tabGroupKey(t('0', { repoRoot: '/r' }))).toBe('/r')
    expect(tabGroupKey(t('0'))).toBe('/p0')
  })
})

describe('colorFor', () => {
  it('is stable and in [0, 8)', () => {
    expect(colorFor('/r')).toBe(colorFor('/r'))
    expect(colorFor('/x')).toBeGreaterThanOrEqual(0)
    expect(colorFor('/x')).toBeLessThan(8)
  })
})
