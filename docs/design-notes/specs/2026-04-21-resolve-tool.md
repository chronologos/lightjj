# `jj resolve --tool` for MergePanel — design (v2, simplified)

Status: reviewed; v1 deep-review collapsed Phase 1 entirely (architect REFACTOR closed 25/40 findings, ratio 0.62).
Goals: (1) exact base bytes for the base popup; (2) save resolution at non-`@`.

## v1 → v2 delta

v1 proposed two `jj resolve --tool` re-entry phases (dump + apply) with helper-mode flags, ephemeral TOML, and JSON tempfile transport. Review found the **fetch phase is unnecessary** — `jj file show --config ui.conflict-marker-style=snapshot` re-materializes conflicts with byte-exact base in `-------` sections at any revision, and `reconstructSides()` already parses snapshot mode. This closes every exit-1-on-happy-path, GET-snapshots-WC, dropped-labels, dropped-`blocks`, lost-LRU-cache, and SSH-dump-tempfile finding. Only the **save phase** is genuinely new.

## Phase 1 — fetch sides (no new endpoint)

Add `--config ui.conflict-marker-style=snapshot` to `internal/jj/commands.go:FileShow`. No-op on non-conflicted files; for conflicted files, snapshot style emits:

```
<<<<<<< conflict 1 of 1
+++++++ <change_id> <commit_id> "<desc>"      ← oursLabel/oursRef parsed from marker text
B-ours
------- <change_id> <commit_id> "<desc>"      ← exact base bytes (was lossy %% diff in default style)
b
+++++++ <change_id> <commit_id> "<desc>"      ← theirsLabel/theirsRef
B-theirs
>>>>>>> conflict 1 of 1 ends
```

`reconstructSides()` parses this today (conflict-extract.ts handles both Diff and Snapshot styles). Preserved: parse-time `blocks` (no LCS regression on >1414-line files), `oursLabel/theirsLabel/oursRef/theirsRef` (pane-header chips), `cachedRequest` LRU (commit_id+path), `--ignore-working-copy` (already on FileShow), SSH-transparency.

**Shape:** `FileShow(rev, path, snapshotMarkers bool)` + `?snapshot=1` query param on `/api/file-show`. Only `merge-controller.svelte.ts:selectFile()` passes `true`.

**Why opt-in, not global:** `executeHunkReview` (App.svelte) reads `api.fileShow(parentId)` as left-content for `applyHunks`. `jj split --tool` materializes `$left` in the *user's* configured style; a global snapshot override desyncs line counts → applyHunks blindly emits wrong context lines → silently commits corrupted output. (5-0 bughunt finding on the v2.0 implementation that did this globally.) DiffPanel's conflict A/B badges and FileEditor raw-edit also expect user's style for consistency with the diff they're rendered alongside.

## Phase 2 — save at non-`@` (`POST /api/merge-resolve {rev, path, content}`)

`cp` is the apply tool — verified `jj resolve --tool x --config 'merge-tools.x.program="cp"' --config 'merge-tools.x.merge-args=["<result>","$output"]'` commits the resolution. No `cmd/lightjj/main.go` helper modes, no TOML tempfile.

```go
// internal/jj/commands.go
func ResolveApply(rev, resultPath, repoRelPath string) CommandArgs {
    return CommandArgs{
        "resolve", "-r", rev,
        "--config", `merge-tools.ljjcp.program="cp"`,
        "--config", fmt.Sprintf(`merge-tools.ljjcp.merge-args=[%q,"$output"]`, resultPath),
        "--tool", "ljjcp",
        "--", EscapeFileName(repoRelPath), // root-file: prefix is in EscapeFileName
    }
}
```

```go
// internal/api/handlers.go
func (s *Server) handleMergeResolve(w http.ResponseWriter, r *http.Request) {
    // SSH 501 — same gate as handleSplitHunks. result.txt would be on the wrong
    // host. SSH non-@ resolution is a follow-up (mktemp + Runner.WriteFile + cp).
    if !s.hasLocalFS() {
        s.writeError(w, http.StatusNotImplemented, "merge-resolve is local-only; use Edit (jj edit <rev>) then save")
        return
    }
    var req struct{ Rev, Path, Content string }
    if err := decodeBody(w, r, &req); err != nil { ... }
    // jj rejects empty-or-unchanged $output ("output file is either unchanged
    // or empty"). Empty resolution is rare but valid (delete-the-file would be
    // a different operation). Normalise to a single newline.
    content := req.Content
    if len(content) == 0 { content = "\n" }
    f, _ := os.CreateTemp("", "lightjj-resolve-*.txt")
    f.WriteString(content); f.Close(); defer os.Remove(f.Name())
    s.runMutation(w, r, jj.ResolveApply(req.Rev, f.Name(), req.Path))
}
```

**Frontend** (`merge-controller.svelte.ts:save()`):
- `cur.changeId === getWorkingCopyChangeId()` → `api.fileWrite` (existing path; SSH-compatible, handles empty content natively). change_id, NOT commit_id — bug_040: fileWrite snapshots `@` → new commit_id.
- otherwise → `api.mergeResolve(rev, path, content)`; on 501 surface "Non-@ resolve requires local mode — `jj edit <rev>` then save"

Both branches stay `withMutation`-wrapped + `mergeGen`-guarded (controller's shared-gen invariant).

## Non-goals / known limitations

- **N-way (3+ sides)**: `jj resolve` errors before invoking the tool; fetch-side fallback already shows the unsupported-format message.
- **SSH non-@**: 501 in v1. Follow-up: `RunRaw(["mktemp"])` → `Runner.WriteFile` (already pipes via stdin per ssh.go) → `ResolveApply` with the remote path. ~40 LOC; deferred to keep test matrix bounded.
- **Concurrent resolve same file across tabs**: second POST 500s with jj's "no conflict at path" — surface verbatim. Tab A's stale MergePanel: SSE op-id refresh re-fires `merge.enter()` only if the user re-enters merge view; document the limitation.
- **Resolved-but-unchanged**: `cp` of bytes identical to `$output`'s initial content (empty) is rejected by jj. The `len==0 → "\n"` normalisation covers empty; "unchanged" can't happen since jj seeds `$output` empty by default and our content is the user's edited center pane.

## Alternatives rejected

- **`jj edit <rev>; fileWrite; jj edit <prev>`** — 3 ops vs 1, full WC checkout cost on large repos, leaves `@` shifted on crash mid-sequence.
- **v1 Phase 1 (`--dump-merge` helper)** — see v1→v2 delta. 25 distinct failure modes for zero capability beyond what one `--config` flag gives.
- **`jj restore --from-file`** — no such flag; `jj restore` operates on tree paths, not external files.

## Shape of the change (~80 LOC)

| File | Change |
|---|---|
| `internal/jj/commands.go` | `FileShow`: add `--config ui.conflict-marker-style=snapshot`. New `ResolveApply(rev, resultPath, path)` builder |
| `internal/api/handlers.go` | `handleMergeResolve` (POST, `runMutation`, `!hasLocalFS()` → 501, empty-content normalise) |
| `internal/api/server.go` | Route `POST /api/merge-resolve` |
| `frontend/src/lib/api.ts` | `api.mergeResolve(rev, path, content)` |
| `frontend/src/lib/merge-controller.svelte.ts` | `save()`: branch on `@` (fileWrite) vs non-@ (mergeResolve). Drop the `@`-only error path |
| Tests | `commands_test.go` (+2: FileShow snapshot config, ResolveApply argv); `handlers_test.go` (+3: mergeResolve happy/501/empty-content); `conflict-extract.test.ts` (+1: snapshot-style fixture round-trips with exact base) |

`conflict-extract.ts` and `MergePanel.svelte` unchanged. `cmd/lightjj/main.go` unchanged.
