<script lang="ts">
  interface Props {
    onundo: () => void
    onfetch: () => void
    onpush: () => void
    oncommit: () => void
    ongitmodal: () => void
    onopenpalette: () => void
  }

  let { onundo, onfetch, onpush, oncommit, ongitmodal, onopenpalette }: Props = $props()
</script>

<header class="titlebar">
  <div class="titlebar-left">
    <span class="app-name">lightjj</span>
  </div>
  <div class="titlebar-right">
    <div class="toolbar">
      <button class="toolbar-btn" onclick={onundo} title="Undo last operation">
        <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
          <path d="M2 5.5a.5.5 0 0 1 .5-.5h9a3.5 3.5 0 0 1 0 7H7a.5.5 0 0 1 0-1h4.5a2.5 2.5 0 0 0 0-5h-9a.5.5 0 0 1-.5-.5z"/>
          <path d="M4.854 3.146a.5.5 0 0 1 0 .708L2.707 6l2.147 2.146a.5.5 0 1 1-.708.708l-2.5-2.5a.5.5 0 0 1 0-.708l2.5-2.5a.5.5 0 0 1 .708 0z"/>
        </svg>
        Undo
        <kbd>u</kbd>
      </button>
      <button class="toolbar-btn" onclick={oncommit} title="Commit working copy">
        Commit
        <kbd>c</kbd>
      </button>
      <div class="toolbar-divider"></div>
      <button class="toolbar-btn" onclick={onfetch} title="Git fetch from default remote">
        <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
          <path d="M8 1a.5.5 0 0 1 .5.5v10.793l3.146-3.147a.5.5 0 0 1 .708.708l-4 4a.5.5 0 0 1-.708 0l-4-4a.5.5 0 0 1 .708-.708L7.5 12.293V1.5A.5.5 0 0 1 8 1z"/>
        </svg>
        Fetch
        <kbd>f</kbd>
      </button>
      <button class="toolbar-btn" onclick={onpush} title="Git push tracking bookmarks">
        <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
          <path d="M8 15a.5.5 0 0 0 .5-.5V3.707l3.146 3.147a.5.5 0 0 0 .708-.708l-4-4a.5.5 0 0 0-.708 0l-4 4a.5.5 0 0 0 .708.708L7.5 3.707V14.5a.5.5 0 0 0 .5.5z"/>
        </svg>
        Push
        <kbd>p</kbd>
      </button>
      <button class="toolbar-btn" onclick={ongitmodal} title="Advanced git operations">
        Git
        <kbd>g</kbd>
      </button>
      <div class="toolbar-divider"></div>
      <button class="toolbar-btn" onclick={onopenpalette} title="Command palette">
        Help
        <kbd>{navigator.platform.includes('Mac') ? '\u2318' : 'Ctrl+'}K</kbd>
      </button>
    </div>
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
  }

  .titlebar-right {
    display: flex;
    align-items: center;
  }

  .app-name {
    font-weight: 700;
    font-size: 14px;
    color: var(--blue);
    letter-spacing: -0.02em;
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
  }

  .toolbar-btn:hover {
    background: var(--surface0);
    border-color: var(--surface1);
    color: var(--text);
  }

  .toolbar-btn:active {
    background: var(--surface1);
  }

  .toolbar-btn kbd {
    display: inline-block;
    background: var(--surface0);
    color: var(--subtext0);
    padding: 0 4px;
    border-radius: 3px;
    font-size: 10px;
    font-family: inherit;
    border: 1px solid var(--surface1);
    line-height: 1.5;
  }

  .toolbar-btn:hover kbd {
    background: var(--surface1);
    border-color: var(--surface2);
  }

  .toolbar-divider {
    width: 1px;
    height: 18px;
    background: var(--surface1);
    margin: 0 4px;
  }
</style>
