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
      <span class="tab-glyph">▪</span>
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
      placeholder="~/path/to/repo"
      spellcheck="false"
      onkeydown={handleKey}
      onblur={() => { opening = false }}
    />
  {:else}
    <button class="tab-new" onclick={startOpen} title="Open repository">+</button>
  {/if}
</div>

<style>
  /* Sits between toolbar (--crust) and workspace (--base). --mantle would be
     the natural in-between but mantle==base in this theme, so use --base +
     a bottom border to read as "content-adjacent". */
  .tab-bar {
    display: flex;
    align-items: stretch;
    background: var(--base);
    border-bottom: 1px solid var(--surface1);
    padding-left: 10px;
    height: 26px;
    flex-shrink: 0;
    user-select: none;
    font-family: var(--font-mono);
    font-size: 11px;
  }

  .tab {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 0 10px;
    background: transparent;
    border: none;
    /* Active-tab indicator is a bottom border, not a background — matches the
       amber accent on .toolbar-nav-active without competing with it (nav uses
       text color, tabs use underline; both amber, different channels). */
    border-bottom: 2px solid transparent;
    margin-bottom: -1px; /* overlap the bar's border so the accent sits ON it */
    color: var(--subtext0);
    font: inherit;
    cursor: pointer;
    max-width: 200px;
  }

  .tab:hover:not(.active) {
    background: var(--bg-hover);
    color: var(--text);
  }

  .tab.active {
    color: var(--text);
    border-bottom-color: var(--amber);
  }

  .tab-glyph {
    font-size: 8px;
    opacity: 0.5;
  }
  .tab.active .tab-glyph {
    color: var(--amber);
    opacity: 1;
  }

  .tab-name {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .tab-close {
    opacity: 0;
    font-size: 13px;
    line-height: 1;
    padding: 0 2px;
    border-radius: 3px;
    margin-right: -4px;
    transition: opacity var(--anim-duration) var(--anim-ease);
  }
  .tab:hover .tab-close,
  .tab.active .tab-close {
    opacity: 0.5;
  }
  .tab-close:hover {
    opacity: 1;
    background: var(--surface1);
  }

  .tab-new {
    width: 26px;
    padding: 0;
    background: transparent;
    border: none;
    color: var(--surface2);
    font: inherit;
    font-size: 14px;
    line-height: 1;
    cursor: pointer;
  }
  .tab-new:hover {
    background: var(--bg-hover);
    color: var(--text);
  }

  .tab-path-input {
    align-self: center;
    height: 18px;
    margin-left: 4px;
    padding: 0 8px;
    background: var(--surface0);
    border: 1px solid var(--surface1);
    border-radius: 3px;
    color: var(--text);
    font: inherit;
    width: 260px;
  }
  .tab-path-input:focus {
    outline: none;
    border-color: var(--amber);
  }
  .tab-path-input::placeholder {
    color: var(--surface2);
  }
</style>
