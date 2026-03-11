// Revset construction for the per-remote visibility feature.
// Extracted from App.svelte so the quoting rules and @-operator semantics are
// unit-testable — the "nothing visible" bug (quoting the @ operator as part of
// a string literal instead of leaving it unquoted) was found in live testing,
// not a unit test. Now it's locked in.

import type { Bookmark, RemoteVisibility } from './api'

// jj revset string-literal: backslash + double-quote need escaping. Git ref
// names forbid both (git-check-ref-format) but remote names are user-chosen;
// a remote named `my"repo` would otherwise produce a syntax-invalid revset.
export function revsetQuote(s: string): string {
  return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

// Builds a revset that shows commits reachable from the visible remote bookmarks.
// Uses remote_bookmarks(remote="X") — the named `remote=` arg selects by remote name,
// not bookmark name pattern. Returns '' if no remotes are visible.
//
// Per-bookmark enumeration uses `"name"@remote`, NOT `"name@remote"` — quoting
// the whole string makes jj look up a SYMBOL literally named `name@remote`
// (which doesn't exist). The `@` must stay unquoted to function as the
// operator. Remote is also quoted independently to survive special chars.
export function buildVisibilityRevset(vis: RemoteVisibility, bookmarks: Bookmark[]): string {
  const parts: string[] = []
  for (const [remote, entry] of Object.entries(vis)) {
    if (!entry.visible) continue
    const qRemote = revsetQuote(remote)
    if (!entry.hidden?.length) {
      parts.push(`remote_bookmarks(remote=${qRemote})`)
    } else {
      const hidden = new Set(entry.hidden)
      const visible = bookmarks
        .flatMap(bm => (bm.remotes ?? [])
          .filter(r => r.remote === remote && !hidden.has(bm.name))
          .map(() => `${revsetQuote(bm.name)}@${qRemote}`)
        )
      if (visible.length > 0) parts.push(visible.join(' | '))
    }
  }
  if (parts.length === 0) return ''
  return `ancestors(${parts.join(' | ')}, 2)`
}
