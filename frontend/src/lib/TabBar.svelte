<script lang="ts">
  import type { TabInfo } from './api'

  let {
    tabs,
    activeId,
    onswitch,
    onopen,
    onclose,
  }: {
    tabs: TabInfo[]
    activeId: string
    onswitch: (id: string) => void
    onopen: (path: string) => void
    onclose: (id: string) => void
  } = $props()

  let opening = $state(false)
  let pathInput = $state('')
  let inputEl: HTMLInputElement | undefined = $state()

  function startOpen() {
    opening = true
    pathInput = ''
    queueMicrotask(() => inputEl?.focus())
  }

  function submit() {
    const p = pathInput.trim()
    if (!p) return
    onopen(p)
    opening = false
  }

  function handleKey(e: KeyboardEvent) {
    if (e.key === 'Enter') { e.preventDefault(); submit() }
    else if (e.key === 'Escape') { e.preventDefault(); opening = false }
  }
</script>

<div class="tab-bar">
  {#each tabs as tab (tab.id)}
    <button
      class="tab"
      class:active={tab.id === activeId}
      onclick={() => { if (tab.id !== activeId) onswitch(tab.id) }}
      title={tab.path}
    >
      <span class="tab-name">{tab.name}</span>
      {#if tabs.length > 1}
        <span
          class="tab-close"
          role="button"
          tabindex="-1"
          onclick={(e) => { e.stopPropagation(); onclose(tab.id) }}
          onkeydown={(e) => { if (e.key === 'Enter') { e.stopPropagation(); onclose(tab.id) } }}
        >×</span>
      {/if}
    </button>
  {/each}
  {#if opening}
    <input
      bind:this={inputEl}
      bind:value={pathInput}
      class="tab-path-input"
      placeholder="/path/to/repo  or  ~/repo"
      onkeydown={handleKey}
      onblur={() => { opening = false }}
    />
  {:else}
    <button class="tab-new" onclick={startOpen} title="Open repository">+</button>
  {/if}
</div>

<style>
  .tab-bar {
    display: flex;
    align-items: center;
    gap: 1px;
    background: var(--surface0);
    border-bottom: 1px solid var(--surface1);
    padding: 0 4px;
    height: 28px;
    flex-shrink: 0;
    user-select: none;
  }

  .tab {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 0 10px;
    height: 24px;
    background: transparent;
    border: none;
    border-radius: 4px 4px 0 0;
    color: var(--text-muted);
    font: inherit;
    font-size: 12px;
    cursor: pointer;
    max-width: 180px;
  }

  .tab:hover:not(.active) {
    background: var(--surface1);
  }

  .tab.active {
    background: var(--surface1);
    color: var(--text);
  }

  .tab-name {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .tab-close {
    opacity: 0.5;
    font-size: 14px;
    line-height: 1;
    padding: 0 2px;
    border-radius: 2px;
  }

  .tab-close:hover {
    opacity: 1;
    background: var(--surface2);
  }

  .tab-new {
    width: 24px;
    height: 24px;
    padding: 0;
    background: transparent;
    border: none;
    color: var(--text-muted);
    font: inherit;
    font-size: 16px;
    line-height: 1;
    cursor: pointer;
    border-radius: 4px;
  }

  .tab-new:hover {
    background: var(--surface1);
    color: var(--text);
  }

  .tab-path-input {
    height: 20px;
    padding: 0 8px;
    background: var(--surface1);
    border: 1px solid var(--surface2);
    border-radius: 3px;
    color: var(--text);
    font: inherit;
    font-size: 12px;
    width: 280px;
  }

  .tab-path-input:focus {
    outline: none;
    border-color: var(--accent);
  }
</style>
