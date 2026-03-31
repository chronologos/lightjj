// Divergence classification — pure functions over DivergenceEntry[].
// See docs/jj-divergence.md for the taxonomy and why certain heuristics fail.
//
// Input: flat list from /api/divergence in jj's index emission order.
// Output: groups (stack or single) with kind + live-hint + collateral.
//
// The classifier does NOT fetch tree deltas — that's an extra round trip the
// panel does lazily on open. Kind here is the structural classification
// (parents same/different, stack/single); "pure rebase" vs "rebase+edit"
// requires the diffRange call.

import type { DivergenceEntry } from './api'

// Structural kind — before tree-delta refinement. The panel combines this with
// diffRange(v0,v1) to land on the final taxonomy row (see doc's table).
export type DivergenceKind =
  | 'same-parent'  // concurrent edit from same base → metadata-drift or edit-conflict depending on tree delta
  | 'diff-parent'  // one was rebased → pure-rebase or rebase+edit depending on tree delta
  | 'compound'     // 3+ versions, parents vary → group by parent, recurse (panel shows as list)

// One group = one unit of resolution. A stack resolves as one click.
export interface DivergenceGroup {
  rootChangeId: string         // the divergence root — where stacks terminate
  changeIds: string[]          // ordered root→tip; length>1 = stack
  versions: DivergenceEntry[][] // versions[i] = all copies of changeIds[i], column-aligned IF alignable
  kind: DivergenceKind
  // alignable=false means alignColumns couldn't establish a bijective
  // parent↔child mapping (arity mismatch, or a parent with 0/2+ children at
  // the next level). versions[][] is then in RAW /N ORDER — columns do NOT
  // represent descent chains. buildPlan indexing would abandon wrong commits.
  // The panel must disable Keep and direct the user to manual resolution.
  // Distinct from kind='compound': compound via classifyKind (3+ mixed-parent
  // root versions) is alignable — it's a 1-level "stack", Keep is safe.
  alignable: boolean
  liveVersion: number | null   // index into versions[0] that's WC-reachable, or null if tautological/ambiguous
  descendants: DivergenceEntry[] // non-divergent children of any version's tip — warm-merge pins etc.
  conflictedBookmarks: { name: string; changeId: string }[] // bookmarks appearing on >1 version of same change_id
}

export function classify(entries: DivergenceEntry[]): DivergenceGroup[] {
  const divergent = entries.filter(e => e.divergent)
  const descendants = entries.filter(e => !e.divergent)

  // Group divergent by change_id. Map preserves insertion order = jj's index
  // order = /N offsets. versions[0] is /0, versions[1] is /1, etc.
  const byChange = new Map<string, DivergenceEntry[]>()
  for (const e of divergent) {
    const arr = byChange.get(e.change_id) ?? []
    arr.push(e)
    byChange.set(e.change_id, arr)
  }

  // Stack detection: X inherits divergence if every version's parent COMMIT
  // is a commit in byChange[p0]. Walk up to the root.
  //
  // The commit-presence check is what makes this walk follow real DAG edges
  // and therefore terminate (minimum-depth argument: cycle's shallowest
  // commit must have a strictly-shallower parent also in the cycle →
  // contradiction). byChange.has(change_id) alone is NOT a DAG edge — it's
  // a label coincidence. byChange is filtered by `& mutable()`; a version's
  // parent can be the IMMUTABLE copy of a change whose mutable copy is in
  // byChange → byChange.has() true but edge is phantom. One phantom edge in
  // a 154-node warm-merge chain closed a cycle → stack overflow.
  //
  // Both arity guards (>=2) are semantic, not termination: stack inheritance
  // needs 2+ copies at BOTH levels. A 1-copy parent with a 2-copy child would
  // chain them, root has nVersions=1, panel shows "immutable sibling" error
  // for the user's genuinely-resolvable 2-copy click. A 1-copy child isn't
  // panel-resolvable at all.
  //
  // The commit-check subsumes the old change_id .every(): parent_commit_ids
  // and parent_change_ids are positionally aligned (same parents.map() in the
  // template); a commit_id in byChange[p0] has change_id p0 by construction.
  const rootOf = new Map<string, string>()
  const findRoot = (cid: string): string => {
    const cached = rootOf.get(cid)
    if (cached) return cached
    const vs = byChange.get(cid)!
    const p0 = vs[0].parent_change_ids[0]
    const parentCommits = new Set(byChange.get(p0)?.map(v => v.commit_id))
    const inherits = vs.length >= 2
      && parentCommits.size >= 2
      && vs.every(v => parentCommits.has(v.parent_commit_ids[0]))
    const root = inherits ? findRoot(p0) : cid
    rootOf.set(cid, root)
    return root
  }

  // Group by root, build chains root→tip.
  const chains = new Map<string, string[]>()
  for (const cid of byChange.keys()) {
    const root = findRoot(cid)
    const chain = chains.get(root) ?? []
    chain.push(cid)
    chains.set(root, chain)
  }
  // Order each chain root→tip: root has no divergent parent in this set,
  // each next link's parent is the previous. Linear topo sort.
  for (const [root, chain] of chains) {
    if (chain.length === 1) continue
    const parentCid = (c: string) => byChange.get(c)![0].parent_change_ids[0]
    const sorted = [root]
    const remaining = new Set(chain.filter(c => c !== root))
    while (remaining.size > 0) {
      const next = [...remaining].find(c => parentCid(c) === sorted[sorted.length - 1])
      if (!next) break // shouldn't happen for a true linear stack; leave remainder unsorted
      sorted.push(next)
      remaining.delete(next)
    }
    chains.set(root, [...sorted, ...remaining])
  }

  // Assemble groups.
  const groups: DivergenceGroup[] = []
  for (const [root, chain] of chains) {
    const versions = chain.map(cid => byChange.get(cid)!)

    // Column alignment: findRoot checks parent CHANGE_IDs match but /N order
    // is per-commit index-insertion — nothing guarantees versions[L][i]'s
    // parent is versions[L-1][i]. Crossed columns → buildPlan abandons the
    // wrong commits. Permute each level so column i is the actual descendant
    // chain. Arity mismatch or non-bijective mapping → bail to compound
    // (the panel falls back to list rendering, no one-click keep).
    const aligned = alignColumns(versions)
    const alignable = aligned !== null
    const finalVersions = aligned ?? versions
    const kind = alignable ? classifyKind(finalVersions[0]) : 'compound'

    const liveVersion = alignable ? detectLive(finalVersions) : null

    // Descendants: non-divergent entries whose parent_commit_id matches any
    // version's commit_id. These pin stale stacks visible.
    const allCommitIds = new Set(finalVersions.flat().map(v => v.commit_id))
    const groupDescendants = descendants.filter(d =>
      d.parent_commit_ids.some(p => allCommitIds.has(p))
    )

    // Conflicted bookmarks: same name on multiple versions of same change_id.
    const conflictedBookmarks: { name: string; changeId: string }[] = []
    for (let i = 0; i < chain.length; i++) {
      const bookmarkCounts = new Map<string, number>()
      for (const v of finalVersions[i]) {
        for (const b of v.bookmarks) {
          bookmarkCounts.set(b, (bookmarkCounts.get(b) ?? 0) + 1)
        }
      }
      for (const [name, count] of bookmarkCounts) {
        if (count > 1) conflictedBookmarks.push({ name, changeId: chain[i] })
      }
    }

    groups.push({
      rootChangeId: root,
      changeIds: chain,
      versions: finalVersions,
      kind,
      alignable,
      liveVersion,
      descendants: groupDescendants,
      conflictedBookmarks,
    })
  }

  return groups
}

// Permutes each level so versions[L][i].parent is versions[L-1][i]. Returns
// null if alignment is impossible (arity mismatch, or a parent has 0 or 2+
// children in the next level — compound shape, not a clean stack).
function alignColumns(versions: DivergenceEntry[][]): DivergenceEntry[][] | null {
  if (versions.length === 1) return versions // single change, nothing to align
  const n = versions[0].length
  if (versions.some(l => l.length !== n)) return null // arity mismatch

  const aligned = [versions[0]] // root level keeps /N order
  for (let L = 1; L < versions.length; L++) {
    const parentLevel = aligned[L - 1]
    const thisLevel = versions[L]
    const permuted: DivergenceEntry[] = []
    const used = new Set<string>()
    for (const parent of parentLevel) {
      const child = thisLevel.find(v =>
        !used.has(v.commit_id) && v.parent_commit_ids.includes(parent.commit_id)
      )
      if (!child) return null // parent with no unclaimed child → non-bijective
      used.add(child.commit_id)
      permuted.push(child)
    }
    aligned.push(permuted)
  }
  return aligned
}

function classifyKind(rootVersions: DivergenceEntry[]): DivergenceKind {
  // Compare parent COMMIT_IDs (not change_ids — stack-inherited already
  // filtered by findRoot; at the root, parent change_ids may match but
  // commit_ids differ → that's diff-parent, a rebase).
  const p0 = rootVersions[0].parent_commit_ids.join(',')
  if (rootVersions.every(v => v.parent_commit_ids.join(',') === p0)) return 'same-parent'
  return rootVersions.length > 2 ? 'compound' : 'diff-parent'
}

// Returns the version index that `@` descends from, or null when the signal
// is tautological/ambiguous. See docs/jj-divergence.md §"jj edit inversion".
//
// wc_reachable means "ancestor of some workspace's @". If @ sits ON a
// divergent commit (is_working_copy=true), that entire column is trivially
// wc_reachable by ancestry — the signal collapses to "whichever the user last
// clicked". Strip it. The "consistently reachable" stack check below isn't
// sufficient: `jj edit b1` makes a1 reachable too (it's b1's parent), so /1
// lights up top-to-bottom and looks like a clean win.
function detectLive(versions: DivergenceEntry[][]): number | null {
  if (versions.flat().some(v => v.is_working_copy)) return null

  const nVersions = versions[0].length
  const consistentLive: number[] = []
  for (let i = 0; i < nVersions; i++) {
    // Reachable at every stack level. Stack-inherited divergence has uniform
    // arity so versions[level][i] is well-defined; if not, the i<length check
    // fails and this index drops out.
    if (versions.every(level => i < level.length && level[i].wc_reachable)) {
      consistentLive.push(i)
    }
  }
  // Exactly one → @ is on a non-divergent descendant of that column. Zero or
  // 2+ → @ moved away, or multiple workspaces each on a different column.
  return consistentLive.length === 1 ? consistentLive[0] : null
}

// After the panel fetches diffRange(v0, v1) and the per-version fileUnion,
// refine diff-parent into pure-rebase vs rebase+edit. Exported separately
// because it needs async data the initial classify() doesn't have.
//
// Subtraction (not one-bit presence check): remove files that neither version
// touched — those are trunk churn. If nothing remains, trees are effectively
// identical modulo trunk → pure rebase. See doc §"Failed heuristics".
export function refineRebaseKind(
  treeDeltaFiles: string[],    // from parseDiffContent(diffRange(v0,v1)).map(f => f.filePath)
  fileUnion: Set<string>,      // union of files each version changed (from api.files per version)
): 'pure-rebase' | 'rebase-edit' {
  const afterSubtraction = treeDeltaFiles.filter(f => fileUnion.has(f))
  return afterSubtraction.length === 0 ? 'pure-rebase' : 'rebase-edit'
}

// --- Resolution planning ---

// KeepPlan: everything App.svelte needs to execute a resolution. Computed by
// buildPlan() (where the group structure lives), executed in App.svelte (where
// withMutation/loadLog live). Bookmark targets are per-change_id, not the
// stack tip — a bookmark on the middle of a stack repoints to that change's
// keeper, not jumping to the tip. See docs/jj-divergence.md §"Collateral".
export interface KeepPlan {
  keeperCommitId: string           // for the status line
  abandonCommitIds: string[]       // losing column + empty descendants
  bookmarkRepoints: { name: string; targetCommitId: string }[]
  // Non-empty descendants are NOT in abandonCommitIds — they go through
  // confirm first. Confirm resolves them into EITHER abandonCommitIds
  // OR rebaseSources (never both). A plan with nonEmptyDescendants still
  // populated never reaches onkeep — execute() is only called post-confirm.
  // rebaseTarget is per-descendant: a mid-stack branch-off rebases onto
  // the keeper's SAME level, not the tip (same pattern as bookmark repoint).
  nonEmptyDescendants: (DivergenceEntry & { rebaseTarget: string })[]
  // Descendants to rebase BEFORE the abandon. Rebase first: if abandon ran
  // first, jj would auto-rebase D onto the loser-stack's parent (trunk), and
  // then our explicit rebase would hit a twice-rebased tree. -s mode (not -r)
  // so D's own descendants follow. dest is per-source — for the common
  // tip-only case all dests match; mid-stack branches have their own level.
  rebaseSources: { source: string; dest: string }[]
}

// Compute the execution plan for "keep column keeperIdx, abandon the rest".
// Pure over DivergenceGroup — extracted from DivergencePanel.svelte so the
// invariants (all-level abandon, same-level bookmark repoint, keeper-tip
// descendant exclusion) are unit-testable. Wrong-column abandon = data loss,
// so every invariant below has a test in divergence.test.ts.
export function buildKeepPlan(g: DivergenceGroup, keeperIdx: number): KeepPlan {
  // Abandon every commit in the losing columns (all levels of the stack).
  const abandonCommitIds: string[] = []
  for (const level of g.versions) {
    for (let i = 0; i < level.length; i++) {
      if (i !== keeperIdx) abandonCommitIds.push(level[i].commit_id)
    }
  }
  // Descendants: empty ones go straight to abandon; non-empty go to confirm.
  // A descendant of ANY keeper-column commit stays valid — its parent is being
  // kept. g.descendants spans children of all levels × columns, so a branch-off
  // from the keeper's ROOT (not tip) would otherwise be miscounted as collateral.
  const keeperCommitIds = new Set(g.versions.map(level => level[keeperIdx].commit_id))
  const keeperTip = g.versions[g.versions.length - 1][keeperIdx].commit_id
  // commit_id → level index, for per-descendant rebase targeting. Same pattern
  // as bookmark repoint (keeperAtLevel below): a mid-stack branch-off rebases
  // onto the keeper's SAME level, not the tip.
  const commitIdToLevel = new Map<string, number>()
  for (let li = 0; li < g.versions.length; li++) {
    for (const v of g.versions[li]) commitIdToLevel.set(v.commit_id, li)
  }
  const collateral = g.descendants.filter(d => !d.parent_commit_ids.some(p => keeperCommitIds.has(p)))
  const nonEmptyDescendants = collateral.filter(d => !d.empty).map(d => {
    // MAX level for merge descendants: if D merges level-0 and level-2, D's
    // base already includes level-0+1+2's content. Rebasing onto keeper[2]
    // preserves that; keeper[0] would drop levels 1+2 from D's base.
    // undefined level = parent outside the divergent set (edge of the classifier
    // filter) → falls through to 0 = root level, which is what keeperTip used to
    // give for single-level groups anyway.
    let maxLevel = 0
    for (const p of d.parent_commit_ids) {
      const li = commitIdToLevel.get(p)
      if (li !== undefined && li > maxLevel) maxLevel = li
    }
    return { ...d, rebaseTarget: g.versions[maxLevel][keeperIdx].commit_id }
  })
  for (const d of collateral.filter(d => d.empty)) abandonCommitIds.push(d.commit_id)

  // Bookmarks: repoint to the keeper at the SAME change_id level. Not the
  // stack tip. See doc §"Collateral" #2.
  //
  // ALL loser-column bookmarks, not just conflicted ones — a bookmark on
  // only ONE version of a loser commit (count=1, so not in conflictedBookmarks)
  // would otherwise get `--retain-bookmarks` auto-move to the abandoned
  // commit's parent (= trunk for a stack root). Silent cascade-to-trunk.
  // Dedup by name: conflicted bookmarks would otherwise emit N-1 repoints
  // (one per loser column); jj bookmark set is idempotent but the log noise
  // isn't worth it.
  const repointed = new Set<string>()
  const bookmarkRepoints: { name: string; targetCommitId: string }[] = []
  for (let levelIdx = 0; levelIdx < g.versions.length; levelIdx++) {
    const keeperAtLevel = g.versions[levelIdx][keeperIdx].commit_id
    for (let col = 0; col < g.versions[levelIdx].length; col++) {
      if (col === keeperIdx) continue
      for (const name of g.versions[levelIdx][col].bookmarks) {
        if (repointed.has(name)) continue
        repointed.add(name)
        bookmarkRepoints.push({ name, targetCommitId: keeperAtLevel })
      }
    }
  }

  return {
    keeperCommitId: keeperTip,
    abandonCommitIds,
    bookmarkRepoints,
    nonEmptyDescendants,
    rebaseSources: [],
  }
}
