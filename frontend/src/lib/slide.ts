// Shift+J/K slide-commit: jj-arrange-style single-step reorder along a
// LINEAR graph segment. Target is the topological parent/child (graph edge),
// NOT revisions[selectedIndex±1] — a side-branch commit visually adjacent to
// an unrelated row must not swap with it. At merge/fork points jj arrange has
// separate fold/unfold actions; we punt with a reason string.

import type { LogEntry } from './api'

export type SlideDir = 'down' | 'up'
type Commit = LogEntry['commit']

export type Slide =
  | { ok: true; dest: string; targetMode: '--insert-before' | '--insert-after' }
  | { ok: false; reason: string }

const no = (reason: string): Slide => ({ ok: false, reason })

/** Compute the rebase target for sliding `entries[idx]` one step in `dir`.
 *  `down` = toward root = swap with parent = `--insert-before <parent>`.
 *  `up`   = toward tip  = swap with child  = `--insert-after <child>`.
 *  Children are derived from parent_ids edges within `entries` — a child
 *  outside the current revset is invisible (matches jj arrange's revset scope). */
export function computeSlide(entries: LogEntry[], idx: number, dir: SlideDir): Slide {
  const src = entries[idx]?.commit
  if (!src) return no('No revision selected')
  if (src.immutable) return no('Cannot slide immutable revision')

  const parents = src.parent_ids ?? []
  if (parents.length > 1) return no('Cannot slide a merge commit — use Rebase')

  const byCid = new Map<string, Commit>(entries.map(e => [e.commit.commit_id, e.commit]))

  if (dir === 'down') {
    if (parents.length === 0) return no('Revision has no parent')
    const parent = byCid.get(parents[0])
    if (!parent) return no('Parent not in current view')
    if (parent.immutable) return no('Cannot slide past immutable parent')
    // --insert-before <merge> makes src inherit the merge's N parents (src
    // becomes the merge) — that's jj arrange's "fold", not a swap. Symmetric
    // with the child-is-merge check below.
    if ((parent.parent_ids ?? []).length > 1) return no('Parent is a merge — use Rebase')
    return { ok: true, dest: parent.commit_id, targetMode: '--insert-before' }
  }

  // dir === 'up': scan for children of src within the visible set.
  const children: Commit[] = []
  for (const e of entries) {
    if ((e.commit.parent_ids ?? []).includes(src.commit_id)) children.push(e.commit)
  }
  if (children.length === 0) return no('Already at tip — no child to slide past')
  if (children.length > 1) return no('Multiple children (fork point) — use Rebase')
  const child = children[0]
  if (child.immutable) return no('Cannot slide past immutable child')
  // Child being a merge means src is one of N parents; --insert-after would
  // collapse the merge's other-parent edge onto src's old parent. Punt.
  if ((child.parent_ids ?? []).length > 1) return no('Child is a merge — use Rebase')
  return { ok: true, dest: child.commit_id, targetMode: '--insert-after' }
}
