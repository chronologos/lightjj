import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render } from '@testing-library/svelte'
import ConflictQueue from './ConflictQueue.svelte'
import type { ConflictEntry } from './api'

const entries: ConflictEntry[] = [
  {
    commit_id: 'abc12345', change_id: 'wlykovwr', description: 'rebase stack',
    files: [{ path: 'src/a.go', sides: 2 }, { path: 'src/b.go', sides: 3 }],
  },
  {
    commit_id: 'def67890', change_id: 'xyzmnopq', description: 'fix',
    files: [{ path: 'README.md', sides: 2 }],
  },
]

const props = (over: Partial<{ resolved: Set<string>; onselect: (it: unknown) => void }> = {}) => ({
  entries,
  resolved: new Set<string>(),
  onselect: vi.fn(),
  ...over,
})

describe('ConflictQueue', () => {
  it('flattens entries preserving jj emission order (topological)', () => {
    const { container } = render(ConflictQueue, { props: props() })
    const paths = [...container.querySelectorAll('.cq-path')].map(e => e.textContent)
    // Order must match: commit[0].files[0..n], commit[1].files[0..n]
    expect(paths).toEqual(['src/a.go', 'src/b.go', 'README.md'])
  })

  it('renders one group header per commit', () => {
    const { container } = render(ConflictQueue, { props: props() })
    expect(container.querySelectorAll('.cq-group')).toHaveLength(2)
    expect(container.querySelectorAll('.cq-change-id')[0].textContent).toBe('wlykovwr')
  })

  it('auto-selects first item on mount', () => {
    const onselect = vi.fn()
    render(ConflictQueue, { props: props({ onselect }) })
    expect(onselect).toHaveBeenCalledWith(
      expect.objectContaining({ commitId: 'abc12345', path: 'src/a.go' }),
    )
  })

  it('j/k navigate within bounds (no wrap — unlike MergePanel block nav)', () => {
    const onselect = vi.fn()
    const { component } = render(ConflictQueue, { props: props({ onselect }) })
    const kd = (key: string) => component.handleKeydown(new KeyboardEvent('keydown', { key }))

    // Auto-select fired once for idx=0.
    onselect.mockClear()
    kd('j'); kd('j'); kd('j')  // 0→1→2, then clamp at 2
    expect(onselect).toHaveBeenCalledTimes(2)
    expect(onselect).toHaveBeenLastCalledWith(expect.objectContaining({ path: 'README.md' }))

    onselect.mockClear()
    kd('k'); kd('k'); kd('k')  // 2→1→0, then clamp at 0
    expect(onselect).toHaveBeenCalledTimes(2)
  })

  it('N-way badge only for sides > 2', () => {
    const { container } = render(ConflictQueue, { props: props() })
    const badges = container.querySelectorAll('.cq-nway')
    expect(badges).toHaveLength(1)
    expect(badges[0].textContent).toBe('3-way')
  })

  it('resolved dots track the resolved set', () => {
    const { container } = render(ConflictQueue, {
      props: props({ resolved: new Set(['abc12345:src/a.go']) }),
    })
    const dots = [...container.querySelectorAll('.cq-dot')].map(d => d.textContent)
    expect(dots).toEqual(['●', '○', '○'])
    expect(container.querySelector('.cq-footer')?.textContent).toContain('1/3')
  })

  it('empty entries → "No conflicts" message, no footer', () => {
    const { container } = render(ConflictQueue, {
      props: { entries: [], resolved: new Set<string>(), onselect: vi.fn() },
    })
    expect(container.querySelector('.cq-empty')).toBeTruthy()
    expect(container.querySelector('.cq-footer')).toBeNull()
  })
})
