<script lang="ts">
  import type { LogEntry, PullRequest } from './api'
  import DescriptionEditor from './DescriptionEditor.svelte'

  interface Props {
    revision: LogEntry
    fullDescription: string
    descriptionEditing: boolean
    descriptionDraft: string
    commitMode: boolean
    prByBookmark: Map<string, PullRequest>
    onstartdescribe: () => void
    ondescribe: () => void
    oncanceldescribe: () => void
    ondraftchange: (value: string) => void
    onbookmarkclick: (name: string) => void
    onresolveDivergence: () => void
  }

  let {
    revision, fullDescription, descriptionEditing, descriptionDraft,
    commitMode, prByBookmark, onstartdescribe, ondescribe, oncanceldescribe,
    ondraftchange, onbookmarkclick, onresolveDivergence,
  }: Props = $props()

  // descExpanded resets on navigation via {#key} in App.svelte (component
  // remounts). No manual reset effect — Svelte 5.50+ flags the previous-value
  // sentinel pattern as state_referenced_locally.
  let descExpanded = $state(false)
  let descText = $derived(fullDescription || revision.description || '(no description)')
  let descIsMultiline = $derived(descText.includes('\n'))
</script>

<div class="revision-detail">
  <div class="detail-header">
    <div class="detail-ids">
      <span class="detail-change-id">{revision.commit.change_id.slice(0, 8)}</span>
      <span
        class="detail-description-inline"
        class:desc-collapsed={descIsMultiline && !descExpanded}
      >{descText}</span>
    </div>
    <div class="panel-actions">
      {#if descIsMultiline}
        <button class="header-btn desc-expand-btn" onclick={() => descExpanded = !descExpanded} title={descExpanded ? 'Collapse description' : 'Expand description'}>
          <svg class="desc-expand-icon" class:desc-expand-open={descExpanded} width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="3,4.5 6,7.5 9,4.5"/></svg>
        </button>
      {/if}
      <button class="header-btn" onclick={onstartdescribe} title="Edit description (e)">
        Describe
      </button>
      {#if revision.commit.divergent}
        <button class="header-btn divergent-btn" onclick={onresolveDivergence} title="Resolve divergent commit">
          Divergence
        </button>
      {/if}
    </div>
  </div>
  {#if revision.bookmarks?.length}
    <div class="detail-bookmarks">
      {#each revision.bookmarks as bm}
        {@const pr = prByBookmark.get(bm.name)}
        {#if pr}
          <a class="detail-pr-badge" class:is-draft={pr.is_draft} class:conflicted={bm.conflict}
             href={pr.url} target="_blank" rel="noopener"
             title="{pr.is_draft ? 'Draft ' : ''}PR #{pr.number} — click to open on GitHub">
            <span class="pr-name">↗ {bm.name}{#if bm.conflict}<span class="conflict-marker">??</span>{/if}</span>
            <span class="pr-number">#{pr.number}</span>
          </a>
        {:else}
          <button class="detail-bookmark-badge" class:conflicted={bm.conflict}
             onclick={() => onbookmarkclick(bm.name)}
             title={bm.conflict ? 'Conflicted — this bookmark points at multiple commits' : undefined}>⑂ {bm.name}{#if bm.conflict}<span class="conflict-marker">??</span>{/if}</button>
        {/if}
      {/each}
    </div>
  {/if}
</div>
{#if descriptionEditing}
  <DescriptionEditor
    {revision}
    draft={descriptionDraft}
    onsave={ondescribe}
    oncancel={oncanceldescribe}
    {ondraftchange}
    {commitMode}
  />
{/if}

<style>
  .revision-detail {
    padding: 8px 12px;
    background: var(--mantle);
    border-bottom: 1px solid var(--surface0);
    flex-shrink: 0;
    font-size: 11px;
    display: flex;
    flex-direction: column;
    gap: 4px;
  }

  .detail-header {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 8px;
  }

  .detail-ids {
    display: flex;
    align-items: baseline;
    gap: 8px;
    min-width: 0;
    flex: 1;
  }

  .detail-change-id {
    font-family: var(--font-mono);
    color: var(--amber);
    font-weight: 600;
    font-size: 12px;
    flex-shrink: 0;
  }

  .detail-description-inline {
    color: var(--text);
    font-size: 12px;
    min-width: 0;
    white-space: pre-wrap;
    word-break: break-word;
  }

  .detail-description-inline.desc-collapsed {
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .panel-actions {
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .header-btn {
    background: transparent;
    border: 1px solid var(--surface1);
    color: var(--subtext0);
    padding: 2px 8px;
    border-radius: 3px;
    cursor: pointer;
    font-family: inherit;
    font-size: 11px;
    transition: all 0.15s ease;
  }

  .header-btn:hover {
    background: var(--surface0);
    color: var(--text);
  }

  .divergent-btn {
    color: var(--red);
    border-color: var(--red);
  }

  .divergent-btn:hover {
    background: rgba(235, 100, 100, 0.15);
  }

  .desc-expand-btn {
    padding: 2px 4px;
  }

  .desc-expand-icon {
    display: block;
    transition: transform var(--anim-duration) var(--anim-ease);
  }

  .desc-expand-icon.desc-expand-open {
    transform: rotate(180deg);
  }

  .detail-bookmarks {
    display: flex;
    align-items: center;
    gap: 4px;
    flex-wrap: wrap;
  }

  .detail-bookmark-badge {
    display: inline-flex;
    align-items: center;
    background: var(--bg-bookmark);
    color: var(--subtext0);
    padding: 0 5px;
    border-radius: 3px;
    font-size: 10px;
    font-weight: 600;
    border: 1px solid var(--border-bookmark);
    line-height: 1.15;
    letter-spacing: 0.02em;
    cursor: pointer;
    font-family: inherit;
  }

  .detail-pr-badge {
    display: inline-flex;
    align-items: center;
    gap: 3px;
    background: var(--bg-pr);
    color: var(--subtext0);
    padding: 0 6px;
    border-radius: 3px;
    font-size: 10px;
    font-weight: 600;
    border: 1px solid var(--border-pr);
    line-height: 1.15;
    letter-spacing: 0.02em;
    cursor: pointer;
    font-family: inherit;
    text-decoration: none;
    transition: border-color var(--anim-duration) var(--anim-ease);
  }

  .detail-pr-badge:hover {
    border-color: var(--border-pr-hover);
  }

  .detail-pr-badge.is-draft {
    border-style: dashed;
    opacity: 0.75;
  }

  .detail-bookmark-badge.conflicted,
  .detail-pr-badge.conflicted {
    border-color: color-mix(in srgb, var(--red) 40%, transparent);
  }

  .conflict-marker {
    color: var(--red);
    font-weight: 600;
    margin-left: 1px;
  }

  .pr-name {
    color: var(--subtext0);
  }

  .pr-number {
    color: var(--overlay0);
    font-weight: 400;
  }

</style>
