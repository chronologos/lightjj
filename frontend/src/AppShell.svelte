<script lang="ts">
  import { SvelteMap } from 'svelte/reactivity'
  import App, { type TabState } from './App.svelte'
  import TabBar from './lib/TabBar.svelte'
  import MessageBar, { errorMessage, type Message } from './lib/MessageBar.svelte'
  import ContextMenu, { type ContextMenuItem } from './lib/ContextMenu.svelte'
  import {
    setActiveTab, listTabs, openTab, closeTab, onTabsChanged,
    workspacesForTab, workspaceAddForTab, workspaceUpdateStaleForTab, updateStaleWorkspaceForTab,
    type TabInfo, type WorkspacesResponse,
  } from './lib/api'
  import { LAUNCH_TAB_ID, groupTabs, isClosableTab, tabGroupKey, type TabGroup } from './lib/tab-groups'
  import { workspaceSectionItems, tabMenuItems, type WorkspaceSectionOpts } from './lib/workspace-menu'
  import { planRecoverAll, recoverAllMessage } from './lib/workspace-recovery'
  import { parseUrlIntent, stripUrlIntent } from './lib/url-intent'


  let tabs: TabInfo[] = $state([])
  let activeTabId: string = $state(LAUNCH_TAB_ID)
  let shellMessage: Message | null = $state(null)
  let appRef: ReturnType<typeof App> | undefined = $state(undefined)

  // Per-tab UI state snapshots. Captured before {#key} destroys the old App
  // instance; fed into the new one as initialState. The {#key} remount is
  // load-bearing (SSE lifecycle, onStale wiring) — this just threads cursor
  // position + scroll through it.
  const tabState = new Map<string, TabState>()

  // Routable URL (issue #35): `/?change=<id>[&revset=<r>][&path=<f>]` — e.g. an
  // agent handing the user a link to the change it made. Parsed ONCE at boot
  // and applied only to the launch tab's first App mount, via the same
  // initialState channel as tab-switch restore: `revset` seeds revsetFilter (so
  // the very first loadLog already uses it — no double load); `change`/`path`
  // ride as the one-shot selectRef/selectPath (App owns select → widen-once →
  // warn). Stripped from the address bar right away — the intent now lives in
  // tabState, and a browser refresh should return to the base URL rather than
  // re-apply stale intent (stripping here, not after App finishes applying,
  // also covers a first load that never succeeds).
  const urlIntent = parseUrlIntent(location.search)
  if (urlIntent) {
    tabState.set(LAUNCH_TAB_ID, {
      selectedId: null,
      revsetFilter: urlIntent.revset ?? '',
      activeView: 'log',
      diffScrollTop: 0,
      selectRef: urlIntent.change,
      selectPath: urlIntent.path,
    })
    history.replaceState(history.state, '', location.pathname + stripUrlIntent(location.search) + location.hash)
  }

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

  // Per-tab stale/wsName come from GET /tabs. The active tab's stream says when the
  // list may have changed, for background tabs too.
  $effect(() => onTabsChanged(refetchTabs))

  // ── Per-repo workspace info (the `◇N` tab icon + workspace menu) ──────────
  // Each tab is a full Server at /tab/{id}/, so workspacesForTab(id) fetches ANY
  // open tab's repo. We fetch once per distinct repoRoot (via the group's first
  // tab). op-sync isn't available here — AppShell has no op-id stream for
  // background tabs — so staleness of this count is bounded by fetch-on-tab-list-
  // change + fetch-on-menu-open (see the spec's data-loading section).
  let groups = $derived<TabGroup[]>(groupTabs(tabs))
  const wsByRepo = new SvelteMap<string, WorkspacesResponse>()
  const wsCounts = $derived(
    new Map([...wsByRepo].map(([k, v]) => [k, v.workspaces.length])),
  )
  // Non-reactive dedup: which group keys we've kicked a fetch for. Keeps the
  // effect's deps to `groups` only (no read of wsByRepo → no self-retrigger).
  const fetchedKeys = new Set<string>()
  $effect(() => {
    for (const g of groups) {
      if (fetchedKeys.has(g.key)) continue
      fetchedKeys.add(g.key)
      workspacesForTab(g.tabs[0].id)
        .then(ws => wsByRepo.set(g.key, ws))
        .catch(() => { fetchedKeys.delete(g.key) }) // let a later change retry
    }
  })

  // Session mode is process-wide (TabManager.Host — all tabs share it), so the
  // active App reporting it once is authoritative for every repo's Add gate.
  let sshMode = $state<boolean | undefined>(undefined)

  // ── Tab/workspace context menu (AppShell's single ContextMenu instance) ────
  let menu: { items: ContextMenuItem[]; x: number; y: number } | null = $state(null)

  // Shared workspace-section options for a repo, or undefined when it has < 2
  // workspaces (nothing to switch between). inlineMode is read from the active
  // App: opening/switching a tab remounts it and drops a half-configured mode.
  function sectionOpts(groupKey: string): WorkspaceSectionOpts | undefined {
    const ws = wsByRepo.get(groupKey)
    if (!ws || ws.workspaces.length < 2) return undefined
    const firstTab = tabs.find(t => tabGroupKey(t) === groupKey)
    if (!firstTab) return undefined
    const firstId = firstTab.id
    return {
      ws, groupKey, tabs, activeTabId, sshMode,
      inlineMode: appRef?.inInlineMode() ?? false,
      onSwitch: switchTab,
      onOpen: handleOpen,
      onAdd: () => addWorkspaceForRepo(groupKey, firstId),
      onUpdateAll: () => updateAllForRepo(groupKey, firstId, ws),
    }
  }

  // Left-click the `◇N` icon → the repo's workspace menu. Items are a snapshot;
  // a background refresh keeps the NEXT open current (fetch-on-menu-open).
  function openWorkspaceMenu(groupKey: string, x: number, y: number) {
    const opts = sectionOpts(groupKey)
    if (!opts) return
    menu = { items: workspaceSectionItems(opts), x, y }
    const firstTab = tabs.find(t => tabGroupKey(t) === groupKey)
    if (firstTab) workspacesForTab(firstTab.id).then(ws => wsByRepo.set(groupKey, ws)).catch(() => {})
  }

  // Right-click any tab → workspace section (when the repo has workspaces) + tab
  // operations. Domain object in, items built here (CLAUDE.md context-menu rule).
  function openTabMenu(tab: TabInfo, x: number, y: number) {
    const groupKey = tabGroupKey(tab)
    const group = groups.find(g => g.key === groupKey)
    menu = {
      items: tabMenuItems({
        tab,
        tabCount: tabs.length,
        groupTabs: group?.tabs ?? [tab],
        section: sectionOpts(groupKey),
        onCloseTab: handleClose,
        onCloseGroup: group ? () => closeGroup(group) : undefined,
      }),
      x, y,
    }
  }

  // `w` key (App → here): open the ACTIVE tab's workspace menu, anchored at its
  // `◇N` icon. No-op when the repo is single-workspace (old `w` guard).
  function openActiveWorkspaceMenu() {
    const active = tabs.find(t => t.id === activeTabId)
    if (!active) return
    const groupKey = tabGroupKey(active)
    if ((wsCounts.get(groupKey) ?? 0) < 2) return
    const icon = Array.from(document.querySelectorAll<HTMLElement>('.ws-tab-icon'))
      .find(el => el.dataset.wsKey === groupKey)
    const el = icon ?? document.querySelector<HTMLElement>('.tab.active')
    const r = el?.getBoundingClientRect()
    openWorkspaceMenu(groupKey, r ? r.left : 100, r ? r.bottom + 2 : 40)
  }

  async function addWorkspaceForRepo(groupKey: string, tabId: string) {
    shellMessage = null
    // eslint-disable-next-line no-alert
    const name = prompt('New workspace name (creates sibling directory <repo>-<name>):')?.trim()
    if (!name) return
    try {
      await workspaceAddForTab(tabId, name)
      const ws = await workspacesForTab(tabId)
      wsByRepo.set(groupKey, ws)
      const added = ws.workspaces.find(w => w.name === name)
      if (added?.path) await handleOpen(added.path)
      else shellMessage = { kind: 'success', text: `Added workspace '${name}'` }
    } catch (e) { showShellError(e) }
  }

  async function updateAllForRepo(groupKey: string, tabId: string, cached: WorkspacesResponse) {
    shellMessage = null
    try {
      // Refetch fresh (a mutation deserves current membership); fall back to the
      // cached snapshot if the refetch fails.
      const ws = await workspacesForTab(tabId).catch(() => cached)
      wsByRepo.set(groupKey, ws)
      const { targets, skipped } = planRecoverAll(ws.workspaces, ws.current)
      if (targets.length === 0) return
      let ran = 0
      const failed: string[] = []
      for (const w of targets) {
        try {
          await (w.name === ws.current
            ? workspaceUpdateStaleForTab(tabId)
            : updateStaleWorkspaceForTab(tabId, w.name))
          ran++
        } catch { failed.push(w.name) }
      }
      shellMessage = recoverAllMessage(ran, failed, skipped)
      refetchTabs()
    } catch (e) { showShellError(e) }
  }

  async function closeGroup(group: TabGroup) {
    // Snapshot the tab list — handleClose mutates `tabs` under us. The launch
    // tab is skipped (server refuses it); closing the rest of its group is the
    // useful reading of "Close group" there.
    for (const t of group.tabs.filter(isClosableTab)) await handleClose(t.id)
  }

  /** False = the user kept their unsaved work and stayed. */
  function switchTab(id: string): boolean {
    // The remount destroys every buffer in the outgoing App.
    if (id !== activeTabId && appRef && !appRef.confirmLeaveTab()) return false
    // Snapshot the outgoing App's state before remount destroys it. appRef is
    // undefined on first paint (no App mounted yet) — that's the only skip.
    if (appRef) tabState.set(activeTabId, appRef.getState())
    // Order matters: basePath must be set BEFORE the {#key} remount fires
    // App's mount-time refreshes (logSync/workspacesSync/... .refresh()).
    setActiveTab(id)
    activeTabId = id
    return true
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
    if (id === LAUNCH_TAB_ID) return // never offered by the UI; server would 400
    // Switch away first so App unmounts cleanly (its wireAutoRefresh cleanup
    // closes the EventSource) before the backend tears down that tab's Server.
    if (id === activeTabId) {
      const other = tabs.find(t => t.id !== id)
      if (other && !switchTab(other.id)) return
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
     (tabs, path-input text) survives tab switches. App just positions it. The
     `◇N` icon + right-click emit domain objects; AppShell builds the menu. -->
{#snippet tabBar()}
  <TabBar
    {tabs}
    activeId={activeTabId}
    onswitch={switchTab}
    onopen={handleOpen}
    onclose={handleClose}
    {wsCounts}
    onWorkspaceIcon={openWorkspaceMenu}
    onTabMenu={openTabMenu}
  />
{/snippet}

{#key activeTabId}
  <App
    bind:this={appRef}
    {tabBar}
    {tabs}
    onOpenTab={handleOpen}
    onSwitchTab={switchTab}
    onOpenWorkspaceMenu={openActiveWorkspaceMenu}
    onSshMode={(v) => sshMode = v}
    initialState={tabState.get(activeTabId)}
    initialWsName={tabs.find(t => t.id === activeTabId)?.wsName}
  />
{/key}

{#if menu}
  <ContextMenu
    items={menu.items}
    x={menu.x}
    y={menu.y}
    bind:open={() => true, (v) => { if (!v) menu = null }}
  />
{/if}

{#if shellMessage}
  <MessageBar message={shellMessage} onDismiss={() => shellMessage = null} />
{/if}
