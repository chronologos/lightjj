# lightjj Backlog

Open items only. Done-item narratives live in [docs/CHANGELOG-ARCHIVE.md](docs/CHANGELOG-ARCHIVE.md).

Last shipped: **2026-04-09** v1.12.1 — keybind tweaks (issue #6): revset filter Enter blurs (was apply-but-stay-focused → j/k dead until click-out); diff scroll Ctrl+e/y line-step + Ctrl+d/u half-page via new `diffScroll` gate slot in keyboard-gate.ts (between inInput and hasModifier passthrough so Ctrl+E in text fields stays readline end-of-line). 25 gate tests (+2 ordering invariants).

## Active

- [ ] **Bombadil UI-fuzzing — wire into CI** (Small, unblocked 2026-04-10) — Scaffold at `e2e/bombadil/` (fixture.sh + spec.ts + run.sh, ~480 LOC). Spec has 9 LTL properties (+ `diffMatchesCursor`/`focusEscapable` covering the two highest-frequency historical bug classes) + weighted action generators; fixture builds a 12-commit jj repo with divergence + conflict + bookmarks. **Unblocked by bombadil 0.4.0** ([#75](https://github.com/antithesishq/bombadil/pull/75) "Instrument module scripts and forward headers" — exact match for the 0.3.x blank-page blocker). Verified on 0.4.2: 30s headless run produced 8 actions (Click row-N, PressKey R/Space/Esc — real app flows), `revisionCount=12`, `rowHeights=[18×32]`, `dom_nodes=3216`, all 7 properties pass. spec.ts typechecks unchanged (we only import `/defaults/properties`, not the removed action-generator exports). **Remaining rough edge:** headless action rate ~0.3/s (3× better than 0.3.x; "screenshot timed out, skipping" now skips instead of blocking). Time-windowed `eventually().within(10,"seconds")` properties still only see ~3 actions — rewrite as step-count windows or run HEADED. CI: `.github/workflows/e2e.yml` runs 60s on every PR (`workflow_dispatch` accepts a custom duration for ad-hoc longer runs); `--no-sandbox` for the GHA runner; trace+screenshots uploaded as artifact on failure. **Untested on actual GHA runner** — verify on first PR. **Fixture gotcha:** don't set `JJ_RANDOMNESS_SEED` in multi-commit fixture scripts — fixed seed makes every `jj commit`'s fresh-WC change_id identical → accidental N-way divergence on commit 2.
- [ ] **OplogPanel visual diff** (Medium, needs design) — Enter → `jj op show` expansion shipped. Remaining: visual diff between op snapshots (tree-at-op-A vs tree-at-op-B). `jj op show -p` is diff-from-prev-op; comparing two ARBITRARY ops needs either `--at-op` file-show at both ops (which files?) or op-restore+snapshot (invasive). **Design question: what's the CUJ?** "Show me the working-copy diff between these two ops" wants `jj diff --from <rev> --to <rev>` where both revs resolve at their respective ops — that's not a thing jj supports directly. Closest: two-cursor compare like FileHistoryPanel, but comparing `@` at different ops instead of a file at different revisions.

## Deferred (explicit — don't do unless conditions change)

- [ ] **fast-check for pure functions** (Small, independent of Bombadil) — `buildKeepPlan` DONE (200-run property over generated shapes, divergence.test.ts:801). Next targets by bug-density: `planTake` (separator-math round-trip), `reconstructSides` (needs a `serializeJjConflict` inverse), `diffBlocks` (classic LCS properties). No browser, no compat risk.
- [ ] **`createMutationGate()` factory** (Deferred — net-neutral) — Adversarial review (2026-04 architecture pass) found singleton shape is WRONG (cross-tab bleed: tabs = separate repos). Factory shape is correct but moves ~10 lines App→file, doesn't reduce coupling (still passed as prop), doesn't structurally enforce lock (components can still call api.X direct). `onfilesaved={loadLog}` survives regardless. Revisit if a 3rd consumer beyond DiffPanel+mergeController appears.
- [ ] **`createListPicker()` for BookmarkModal/GitModal shell** (Deferred — break-even) — Shared shell is ~25 lines (previousFocus/query/index/tick-focus/index-clamp/close). Factory ~35 lines + 2×10 integration ≈ break-even at 2 consumers. CommandPalette is 3rd candidate but has submenu/breadcrumb. Do when a 3rd plain list-picker modal appears.
- [ ] **Flat `api` object at ~50 methods** (Deferred) — bookmark sub-family (7 methods) is the strongest namespace case. Pure helpers don't belong in api.ts. Hold until next expansion.
- [ ] **Watcher struct does 5 things** (Deferred — testability already achieved) — Decomposition would add 3 lifecycle owners needing coordinated shutdown for zero new testability. Revisit only if a third `OpHeadsWatcher` impl appears.
- [ ] **Annotations repo-partitioning** (Trivial) — `annotations/{changeId}.json` — changeId is jj-random (~2^128 space), collision across repos is negligible but semantically wrong.
- [ ] **SSH stdin/stdout multiplexing protocol** (Complex) — one persistent SSH session, commands + responses over a framed protocol. Only worth it if port-forward isn't an option. `--remote` stays viable for quick-peek; heavy use → port-forward.

## Small features

- [ ] **Multi-line description wrap in RevisionGraph** (Small, opt-in) — Push N `isDescLine` rows instead of 1 in the `flatLines` $derived (RevisionGraph.svelte:218); `contGutter` already produces pure-`│` continuation so GraphSvg, the 18px row invariant, virtualization, and hover-by-`entryIndex` all work unchanged. Only open question is `wrapDesc()`: char-count word-boundary split (~10 LOC, width-stable, fine for ASCII) is the v1; if someone asks for CJK/bidi-correct or pixel-exact reflow-on-split-drag, that's [@chenglou/pretext](https://github.com/chenglou/pretext) — `prepare()` once per description + `layout()` per resize is its designed hot path, gives exact `lineCount` matching browser wrap without DOM measurement. Gate behind `config.maxDescLines` (default 1 = today's single-line ellipsis).

## Advanced features (roadmap 2.0)

- [ ] **N-way (3+) conflict handling in merge mode** (Medium) — Currently `reconstructSides()` returns null for >2 sides → "unsupported" message. Queue is now earliest-first (option c shipped — propagation roots auto-selected, downstream copies dimmed with ↑ hint). Remaining: (a) sequential 2-at-a-time resolution, (b) `jj resolve --tool` round-trip which gives us `$base`+N sides as real files.
- [ ] **Merge mode Phase 2.x: non-`@` resolution** (Medium) — Current save path is `@`-only via `api.fileWrite`. Next: `jj resolve -r <rev> --tool` + `merge-args $base/$left/$right/$output` lets us resolve any revision AND deprecates `reconstructSides()` marker parsing (pattern proven at `writeHunkToolConfig`). See [docs/design-notes/specs/2026-03-22-merge-mode-and-file-history.md](docs/design-notes/specs/2026-03-22-merge-mode-and-file-history.md) Open Question 2.
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
