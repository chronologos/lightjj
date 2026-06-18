// Merge-mode state + async orchestration, extracted from App.svelte so the
// gen-counter race invariants are testable (the inline block accumulated
// bug_009/013/039/040/047/048/051 — all races, all caught post-ship by
// bughunter). Follows the revision-navigator pattern: shared gen wraps
// multiple async ops so each invalidates the others.

import { api, type ConflictEntry } from './api'
import { reconstructSides, type MergeSides } from './conflict-extract'
import { resolveConflictFile } from './conflict-resolve'

export interface MergeQueueItem {
  commitId: string
  changeId: string
  path: string
  sides: number
}

export interface MergeController {
  /** Conflict queue from GET /api/conflicts. Stale-while-revalidate on re-enter. */
  readonly queue: ConflictEntry[]
  /** True while the queue fetch is in flight. */
  readonly queueLoading: boolean
  /** Selected queue item. Null = nothing selected. */
  readonly current: MergeQueueItem | null
  /** Reconstructed conflict. Null = loading, unsupported, or no selection. */
  readonly sides: MergeSides | null
  /** True while loading sides or saving a resolution. */
  readonly busy: boolean
  /** Session-local resolved set — `commitId:path` keys. Persists across enters. */
  readonly resolved: Set<string>
  /**
   * Enter merge mode: reset current/sides (NOT resolved — resume behavior),
   * fetch the queue. Returns true if fetch succeeded, false on error — caller
   * decides whether to bounce activeView (bug_013: don't clobber if user
   * navigated away during the await).
   */
  enter(): Promise<boolean>
  /**
   * Select a queue item, load its conflict sides. Bumps the shared gen so a
   * prior save's finally-block bounces (bug_048: nav-during-save). Clears
   * sides synchronously before the await (bug_047: no stale-panel flash).
   */
  selectFile(item: MergeQueueItem): void
  /**
   * Write resolved content via the unified strategy (conflict-resolve.ts,
   * shared with DiffPanel's quickResolve/saveMerge): `@` → api.fileWrite;
   * non-@ → api.mergeResolve (`jj resolve --tool cp`, does NOT move @);
   * non-@ in SSH mode (501) → explicit jj-edit + fileWrite fallback, surfaced
   * as a warning ("working copy moved"). The @-branch compares change_id,
   * NOT commit_id (bug_040: fileWrite snapshots @ → new commit_id).
   * Returns false on error/skip so caller can leave the panel open.
   */
  save(content: string): Promise<boolean>
}

export interface MergeControllerDeps {
  onError: (e: unknown) => void
  onWarning: (text: string) => void
  withMutation: <T>(fn: () => Promise<T>) => Promise<T | undefined>
  reload: () => Promise<void>
  getWorkingCopyChangeId: () => string | undefined
}

export function createMergeController(deps: MergeControllerDeps): MergeController {
  let queue = $state<ConflictEntry[]>([])
  let queueLoading = $state(false)
  let current = $state<MergeQueueItem | null>(null)
  let sides = $state<MergeSides | null>(null)
  let busy = $state(false)
  let resolved = $state(new Set<string>())

  // Shared gen across enter/selectFile/save — the load-bearing invariant.
  // Each op bumping it invalidates the others' post-await writes. Two
  // isolated createLoader instances can't express this (bug_048 would regress).
  let gen = 0
  // queueLoading has its OWN counter: `gen` is bumped by selectFile (which
  // never touches queueLoading), so gating the finally-clear on `g === gen`
  // would strand the flag when a nav lands during save()'s post-resolve
  // refetch. queueGen is bumped only by refreshQueue itself — only a
  // competing queue fetch suppresses the clear (the bug_009 invariant).
  let queueGen = 0

  // Shared queue fetch for enter() and save()'s post-resolve refresh. Caller
  // owns the gen bump; this only writes `queue` when its caller's gen is live.
  async function refreshQueue(g: number): Promise<void> {
    const qg = ++queueGen
    queueLoading = true
    try {
      const q = await api.conflicts()
      if (g !== gen) return
      queue = q
    } finally {
      if (qg === queueGen) queueLoading = false
    }
  }

  async function enter(): Promise<boolean> {
    // bug_039: reset stale panel state; keep resolved (resume behavior).
    // busy too — a selectFile suspended at await when enter() bumps gen will
    // skip its finally-clear (g !== gen), leaving busy stuck.
    current = null
    sides = null
    busy = false
    const g = ++gen
    try {
      await refreshQueue(g)
      return true
    } catch (e) {
      if (g !== gen) return true  // superseded — not an error
      deps.onError(e)
      return false
    }
  }

  async function selectFile(item: MergeQueueItem) {
    current = item
    const g = ++gen
    // bug_047: clear before await so {#key} remounts to "Loading…" not stale.
    sides = null
    busy = true
    try {
      const { content } = await api.fileShow(item.commitId, item.path, true)
      if (g !== gen) return
      const reconstructed = reconstructSides(content)
      sides = reconstructed
      if (!reconstructed) {
        deps.onWarning(`${item.path}: unsupported conflict format (N-way or git-style)`)
      }
    } catch (e) {
      if (g !== gen) return
      deps.onError(e)
    } finally {
      if (g === gen) busy = false
    }
  }

  async function save(content: string): Promise<boolean> {
    const cur = current
    if (!cur) return false
    // bug_048/051: shared gen + withMutation mutex.
    const g = ++gen
    const result = await deps.withMutation(async () => {
      busy = true
      try {
        // The @/non-@/SSH strategy lives in conflict-resolve.ts — the single
        // resolution path shared with DiffPanel. bug_040 (change_id, NOT
        // commit_id, decides the @ branch) is enforced inside it.
        const outcome = await resolveConflictFile(
          {
            api: { fileWrite: api.fileWrite, mergeResolve: api.mergeResolve, edit: api.edit },
            getWorkingCopyChangeId: deps.getWorkingCopyChangeId,
            // Shared-gen staleness: a selectFile/enter during this save's
            // await means the SSH fallback must NOT move @ for a stale target.
            isStale: () => g !== gen,
          },
          // cur.commitId for non-@ ops — `jj resolve -r`/`jj edit` accept
          // commit_id and won't be ambiguous on divergent change_ids.
          { changeId: cur.changeId, revision: cur.commitId },
          cur.path, content,
        )
        // A relocated working copy MUST be reported BEFORE any early return —
        // including the gen-supersede one below. By the time the SSH
        // fallback's `jj edit` has run, @ has moved on the remote; navigating
        // away (gen bump) does not undo that. The MessageBar warning is
        // app-level, not tied to the (possibly superseded) selection.
        // conflict-resolve.ts contract: "Callers MUST surface this."
        if (outcome.movedWorkingCopy) {
          deps.onWarning(outcome.ok
            ? `Resolved ${cur.path}; working copy moved to ${cur.changeId.slice(0, 8)} (remote mode)`
            : `Working copy was moved to ${cur.changeId.slice(0, 8)} before the write failed (remote mode); the file there is still conflicted.`)
        }
        if (g !== gen) return false  // superseded — not an error (@ move reported above)
        if (!outcome.ok) {
          if (outcome.reason === 'error') deps.onError(outcome.error)
          return false  // 'stale' is silent: gen check above already covers it
        }
        resolved = new Set([...resolved, `${cur.commitId}:${cur.path}`])
        // issue #24: the resolve REWROTE cur's commit (and possibly auto-
        // resolved descendants). The queue still holds pre-rewrite commit_ids;
        // a second save in the same commit would `jj resolve -r <stale id>` →
        // divergence. Refetch so the next selectFile gets the rewritten id.
        // `current` is NOT remapped — it keeps the pre-rewrite id so the
        // {#key} block (and the user's just-saved result panel) stay put;
        // remapping would re-key against `sides` still loaded from C0.
        // Clicking the next queue item runs a fresh selectFile.
        await refreshQueue(g)
        await deps.reload()
        return true
      } catch (e) {
        // refreshQueue/reload failure (resolveConflictFile itself never throws).
        // Resolution already landed; surfacing the error nudges a re-enter.
        if (g === gen) deps.onError(e)
        return false
      } finally {
        if (g === gen) busy = false
      }
    })
    // withMutation returns undefined when blocked by an in-flight mutation.
    return result ?? false
  }

  return {
    get queue() { return queue },
    get queueLoading() { return queueLoading },
    get current() { return current },
    get sides() { return sides },
    get busy() { return busy },
    get resolved() { return resolved },
    enter,
    selectFile,
    save,
  }
}
