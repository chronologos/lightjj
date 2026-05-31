<script lang="ts">
  import { fuzzyMatch } from './fuzzy'
  import { createListCursor } from './list-cursor.svelte'

  export interface PaletteCommand {
    label: string
    shortcut?: string
    hint?: string
    category?: string
    action?: () => void
    when?: () => boolean
    infoOnly?: boolean
    // Show in the empty-query cheatsheet even without a shortcut (otherwise search-only)
    showInCheatsheet?: boolean
    /** Submenu — selecting drills in (breadcrumb shows label, Esc goes back).
     *  Isolates large option sets (themes, aliases) from the root list. */
    children?: PaletteCommand[]
    /** 3-4 hex colors rendered as a chip strip — visual-first picking for
     *  theme/color submenus without clicking through. */
    swatch?: readonly string[]
  }

  interface Props {
    commands: PaletteCommand[]
    open: boolean
  }

  let { commands, open = $bindable(false) }: Props = $props()

  let query: string = $state('')
  let inputEl: HTMLInputElement | undefined = $state(undefined)
  let resultsEl: HTMLElement | undefined = $state(undefined)
  // Label of the drilled-into command (stable key — the cmd OBJECT is fresh
  // each `commands` recompute, so storing the object would freeze children at
  // the value at drill-in time and miss lazy-loaded additions).
  let submenuLabel = $state<string | null>(null)
  let submenu = $derived(submenuLabel ? commands.find(c => c.label === submenuLabel) : null)

  let availableCommands = $derived.by(() => {
    if (!open) return []
    const src = submenu?.children ?? commands
    return src.filter(c => !c.when || c.when())
  })

  let filteredCommands = $derived.by(() => {
    if (!query) return availableCommands
    return availableCommands.filter(c => fuzzyMatch(query, c.label) || (c.hint && fuzzyMatch(query, c.hint)))
  })

  const inCheatsheet = (c: PaletteCommand) => !!c.shortcut || !!c.showInCheatsheet

  let groupedCommands = $derived.by(() => {
    if (query) return []
    const groups = Map.groupBy(
      availableCommands.filter(inCheatsheet),
      c => c.category ?? 'Other'
    )
    return [...groups.entries()]
  })

  let isCheatsheet = $derived(groupedCommands.length > 0)

  let searchOnlyCount = $derived.by(() => {
    if (!isCheatsheet) return 0
    return availableCommands.filter(c => !inCheatsheet(c)).length
  })

  // Cursor/hover/keydown core via the shared factory. The palette is
  // typing-first — the input always holds focus, so inputFocused: () => true
  // makes j/k fall through (they type into the query) while ArrowUp/ArrowDown
  // still navigate the list.
  const cursor = createListCursor({
    count: () => filteredCommands.length,
    container: () => resultsEl,
    inputFocused: () => true,
    onEnter: () => {
      if (filteredCommands[cursor.index]) {
        execute(filteredCommands[cursor.index])
      }
    },
    onEscape: () => {
      if (submenuLabel) { submenuLabel = null; query = ''; cursor.index = 0 }
      else close()
    },
    hoverMovesCursor: true,
  })

  // Focus input when palette opens
  $effect(() => {
    if (open) {
      query = ''
      cursor.index = 0
      submenuLabel = null
      inputEl?.focus()
    }
  })

  function close() {
    open = false
    query = ''
    submenuLabel = null
  }

  function execute(cmd: PaletteCommand) {
    if (cmd.children) {
      cmd.action?.()  // optional side-effect (e.g. kick a lazy load)
      submenuLabel = cmd.label
      query = ''
      cursor.index = 0
      inputEl?.focus()
      return
    }
    close()
    cmd.action?.()
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
    cursor.handleKey(e)
  }
</script>

{#if open}
  <div class="palette-backdrop" onclick={close} role="presentation"></div>
  <div class="palette" class:palette-wide={isCheatsheet} role="dialog" aria-modal="true" aria-label="Command palette">
    <div class="palette-input-wrap">
      {#if submenu}
        <button class="palette-crumb" onclick={() => { submenuLabel = null; query = ''; cursor.index = 0; inputEl?.focus() }} title="Back (Esc)">
          {submenu.label} ›
        </button>
      {:else}
        <span class="palette-arrow">▸</span>
      {/if}
      <input
        bind:this={inputEl}
        bind:value={query}
        class="palette-input"
        type="text"
        placeholder={isCheatsheet ? 'Filter commands...' : 'Type a command...'}
        onkeydown={handleKeydown}
        oninput={() => { cursor.index = 0 }}
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
                  {#if cmd.shortcut}
                    <kbd class="cheatsheet-key">{cmd.shortcut}</kbd>
                  {:else}
                    <span class="cheatsheet-key-placeholder"></span>
                  {/if}
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
      <!-- Hover moves the cursor via the factory's delegated mousemove. -->
      <!-- svelte-ignore a11y_no_static_element_interactions -- container only
           delegates hover tracking; the buttons inside are the interactive bits -->
      <div
        class="palette-results"
        bind:this={resultsEl}
        onmousemove={cursor.onRowsMouseMove}
        onmouseleave={cursor.onRowsMouseLeave}
      >
        {#each filteredCommands as cmd, i}
          <button
            class="palette-item"
            class:palette-item-active={i === cursor.index}
            data-idx={i}
            onclick={() => execute(cmd)}
          >
            {#if cmd.swatch}
              <span class="palette-swatch">
                {#each cmd.swatch as c}<span style:background={c}></span>{/each}
              </span>
            {/if}
            <span class="palette-label">
              {cmd.label}
              {#if cmd.children}<span class="palette-submenu-arrow">›</span>{/if}
              {#if cmd.category === 'Aliases'}<span class="palette-badge">alias</span>{/if}
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
    width: 580px;
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
    font-size: var(--fs-lg);
    flex-shrink: 0;
  }

  .palette-input {
    flex: 1;
    background: transparent;
    color: var(--text);
    border: none;
    padding: 0;
    font-family: inherit;
    font-size: var(--fs-lg);
    outline: none;
  }

  .palette-input::placeholder {
    color: var(--text-faint);
  }

  .palette-esc {
    font-family: inherit;
    font-size: var(--fs-xs);
    color: var(--text-faint);
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
    font-size: var(--fs-sm);
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
    font-size: var(--fs-md);
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

  .cheatsheet-key,
  .cheatsheet-key-placeholder {
    color: var(--amber);
    min-width: 36px;
    font-family: inherit;
    font-size: var(--fs-sm);
    background: none;
    border: none;
    padding: 0;
  }

  .cheatsheet-label {
    color: var(--subtext0);
    font-size: var(--fs-md);
  }

  .cheatsheet-hint {
    column-span: all;
    text-align: center;
    color: var(--text-faint);
    font-size: var(--fs-sm);
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
    font-size: var(--font-size);
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
    font-size: var(--fs-sm);
    font-family: inherit;
    border: 1px solid var(--surface1);
    margin-left: 12px;
  }

  .palette-item-active .palette-shortcut {
    background: var(--surface1);
  }

  .palette-badge {
    font-size: var(--fs-2xs);
    font-weight: 500;
    letter-spacing: 0.02em;
    color: var(--overlay0);
    background: var(--surface0);
    border: 1px solid var(--surface1);
    padding: 0 4px;
    border-radius: 3px;
    margin-left: 6px;
    vertical-align: 1px;
  }


  .palette-crumb {
    background: transparent;
    border: none;
    color: var(--amber);
    font-family: inherit;
    font-size: var(--fs-md);
    font-weight: 600;
    padding: 0 4px 0 0;
    cursor: pointer;
    white-space: nowrap;
  }
  .palette-crumb:hover { text-decoration: underline; }
  .palette-submenu-arrow {
    margin-left: 6px;
    color: var(--overlay0);
  }
  .palette-swatch {
    display: inline-flex;
    margin-right: 8px;
    border-radius: 3px;
    overflow: hidden;
    border: 1px solid var(--surface2);
  }
  .palette-swatch span {
    width: 12px;
    height: 12px;
  }
  .palette-hint {
    color: var(--text-faint);
    font-family: var(--font-mono);
    font-size: var(--fs-sm);
    margin-left: auto;
    padding-left: 12px;
    overflow: hidden;
    min-width: 0;
    flex-shrink: 1;
    /* 2-line clamp so alias bodies (the only hints that get long) show enough
       to disambiguate. -webkit-line-clamp is cross-browser despite the prefix.
       text-align keeps the ragged edge against the label, not the kbd. */
    display: -webkit-box;
    -webkit-line-clamp: 2;
    -webkit-box-orient: vertical;
    line-height: 1.3;
    text-align: right;
    word-break: break-word;
  }

  .palette-empty {
    padding: 16px;
    color: var(--text-faint);
    text-align: center;
    font-size: var(--font-size);
  }
</style>
