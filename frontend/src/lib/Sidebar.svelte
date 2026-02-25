<script lang="ts">
  interface Props {
    activeView: 'log' | 'branches' | 'operations'
    onnavigate: (view: 'log' | 'branches' | 'operations') => void
    onopenpalette: () => void
    onthemetoggle: () => void
    theme: 'dark' | 'light'
    inlineMode: boolean
    onundo: () => void
    oncommit: () => void
    onfetch: () => void
    onpush: () => void
    ongitmodal: () => void
  }

  let { activeView, onnavigate, onopenpalette, onthemetoggle, theme, inlineMode, onundo, oncommit, onfetch, onpush, ongitmodal }: Props = $props()

  const navItems: { view: 'log' | 'branches' | 'operations'; icon: string; label: string; key: string }[] = [
    { view: 'log', icon: '◉', label: 'Revisions', key: '1' },
    { view: 'branches', icon: '⑂', label: 'Branches', key: '2' },
    { view: 'operations', icon: '⟲', label: 'Operations', key: '3' },
  ]

  const cmdKey = typeof navigator !== 'undefined' && navigator.platform.includes('Mac') ? '⌘' : 'Ctrl+'
</script>

<aside class="sidebar">
  <div class="sidebar-top">
    <div class="logo">
      <span class="logo-diamond">◆</span>
      <span class="logo-text">lightjj</span>
    </div>

    <button class="search-trigger" onclick={onopenpalette}>
      <span class="search-text">Search…</span>
      <kbd class="search-kbd">{cmdKey}K</kbd>
    </button>

    <nav class="nav">
      {#each navItems as item}
        <button
          class="nav-item"
          class:nav-active={activeView === item.view}
          onclick={() => onnavigate(item.view)}
          title="{item.label} ({item.key})"
        >
          <span class="nav-icon">{item.icon}</span>
          <span class="nav-label">{item.label}</span>
          <kbd class="nav-key">{item.key}</kbd>
        </button>
      {/each}
    </nav>
  </div>

  <div class="sidebar-bottom">
    <div class="action-buttons">
      <button class="action-btn" onclick={onundo} title="Undo (u)" disabled={inlineMode}>
        Undo <kbd>u</kbd>
      </button>
      <button class="action-btn" onclick={oncommit} title="Commit (c)" disabled={inlineMode}>
        Commit <kbd>c</kbd>
      </button>
      <div class="action-row">
        <button class="action-btn" onclick={onfetch} title="Fetch (f)" disabled={inlineMode}>
          Fetch <kbd>f</kbd>
        </button>
        <button class="action-btn" onclick={onpush} title="Push (p)" disabled={inlineMode}>
          Push <kbd>p</kbd>
        </button>
      </div>
      <button class="action-btn" onclick={ongitmodal} title="Git operations (g)" disabled={inlineMode}>
        Git <kbd>g</kbd>
      </button>
    </div>

    <button class="theme-toggle" onclick={onthemetoggle} title="Toggle theme (t)">
      {theme === 'dark' ? '☀' : '☽'}
      <kbd>t</kbd>
    </button>
  </div>
</aside>

<style>
  .sidebar {
    width: 190px;
    flex-shrink: 0;
    display: flex;
    flex-direction: column;
    background: var(--base);
    border-right: 1px solid var(--surface1);
    user-select: none;
  }

  .sidebar-top {
    display: flex;
    flex-direction: column;
    gap: 16px;
    padding: 16px 12px 12px;
  }

  .sidebar-bottom {
    margin-top: auto;
    padding: 12px;
    display: flex;
    flex-direction: column;
    gap: 12px;
  }

  .logo {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 0 4px;
  }

  .logo-diamond {
    color: var(--blue);
    font-size: 16px;
  }

  .logo-text {
    font-weight: 700;
    font-size: 15px;
    color: var(--text);
    letter-spacing: -0.02em;
  }

  .search-trigger {
    display: flex;
    align-items: center;
    justify-content: space-between;
    width: 100%;
    padding: 6px 10px;
    background: var(--surface0);
    border: 1px solid var(--surface1);
    border-radius: 6px;
    color: var(--subtext0);
    font-family: inherit;
    font-size: 12px;
    cursor: pointer;
  }

  .search-trigger:hover {
    border-color: var(--surface2);
    color: var(--text);
  }

  .search-kbd {
    font-family: inherit;
    font-size: 10px;
    color: var(--surface2);
    background: none;
    border: none;
    padding: 0;
  }

  .nav {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  .nav-item {
    display: flex;
    align-items: center;
    gap: 8px;
    width: 100%;
    padding: 6px 10px;
    background: transparent;
    border: none;
    border-radius: 6px;
    color: var(--subtext0);
    font-family: inherit;
    font-size: 13px;
    cursor: pointer;
    text-align: left;
  }

  .nav-item:hover {
    background: var(--bg-hover);
    color: var(--text);
  }

  .nav-item.nav-active {
    background: var(--bg-selected);
    color: var(--blue);
  }

  .nav-icon {
    font-size: 14px;
    width: 18px;
    text-align: center;
    flex-shrink: 0;
  }

  .nav-label {
    flex: 1;
  }

  .nav-key {
    font-family: inherit;
    font-size: 10px;
    color: var(--surface2);
    background: var(--bg-btn-kbd);
    border: none;
    padding: 1px 4px;
    border-radius: 3px;
    opacity: 0.7;
  }

  .nav-active .nav-key {
    color: var(--blue);
    opacity: 0.5;
  }

  .action-buttons {
    display: flex;
    flex-direction: column;
    gap: 3px;
  }

  .action-row {
    display: flex;
    gap: 3px;
  }

  .action-row .action-btn {
    flex: 1;
  }

  .action-btn {
    display: flex;
    align-items: center;
    justify-content: space-between;
    width: 100%;
    padding: 5px 10px;
    background: transparent;
    border: 1px solid var(--surface1);
    border-radius: 5px;
    color: var(--subtext0);
    font-family: inherit;
    font-size: 11px;
    cursor: pointer;
  }

  .action-btn:hover:not(:disabled) {
    background: var(--bg-hover);
    color: var(--text);
    border-color: var(--surface2);
  }

  .action-btn:disabled {
    opacity: 0.4;
    cursor: default;
  }

  .action-btn kbd {
    font-family: inherit;
    font-size: 10px;
    color: var(--surface2);
    background: none;
    border: none;
    padding: 0;
  }

  .theme-toggle {
    display: flex;
    align-items: center;
    justify-content: space-between;
    width: 100%;
    padding: 5px 10px;
    background: transparent;
    border: 1px solid transparent;
    border-radius: 5px;
    color: var(--subtext0);
    font-family: inherit;
    font-size: 13px;
    cursor: pointer;
  }

  .theme-toggle:hover {
    background: var(--bg-hover);
    color: var(--text);
  }

  .theme-toggle kbd {
    font-family: inherit;
    font-size: 10px;
    color: var(--surface2);
    background: none;
    border: none;
    padding: 0;
  }
</style>
