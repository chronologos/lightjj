<script lang="ts">
  import { api } from './api'
  import { classify, buildKeepPlan, type DivergenceGroup, type KeepPlan } from './divergence'
  import { computeRefinedKind, findCrossColumnMerge, type RefinedKind } from './divergence-refined'
  import { recommend, immutableSiblingCopy, type Strategy } from './divergence-strategy'
  import { parseDiffContent } from './diff-parser'
  import DiffFileView from './DiffFileView.svelte'

  interface Props {
    changeId: string
    onkeep: (plan: KeepPlan) => Promise<void>
    // Split-identity (jj-guide Strategy 2): metaedit --update-change-id.
    // Panel passes the COMMIT_ID to re-id. Single command, no plan struct.
    onsplit: (commitId: string) => Promise<void>
    // Squash (Strategy 3): jj squash --from loser --into keeper. Panel
    // computes both IDs from the column indices; App just wraps api.squash().
    onsquash: (fromCommitId: string, intoCommitId: string) => Promise<void>
    // Abandon-mutable for the immutable-sibling case. Distinct from onkeep:
    // no keeper id available (the immutable copy is filtered by mutable()
    // revset), no bookmark repoint plan. Just `jj abandon <mutable>`.
    onabandon: (commitId: string) => Promise<void>
    onclose: () => void
  }

  let { changeId, onkeep, onsplit, onsquash, onabandon, onclose }: Props = $props()

  // Escape-to-close. divergence.active is in anyModalOpen so keyboard-gate
  // swallows the key at :57 before escapeStack runs; without this handler
  // Escape is a silent no-op. Auto-focus makes the key reachable immediately
  // — {#key changeId} remount in App.svelte resets panelEl to undefined so
  // this fires once per open.
  let panelEl = $state<HTMLDivElement>()
  $effect(() => { panelEl?.focus() })
  function handleKeydown(e: KeyboardEvent) {
    if (e.key === 'Escape') { e.preventDefault(); onclose() }
  }

  // --- Group classification ---
  // One api.divergence() call on mount gives us everything. Finding the group
  // containing changeId routes to stack or single rendering.
  let group = $state<DivergenceGroup | null>(null)
  // Immutable-sibling case: classify() returns a 1-copy group (the other copy
  // was filtered by `& mutable()`). Not representable as a Keep-able group —
  // stash the lone mutable commit_id and render via recommendForImmutableSibling().
  let immutableSibling = $state<string | null>(null)
  let loading = $state(true)
  let error = $state('')
  let keepingIdx = $state(-1)
  // Guards handleSplit/handleSquash re-entry (same role as keepingIdx for Keep
  // — but Keep needs the idx for "Keeping…" per-button; these are one-shot).
  let strategyBusy = $state(false)

  // Derived view data
  let isStack = $derived((group?.changeIds.length ?? 0) > 1)
  // MAX across levels, not versions[0].length — when alignable=false we keep
  // the ORIGINAL unaligned versions, and those can have mismatched widths
  // (root=3, child=2). Root-only would crash on versions[1][2].commit_id
  // before the `!alignable` Keep-disabled guard can save the user. MAX + the
  // optional chaining below renders all columns with "—" placeholders for
  // missing cells; Keep stays disabled so no wrong-abandon risk.
  let nVersions = $derived(
    group ? Math.max(...group.versions.map(l => l.length)) : 0
  )

  // --- Cross-diff (works for both stack tips and single-change versions) ---
  let compareFrom = $state(0)
  let compareTo = $state(1)
  let crossDiff = $state('')
  let diffLoading = $state(false)
  // Separate from `error` — cross-diff failure must NOT hide the Keep buttons
  // (the `{:else if error}` template branch replaces the entire group view).
  // Previously this WROTE `error` → panel clobbered with no recovery (success
  // path doesn't clear it). Rendered inline in the compare-section instead.
  let crossDiffError = $state('')
  let fileUnion = $state<Set<string>>(new Set())

  let parsedCrossDiff = $derived(parseDiffContent(crossDiff))

  // RefinedKind — full taxonomy after tree-delta lands. Feeds both the kind
  // badge AND recommend(). Decision logic extracted to divergence-refined.ts.
  let refinedKind = $derived(
    computeRefinedKind(group, diffLoading, parsedCrossDiff.map(f => f.filePath), fileUnion)
  )

  // Strategy recommendations — ranked list, [0] rendered as primary card.
  // Recomputes when refinedKind settles (pending→concrete). Immutable-sibling
  // doesn't use this — two hardcoded buttons, see template.
  let strategies = $derived(group ? recommend(group, refinedKind) : [])

  // A descendant merging two column tips is likely the user's manual
  // reconciliation. Extracted to divergence-refined.ts (findCrossColumnMerge).
  let crossColumnMerge = $derived(group ? findCrossColumnMerge(group) : null)

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
        // Old panel showed an error string with a shell hint; now we offer
        // actionable strategies — split-identity keeps the user's work,
        // abandon-mutable accepts trunk's version. See recommendForImmutableSibling().
        //
        // findRoot's parentCommits.size >= 2 guard ensures these never chain
        // as roots of resolvable stacks — versions[0] here is always the
        // clicked change.
        immutableSibling = found.versions[0][0].commit_id
        loading = false
        return
      }
      // fileUnion BEFORE group: the diff effect depends on both. Setting
      // group first would fire it with fileUnion empty → unfiltered fetch
      // (large, includes trunk churn), then fileUnion lands → fires again
      // filtered → first response discarded by diffGen but wasted round trip.
      // With this order: fileUnion set → diff effect checks `if (!group)` →
      // bails. group set → single filtered fetch.
      // No per-call .catch(): a silently-empty fileUnion makes refineRebaseKind
      // unconditionally return 'pure-rebase' (filter against empty set → []),
      // triggering a HIGH-confidence keep recommendation when trees may
      // actually differ. Let failures bubble to the outer catch → panel error.
      //
      // ALL levels, not just tip — diffRange(tip0, tip1) compares full trees
      // which inherit changes from intermediate levels. Tip-only fileUnion
      // would exclude those from the filterFiles → refineRebaseKind
      // subtraction is a no-op (every returned file is tip-touched) →
      // 'pure-rebase' + HIGH confidence when stacked content differs.
      // Rare (stacked divergence + non-tip edits) but the failure mode is
      // "recommend destructive action with false confidence".
      const fileResults = await Promise.all(
        found.versions.flat().map(v => api.files(v.commit_id))
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
    // Clear error at the top — early-returns below would otherwise leave a
    // stale crossDiffError displayed after toggling compareFrom/To out of a
    // failed state (e.g. self-compare, or !alignable colIdx out-of-range).
    crossDiffError = ''
    // compareFrom === compareTo: meaningless self-compare. Clear crossDiff so
    // the template doesn't show stale content labeled "Diff /N → /N". Also
    // invalidate in-flight fetch (prev from/to selection) that would clobber.
    if (!group || nVersions < 2 || compareFrom === compareTo) {
      diffGen++
      crossDiff = ''
      diffLoading = false
      return
    }
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
      crossDiffError = e.message || 'Failed to load cross-version diff'
    })
  })

  // Thin wrapper — logic lives in divergence.ts now (testable in isolation).
  function buildPlan(keeperIdx: number): KeepPlan {
    return buildKeepPlan(group!, keeperIdx)
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
    if (!group || !group.alignable || keepingIdx >= 0 || strategyBusy) return
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

  // Dispatches a Strategy to the right handler. Centralized so both the
  // primary card button AND secondary pills go through one path.
  // recommend() never emits 'split-identity' — that's immutable-sibling-only,
  // handled by splitMutable()/abandonMutable() below (hardcoded buttons).
  async function applyStrategy(s: Strategy) {
    if (strategyBusy || keepingIdx >= 0) return
    switch (s.kind) {
      case 'keep':
        // targetIdx null → no recommendation on WHICH column; let user pick
        // via the per-column Keep buttons. The card is informational only.
        if (s.targetIdx === null) return
        await handleKeep(s.targetIdx)
        return
      case 'squash': {
        // targetIdx is the --into side; --from is the other column. n=2 and
        // non-stack guaranteed upstream (recommend() gates on both); re-checked
        // here as defense-in-depth for direct callers.
        if (!group || nVersions !== 2 || isStack) return
        const into = s.targetIdx ?? 0
        const from = 1 - into
        const tipLevel = group.versions[group.versions.length - 1]
        strategyBusy = true
        try {
          await onsquash(tipLevel[from].commit_id, tipLevel[into].commit_id)
        } finally { strategyBusy = false }
        return
      }
    }
  }

  // Immutable-sibling actions. Two fixed choices; not routed through
  // Strategy[] (would overload 'keep' with inverted semantics).
  async function splitMutable() {
    if (!immutableSibling || strategyBusy) return
    strategyBusy = true
    try { await onsplit(immutableSibling) } finally { strategyBusy = false }
  }
  async function abandonMutable() {
    if (!immutableSibling || strategyBusy) return
    strategyBusy = true
    try { await onabandon(immutableSibling) } finally { strategyBusy = false }
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
    // Descendants move to the keeper at their ORIGINAL parent's level; the
    // stale stack is then abandoned with no children pinning it visible.
    // executeKeepPlan groups by dest and runs one rebase per distinct target,
    // BEFORE the abandon.
    execute({
      ...pendingPlan,
      rebaseSources: pendingPlan.nonEmptyDescendants.map(d => ({
        source: d.commit_id,
        dest: d.rebaseTarget,
      })),
      nonEmptyDescendants: [],
    }, pendingKeeperIdx)
  }

  // RefinedKind → badge text. Shown in the header; updates as cross-diff lands.
  const kindLabel: Record<RefinedKind, { text: string; hint: string }> = {
    'pending':       { text: '…',               hint: 'Loading tree diff to refine classification…' },
    'metadata-only': { text: 'metadata only',   hint: 'Same tree, same parent — only description/author differ.' },
    'edit-conflict': { text: 'edit conflict',   hint: 'Both versions have unique edits from the same base.' },
    'pure-rebase':   { text: 'pure rebase',     hint: 'Trees identical (modulo trunk). Either version is safe.' },
    'rebase-edit':   { text: 'rebase + edit',   hint: 'One version has edits the other doesn\'t. Check the diff before keeping.' },
    'compound':      { text: 'compound',        hint: '3+ versions or non-alignable columns. Resolve manually.' },
  }

  // Strategy → button verb + what jj will run (for the title tooltip).
  // recommend() only emits keep/squash; split-identity is immutable-sibling
  // only (hardcoded buttons, doesn't go through strategyCard).
  const strategyLabel: Record<'keep' | 'squash', { verb: string; cmd: (s: Strategy) => string }> = {
    'keep':   { verb: 'Keep',   cmd: s => s.targetIdx === null ? 'jj abandon <other>' : `Keep /${s.targetIdx} (abandons others)` },
    'squash': { verb: 'Squash', cmd: s => `jj squash --from /${s.targetIdx === null ? '?' : 1 - s.targetIdx} --into /${s.targetIdx ?? '?'}` },
  }
</script>

<!-- svelte-ignore a11y_no_noninteractive_element_interactions --
     keydown is for Escape-to-close only; buttons inside handle their own clicks. -->
<div class="panel divergence-panel" role="region" aria-label="Divergence resolution" tabindex="-1" bind:this={panelEl} onkeydown={handleKeydown}>
  <div class="panel-header">
    <span class="panel-title">
      Divergence
      {#if immutableSibling}
        <span class="kind-badge kind-immut" title="The other copy is in immutable history (trunk). It cannot be abandoned.">
          immutable sibling
        </span>
      {:else if group}
        <span class="kind-badge" title={kindLabel[refinedKind].hint}>
          {kindLabel[refinedKind].text}
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
  {:else if immutableSibling}
    <!-- Divergent-with-immutable-sibling: the other copy is trunk. No columns
         to keep — the immutable side is permanent. Two hardcoded actions;
         NOT routed through Strategy[] (would overload 'keep' semantics). -->
    <div class="panel-content">
      <div class="divergence-info">
        Change <span class="change-id-highlight">{changeId.slice(0, 12)}</span>
        is divergent with an <strong>immutable</strong> copy (likely in trunk history).
        That copy cannot be abandoned.
      </div>
      <div class="strategy-card conf-medium">
        <div class="strategy-head">
          <span class="strategy-verb">Split identity</span>
          <span class="strategy-conf">recommended</span>
        </div>
        <div class="strategy-reason">{immutableSiblingCopy.splitReason}</div>
        <div class="strategy-actions">
          <button class="strategy-apply"
            onclick={splitMutable}
            disabled={strategyBusy}
            title="jj metaedit --update-change-id {immutableSibling.slice(0, 8)}"
          >
            {strategyBusy ? 'Applying…' : 'Apply'}
          </button>
          <button class="strategy-pill"
            onclick={abandonMutable}
            disabled={strategyBusy}
            title="{immutableSiblingCopy.abandonReason} — jj abandon {immutableSibling.slice(0, 8)}"
          >
            Abandon mutable
          </button>
        </div>
      </div>
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
              <button class="dp-btn-confirm" onclick={confirmRebaseDescendants}
                title="jj rebase -s onto keeper at the same stack level — keeps their content, moves them to the winning stack">
                Rebase onto keeper
              </button>
              <button class="dp-btn-abandon" onclick={confirmAbandonDescendants}
                title="Discards their content">
                Abandon anyway
              </button>
              <button class="dp-btn-cancel" onclick={() => pendingPlan = null}>Cancel</button>
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

      {@render strategyCard()}

      <!-- Columns: one per version, rows = stack levels. For single-change
           divergence this is 1 row × N columns = the old card layout.
           Optional chaining for arity-mismatch (!alignable) cases where
           nVersions=MAX(...) exceeds some level's width — cell renders "—"
           instead of crashing on undefined.commit_id. Keep stays disabled. -->
      <div class="version-columns" style="--n-cols: {nVersions}">
        {#each Array(nVersions) as _, colIdx}
          {@const colCommitIds = new Set(group.versions.map(l => l[colIdx]?.commit_id).filter(Boolean))}
          {@const rootV = group.versions[0][colIdx]}
          <div class="version-col" class:col-live={group.liveVersion === colIdx} class:col-from={colIdx === compareFrom} class:col-to={colIdx === compareTo}>
            <div class="col-header">
              <span class="col-idx">/{colIdx}</span>
              {#if group.liveVersion === colIdx}<span class="live-dot" title="@ descends from here">●</span>{/if}
            </div>
            <!-- Description line — the metadata-only discriminator. first_line()
                 from the template (divergence.go:42). Highlighted when THIS is
                 the thing to compare (metadata-only case). -->
            <div class="col-desc" class:col-desc-key={refinedKind === 'metadata-only'}
              title={rootV?.description}>
              {rootV?.description || '(no description)'}
            </div>
            <!-- Parent commit chip — for diff-parent cases these DIFFER and
                 answer "which trunk point?"; for same-parent they match. -->
            <div class="col-parent" class:col-parent-key={group.kind === 'diff-parent'}
              title="Parent commit. Cross-reference in the log to see which trunk point this sits on.">
              <span class="col-parent-label">on</span>
              <span class="col-parent-id">{rootV?.parent_commit_ids[0]?.slice(0, 8) ?? '—'}</span>
            </div>
            {#each group.changeIds as cid, levelIdx}
              {@const v = group.versions[levelIdx][colIdx]}
              <div class="version-cell">
                <span class="cell-change-id">{cid.slice(0, 8)}</span>
                <span class="cell-commit-id">{v?.commit_id.slice(0, 8) ?? '—'}</span>
                {#if v && v.bookmarks.length > 0}
                  <span class="cell-bookmarks">{v.bookmarks.join(', ')}</span>
                {/if}
              </div>
            {/each}
            {#each group.descendants.filter(d => d.parent_commit_ids.some(p => colCommitIds.has(p))) as d}
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
              disabled={keepingIdx >= 0 || strategyBusy || !group.alignable}
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
          {:else if crossDiffError}
            <div class="diff-empty diff-error">{crossDiffError}</div>
          {:else if crossDiff === '' && compareFrom !== compareTo}
            <!-- Diff is filtered to fileUnion — empty means the files THIS
                 change owns are identical. For same-parent that's "only
                 metadata"; for diff-parent the trees may still differ via
                 trunk churn (which was filtered out). -->
            <div class="diff-empty">
              {#if group.kind === 'diff-parent'}
                No content drift in change-owned files — differences are trunk churn only
              {:else}
                Trees identical — only metadata differs
              {/if}
            </div>
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

<!-- Strategy recommendation card — primary (#1 in ranked list) rendered
     prominently with confidence-tinted accent, secondaries as small pills.
     Only rendered in the normal-group path; immutable-sibling uses hardcoded
     buttons (two fixed actions, no ranking). Empty list = no card. -->
{#snippet strategyCard()}
  {#if strategies.length > 0}
    {@const primary = strategies[0]}
    {@const label = strategyLabel[primary.kind]}
    <!-- null targetIdx = "we don't know which direction". keep: informational
         only (per-column buttons below). squash: offer BOTH directions —
         defaulting to /0 silently would be arbitrary. -->
    {@const needsDirection = primary.targetIdx === null}
    <div class="strategy-card conf-{primary.confidence}">
      <div class="strategy-head">
        <span class="strategy-verb">{label.verb}
          {#if primary.targetIdx !== null}<span class="strategy-target">/{primary.targetIdx}</span>{/if}
        </span>
        <span class="strategy-conf">{primary.confidence}</span>
      </div>
      <div class="strategy-reason">{primary.reason}</div>
      <div class="strategy-actions">
        {#if !needsDirection}
          <button class="strategy-apply"
            onclick={() => applyStrategy(primary)}
            disabled={strategyBusy || keepingIdx >= 0}
            title={label.cmd(primary)}
          >
            {strategyBusy ? 'Applying…' : 'Apply'}
          </button>
        {:else if primary.kind === 'squash'}
          <!-- Directional squash: two buttons, each a concrete --into. -->
          {#each [0, 1] as into}
            <button class="strategy-apply"
              onclick={() => applyStrategy({ ...primary, targetIdx: into })}
              disabled={strategyBusy || keepingIdx >= 0}
              title="jj squash --from /{1 - into} --into /{into}"
            >
              {strategyBusy ? '…' : `Into /${into}`}
            </button>
          {/each}
        {/if}
        <!-- keep with targetIdx null → no button, per-column Keep handles it.
             The reason text already says "pick"; no extra hint needed. -->
        {#each strategies.slice(1) as s}
          {@const sLabel = strategyLabel[s.kind]}
          <button class="strategy-pill"
            onclick={() => applyStrategy(s)}
            disabled={strategyBusy || keepingIdx >= 0}
            title="{s.reason} — {sLabel.cmd(s)}"
          >
            {sLabel.verb}{#if s.targetIdx !== null} /{s.targetIdx}{/if}
          </button>
        {/each}
      </div>
    </div>
  {/if}
{/snippet}

<style>
  .divergence-panel { display: flex; flex-direction: column; flex: 1; overflow: hidden; outline: none; }

  .panel-title {
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
    gap: 10px;
    margin-bottom: 16px;
  }
  .version-col {
    display: flex; flex-direction: column; gap: 6px;
    padding: 10px 12px; border-radius: 6px;
    background: var(--surface0);
    border: 1px solid var(--surface1);
    border-top: 3px solid var(--surface1);
    /* Subtle lift — columns are CHOICES, not just data rows. */
    box-shadow: 0 1px 3px rgba(0,0,0,0.06), inset 0 1px 0 rgba(255,255,255,0.02);
    transition: border-color 120ms ease;
  }
  .version-col.col-live { border-top-color: var(--green); }
  /* diff-selector from/to markers — corner indicator dots, not noisy full-
     height borders that compete with the confidence accent. */
  .version-col.col-from::before,
  .version-col.col-to::before {
    content: ''; position: absolute; width: 6px; height: 6px; border-radius: 50%;
    top: 6px;
  }
  .version-col { position: relative; }
  .version-col.col-from::before { left: 6px; background: var(--red); }
  .version-col.col-to::before { right: 6px; background: var(--green); }

  .col-header {
    display: flex; align-items: center; gap: 6px;
    font-family: var(--font-mono); font-size: 12px; font-weight: 700;
    color: var(--subtext1); padding-bottom: 6px;
  }
  .col-idx {
    color: var(--overlay0);
    /* /N is the column's "name" — make it readable. */
    font-size: 13px; letter-spacing: -0.02em;
  }
  .live-dot { color: var(--green); font-size: 10px; }

  /* Description — THE discriminator for metadata-only. When it IS the key
     difference (.col-desc-key), quote-block it with an amber accent so the
     eye lands there first. */
  .col-desc {
    font-size: 11px; color: var(--text); line-height: 1.4;
    padding: 2px 0 6px; border-bottom: 1px solid var(--surface1);
    overflow: hidden; text-overflow: ellipsis;
    display: -webkit-box; -webkit-line-clamp: 2; line-clamp: 2; -webkit-box-orient: vertical;
  }
  .col-desc-key {
    padding: 6px 8px; margin: 2px 0 4px;
    border-left: 2px solid var(--amber); border-bottom: none;
    background: color-mix(in srgb, var(--amber) 6%, transparent);
    border-radius: 0 3px 3px 0;
    font-weight: 500;
  }

  /* Parent commit chip. For diff-parent (fresher-trunk question), these
     DIFFER — amber tint calls attention. For same-parent they match so
     the subdued default styling de-emphasizes. */
  .col-parent {
    display: inline-flex; align-items: baseline; gap: 4px;
    padding: 2px 0; font-size: 10px;
  }
  .col-parent-label {
    color: var(--overlay0); font-size: 9px;
    text-transform: uppercase; letter-spacing: 0.04em;
  }
  .col-parent-id {
    font-family: var(--font-mono); color: var(--subtext0);
    padding: 1px 5px; border-radius: 2px;
    background: var(--surface1);
  }
  /* diff-parent case — parents differ, this IS the answer to "fresher trunk" */
  .col-parent-key .col-parent-id {
    background: color-mix(in srgb, var(--amber) 14%, var(--surface1));
    color: var(--text);
    border: 1px solid color-mix(in srgb, var(--amber) 30%, transparent);
  }

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
    margin-top: auto; padding: 6px 10px;
    background: var(--surface1); border: 1px solid var(--surface2); color: var(--text);
    border-radius: 4px; cursor: pointer;
    font-size: 11px; font-weight: 700; letter-spacing: 0.02em;
    transition: background 100ms ease, transform 80ms ease;
  }
  .keep-btn.keep-live {
    background: color-mix(in srgb, var(--green) 12%, var(--surface1));
    border-color: var(--green); color: var(--green);
  }
  .keep-btn:hover:not(:disabled) { background: var(--surface2); transform: translateY(-1px); }
  .keep-btn.keep-live:hover:not(:disabled) { background: var(--green); color: var(--crust); }
  .keep-btn:active:not(:disabled) { transform: translateY(0); }
  .keep-btn:disabled { opacity: 0.4; cursor: not-allowed; }

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
  .diff-error { color: var(--red); }
  .cross-diff { margin-top: 4px; }

  .confirm-overlay {
    position: absolute; inset: 0; z-index: 10;
    background: var(--backdrop);
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
  .dp-btn-confirm {
    padding: 4px 12px; background: var(--green); color: var(--crust);
    border: none; border-radius: 3px; cursor: pointer; font-size: 11px; font-weight: 600;
  }
  .dp-btn-abandon {
    padding: 4px 12px; background: var(--red); color: var(--crust);
    border: none; border-radius: 3px; cursor: pointer; font-size: 11px; font-weight: 600;
  }
  .dp-btn-cancel {
    padding: 4px 12px; background: transparent; color: var(--subtext0);
    border: 1px solid var(--surface1); border-radius: 3px; cursor: pointer; font-size: 11px;
  }

  .empty-state {
    display: flex; flex-direction: column; align-items: center; justify-content: center;
    gap: 8px; padding: 48px 24px; color: var(--surface2); font-size: 13px;
  }
  .error-message { color: var(--red); font-size: 12px; padding: 12px; }

  .kind-immut { background: var(--amber); color: var(--crust); }

  /* Strategy card — confidence-tinted left accent. High = green (near-certain
     no content risk), medium = amber (plausible but verify), low = overlay
     (informational). Visually bridges to the columns below: narrower bottom
     margin + bottom-only radius = "this card annotates those columns". */
  .strategy-card {
    padding: 10px 14px; margin-bottom: 10px;
    background: linear-gradient(to bottom,
      var(--surface0),
      color-mix(in srgb, var(--surface0) 60%, transparent));
    border-radius: 6px 6px 3px 3px;
    border-left: 3px solid var(--overlay0);
  }
  .strategy-card.conf-high   { border-left-color: var(--green); }
  .strategy-card.conf-medium { border-left-color: var(--amber); }

  .strategy-head {
    display: flex; align-items: center; gap: 6px; margin-bottom: 3px;
  }
  .strategy-verb {
    font-size: 13px; font-weight: 700; color: var(--text);
    letter-spacing: -0.01em;
  }
  .strategy-target {
    font-family: var(--font-mono); font-weight: 700; color: var(--amber);
    margin-left: 1px;
  }
  .strategy-conf {
    font-size: 8px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.08em;
    padding: 2px 6px; border-radius: 3px;
    background: var(--surface1); color: var(--subtext0);
    /* Sit tight against the verb, not floating off to the right. */
  }
  .conf-high .strategy-conf {
    background: color-mix(in srgb, var(--green) 18%, var(--surface1)); color: var(--green);
  }
  .conf-medium .strategy-conf {
    background: color-mix(in srgb, var(--amber) 18%, var(--surface1)); color: var(--amber);
  }

  .strategy-reason {
    font-size: 11px; color: var(--subtext0); line-height: 1.45;
  }
  .strategy-reason:not(:last-child) { margin-bottom: 8px; }

  .strategy-actions {
    display: flex; align-items: center; gap: 6px; flex-wrap: wrap;
  }
  .strategy-apply {
    padding: 5px 16px; font-size: 11px; font-weight: 700;
    background: var(--surface1); color: var(--text);
    border: 1px solid var(--surface2); border-radius: 4px; cursor: pointer;
    letter-spacing: 0.01em;
    transition: background 100ms ease, transform 80ms ease;
  }
  .conf-high .strategy-apply {
    background: var(--green); color: var(--crust); border-color: var(--green);
    /* High confidence = decisive weight */
    box-shadow: 0 1px 2px color-mix(in srgb, var(--green) 25%, transparent);
  }
  .conf-medium .strategy-apply {
    background: color-mix(in srgb, var(--amber) 10%, var(--surface1));
    border-color: var(--amber); color: var(--amber);
  }
  .strategy-apply:hover:not(:disabled) { transform: translateY(-1px); filter: brightness(1.08); }
  .strategy-apply:active:not(:disabled) { transform: translateY(0); }
  .strategy-apply:disabled { opacity: 0.4; cursor: not-allowed; }

  .strategy-pill {
    padding: 3px 10px; font-size: 10px; font-weight: 500;
    background: transparent; color: var(--subtext0);
    border: 1px solid var(--surface2); border-radius: 12px; cursor: pointer;
    transition: background 100ms ease, color 100ms ease;
  }
  .strategy-pill:hover:not(:disabled) { background: var(--surface1); color: var(--text); }
  .strategy-pill:disabled { opacity: 0.4; cursor: not-allowed; }

  .panel-content::-webkit-scrollbar { width: 8px; }
  .panel-content::-webkit-scrollbar-track { background: transparent; }
  .panel-content::-webkit-scrollbar-thumb { background: var(--surface0); border-radius: 4px; }
  .panel-content::-webkit-scrollbar-thumb:hover { background: var(--surface1); }
</style>
