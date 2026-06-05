import { describe, it, expect } from 'vitest'
import { revsetQuote, buildVisibilityRevset, syncVisibility } from './remote-visibility'
import type { Bookmark, BookmarkRemote, RemoteVisibility } from './api'

describe('revsetQuote', () => {
  it('wraps in double-quotes', () => {
    expect(revsetQuote('main')).toBe('"main"')
  })

  it('escapes embedded double-quotes', () => {
    // Remote names are user-chosen, no git-check-ref-format restriction.
    // A remote named `my"repo` must not produce a syntax-invalid revset.
    expect(revsetQuote('my"repo')).toBe('"my\\"repo"')
  })

  it('escapes backslashes', () => {
    expect(revsetQuote('path\\like')).toBe('"path\\\\like"')
  })

  it('escapes both (backslash first so escaped-quotes are not re-escaped)', () => {
    // If quote-escape ran first, its output `\"` would have its `\` doubled
    // by the backslash-escape pass → `\\"` → jj sees a literal backslash
    // followed by a quote → parse error. Order matters.
    expect(revsetQuote('a\\b"c')).toBe('"a\\\\b\\"c"')
  })
})

const mkRemote = (over: Partial<BookmarkRemote> = {}): BookmarkRemote => ({
  remote: 'origin', commit_id: 'abc', description: '', author_name: '', author_email: '', commit_ts: 0, mine: false, tracked: true, ahead: 0, behind: 0, ...over,
})
const mkBm = (name: string, remotes: string[]): Bookmark => ({
  name, conflict: false, synced: true, commit_id: 'abc',
  remotes: remotes.map(r => mkRemote({ remote: r })),
})

describe('buildVisibilityRevset', () => {
  it('empty config → empty revset', () => {
    expect(buildVisibilityRevset({}, [])).toBe('')
  })

  it('all remotes hidden → empty revset', () => {
    const vis: RemoteVisibility = { origin: { visible: false }, upstream: { visible: false } }
    expect(buildVisibilityRevset(vis, [])).toBe('')
  })

  it('visible remote, no hidden list → remote_bookmarks(remote=...)', () => {
    const vis: RemoteVisibility = { origin: { visible: true } }
    expect(buildVisibilityRevset(vis, [])).toBe('ancestors(remote_bookmarks(remote="origin"), 2)')
  })

  it('visible remote, empty hidden[] → still uses remote_bookmarks() shorthand', () => {
    // Empty-array is treated same as undefined — !entry.hidden?.length is true
    // for both. Using per-bookmark enumeration for 0 hidden would produce an
    // empty parts[] if bookmarks prop hadn't loaded yet.
    const vis: RemoteVisibility = { origin: { visible: true, hidden: [] } }
    expect(buildVisibilityRevset(vis, [])).toBe('ancestors(remote_bookmarks(remote="origin"), 2)')
  })

  // --- THE BUG: `@` is a revset operator, not part of a string literal ---
  // Original code emitted `"main@upstream"` — jj looks up a SYMBOL literally
  // named `main@upstream` (doesn't exist) → empty result → "nothing visible".
  // Correct form: `"main"@"upstream"` — name quoted, @ unquoted, remote quoted.
  it('per-bookmark enumeration leaves @ unquoted as operator', () => {
    const vis: RemoteVisibility = { upstream: { visible: true, hidden: ['other'] } }
    const bms = [mkBm('main', ['upstream']), mkBm('other', ['upstream'])]
    const revset = buildVisibilityRevset(vis, bms)
    // Must contain `"main"@"upstream"` — the @ outside the quotes.
    expect(revset).toBe('ancestors("main"@"upstream", 2)')
    expect(revset).not.toContain('"main@upstream"')  // the bug form
  })

  it('per-bookmark enumeration joins multiple visible with |', () => {
    const vis: RemoteVisibility = { upstream: { visible: true, hidden: ['hidden-one'] } }
    const bms = [
      mkBm('feat-a', ['upstream']),
      mkBm('feat-b', ['upstream']),
      mkBm('hidden-one', ['upstream']),
    ]
    expect(buildVisibilityRevset(vis, bms))
      .toBe('ancestors("feat-a"@"upstream" | "feat-b"@"upstream", 2)')
  })

  it('per-bookmark enumeration quotes special-char names independently of @', () => {
    // Git-created branch with @ in the NAME — must quote name but not the
    // operator. `"release@v2"@"upstream"` ≠ `"release@v2@upstream"`.
    const vis: RemoteVisibility = { upstream: { visible: true, hidden: ['x'] } }
    const bms = [mkBm('release@v2', ['upstream']), mkBm('x', ['upstream'])]
    const revset = buildVisibilityRevset(vis, bms)
    expect(revset).toBe('ancestors("release@v2"@"upstream", 2)')
    // The bug form: name-@ and @-remote collapsed into one quoted string.
    expect(revset).not.toContain('"release@v2@upstream"')
  })

  it('all bookmarks hidden → remote contributes no part (not empty string)', () => {
    // visible.join(' | ') on an empty array would be `` — if pushed, the
    // final revset would be `ancestors(, 2)` (syntax error). The length>0
    // guard prevents this.
    const vis: RemoteVisibility = { upstream: { visible: true, hidden: ['main'] } }
    const bms = [mkBm('main', ['upstream'])]
    expect(buildVisibilityRevset(vis, bms)).toBe('')
  })

  it('bookmarks on OTHER remotes are excluded from enumeration', () => {
    // The filter `r.remote === remote` scopes to this loop's remote — a
    // bookmark on both origin+upstream should only count once per iteration.
    const vis: RemoteVisibility = { upstream: { visible: true, hidden: ['x'] } }
    const bms = [
      mkBm('main', ['origin', 'upstream']),  // on both
      mkBm('x', ['upstream']),
    ]
    // flatMap over remotes[]: ONE entry (the upstream one), not two.
    expect(buildVisibilityRevset(vis, bms))
      .toBe('ancestors("main"@"upstream", 2)')
  })

  it('multiple visible remotes → parts joined with |', () => {
    // | operand order matches Object.entries insertion order (ES2015+
    // guarantees this for string keys). jj's revset is commutative over |,
    // but this test asserts the exact string — a companion test below
    // verifies the order doesn't affect what's INCLUDED.
    const vis: RemoteVisibility = {
      origin: { visible: true },
      upstream: { visible: true },
    }
    expect(buildVisibilityRevset(vis, []))
      .toBe('ancestors(remote_bookmarks(remote="origin") | remote_bookmarks(remote="upstream"), 2)')
  })

  it('object key order does not affect WHICH remotes are included', () => {
    // Companion to the exact-string test above: flipped key order still
    // produces a revset with both parts. This is the semantic invariant;
    // the exact-string test is the regression lock.
    const vis: RemoteVisibility = {
      upstream: { visible: true },
      origin: { visible: true },
    }
    const revset = buildVisibilityRevset(vis, [])
    expect(revset).toContain('remote_bookmarks(remote="origin")')
    expect(revset).toContain('remote_bookmarks(remote="upstream")')
    expect(revset).toMatch(/^ancestors\(.+ \| .+, 2\)$/)
  })

  it('mixed: one remote shorthand + one per-bookmark enumeration', () => {
    const vis: RemoteVisibility = {
      origin: { visible: true },
      upstream: { visible: true, hidden: ['x'] },
    }
    const bms = [mkBm('main', ['upstream']), mkBm('x', ['upstream'])]
    expect(buildVisibilityRevset(vis, bms))
      .toBe('ancestors(remote_bookmarks(remote="origin") | "main"@"upstream", 2)')
  })

  // --- Indeterminate (null) vs genuinely-empty ('') ---
  // bookmarksPanel.load() only fires on branches-view entry. Before that,
  // hidden-mode can't enumerate → output is UNKNOWN, not empty. Returning
  // '' in both cases made the sync effect overwrite revsetFilter when
  // bookmarks loaded (the '' → 'ancestors(…)' transition looked like a
  // user toggle because prev and filter were both '').

  it('hidden-mode + empty bookmarks → null (indeterminate, not empty)', () => {
    const vis: RemoteVisibility = { origin: { visible: true, hidden: ['x'] } }
    expect(buildVisibilityRevset(vis, [])).toBe(null)
  })

  it('mixed shorthand + hidden-mode + empty bookmarks → null (whole result indeterminate)', () => {
    // origin could use remote_bookmarks() shorthand, but upstream needs
    // enumeration. Partial output would change when bookmarks load — null
    // signals "wait for data" regardless of how many parts are computable.
    const vis: RemoteVisibility = {
      origin: { visible: true },
      upstream: { visible: true, hidden: ['x'] },
    }
    expect(buildVisibilityRevset(vis, [])).toBe(null)
  })

  it('no-hidden + empty bookmarks → shorthand (bookmarks not needed)', () => {
    // remote_bookmarks() is evaluated by jj, not us — empty bookmarks[]
    // doesn't affect it. Only hidden-mode needs the enumeration input.
    const vis: RemoteVisibility = { origin: { visible: true } }
    expect(buildVisibilityRevset(vis, [])).toBe('ancestors(remote_bookmarks(remote="origin"), 2)')
  })
})

describe('syncVisibility', () => {
  // Sequence helper: thread prev through a series of (vr, filter) steps,
  // collecting the apply decision at each step. This tests TRANSITIONS,
  // not just individual calls — the prev threading is load-bearing.
  function run(steps: { vr: string | null; filter: string }[]) {
    let prev: string | undefined = undefined
    return steps.map(({ vr, filter }) => {
      const { nextPrev, apply } = syncVisibility(vr, prev, filter)
      prev = nextPrev
      return { prev, apply }
    })
  }

  // ─── Single-step transition table ───
  // Each row is one syncVisibility call. Covers the 3×N guard matrix:
  //   vr:     null | '' | non-empty
  //   prev:   undefined | '' | non-empty (matching filter or not)
  //   filter: '' | matching prev | custom
  const U = undefined
  it.each([
    // vr,       prev,    filter,   → nextPrev, apply,    scenario
    [null,       U,       '',       U,          null,     'mount, bookmarks not loaded'],
    [null,       '',      '',       U,          null,     'repoPath arrived — RESET prev (the real bug)'],
    [null,       'anc(a)', 'anc(a)', U,         null,     'reload cleared bookmarks — reset, next load rebaseline'],
    ['',         U,       '',       '',         null,     'first fire, no visibility config'],
    ['anc(a)',   U,       '',       'anc(a)',   null,     'first determinate fire — null→loaded, or saved-vis mount'],
    ['anc(a)',   '',      '',       'anc(a)',   'anc(a)', 'first toggle from blank — no-saved-config flow'],
    ['anc(b)',   'anc(a)', 'anc(a)', 'anc(b)',  'anc(b)', 'user tracking, visibility toggled'],
    ['anc(b)',   'anc(a)', '',       'anc(b)',  null,     'user cleared, visibility changes — DO NOT reapply'],
    ['anc(b)',   'anc(a)', 'mine()', 'anc(b)',  null,     'user custom, visibility changes — DO NOT stomp'],
    ['',         'anc(a)', 'anc(a)', '',        '',       'visibility turned off while tracking — clear filter'],
    ['',         'anc(a)', 'mine()', '',        null,     'visibility off, user has custom'],
    ['anc(a)',   'anc(a)', 'anc(a)', 'anc(a)',  'anc(a)', 'idempotent (same vr) — applies but write is no-op'],
  ] as const)('vr=%j prev=%j filter=%j → nextPrev=%j apply=%j (%s)', (vr, prev, filter, expNext, expApply, _scenario) => {
    const result = syncVisibility(vr, prev, filter)
    expect(result.nextPrev).toBe(expNext)
    expect(result.apply).toBe(expApply)
  })

  // ─── Sequence tests — prev threading across multiple fires ───

  it('the reported bug: repoPath async, hidden-mode, switch to branches', () => {
    // THREE-step: mount with repoPath='' → vis={} → vr='' (sets prev='').
    // loadInfo resolves → repoPath set → vis has hidden → vr=null (bookmarks
    // not loaded). null RESETS prev to undefined — without this, step 3
    // would see prev='' === filter='' and apply. Branches → bookmarks load
    // → vr determinate → first-fire path (set prev, don't apply).
    const results = run([
      { vr: '', filter: '' },         // mount: repoPath='' → vis={} → vr=''
      { vr: null, filter: '' },       // loadInfo: vis has hidden, bookmarks=[]
      { vr: 'anc(a|b)', filter: '' }, // branches view → bookmarks load
    ])
    expect(results).toEqual([
      { prev: '', apply: null },          // first fire, prev poisoned to ''
      { prev: undefined, apply: null },   // null RESETS — unpoisons
      { prev: 'anc(a|b)', apply: null },  // first-fire after reset — NOT applied
    ])
  })

  it('two-step variant: bookmarks-not-loaded straight from mount', () => {
    // Simpler case: saved vis loads from localStorage synchronously before
    // the effect fires (config.svelte.ts write-through cache). vr is null
    // from the start — prev never gets poisoned.
    const results = run([
      { vr: null, filter: '' },
      { vr: 'anc(a|b)', filter: '' },
    ])
    expect(results).toEqual([
      { prev: undefined, apply: null },
      { prev: 'anc(a|b)', apply: null },
    ])
  })

  it('no-saved-config flow: mount blank, user toggles, tracks through changes', () => {
    const results = run([
      { vr: '', filter: '' },           // mount, no visibility config
      { vr: 'anc(a)', filter: '' },     // user enables origin — apply
      { vr: 'anc(a|b)', filter: 'anc(a)' }, // user unhides bookmark b — tracks
      { vr: '', filter: 'anc(a|b)' },   // user disables origin — clears
    ])
    expect(results.map(r => r.apply)).toEqual([null, 'anc(a)', 'anc(a|b)', ''])
  })

  it('user clears then visibility changes — effect goes dormant', () => {
    const results = run([
      { vr: '', filter: '' },
      { vr: 'anc(a)', filter: '' },     // apply
      { vr: 'anc(a)', filter: '' },     // user cleared filter (idempotent vr — in practice the effect wouldn't fire, but filter no longer matches prev)
      { vr: 'anc(b)', filter: '' },     // visibility changes — user cleared, DON'T reapply
    ])
    expect(results.map(r => r.apply)).toEqual([null, 'anc(a)', null, null])
  })

  it('user types custom revset — effect goes dormant, stays dormant', () => {
    const results = run([
      { vr: '', filter: '' },
      { vr: 'anc(a)', filter: '' },     // apply
      { vr: 'anc(b)', filter: 'mine()' }, // user typed custom — don't stomp
      { vr: 'anc(c)', filter: 'mine()' }, // still custom — still dormant
      { vr: '', filter: 'mine()' },     // visibility off — still dormant
    ])
    expect(results.map(r => r.apply)).toEqual([null, 'anc(a)', null, null, null])
  })

  it('saved visibility at mount, bookmarks load later, user toggles', () => {
    // With saved hidden-config: vr is null until bookmarks load. After
    // load, vr is determinate but first-fire doesn't apply. User then
    // toggles — filter ('') doesn't match prev (enumeration) → dormant.
    // This is a KNOWN LIMITATION: saved-vis users must explicitly click
    // a visibility chip to start tracking. Documenting, not fixing —
    // auto-applying saved vis at mount would fight with tab-restore's
    // revsetFilter rehydration.
    const results = run([
      { vr: null, filter: '' },
      { vr: 'anc(saved)', filter: '' },  // bookmarks load — first determinate, don't apply
      { vr: 'anc(toggled)', filter: '' }, // user toggles — '' !== 'anc(saved)' → dormant
    ])
    expect(results.map(r => r.apply)).toEqual([null, null, null])
  })

  it('tab-switch restore: filter rehydrated, prev fresh — tracking resumes', () => {
    // AppShell preserves revsetFilter via initialState, but prev is plain
    // `let` — resets on {#key activeTabId} remount. User was tracking in
    // tab A (filter='anc'), switches away and back → filter restored but
    // prev=undefined. Mount 3-step runs again; filter never matches prev
    // until bookmarks load rebaselines prev to the SAME revset the filter
    // was restored to. Then the next toggle picks up tracking.
    const results = run([
      { vr: '', filter: 'anc(a)' },       // remount: vis={}, filter RESTORED
      { vr: null, filter: 'anc(a)' },     // loadInfo: vis has hidden — reset
      { vr: 'anc(a)', filter: 'anc(a)' }, // bookmarks load — same revset as restored filter
      { vr: 'anc(b)', filter: 'anc(a)' }, // user toggles — prev matches filter
    ])
    expect(results.map(r => r.apply)).toEqual([null, null, null, 'anc(b)'])
  })

  it('tracking survives a null interlude — resume after reload', () => {
    // User is tracking (prev='anc', filter='anc'). Bookmarks briefly clear
    // (tab A→B→A where B triggered a reload). null resets prev, but when
    // bookmarks reload with the SAME revset, prev is rebaseline'd to that
    // value. Next toggle: filter still 'anc', prev 'anc' → tracking resumes.
    const results = run([
      { vr: '', filter: '' },
      { vr: 'anc(a)', filter: '' },       // first toggle — apply
      { vr: null, filter: 'anc(a)' },     // reload clears — reset prev
      { vr: 'anc(a)', filter: 'anc(a)' }, // reload completes, same revset — first-fire
      { vr: 'anc(b)', filter: 'anc(a)' }, // user toggles — filter matches prev → apply
    ])
    expect(results.map(r => r.apply)).toEqual([null, 'anc(a)', null, null, 'anc(b)'])
  })
})
