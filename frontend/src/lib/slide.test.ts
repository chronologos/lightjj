import { describe, it, expect } from 'vitest'
import { computeSlide } from './slide'
import type { LogEntry } from './api'

const mk = (
  commit_id: string,
  parent_ids: string[],
  over: Partial<LogEntry['commit']> = {},
): LogEntry => ({
  commit: {
    change_id: 'z' + commit_id, commit_id,
    change_prefix: 1, commit_prefix: 1,
    is_working_copy: false, hidden: false, immutable: false,
    conflicted: false, divergent: false, empty: false, mine: true,
    parent_ids, ...over,
  },
  description: '', graph_lines: [],
})

// Linear stack, log order (newest first): C → B → A → root
const linear = () => [
  mk('ccc', ['bbb']),
  mk('bbb', ['aaa']),
  mk('aaa', ['000'], { immutable: true }),
  mk('000', [], { immutable: true }),
]

describe('computeSlide — down (toward root, --insert-before parent)', () => {
  it('mid-stack: targets parent commit_id', () => {
    expect(computeSlide(linear(), 0, 'down'))
      .toEqual({ ok: true, dest: 'bbb', targetMode: '--insert-before' })
  })

  it('blocked: parent is immutable', () => {
    expect(computeSlide(linear(), 1, 'down'))
      .toEqual({ ok: false, reason: 'Cannot slide past immutable parent' })
  })

  it('blocked: source is immutable', () => {
    expect(computeSlide(linear(), 2, 'down'))
      .toEqual({ ok: false, reason: 'Cannot slide immutable revision' })
  })

  it('blocked: source is a merge', () => {
    const e = [mk('mmm', ['aaa', 'bbb']), mk('aaa', []), mk('bbb', [])]
    expect(computeSlide(e, 0, 'down'))
      .toEqual({ ok: false, reason: 'Cannot slide a merge commit — use Rebase' })
  })

  it('blocked: parent is a merge (would fold src into merge position)', () => {
    const e = [mk('ccc', ['mmm']), mk('mmm', ['aaa', 'bbb']), mk('aaa', []), mk('bbb', [])]
    expect(computeSlide(e, 0, 'down'))
      .toEqual({ ok: false, reason: 'Parent is a merge — use Rebase' })
  })

  it('blocked: parent not in current revset view', () => {
    const e = [mk('ccc', ['bbb'])] // bbb absent
    expect(computeSlide(e, 0, 'down'))
      .toEqual({ ok: false, reason: 'Parent not in current view' })
  })

  it('blocked: no parent (root)', () => {
    expect(computeSlide(linear(), 3, 'down'))
      .toEqual({ ok: false, reason: 'Cannot slide immutable revision' })
    // mutable orphan (synthetic): hits the no-parent branch
    expect(computeSlide([mk('xxx', [])], 0, 'down'))
      .toEqual({ ok: false, reason: 'Revision has no parent' })
  })
})

describe('computeSlide — up (toward tip, --insert-after child)', () => {
  it('mid-stack: targets sole child commit_id', () => {
    expect(computeSlide(linear(), 1, 'up'))
      .toEqual({ ok: true, dest: 'ccc', targetMode: '--insert-after' })
  })

  it('blocked: at tip (no children in view)', () => {
    expect(computeSlide(linear(), 0, 'up'))
      .toEqual({ ok: false, reason: 'Already at tip — no child to slide past' })
  })

  it('blocked: fork point (two children)', () => {
    const e = [mk('c1', ['bbb']), mk('c2', ['bbb']), mk('bbb', ['aaa']), mk('aaa', [])]
    expect(computeSlide(e, 2, 'up'))
      .toEqual({ ok: false, reason: 'Multiple children (fork point) — use Rebase' })
  })

  it('blocked: sole child is a merge', () => {
    const e = [mk('mmm', ['bbb', 'xxx']), mk('bbb', ['aaa']), mk('aaa', [])]
    expect(computeSlide(e, 1, 'up'))
      .toEqual({ ok: false, reason: 'Child is a merge — use Rebase' })
  })

  it('blocked: sole child is immutable', () => {
    const e = [mk('ccc', ['bbb'], { immutable: true }), mk('bbb', ['aaa']), mk('aaa', [])]
    expect(computeSlide(e, 1, 'up'))
      .toEqual({ ok: false, reason: 'Cannot slide past immutable child' })
  })

  it('blocked: source is a merge (even going up)', () => {
    const e = [mk('ccc', ['mmm']), mk('mmm', ['aaa', 'bbb']), mk('aaa', []), mk('bbb', [])]
    expect(computeSlide(e, 1, 'up'))
      .toEqual({ ok: false, reason: 'Cannot slide a merge commit — use Rebase' })
  })
})

describe('computeSlide — graph-edge not display-row', () => {
  // Two parallel branches interleaved in display order (jj log does this):
  //   d2 (→a)   ← idx 0
  //   c1 (→b1)  ← idx 1
  //   b1 (→a)   ← idx 2
  //   a  (root) ← idx 3
  // Display-adjacent d2/c1 are NOT graph-adjacent. Sliding c1 down must
  // target b1 (its parent), not d2 (its display neighbor).
  const interleaved = [
    mk('d2', ['aaa']),
    mk('c1', ['b1']),
    mk('b1', ['aaa']),
    mk('aaa', []),
  ]

  it('down follows parent_ids, ignores display adjacency', () => {
    expect(computeSlide(interleaved, 1, 'down'))
      .toEqual({ ok: true, dest: 'b1', targetMode: '--insert-before' })
  })

  it('up finds child by reverse edge, ignores display adjacency', () => {
    expect(computeSlide(interleaved, 2, 'up'))
      .toEqual({ ok: true, dest: 'c1', targetMode: '--insert-after' })
  })

  it('fork at aaa blocks up (d2 and b1 both children)', () => {
    expect(computeSlide(interleaved, 3, 'up'))
      .toEqual({ ok: false, reason: 'Multiple children (fork point) — use Rebase' })
  })
})

describe('computeSlide — bounds', () => {
  it('idx out of range', () => {
    expect(computeSlide(linear(), -1, 'down')).toEqual({ ok: false, reason: 'No revision selected' })
    expect(computeSlide(linear(), 99, 'up')).toEqual({ ok: false, reason: 'No revision selected' })
    expect(computeSlide([], 0, 'down')).toEqual({ ok: false, reason: 'No revision selected' })
  })
})
