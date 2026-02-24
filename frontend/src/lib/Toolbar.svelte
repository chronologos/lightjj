<script lang="ts">
  interface Props {
    onrefresh: () => void
    onundo: () => void
    onfetch: () => void
    onpush: () => void
    onopenpalette: () => void
  }

  let { onrefresh, onundo, onfetch, onpush, onopenpalette }: Props = $props()
</script>

<header class="titlebar">
  <div class="titlebar-left">
    <span class="app-name">lightjj</span>
    <span class="separator">|</span>
    <div class="toolbar">
      <button class="toolbar-btn" onclick={onrefresh} title="Refresh (r)">
        <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
          <path d="M13.5 2a.5.5 0 0 0-.5.5V5h-2.5a.5.5 0 0 0 0 1H14a.5.5 0 0 0 .5-.5V2.5a.5.5 0 0 0-.5-.5z"/>
          <path d="M13.36 4.05A6 6 0 1 0 14 8a.5.5 0 0 1 1 0 7 7 0 1 1-1.75-4.63l.11.68z"/>
        </svg>
        Refresh
      </button>
      <button class="toolbar-btn" onclick={onundo} title="Undo (u)">
        <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
          <path d="M2 5.5a.5.5 0 0 1 .5-.5h9a3.5 3.5 0 0 1 0 7H7a.5.5 0 0 1 0-1h4.5a2.5 2.5 0 0 0 0-5h-9a.5.5 0 0 1-.5-.5z"/>
          <path d="M4.854 3.146a.5.5 0 0 1 0 .708L2.707 6l2.147 2.146a.5.5 0 1 1-.708.708l-2.5-2.5a.5.5 0 0 1 0-.708l2.5-2.5a.5.5 0 0 1 .708 0z"/>
        </svg>
        Undo
      </button>
      <div class="toolbar-divider"></div>
      <button class="toolbar-btn" onclick={onfetch} title="Git fetch">
        <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
          <path d="M8 1a.5.5 0 0 1 .5.5v10.793l3.146-3.147a.5.5 0 0 1 .708.708l-4 4a.5.5 0 0 1-.708 0l-4-4a.5.5 0 0 1 .708-.708L7.5 12.293V1.5A.5.5 0 0 1 8 1z"/>
        </svg>
        Fetch
      </button>
      <button class="toolbar-btn" onclick={onpush} title="Git push">
        <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
          <path d="M8 15a.5.5 0 0 0 .5-.5V3.707l3.146 3.147a.5.5 0 0 0 .708-.708l-4-4a.5.5 0 0 0-.708 0l-4 4a.5.5 0 0 0 .708.708L7.5 3.707V14.5a.5.5 0 0 0 .5.5z"/>
        </svg>
        Push
      </button>
    </div>
  </div>
  <div class="titlebar-right">
    <kbd class="shortcut-hint">Cmd+K</kbd> commands
    <kbd class="shortcut-hint">/</kbd> filter
    <kbd class="shortcut-hint">j/k</kbd> navigate
    <kbd class="shortcut-hint">Space</kbd> check
    <kbd class="shortcut-hint">e</kbd> describe
    <kbd class="shortcut-hint">n</kbd> new
    <kbd class="shortcut-hint">u</kbd> undo
  </div>
</header>

<style>
  .titlebar {
    display: flex;
    justify-content: space-between;
    align-items: center;
    height: 40px;
    padding: 0 12px;
    background: var(--crust);
    border-bottom: 1px solid var(--surface1);
    flex-shrink: 0;
    user-select: none;
  }

  .titlebar-left {
    display: flex;
    align-items: center;
    gap: 10px;
  }

  .app-name {
    font-weight: 700;
    font-size: 14px;
    color: var(--blue);
    letter-spacing: -0.02em;
  }

  .separator {
    color: var(--surface1);
  }

  .toolbar {
    display: flex;
    align-items: center;
    gap: 2px;
  }

  .toolbar-btn {
    display: flex;
    align-items: center;
    gap: 5px;
    background: transparent;
    border: 1px solid transparent;
    color: var(--subtext1);
    padding: 4px 8px;
    border-radius: 4px;
    cursor: pointer;
    font-family: inherit;
    font-size: 12px;
    transition: all 0.15s ease;
  }

  .toolbar-btn:hover {
    background: var(--surface0);
    border-color: var(--surface1);
    color: var(--text);
  }

  .toolbar-btn:active {
    background: var(--surface1);
  }

  .toolbar-divider {
    width: 1px;
    height: 18px;
    background: var(--surface1);
    margin: 0 4px;
  }

  .titlebar-right {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 11px;
    color: var(--overlay0);
  }

  .shortcut-hint {
    display: inline-block;
    background: var(--surface0);
    color: var(--subtext0);
    padding: 1px 5px;
    border-radius: 3px;
    font-size: 10px;
    font-family: inherit;
    border: 1px solid var(--surface1);
  }
</style>
