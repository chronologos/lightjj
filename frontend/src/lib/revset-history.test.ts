import { describe, expect, it } from 'vitest'
import {
  REVSET_OPERATORS,
  insertRevsetOperator,
  moveHistoryIndex,
  normalizeRevset,
  revsetHistoryItems,
} from './revset-history'

describe('revset history', () => {
  it('normalizes submitted revsets', () => {
    expect(normalizeRevset('  trunk()..@  ')).toBe('trunk()..@')
  })

  it('returns newest finite non-empty entries first', () => {
    expect(revsetHistoryItems({
      'mine()': 2,
      '': 10,
      'all()': 3,
      'bad': Number.NaN,
      'trunk()..@': 1,
    })).toEqual(['all()', 'mine()', 'trunk()..@'])
  })

  it('filters by the current query and omits the exact current value', () => {
    expect(revsetHistoryItems({
      'main@origin..@': 3,
      'trunk()..@': 2,
      'mine()': 1,
    }, 'main')).toEqual(['main@origin..@'])

    expect(revsetHistoryItems({
      'trunk()..@': 2,
      'mine()': 1,
    }, 'trunk()..@')).toEqual([])
  })

  it('caps entries to the requested limit', () => {
    expect(revsetHistoryItems({ a: 1, b: 2, c: 3 }, '', 2)).toEqual(['c', 'b'])
  })

  it('moves the keyboard cursor with wrapping', () => {
    expect(moveHistoryIndex(-1, 1, 3)).toBe(0)
    expect(moveHistoryIndex(-1, -1, 3)).toBe(2)
    expect(moveHistoryIndex(2, 1, 3)).toBe(0)
    expect(moveHistoryIndex(0, -1, 3)).toBe(2)
    expect(moveHistoryIndex(0, 1, 0)).toBe(-1)
  })

  it('exposes common revset operators', () => {
    expect(REVSET_OPERATORS.map(op => op.label)).toEqual([
      'f(x)',
      'x-',
      'x+',
      'p:x',
      'x::',
      'x..',
      '::x',
      '..x',
      'x::y',
      'x..y',
      '::',
      '..',
      '~x',
      'x & y',
      'x ~ y',
      'x | y',
    ])
  })

  it('inserts an operator at the current cursor', () => {
    expect(insertRevsetOperator('trunk()@', ' | ', 7, 7)).toEqual({
      value: 'trunk() | @',
      selectionStart: 10,
      selectionEnd: 10,
    })
  })

  it('wraps the selected expression with grouping parens', () => {
    expect(insertRevsetOperator('mine() & mutable()', '()', 9, 18)).toEqual({
      value: 'mine() & (mutable())',
      selectionStart: 20,
      selectionEnd: 20,
    })
  })
})
