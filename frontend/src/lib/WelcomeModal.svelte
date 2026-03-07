<script lang="ts">
  import type { TutorialFeature } from './tutorial-content'
  import { CURRENT_RELEASE_URL, RELEASES_URL } from './version'

  interface Props {
    version: string
    features: TutorialFeature[]
    title: string
    onclose: () => void
  }

  let { version, features, title, onclose }: Props = $props()

  let modalEl: HTMLDivElement | undefined = $state(undefined)

  $effect(() => {
    if (modalEl) modalEl.focus()
  })

  function handleKeydown(e: KeyboardEvent) {
    e.stopPropagation()
    if (e.key === 'Escape' || e.key === 'Enter') {
      e.preventDefault()
      onclose()
    }
  }
</script>

<div class="welcome-backdrop" role="presentation" onclick={onclose}></div>
<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class="welcome-modal" bind:this={modalEl} onkeydown={handleKeydown} tabindex="-1">
  <div class="welcome-header">{title}</div>
  <div class="welcome-features">
    {#each features as f}
      <div class="welcome-feature">
        {#if f.shortcut}
          <kbd class="welcome-kbd">{f.shortcut}</kbd>
        {:else}
          <span class="welcome-kbd-placeholder"></span>
        {/if}
        <div>
          <div class="welcome-feature-title">{f.title}</div>
          <div class="welcome-feature-desc">{f.description}</div>
        </div>
      </div>
    {/each}
  </div>
  <div class="welcome-footer">
    <div class="welcome-links">
      <a href={CURRENT_RELEASE_URL} target="_blank" rel="noopener">Changelog for v{version}</a>
      <span class="welcome-link-sep">·</span>
      <a href={RELEASES_URL} target="_blank" rel="noopener">All releases</a>
    </div>
    <button class="welcome-dismiss" onclick={onclose}>Got it</button>
  </div>
</div>

<style>
  .welcome-backdrop {
    position: fixed;
    inset: 0;
    background: var(--backdrop);
    z-index: 100;
  }

  .welcome-modal {
    position: fixed;
    top: 12%;
    left: 50%;
    transform: translateX(-50%);
    width: 480px;
    max-height: 76vh;
    display: flex;
    flex-direction: column;
    background: var(--base);
    border: 1px solid var(--surface1);
    border-radius: 12px;
    box-shadow: var(--shadow-heavy);
    z-index: 101;
    outline: none;
    overflow: hidden;
  }

  .welcome-header {
    padding: 20px 24px 12px;
    font-size: 16px;
    font-weight: 600;
    color: var(--text);
  }

  .welcome-features {
    padding: 4px 24px 16px;
    overflow-y: auto;
    display: flex;
    flex-direction: column;
    gap: 10px;
  }

  .welcome-feature {
    display: flex;
    align-items: flex-start;
    gap: 12px;
  }

  .welcome-kbd {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-width: 48px;
    padding: 2px 8px;
    background: var(--surface0);
    border: 1px solid var(--surface1);
    border-radius: 4px;
    font-family: var(--font-mono);
    font-size: 11px;
    color: var(--subtext0);
    white-space: nowrap;
    flex-shrink: 0;
    margin-top: 1px;
  }

  .welcome-kbd-placeholder {
    display: inline-block;
    min-width: 48px;
    flex-shrink: 0;
  }

  .welcome-feature-title {
    font-size: 13px;
    font-weight: 600;
    color: var(--text);
  }

  .welcome-feature-desc {
    font-size: 12px;
    color: var(--subtext0);
    line-height: 1.4;
  }

  .welcome-footer {
    padding: 12px 24px 16px;
    display: flex;
    flex-direction: column;
    gap: 10px;
  }

  .welcome-links {
    font-size: 11px;
    text-align: center;
    color: var(--subtext0);
  }

  .welcome-links a {
    color: var(--subtext0);
    text-decoration: none;
  }

  .welcome-links a:hover {
    color: var(--text);
    text-decoration: underline;
  }

  .welcome-link-sep {
    margin: 0 6px;
  }

  .welcome-dismiss {
    width: 100%;
    padding: 8px;
    background: var(--amber);
    color: var(--base);
    border: none;
    border-radius: 6px;
    font-family: inherit;
    font-size: 13px;
    font-weight: 600;
    cursor: pointer;
  }

  .welcome-dismiss:hover {
    filter: brightness(1.1);
  }
</style>
