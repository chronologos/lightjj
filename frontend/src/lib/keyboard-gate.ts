// Gate-priority router for the global keydown handler. Extracted from
// App.svelte so the ORDER can be table-tested — gate placement has been the
// highest-regression surface (bug_005 merge-Escape, bug_030 Cmd+F-behind-
// overlay, the inlineMode-leaks-into-rebase class).
//
// The router encodes ORDER only. Handlers encode their own entry conditions
// and return whether they handled the key. "Try X, fall through if not" is
// the shape — a pure state→target function would have to duplicate each
// handler's entry predicate, which drifts.

export type ActiveView = 'log' | 'branches' | 'merge'

export interface GateCtx {
  key: string
  hasModifier: boolean
  inInput: boolean
  /** e.defaultPrevented at dispatch time — element-level onkeydown may have
   *  already handled (BookmarksPanel, MergePanel swallowKeydown). */
  defaultPrevented: boolean
  fileHistoryOpen: boolean
  anyModalOpen: boolean
  inlineMode: boolean
  activeView: ActiveView
}

/** Handlers return `true` if they consumed the key. `void` handlers are
 *  terminal — nothing falls through past them. */
export interface GateHandlers {
  globalOverrides(): boolean
  inlineCommit(): boolean
  delegateFileHistory(): boolean
  inlineNav(): void
  /** Delegate to branches-panel key handler; return true if consumed. Unlike
   *  the other delegates, BookmarksPanel signals via e.preventDefault() not a
   *  return value (it's dual-wired as element onkeydown). */
  delegateBranches(): boolean
  /** Exit merge view. */
  mergeEscape(): void
  delegateConflictQueue(): boolean
  escapeStack(): void
  globalKeys(): boolean
  logKeys(): void
}

// Ordering is load-bearing. Each gate's placement is deliberate:
//   - globalOverrides (Cmd+K/F) BEFORE inInput: work inside text fields.
//   - inlineCommit BEFORE inInput: FileSelectionPanel holds focus during
//     squash/split; Enter still executes. (cm-editor sub-filter inside.)
//   - hasModifier AFTER globalOverrides: Cmd+C etc. pass through to browser.
//   - inlineNav swallows EVERYTHING: no normal-mode keys leak into modes.
export function routeKeydown(c: GateCtx, h: GateHandlers): void {
  if (h.globalOverrides()) return
  if (h.inlineCommit()) return
  if (c.inInput) return
  if (c.hasModifier) return
  if (c.fileHistoryOpen && h.delegateFileHistory()) return
  if (c.anyModalOpen) return
  if (c.inlineMode) return h.inlineNav()
  if (c.activeView === 'branches') {
    if (c.defaultPrevented) return
    if (h.delegateBranches()) return
    if (h.globalKeys()) return
    // Fall through to logKeys so Space/@/n etc work on the still-visible
    // RevisionGraph. j/k conflict is moot — BookmarksPanel claims those via
    // preventDefault() so they never reach here.
    h.logKeys()
    return
  }
  if (c.activeView === 'merge') {
    if (c.defaultPrevented) return
    if (c.key === 'Escape') return h.mergeEscape()
    if (h.delegateConflictQueue()) return
    h.globalKeys()
    return
  }
  // activeView === 'log' by exhaustion — branches/merge returned above.
  if (c.key === 'Escape') return h.escapeStack()
  if (h.globalKeys()) return
  h.logKeys()
}
