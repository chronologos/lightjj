<script lang="ts">
  import type { RebaseMode, SquashMode, SplitMode } from './modes.svelte'

  interface Props {
    statusText: string
    rebase: RebaseMode
    squash: SquashMode
    squashFileCount: { selected: number, total: number } | null
    split: SplitMode
    splitFileCount: { selected: number, total: number } | null
    activeView: 'log' | 'branches'
  }

  let { statusText, rebase, squash, squashFileCount, split, splitFileCount, activeView }: Props = $props()

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
</script>

<footer class="statusbar" class:rebase-active={rebase.active} class:squash-active={squash.active} class:split-active={split.active}>
  {#if split.active}
    <div class="statusbar-left">
      <span class="mode-badge">{split.review ? 'review' : 'split'}</span>
      <span class="key-group">
        <kbd class="key action-key">Enter</kbd><span class="key-label">apply</span>
        <kbd class="key action-key">Esc</kbd><span class="key-label">cancel</span>
      </span>
      <span class="key-divider"></span>
      {#if split.review}
        <span class="key-group">
          <kbd class="key">j</kbd><kbd class="key">k</kbd><span class="key-label">hunk</span>
          <kbd class="key">Space</kbd><span class="key-label">toggle</span>
          <kbd class="key">a</kbd><kbd class="key">n</kbd><span class="key-label">file</span>
        </span>
      {:else}
        <span class="key-group">
          <kbd class="key" class:key-active={split.parallel}>p</kbd><span class="key-label" class:key-label-active={split.parallel}>parallel</span>
        </span>
      {/if}
      {#if splitFileCount}
        <span class="key-divider"></span>
        <span class="key-group">
          <span class="file-count">{splitFileCount.selected}/{splitFileCount.total} {split.review ? 'hunks accepted' : 'files stay'}</span>
        </span>
      {/if}
    </div>
  {:else if squash.active}
    <div class="statusbar-left">
      <span class="mode-badge">squash</span>
      <span class="key-group">
        <kbd class="key action-key">Enter</kbd><span class="key-label">apply</span>
        <kbd class="key action-key">Esc</kbd><span class="key-label">cancel</span>
      </span>
      <span class="key-divider"></span>
      <span class="key-group">
        <kbd class="key" class:key-active={squash.keepEmptied}>e</kbd><span class="key-label" class:key-label-active={squash.keepEmptied}>keep-emptied</span>
        <kbd class="key" class:key-active={squash.ignoreImmutable}>x</kbd><span class="key-label" class:key-label-active={squash.ignoreImmutable}>ignore-immutable</span>
      </span>
      {#if squashFileCount}
        <span class="key-divider"></span>
        <span class="key-group">
          <span class="file-count" class:file-count-empty={squashFileCount.selected === 0}>{squashFileCount.selected}/{squashFileCount.total} files to move</span>
        </span>
      {/if}
    </div>
  {:else if rebase.active}
    <div class="statusbar-left">
      <span class="mode-badge">rebase</span>
      <span class="key-group">
        <kbd class="key action-key">Enter</kbd><span class="key-label">apply</span>
        <kbd class="key action-key">Esc</kbd><span class="key-label">cancel</span>
      </span>
      <span class="key-divider"></span>
      <span class="key-group">
        {#each sourceKeys as sk}
          <kbd class="key" class:key-active={rebase.sourceMode === sk.flag}>{sk.key}</kbd><span class="key-label" class:key-label-active={rebase.sourceMode === sk.flag}>{sk.label}</span>
        {/each}
      </span>
      <span class="key-divider"></span>
      <span class="key-group">
        {#each targetKeys as tk}
          <kbd class="key" class:key-active={rebase.targetMode === tk.flag}>{tk.key}</kbd><span class="key-label" class:key-label-active={rebase.targetMode === tk.flag}>{tk.label}</span>
        {/each}
      </span>
      <span class="key-divider"></span>
      <span class="key-group">
        <kbd class="key" class:key-active={rebase.skipEmptied}>e</kbd><span class="key-label" class:key-label-active={rebase.skipEmptied}>skip-emptied</span>
        <kbd class="key" class:key-active={rebase.ignoreImmutable}>x</kbd><span class="key-label" class:key-label-active={rebase.ignoreImmutable}>ignore-immutable</span>
      </span>
    </div>
  {:else}
    <div class="statusbar-left">
      {#if statusText}
        <span class="status-item">{statusText}</span>
      {:else if activeView === 'log'}
        <span class="key-hints">
          <kbd>j</kbd>/<kbd>k</kbd> navigate
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
    font-size: 11px;
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

  .statusbar-left {
    display: flex;
    align-items: center;
    gap: 12px;
  }

  /* --- Rebase mode --- */
  .mode-badge {
    background: var(--amber);
    color: var(--crust);
    font-weight: 800;
    font-size: 10px;
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
    font-size: 10px;
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
    font-size: 10px;
    margin-right: 4px;
  }

  .key-label.key-label-active {
    color: var(--text);
    font-weight: 600;
  }


  .file-count {
    color: var(--subtext0);
    font-size: 10px;
  }

  .file-count-empty {
    color: var(--red);
    font-weight: 600;
  }

  .key-hints {
    display: flex;
    align-items: center;
    gap: 4px;
    color: var(--surface2);
    font-size: 10px;
  }

  .key-hints kbd {
    font-family: inherit;
    font-size: 10px;
    color: var(--subtext0);
    background: var(--surface0);
    padding: 0 3px;
    border-radius: 2px;
    border: none;
  }
</style>
