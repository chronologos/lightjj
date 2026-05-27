# Unified review model

**Status:** implemented (v1.25.0; the [Open questions](#open-questions) below remain open) · **Supersedes:** parts of [ANNOTATIONS.md](../ANNOTATIONS.md) (data model only; the agent-iteration workflow there stays)

## Problem

lightjj has two comment systems built six months apart:

|                       | Annotations (diff review)                               | Doc-comments (doc mode)                                |
| --------------------- | ------------------------------------------------------- | ------------------------------------------------------ |
| Storage scope         | `annotations/{changeId}.json`                           | `doc-comments/{sha(repo+path)}.json`                   |
| Anchor                | `{filePath, lineNum, side, lineContent, createdAtCommitId}` | `{selection, contextBefore, contextAfter}`         |
| Body field            | `comment`                                               | `body`                                                 |
| Resolution            | `status: open\|resolved\|orphaned`                      | `resolution: addressed\|wontfix` (absent = open)       |
| Severity              | `must-fix\|suggestion\|question\|nitpick\|reviewed`     | —                                                      |
| Threading             | —                                                       | `parentId`                                             |
| Suggestion-with-apply | —                                                       | `kind:'suggestion'` + `replacement` → PM transaction   |
| Author                | — (assumed: you)                                        | `author`                                               |
| Render                | gutter SVG + file-header chip + panel chip-bar + file-note strip | right rail of cards                           |
| In-content highlight  | —                                                       | `Decoration.inline` underline                          |
| Keyboard nav          | `{`/`}` over `navAnnotations`                           | —                                                      |
| Hide/show             | —                                                       | resolved dims to 0.55                                  |

They share **zero rendering code**. Neither has a real visibility toggle. Annotations render in **four** places; doc-comments in **one**. Features land on whichever system the author happened to be touching.

## Non-goals

- **Merging storage.** `changeId` scope (review of *this* revision, dies with the PR) vs `filePath` scope (living document, survives commits) is a product distinction — see `doc_comments.go:19-22`. Two buckets stay.
- **Breaking `agent_api.md`.** Agents POST doc-comments today; the wire format must keep working.
- **Migrating on-disk JSON.** Existing annotation/doc-comment files load unchanged.

## Unified read model

`Review` is a **read-side projection** — components render it, but mutations go through the existing stores by `id`. There are no `Review→wire` inverse mappers; `CommentCard` emits intent callbacks (`onresolve`, `onreply`, `onhideauthor`) and the parent surface wires them to `annotations.update(id, …)` / `docSession.resolveComment(id, …)` directly. This sidesteps round-trip lossiness (`baseVersion`, `'reviewed'`) entirely.

```ts
type ReviewAnchor =
  | { kind: 'diff'
      changeId: string; filePath: string
      line: number; side: 'old' | 'new'
      lineContent: string        // re-anchor scan target
      commitId: string }         // evolog attribution + diffRange `from`
  | { kind: 'prose'
      filePath: string
      selection: string; ctxBefore: string; ctxAfter: string }

// 'reviewed' stays an explicit value — only setReviewed() writes it, so it's
// collision-free. Migrating viewed-progress to a separate reviewedFiles[] is
// cleaner but out of phase-1 scope.
type Severity = 'must-fix' | 'suggestion' | 'question' | 'nitpick' | 'reviewed'

type Review = {
  id: string
  anchor: ReviewAnchor
  body: string
  author?: string
  createdAt: number
  parentId?: string
  severity?: Severity
  kind: 'note' | 'suggestion'
  suggestion?: { replacement: string; baseVersion?: number }
  resolution?: 'addressed' | 'wontfix'       // user-set; absent = open
  resolvedAt?: number
}

// Per-surface placed wrapper — derived state that doesn't persist.
type PlacedReview = Review & {
  orphaned: boolean      // re-anchor failed (was Annotation.status:'orphaned')
  line?: number          // post-re-anchor effective line (diff side)
  from?: number; to?: number   // PM positions (prose side, was PlacedComment)
}
```

### Adapters (read-only)

```ts
fromAnnotation(a: Annotation): Review
  // comment→body, build anchor.kind='diff', status:'resolved'→resolution:'addressed',
  // status:'orphaned' DROPPED (recomputed into PlacedReview.orphaned), severity verbatim.
fromDocComment(d: DocComment): Review
  // anchor.kind='prose', kind 'comment'→'note', suggestion passes baseVersion through.
```

The Go `Annotation` struct gains optional `Resolution string \`json:"resolution,omitempty"\`` so `wontfix` has somewhere to land; `status` is still emitted for back-compat and `fromAnnotation` prefers `resolution` when present.

## Visibility model

### Render states

| state     | what renders                                              |
| --------- | --------------------------------------------------------- |
| `visible` | full `<CommentCard>` (inline row in diff, rail card in doc) |
| `bubbled` | 14px gutter dot only — zero vertical footprint            |
| `stub`    | author-row only with "… hidden" label (root hidden by author filter, replies visible) |
| `hidden`  | no trace (author-filtered leaf)                           |

### Store

Per-App-instance factory — **not** a module singleton. Tabs are separate repos mounted via `{#key activeTabId}` remount; a module-level `mode` would make ⇧C in repo-A flip repo-B's doc mode.

```ts
createCommentVisibility() → {
  mode: 'auto' | 'hide' | 'show'            // ⇧C cycles; 'auto' = open visible, resolved bubbled
  overrides: SvelteMap<string, boolean>     // id → true=force-visible, false=force-bubbled, absent=mode
  isVisible(r: Review, hasDraft: boolean): boolean
  cycle(): void                             // also clears overrides
  toggleThread(id: string): void
}
```

`hiddenAuthors` lives in **`config.svelte.ts`** (`hiddenCommentAuthors: string[]`) — the single localStorage+server-persisted surface — not hand-rolled here. The store reads it via `$derived(new Set(config.hiddenCommentAuthors))`.

Resolution order (first match wins):

1. `hasDraft` → `visible` (never collapse a thread you're typing in)
2. `hiddenAuthors.has(r.author)` → `hidden` (or `stub` if it's a root with visible replies)
3. `overrides.get(id)` → that
4. `mode === 'hide'` → `bubbled` · `mode === 'show'` → `visible`
5. `mode === 'auto'` → `visible` iff `!r.resolution`

### Scroll anchor on bulk toggle

Cycling `mode` adds or removes hundreds of px above the viewport. Compensation:

```ts
holdViewport(scrollEl: HTMLElement, anchorSel: string, fn: () => void, gen?: () => number): Promise<void>
```

Pick `anchorEl` = first `scrollEl.querySelectorAll(anchorSel)` match with `top ≥ scrollEl.top` → capture its `top` → run `fn()` → `await tick()` → re-read `top` → `scrollEl.scrollTop += delta`. `anchorSel` must be per-row (DiffPanel passes `'.diff-file'`) — a single wrapper div's top doesn't move when its contents reflow. `tick()` (microtask, post-DOM-flush, pre-paint) is the right barrier; double-rAF would let frame N paint at the shifted position before correcting in N+1. The store owns a `scrollGen` that `holdViewport` checks post-tick and `scrollToHunk`/`DocView.scrollTo` bump, so a nav during the toggle wins.

Second caller: `DiffPanel.refreshPreviews` currently does absolute `scrollTop` save/restore, which drifts when content above the viewport reflows — switch it to `holdViewport`.

## Rendering

### `<CommentCard>` — pure presentational atom

Props (no `ReviewAnchor` import — the surface computes anchor-dependent bits):

```ts
{ review: Review
  anchorText: string         // diff: lineContent; prose: anchor.selection
  staleness?: number         // diff-only: graph-index distance commitId→head; undefined hides badge
  replies: Review[]
  onresolve(id, r: 'addressed'|'wontfix'): void
  onreply(id, body): void
  onaccept?(id): void        // present iff kind==='suggestion' and surface can apply
  onhideauthor(author): void
  onjump(): void }
```

- 3px left border in severity color (`must-fix`→`--red`, `suggestion`→`--amber`, `question`→`--blue`, `nitpick`/`reviewed`→`--overlay0` per [DESIGN_LANGUAGE.md](../DESIGN_LANGUAGE.md) Tier 1)
- Head: `author` (⟐ prefix when ≠ `'you'`) · `relativeTime(createdAt)` · `staleness && "commit −{staleness}"` badge
- Body: rendered markdown
- Suggestion: strikethrough `anchorText` + `suggestion.replacement` in `--diff-remove-bg`/`--diff-add-bg`
- Actions: Reply · Resolve ▾ (addressed / won't-fix) · Hide-author (when `author && author !== 'you'`) · Accept (when `onaccept`)
- Replies: 2px `--surface2` left rule, indented
- `[data-resolved]` → `opacity:.55`, hover restores

**Extracted from `DocCommentRail.svelte:65-117`** (~80% overlap: border, head, markdown body, suggestion preview, actions, replies, resolved-dim). Net-new: severity color, staleness badge, Hide-author. `DocCommentRail`'s local `fmtAge` is replaced by `time-format.ts:relativeTime` (gains a `number`-epoch overload).

### Per-surface attachment

|              | Collapsed (`bubbled`)                                  | Expanded (`visible`)                      | In-content mark            |
| ------------ | ------------------------------------------------------ | ----------------------------------------- | -------------------------- |
| Diff         | 14px dot in the existing 18px gutter column — severity-filled, count digit, ring when resolved | `<CommentCard>` in a full-width row below the line (`grid-column:1/-1`) | none (gutter is the mark) |
| Doc / md-preview | dot in `MarkdownPreview`'s `.md-gutter`            | `<CommentCard>` in the right rail         | `.hl` underline + bg on the anchor range |

DiffPanel keeps a **severity count strip** in the panel toolbar (`●3 ●5 ●2` in `--red`/`--amber`/`--blue`, click → first-of-severity) — replaces the chip-bar's at-a-glance distribution without the per-annotation chip sprawl. Diff-anchored orphans render as a collapsed `N possibly addressed` row at panel bottom (click → list with original `lineContent`).

### Navigation

`{`/`}` → `stepReview(dir)` over a document-order list of `(anchorEl, reviewId)` where `anchorEl` is the **in-content mark** (`.review-bubble` for diff, `.hl` for prose) — not the rail card, whose DOM position doesn't track anchor position. Jumping to a `bubbled` target sets `overrides.set(id, true)` first.

## Migration

| Phase | Change                                                                                              |
| ----- | --------------------------------------------------------------------------------------------------- |
| 1     | `review.ts` (types + 2 read adapters), `comment-visibility.svelte.ts`, `holdViewport` in `virtual.svelte.ts`, extract `<CommentCard>` from DocCommentRail, `relativeTime(number)` overload, `config.hiddenCommentAuthors`. Compiles unused. |
| 2     | DiffPanel: gutter SVG → bubble, drop chip-bar/file-note, inline-row mount, severity strip, orphan row, wire visibility + `holdViewport`. `annotations.svelte.ts` exposes `PlacedReview[]`; six `status==='orphaned'` sites retyped. Go: `Annotation.Resolution` optional field. |
| 3     | DocView/DocCommentRail rewire over `<CommentCard>`; `{`/`}` in doc mode; `refreshPreviews` → `holdViewport`. |

## Open questions

- **Suggestions on diff anchors.** Accept = write `replacement` to `@` at `filePath:line`. Gate: `diffTarget.kind==='single' && !diffTarget.immutable && anchor.side==='new' && anchor.commitId === diffTarget.commitId` (the staleness term is already computed for the badge). Whether Accept auto-`jj edit`s like `startEdit` does, or stays `@`-only — phase 2 decides.
- **`'reviewed'` as severity.** It's progress-tracking, not a comment. A separate `reviewedFiles: string[]` per changeId is cleaner — punted to keep phase 1 read-only.
