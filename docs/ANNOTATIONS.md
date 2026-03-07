# Inline Diff Annotations

Per-line review comments for agent-iteration workflows. Supports the loop: user reviews → leaves feedback → exports → agent iterates → annotations auto-re-anchor → loop.

## The jj model

**Agent mutates the same revision** (same `change_id`, new `commit_id` per edit). jj's evolog captures every iteration:

```
change_id: xyz (stable)
├── commit abc123 (evolog step 1: agent's first attempt)
├── commit def456 (evolog step 2: after user feedback round 1)
└── commit ghi789 (evolog step 3: current)
```

Annotations are keyed by `change_id` — they survive iterations. `createdAtCommitId` attributes each annotation to a specific evolog step, and is the `from` side of the re-anchor inter-diff.

## Data flow

```
┌─────────────────────────────────────────────────────────────┐
│                                                             │
│  DiffPanel $effect tracks diffTarget.{changeId, commitId}   │
│      │                                                      │
│      ▼                                                      │
│  annotations.load(changeId, commitId)                       │
│      │                                                      │
│      ├─► GET /api/annotations?changeId=X                    │
│      │       ($XDG_CONFIG_HOME/lightjj/annotations/X.json)  │
│      │                                                      │
│      ├─► Group by createdAtCommitId                         │
│      │                                                      │
│      ├─► For each group: diffRange(createdAt, current)      │
│      │       (one call per snapshot, scoped to files)       │
│      │                                                      │
│      ├─► reanchor(ann, hunks) → {lineNum, status}           │
│      │                                                      │
│      └─► POST /api/annotations (persist re-anchored state)  │
│                                                             │
│  Agent iterates → fsnotify → SSE → onStale → loadLog()      │
│      → diffTarget.commitId changes → effect fires → reload  │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

## Re-anchoring (`annotations.svelte.ts:reanchor`)

Two stages, composed:

### Stage 1: diff-delta adjustment
For each hunk in `diffRange(createdAtCommitId, currentCommitId)` that ends **above** the annotation's original line (old side), accumulate `hunkDelta = adds - removes`. Pure arithmetic — exact for insertions/deletions above the annotated line.

### Stage 2: content verification
If the hunk **spans** the annotation's line, search its new-side lines for `ann.lineContent` (exact match). Handles moves/rewrites within a hunk.

If delta-adjusted line's content doesn't match the snapshot and no spanning hunk found it, scan ±5 lines (fuzzy window). If still no match → `status: 'orphaned'`.

**Orphaned ≈ addressed.** The agent deleted or rewrote the line — likely fixed what the comment asked for. Surfaced in a "possibly addressed" panel for one-click resolve.

## Storage

`$XDG_CONFIG_HOME/lightjj/annotations/{changeId}.json`

**Why server-side, not localStorage:** originally because workspace spawning ran child processes on different ports (isolated localStorage per origin). Workspaces are now in-process tabs (single origin), but server-side storage is still right — survives `localStorage.clear()`, works across browsers, and SSH-mode stores on the remote host where the agent is running.

**Path safety:** `changeId` validated against `^[a-z0-9]{1,64}$` (jj's charset) before embedding in filesystem path. Blocks `../`, null bytes, etc.

**GC:** Last annotation deleted → file removed. `jj abandon` of the change leaves a stranded file; manual cleanup or future `jj abandon` hook.

## UX surfaces

| Surface | Trigger | Location |
|---|---|---|
| 💬 Gutter badge | Line has annotations | `DiffFileView` — right-edge absolute positioned, severity-colored, dashed outline = orphaned |
| Context menu "💬 Annotate" | Right-click diff line | `DiffPanel:openDiffLineContextMenu` — single-rev + single-line only |
| `AnnotationBubble` popup | Click badge / Annotate menu | Overlay dialog: severity select + textarea + ⌘Enter save |
| Summary bar | `openAnns.length > 0` | Between file-list-bar and diff-toolbar. Clickable chips + "Export ↗" button |
| Palette commands | "Export annotations (markdown/JSON)" | `App.svelte:staticCommands` — copies to clipboard |

## Export formats

**Markdown** (for text-prompt agents): groups by file, sorts by line, skips resolved, notes orphaned.

**JSON** (programmatic): `{changeId, commitId, annotations: [{file, line, context, comment, severity, status}]}`

## API

| Method | Endpoint | |
|---|---|---|
| `GET` | `/api/annotations?changeId=X` | → `Annotation[]` (empty if missing/corrupt) |
| `POST` | `/api/annotations` | Upsert by `id` within `changeId` file |
| `DELETE` | `/api/annotations?changeId=X&id=Y` | Remove by id; file deleted if last |
| `DELETE` | `/api/annotations?changeId=X` | Clear all (remove file) |

## Deferred (follow-up)

- **Evolog badge counts** — `💬 5→3` per evolog step showing how many annotations each iteration addressed
- **Levenshtein re-anchor** — current `reanchor()` does exact content match only; edited-but-similar lines orphan
- **Inline bubble** — currently overlay popup. True inline insertion between diff lines needs `DiffFileView` hunk-loop changes
- **"Mark resolved" from orphaned panel** — currently only delete/edit; no one-click resolve flow
