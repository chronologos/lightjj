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
      <img
        src={theme === 'dark' ? '/logo.svg' : '/logo-light.svg'}
        alt=""
        width="20"
        height="20"
        class="logo-img"
      />
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

    <button
      class="theme-toggle"
      onclick={onthemetoggle}
      aria-label={theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}
    >
      <span>{theme === 'dark' ? '☀' : '🌙'}</span>
      <span class="theme-label">{theme === 'dark' ? 'Light' : 'Dark'}</span>
      <kbd class="theme-key">t</kbd>
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
    padding: 14px 10px;
    gap: 1px;
  }

  .sidebar-top {
    display: flex;
    flex-direction: column;
    gap: 14px;
  }

  .sidebar-bottom {
    margin-top: auto;
    display: flex;
    flex-direction: column;
    gap: 10px;
  }

  .logo {
    display: flex;
    align-items: center;
    gap: 7px;
    padding: 4px 8px;
  }

  .logo-img {
    flex-shrink: 0;
  }

  .logo-text {
    font-weight: 600;
    font-size: 14px;
    color: var(--text);
    letter-spacing: -0.01em;
  }

  .search-trigger {
    display: flex;
    align-items: center;
    justify-content: space-between;
    width: 100%;
    padding: 6px 9px;
    background: var(--bg-hover);
    border: none;
    border-radius: 7px;
    color: var(--surface2);
    font-family: inherit;
    font-size: 12px;
    cursor: pointer;
  }

  .search-trigger:hover {
    color: var(--subtext0);
  }

  /* Shared kbd styling for search, nav, and theme keys */
  .search-kbd,
  .nav-key,
  .theme-key {
    font-family: var(--font-mono);
    font-size: 9px;
    color: var(--surface2);
    background: none;
    border: 1px solid var(--surface1);
    padding: 1px 5px;
    border-radius: 3px;
  }

  .nav {
    display: flex;
    flex-direction: column;
    gap: 1px;
  }

  .nav-item {
    display: flex;
    align-items: center;
    gap: 7px;
    width: 100%;
    padding: 7px 9px;
    background: transparent;
    border: none;
    border-radius: 7px;
    color: var(--subtext0);
    font-family: inherit;
    font-size: 13px;
    cursor: pointer;
    text-align: left;
  }

  .nav-item:hover:not(.nav-active) {
    background: var(--bg-hover);
    color: var(--text);
  }

  .nav-item.nav-active {
    background: var(--bg-selected);
    color: var(--blue);
    font-weight: 500;
  }

  .nav-icon {
    font-size: 13px;
    width: 16px;
    text-align: center;
    flex-shrink: 0;
  }

  .nav-label {
    flex: 1;
  }

  .nav-key {
    opacity: 0.6;
  }

  .nav-active .nav-key {
    color: var(--blue);
    border-color: transparent;
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
    gap: 6px;
    width: 100%;
    padding: 6px 9px;
    background: transparent;
    border: none;
    border-radius: 7px;
    color: var(--surface2);
    font-family: inherit;
    font-size: 12px;
    cursor: pointer;
  }

  .theme-toggle:hover {
    background: var(--bg-hover);
    color: var(--subtext0);
  }

  .theme-label {
    flex: 1;
    text-align: left;
  }

  .theme-key {
    opacity: 0.6;
  }
</style>
