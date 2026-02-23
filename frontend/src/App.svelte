<script lang="ts">
  import { SvelteSet } from 'svelte/reactivity'
  import { api, type LogEntry, type FileChange, type OpEntry } from './lib/api'
  import type { PaletteCommand } from './lib/CommandPalette.svelte'
  import Toolbar from './lib/Toolbar.svelte'
  import StatusBar from './lib/StatusBar.svelte'
  import CommandPalette from './lib/CommandPalette.svelte'
  import RevisionGraph from './lib/RevisionGraph.svelte'
  import DiffPanel from './lib/DiffPanel.svelte'
  import EvologPanel from './lib/EvologPanel.svelte'
  import OplogPanel from './lib/OplogPanel.svelte'

  // --- Global state ---
  let revisions: LogEntry[] = $state([])
  let selectedIndex: number = $state(-1)
  let diffContent: string = $state('')
  let error: string = $state('')
  let loading: boolean = $state(true)
  let diffLoading: boolean = $state(false)
  let lastAction: string = $state('')
  let descriptionEditing: boolean = $state(false)
  let descriptionDraft: string = $state('')
  let commandOutput: string = $state('')
  let revsetFilter: string = $state('')
  let changedFiles: FileChange[] = $state([])
  let filesLoading: boolean = $state(false)
  let describeSaved: boolean = $state(false)
  let checkedRevisions = new SvelteSet<string>()
  let lastCheckedIndex: number = $state(-1)
  let diffGeneration: number = 0
  let filesGeneration: number = 0
  let evologOpen: boolean = $state(false)
  let evologContent: string = $state('')
  let evologLoading: boolean = $state(false)
  let oplogOpen: boolean = $state(false)
  let oplogEntries: OpEntry[] = $state([])
  let oplogLoading: boolean = $state(false)

  // --- Refs ---
  let paletteRef: ReturnType<typeof CommandPalette> | undefined = $state(undefined)
  let revisionGraphRef: ReturnType<typeof RevisionGraph> | undefined = $state(undefined)
  let diffPanelRef: ReturnType<typeof DiffPanel> | undefined = $state(undefined)

  // --- Derived ---
  let selectedRevision: LogEntry | null = $derived(
    selectedIndex >= 0 && selectedIndex < revisions.length
      ? revisions[selectedIndex]
      : null
  )

  let effectiveRevisions = $derived.by(() => {
    if (checkedRevisions.size > 0) {
      return [...checkedRevisions]
    }
    return selectedRevision ? [selectedRevision.commit.change_id] : []
  })

  let statusText = $derived.by(() => {
    if (loading) return 'Loading revisions...'
    if (diffLoading) return 'Loading diff...'
    if (lastAction) return lastAction
    const count = revisions.length
    const wc = revisions.find(r => r.commit.is_working_copy)
    const checked = checkedRevisions.size > 0 ? `${checkedRevisions.size} checked | ` : ''
    return `${checked}${count} revisions${wc ? ` | @ ${wc.commit.change_id.slice(0, 8)}` : ''}`
  })

  // --- Check management ---
  function toggleCheck(changeId: string, index: number) {
    if (checkedRevisions.has(changeId)) {
      checkedRevisions.delete(changeId)
    } else {
      checkedRevisions.add(changeId)
    }
    diffPanelRef?.resetCollapsed()
    lastCheckedIndex = index
  }

  function rangeCheck(fromIndex: number, toIndex: number) {
    const lo = Math.min(fromIndex, toIndex)
    const hi = Math.max(fromIndex, toIndex)
    for (let i = lo; i <= hi; i++) {
      if (i < revisions.length) {
        checkedRevisions.add(revisions[i].commit.change_id)
      }
    }
    diffPanelRef?.resetCollapsed()
    lastCheckedIndex = toIndex
  }

  function clearChecks() {
    checkedRevisions.clear()
    lastCheckedIndex = -1
  }

  // --- Error helper ---
  function showError(e: unknown) {
    error = e instanceof Error ? e.message : String(e)
  }

  function dismissError() {
    error = ''
  }

  // --- Command palette ---
  let commands: PaletteCommand[] = $derived.by(() => [
    { label: 'Refresh revisions', shortcut: 'r', action: () => loadLog() },
    { label: 'Undo last operation', shortcut: 'u', action: () => handleUndo() },
    { label: 'Git fetch', action: () => handleGitFetch() },
    { label: 'Git push', action: () => handleGitPush() },
    { label: 'Focus revset filter', shortcut: '/', action: () => revisionGraphRef?.focusRevsetInput() },
    { label: 'Clear revset filter', action: () => clearRevsetFilter(), when: () => revsetFilter !== '' },
    { label: 'Edit description', shortcut: 'e', action: () => startDescriptionEdit(), when: () => !!selectedRevision && checkedRevisions.size <= 1 },
    { label: 'New revision from selected', shortcut: 'n', action: () => {
      if (checkedRevisions.size > 0) handleNewFromChecked()
      else if (selectedRevision) handleNew(selectedRevision.commit.change_id)
    }, when: () => !!selectedRevision || checkedRevisions.size > 0 },
    { label: 'Edit selected revision', action: () => handleEdit(selectedRevision!.commit.change_id), when: () => !!selectedRevision },
    { label: 'Abandon selected revision', action: () => handleAbandon(selectedRevision!.commit.change_id), when: () => !!selectedRevision && checkedRevisions.size === 0 },
    { label: `Abandon ${checkedRevisions.size} checked revisions`, action: () => handleAbandonChecked(), when: () => checkedRevisions.size > 0 },
    { label: `New from ${checkedRevisions.size} checked revisions`, action: () => handleNewFromChecked(), when: () => checkedRevisions.size > 0 },
    { label: 'Clear all checked revisions', shortcut: 'Esc', action: () => {
      clearChecks()
      if (selectedRevision) { loadDiff(selectedRevision); loadFiles(selectedRevision) }
      else { diffContent = ''; changedFiles = [] }
    }, when: () => checkedRevisions.size > 0 },
    { label: 'Toggle split/unified diff view', action: () => { /* handled in DiffPanel */ } },
    { label: 'Toggle operation log', action: () => toggleOplog() },
    { label: 'Toggle evolution log for selected revision', action: () => toggleEvolog(), when: () => !!selectedRevision },
  ])

  // --- API actions ---
  async function loadLog() {
    loading = true
    error = ''
    try {
      revisions = await api.log(revsetFilter || undefined)
      if (selectedIndex < 0 || selectedIndex >= revisions.length) {
        selectedIndex = revisions.findIndex(r => r.commit.is_working_copy)
      }
      if (checkedRevisions.size > 0) {
        const validIds = new Set(revisions.map(r => r.commit.change_id))
        for (const id of [...checkedRevisions]) {
          if (!validIds.has(id)) checkedRevisions.delete(id)
        }
      }
      lastCheckedIndex = -1
      if (selectedIndex >= 0 && checkedRevisions.size === 0) {
        await Promise.all([loadDiff(revisions[selectedIndex]), loadFiles(revisions[selectedIndex])])
      }
    } catch (e) {
      showError(e)
    } finally {
      loading = false
    }
  }

  async function loadDiffForRevset(revset: string, file?: string) {
    const gen = ++diffGeneration
    diffLoading = true
    diffContent = ''
    try {
      const result = await api.diff(revset, file)
      if (gen !== diffGeneration) return
      diffContent = result.diff
    } catch (e) {
      if (gen !== diffGeneration) return
      diffContent = ''
      showError(e)
    } finally {
      if (gen === diffGeneration) diffLoading = false
    }
  }

  async function loadFilesForRevset(revset: string) {
    const gen = ++filesGeneration
    filesLoading = true
    changedFiles = []
    try {
      const result = await api.files(revset)
      if (gen !== filesGeneration) return
      changedFiles = result
    } catch (e) {
      if (gen !== filesGeneration) return
      changedFiles = []
      showError(e)
    } finally {
      if (gen === filesGeneration) filesLoading = false
    }
  }

  async function loadDiff(entry: LogEntry, file?: string) {
    await loadDiffForRevset(entry.commit.change_id, file)
  }

  async function loadFiles(entry: LogEntry) {
    await loadFilesForRevset(entry.commit.change_id)
  }

  async function selectRevision(index: number) {
    selectedIndex = index
    const entry = revisions[index]
    if (entry) {
      descriptionEditing = false
      diffPanelRef?.resetCollapsed()
      if (checkedRevisions.size === 0) {
        await Promise.all([loadDiff(entry), loadFiles(entry)])
      }
      if (evologOpen) {
        loadEvolog(entry.commit.change_id)
      }
    }
  }

  // Reload diff/files when checked revisions change
  $effect(() => {
    const checked = [...checkedRevisions]
    if (checked.length === 0) return
    const revset = checked.join('|')
    loadDiffForRevset(revset)
    loadFilesForRevset(revset)
  })

  async function handleAbandon(changeId: string) {
    try {
      const result = await api.abandon([changeId])
      lastAction = `Abandoned ${changeId.slice(0, 8)}`
      commandOutput = result.output
      await loadLog()
    } catch (e) {
      showError(e)
    }
  }

  async function handleAbandonChecked() {
    const revs = effectiveRevisions
    if (revs.length === 0) return
    try {
      const result = await api.abandon(revs)
      lastAction = revs.length > 1
        ? `Abandoned ${revs.length} revisions`
        : `Abandoned ${revs[0].slice(0, 8)}`
      commandOutput = result.output
      clearChecks()
      await loadLog()
    } catch (e) {
      showError(e)
    }
  }

  async function handleNew(changeId: string) {
    try {
      const result = await api.newRevision([changeId])
      lastAction = `Created new revision from ${changeId.slice(0, 8)}`
      commandOutput = result.output
      await loadLog()
    } catch (e) {
      showError(e)
    }
  }

  async function handleNewFromChecked() {
    const revs = effectiveRevisions
    if (revs.length === 0) return
    try {
      const result = await api.newRevision(revs)
      lastAction = revs.length > 1
        ? `Created new revision from ${revs.length} revisions`
        : `Created new revision from ${revs[0].slice(0, 8)}`
      commandOutput = result.output
      clearChecks()
      await loadLog()
    } catch (e) {
      showError(e)
    }
  }

  async function handleEdit(changeId: string) {
    try {
      const result = await api.edit(changeId)
      lastAction = `Editing ${changeId.slice(0, 8)}`
      commandOutput = result.output
      await loadLog()
    } catch (e) {
      showError(e)
    }
  }

  async function handleUndo() {
    try {
      const result = await api.undo()
      lastAction = 'Undo successful'
      commandOutput = result.output
      await loadLog()
    } catch (e) {
      showError(e)
    }
  }

  async function handleDescribe() {
    if (!selectedRevision) return
    try {
      const result = await api.describe(selectedRevision.commit.change_id, descriptionDraft)
      lastAction = `Updated description for ${selectedRevision.commit.change_id.slice(0, 8)}`
      commandOutput = result.output
      descriptionEditing = false
      describeSaved = true
      setTimeout(() => { describeSaved = false }, 1500)
      await loadLog()
    } catch (e) {
      showError(e)
    }
  }

  async function handleGitPush() {
    try {
      const result = await api.gitPush()
      lastAction = 'Git push complete'
      commandOutput = result.output
    } catch (e) {
      showError(e)
    }
  }

  async function handleGitFetch() {
    try {
      const result = await api.gitFetch()
      lastAction = 'Git fetch complete'
      commandOutput = result.output
      await loadLog()
    } catch (e) {
      showError(e)
    }
  }

  async function toggleOplog() {
    oplogOpen = !oplogOpen
    if (oplogOpen && oplogEntries.length === 0) {
      await loadOplog()
    }
  }

  async function loadOplog() {
    oplogLoading = true
    try {
      oplogEntries = await api.oplog(50)
    } catch (e) {
      showError(e)
    } finally {
      oplogLoading = false
    }
  }

  async function toggleEvolog() {
    evologOpen = !evologOpen
    if (evologOpen && selectedRevision) {
      await loadEvolog(selectedRevision.commit.change_id)
    }
  }

  async function loadEvolog(changeId: string) {
    evologLoading = true
    evologContent = ''
    try {
      const result = await api.evolog(changeId)
      evologContent = result.output
    } catch (e) {
      evologContent = ''
      showError(e)
    } finally {
      evologLoading = false
    }
  }

  async function startDescriptionEdit() {
    if (!selectedRevision) return
    try {
      const result = await api.description(selectedRevision.commit.change_id)
      descriptionDraft = result.description
    } catch {
      descriptionDraft = selectedRevision.description
    }
    descriptionEditing = true
    requestAnimationFrame(() => {
      const el = document.querySelector('.desc-editor textarea') as HTMLTextAreaElement
      el?.focus()
    })
  }

  function handleRevsetSubmit() {
    selectedIndex = -1
    changedFiles = []
    clearChecks()
    loadLog()
  }

  function clearRevsetFilter() {
    revsetFilter = ''
    handleRevsetSubmit()
  }

  // --- Keyboard shortcuts ---
  function handleKeydown(e: KeyboardEvent) {
    const target = e.target as HTMLElement

    // Cmd+K / Ctrl+K opens palette from anywhere
    if (e.key === 'k' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault()
      paletteRef?.show()
      return
    }

    // Handle Escape in revset input specially
    const revsetInputEl = revisionGraphRef?.getRevsetInputEl()
    if (target === revsetInputEl) {
      if (e.key === 'Escape') {
        e.preventDefault()
        revsetFilter = ''
        handleRevsetSubmit()
        revisionGraphRef?.blurRevsetInput()
        const listEl = document.querySelector('.revision-list') as HTMLElement
        listEl?.focus()
      }
      return
    }

    if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA') return

    switch (e.key) {
      case 'j':
        e.preventDefault()
        if (selectedIndex < revisions.length - 1) {
          selectRevision(selectedIndex + 1)
        }
        break
      case 'k':
        e.preventDefault()
        if (selectedIndex > 0) {
          selectRevision(selectedIndex - 1)
        }
        break
      case ' ':
        if (selectedRevision) {
          e.preventDefault()
          toggleCheck(selectedRevision.commit.change_id, selectedIndex)
        }
        break
      case 'Enter':
        if (selectedRevision) {
          e.preventDefault()
          loadDiff(selectedRevision)
        }
        break
      case 'u':
        e.preventDefault()
        handleUndo()
        break
      case 'r':
        e.preventDefault()
        loadLog()
        break
      case 'e':
        if (checkedRevisions.size > 1) {
          e.preventDefault()
          lastAction = 'Describe works on a single revision — clear checks first'
        } else if (selectedRevision) {
          e.preventDefault()
          startDescriptionEdit()
        }
        break
      case 'n':
        e.preventDefault()
        if (checkedRevisions.size > 0) {
          handleNewFromChecked()
        } else if (selectedRevision) {
          handleNew(selectedRevision.commit.change_id)
        }
        break
      case '/':
        e.preventDefault()
        revisionGraphRef?.focusRevsetInput()
        break
      case 'Escape':
        if (descriptionEditing) {
          descriptionEditing = false
        } else if (checkedRevisions.size > 0) {
          clearChecks()
          if (selectedRevision) {
            loadDiff(selectedRevision)
            loadFiles(selectedRevision)
          } else {
            diffContent = ''
            changedFiles = []
          }
        } else if (error) {
          dismissError()
        }
        break
    }
  }

  // Scroll selected revision into view
  function scrollSelectedIntoView(_index: number) {
    requestAnimationFrame(() => {
      const el = document.querySelector('.graph-row.node-row.selected')
      el?.scrollIntoView({ block: 'nearest' })
    })
  }

  $effect(() => {
    scrollSelectedIntoView(selectedIndex)
  })

  loadLog()
</script>

<svelte:window onkeydown={handleKeydown} />

<div class="app">
  <Toolbar
    onrefresh={loadLog}
    onundo={handleUndo}
    onfetch={handleGitFetch}
    onpush={handleGitPush}
    onopenpalette={() => paletteRef?.show()}
  />

  {#if error}
    <div class="error-bar" role="alert">
      <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
        <path d="M8 1a7 7 0 1 0 0 14A7 7 0 0 0 8 1zm0 10.5a.75.75 0 1 1 0-1.5.75.75 0 0 1 0 1.5zM8.75 4.5v4a.75.75 0 0 1-1.5 0v-4a.75.75 0 0 1 1.5 0z"/>
      </svg>
      <span class="error-text">{error}</span>
      <button class="error-dismiss" onclick={dismissError}>Dismiss</button>
    </div>
  {/if}

  <!-- Main content -->
  <div class="workspace">
    <RevisionGraph
      bind:this={revisionGraphRef}
      {revisions}
      {selectedIndex}
      {checkedRevisions}
      {loading}
      {revsetFilter}
      {lastCheckedIndex}
      onselect={selectRevision}
      oncheck={toggleCheck}
      onrangecheck={rangeCheck}
      onedit={handleEdit}
      onnew={handleNew}
      onabandon={handleAbandon}
      onnewfromchecked={handleNewFromChecked}
      onabandonchecked={handleAbandonChecked}
      onclearchecks={() => {
        clearChecks()
        if (selectedRevision) { loadDiff(selectedRevision); loadFiles(selectedRevision) }
        else { diffContent = ''; changedFiles = [] }
      }}
      onrevsetsubmit={handleRevsetSubmit}
      onrevsetclear={clearRevsetFilter}
      onrevsetchange={(v) => { revsetFilter = v }}
    />

    <DiffPanel
      bind:this={diffPanelRef}
      {diffContent}
      {changedFiles}
      {selectedRevision}
      {checkedRevisions}
      {diffLoading}
      {filesLoading}
      {descriptionEditing}
      {descriptionDraft}
      {describeSaved}
      onstartdescribe={startDescriptionEdit}
      ondescribe={handleDescribe}
      oncanceldescribe={() => { descriptionEditing = false }}
      ondraftchange={(v) => { descriptionDraft = v }}
    />
  </div>

  {#if evologOpen}
    <EvologPanel
      content={evologContent}
      loading={evologLoading}
      {selectedRevision}
      onrefresh={() => { if (selectedRevision) loadEvolog(selectedRevision.commit.change_id) }}
      onclose={() => { evologOpen = false }}
    />
  {/if}

  {#if oplogOpen}
    <OplogPanel
      entries={oplogEntries}
      loading={oplogLoading}
      onrefresh={loadOplog}
      onclose={() => { oplogOpen = false }}
    />
  {/if}

  <CommandPalette bind:this={paletteRef} {commands} />

  <StatusBar {statusText} {commandOutput} />
</div>

<style>
  /* --- Catppuccin Mocha palette --- */
  :root {
    --base: #1e1e2e;
    --mantle: #181825;
    --crust: #11111b;
    --surface0: #313244;
    --surface1: #45475a;
    --surface2: #585b70;
    --overlay0: #6c7086;
    --overlay1: #7f849c;
    --subtext0: #a6adc8;
    --subtext1: #bac2de;
    --text: #cdd6f4;
    --blue: #89b4fa;
    --green: #a6e3a1;
    --red: #f38ba8;
    --yellow: #f9e2af;
    --teal: #74c7ec;
  }

  /* --- Reset & Globals --- */
  :global(*) {
    box-sizing: border-box;
  }

  :global(body) {
    margin: 0;
    padding: 0;
    font-family: 'SF Mono', 'Cascadia Code', 'JetBrains Mono', 'Fira Code', 'Menlo', 'Consolas', monospace;
    font-size: 13px;
    background: var(--base);
    color: var(--text);
    overflow: hidden;
  }

  /* --- Layout --- */
  .app {
    display: flex;
    flex-direction: column;
    height: 100vh;
    overflow: hidden;
  }

  .workspace {
    display: flex;
    flex: 1;
    overflow: hidden;
  }

  /* --- Error bar --- */
  .error-bar {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 6px 12px;
    background: #45171a;
    border-bottom: 1px solid var(--red);
    color: var(--red);
    font-size: 12px;
    flex-shrink: 0;
  }

  .error-text {
    flex: 1;
  }

  .error-dismiss {
    background: transparent;
    border: 1px solid var(--red);
    color: var(--red);
    padding: 2px 8px;
    border-radius: 3px;
    cursor: pointer;
    font-family: inherit;
    font-size: 11px;
  }

  .error-dismiss:hover {
    background: #f38ba822;
  }
</style>
