<script lang="ts">
  import type { ModeBase, RebaseMode, SquashMode, SplitMode, MegamergeMode } from './modes.svelte'

  interface Props {
    statusText: string
    rebase: RebaseMode
    squash: SquashMode
    squashFileCount: { selected: number, total: number } | null
    split: SplitMode
    splitFileCount: { selected: number, total: number } | null
    megamerge: MegamergeMode
    activeView: 'log' | 'branches' | 'merge'
  }

  let { statusText, rebase, squash, squashFileCount, split, splitFileCount, megamerge, activeView }: Props = $props()

  // At most one mode is active (App's enter* helpers cancel the others first).
  let activeMode: ModeBase | null = $derived(
    rebase.active ? rebase : squash.active ? squash : split.active ? split : megamerge.active ? megamerge : null)

  const sourceKeys: { key: string; flag: string; label: string }[] = [
    { key: 'r', flag: '-r', label: 'revision' },
    { key: 's', flag: '-s', label: 'source' },
    { key: 'b', flag: '-b', label: 'branch' },
  ]

  const targetKeys: { key: string; flag: string; label: string }[] = [
    { key: 'o', flag: '-d', label: 'onto' },
    { key: 'a', flag: '--insert-after', label: 'after' },
    { key: 'i', flag: '--insert-before', label: 'before' },
  ]

  // Per-mode key hints, rendered by ONE generic loop below. Each inner array
  // is a key-group (separated by dividers); each hint is N <kbd>s + a label.
  // The mode-specific knowledge lives in this kind-keyed table — the chrome
  // around it (mode badge, Enter/Esc/`/`, file count) renders once for all modes.
  interface KeyHint { keys: string[]; label: string; active?: boolean }
  let keyGroups: KeyHint[][] = $derived.by(() => {
    switch (activeMode?.kind) {
      case 'rebase': return [
        sourceKeys.map(sk => ({ keys: [sk.key], label: sk.label, active: rebase.sourceMode === sk.flag })),
        targetKeys.map(tk => ({ keys: [tk.key], label: tk.label, active: rebase.targetMode === tk.flag })),
        [
          { keys: ['e'], label: 'skip-emptied', active: rebase.skipEmptied },
          { keys: ['x'], label: 'ignore-immutable', active: rebase.ignoreImmutable },
          { keys: ['p'], label: 'simplify-parents', active: rebase.simplifyParents },
        ],
      ]
      case 'squash': return [
        [
          { keys: ['e'], label: 'keep-emptied', active: squash.keepEmptied },
          { keys: ['x'], label: 'ignore-immutable', active: squash.ignoreImmutable },
        ],
        // Which description the squashed commit keeps (issue #22). Showing the
        // active choice here is also the answer to "I'm not sure which prevails".
        [{ keys: ['m'], label: `desc: ${squash.descMode}`, active: squash.descMode !== 'destination' }],
      ]
      case 'split': return [
        split.review
          ? [{ keys: ['j', 'k'], label: 'hunk' }, { keys: ['Space'], label: 'toggle' }, { keys: ['a', 'n'], label: 'file' }]
          : [{ keys: ['p'], label: 'parallel', active: split.parallel }],
      ]
      case 'megamerge': return [
        [{ keys: ['j', 'k'], label: 'move' }, { keys: ['Space'], label: 'toggle parent' }],
      ]
      default: return []
    }
  })

  let badgeLabel = $derived(
    activeMode?.kind === 'split' && split.review ? 'review' : activeMode?.kind ?? '')

  // File/hunk progress — at most one of the two count props applies.
  let fileCount = $derived(
    activeMode?.kind === 'squash' ? squashFileCount
    : activeMode?.kind === 'split' ? splitFileCount
    : null)
  let fileCountNoun = $derived(
    activeMode?.kind === 'squash' ? 'files to move'
    : split.review ? 'hunks accepted' : 'files stay')
  // Red empty-warning only for squash: 0 selected files blocks Enter there.
  // Split's 0/total is reported on Enter instead.
  let warnEmpty = $derived(activeMode?.kind === 'squash')
</script>

<footer class="statusbar"
  class:rebase-active={activeMode?.kind === 'rebase'}
  class:squash-active={activeMode?.kind === 'squash'}
  class:split-active={activeMode?.kind === 'split'}
  class:megamerge-active={activeMode?.kind === 'megamerge'}>
  {#if activeMode}
    <div class="statusbar-left">
      <span class="mode-badge">{badgeLabel}</span>
      <span class="key-group">
        <kbd class="key action-key">Enter</kbd><span class="key-label">apply</span>
        <kbd class="key action-key">Esc</kbd><span class="key-label">cancel</span>
        {#if activeMode.hasDestination && activeMode.kind !== 'megamerge'}
          <kbd class="key action-key">/</kbd><span class="key-label">type dest</span>
        {/if}
      </span>
      {#if activeMode.kind === 'megamerge'}
        <span class="key-divider"></span>
        <span class="key-group">
          <span class="mm-parent-count" class:file-count-empty={megamerge.parentIds.length === 0}>{megamerge.parentIds.length} parent{megamerge.parentIds.length === 1 ? '' : 's'}</span>
        </span>
      {/if}
      {#each keyGroups as group}
        <span class="key-divider"></span>
        <span class="key-group">
          {#each group as hint}
            {#each hint.keys as k}<kbd class="key" class:key-active={hint.active}>{k}</kbd>{/each}<span class="key-label" class:key-label-active={hint.active}>{hint.label}</span>
          {/each}
        </span>
      {/each}
      {#if fileCount}
        <span class="key-divider"></span>
        <span class="key-group">
          <span class="file-count" class:file-count-empty={warnEmpty && fileCount.selected === 0}>{fileCount.selected}/{fileCount.total} {fileCountNoun}</span>
        </span>
      {/if}
    </div>
  {:else}
    <div class="statusbar-left">
      {#if statusText}
        <span class="status-item">{statusText}</span>
      {:else if activeView === 'log'}
        <span class="key-hints">
          <kbd>j</kbd>/<kbd>k</kbd> navigate
          <kbd>⇧J</kbd>/<kbd>⇧K</kbd> slide
          <kbd>[</kbd>/<kbd>]</kbd> file
          <kbd>Space</kbd> check
          <kbd>e</kbd> describe
          <kbd>R</kbd> rebase
          <kbd>S</kbd> squash
          <kbd>/</kbd> filter
          <kbd>⌘F</kbd> search
        </span>
      {:else if activeView === 'branches'}
        <span class="key-hints">
          <kbd>j</kbd>/<kbd>k</kbd> navigate
          <kbd>⏎</kbd> jump
          <kbd>d</kbd> delete
          <kbd>f</kbd> forget
          <kbd>t</kbd> track
          <kbd>/</kbd> filter
        </span>
      {:else if activeView === 'merge'}
        <span class="key-hints">
          <kbd>j</kbd>/<kbd>k</kbd> file
          <kbd>[</kbd>/<kbd>]</kbd> block
          <kbd>b</kbd> both
          <kbd>h</kbd> hide pane
          <kbd>⌘S</kbd> save
          <kbd>Esc</kbd> exit
        </span>
      {/if}
    </div>
  {/if}
</footer>

<style>
  .statusbar {
    display: flex;
    justify-content: space-between;
    align-items: center;
    height: 24px;
    padding: 0 10px;
    background: var(--crust);
    border-top: 1px solid var(--surface1);
    flex-shrink: 0;
    user-select: none;
    font-size: var(--fs-sm);
    color: var(--subtext0);
    transition: border-top-color var(--anim-duration) var(--anim-ease);
  }

  .statusbar.rebase-active {
    border-top-color: var(--amber);
  }

  .statusbar.squash-active {
    border-top-color: var(--green);
  }

  .statusbar.split-active {
    border-top-color: var(--amber);
  }

  .statusbar.megamerge-active {
    border-top-color: var(--blue);
  }

  .statusbar-left {
    display: flex;
    align-items: center;
    gap: 12px;
  }

  /* --- Inline mode (rebase/squash/split) --- */
  .mode-badge {
    background: var(--amber);
    color: var(--crust);
    font-weight: 800;
    font-size: var(--fs-xs);
    text-transform: uppercase;
    letter-spacing: 0.08em;
    padding: 1px 7px;
    border-radius: 3px;
    animation: badge-in var(--anim-duration) var(--anim-ease);
  }

  .key-group {
    display: flex;
    align-items: center;
    gap: 3px;
  }

  .key-divider {
    width: 1px;
    height: 12px;
    background: var(--surface1);
    margin: 0 4px;
  }

  .key {
    font-family: inherit;
    font-size: var(--fs-xs);
    font-weight: 600;
    padding: 0 4px;
    border-radius: 3px;
    background: var(--surface0);
    color: var(--subtext0);
    border: 1px solid var(--surface1);
    line-height: 1.5;
  }

  .key.action-key {
    background: var(--surface1);
    color: var(--text);
  }

  .key.key-active {
    background: var(--amber);
    color: var(--crust);
    border-color: var(--amber);
  }

  .key-label {
    color: var(--overlay0);
    font-size: var(--fs-xs);
    margin-right: 4px;
  }

  .key-label.key-label-active {
    color: var(--text);
    font-weight: 600;
  }


  .file-count,
  .mm-parent-count {
    color: var(--subtext0);
    font-size: var(--fs-xs);
  }

  .file-count-empty {
    color: var(--red);
    font-weight: 600;
  }

  .key-hints {
    display: flex;
    align-items: center;
    gap: 4px;
    color: var(--text-faint);
    font-size: var(--fs-xs);
  }

  .key-hints kbd {
    font-family: inherit;
    font-size: var(--fs-xs);
    color: var(--subtext0);
    background: var(--surface0);
    padding: 0 3px;
    border-radius: 2px;
    border: none;
  }
</style>
