<script lang="ts">
  import { config } from './config.svelte'
  import type FileEditor from './FileEditor.svelte'

  interface Props {
    open: boolean
    onclose: () => void
    onerror: (e: unknown) => void
  }

  let { open, onclose, onerror }: Props = $props()

  let content: string = $state('')
  let parseError: string = $state('')
  let loading: boolean = $state(true)
  let editorRef: ReturnType<typeof FileEditor> | undefined = $state(undefined)

  // Raw fetch — same rationale as config.svelte.ts (non-jj endpoint, no op-id).
  // /api/config/raw returns the on-disk bytes verbatim (or the template on
  // missing file), so the user sees comments they wrote and the commented
  // defaults on first open. No re-stringify.
  $effect(() => {
    if (!open) return
    loading = true
    parseError = ''
    fetch('/api/config/raw')
      .then(r => r.ok ? r.text() : Promise.reject(new Error(`HTTP ${r.status}`)))
      .then(text => { content = text })
      .catch(e => onerror(e))
      .finally(() => { loading = false })
  })

  async function save(text: string) {
    // Lazy-load jsonc-parser only when the user actually saves. Keeps main
    // bundle free of the ~30KB dep.
    const { parse: parseJsonc, printParseErrorCode } = await import('jsonc-parser')
    const errors: Array<{ error: number; offset: number; length: number }> = []
    const parsed = parseJsonc(text, errors, { allowTrailingComma: true }) as unknown
    if (errors.length > 0) {
      const e = errors[0]
      parseError = `${printParseErrorCode(e.error)} at offset ${e.offset}`
      return
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      parseError = 'config must be a JSONC object'
      return
    }
    parseError = ''
    try {
      const res = await fetch('/api/config/raw', {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain' },
        body: text,
      })
      if (!res.ok) throw new Error(await res.text() || `HTTP ${res.status}`)
      // Apply known keys to reactive state so theme/fontSize/etc take effect
      // immediately. The config save-effect then echoes to localStorage. Unknown
      // keys in `parsed` are ignored by applyPartial.
      config.applyPartial(parsed as Record<string, unknown>)
      onclose()
    } catch (e) {
      onerror(e)
    }
  }
</script>

{#if open}
  <div class="modal-backdrop" onclick={onclose} role="presentation"></div>
  <div class="modal config-modal" role="dialog" aria-label="Edit config">
    <div class="modal-header">
      <span>Config <span class="path">~/.config/lightjj/config.json</span></span>
      <span class="hint"><kbd class="nav-hint">⌘S</kbd> save · <kbd class="nav-hint">Esc</kbd> cancel</span>
    </div>
    {#if loading}
      <div class="placeholder-text body">Loading…</div>
    {:else}
      <div class="body">
        {#await import('./FileEditor.svelte') then { default: FileEditor }}
          <FileEditor
            bind:this={editorRef}
            {content}
            filePath="config.json"
            changedRanges={[]}
            onsave={save}
            oncancel={onclose}
          />
        {/await}
      </div>
    {/if}
    {#if parseError}
      <div class="parse-error">{parseError}</div>
    {/if}
    <div class="footer">
      <a class="docs-link" href="https://github.com/chronologos/lightjj/blob/main/docs/CONFIG.md" target="_blank" rel="noreferrer">Field reference ↗</a>
      <div class="actions">
        <button class="btn" onclick={onclose}>Cancel</button>
        <button class="btn btn-primary" onclick={() => save(editorRef?.getContent() ?? content)}>Save</button>
      </div>
    </div>
  </div>
{/if}

<style>
  .config-modal {
    width: 640px;
    max-height: 70vh;
    top: 12%;
  }
  .body {
    flex: 1;
    min-height: 240px;
    display: flex;
    overflow: hidden;
  }
  .path {
    font-family: var(--font-mono);
    font-size: var(--fs-xs);
    color: var(--overlay0);
    text-transform: none;
    letter-spacing: 0;
    margin-left: 8px;
  }
  .hint {
    font-size: var(--fs-xs);
    color: var(--overlay0);
    text-transform: none;
    letter-spacing: 0;
    font-weight: 400;
  }
  .parse-error {
    padding: 6px 16px;
    background: var(--bg-error);
    color: var(--red);
    font-family: var(--font-mono);
    font-size: var(--fs-sm);
    border-top: 1px solid var(--surface0);
  }
  .footer {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 8px 16px;
    border-top: 1px solid var(--surface0);
  }
  .actions { display: flex; gap: 8px; }
  .docs-link {
    color: var(--subtext0);
    font-size: var(--fs-sm);
    text-decoration: none;
  }
  .docs-link:hover { color: var(--text); text-decoration: underline; }
</style>
