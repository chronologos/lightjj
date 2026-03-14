# lightjj Backlog

Open items only. Done-item narratives live in [docs/CHANGELOG-ARCHIVE.md](docs/CHANGELOG-ARCHIVE.md) — keep the design rationale but don't let it drown the actionable list.

## Active (2026-03-11)

- [x] **Smart views** — Shipped as inline preset chips in the revset filter bar (not a panel). `applyRevsetExample()` reuse, no new components. Rationale in `docs/plan-smart-views.md`: the v1 tab-strip-hosting-BookmarksPanel design conflated revset-apply buttons with the bookmarks list surface; decoupling collapsed ~240 LOC → ~60. User-defined presets (config.json-backed) is the natural follow-up if asked.
- [ ] **OplogPanel visual diff** (Small) — Enter → `jj op show` expansion shipped. Remaining: visual diff between op snapshots (tree-at-op-A vs tree-at-op-B). `jj op show -p` gives per-change patches but comparing two arbitrary ops needs `--at-op` revset gymnastics. Defer until someone asks.

## Architecture debt

- [x] **Revset input ownership inversion** (Small) — Done. Extracted filter bar from RevisionGraph into App.svelte. Removed 4 `onrevset*` callbacks + `revsetFilter` prop + `focusRevsetInput` export.
- [ ] **`RepoDir == ""` overloaded sentinel** (Low) — Used as SSH-mode flag across 6+ sites. Conflates "SSH mode" / "test mode" / "no local fs". The real bit is "local filesystem access available". A `Capabilities` bitset (or just `hasLocalFS bool`) would clarify error messages but is cosmetic.
- [ ] **`recent-actions` localStorage port loss** (Trivial) — `localhost:0` randomizes port → localStorage resets each launch → BookmarkModal "recent first" sort is always cold. config.svelte.ts already uses server-side primary (audited); only this frequency counter is affected. Either migrate to server-side or accept soft-degrade.
- [ ] **No `storage` event listener in config.svelte.ts** (Trivial) — two browser tabs on same port: A writes localStorage, B's `$state` never re-reads (`loadLocal()` runs once at module eval). Diverge until reload.

## Deferred (explicit — don't do unless conditions change)

- [ ] **8 near-identical bookmark handlers** (Low, taste-dependent) — handlers.go. Each is decode → validate-non-empty → runMutation. Go's lack of structural typing makes table-driven dispatch awkward; current form is greppable. Defer unless bookmark family grows further.
- [ ] **Flat `api` object at ~50 methods** (Deferred) — bookmark sub-family (7 methods) is the strongest namespace case. Pure helpers (`effectiveId`/`multiRevset`/`computeConnectedCommitIds`) are zero-I/O and don't belong in api.ts. Hold until next expansion.
- [ ] **Watcher struct does 5 things** (Deferred — testability already achieved) — Decomposition would add 3 lifecycle owners needing coordinated shutdown for zero new testability. Revisit only if a third `OpHeadsWatcher` impl appears.
- [ ] **Annotations repo-partitioning** (Trivial) — `annotations/{changeId}.json` — changeId is jj-random (~2^128 space), collision across repos is negligible but semantically wrong. Partition as `annotations/{repoRootHash}/{changeId}.json`. Fix when it matters.
- [ ] **SSH stdin/stdout multiplexing protocol** (Complex, deferred) — one persistent SSH session, commands + responses over a framed protocol. Only worth it if port-forward isn't an option (firewall/policy). `--remote` mode stays viable for quick-peek; heavy use → port-forward.

## Small features (file when bored)

- [ ] **`git push --option` / `-o`** (Trivial) — Add to `allowedGitPushFlags`. Passes server-side push options (Gerrit reviewers, GitLab merge options). Low demand; wait for a request.
- [ ] **`--simplify-parents` on rebase** (Trivial) — Add to `Rebase()` builder signature, wire a checkbox in rebase mode. Useful when rebasing onto a descendant of the old parent.
- [ ] **Double-slice per diff line** (Trivial) — DiffFileView.svelte both slices `line.content` twice per render. One alloc.

## Advanced features

- [ ] **No virtualization for mega-files** (Low) — manual expand of 5000-line file renders all lines. Auto-collapse at 500 + total-line collapse at 2000 mitigate; `@tanstack/virtual` on the per-hunk `{#each}` inside DiffFileView would be the full fix.
- [ ] **Drag-and-drop rebase** (Low) — drag revision onto destination. Inline keyboard rebase already covers the CUJ.
- [ ] **Search across revisions** (Medium) — `jj log -r 'description(glob:"*query*")'` or tree-grep. Needs design.
- [ ] **SSH remote repo browser** (Low) — discover repos on remote host, open as tabs.

## Known non-goals

Items explicitly rejected after review — kept here so they don't get re-proposed.

- **Modal-union for App.svelte** — of 9 booleans only 5 are real modals, all use `bind:open` (union would need 5 getter/setter binding pairs = more code than now).
- **Keybind registry** (PaletteCommand-shaped array with `when` predicates) — adding a new mode requires auditing every `when` to add `&& !newMode.active`; current early-return-and-swallow is structurally safer.
- **`createInlineEdit()` / `createDiffSearch()` factories** — stale-guard bug + net +LOC + `set error` smell; factorizing creates "distributed monolith" with injected getters replacing closure access.
