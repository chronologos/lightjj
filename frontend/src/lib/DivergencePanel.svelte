<script lang="ts">
  import { api, type LogEntry, type FileChange } from './api'
  import { parseDiffContent } from './diff-parser'
  import DiffFileView from './DiffFileView.svelte'

  // Parent info per version: change_id prefix + description
  interface ParentInfo {
    changeId: string
    description: string
  }

  interface Props {
    changeId: string
    onkeep: (keptCommitId: string, abandonCommitIds: string[]) => Promise<void>
    onclose: () => void
  }

  let { changeId, onkeep, onclose }: Props = $props()

  // --- Internal state ---
  let versions: LogEntry[] = $state([])
  let compareFrom: number = $state(0)
  let compareTo: number = $state(1)
  let crossDiff: string = $state('')
  let loading: boolean = $state(true)
  let diffLoading: boolean = $state(false)
  let error: string = $state('')
  let keepingId: string = $state('')
  let fileUnion: string[] = $state([])
  let parentMap: Map<string, ParentInfo> = $state(new Map())

  let parsedCrossDiff = $derived(parseDiffContent(crossDiff))

  // Derive the diff role for each version relative to the current comparison
  function diffRole(index: number): 'from' | 'to' | null {
    if (index === compareFrom) return 'from'
    if (index === compareTo) return 'to'
    return null
  }

  // Separate generation counters — shared counter causes the diff effect to
  // invalidate the version-loading effect's continuation when it runs reactively.
  let versionGen = 0
  let diffGen = 0

  // Load divergent versions when changeId changes
  $effect(() => {
    const id = changeId
    if (!id) return
    const gen = ++versionGen
    loading = true
    error = ''
    versions = []
    crossDiff = ''
    fileUnion = []

    // Use change_id() function to resolve all divergent versions —
    // bare change IDs error on divergent commits in jj
    api.log('change_id(' + id + ')').then(async result => {
      if (gen !== versionGen) return
      // Sort by commit_id for stable ordering
      versions = result.sort((a, b) => a.commit.commit_id.localeCompare(b.commit.commit_id))
      compareFrom = 0
      compareTo = Math.min(1, versions.length - 1)

      // Fetch files for each version in parallel to compute union
      if (versions.length >= 2) {
        try {
          const fileResults = await Promise.all(
            versions.map(v => api.files(v.commit.commit_id).catch(() => [] as FileChange[]))
          )
          if (gen !== versionGen) return
          const pathSet = new Set<string>()
          for (const files of fileResults) {
            for (const f of files) pathSet.add(f.path)
          }
          fileUnion = [...pathSet].sort()
        } catch {
          // Non-critical — cross-diff will still work without file filtering
        }
      }

      // Fetch parent info for each version (best-effort, parallel)
      try {
        const parentResults = await Promise.all(
          versions.map(v =>
            api.log('parents(' + v.commit.commit_id + ')').catch(() => [] as LogEntry[])
          )
        )
        if (gen !== versionGen) return
        const newParentMap = new Map<string, ParentInfo>()
        for (let i = 0; i < versions.length; i++) {
          const parents = parentResults[i]
          if (parents.length > 0) {
            newParentMap.set(versions[i].commit.commit_id, {
              changeId: parents[0].commit.change_id.slice(0, 8),
              description: parents[0].description || '(no description)',
            })
          }
        }
        parentMap = newParentMap
      } catch {
        // Non-critical — parent info is supplementary
      }

      loading = false
    }).catch(e => {
      if (gen !== versionGen) return
      error = e.message || 'Failed to load divergent versions'
      loading = false
    })
  })

  // Load cross-version diff when comparison indices change
  $effect(() => {
    const from = compareFrom
    const to = compareTo
    if (versions.length < 2 || from === to) return
    const fromId = versions[from]?.commit.commit_id
    const toId = versions[to]?.commit.commit_id
    if (!fromId || !toId) return

    const gen = ++diffGen
    error = ''
    diffLoading = true
    api.diffRange(fromId, toId, fileUnion.length > 0 ? fileUnion : undefined).then(result => {
      if (gen !== diffGen) return
      crossDiff = result.diff
      diffLoading = false
    }).catch(e => {
      if (gen !== diffGen) return
      crossDiff = ''
      diffLoading = false
      error = e.message || 'Failed to load cross-version diff'
    })
  })

  async function handleKeep(index: number) {
    const kept = versions[index]
    if (!kept) return
    keepingId = kept.commit.commit_id
    const abandonIds = versions
      .filter((_, i) => i !== index)
      .map(v => v.commit.commit_id)
    try {
      await onkeep(kept.commit.commit_id, abandonIds)
    } finally {
      keepingId = ''
    }
  }
</script>

<div class="panel divergence-panel">
  <div class="panel-header">
    <span class="panel-title">
      Divergence
      <span class="divergence-warn">⚠</span>
    </span>
    <button class="close-btn" onclick={onclose}>×</button>
  </div>

  {#if loading}
    <div class="panel-content">
      <div class="empty-state">
        <div class="spinner"></div>
        <span>Loading divergent versions...</span>
      </div>
    </div>
  {:else if error}
    <div class="panel-content">
      <div class="error-message">{error}</div>
    </div>
  {:else}
    <div class="panel-content">
      <div class="divergence-info">
        Change <span class="change-id-highlight">{changeId.slice(0, 12)}</span> is divergent ({versions.length} versions)
      </div>

      <div class="version-list">
        {#each versions as version, i}
          {@const role = diffRole(i)}
          {@const parent = parentMap.get(version.commit.commit_id)}
          <div class="version-card" class:version-from={role === 'from'} class:version-to={role === 'to'}>
            <div class="version-info">
              <div class="version-header">
                <span class="version-role-indicator" class:role-from={role === 'from'} class:role-to={role === 'to'}>{role === 'from' ? '−' : role === 'to' ? '+' : '·'}</span>
                <span class="version-commit-id">{version.commit.commit_id.slice(0, 8)}</span>
                <span class="version-desc">{version.description || '(no description)'}</span>
              </div>
              {#if parent}
                <div class="version-parent">
                  parent: <span class="parent-id">{parent.changeId}</span> {parent.description}
                </div>
              {/if}
            </div>
            <div class="version-actions">
              <button
                class="keep-btn"
                onclick={() => handleKeep(i)}
                disabled={!!keepingId}
              >
                {keepingId === version.commit.commit_id ? 'Keeping...' : 'Keep'}
              </button>
            </div>
          </div>
        {/each}
      </div>

      {#if versions.length >= 2}
        <div class="compare-section">
          <div class="compare-header">
            <span class="compare-label">Compare:</span>
            <select class="compare-select compare-from" bind:value={compareFrom}>
              {#each versions as v, i}
                <option value={i}>{v.commit.commit_id.slice(0, 8)} − {(v.description || '(none)').slice(0, 30)}</option>
              {/each}
            </select>
            <span class="compare-arrow">↔</span>
            <select class="compare-select compare-to" bind:value={compareTo}>
              {#each versions as v, i}
                <option value={i}>{v.commit.commit_id.slice(0, 8)} + {(v.description || '(none)').slice(0, 30)}</option>
              {/each}
            </select>
            {#if fileUnion.length > 0}
              <span class="file-count">{fileUnion.length} relevant file{fileUnion.length !== 1 ? 's' : ''}</span>
            {/if}
          </div>

          {#if diffLoading}
            <div class="diff-loading">Loading cross-version diff...</div>
          {:else if crossDiff === '' && compareFrom !== compareTo}
            <div class="diff-empty">No differences between these versions</div>
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
                  wordDiffMap={new Map()}
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
  .divergence-panel {
    display: flex;
    flex-direction: column;
    flex: 1;
    overflow: hidden;
  }

  .panel-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    height: 34px;
    padding: 0 12px;
    background: var(--mantle);
    border-bottom: 1px solid var(--surface0);
    flex-shrink: 0;
    user-select: none;
  }

  .panel-title {
    font-size: 11px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--subtext1);
    display: flex;
    align-items: center;
    gap: 6px;
  }

  .divergence-warn {
    color: var(--red);
    font-size: 13px;
  }

  .close-btn {
    background: transparent;
    border: none;
    color: var(--subtext0);
    font-size: 16px;
    cursor: pointer;
    padding: 0 4px;
    font-family: inherit;
    line-height: 1;
  }

  .close-btn:hover {
    color: var(--text);
  }

  .panel-content {
    flex: 1;
    overflow-y: auto;
    padding: 12px;
  }

  .divergence-info {
    color: var(--subtext0);
    font-size: 12px;
    margin-bottom: 12px;
  }

  .change-id-highlight {
    color: var(--amber);
    font-family: var(--font-mono);
    font-weight: 600;
  }

  .version-list {
    display: flex;
    flex-direction: column;
    gap: 8px;
    margin-bottom: 16px;
  }

  .version-card {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 8px 10px;
    background: var(--surface0);
    border: 1px solid var(--surface1);
    border-left: 3px solid var(--surface1);
    border-radius: 4px;
    gap: 8px;
  }

  .version-card.version-from {
    border-left-color: var(--red);
    background: var(--bg-diff-del, rgba(235, 100, 100, 0.06));
  }

  .version-card.version-to {
    border-left-color: var(--green);
    background: var(--bg-diff-add, rgba(100, 200, 100, 0.06));
  }

  .version-info {
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-width: 0;
    flex: 1;
  }

  .version-header {
    display: flex;
    align-items: baseline;
    gap: 8px;
    min-width: 0;
  }

  .version-role-indicator {
    font-family: var(--font-mono);
    font-size: 13px;
    font-weight: 700;
    flex-shrink: 0;
    width: 12px;
    text-align: center;
    color: var(--overlay0);
  }

  .version-role-indicator.role-from {
    color: var(--red);
  }

  .version-role-indicator.role-to {
    color: var(--green);
  }

  .version-commit-id {
    color: var(--subtext0);
    font-size: 11px;
    font-family: var(--font-mono);
    flex-shrink: 0;
  }

  .version-desc {
    color: var(--text);
    font-size: 12px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    min-width: 0;
  }

  .version-parent {
    color: var(--overlay0);
    font-size: 10px;
    padding-left: 20px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .parent-id {
    color: var(--subtext0);
    font-family: var(--font-mono);
  }

  .version-actions {
    flex-shrink: 0;
  }

  .keep-btn {
    background: transparent;
    border: 1px solid var(--green);
    color: var(--green);
    padding: 2px 10px;
    border-radius: 3px;
    cursor: pointer;
    font-family: inherit;
    font-size: 11px;
    font-weight: 600;
  }

  .keep-btn:hover:not(:disabled) {
    background: var(--green);
    color: var(--crust);
  }

  .keep-btn:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .compare-section {
    border-top: 1px solid var(--surface1);
    padding-top: 12px;
  }

  .compare-header {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-bottom: 10px;
    flex-wrap: wrap;
  }

  .compare-label {
    color: var(--subtext0);
    font-size: 11px;
    font-weight: 600;
  }

  .compare-select {
    background: var(--surface0);
    color: var(--text);
    border: 1px solid var(--surface1);
    border-radius: 3px;
    padding: 2px 6px;
    font-family: var(--font-mono);
    font-size: 11px;
    cursor: pointer;
  }

  .compare-from {
    border-left: 2px solid var(--red);
  }

  .compare-to {
    border-left: 2px solid var(--green);
  }

  .compare-arrow {
    color: var(--overlay0);
    font-size: 13px;
  }

  .file-count {
    color: var(--overlay0);
    font-size: 10px;
    margin-left: auto;
  }

  .diff-loading, .diff-empty {
    color: var(--surface2);
    font-size: 12px;
    padding: 12px 0;
    text-align: center;
  }

  .cross-diff {
    margin-top: 4px;
  }

  .empty-state {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 8px;
    padding: 48px 24px;
    color: var(--surface2);
    font-size: 13px;
  }

  .error-message {
    color: var(--red);
    font-size: 12px;
    padding: 12px;
  }

  .spinner {
    width: 20px;
    height: 20px;
    border: 2px solid var(--surface0);
    border-top-color: var(--amber);
    border-radius: 50%;
    animation: spin 0.8s linear infinite;
  }

  @keyframes spin {
    to { transform: rotate(360deg); }
  }

  .panel-content::-webkit-scrollbar {
    width: 8px;
  }

  .panel-content::-webkit-scrollbar-track {
    background: transparent;
  }

  .panel-content::-webkit-scrollbar-thumb {
    background: var(--surface0);
    border-radius: 4px;
  }

  .panel-content::-webkit-scrollbar-thumb:hover {
    background: var(--surface1);
  }
</style>
