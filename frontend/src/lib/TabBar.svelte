<script lang="ts">
  import type { TabInfo } from './api'
  import { basename } from './paths'

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
  let scrollEl: HTMLElement | undefined = $state()

  interface TabGroup {
    key: string
    label: string
    colorIdx: number
    stale: boolean
    tabs: TabInfo[]
  }

  // Stable non-negative hash → --graph-{0..7}. Collision-tolerant: color is a
  // hint, chip text is the identity. >>> 0 keeps it unsigned so % is positive.
  function colorFor(s: string): number {
    let h = 0
    for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0
    return h % 8
  }

  // Group tabs by repoRoot. Ungroupable (repoRoot="") key on their own path so
  // they render solo. Group order = first-seen in the tabs array (which is
  // backend-sorted by open order).
  let groups = $derived.by((): TabGroup[] => {
    const byKey = new Map<string, TabInfo[]>()
    const order: string[] = []
    for (const t of tabs) {
      const key = t.repoRoot || t.path
      if (!byKey.has(key)) { byKey.set(key, []); order.push(key) }
      byKey.get(key)!.push(t)
    }
    return order.map(key => {
      const ts = byKey.get(key)!
      return {
        key,
        label: basename(key),
        colorIdx: colorFor(key),
        stale: ts.some(t => t.stale),
        tabs: ts,
      }
    })
  })

  // Per-tab display label. See spec §Rendering: don't degrade the primary
  // workspace to "◇ default" — nobody names their primary, so 3 multi-ws repos
  // would show 3 tabs all reading "default".
  function tabLabel(g: TabGroup, t: TabInfo): string {
    if (g.tabs.length === 1) {
      // Solo tab: repo basename, plus workspace suffix if it's a secondary.
      const ws = t.wsName && t.wsName !== 'default' ? ` ◇ ${t.wsName}` : ''
      return g.label + ws
    }
    // Grouped: primary reads as the repo name; secondaries by workspace name.
    return !t.wsName || t.wsName === 'default' ? g.label : t.wsName
  }

  // Keep the active tab visible on switch AND on regroup (a refetch can move
  // it into an earlier group, shifting its offset). Tracks `groups` — the DOM
  // query itself isn't a reactive read. Direct scrollLeft math instead of
  // scrollIntoView so we don't scroll ancestor containers.
  $effect(() => {
    void activeId
    void groups
    const el = scrollEl?.querySelector<HTMLElement>('.tab.active')
    if (!el || !scrollEl) return
    const pad = 8
    const left = el.offsetLeft, right = left + el.offsetWidth
    const viewL = scrollEl.scrollLeft, viewR = viewL + scrollEl.clientWidth
    if (left < viewL) scrollEl.scrollLeft = left - pad
    else if (right > viewR) scrollEl.scrollLeft = right - scrollEl.clientWidth + pad
  })

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

{#snippet tabButton(g: TabGroup, t: TabInfo, glyph: string)}
  <button
    class="tab"
    class:active={t.id === activeId}
    onclick={() => { if (t.id !== activeId) onswitch(t.id) }}
    title={t.path}
  >
    <span class="tab-glyph">{glyph}</span>
    <span class="tab-name">{tabLabel(g, t)}</span>
    {#if t.stale}<span class="stale-dot" title="stale working copy"></span>{/if}
    {#if tabs.length > 1}
      <span
        class="tab-close"
        role="button"
        tabindex="-1"
        onclick={(e) => { e.stopPropagation(); onclose(t.id) }}
        onkeydown={(e) => { if (e.key === 'Enter') { e.stopPropagation(); onclose(t.id) } }}
      >×</span>
    {/if}
  </button>
{/snippet}

<div class="tab-bar">
  <div class="tab-scroll" bind:this={scrollEl}>
    {#each groups as g (g.key)}
      {#if g.tabs.length === 1}
        {@render tabButton(g, g.tabs[0], '▪')}
      {:else}
        <div class="tab-group" style:--gcolor="var(--graph-{g.colorIdx})" title={g.key}>
          <span class="repo-chip">
            {g.label}
            {#if g.stale}<span class="stale-dot"></span>{/if}
          </span>
          {#each g.tabs as t (t.id)}
            {@render tabButton(g, t, '◇')}
          {/each}
        </div>
      {/if}
    {/each}
  </div>
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
    height: 26px;
    flex-shrink: 0;
    user-select: none;
    font-family: var(--font-mono);
    font-size: var(--fs-sm);
  }

  /* Groups scroll; + and path-input stay pinned right. min-width:0 lets this
     flex item shrink below its intrinsic content width so overflow-x actually
     activates (default min-width:auto would push the + button off-screen).
     position:relative makes this the offsetParent for the scroll-into-view
     math above. margin/padding-bottom pair moves the -1px overlap here so the
     active-tab underline still sits on the bar's border instead of being
     clipped by the (now-computed-auto) overflow-y. */
  .tab-scroll {
    display: flex;
    align-items: stretch;
    flex: 1;
    min-width: 0;
    padding-left: 10px;
    position: relative;
    overflow-x: auto;
    scrollbar-width: none;
    margin-bottom: -1px;
    padding-bottom: 1px;
  }
  .tab-scroll::-webkit-scrollbar { display: none; }

  .tab-group {
    display: flex;
    align-items: stretch;
    flex-shrink: 0;
    margin-right: 6px;
    background: color-mix(in srgb, var(--text) 2%, transparent);
    border-left: 2px solid color-mix(in srgb, var(--gcolor) 55%, transparent);
    border-radius: 4px 4px 0 0;
  }

  .repo-chip {
    display: flex;
    align-items: center;
    gap: 5px;
    padding: 0 8px 0 7px;
    font-size: var(--fs-xs);
    color: var(--text-faint);
    border-right: 1px solid var(--surface1);
    cursor: default;
  }

  .tab {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 0 10px;
    flex-shrink: 0;
    background: transparent;
    border: none;
    /* Active-tab indicator is a bottom border, not a background — matches the
       amber accent on .toolbar-nav-active without competing with it (nav uses
       text color, tabs use underline; both amber, different channels). */
    border-bottom: 2px solid transparent;
    color: var(--subtext0);
    font: inherit;
    cursor: pointer;
    max-width: 200px;
  }
  .tab-group .tab { padding: 0 8px; }

  .tab:hover:not(.active) {
    background: var(--bg-hover);
    color: var(--text);
  }

  .tab.active {
    color: var(--text);
    border-bottom-color: var(--amber);
  }

  .tab-glyph {
    font-size: var(--fs-3xs);
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

  .stale-dot {
    width: 5px;
    height: 5px;
    flex-shrink: 0;
    border-radius: 50%;
    background: var(--amber);
    box-shadow: 0 0 0 2px color-mix(in srgb, var(--amber) 25%, transparent);
  }

  .tab-close {
    opacity: 0;
    font-size: var(--font-size);
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
    flex-shrink: 0;
    background: transparent;
    border: none;
    color: var(--text-faint);
    font: inherit;
    font-size: var(--fs-lg);
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
    color: var(--text-faint);
  }
</style>
