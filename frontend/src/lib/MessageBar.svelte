<script module lang="ts">
  export interface Message {
    kind: 'error' | 'warning' | 'success'
    text: string
    /** Multi-line jj output; presence triggers the [+N] expand affordance. */
    details?: string
  }

  /** Unknown → error Message. Shared coercion for catch blocks. */
  export const errorMessage = (e: unknown): Message =>
    ({ kind: 'error', text: e instanceof Error ? e.message : String(e) })
</script>

<script lang="ts">
  interface Props {
    message: Message
    expanded?: boolean
    onDismiss: () => void
    /** Omit to hide the expand affordance entirely (e.g. shell errors never
     *  have details, so AppShell passes only onDismiss). */
    onExpandToggle?: () => void
  }
  let { message, expanded = false, onDismiss, onExpandToggle }: Props = $props()

  const icons = { error: '✕', warning: '⚠', success: '✓' }
  // Count newlines (no array alloc) — only reachable when details is set.
  let detailLines = $derived(message.details ? (message.details.match(/\n/g)?.length ?? 0) + 1 : 0)

  function copyDetails() {
    if (message.details) navigator.clipboard.writeText(message.details)
  }
</script>

<div class="message-bar kind-{message.kind}">
  <div class="message-main">
    <span class="message-icon" aria-hidden="true">{icons[message.kind]}</span>
    <span class="message-text" role={message.kind === 'success' ? 'status' : 'alert'}>{message.text}</span>
    {#if message.details && onExpandToggle}
      <button
        class="expand-badge"
        onclick={onExpandToggle}
        aria-expanded={expanded}
        aria-label={expanded ? 'Hide details' : `Show details (${detailLines} lines)`}
      >
        {expanded ? '−' : `+${detailLines}`}
      </button>
    {/if}
    <button class="dismiss" onclick={onDismiss} aria-label="Dismiss">✕</button>
  </div>
  {#if expanded && message.details}
    <div class="message-details">
      <pre>{message.details}</pre>
      <div class="details-actions">
        <button class="detail-btn" onclick={copyDetails}>Copy</button>
      </div>
    </div>
  {/if}
</div>

<style>
  .message-bar {
    display: flex;
    flex-direction: column;
    background: var(--msg-bg);
    /* Left accent stripe: primary visual anchor — stays saturated even when
       bg is subtle. Bottom border separates from workspace content. */
    border-left: 3px solid var(--msg-fg);
    border-bottom: 1px solid color-mix(in srgb, var(--msg-fg) 30%, transparent);
    color: var(--msg-fg);
    font-size: 12px;
    flex-shrink: 0;
    animation: slide-down var(--anim-duration) var(--anim-ease);
  }

  .kind-error   { --msg-fg: var(--red);   --msg-bg: var(--bg-error); }
  .kind-warning { --msg-fg: var(--amber); --msg-bg: var(--bg-warning); }
  .kind-success { --msg-fg: var(--green); --msg-bg: var(--bg-success); }

  .message-main {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 6px 12px;
  }

  .message-icon {
    font-weight: 700;
    flex-shrink: 0;
  }

  .message-text {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .expand-badge {
    background: transparent;
    border: 1px solid var(--msg-fg);
    color: var(--msg-fg);
    padding: 0 6px;
    border-radius: 3px;
    cursor: pointer;
    font-family: inherit;
    font-size: 10px;
    font-weight: 600;
    line-height: 1.5;
  }

  .expand-badge:hover {
    background: color-mix(in srgb, var(--msg-fg) 15%, transparent);
  }

  .dismiss {
    background: transparent;
    border: 1px solid var(--msg-fg);
    color: var(--msg-fg);
    padding: 2px 8px;
    border-radius: 3px;
    cursor: pointer;
    font-family: inherit;
    font-size: 11px;
  }

  .dismiss:hover {
    background: color-mix(in srgb, var(--msg-fg) 15%, transparent);
  }

  .message-details {
    border-top: 1px solid color-mix(in srgb, var(--msg-fg) 30%, transparent);
    padding: 6px 12px;
    position: relative;
  }

  .message-details pre {
    margin: 0;
    font-family: var(--font-mono);
    font-size: 11px;
    color: var(--text);
    max-height: 30vh;
    overflow-y: auto;
    white-space: pre-wrap;
    word-break: break-word;
  }

  .details-actions {
    position: absolute;
    top: 6px;
    right: 12px;
    display: flex;
    gap: 4px;
  }

  .detail-btn {
    background: var(--surface0);
    border: 1px solid var(--surface1);
    color: var(--subtext0);
    padding: 2px 8px;
    border-radius: 3px;
    cursor: pointer;
    font-family: inherit;
    font-size: 10px;
  }

  .detail-btn:hover {
    background: var(--surface1);
    color: var(--text);
  }

  .expand-badge:focus-visible,
  .dismiss:focus-visible,
  .detail-btn:focus-visible {
    outline: 2px solid var(--msg-fg);
    outline-offset: 1px;
  }
</style>
