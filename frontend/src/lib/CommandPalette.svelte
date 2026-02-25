<script lang="ts">
  import { fuzzyMatch } from './fuzzy'

  export interface PaletteCommand {
    label: string
    shortcut?: string
    hint?: string
    category?: string
    action: () => void
    when?: () => boolean
    infoOnly?: boolean
  }

  interface Props {
    commands: PaletteCommand[]
    open: boolean
  }

  let { commands, open = $bindable(false) }: Props = $props()

  let query: string = $state('')
  let index: number = $state(0)
  let inputEl: HTMLInputElement | undefined = $state(undefined)

  let availableCommands = $derived.by(() => {
    if (!open) return []
    return commands.filter(c => !c.when || c.when())
  })

  let filteredCommands = $derived.by(() => {
    if (!query) return availableCommands
    return availableCommands.filter(c => fuzzyMatch(query, c.label) || (c.hint && fuzzyMatch(query, c.hint)))
  })

  let groupedCommands = $derived.by(() => {
    if (query) return []
    const groups = Map.groupBy(
      availableCommands.filter(c => c.shortcut),
      c => c.category ?? 'Other'
    )
    return [...groups.entries()]
  })

  let isCheatsheet = $derived(groupedCommands.length > 0)

  let searchOnlyCount = $derived.by(() => {
    if (!isCheatsheet) return 0
    return availableCommands.filter(c => !c.shortcut).length
  })

  // Focus input when palette opens
  $effect(() => {
    if (open) {
      query = ''
      index = 0
      inputEl?.focus()
    }
  })

  function close() {
    open = false
    query = ''
  }

  function execute(cmd: PaletteCommand) {
    close()
    cmd.action()
  }

  function scrollActiveIntoView() {
    requestAnimationFrame(() => {
      const el = document.querySelector('.palette-item-active')
      el?.scrollIntoView({ block: 'nearest' })
    })
  }

  function handleKeydown(e: KeyboardEvent) {
    if (isCheatsheet) {
      // In cheatsheet mode, only handle Escape
      if (e.key === 'Escape') {
        e.preventDefault()
        close()
      }
      return
    }
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault()
        index = Math.min(index + 1, filteredCommands.length - 1)
        scrollActiveIntoView()
        break
      case 'ArrowUp':
        e.preventDefault()
        index = Math.max(index - 1, 0)
        scrollActiveIntoView()
        break
      case 'Enter':
        e.preventDefault()
        if (filteredCommands[index]) {
          execute(filteredCommands[index])
        }
        break
      case 'Escape':
        e.preventDefault()
        close()
        break
    }
  }
</script>

{#if open}
  <div class="palette-backdrop" onclick={close} role="presentation"></div>
  <div class="palette" class:palette-wide={isCheatsheet} role="dialog" aria-modal="true" aria-label="Command palette">
    <div class="palette-input-wrap">
      <span class="palette-arrow">▸</span>
      <input
        bind:this={inputEl}
        bind:value={query}
        class="palette-input"
        type="text"
        placeholder={isCheatsheet ? 'Filter commands...' : 'Type a command...'}
        onkeydown={handleKeydown}
        oninput={() => { index = 0 }}
      />
      <kbd class="palette-esc">esc</kbd>
    </div>
    {#if isCheatsheet}
      <div class="cheatsheet">
        {#each groupedCommands as [category, cmds]}
          <div class="cheatsheet-group">
            <div class="cheatsheet-header">{category}</div>
            {#each cmds as cmd}
              {#if cmd.infoOnly}
                <div class="cheatsheet-item cheatsheet-item-info">
                  <kbd class="cheatsheet-key">{cmd.shortcut}</kbd>
                  <span class="cheatsheet-label">{cmd.label}</span>
                  {#if cmd.hint}<span class="palette-hint">{cmd.hint}</span>{/if}
                </div>
              {:else}
                <button class="cheatsheet-item" onclick={() => execute(cmd)}>
                  <kbd class="cheatsheet-key">{cmd.shortcut}</kbd>
                  <span class="cheatsheet-label">{cmd.label}</span>
                  {#if cmd.hint}<span class="palette-hint">{cmd.hint}</span>{/if}
                </button>
              {/if}
            {/each}
          </div>
        {/each}
        {#if searchOnlyCount > 0}
          <div class="cheatsheet-hint">{searchOnlyCount} more — type to search</div>
        {/if}
      </div>
    {:else}
      <div class="palette-results">
        {#each filteredCommands as cmd, i}
          <button
            class="palette-item"
            class:palette-item-active={i === index}
            onclick={() => execute(cmd)}
            onmouseenter={() => { index = i }}
          >
            <span class="palette-label">
              {cmd.label}
              {#if cmd.hint}<span class="palette-badge">alias</span>{/if}
            </span>
            {#if cmd.hint}<span class="palette-hint" title={cmd.hint}>{cmd.hint}</span>{/if}
            {#if cmd.shortcut}
              <kbd class="palette-shortcut">{cmd.shortcut}</kbd>
            {/if}
          </button>
        {:else}
          <div class="palette-empty">No matching commands</div>
        {/each}
      </div>
    {/if}
  </div>
{/if}

<style>
  .palette-backdrop {
    position: fixed;
    inset: 0;
    background: var(--backdrop);
    backdrop-filter: blur(4px);
    -webkit-backdrop-filter: blur(4px);
    z-index: 100;
  }

  .palette {
    position: fixed;
    top: 20%;
    left: 50%;
    transform: translateX(-50%);
    width: 520px;
    max-height: 400px;
    background: var(--base);
    border: 1px solid var(--surface1);
    border-radius: 14px;
    box-shadow: var(--shadow-heavy);
    z-index: 101;
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }

  .palette-wide {
    width: min(90vw, 720px);
    max-height: 70vh;
  }

  .palette-input-wrap {
    display: flex;
    align-items: center;
    gap: 8px;
    background: var(--mantle);
    border-bottom: 1px solid var(--surface0);
    padding: 12px 16px;
  }

  .palette-arrow {
    color: var(--amber);
    font-size: 14px;
    flex-shrink: 0;
  }

  .palette-input {
    flex: 1;
    background: transparent;
    color: var(--text);
    border: none;
    padding: 0;
    font-family: inherit;
    font-size: 14px;
    outline: none;
  }

  .palette-input::placeholder {
    color: var(--surface2);
  }

  .palette-esc {
    font-family: inherit;
    font-size: 10px;
    color: var(--surface2);
    background: var(--surface0);
    border: 1px solid var(--surface1);
    padding: 1px 5px;
    border-radius: 3px;
    flex-shrink: 0;
  }

  /* --- Cheatsheet grid --- */
  .cheatsheet {
    overflow-y: auto;
    padding: 12px 16px;
    columns: 3;
    column-gap: 16px;
  }

  @media (max-width: 600px) {
    .cheatsheet {
      columns: 2;
    }
  }

  .cheatsheet-group {
    break-inside: avoid;
    margin-bottom: 12px;
  }

  .cheatsheet-header {
    color: var(--green);
    font-size: 11px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    padding: 0 4px 4px;
    border-bottom: 1px solid var(--surface0);
    margin-bottom: 2px;
  }

  .cheatsheet-item {
    display: flex;
    align-items: center;
    gap: 8px;
    width: 100%;
    padding: 3px 4px;
    background: transparent;
    border: none;
    color: var(--text);
    font-family: inherit;
    font-size: 12px;
    cursor: pointer;
    text-align: left;
    border-radius: 3px;
  }

  .cheatsheet-item:not(.cheatsheet-item-info):hover {
    background: var(--surface0);
  }

  .cheatsheet-item-info {
    cursor: default;
  }

  .cheatsheet-key {
    color: var(--amber);
    min-width: 36px;
    font-family: inherit;
    font-size: 11px;
    background: none;
    border: none;
    padding: 0;
  }

  .cheatsheet-label {
    color: var(--subtext0);
    font-size: 12px;
  }

  .cheatsheet-hint {
    column-span: all;
    text-align: center;
    color: var(--surface2);
    font-size: 11px;
    padding: 8px 0 4px;
  }

  /* --- Filtered list (existing) --- */
  .palette-results {
    overflow-y: auto;
    padding: 4px 0;
  }

  .palette-item {
    display: flex;
    align-items: center;
    justify-content: space-between;
    width: 100%;
    padding: 8px 16px;
    background: transparent;
    border: none;
    color: var(--text);
    font-family: inherit;
    font-size: 13px;
    cursor: pointer;
    text-align: left;
  }

  .palette-item-active {
    background: var(--bg-selected);
  }

  .palette-label {
    flex-shrink: 0;
    white-space: nowrap;
  }

  .palette-shortcut {
    background: var(--surface0);
    color: var(--subtext0);
    padding: 1px 6px;
    border-radius: 3px;
    font-size: 11px;
    font-family: inherit;
    border: 1px solid var(--surface1);
    margin-left: 12px;
  }

  .palette-item-active .palette-shortcut {
    background: var(--surface1);
  }

  .palette-badge {
    font-size: 9px;
    font-weight: 500;
    letter-spacing: 0.02em;
    color: var(--purple);
    background: rgba(171, 71, 188, 0.1);
    border: 1px solid rgba(171, 71, 188, 0.2);
    padding: 0 4px;
    border-radius: 3px;
    margin-left: 6px;
    vertical-align: 1px;
  }

  .palette-hint {
    color: var(--surface2);
    font-family: var(--font-mono);
    font-size: 11px;
    margin-left: auto;
    padding-left: 12px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    min-width: 0;
    flex-shrink: 1;
  }

  .palette-empty {
    padding: 16px;
    color: var(--surface2);
    text-align: center;
    font-size: 13px;
  }
</style>
