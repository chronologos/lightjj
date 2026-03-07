<script lang="ts">
  import App from './App.svelte'
  import TabBar from './lib/TabBar.svelte'
  import { setActiveTab, listTabs, openTab, closeTab, type TabInfo } from './lib/api'

  let tabs: TabInfo[] = $state([])
  let activeTabId: string = $state('0')
  let error: string = $state('')

  // basePath defaults to '/tab/0' in api.ts, so App can mount immediately
  // without waiting for listTabs. The tab list populates asynchronously.
  listTabs().then(t => { tabs = t }).catch(() => {})

  function switchTab(id: string) {
    // Order matters: basePath must be set BEFORE the {#key} remount fires
    // App's top-level fetches (loadLog, loadWorkspaces, etc.).
    setActiveTab(id)
    activeTabId = id
  }

  async function handleOpen(path: string) {
    error = ''
    try {
      const tab = await openTab(path)
      // Dedup: backend returns existing tab if path resolves to a known root.
      if (!tabs.find(t => t.id === tab.id)) tabs = [...tabs, tab]
      switchTab(tab.id)
    } catch (e) {
      error = e instanceof Error ? e.message : String(e)
    }
  }

  async function handleClose(id: string) {
    error = ''
    // Switch away first so App unmounts cleanly (its wireAutoRefresh cleanup
    // closes the EventSource) before the backend tears down that tab's Server.
    if (id === activeTabId) {
      const other = tabs.find(t => t.id !== id)
      if (other) switchTab(other.id)
    }
    try {
      await closeTab(id)
      tabs = tabs.filter(t => t.id !== id)
    } catch (e) {
      error = e instanceof Error ? e.message : String(e)
    }
  }
</script>

<!-- TabBar is rendered by App (between its toolbar and workspace) via snippet
     prop. It lives outside {#key} here — one instance for the session, state
     (tabs, path-input text) survives tab switches. App just positions it. -->
{#snippet tabBar()}
  <TabBar {tabs} activeId={activeTabId} onswitch={switchTab} onopen={handleOpen} onclose={handleClose} />
  {#if error}
    <div class="shell-error">{error} <button onclick={() => error = ''}>×</button></div>
  {/if}
{/snippet}

{#key activeTabId}
  <App {tabBar} onOpenTab={handleOpen} />
{/key}

<style>
  .shell-error {
    padding: 4px 12px;
    background: var(--red-bg);
    color: var(--red);
    font-size: 12px;
    display: flex;
    align-items: center;
    justify-content: space-between;
  }

  .shell-error button {
    background: transparent;
    border: none;
    color: inherit;
    cursor: pointer;
    font-size: 14px;
    padding: 0 4px;
  }
</style>
