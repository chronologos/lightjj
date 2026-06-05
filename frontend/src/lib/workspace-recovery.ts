// Pure helpers for the "Update all (recover stale)" action (issue #21). Kept
// out of App.svelte so the partition predicate and the summary message — the
// only branchy bits — are unit-testable without an App render.

/** Partition workspaces for "Update all": a workspace is a target if it has a
 *  resolvable path OR is the current one (which runs through its own
 *  watcher-clearing endpoint); otherwise it's skipped — it predates jj's
 *  workspace_store index, so there's no path to target with `-R`. */
export function planRecoverAll<T extends { name: string; path?: string }>(
  workspaces: T[],
  current: string,
): { targets: T[]; skipped: string[] } {
  const targets: T[] = []
  const skipped: string[] = []
  for (const w of workspaces) {
    if (w.path || w.name === current) targets.push(w)
    else skipped.push(w.name)
  }
  return { targets, skipped }
}

/** Summary message after running update-stale across the targets. The verb is
 *  neutral ("Ran update-stale") on purpose: update-stale is a no-op when a
 *  workspace is already fresh (jj exits 0 either way), so claiming it "updated"
 *  them would be a lie. */
export function recoverAllMessage(
  ran: number,
  failed: string[],
  skipped: string[],
): { kind: 'success' | 'warning'; text: string } {
  const n = `${ran} workspace${ran !== 1 ? 's' : ''}`
  const note = skipped.length ? ` (skipped ${skipped.join(', ')} — path unknown)` : ''
  if (failed.length) {
    return { kind: 'warning', text: `Ran update-stale on ${n}; failed: ${failed.join(', ')}${note}` }
  }
  return { kind: 'success', text: `Ran update-stale on ${n}${note}` }
}
