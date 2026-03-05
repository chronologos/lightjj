<script lang="ts">
  import { api, type DivergenceEntry, type FileChange } from './api'
  import { classify, refineRebaseKind, type DivergenceGroup } from './divergence'
  import { parseDiffContent } from './diff-parser'
  import DiffFileView from './DiffFileView.svelte'

  // KeepPlan: everything App.svelte needs to execute a resolution. Computed
  // here (where the group structure lives), executed in App.svelte (where
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
    nonEmptyDescendants: DivergenceEntry[]
    // Descendants to rebase onto keeperCommitId BEFORE the abandon. Rebase
    // first: if abandon ran first, jj would auto-rebase D onto the loser-
    // stack's parent (trunk), and then our explicit rebase would hit a
    // twice-rebased tree. -s mode (not -r) so D's own descendants follow.
    rebaseSources: string[]
  }

  interface Props {
    changeId: string
    onkeep: (plan: KeepPlan) => Promise<void>
    onclose: () => void
  }

  let { changeId, onkeep, onclose }: Props = $props()

  // --- Group classification ---
  // One api.divergence() call on mount gives us everything. Finding the group
  // containing changeId routes to stack or single rendering.
  let group = $state<DivergenceGroup | null>(null)
  let loading = $state(true)
  let error = $state('')
  let keepingIdx = $state(-1)

  // Derived view data
  let isStack = $derived((group?.changeIds.length ?? 0) > 1)
  let nVersions = $derived(group?.versions[0]?.length ?? 0)

  // --- Cross-diff (works for both stack tips and single-change versions) ---
  let compareFrom = $state(0)
  let compareTo = $state(1)
  let crossDiff = $state('')
  let diffLoading = $state(false)
  let fileUnion = $state<Set<string>>(new Set())

  let parsedCrossDiff = $derived(parseDiffContent(crossDiff))
  // refinedKind depends on both classify() AND the lazy diffRange fetch.
  // Consumes parsedCrossDiff (not re-parsing crossDiff — derived memoizes).
  let refinedKind = $derived.by(() => {
    if (!group || group.kind === 'same-parent' || group.kind === 'compound') return group?.kind
    if (diffLoading || parsedCrossDiff.length === 0) return 'diff-parent'
    return refineRebaseKind(parsedCrossDiff.map(f => f.filePath), fileUnion)
  })

  // A descendant merging two column tips is likely the user's manual
  // reconciliation (`jj new keeper loser`). buildPlan would silently exclude
  // it (keeper-parent match) then abandon its OTHER input — the merge survives
  // but against a rewritten parent. Surface it instead of silently acting.
  let crossColumnMerge = $derived.by(() => {
    if (!group || nVersions < 2) return null
    const tips = group.versions[group.versions.length - 1].map(v => v.commit_id)
    return group.descendants.find(d => {
      const hits = tips.filter(t => d.parent_commit_ids.includes(t))
      return hits.length >= 2
    }) ?? null
  })

  // --- Non-empty descendant confirm ---
  // When keeping a column would abandon a non-empty descendant of the loser,
  // stash the plan and show a confirm. [Rebase onto keeper] is the default
  // (green, leftmost); [Abandon anyway] for throwaway content.
  //
  // rebaseSources is safe from -s flattening: g.descendants is roots-only
  // by classifier construction (divergence.ts:108 — only entries whose
  // parent is in the divergent set). A D2-on-D1 chain has D2's parent = D1
  // (non-divergent) → D2 never enters g.descendants → never in rebaseSources.
  // `jj rebase -s D1` pulls D2 along. See divergence.test.ts pin test.
  let pendingPlan: KeepPlan | null = $state(null)

  // Version load runs exactly once per mount — {#if divergence.active} in
  // App.svelte unmounts on cancel(), so changeId never changes in-place. No
  // gen counter or reset block needed; there's no second run to race against.
  $effect(() => {
    const id = changeId
    if (!id) return

    api.divergence().then(async entries => {
      const groups = classify(entries)
      // Find the group containing the requested changeId — it may be a stack
      // member (not the root), so search changeIds[] not just rootChangeId.
      const found = groups.find(gr => gr.changeIds.includes(id))
      if (!found) {
        error = 'No actionable divergence — may be immutable or already resolved'
        loading = false
        return
      }
      if (found.versions[0].length < 2) {
        // Divergent-with-immutable-sibling: the other copy was filtered out
        // by `& mutable()`. Can't abandon it (it's in trunk's DAG permanently).
        // This is the "never clears" case from docs/jj-divergence.md — the
        // panel has nothing to offer. Common in repos with automated
        // warm-merge trains where trunk was rewritten.
        //
        // findRoot's parentCommits.size >= 2 guard ensures these never chain
        // as roots of resolvable stacks — versions[0] here is always the
        // clicked change. commit_id (not change_id) in the abandon hint:
        // `jj abandon <change_id>` on a divergent change errors with
        // "resolved to more than one revision".
        error = `Change ${id} is divergent with an immutable copy (likely in trunk history). ` +
          'The immutable copy cannot be abandoned; this divergence will persist. ' +
          'To discard your mutable copy instead: jj abandon ' + found.versions[0][0].commit_id
        loading = false
        return
      }
      // fileUnion BEFORE group: the diff effect depends on both. Setting
      // group first would fire it with fileUnion empty → unfiltered fetch
      // (large, includes trunk churn), then fileUnion lands → fires again
      // filtered → first response discarded by diffGen but wasted round trip.
      // With this order: fileUnion set → diff effect checks `if (!group)` →
      // bails. group set → single filtered fetch.
      const tipLevel = found.versions[found.versions.length - 1]
      const fileResults = await Promise.all(
        tipLevel.map(v => api.files(v.commit_id).catch(() => [] as FileChange[]))
      )
      const paths = new Set<string>()
      for (const files of fileResults) for (const f of files) paths.add(f.path)
      fileUnion = paths

      group = found
      compareTo = Math.min(1, nVersions - 1)
      loading = false
    }).catch(e => {
      error = e.message || 'Failed to load divergence'
      loading = false
    })
  })

  // Cross-diff between selected version-tips. diffGen invalidates in-flight
  // fetches when compareFrom/compareTo toggle. Separate from version load —
  // a shared counter would kill the fileUnion continuation when this effect
  // fires on group becoming non-null (mid-way through version load's async).
  let diffGen = 0
  $effect(() => {
    if (!group || nVersions < 2 || compareFrom === compareTo) return
    const tipLevel = group.versions[group.versions.length - 1]
    const fromId = tipLevel[compareFrom]?.commit_id
    const toId = tipLevel[compareTo]?.commit_id
    if (!fromId || !toId) return

    const g = ++diffGen
    diffLoading = true
    // Pass fileUnion as filter if we have it — reduces diff size, and the
    // full-diff fetch would include trunk churn that refineRebaseKind would
    // subtract anyway. Empty Set → don't filter (still loading).
    const filterFiles = fileUnion.size > 0 ? [...fileUnion] : undefined
    api.diffRange(fromId, toId, filterFiles).then(result => {
      if (g !== diffGen) return
      crossDiff = result.diff
      diffLoading = false
    }).catch(e => {
      if (g !== diffGen) return
      crossDiff = ''
      diffLoading = false
      error = e.message || 'Failed to load cross-version diff'
    })
  })

  function buildPlan(keeperIdx: number): KeepPlan {
    const g = group!
    // Abandon every commit in the losing columns (all levels of the stack).
    const abandonCommitIds: string[] = []
    for (const level of g.versions) {
      for (let i = 0; i < level.length; i++) {
        if (i !== keeperIdx) abandonCommitIds.push(level[i].commit_id)
      }
    }
    // Descendants: empty ones go straight to abandon; non-empty go to confirm.
    // A descendant of the KEEPER'S tip doesn't need abandoning (it stays valid).
    const keeperTip = g.versions[g.versions.length - 1][keeperIdx].commit_id
    const collateral = g.descendants.filter(d => !d.parent_commit_ids.includes(keeperTip))
    const nonEmptyDescendants = collateral.filter(d => !d.empty)
    for (const d of collateral.filter(d => d.empty)) abandonCommitIds.push(d.commit_id)

    // Bookmarks: map each conflicted bookmark to the keeper at the SAME
    // change_id level it was on. Not the stack tip. See doc §"Collateral" #2.
    const bookmarkRepoints = g.conflictedBookmarks.map(({ name, changeId }) => {
      const levelIdx = g.changeIds.indexOf(changeId)
      return { name, targetCommitId: g.versions[levelIdx][keeperIdx].commit_id }
    })

    return {
      keeperCommitId: keeperTip,
      abandonCommitIds,
      bookmarkRepoints,
      nonEmptyDescendants,
      rebaseSources: [],
    }
  }

  // keeperIdx is derivable from pendingPlan (the root-level commit NOT in
  // the abandon list). Both confirm handlers need it; compute once here.
  let pendingKeeperIdx = $derived.by(() => {
    if (!pendingPlan || !group) return -1
    return group.versions[0].findIndex(
      v => !pendingPlan!.abandonCommitIds.includes(v.commit_id)
    )
  })

  async function handleKeep(idx: number) {
    if (!group || !group.alignable || keepingIdx >= 0) return
    const plan = buildPlan(idx)
    if (plan.nonEmptyDescendants.length > 0) {
      pendingPlan = plan
      return // wait for confirm
    }
    await execute(plan, idx)
  }

  async function execute(plan: KeepPlan, idx: number) {
    keepingIdx = idx
    try {
      await onkeep(plan)
    } finally {
      keepingIdx = -1
      pendingPlan = null
    }
  }

  function confirmAbandonDescendants() {
    if (!pendingPlan) return
    execute({
      ...pendingPlan,
      abandonCommitIds: [
        ...pendingPlan.abandonCommitIds,
        ...pendingPlan.nonEmptyDescendants.map(d => d.commit_id),
      ],
      nonEmptyDescendants: [],
    }, pendingKeeperIdx)
  }

  function confirmRebaseDescendants() {
    if (!pendingPlan) return
    // Descendants move to the keeper's tip; the stale stack is then abandoned
    // with no children pinning it visible. App.svelte runs the rebase BEFORE
    // the abandon (single batched `jj rebase -s D1 -s D2 -d tip`).
    execute({
      ...pendingPlan,
      rebaseSources: pendingPlan.nonEmptyDescendants.map(d => d.commit_id),
      nonEmptyDescendants: [],
    }, pendingKeeperIdx)
  }

  // Kind → badge text. Panel shows what it knows; refined kinds appear once
  // the cross-diff lands.
  const kindLabel: Record<string, { text: string; hint: string }> = {
    'same-parent': { text: 'concurrent edit', hint: 'Both versions rewrote from the same base. Check the diff — one may have changes the other doesn\'t.' },
    'diff-parent': { text: 'rebased', hint: 'One version was rebased. Loading diff to check for content drift…' },
    'pure-rebase': { text: 'pure rebase', hint: 'Trees identical (modulo trunk). Either version is safe.' },
    'rebase-edit': { text: 'rebase + edit', hint: 'One version has edits the other doesn\'t. Check the diff before keeping.' },
    'compound': { text: 'compound', hint: '3+ versions with mixed parents. Pick manually.' },
  }
</script>

<div class="panel divergence-panel">
  <div class="panel-header">
    <span class="panel-title">
      Divergence
      {#if group}
        <span class="kind-badge" title={kindLabel[refinedKind ?? group.kind]?.hint}>
          {kindLabel[refinedKind ?? group.kind]?.text}
        </span>
        {#if isStack}
          <span class="stack-badge">{group.changeIds.length}-change stack</span>
        {/if}
      {/if}
    </span>
    <button class="close-btn" onclick={onclose} aria-label="Close">×</button>
  </div>

  {#if loading}
    <div class="panel-content">
      <div class="empty-state"><div class="spinner"></div><span>Loading…</span></div>
    </div>
  {:else if error}
    <div class="panel-content">
      <div class="error-message">{error}</div>
    </div>
  {:else if group}
    <div class="panel-content">
      {#if pendingPlan}
        <!-- Non-empty descendant confirm — blocks the view until resolved -->
        <div class="confirm-overlay">
          <div class="confirm-box">
            <div class="confirm-title">Non-empty commits on the losing stack</div>
            {#each pendingPlan.nonEmptyDescendants as d}
              <div class="confirm-item">
                <span class="confirm-id">{d.commit_id.slice(0, 8)}</span>
                <span class="confirm-desc">{d.description || '(no description)'}</span>
              </div>
            {/each}
            <div class="confirm-hint">Rebase moves them (and their descendants) onto the keeper. Abandon discards their content.</div>
            <div class="confirm-actions">
              <button class="btn-primary" onclick={confirmRebaseDescendants}
                title="jj rebase -s onto {pendingPlan.keeperCommitId.slice(0, 8)} — keeps their content, moves them to the winning stack">
                Rebase onto keeper
              </button>
              <button class="btn-danger" onclick={confirmAbandonDescendants}
                title="Discards their content">
                Abandon anyway
              </button>
              <button class="btn-secondary" onclick={() => pendingPlan = null}>Cancel</button>
            </div>
          </div>
        </div>
      {/if}

      {#if crossColumnMerge}
        <div class="merge-warning">
          <span class="warn-icon">⚠</span>
          <span class="warn-text">
            <span class="warn-id">{crossColumnMerge.commit_id.slice(0, 8)}</span>
            merges multiple versions — this may be your manual reconciliation. Keeping a column will abandon one of its parents.
          </span>
        </div>
      {/if}

      <div class="divergence-info">
        Change <span class="change-id-highlight">{group.rootChangeId.slice(0, 12)}</span>
        {#if isStack}<span class="info-detail">+ {group.changeIds.length - 1} descendant{group.changeIds.length > 2 ? 's' : ''}</span>{/if}
        — {nVersions} copies
        {#if group.liveVersion !== null}
          <span class="live-hint" title="@ descends from this column — likely your active work">
            (copy {group.liveVersion} is live)
          </span>
        {/if}
      </div>

      <!-- Columns: one per version, rows = stack levels. For single-change
           divergence this is 1 row × N columns = the old card layout. -->
      <div class="version-columns" style="--n-cols: {nVersions}">
        {#each Array(nVersions) as _, colIdx}
          {@const tipCommitId = group.versions[group.versions.length - 1][colIdx].commit_id}
          <div class="version-col" class:col-live={group.liveVersion === colIdx} class:col-from={colIdx === compareFrom} class:col-to={colIdx === compareTo}>
            <div class="col-header">
              <span class="col-idx">/{colIdx}</span>
              {#if group.liveVersion === colIdx}<span class="live-dot" title="@ descends from here">●</span>{/if}
            </div>
            {#each group.changeIds as cid, levelIdx}
              {@const v = group.versions[levelIdx][colIdx]}
              <div class="version-cell">
                <span class="cell-change-id">{cid.slice(0, 8)}</span>
                <span class="cell-commit-id">{v.commit_id.slice(0, 8)}</span>
                {#if v.bookmarks.length > 0}
                  <span class="cell-bookmarks">{v.bookmarks.join(', ')}</span>
                {/if}
              </div>
            {/each}
            {#each group.descendants.filter(d => d.parent_commit_ids.includes(tipCommitId)) as d}
              <div class="version-cell descendant-cell" title="Non-divergent descendant — pins this column visible">
                <span class="descendant-marker">└</span>
                <span class="cell-commit-id">{d.commit_id.slice(0, 8)}</span>
                <span class="cell-desc">{d.description || '(no description)'}</span>
                {#if d.empty}<span class="empty-tag">empty</span>{/if}
              </div>
            {/each}
            <button
              class="keep-btn"
              class:keep-live={group.liveVersion === colIdx}
              onclick={() => handleKeep(colIdx)}
              disabled={keepingIdx >= 0 || !group.alignable}
              title={group.alignable ? '' : 'Columns don\'t form clean descent chains — one-click keep would abandon wrong commits. Resolve with jj abandon <commit_id>.'}
            >
              {keepingIdx === colIdx ? 'Keeping…' : 'Keep'}
            </button>
          </div>
        {/each}
      </div>

      {#if nVersions >= 2}
        <div class="compare-section">
          <div class="compare-header">
            <span class="compare-label">Diff /{compareFrom} → /{compareTo}</span>
            {#if nVersions > 2}
              <select class="compare-select" bind:value={compareFrom}>
                {#each Array(nVersions) as _, i}<option value={i}>/{i}</option>{/each}
              </select>
              <span class="compare-arrow">→</span>
              <select class="compare-select" bind:value={compareTo}>
                {#each Array(nVersions) as _, i}<option value={i}>/{i}</option>{/each}
              </select>
            {/if}
            {#if fileUnion.size > 0}
              <span class="file-count">{fileUnion.size} file{fileUnion.size !== 1 ? 's' : ''} in union</span>
            {/if}
          </div>

          {#if diffLoading}
            <div class="diff-loading">Loading diff…</div>
          {:else if crossDiff === '' && compareFrom !== compareTo}
            <div class="diff-empty">Trees identical — only metadata differs</div>
          {:else}
            <div class="cross-diff">
              {#each parsedCrossDiff as file}
                <DiffFileView
                  {file}
                  fileStats={undefined}
                  isCollapsed={false}
                  isExpanded={false}
                  splitView={false}
                  highlightedLines={new Map()}
                  wordDiffs={new Map()}
                  ontoggle={() => {}}
                  onexpand={() => {}}
                />
              {/each}
            </div>
          {/if}
        </div>
      {/if}
    </div>
  {/if}
</div>

<style>
  .divergence-panel { display: flex; flex-direction: column; flex: 1; overflow: hidden; }

  .panel-header {
    display: flex; align-items: center; justify-content: space-between;
    height: 34px; padding: 0 12px;
    background: var(--mantle); border-bottom: 1px solid var(--surface0);
    flex-shrink: 0; user-select: none;
  }
  .panel-title {
    font-size: 11px; font-weight: 700; text-transform: uppercase;
    letter-spacing: 0.05em; color: var(--subtext1);
    display: flex; align-items: center; gap: 8px;
  }
  .kind-badge {
    font-size: 10px; font-weight: 600; text-transform: none; letter-spacing: 0;
    padding: 1px 6px; border-radius: 3px;
    background: var(--surface1); color: var(--subtext0);
  }
  .stack-badge {
    font-size: 10px; font-weight: 600; text-transform: none; letter-spacing: 0;
    padding: 1px 6px; border-radius: 3px;
    background: var(--amber); color: var(--crust);
  }
  .close-btn {
    background: transparent; border: none; color: var(--subtext0);
    font-size: 16px; cursor: pointer; padding: 0 4px; line-height: 1;
  }
  .close-btn:hover { color: var(--text); }

  .panel-content { flex: 1; overflow-y: auto; padding: 12px; position: relative; }

  .merge-warning {
    display: flex; gap: 8px; align-items: flex-start;
    padding: 8px 10px; margin-bottom: 12px;
    background: var(--surface0); border-left: 3px solid var(--amber);
    border-radius: 4px; font-size: 11px;
  }
  .warn-icon { color: var(--amber); flex-shrink: 0; }
  .warn-text { color: var(--subtext0); }
  .warn-id { color: var(--text); font-family: var(--font-mono); }

  .divergence-info { color: var(--subtext0); font-size: 12px; margin-bottom: 12px; }
  .change-id-highlight { color: var(--amber); font-family: var(--font-mono); font-weight: 600; }
  .info-detail { color: var(--overlay0); font-size: 11px; }
  .live-hint { color: var(--green); font-size: 11px; margin-left: 6px; }

  .version-columns {
    display: grid;
    grid-template-columns: repeat(var(--n-cols), minmax(0, 1fr));
    gap: 8px;
    margin-bottom: 16px;
  }
  .version-col {
    display: flex; flex-direction: column; gap: 4px;
    padding: 8px; border-radius: 4px;
    background: var(--surface0); border: 1px solid var(--surface1);
    border-top: 3px solid var(--surface1);
  }
  .version-col.col-live { border-top-color: var(--green); }
  .version-col.col-from { border-left: 2px solid var(--red); }
  .version-col.col-to { border-right: 2px solid var(--green); }

  .col-header {
    display: flex; align-items: center; gap: 6px;
    font-family: var(--font-mono); font-size: 11px; font-weight: 700;
    color: var(--subtext1); padding-bottom: 4px;
    border-bottom: 1px solid var(--surface1);
  }
  .col-idx { color: var(--overlay0); }
  .live-dot { color: var(--green); font-size: 10px; }

  .version-cell {
    display: flex; align-items: baseline; gap: 6px;
    font-family: var(--font-mono); font-size: 11px;
    padding: 2px 0; min-width: 0;
  }
  .cell-change-id { color: var(--amber); flex-shrink: 0; }
  .cell-commit-id { color: var(--subtext0); flex-shrink: 0; }
  .cell-bookmarks {
    color: var(--lavender); font-size: 10px;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  .cell-desc {
    color: var(--text); font-family: inherit; font-size: 10px;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  .descendant-cell { opacity: 0.7; padding-left: 8px; }
  .descendant-marker { color: var(--overlay0); }
  .empty-tag {
    font-size: 9px; padding: 0 4px; border-radius: 2px;
    background: var(--surface2); color: var(--overlay1);
  }

  .keep-btn {
    margin-top: 4px; padding: 4px 10px;
    background: transparent; border: 1px solid var(--surface2); color: var(--text);
    border-radius: 3px; cursor: pointer; font-size: 11px; font-weight: 600;
  }
  .keep-btn.keep-live { border-color: var(--green); color: var(--green); }
  .keep-btn:hover:not(:disabled) { background: var(--surface1); }
  .keep-btn.keep-live:hover:not(:disabled) { background: var(--green); color: var(--crust); }
  .keep-btn:disabled { opacity: 0.5; cursor: not-allowed; }

  .compare-section { border-top: 1px solid var(--surface1); padding-top: 12px; }
  .compare-header {
    display: flex; align-items: center; gap: 8px;
    margin-bottom: 10px; flex-wrap: wrap;
  }
  .compare-label { color: var(--subtext0); font-size: 11px; font-weight: 600; }
  .compare-select {
    background: var(--surface0); color: var(--text);
    border: 1px solid var(--surface1); border-radius: 3px;
    padding: 2px 6px; font-family: var(--font-mono); font-size: 11px;
  }
  .compare-arrow { color: var(--overlay0); }
  .file-count { color: var(--overlay0); font-size: 10px; margin-left: auto; }

  .diff-loading, .diff-empty {
    color: var(--surface2); font-size: 12px; padding: 12px 0; text-align: center;
  }
  .cross-diff { margin-top: 4px; }

  .confirm-overlay {
    position: absolute; inset: 0; z-index: 10;
    background: rgba(0,0,0,0.5);
    display: flex; align-items: center; justify-content: center;
  }
  .confirm-box {
    background: var(--base); border: 1px solid var(--surface1);
    border-radius: 6px; padding: 16px;
    max-width: 420px; width: 90%;
  }
  .confirm-title { font-weight: 700; margin-bottom: 10px; color: var(--red); }
  .confirm-item {
    display: flex; gap: 8px; padding: 4px 0;
    font-family: var(--font-mono); font-size: 11px;
  }
  .confirm-id { color: var(--subtext0); }
  .confirm-desc { color: var(--text); }
  .confirm-hint { margin-top: 10px; font-size: 11px; color: var(--overlay0); }
  .confirm-actions { display: flex; gap: 8px; margin-top: 14px; }
  .btn-primary {
    padding: 4px 12px; background: var(--green); color: var(--crust);
    border: none; border-radius: 3px; cursor: pointer; font-size: 11px; font-weight: 600;
  }
  .btn-danger {
    padding: 4px 12px; background: var(--red); color: var(--crust);
    border: none; border-radius: 3px; cursor: pointer; font-size: 11px; font-weight: 600;
  }
  .btn-secondary {
    padding: 4px 12px; background: transparent; color: var(--subtext0);
    border: 1px solid var(--surface1); border-radius: 3px; cursor: pointer; font-size: 11px;
  }

  .empty-state {
    display: flex; flex-direction: column; align-items: center; justify-content: center;
    gap: 8px; padding: 48px 24px; color: var(--surface2); font-size: 13px;
  }
  .error-message { color: var(--red); font-size: 12px; padding: 12px; }
  .spinner {
    width: 20px; height: 20px;
    border: 2px solid var(--surface0); border-top-color: var(--amber);
    border-radius: 50%; animation: spin 0.8s linear infinite;
  }
  @keyframes spin { to { transform: rotate(360deg); } }

  .panel-content::-webkit-scrollbar { width: 8px; }
  .panel-content::-webkit-scrollbar-track { background: transparent; }
  .panel-content::-webkit-scrollbar-thumb { background: var(--surface0); border-radius: 4px; }
  .panel-content::-webkit-scrollbar-thumb:hover { background: var(--surface1); }
</style>
