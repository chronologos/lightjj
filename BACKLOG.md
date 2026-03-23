# lightjj Backlog

Open items only. Done-item narratives live in [docs/CHANGELOG-ARCHIVE.md](docs/CHANGELOG-ARCHIVE.md).

Last shipped: **2026-03-22** v1.4.0 — merge mode (`3` key) with ConflictQueue + SVG ribbons + minimap + take-all + take-both; file-history overlay (right-click → "View history", two-cursor compare). `conflicts()` and `files()` revsets intersected with `mutable()` for instant large-repo queries. 8 bughunter rounds, ~20 confirmed bugs fixed in-session.

## Divergence deferred (low-impact, from 2026-03-18 bughunt)

The only non-trivial carryover from the 2026-03-20 fix cluster:

- [ ] **confirmRebaseDescendants wrong target** — Requires per-descendant parent-level tracking; current `keeperTip` target is correct for the common case (descendants off tip). Mid-stack-branch is uncommon.
- [ ] **Mid-stack descendant display tip-filtered** — confirm dialog shows them, panel doesn't. Low priority.
- [ ] **commit_id.short() TOCTOU** — same window as `staleImmutableTemplate`; low-probability.

## Active

- [ ] **OplogPanel visual diff** (Small, deferred) — Enter → `jj op show` expansion shipped. Remaining: visual diff between op snapshots (tree-at-op-A vs tree-at-op-B). `jj op show -p` gives per-change patches but comparing two arbitrary ops needs `--at-op` revset gymnastics. Defer until asked.

## Architecture debt

- [ ] **`RepoDir == ""` overloaded sentinel** (Low) — Used as SSH-mode flag across 4 sites (down from 6 — two were consolidated). Conflates "SSH mode" / "test mode" / "no local fs". A `hasLocalFS bool` would clarify but is cosmetic.
- [ ] **`recent-actions` localStorage port loss** (Trivial) — `localhost:0` randomizes port → localStorage resets each launch → BookmarkModal "recent first" sort is always cold. Migrate to server-side or accept soft-degrade.
- [ ] **No `storage` event listener in config.svelte.ts** (Trivial) — two browser tabs on same port: A writes localStorage, B's `$state` never re-reads. Diverge until reload.

## Deferred (explicit — don't do unless conditions change)

- [ ] **8 near-identical bookmark handlers** (Low, taste-dependent) — handlers.go. Each is decode → validate-non-empty → runMutation. Go's lack of structural typing makes table-driven dispatch awkward; current form is greppable.
- [ ] **Flat `api` object at ~50 methods** (Deferred) — bookmark sub-family (7 methods) is the strongest namespace case. Pure helpers don't belong in api.ts. Hold until next expansion.
- [ ] **Watcher struct does 5 things** (Deferred — testability already achieved) — Decomposition would add 3 lifecycle owners needing coordinated shutdown for zero new testability. Revisit only if a third `OpHeadsWatcher` impl appears.
- [ ] **Annotations repo-partitioning** (Trivial) — `annotations/{changeId}.json` — changeId is jj-random (~2^128 space), collision across repos is negligible but semantically wrong.
- [ ] **SSH stdin/stdout multiplexing protocol** (Complex) — one persistent SSH session, commands + responses over a framed protocol. Only worth it if port-forward isn't an option. `--remote` stays viable for quick-peek; heavy use → port-forward.

## Small features

- [ ] **`git push --option` / `-o`** (Trivial) — Add to `allowedGitPushFlags`. Gerrit reviewers, GitLab merge options. Low demand; wait for a request.
- [ ] **`--simplify-parents` on rebase** (Trivial) — Add to `Rebase()` builder signature, wire a checkbox in rebase mode. Useful when rebasing onto a descendant of the old parent.
- [ ] **Double-slice per diff line** (Trivial) — DiffFileView.svelte slices `line.content` twice per render. One alloc.

## Advanced features (roadmap 2.0)

- [ ] **N-way (3+) conflict handling in merge mode** (Medium) — Currently `reconstructSides()` returns null for >2 sides → "unsupported" message. The jj-idiomatic guidance is "resolve at earliest commit, descendants auto-resolve" (now shown in the empty-state). Actual N-way UI options: (a) sequential 2-at-a-time resolution, (b) `jj resolve --tool` round-trip which gives us `$base`+N sides as real files, (c) queue smart-sort that surfaces the EARLIEST occurrence of each file first so users naturally fix the propagation root. Option (c) is cheapest and most jj-native.
- [ ] **Merge mode Phase 2.x: non-`@` resolution** (Medium) — Current save path is `@`-only via `api.fileWrite`. Next: `jj resolve -r <rev> --tool` + `merge-args $base/$left/$right/$output` lets us resolve any revision AND deprecates `reconstructSides()` marker parsing (pattern proven at `writeHunkToolConfig`). See [docs/plan-merge-mode.md](docs/plan-merge-mode.md) §2.x.
- [ ] **Mega-file virtualization** (Low) — manual expand of 5000-line file renders all lines. Auto-collapse at 500 + total-line collapse at 2000 mitigate; `@tanstack/virtual` on the per-hunk `{#each}` inside DiffFileView would be the full fix.
- [ ] **Search across revisions** (Medium) — `jj log -r 'description(glob:"*query*")'` or tree-grep. Needs design.
- [ ] **SSH remote repo browser** (Low) — discover repos on remote host, open as tabs.
- [ ] **Drag-and-drop rebase** (Low) — drag revision onto destination. Inline keyboard rebase already covers the CUJ.
- [ ] **LSP-in-FileEditor** (Complex) — hover/goto in the inline editor. Depends on the LSP running relative to the repo root.

## Known non-goals

Kept here so they don't get re-proposed.

- **Modal-union for App.svelte** — of 9 booleans only 5 are real modals, all use `bind:open` (union would need 5 getter/setter binding pairs = more code than now).
- **Keybind registry** (PaletteCommand-shaped array with `when` predicates) — adding a new mode requires auditing every `when` to add `&& !newMode.active`; current early-return-and-swallow is structurally safer.
- **`createInlineEdit()` / `createDiffSearch()` factories** — stale-guard bug + net +LOC + `set error` smell; factorizing creates "distributed monolith" with injected getters replacing closure access.
