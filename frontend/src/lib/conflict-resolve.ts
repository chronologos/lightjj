// Single conflict-resolution strategy shared by BOTH resolution surfaces:
//   - merge-controller.svelte.ts save()      (merge view, 3-pane editor)
//   - DiffPanel.svelte quickResolve/saveMerge (diff view, ◀Ours/Theirs▶ + ⧉ Merge)
//
// Before this module the two surfaces had DIVERGENT jj semantics for the same
// user intent ("resolve this file"): the diff-view path silently ran `jj edit`
// to move the working copy onto a non-@ target, while the merge-view path
// resolved in place via `jj resolve --tool`. resolveConflictFile() owns the
// @/non-@/remote decision in ONE place:
//
//   target          | strategy            | moves @?
//   ----------------+---------------------+----------------------------------
//   @ (working copy)| api.fileWrite       | no (it IS @)
//   non-@, local    | api.mergeResolve    | no (jj resolve -r <rev>)
//   non-@, SSH (501)| api.edit + fileWrite | YES — surfaced via the result's
//                   |                      | movedWorkingCopy flag; callers
//                   |                      | MUST show it, never silent
//
// Pure dependency injection — no api.ts import — so the strategy is unit-
// testable and each caller keeps its own race protection (gen counter or
// target-identity comparison) via the isStale hook.

export interface ResolveConflictApi {
  /** Write content into the working copy (snapshots @). SSH-compatible. */
  fileWrite: (path: string, content: string) => Promise<unknown>
  /** `jj resolve -r <revision> --tool` apply — resolves at any mutable
   *  revision WITHOUT moving @. Local-only: rejects with a "local mode"
   *  error (HTTP 501) in SSH mode. */
  mergeResolve: (revision: string, path: string, content: string) => Promise<unknown>
  /** `jj edit <revision>` — moves @. Only used by the SSH fallback. */
  edit: (revision: string) => Promise<unknown>
}

export interface ResolveConflictDeps {
  api: ResolveConflictApi
  /** Working-copy change_id at decision time. The @/non-@ branch compares the
   *  TARGET's change_id against this — change_id, NEVER commit_id: fileWrite
   *  snapshots @ → new commit_id, so a queue/target captured pre-snapshot
   *  would never compare equal by commit_id (merge-controller bug_040).
   *  Callers that only hold a precomputed is-working-copy flag (itself
   *  change_id-derived, e.g. DiffPanel's diffTarget.isWorkingCopy) express it
   *  as `() => flag ? target.changeId : undefined`. */
  getWorkingCopyChangeId: () => string | undefined
  /** Optional staleness probe — the caller's own race guard (shared gen
   *  counter, or live-target identity comparison). Consulted ONLY before the
   *  SSH fallback's `jj edit` (the point of no return: moving @ for a target
   *  the user has navigated away from is worse than not resolving). It is NOT
   *  consulted between edit and fileWrite — once @ has moved, completing the
   *  write is strictly better than aborting (moved @ + still-conflicted file).
   *  Callers still apply their own post-await guards to UI side effects. */
  isStale?: () => boolean
}

export interface ResolveTarget {
  /** change_id of the revision being resolved — the @-comparison key. */
  changeId: string
  /** Revision argument for non-@ ops (`jj resolve -r` / `jj edit`). Pass the
   *  commit_id when known — unambiguous on divergent change_ids. */
  revision: string
}

export type ResolveOutcome =
  | {
      ok: true
      /** True when the SSH fallback ran `jj edit` — the working copy now sits
       *  at the target revision. Callers MUST surface this through their
       *  message path (e.g. "Resolved <file>; working copy moved to <rev>
       *  (remote mode)"). */
      movedWorkingCopy: boolean
    }
  | {
      ok: false
      reason: 'stale' | 'error'
      error?: unknown
      /** True when the failure happened AFTER the SSH fallback's `jj edit` —
       *  the working copy has already moved even though the resolution did
       *  not complete (the worst state: relocated @ AND a still-conflicted
       *  file). Callers MUST surface this alongside the error. */
      movedWorkingCopy?: boolean
    }

/** True for the backend's "requires local mode" 501 rejection (api.ts post()
 *  surfaces the response body's error string as Error.message). */
export function isLocalOnlyError(e: unknown): boolean {
  return e instanceof Error && e.message.includes('local mode')
}

/** Resolve one conflicted file at `target` with `content`. Never throws —
 *  failures come back as `{ ok: false }` outcomes so both call patterns
 *  (gen-guarded controller, identity-guarded component) handle them uniformly.
 *  Callers own the mutation lock (wrap this call in withMutation/onjjmutation)
 *  and all UI side effects (resolved-set updates, reloads, messages). */
export async function resolveConflictFile(
  deps: ResolveConflictDeps,
  target: ResolveTarget,
  path: string,
  content: string,
): Promise<ResolveOutcome> {
  const isWorkingCopy = target.changeId === deps.getWorkingCopyChangeId()
  try {
    if (isWorkingCopy) {
      // @ → plain working-copy write. SSH-compatible, handles empty content
      // natively (no "\n" normalization needed).
      await deps.api.fileWrite(path, content)
      return { ok: true, movedWorkingCopy: false }
    }

    // Non-@ → `jj resolve --tool` at the target. The canonical strategy: does
    // NOT move @.
    try {
      await deps.api.mergeResolve(target.revision, path, content)
      return { ok: true, movedWorkingCopy: false }
    } catch (e) {
      if (!isLocalOnlyError(e)) throw e
      // SSH mode (the endpoint 501s) → explicit fallback: move @ onto the
      // target, then write. This is the ONLY path that moves the working
      // copy, and it reports doing so.
      if (deps.isStale?.()) return { ok: false, reason: 'stale' }
      await deps.api.edit(target.revision)
      try {
        await deps.api.fileWrite(path, content)
      } catch (writeErr) {
        // @ has already moved. A failed write here is the worst state
        // (relocated working copy + still-conflicted file) — report BOTH
        // facts so the caller can tell the user, never silently.
        return { ok: false, reason: 'error', error: writeErr, movedWorkingCopy: true }
      }
      return { ok: true, movedWorkingCopy: true }
    }
  } catch (e) {
    return { ok: false, reason: 'error', error: e }
  }
}
