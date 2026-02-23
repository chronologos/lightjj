<script lang="ts">
  import { api, type LogEntry } from './lib/api'

  let revisions: LogEntry[] = $state([])
  let selectedRevision: LogEntry | null = $state(null)
  let diffContent: string = $state('')
  let error: string = $state('')
  let loading: boolean = $state(true)

  async function loadLog() {
    loading = true
    error = ''
    try {
      revisions = await api.log()
    } catch (e) {
      error = e instanceof Error ? e.message : String(e)
    } finally {
      loading = false
    }
  }

  async function selectRevision(entry: LogEntry) {
    selectedRevision = entry
    try {
      const result = await api.diff(entry.change_id)
      diffContent = result.diff
    } catch (e) {
      diffContent = e instanceof Error ? e.message : String(e)
    }
  }

  async function handleAbandon(changeId: string) {
    try {
      await api.abandon([changeId])
      await loadLog()
      selectedRevision = null
      diffContent = ''
    } catch (e) {
      error = e instanceof Error ? e.message : String(e)
    }
  }

  async function handleNew(changeId: string) {
    try {
      await api.newRevision([changeId])
      await loadLog()
    } catch (e) {
      error = e instanceof Error ? e.message : String(e)
    }
  }

  async function handleUndo() {
    try {
      await api.undo()
      await loadLog()
    } catch (e) {
      error = e instanceof Error ? e.message : String(e)
    }
  }

  loadLog()
</script>

<main>
  <header>
    <h1>jj-web</h1>
    <div class="actions">
      <button onclick={loadLog}>Refresh</button>
      <button onclick={handleUndo}>Undo</button>
    </div>
  </header>

  {#if error}
    <div class="error">{error}</div>
  {/if}

  <div class="layout">
    <section class="revisions">
      <h2>Revisions</h2>
      {#if loading}
        <p class="muted">Loading...</p>
      {:else if revisions.length === 0}
        <p class="muted">No revisions</p>
      {:else}
        <ul>
          {#each revisions as entry}
            <li
              class:selected={selectedRevision?.change_id === entry.change_id}
              class:working-copy={entry.is_working_copy}
              class:hidden-rev={entry.hidden}
            >
              <button class="revision-row" onclick={() => selectRevision(entry)}>
                <span class="change-id">{entry.change_id}</span>
                <span class="description">{entry.description || '(no description)'}</span>
                {#if entry.bookmarks?.length}
                  <span class="bookmarks">
                    {#each entry.bookmarks as bm}
                      <span class="bookmark">{bm}</span>
                    {/each}
                  </span>
                {/if}
                {#if entry.is_working_copy}
                  <span class="badge wc">@</span>
                {/if}
              </button>
              <div class="revision-actions">
                <button onclick={() => handleNew(entry.change_id)} title="New child">+</button>
                <button onclick={() => handleAbandon(entry.change_id)} title="Abandon">×</button>
              </div>
            </li>
          {/each}
        </ul>
      {/if}
    </section>

    <section class="detail">
      {#if selectedRevision}
        <h2>
          {selectedRevision.change_id}
          <span class="commit-id">{selectedRevision.commit_id}</span>
        </h2>
        <pre class="diff">{diffContent || '(no changes)'}</pre>
      {:else}
        <p class="muted">Select a revision to view its diff</p>
      {/if}
    </section>
  </div>
</main>

<style>
  :global(body) {
    margin: 0;
    font-family: 'SF Mono', 'Menlo', 'Consolas', monospace;
    background: #1a1a2e;
    color: #e0e0e0;
  }

  main {
    max-width: 1400px;
    margin: 0 auto;
    padding: 1rem;
  }

  header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    border-bottom: 1px solid #333;
    padding-bottom: 0.5rem;
    margin-bottom: 1rem;
  }

  h1 { margin: 0; font-size: 1.2rem; color: #7c8dff; }
  h2 { margin: 0 0 0.5rem; font-size: 1rem; }

  .actions { display: flex; gap: 0.5rem; }

  button {
    background: #2a2a4a;
    color: #e0e0e0;
    border: 1px solid #444;
    padding: 0.3rem 0.6rem;
    border-radius: 4px;
    cursor: pointer;
    font-family: inherit;
    font-size: 0.85rem;
  }
  button:hover { background: #3a3a5a; }

  .error {
    background: #4a1a1a;
    color: #ff6b6b;
    padding: 0.5rem;
    border-radius: 4px;
    margin-bottom: 1rem;
  }

  .layout {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 1rem;
    height: calc(100vh - 8rem);
  }

  .revisions, .detail {
    overflow-y: auto;
    border: 1px solid #333;
    border-radius: 4px;
    padding: 0.5rem;
  }

  ul { list-style: none; padding: 0; margin: 0; }

  li {
    display: flex;
    align-items: center;
    border-bottom: 1px solid #222;
  }
  li:hover { background: #2a2a3a; }
  li.selected { background: #2a2a4a; }
  li.working-copy .change-id { color: #4ade80; }
  li.hidden-rev { opacity: 0.5; }

  .revision-row {
    flex: 1;
    display: flex;
    gap: 0.5rem;
    align-items: center;
    background: none;
    border: none;
    text-align: left;
    padding: 0.4rem;
    color: inherit;
  }
  .revision-row:hover { background: none; }

  .change-id {
    color: #7c8dff;
    font-weight: bold;
    min-width: 8ch;
  }

  .commit-id {
    color: #888;
    font-size: 0.85rem;
    font-weight: normal;
  }

  .description {
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .bookmark {
    background: #3a5a3a;
    color: #8fffaa;
    padding: 0.1rem 0.4rem;
    border-radius: 3px;
    font-size: 0.75rem;
  }

  .badge.wc {
    color: #4ade80;
    font-weight: bold;
  }

  .revision-actions {
    display: flex;
    gap: 0.2rem;
  }
  .revision-actions button {
    padding: 0.2rem 0.4rem;
    font-size: 0.8rem;
  }

  .diff {
    background: #111;
    padding: 1rem;
    border-radius: 4px;
    overflow: auto;
    white-space: pre-wrap;
    font-size: 0.85rem;
    line-height: 1.4;
  }

  .muted { color: #666; }
</style>
