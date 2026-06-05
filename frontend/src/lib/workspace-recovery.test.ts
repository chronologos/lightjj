import { describe, it, expect } from 'vitest'
import { planRecoverAll, recoverAllMessage } from './workspace-recovery'

describe('planRecoverAll', () => {
  const ws = (name: string, path?: string) => ({ name, path })

  it('targets workspaces with a path; skips path-less non-current ones', () => {
    const { targets, skipped } = planRecoverAll(
      [ws('a', '/a'), ws('b'), ws('c', '/c')],
      'a',
    )
    expect(targets.map(w => w.name)).toEqual(['a', 'c'])
    expect(skipped).toEqual(['b'])
  })

  it('the current workspace is always a target even without a path', () => {
    const { targets, skipped } = planRecoverAll([ws('cur'), ws('other')], 'cur')
    expect(targets.map(w => w.name)).toEqual(['cur'])
    expect(skipped).toEqual(['other'])
  })

  it('empty list → empty partition', () => {
    expect(planRecoverAll([], 'x')).toEqual({ targets: [], skipped: [] })
  })
})

describe('recoverAllMessage', () => {
  it('all succeeded → success, pluralized', () => {
    expect(recoverAllMessage(3, [], [])).toEqual({ kind: 'success', text: 'Ran update-stale on 3 workspaces' })
  })

  it('singular when ran === 1', () => {
    expect(recoverAllMessage(1, [], [])).toEqual({ kind: 'success', text: 'Ran update-stale on 1 workspace' })
  })

  it('failures → warning naming them', () => {
    expect(recoverAllMessage(2, ['bad'], [])).toEqual({
      kind: 'warning', text: 'Ran update-stale on 2 workspaces; failed: bad',
    })
  })

  it('skipped appended as a note', () => {
    expect(recoverAllMessage(1, [], ['old'])).toEqual({
      kind: 'success', text: 'Ran update-stale on 1 workspace (skipped old — path unknown)',
    })
  })

  it('neutral verb — never claims it "updated" (update-stale is a no-op when fresh)', () => {
    expect(recoverAllMessage(2, [], []).text).not.toContain('Updated')
    expect(recoverAllMessage(2, [], []).text).toContain('Ran update-stale')
  })
})
