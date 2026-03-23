// Merge-mode state + async orchestration, extracted from App.svelte so the
// gen-counter race invariants are testable (the inline block accumulated
// bug_009/013/039/040/047/048/051 — all races, all caught post-ship by
// bughunter). Follows the revision-navigator pattern: shared gen wraps
// multiple async ops so each invalidates the others.

import { api, type ConflictEntry } from './api'
import { reconstructSides, type MergeSides } from './conflict-extract'

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
   * Write resolved content. @-only: gated on change_id (NOT commit_id —
   * bug_040: fileWrite snapshots @ → new commit_id). Returns false if the
   * @-gate rejected — caller can surface a warning and skip.
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

  async function enter(): Promise<boolean> {
    // bug_039: reset stale panel state; keep resolved (resume behavior).
    // busy too — a selectFile suspended at await when enter() bumps gen will
    // skip its finally-clear (g !== gen), leaving busy stuck.
    current = null
    sides = null
    busy = false
    const g = ++gen
    queueLoading = true
    try {
      const q = await api.conflicts()
      if (g !== gen) return true  // superseded — not an error
      queue = q
      return true
    } catch (e) {
      if (g !== gen) return true
      deps.onError(e)
      return false
    } finally {
      if (g === gen) queueLoading = false
    }
  }

  async function selectFile(item: MergeQueueItem) {
    current = item
    const g = ++gen
    // bug_047: clear before await so {#key} remounts to "Loading…" not stale.
    sides = null
    busy = true
    try {
      const { content } = await api.fileShow(item.commitId, item.path)
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
    // bug_040: change_id, NOT commit_id — fileWrite snapshots @.
    if (cur.changeId !== deps.getWorkingCopyChangeId()) {
      deps.onWarning('Merge mode currently only resolves @ conflicts. Use `jj edit` to move @ first.')
      return false
    }
    // bug_048/051: shared gen + withMutation mutex.
    const g = ++gen
    const result = await deps.withMutation(async () => {
      busy = true
      try {
        await api.fileWrite(cur.path, content)
        if (g !== gen) return false  // superseded — not an error
        resolved = new Set([...resolved, `${cur.commitId}:${cur.path}`])
        await deps.reload()
        return true
      } catch (e) {
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
