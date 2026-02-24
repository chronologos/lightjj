<script lang="ts">
  interface Props {
    statusText: string
    commandOutput: string
    rebaseMode: boolean
    rebaseSourceMode: string
    rebaseTargetMode: string
    squashMode: boolean
    squashKeepEmptied: boolean
    squashUseDestMsg: boolean
    squashFileCount: { selected: number, total: number } | null
  }

  let { statusText, commandOutput, rebaseMode, rebaseSourceMode, rebaseTargetMode, squashMode, squashKeepEmptied, squashUseDestMsg, squashFileCount }: Props = $props()

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

<footer class="statusbar" class:rebase-active={rebaseMode} class:squash-active={squashMode}>
  {#if squashMode}
    <div class="statusbar-left">
      <span class="mode-badge mode-badge-squash">squash</span>
      <span class="key-group">
        <kbd class="key action-key">Enter</kbd><span class="key-label">apply</span>
        <kbd class="key action-key">Esc</kbd><span class="key-label">cancel</span>
      </span>
      <span class="key-divider"></span>
      <span class="key-group">
        <kbd class="key" class:key-active={squashKeepEmptied}>e</kbd><span class="key-label" class:key-label-active={squashKeepEmptied}>keep-emptied</span>
        <kbd class="key" class:key-active={squashUseDestMsg}>d</kbd><span class="key-label" class:key-label-active={squashUseDestMsg}>use-dest-message</span>
      </span>
      {#if squashFileCount}
        <span class="key-divider"></span>
        <span class="key-group">
          <span class="file-count" class:file-count-empty={squashFileCount.selected === 0}>{squashFileCount.selected}/{squashFileCount.total} files</span>
        </span>
      {/if}
    </div>
  {:else if rebaseMode}
    <div class="statusbar-left">
      <span class="mode-badge">rebase</span>
      <span class="key-group">
        <kbd class="key action-key">Enter</kbd><span class="key-label">apply</span>
        <kbd class="key action-key">Esc</kbd><span class="key-label">cancel</span>
      </span>
      <span class="key-divider"></span>
      <span class="key-group">
        {#each sourceKeys as sk}
          <kbd class="key" class:key-active={rebaseSourceMode === sk.flag}>{sk.key}</kbd><span class="key-label" class:key-label-active={rebaseSourceMode === sk.flag}>{sk.label}</span>
        {/each}
      </span>
      <span class="key-divider"></span>
      <span class="key-group">
        {#each targetKeys as tk}
          <kbd class="key" class:key-active={rebaseTargetMode === tk.flag}>{tk.key}</kbd><span class="key-label" class:key-label-active={rebaseTargetMode === tk.flag}>{tk.label}</span>
        {/each}
      </span>
    </div>
  {:else}
    <div class="statusbar-left">
      <span class="status-item">{statusText}</span>
    </div>
    <div class="statusbar-right">
      {#if commandOutput}
        <span class="status-item output">{commandOutput.trim().split('\n').pop()}</span>
      {/if}
      <span class="status-item">lightjj</span>
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
  }

  .statusbar.rebase-active {
    background: var(--crust);
    border-top: 1px solid var(--yellow);
  }

  .statusbar.squash-active {
    background: var(--crust);
    border-top: 1px solid var(--green);
  }

  .statusbar-left,
  .statusbar-right {
    display: flex;
    align-items: center;
    gap: 12px;
  }

  .status-item.output {
    color: var(--subtext0);
    max-width: 500px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  /* --- Rebase mode --- */
  .mode-badge {
    background: var(--yellow);
    color: var(--crust);
    font-weight: 800;
    font-size: 10px;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    padding: 1px 7px;
    border-radius: 3px;
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
    background: var(--blue);
    color: var(--crust);
    border-color: var(--blue);
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

  .mode-badge-squash {
    background: var(--green);
  }

  .file-count {
    color: var(--subtext0);
    font-size: 10px;
  }

  .file-count-empty {
    color: var(--red);
    font-weight: 600;
  }
</style>
