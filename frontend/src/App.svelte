<script lang="ts">
  import { SvelteSet } from 'svelte/reactivity'
  import { api, isCached, onStale, type LogEntry, type FileChange, type OpEntry } from './lib/api'
  import type { PaletteCommand } from './lib/CommandPalette.svelte'
  import Toolbar from './lib/Toolbar.svelte'
  import StatusBar from './lib/StatusBar.svelte'
  import CommandPalette from './lib/CommandPalette.svelte'
  import RevisionGraph from './lib/RevisionGraph.svelte'
  import DiffPanel from './lib/DiffPanel.svelte'
  import EvologPanel from './lib/EvologPanel.svelte'
  import OplogPanel from './lib/OplogPanel.svelte'
  import BookmarkModal, { type BookmarkOp } from './lib/BookmarkModal.svelte'
  import BookmarkInput from './lib/BookmarkInput.svelte'

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
  let splitView: boolean = $state(false)
  let checkedRevisions = new SvelteSet<string>()
  let lastCheckedIndex: number = $state(-1)
  // Non-reactive generation counters for async cancellation
  let diffGeneration: number = 0
  let filesGeneration: number = 0
  let evologGeneration: number = 0
  // Debounce timer for diff/files loading during rapid j/k navigation
  let navDebounceTimer: number | undefined
  let evologOpen: boolean = $state(false)
  let evologContent: string = $state('')
  let evologLoading: boolean = $state(false)
  let oplogOpen: boolean = $state(false)
  let oplogEntries: OpEntry[] = $state([])
  let oplogLoading: boolean = $state(false)

  let paletteOpen: boolean = $state(false)
  let bookmarkModalOpen: boolean = $state(false)
  let bookmarkModalFilter: string = $state('')
  let bookmarkInputOpen: boolean = $state(false)

  // --- Theme ---
  let darkMode: boolean = $state(localStorage.getItem('jj-web-theme') !== 'light')

  function toggleTheme() {
    darkMode = !darkMode
    document.documentElement.classList.toggle('light', !darkMode)
    localStorage.setItem('jj-web-theme', darkMode ? 'dark' : 'light')
    diffPanelRef?.rehighlight()
  }

  // Apply saved theme on load
  if (localStorage.getItem('jj-web-theme') === 'light') document.documentElement.classList.add('light')

  // --- Refs ---
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

  function clearChecksAndReload() {
    clearChecks()
    if (selectedRevision) loadDiffAndFiles(selectedRevision.commit.change_id)
    else { diffContent = ''; changedFiles = [] }
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
    { label: 'Clear all checked revisions', shortcut: 'Esc', action: clearChecksAndReload, when: () => checkedRevisions.size > 0 },
    { label: 'Toggle split/unified diff view', action: () => { splitView = !splitView } },
    { label: 'Toggle operation log', action: () => toggleOplog() },
    { label: 'Toggle evolution log for selected revision', action: () => toggleEvolog(), when: () => !!selectedRevision },
    { label: darkMode ? 'Switch to light theme' : 'Switch to dark theme', action: () => toggleTheme() },
    { label: 'Set bookmark on revision', shortcut: 'B', action: () => { bookmarkInputOpen = true }, when: () => !!selectedRevision && checkedRevisions.size === 0 },
    { label: 'Bookmark operations', shortcut: 'b', action: () => openBookmarkModal() },
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
        loadDiffAndFiles(revisions[selectedIndex].commit.change_id)
      }
    } catch (e) {
      showError(e)
    } finally {
      loading = false
    }
  }

  async function loadDiffForRevset(revset: string, file?: string) {
    const gen = ++diffGeneration
    if (!isCached(revset)) diffLoading = true
    try {
      const result = await api.diff(revset, file)
      if (gen !== diffGeneration) return
      if (diffContent !== result.diff) diffContent = result.diff
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
    if (!isCached(revset)) filesLoading = true
    try {
      const result = await api.files(revset)
      if (gen !== filesGeneration) return
      if (changedFiles !== result) changedFiles = result
    } catch (e) {
      if (gen !== filesGeneration) return
      changedFiles = []
      showError(e)
    } finally {
      if (gen === filesGeneration) filesLoading = false
    }
  }

  function loadDiffAndFiles(changeId: string) {
    loadDiffForRevset(changeId)
    loadFilesForRevset(changeId)
  }

  function selectRevision(index: number) {
    selectedIndex = index
    descriptionEditing = false

    const entry = revisions[index]
    if (!entry) return

    // Debounce diff/files loading: highlight moves instantly, but fetches
    // wait for navigation to settle. Cache hits skip the debounce.
    clearTimeout(navDebounceTimer)
    const cached = isCached(entry.commit.change_id)
    if (checkedRevisions.size === 0) {
      if (cached) {
        loadDiffAndFiles(entry.commit.change_id)
      } else {
        navDebounceTimer = setTimeout(() => {
          const current = revisions[selectedIndex]
          if (current) {
            loadDiffAndFiles(current.commit.change_id)
            if (evologOpen) loadEvolog(current.commit.change_id)
          }
        }, 50)
        return // evolog deferred with the rest
      }
    }
    if (evologOpen) {
      loadEvolog(entry.commit.change_id)
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
      await loadLog() // push may update remote tracking bookmarks
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

  async function handleBookmarkSet(name: string) {
    if (!selectedRevision) return
    try {
      const result = await api.bookmarkSet(selectedRevision.commit.change_id, name)
      bookmarkInputOpen = false
      lastAction = `Set bookmark ${name}`
      commandOutput = result.output
      await loadLog()
    } catch (e) {
      showError(e)
    }
  }

  async function handleBookmarkOp(op: BookmarkOp) {
    if (op.action === 'move' && !selectedRevision) return
    try {
      const changeId = selectedRevision?.commit.change_id ?? ''
      const actions: Record<BookmarkOp['action'], () => Promise<{ output: string }>> = {
        move: () => api.bookmarkMove(op.bookmark, changeId),
        delete: () => api.bookmarkDelete(op.bookmark),
        forget: () => api.bookmarkForget(op.bookmark),
        track: () => api.bookmarkTrack(op.bookmark, op.remote!),
        untrack: () => api.bookmarkUntrack(op.bookmark, op.remote!),
      }
      const result = await actions[op.action]()
      bookmarkModalOpen = false
      lastAction = `${op.action} ${op.bookmark}`
      commandOutput = result.output
      await loadLog()
    } catch (e) {
      showError(e)
    }
  }

  function openBookmarkModal(filter?: string) {
    bookmarkModalFilter = filter ?? ''
    bookmarkModalOpen = true
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
    const gen = ++evologGeneration
    evologLoading = true
    evologContent = ''
    try {
      const result = await api.evolog(changeId)
      if (gen !== evologGeneration) return
      evologContent = result.output
    } catch (e) {
      if (gen !== evologGeneration) return
      evologContent = ''
      showError(e)
    } finally {
      if (gen === evologGeneration) evologLoading = false
    }
  }

  async function startDescriptionEdit() {
    if (!selectedRevision) return
    try {
      const result = await api.description(selectedRevision.commit.change_id)
      descriptionDraft = result.description
    } catch (e) {
      // Fall back to cached description but warn the user
      descriptionDraft = selectedRevision.description
      lastAction = 'Using cached description (could not fetch latest)'
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
      paletteOpen = true
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
          loadDiffAndFiles(selectedRevision.commit.change_id)
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
      case 'b':
        e.preventDefault()
        openBookmarkModal()
        break
      case 'B':
        if (selectedRevision && checkedRevisions.size === 0) {
          e.preventDefault()
          bookmarkInputOpen = true
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
          clearChecksAndReload()
        } else if (error) {
          dismissError()
        }
        break
    }
  }

  // Auto-refresh when jj state changes outside the UI (detected via op-id header).
  // Skip if a loadLog is already in progress (mutation handlers call loadLog explicitly).
  onStale(() => {
    if (!loading) loadLog()
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
    onopenpalette={() => { paletteOpen = true }}
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
      onclearchecks={clearChecksAndReload}
      onrevsetsubmit={handleRevsetSubmit}
      onrevsetclear={clearRevsetFilter}
      onrevsetchange={(v) => { revsetFilter = v }}
      onrevsetescaped={clearRevsetFilter}
      onbookmarkclick={openBookmarkModal}
    />

    <DiffPanel
      bind:this={diffPanelRef}
      {diffContent}
      {changedFiles}
      {selectedRevision}
      {checkedRevisions}
      {diffLoading}
      {filesLoading}
      bind:splitView
      {descriptionEditing}
      {descriptionDraft}
      {describeSaved}
      onstartdescribe={startDescriptionEdit}
      ondescribe={handleDescribe}
      oncanceldescribe={() => { descriptionEditing = false }}
      ondraftchange={(v) => { descriptionDraft = v }}
      onbookmarkclick={openBookmarkModal}
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

  <CommandPalette bind:open={paletteOpen} {commands} />

  <BookmarkInput
    bind:open={bookmarkInputOpen}
    onsave={handleBookmarkSet}
    oncancel={() => { bookmarkInputOpen = false }}
  />

  <BookmarkModal
    bind:open={bookmarkModalOpen}
    currentCommitId={selectedRevision?.commit.commit_id ?? null}
    filterBookmark={bookmarkModalFilter}
    onexecute={handleBookmarkOp}
    onclose={() => { bookmarkModalOpen = false }}
  />

  <StatusBar {statusText} {commandOutput} />
</div>

<style>
  /* --- Catppuccin Mocha (dark) --- */
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

    /* Semantic tinted backgrounds */
    --bg-hover: #262637;
    --bg-selected: #2a2a40;
    --bg-checked: #1e2a1e;
    --bg-checked-selected: #243024;
    --bg-error: #45171a;
    --bg-error-hover: #f38ba822;
    --bg-bookmark: #1e3a2a;
    --border-bookmark: #2d5a3d;
    --bg-diff-header-hover: #1e1e30;
    --bg-hunk-header: #1a1a2e;
    --border-hunk-header: #21212e;
    --bg-diff-empty: #1a1a2a;
    --bg-active: #89b4fa22;
    --bg-btn-primary-hover: #b4d0fb;
    --bg-btn-kbd: #1e1e2e33;
    --wc-desc-color: #e0e0e0;

    /* Diff line backgrounds */
    --diff-add-bg: #a6e3a112;
    --diff-remove-bg: #f38ba812;
    --diff-add-word: #a6e3a133;
    --diff-remove-word: #f38ba833;

    /* File type badge backgrounds */
    --badge-add-bg: #a6e3a120;
    --badge-modify-bg: #89b4fa20;
    --badge-delete-bg: #f38ba820;
    --badge-other-bg: #f9e2af20;

    /* Palette overlay */
    --backdrop: #00000066;
    --shadow-heavy: 0 16px 48px #00000088;
  }

  /* --- Catppuccin Latte (light) --- */
  :root.light {
    --base: #eff1f5;
    --mantle: #e6e9ef;
    --crust: #dce0e8;
    --surface0: #ccd0da;
    --surface1: #bcc0cc;
    --surface2: #acb0be;
    --overlay0: #9ca0b0;
    --overlay1: #8c8fa1;
    --subtext0: #6c6f85;
    --subtext1: #5c5f77;
    --text: #4c4f69;
    --blue: #1e66f5;
    --green: #40a02b;
    --red: #d20f39;
    --yellow: #df8e1d;
    --teal: #04a5e5;

    --bg-hover: #d9dbe5;
    --bg-selected: #cbd0e0;
    --bg-checked: #d4e8d0;
    --bg-checked-selected: #c0ddb8;
    --bg-error: #fce4e8;
    --bg-error-hover: #d20f3918;
    --bg-bookmark: #d8f0d0;
    --border-bookmark: #90c480;
    --bg-diff-header-hover: #d8dae5;
    --bg-hunk-header: #d5d8e2;
    --border-hunk-header: #c8ccd8;
    --bg-diff-empty: #e0e2ea;
    --bg-active: #1e66f522;
    --bg-btn-primary-hover: #1555d0;
    --bg-btn-kbd: #ffffff55;
    --wc-desc-color: #2a2d3a;

    --diff-add-bg: #40a02b15;
    --diff-remove-bg: #d20f3915;
    --diff-add-word: #40a02b30;
    --diff-remove-word: #d20f3930;

    --badge-add-bg: #40a02b20;
    --badge-modify-bg: #1e66f520;
    --badge-delete-bg: #d20f3920;
    --badge-other-bg: #df8e1d20;

    --backdrop: #00000033;
    --shadow-heavy: 0 16px 48px #00000044;
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
    background: var(--bg-error);
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
    background: var(--bg-error-hover);
  }
</style>
