import { describe, it, expect } from 'vitest'
import { groupByWithIndex } from './group-by'

describe('groupByWithIndex', () => {
  it('records global index alongside each item', () => {
    const items = [
      { file: 'a.ts' }, // idx 0
      { file: 'b.ts' }, // idx 1
      { file: 'a.ts' }, // idx 2
    ]
    const result = groupByWithIndex(items, i => i.file)
    expect(result.get('a.ts')).toEqual([
      { item: { file: 'a.ts' }, index: 0 },
      { item: { file: 'a.ts' }, index: 2 },
    ])
    expect(result.get('b.ts')).toEqual([
      { item: { file: 'b.ts' }, index: 1 },
    ])
  })

  it('returns empty map for empty input', () => {
    const result = groupByWithIndex([], () => 'key')
    expect(result.size).toBe(0)
  })
})
