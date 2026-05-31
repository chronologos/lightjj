// Per-file mutation cluster extracted from DiffPanel.svelte: the inline-edit /
// markdown-preview / 3-pane-merge / quick-resolve state and the async actions
// that drive them. This was the densest hand-rolled async block
// left in the panel — every function carries post-await identity guards,
// per-file busy holds, and (for previews) a generation barrier. Extracting it
// follows the createMergeController precedent: deps injection, documented
// contract, race invariants locked by deferred-promise tests instead of full
// component mounts.
//
// Guard inventory (all preserved verbatim from the DiffPanel inline code —
// see docs/design-notes/frontend-perf.md "Post-await identity guard"):
//   - diffTarget identity guards: every await is a j/k navigation window; the
//     captured changeId is compared against deps.getDiffTarget() AFTER each
//     await, before any state write (stillOn() below).
//   - editBusy holds: per-file concurrency gate — a second op on the same
//     file while one is in flight is a no-op, not a queue.
//   - previewGen barrier: bumped once per bulk clear / identity change to
//     invalidate ALL in-flight per-file preview fetches. Deliberately NOT a
//     createLoader (no single `.value` — it guards per-key Map writes).
//   - mutation lock (deps.getMutationLock): jj mutations route through App's
//     withMutation when present; an `undefined` result means blocked → bail.
//     The `&& lock` on the bail checks is load-bearing: without a lock
//     (test mounts) a mock resolving `undefined` must NOT read as "blocked".

import { tick, untrack } from 'svelte'
import { SvelteSet } from 'svelte/reactivity'
import { api, IMAGE_RE, type DiffTarget } from './api'
import { reconstructSides, type MergeSides } from './conflict-extract'
import { resolveConflictFile } from './conflict-resolve'

/** App's withMutation shape (DiffPanel's onjjmutation prop). Returns undefined
 *  when blocked by another in-flight mutation. */
export type JJMutationLock = <T>(fn: () => Promise<T>) => Promise<T | undefined>

export interface FileActionsDeps {
  /** Live diff target (DiffPanel's diffTarget prop = nav.loadedTarget). Read
   *  through a closure so post-await guards always see the CURRENT prop, not
   *  a creation-time snapshot. */
  getDiffTarget: () => DiffTarget | undefined
  /** Live onjjmutation prop (App's withMutation — serializes jj mutations
   *  app-wide). Undefined when the host has none (test mounts): jj calls run
   *  direct and an undefined resolve is NOT treated as "blocked". */
  getMutationLock: () => JJMutationLock | undefined
  /** Live onfilesaved prop (App's logSync.refresh()) — the explicit refresh
   *  after every WC-mutating op. Explicit for IMMEDIACY: the log's op-sync also
   *  sees the new op-id, but its auto-refresh defers until the mutation gate
   *  clears; this call refreshes inside the save flow, and the op-sync's
   *  attempted-op-id dedup makes the deferred auto pass a no-op afterwards. */
  getOnFileSaved: () => (() => Promise<void> | void) | undefined
  /** DiffPanel's revealFile(): force-mount + session-expand a file so the
   *  editor/preview about to open has body DOM to land in. */
  revealFile: (path: string) => void
  /** Flip DiffPanel's splitView bindable to true — FileEditor renders only in
   *  the split view's right column. */
  ensureSplitView: () => void
  /** Restore the diff panel's scrollTop (refreshPreviews' post-write restore). */
  setScrollTop: (v: number) => void
}

export interface FileActions {
  // ── Reactive state (DiffPanel's template + $deriveds read these) ──────────
  /** Files with an open inline FileEditor. */
  readonly editingFiles: ReadonlySet<string>
  /** Per-file in-flight guard + busy indicator. */
  readonly editBusy: ReadonlySet<string>
  /** Pre-edit original content per editing file (NOT the live CM6 buffer). */
  readonly editFileContents: ReadonlyMap<string, string>
  /** Open markdown/image previews (path → content; '' for images). */
  readonly previewContents: ReadonlyMap<string, string>
  /** 3-pane merge state — non-null = MergePanel takes over .panel-content. */
  readonly mergeSides: MergeSides | null
  readonly mergingPath: string | null
  /** Last error message (edit-error banner). Assignable so the banner's
   *  dismiss button can clear it. */
  editError: string

  // ── User actions ───────────────────────────────────────────────────────────
  /** Open the inline FileEditor on a file. Editor-opening semantic: a non-@
   *  target is `jj edit`ed first (the editor's Save writes to @). */
  startEdit(path: string): Promise<void>
  /** Toggle markdown/image preview for a file. */
  togglePreview(path: string): Promise<void>
  /** Close one preview. No gen bump (per-path close must not cancel OTHER
   *  files' in-flight fetches). */
  closePreview(path: string): void
  /** Open the 3-pane merge editor on a conflicted file. Pure read (no @ move);
   *  unparseable conflicts fall back to the raw FileEditor. */
  startMerge(path: string): Promise<void>
  closeMerge(): void
  /** One-click whole-file resolve to ours/theirs (no 3-pane editor). */
  quickResolve(path: string, side: 'ours' | 'theirs'): Promise<void>
  /** Save the 3-pane merge result via the shared resolution strategy. */
  saveMerge(content: string): Promise<void>
  /** Save an inline FileEditor buffer to the working copy. */
  saveFile(path: string, content: string): Promise<void>
  cancelEdit(path: string): void
  /** `jj restore` a file back to its parent state. */
  discardFile(path: string, sourcePath?: string): Promise<void>

  // ── Lifecycle hooks (DiffPanel's effects call these) ──────────────────────
  /** Invalidate ALL in-flight preview fetches. Called unconditionally at the
   *  top of DiffPanel's nav-reset effect (covers sameChange→sameChange
   *  double-snapshots). */
  bumpPreviewGen(): void
  /** Bump gen + drop all open previews (hunk-review entry). */
  clearPreviews(): void
  /** Re-fetch open previews at a new commit_id (sameChange snapshot path).
   *  scrollTop is captured by the caller pre-await; restored via
   *  deps.setScrollTop after the content swap. */
  refreshPreviews(commitId: string, paths: string[], scrollTop?: number): Promise<void>
  /** Full clear: editing + busy + error + previews + merge. The nav-reset
   *  (different change_id) branch. Bumps the preview gen itself so it is safe
   *  to call standalone. */
  reset(): void
}

export function createFileActions(deps: FileActionsDeps): FileActions {
  // --- Inline editing state ---
  const editingFiles = new SvelteSet<string>()
  let editFileContents = $state(new Map<string, string>())
  const editBusy = new SvelteSet<string>() // concurrency guard + loading indicator
  let editError = $state('') // last error message (shown in the edit-error banner)

  // --- Markdown preview ---
  // Presence = previewing. Simpler than editing (read-only, no busy/dirty);
  // one Map serves as both toggle-set and content-store. previewGen bumped
  // by every bulk clear (hunkReview entry, nav reset) so an in-flight
  // fileShow resolve bounces instead of re-inserting after a sync clear —
  // the SSH-latency hunkReview race (fetch resolves 440ms AFTER the clear
  // effect already ran).
  let previewContents = $state(new Map<string, string>())
  let previewGen = 0

  // 3-pane merge — when set, MergePanel takes over .panel-content entirely
  // (vs FileEditor which slots into split-view's right column per-file).
  let mergeSides = $state<MergeSides | null>(null)
  let mergingPath = $state<string | null>(null)

  /** Post-await identity guard: still showing the single-rev target whose
   *  changeId was captured before the await? Reads the LIVE target — exactly
   *  `diffTarget?.kind !== 'single' || diffTarget.changeId !== revId` from the
   *  pre-extraction inline code, inverted. */
  function stillOn(revId: string): boolean {
    const t = deps.getDiffTarget()
    return t?.kind === 'single' && t.changeId === revId
  }

  /** Which revision's content previews render. Multi-select previews the
   *  NEWEST checked commit (commitIds is log-order = newest-first via
   *  revisions.filter in App). DiffPanel keeps a parallel $derived for its
   *  template gating; both are pure projections of the same live target. */
  function previewCommitId(): string | undefined {
    const t = deps.getDiffTarget()
    return t?.kind === 'single' ? t.commitId
      : t?.kind === 'multi' ? t.commitIds[0]
      : undefined
  }

  function closePreview(path: string) {
    // NO gen bump — single-file close. All callers guard on has(path) so
    // there's never an in-flight fetch for THIS path; editBusy prevents
    // same-file double-click. Bumping the GLOBAL gen here would invalidate
    // OTHER files' in-flight fetches (close CHANGELOG → README's pending
    // fetch silently drops). Bulk clears (nav reset, hunkReview entry)
    // bump previewGen at their own sites.
    previewContents = new Map([...previewContents].filter(([p]) => p !== path))
  }

  // Same-change reset (snapshot/amend → new commit_id, same change_id) keeps
  // previews open and refreshes content at the new commit. Unchanged .md →
  // identical string → MarkdownPreview's $derived(html) short-circuits, so
  // ToC/scroll/mermaid pan-zoom survive. Changed .md → {@html} swaps the
  // subtree, so the caller captures panel scroll just before the write and
  // we restore post-tick. Captured per-write (not pre-loop) so a 400ms-SSH
  // await doesn't jump the user back to where they were before the fetch.
  async function refreshPreviews(commitId: string, paths: string[], scrollTop?: number) {
    const gen = previewGen
    let changed = false
    for (const path of paths) {
      try {
        const { content } = await api.fileShow(commitId, path)
        if (gen !== previewGen) return
        // closePreview doesn't bump gen (per-path close mustn't cancel OTHER
        // files' fetches) — so a click-to-close during this await passes the
        // gen check. has() guard stops the resurrect.
        if (!previewContents.has(path)) continue
        if (previewContents.get(path) !== content) {
          previewContents = new Map(previewContents).set(path, content)
          changed = true
        }
      } catch {
        // Keep stale content on transient error (WC-lock contention with the
        // concurrent diff.load/snapshot loop, SSH blip). Closing here surfaces
        // as "preview vanished" — worse than briefly-stale.
      }
    }
    // scrollTop captured by caller pre-await (sameChange branch) — covers the
    // whole snapshot window, not just the final write.
    if (changed && scrollTop !== undefined && gen === previewGen) {
      await tick()
      deps.setScrollTop(scrollTop)
    }
  }

  async function discardFile(path: string, sourcePath?: string) {
    // editBusy guard: startEdit releases the mutation lock after api.edit,
    // then awaits fileShow (holding only editBusy). Without this guard a
    // Discard click during that window races: restore succeeds, then the
    // resumed startEdit populates editFileContents with pre-discard content.
    const target = deps.getDiffTarget()
    if (target?.kind !== 'single' || editBusy.has(path)) return
    const revId = target.changeId
    // Renames need both paths: `jj restore -c X root-file:"dest"` only matches
    // the new path → rename would become a delete of the source.
    const files = sourcePath ? [sourcePath, path] : [path]
    editBusy.add(path)
    editError = ''
    try {
      const lock = deps.getMutationLock()
      const result = lock
        ? await lock(() => api.restore(revId, files))
        : await api.restore(revId, files)
      // undefined = withMutation rejected (busy). It already setMessage'd the
      // warning at App.svelte — don't duplicate it in editError.
      if (result === undefined && lock) return
      if (!stillOn(revId)) return
      // Explicit refresh — onjjmutation is withMutation (lock only, no log refresh).
      // The log's op-sync also sees the header-driven op-id, but its auto-refresh
      // defers until `mutating` clears; calling onfilesaved here refreshes
      // immediately in the save flow, and the op-sync's attempted-op-id dedup
      // keeps the deferred auto pass from refreshing a second time.
      await deps.getOnFileSaved()?.()
    } catch (e) {
      editError = `Discard failed: ${e instanceof Error ? e.message : String(e)}`
    } finally {
      editBusy.delete(path)
    }
  }

  /** Shared prologue for the edit/merge/resolve flows: guard, fetch file
   *  content, post-await identity guards. Returns undefined on any bail
   *  (concurrent op, navigation during await, network error). The tricky
   *  post-await guards live here so a race fix lands in one place.
   *
   *  `moveWorkingCopy` additionally `jj edit`s a non-@ target BEFORE fetching.
   *  Pass true ONLY on editor-opening paths (startEdit / openEditorFallback):
   *  FileEditor's Save writes via fileWrite-to-@, so @ must BE the target.
   *  Resolution paths (quickResolve/saveMerge) pass false — their write goes
   *  through writeResolution → conflict-resolve.ts, which never moves @ in
   *  local mode. */
  async function fetchFileForEdit(path: string, errorPrefix: string, moveWorkingCopy: boolean): Promise<string | undefined> {
    const target = deps.getDiffTarget()
    if (target?.kind !== 'single' || editBusy.has(path)) return undefined
    const { changeId: revId, commitId, isWorkingCopy } = target
    editBusy.add(path)
    editError = ''
    try {
      if (moveWorkingCopy && !isWorkingCopy) {
        // api.edit is a jj mutation — goes through App's mutation lock to
        // prevent races with keyboard-triggered mutations (e.g. 'u' undo).
        const lock = deps.getMutationLock()
        const result = lock
          ? await lock(() => api.edit(revId))
          : await api.edit(revId)
        if (result === undefined && lock) return undefined
      }
      // Post-await identity guard — j/k navigation is possible during await.
      if (!stillOn(revId)) return undefined
      // Read by commit_id, NOT changeId/revId (issue #16). api.fileShow caches
      // by the id it's given; change_id survives rewrites, so a save (fileWrite
      // → snapshot → new commit_id, same change_id) would leave a change_id-keyed
      // entry serving the PRE-save content to the next Edit click. commit_id is
      // content-addressed — the cache stays provably valid, and the editor opens
      // with exactly what the displayed diff (also commit_id-keyed) shows.
      // Mutations (api.edit above) and identity guards keep change_id.
      const resp = await api.fileShow(commitId, path)
      if (!stillOn(revId)) return undefined
      return resp.content
    } catch (e) {
      editError = `${errorPrefix} failed: ${e instanceof Error ? e.message : String(e)}`
      return undefined
    } finally {
      editBusy.delete(path)
    }
  }

  /** Fallback for unparseable conflicts (N-way, git-style) or auto-resolved
   *  races: open the raw FileEditor on the file. FileEditor's save path is
   *  fileWrite-to-@, so a non-@ target must become @ first — this re-runs the
   *  prologue WITH moveWorkingCopy (the editor-opening semantic, same as
   *  startEdit). It is the only resolution-flow step that still moves the
   *  working copy; the actual resolution writes never do (in local mode). */
  async function openEditorFallback(path: string, errorPrefix: string) {
    const content = await fetchFileForEdit(path, errorPrefix, true)
    if (content === undefined) return
    openFileEditor(path, content)
  }

  /** Single write path for conflict resolutions (quickResolve + saveMerge).
   *  The @/non-@/SSH strategy lives in conflict-resolve.ts — shared with
   *  merge-controller's save():
   *    @ → api.fileWrite; non-@ local → api.mergeResolve (does NOT move @);
   *    non-@ SSH (501) → explicit jj edit + fileWrite, surfaced via the
   *    error banner ("working copy moved"), never silent.
   *  Returns true when the write succeeded AND the target is still current,
   *  so callers run their post-steps (closeMerge / onfilesaved). */
  async function writeResolution(path: string, content: string, errorPrefix: string): Promise<boolean> {
    const target = deps.getDiffTarget()
    if (target?.kind !== 'single' || editBusy.has(path)) return false
    const revId = target.changeId
    editBusy.add(path)
    editError = ''
    try {
      const run = () => resolveConflictFile(
        {
          api: { fileWrite: api.fileWrite, mergeResolve: api.mergeResolve, edit: api.edit },
          // DiffPanel's @-knowledge is diffTarget.isWorkingCopy (computed by
          // App at navigate time, change_id-derived) — expressed here as the
          // change_id rule conflict-resolve.ts documents.
          getWorkingCopyChangeId: () => (target.isWorkingCopy ? target.changeId : undefined),
          // j/k nav during the await → the SSH fallback must not move @.
          isStale: () => !stillOn(revId),
        },
        // commitId for non-@ ops — unambiguous on divergent change_ids.
        { changeId: target.changeId, revision: target.commitId },
        path, content,
      )
      // jj mutations (resolve/edit) go through App's mutation lock, same as
      // startEdit/discardFile. undefined = blocked (App already warned).
      // No `&& lock` here: resolveConflictFile never resolves undefined, so
      // undefined uniquely means "blocked".
      const lock = deps.getMutationLock()
      const outcome = lock ? await lock(run) : await run()
      if (outcome === undefined) return false
      if (!outcome.ok) {
        if (outcome.reason === 'error') {
          const e = outcome.error
          editError = `${errorPrefix} failed: ${e instanceof Error ? e.message : String(e)}`
          // The SSH fallback's `jj edit` may have run BEFORE the failure —
          // the working copy moved even though the write failed. Append the
          // fact so the user isn't left with a silently relocated @.
          if (outcome.movedWorkingCopy) {
            editError += ` Working copy was moved to ${revId.slice(0, 8)} (remote mode); the file there is still conflicted.`
          }
        }
        return false
      }
      if (outcome.movedWorkingCopy) {
        // Surface via the existing banner — never silently move @. Survives
        // the post-resolve refresh: the target's change_id is unchanged, so
        // the reset effect takes its sameChange (soft) branch.
        editError = `Resolved ${path}; working copy moved to ${revId.slice(0, 8)} (remote mode).`
      }
      // Post-await identity guard: nav during the resolve → the write already
      // happened, but don't run post-steps (reload) for the wrong revision.
      if (!stillOn(revId)) return false
      return true
    } catch (e) {
      editError = `${errorPrefix} failed: ${e instanceof Error ? e.message : String(e)}`
      return false
    } finally {
      editBusy.delete(path)
    }
  }

  function openFileEditor(path: string, content: string): void {
    // Editor lives in the right split column — switch if coming from unified.
    deps.ensureSplitView()
    // Edit wins over preview — DiffFileView's {#if previewContent} branch
    // precedes the FileEditor branch; a stale preview would hide the editor.
    if (previewContents.has(path)) closePreview(path)
    deps.revealFile(path)
    editFileContents = new Map(editFileContents).set(path, content)
    editingFiles.add(path)
  }

  async function startEdit(path: string) {
    // Editor-opening path: moving @ to the target is the expected semantic —
    // the editor's Save writes via fileWrite-to-@.
    const content = await fetchFileForEdit(path, 'Edit', true)
    if (content === undefined) return
    openFileEditor(path, content)
  }

  async function togglePreview(path: string) {
    if (previewContents.has(path)) return closePreview(path)
    const revId = previewCommitId()
    if (!revId || editBusy.has(path)) return
    deps.revealFile(path)
    if (IMAGE_RE.test(path)) {
      previewContents = new Map(previewContents).set(path, '')
      return
    }
    const gen = previewGen
    editBusy.add(path)
    try {
      const { content } = await api.fileShow(revId, path)
      // Live previewCommitId() re-read mirrors the original's live $derived
      // comparison — covers commit_id churn that doesn't bump the gen.
      if (gen !== previewGen || previewCommitId() !== revId) return
      previewContents = new Map(previewContents).set(path, content)
    } catch (e) {
      if (gen === previewGen) editError = `Preview failed: ${e instanceof Error ? e.message : String(e)}`
    } finally {
      editBusy.delete(path)
    }
  }

  async function startMerge(path: string) {
    // MergePanel takes over .panel-content → all FileEditors unmount → CM6
    // state destroyed → unsaved edits lost. Editing the SAME file is fine (user
    // is switching edit modes); OTHER files might have unsaved work. Confirm
    // before any await — no post-await identity-guard complexity for this.
    const otherEdits = [...editingFiles].filter(p => p !== path)
    if (otherEdits.length > 0) {
      const names = otherEdits.length === 1 ? otherEdits[0] : `${otherEdits.length} files`
      if (!confirm(`Discard unsaved edits in ${names}?`)) return
    }
    // Pure read — opening the 3-pane editor no longer moves @; the eventual
    // save goes through writeResolution (conflict-resolve.ts strategy).
    const content = await fetchFileForEdit(path, 'Merge', false)
    if (content === undefined) return
    const sides = reconstructSides(content)
    // Unparseable (N-way, git-style) OR auto-resolved race (conflict_sides
    // said 2 but jj resolved between /api/files and here → all identical)
    // → fall back to raw FileEditor (which DOES need @ at the target).
    if (!sides || sides.ours === sides.theirs) {
      await openEditorFallback(path, 'Merge')
      return
    }
    // Entering merge clears ALL in-progress file editors — MergePanel takes
    // over .panel-content entirely. User was warned via confirm() above.
    editingFiles.clear()
    editFileContents = new Map()
    mergeSides = sides
    mergingPath = path
  }

  function closeMerge() {
    mergeSides = null
    mergingPath = null
  }

  /** One-click whole-file resolve to ours/theirs WITHOUT the 3-pane editor —
   *  the common "just take my/their side" case. Writes the full reconstructed
   *  side (sides.ours/theirs), NOT planTake's incremental block surgery, so it
   *  sidesteps planTake's blank-line separator gap entirely (see BACKLOG.md).
   *  Fetches WITHOUT moving @ (pure read), then writes via writeResolution
   *  (conflict-resolve.ts: @ → fileWrite, non-@ local → mergeResolve, non-@
   *  SSH → explicit jj-edit fallback). N-way / git-style / auto-resolved-race
   *  → fall back to the editor, same as startMerge. */
  async function quickResolve(path: string, side: 'ours' | 'theirs') {
    const content = await fetchFileForEdit(path, 'Resolve', false)
    if (content === undefined) return
    const sides = reconstructSides(content)
    if (!sides || sides.ours === sides.theirs) {
      await openEditorFallback(path, 'Resolve')
      return
    }
    // Modify/delete conflicts: jj materializes the deleted side as empty, so
    // reconstructSides yields '' for it. The resolution write has no delete
    // path — writing '' would "resolve" to a zero-byte file (M with the empty
    // blob, not D): wrong tree content with no warning. The markers can't
    // distinguish deleted-on-that-side from emptied-on-that-side, so refuse
    // both and explain; a genuinely-empty resolve still works via the merge
    // editor.
    const chosen = side === 'ours' ? sides.ours : sides.theirs
    if (chosen === '') {
      editError = `The ${side} side of ${path} is empty — likely a modify/delete conflict. `
        + `Quick-resolve can't delete files; delete the file in the working copy to take that side.`
      return
    }
    if (!await writeResolution(path, chosen, 'Resolve')) return
    await deps.getOnFileSaved()?.()
  }

  async function saveMerge(content: string) {
    const path = mergingPath
    if (!path) return
    if (!await writeResolution(path, content, 'Save')) return
    closeMerge()
    await deps.getOnFileSaved()?.()
  }

  function clearEditState(path: string): void {
    editingFiles.delete(path)
    const next = new Map(editFileContents)
    next.delete(path)
    editFileContents = next
  }

  async function saveFile(path: string, content: string) {
    const target = deps.getDiffTarget()
    if (editBusy.has(path) || target?.kind !== 'single') return
    const revId = target.changeId
    editBusy.add(path)
    editError = ''
    try {
      await api.fileWrite(path, content)
      // Guard: display target may have changed during the await (navigation)
      if (!stillOn(revId)) return
      clearEditState(path)
      // Reload to show updated diff. Scroll position is preserved by the
      // stale-while-revalidate pattern in the panel-content {#if} — it keeps
      // showing the old diff until the new one arrives, and the keyed {#each}
      // maintains DiffFileView component instances across the swap.
      await deps.getOnFileSaved()?.()
    } catch (e) {
      editError = `Save failed: ${e instanceof Error ? e.message : String(e)}`
    } finally {
      editBusy.delete(path)
    }
  }

  function cancelEdit(path: string) {
    clearEditState(path)
  }

  function bumpPreviewGen() {
    previewGen++
  }

  function clearPreviews() {
    // Unconditional bump — an in-flight fetch may be the ONLY pending preview
    // (map empty now, would populate post-resolve). The size read is untracked
    // so effects calling this don't pick up previewContents as a dependency
    // (preserves the pre-extraction inline untrack).
    previewGen++
    if (untrack(() => previewContents.size) > 0) previewContents = new Map()
  }

  function reset() {
    // Self-contained: bump the gen so any in-flight preview fetch bounces even
    // if the caller forgot bumpPreviewGen(). DiffPanel's nav-reset effect bumps
    // before branching too — the double bump is harmless (barrier checks
    // inequality, not count).
    previewGen++
    editingFiles.clear()
    editFileContents = new Map()
    editBusy.clear()
    editError = ''
    previewContents = new Map()
    mergeSides = null
    mergingPath = null
  }

  return {
    get editingFiles(): ReadonlySet<string> { return editingFiles },
    get editBusy(): ReadonlySet<string> { return editBusy },
    get editFileContents(): ReadonlyMap<string, string> { return editFileContents },
    get previewContents(): ReadonlyMap<string, string> { return previewContents },
    get mergeSides() { return mergeSides },
    get mergingPath() { return mergingPath },
    get editError() { return editError },
    set editError(v: string) { editError = v },

    startEdit,
    togglePreview,
    closePreview,
    startMerge,
    closeMerge,
    quickResolve,
    saveMerge,
    saveFile,
    cancelEdit,
    discardFile,

    bumpPreviewGen,
    clearPreviews,
    refreshPreviews,
    reset,
  }
}
