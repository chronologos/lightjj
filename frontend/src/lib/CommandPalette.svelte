<script lang="ts">
  import { fuzzyMatch } from './fuzzy'

  export interface PaletteCommand {
    label: string
    shortcut?: string
    action: () => void
    when?: () => boolean
  }

  interface Props {
    commands: PaletteCommand[]
    open: boolean
  }

  let { commands, open = $bindable(false) }: Props = $props()

  let query: string = $state('')
  let index: number = $state(0)
  let inputEl: HTMLInputElement | undefined = $state(undefined)

  let filteredCommands = $derived.by(() => {
    if (!open) return []
    const available = commands.filter(c => !c.when || c.when())
    if (!query) return available
    return available.filter(c => fuzzyMatch(query, c.label))
  })

  // Focus input when palette opens
  $effect(() => {
    if (open) {
      query = ''
      index = 0
      requestAnimationFrame(() => inputEl?.focus())
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
  <div class="palette">
    <input
      bind:this={inputEl}
      bind:value={query}
      class="palette-input"
      type="text"
      placeholder="Type a command..."
      onkeydown={handleKeydown}
      oninput={() => { index = 0 }}
    />
    <div class="palette-results">
      {#each filteredCommands as cmd, i}
        <button
          class="palette-item"
          class:palette-item-active={i === index}
          onclick={() => execute(cmd)}
          onmouseenter={() => { index = i }}
        >
          <span class="palette-label">{cmd.label}</span>
          {#if cmd.shortcut}
            <kbd class="palette-shortcut">{cmd.shortcut}</kbd>
          {/if}
        </button>
      {:else}
        <div class="palette-empty">No matching commands</div>
      {/each}
    </div>
  </div>
{/if}

<style>
  .palette-backdrop {
    position: fixed;
    inset: 0;
    background: #00000066;
    z-index: 100;
  }

  .palette {
    position: fixed;
    top: 20%;
    left: 50%;
    transform: translateX(-50%);
    width: 480px;
    max-height: 400px;
    background: var(--base);
    border: 1px solid var(--surface1);
    border-radius: 8px;
    box-shadow: 0 16px 48px #00000088;
    z-index: 101;
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }

  .palette-input {
    width: 100%;
    background: var(--mantle);
    color: var(--text);
    border: none;
    border-bottom: 1px solid var(--surface0);
    padding: 12px 16px;
    font-family: inherit;
    font-size: 14px;
    outline: none;
  }

  .palette-input::placeholder {
    color: var(--surface2);
  }

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
    background: var(--surface0);
  }

  .palette-label {
    flex: 1;
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

  .palette-empty {
    padding: 16px;
    color: var(--surface2);
    text-align: center;
    font-size: 13px;
  }
</style>
