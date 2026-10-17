// PURE — view model for FileTreePanel (full tree at a revision, issue #39).
// The server (GET /api/file-tree) returns ONE directory's children at a time,
// already sorted dirs-first; this module turns the loaded-directories map +
// expanded set into the flat, virtualizable row list, and owns the small
// helpers (changed-file marks, ancestor paths, content classification) that
// the component would otherwise inline.

import type { FileChange, TreeEntry } from './api'
import { IMAGE_RE } from './api'

export type { TreeEntry }

/** Load state of one directory's children. */
export type DirState =
  | { status: 'loading' }
  | { status: 'error'; error: string }
  | { status: 'ok'; entries: TreeEntry[]; omitted: number }

export type TreeRow =
  | { kind: 'entry'; key: string; entry: TreeEntry; depth: number }
  /** Placeholder under an expanded dir whose children aren't usable yet. */
  | { kind: 'status'; key: string; depth: number; text: string; error?: boolean }

/** Flatten the visible tree: DFS from the root (`''`), descending into dirs
 *  in `expanded`. O(visible rows). An expanded dir with no DirState yet is
 *  shown as loading (the component fires the fetch on expand). */
export function flattenTree(dirs: ReadonlyMap<string, DirState>, expanded: ReadonlySet<string>): TreeRow[] {
  const rows: TreeRow[] = []
  const walk = (dir: string, depth: number) => {
    const st = dirs.get(dir)
    if (!st || st.status === 'loading') {
      rows.push({ kind: 'status', key: `\0loading:${dir}`, depth, text: 'Loading…' })
      return
    }
    if (st.status === 'error') {
      rows.push({ kind: 'status', key: `\0error:${dir}`, depth, text: st.error, error: true })
      return
    }
    if (st.entries.length === 0 && dir === '') {
      rows.push({ kind: 'status', key: '\0empty', depth, text: '(no files at this revision)' })
    }
    for (const e of st.entries) {
      rows.push({ kind: 'entry', key: e.path, entry: e, depth })
      if (e.type === 'dir' && expanded.has(e.path)) walk(e.path, depth + 1)
    }
    if (st.omitted > 0) {
      rows.push({ kind: 'status', key: `\0more:${dir}`, depth, text: `… ${st.omitted.toLocaleString()} more entries — use the filter (/) to reach them` })
    }
  }
  walk('', 0)
  return rows
}

/** Ancestor directories of a repo path, outermost first: `a/b/c.go` → `['a', 'a/b']`. */
export function ancestorDirs(path: string): string[] {
  const parts = path.split('/')
  const out: string[] = []
  for (let i = 1; i < parts.length; i++) out.push(parts.slice(0, i).join('/'))
  return out
}

/** Parent directory of a repo path (`''` for top-level entries). */
export function parentDir(path: string): string {
  const i = path.lastIndexOf('/')
  return i < 0 ? '' : path.slice(0, i)
}

export interface ChangeMarks {
  /** path → status letter (A/M/D/R/C) + conflict flag for files this revision touched. */
  files: Map<string, { type: string; conflict: boolean }>
  /** Every ancestor dir of a changed path — gets a "contains changes" dot. */
  dirs: Set<string>
}

/** Index the revision's changed-files list (api.files) for O(1) row marks.
 *  Deleted files don't exist in the tree, but their dirs still changed. */
export function changeMarks(changes: readonly FileChange[]): ChangeMarks {
  const files = new Map<string, { type: string; conflict: boolean }>()
  const dirs = new Set<string>()
  for (const c of changes) {
    files.set(c.path, { type: c.type, conflict: c.conflict })
    for (const d of ancestorDirs(c.path)) dirs.add(d)
  }
  return { files, dirs }
}

export type ContentKind = 'image' | 'binary' | 'text'

/** How the viewer should show a file. Images by extension (rendered from
 *  /api/file-raw); binary = a NUL in the first 8 KB (git's heuristic) — the
 *  JSON transport keeps NULs as \u0000, invalid UTF-8 becomes U+FFFD. */
export function contentKind(path: string, content: string): ContentKind {
  if (IMAGE_RE.test(path)) return 'image'
  if (content.slice(0, 8192).includes('\u0000')) return 'binary'
  return 'text'
}

/** Make control characters in a repo path visible for DISPLAY (`a\nb` would
 *  otherwise render as "a b" and be indistinguishable from a real space).
 *  Never use the result as an identity — keys/requests keep the raw path. */
export function visiblePath(p: string): string {
  // eslint-disable-next-line no-control-regex
  return p.replace(/[\u0000-\u001f\u007f]/g, (c) =>
    c === '\n' ? '\\n' : c === '\t' ? '\\t' : c === '\r' ? '\\r' : `\\x${c.charCodeAt(0).toString(16).padStart(2, '0')}`)
}

/** Split file content into display lines (a trailing newline doesn't add an
 *  empty last line; CRLF shows as LF). */
export function contentLines(content: string): string[] {
  if (content === '') return []
  const lines = content.split('\n')
  if (lines[lines.length - 1] === '') lines.pop()
  return lines.map(l => l.endsWith('\r') ? l.slice(0, -1) : l)
}
