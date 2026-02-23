<script lang="ts">
  interface Props {
    statusText: string
    commandOutput: string
  }

  let { statusText, commandOutput }: Props = $props()
</script>

<footer class="statusbar">
  <div class="statusbar-left">
    <span class="status-item">{statusText}</span>
  </div>
  <div class="statusbar-right">
    {#if commandOutput}
      <span class="status-item output">{commandOutput.trim().split('\n').pop()}</span>
    {/if}
    <span class="status-item">jj-web</span>
  </div>
</footer>

<style>
  .statusbar {
    display: flex;
    justify-content: space-between;
    align-items: center;
    height: 24px;
    padding: 0 10px;
    background: var(--mantle);
    border-top: 1px solid var(--surface0);
    flex-shrink: 0;
    user-select: none;
    font-size: 11px;
    color: var(--overlay0);
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
</style>
