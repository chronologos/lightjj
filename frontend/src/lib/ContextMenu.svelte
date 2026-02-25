<script lang="ts">
  import { tick } from 'svelte'

  export interface ContextMenuItem {
    label?: string
    action?: () => void
    danger?: boolean
    disabled?: boolean
    separator?: boolean
    shortcut?: string
  }

  interface Props {
    items: ContextMenuItem[]
    x: number
    y: number
    open: boolean
  }

  let { items, x, y, open = $bindable(false) }: Props = $props()

  let activeIndex: number = $state(-1)
  let menuEl: HTMLDivElement | undefined = $state(undefined)
  let adjustedX: number = $state(0)
  let adjustedY: number = $state(0)
  let flippedX: boolean = $state(false)
  let flippedY: boolean = $state(false)
  let previouslyFocused: HTMLElement | null = null

  let navigableIndices = $derived(
    items.reduce<number[]>((acc, item, i) => {
      if (!item.separator && !item.disabled) acc.push(i)
      return acc
    }, [])
  )

  function close() {
    open = false
    previouslyFocused?.focus()
    previouslyFocused = null
  }

  function select(item: ContextMenuItem) {
    if (item.disabled || item.separator || !item.action) return
    close()
    item.action()
  }

  const EDGE_MARGIN = 8

  // Focus menu and compute position when opened
  $effect(() => {
    if (!open) return
    previouslyFocused = document.activeElement as HTMLElement
    activeIndex = -1
    adjustedX = x
    adjustedY = y
    flippedX = false
    flippedY = false

    tick().then(() => {
      if (!menuEl) return
      menuEl.focus()

      const rect = menuEl.getBoundingClientRect()
      const vw = window.innerWidth
      const vh = window.innerHeight

      if (x + rect.width > vw - EDGE_MARGIN) {
        adjustedX = Math.max(EDGE_MARGIN, x - rect.width)
        flippedX = true
      }
      if (y + rect.height > vh - EDGE_MARGIN) {
        adjustedY = Math.max(EDGE_MARGIN, y - rect.height)
        flippedY = true
      }
    })
  })

  function nextNavigable(current: number, direction: 1 | -1): number {
    const len = navigableIndices.length
    if (len === 0) return -1
    const curPos = navigableIndices.indexOf(current)
    if (curPos === -1) {
      return direction === 1 ? navigableIndices[0] : navigableIndices.at(-1)!
    }
    return navigableIndices[((curPos + direction) % len + len) % len]
  }

  function handleKeydown(e: KeyboardEvent) {
    // Stop all keys from bubbling to window handler while menu is open
    e.stopPropagation()
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault()
        activeIndex = nextNavigable(activeIndex, 1)
        break
      case 'ArrowUp':
        e.preventDefault()
        activeIndex = nextNavigable(activeIndex, -1)
        break
      case 'Enter':
        e.preventDefault()
        if (activeIndex >= 0 && items[activeIndex]) {
          select(items[activeIndex])
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
  <div class="ctx-backdrop" onclick={close} oncontextmenu={(e) => { e.preventDefault(); close() }} role="presentation"></div>
  <div
    class="ctx-menu"
    bind:this={menuEl}
    tabindex="-1"
    role="menu"
    aria-label="Context menu"
    style:left="{adjustedX}px"
    style:top="{adjustedY}px"
    style:transform-origin="{flippedY ? 'bottom' : 'top'} {flippedX ? 'right' : 'left'}"
    onkeydown={handleKeydown}
  >
    {#each items as item, i (i)}
      {#if item.separator}
        <div class="ctx-separator" role="separator"></div>
      {:else}
        <button
          class="ctx-item"
          class:ctx-item-active={i === activeIndex}
          class:ctx-item-danger={item.danger}
          class:ctx-item-disabled={item.disabled}
          role="menuitem"
          disabled={item.disabled}
          onclick={() => select(item)}
          onmouseenter={() => { if (!item.disabled) activeIndex = i }}
          onmouseleave={() => { activeIndex = -1 }}
        >
          <span class="ctx-label">{item.label ?? ''}</span>
          {#if item.shortcut}
            <kbd class="ctx-shortcut">{item.shortcut}</kbd>
          {/if}
        </button>
      {/if}
    {/each}
  </div>
{/if}

<style>
  .ctx-backdrop {
    position: fixed;
    inset: 0;
    z-index: 199;
  }

  @keyframes ctx-enter {
    from {
      opacity: 0;
      transform: scale(0.96);
    }
    to {
      opacity: 1;
      transform: scale(1);
    }
  }

  .ctx-menu {
    position: fixed;
    min-width: 200px;
    max-height: calc(100vh - 16px);
    overflow-y: auto;
    background: var(--base);
    border: 1px solid var(--surface1);
    border-radius: 8px;
    box-shadow: var(--shadow-heavy), 0 0 0 1px rgba(255,255,255,0.03);
    z-index: 200;
    padding: 4px;
    outline: none;
    animation: ctx-enter 0.12s ease-out;
  }

  .ctx-item {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 24px;
    width: 100%;
    padding: 6px 10px 6px 24px;
    background: transparent;
    border: none;
    border-radius: 5px;
    color: var(--text);
    font-family: inherit;
    font-size: 13px;
    cursor: pointer;
    text-align: left;
    transition: background 0.08s ease;
  }

  .ctx-item:hover:not(.ctx-item-disabled),
  .ctx-item-active:not(.ctx-item-disabled) {
    background: var(--bg-selected);
  }

  .ctx-label {
    flex: 1;
    white-space: nowrap;
  }

  .ctx-shortcut {
    font-family: inherit;
    font-size: 11px;
    color: var(--surface2);
    background: var(--surface0);
    border: 1px solid var(--surface1);
    padding: 1px 5px;
    border-radius: 3px;
    flex-shrink: 0;
    line-height: 1.4;
  }

  .ctx-item-active:not(.ctx-item-disabled) .ctx-shortcut {
    background: var(--surface1);
  }

  .ctx-item-danger {
    color: var(--red);
  }

  .ctx-item-danger:hover:not(.ctx-item-disabled),
  .ctx-item-danger.ctx-item-active:not(.ctx-item-disabled) {
    background: var(--bg-error);
  }

  .ctx-item-disabled {
    opacity: 0.4;
    cursor: default;
  }

  .ctx-separator {
    height: 0;
    border-top: 1px solid var(--surface0);
    margin: 4px 10px;
  }
</style>
