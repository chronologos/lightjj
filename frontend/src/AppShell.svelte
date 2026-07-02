<script lang="ts">
  import App, { type TabState } from './App.svelte'
  import TabBar from './lib/TabBar.svelte'
  import MessageBar, { errorMessage, type Message } from './lib/MessageBar.svelte'
  import { setActiveTab, listTabs, openTab, closeTab, onStaleWC, type TabInfo } from './lib/api'

  let tabs: TabInfo[] = $state([])
  let activeTabId: string = $state('0')
  let shellMessage: Message | null = $state(null)
  let appRef: ReturnType<typeof App> | undefined = $state(undefined)

  // Per-tab UI state snapshots. Captured before {#key} destroys the old App
  // instance; fed into the new one as initialState. The {#key} remount is
  // load-bearing (SSE lifecycle, onStale wiring) — this just threads cursor
  // position + scroll through it.
  const tabState = new Map<string, TabState>()

  // basePath defaults to '/tab/0' in api.ts, so App can mount immediately
  // without waiting for listTabs. The tab list populates asynchronously.
  // Generation-guarded: GET /tabs runs subprocesses on first call per tab, so
  // an early refetch can land after a later handleOpen's local append and
  // clobber it with a snapshot taken before the new tab existed backend-side.
  let tabsGen = 0
  function refetchTabs() {
    const gen = ++tabsGen
    listTabs().then(t => { if (gen === tabsGen) tabs = t }).catch(() => {})
  }
  refetchTabs()

  // Per-tab stale/wsName come from GET /tabs (each tab's Watcher.Stale()).
  // The active tab's SSE is the only stale-edge signal AppShell hears — a
  // background tab going stale (e.g. rebase in A stales workspace B) doesn't
  // fire it, so B's dot appears on next switch/open rather than instantly.
  // A manager-level tabs-changed SSE would close that gap; tracked in BACKLOG.
  $effect(() => onStaleWC(() => { refetchTabs() }))

  function switchTab(id: string) {
    // Snapshot the outgoing App's state before remount destroys it. appRef is
    // undefined on first paint (no App mounted yet) — that's the only skip.
    if (appRef) tabState.set(activeTabId, appRef.getState())
    // Order matters: basePath must be set BEFORE the {#key} remount fires
    // App's mount-time refreshes (logSync/workspacesSync/... .refresh()).
    setActiveTab(id)
    activeTabId = id
  }

  const showShellError = (e: unknown) => shellMessage = errorMessage(e)

  async function handleOpen(path: string) {
    shellMessage = null
    try {
      const tab = await openTab(path)
      // Dedup: backend returns existing tab if path resolves to a known root.
      // Bump gen BEFORE the local append so any refetch already in flight
      // (started before this tab existed backend-side) can't clobber it.
      tabsGen++
      if (!tabs.find(t => t.id === tab.id)) tabs = [...tabs, tab]
      switchTab(tab.id)
      // Refetch for enrichment: POST /tabs returns the bare Tab (no wsName —
      // that's resolved off-path); a follow-up GET fills it so grouping/labels
      // settle without waiting for the next stale-edge.
      refetchTabs()
    } catch (e) {
      showShellError(e)
    }
  }

  async function handleClose(id: string) {
    shellMessage = null
    // Switch away first so App unmounts cleanly (its wireAutoRefresh cleanup
    // closes the EventSource) before the backend tears down that tab's Server.
    if (id === activeTabId) {
      const other = tabs.find(t => t.id !== id)
      if (other) switchTab(other.id)
    }
    try {
      await closeTab(id)
      // Bump gen before local write — same guard as handleOpen: an in-flight
      // refetch snapshotted before the DELETE would otherwise re-add this tab.
      tabsGen++
      tabs = tabs.filter(t => t.id !== id)
      tabState.delete(id)
    } catch (e) {
      showShellError(e)
    }
  }
</script>

<!-- TabBar is rendered by App (between its toolbar and workspace) via snippet
     prop. It lives outside {#key} here — one instance for the session, state
     (tabs, path-input text) survives tab switches. App just positions it. -->
{#snippet tabBar()}
  <TabBar {tabs} activeId={activeTabId} onswitch={switchTab} onopen={handleOpen} onclose={handleClose} />
{/snippet}

{#key activeTabId}
  <App
    bind:this={appRef}
    {tabBar}
    onOpenTab={handleOpen}
    initialState={tabState.get(activeTabId)}
    initialWsName={tabs.find(t => t.id === activeTabId)?.wsName}
  />
{/key}

{#if shellMessage}
  <MessageBar message={shellMessage} onDismiss={() => shellMessage = null} />
{/if}
