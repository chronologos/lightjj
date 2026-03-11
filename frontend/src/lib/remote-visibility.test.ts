import { describe, it, expect } from 'vitest'
import { revsetQuote, buildVisibilityRevset } from './remote-visibility'
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
  remote: 'origin', commit_id: 'abc', description: '', ago: '', tracked: true, ahead: 0, behind: 0, ...over,
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
})
