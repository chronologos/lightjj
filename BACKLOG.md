# lightjj Backlog

Open items only. Done-item narratives live in [docs/CHANGELOG-ARCHIVE.md](docs/CHANGELOG-ARCHIVE.md).

Last shipped: **2026-04-03** v1.11.0 — Theme system: 7 builtins (CSS-baked) + 486 Ghostty (raw palettes lazy-loaded, deriveTheme() client-side with pickAccent lum-guards). theme.css ~50 derived via color-mix() + per-theme primaries (~32). CommandPalette children submenu + swatch. Cold-load triple-fix (void ghosttyThemes on $effect AND $derived AND GraphSvg themeEpoch). .theme-switching double-rAF (single rAF fires pre-style-recalc → suppression was no-op). themeSubmenuCommand own $derived (493 children not rebuilt on Space-spam). loadGhosttyThemes .catch clears memo.

## Active

- [ ] **OplogPanel visual diff** (Medium, needs design) — Enter → `jj op show` expansion shipped. Remaining: visual diff between op snapshots (tree-at-op-A vs tree-at-op-B). `jj op show -p` is diff-from-prev-op; comparing two ARBITRARY ops needs either `--at-op` file-show at both ops (which files?) or op-restore+snapshot (invasive). **Design question: what's the CUJ?** "Show me the working-copy diff between these two ops" wants `jj diff --from <rev> --to <rev>` where both revs resolve at their respective ops — that's not a thing jj supports directly. Closest: two-cursor compare like FileHistoryPanel, but comparing `@` at different ops instead of a file at different revisions.

## Deferred (explicit — don't do unless conditions change)

- [ ] **Bombadil UI-fuzzing spike** (Medium, blocked upstream) — Scaffold drafted at `e2e/bombadil/` (fixture.sh + spec.ts + run.sh, ~480 LOC). Spec has 7 LTL properties (`appMounts` liveness guard + `noModalTraps`, `rowsAlwaysEighteen`, etc.) + weighted action generators; fixture builds a 12-commit jj repo with divergence (`--at-op describe` trick) + conflict + bookmarks; typechecks against `@antithesishq/bombadil` 0.3.2. **Blocked:** the Svelte 5 / Vite bundle doesn't execute in Bombadil's managed Chromium — blank page, zero DOM in extractors, both headed and headless. Same server renders fine in real Chrome. Suspect JS instrumentation vs `<script type="module" crossorigin>` or an old bundled Chromium. `appMounts` now fails fast (~5s) on this instead of 300s of key-presses into a blank page — without it every other property passed vacuously (`[].every()` is true, `false.implies(x)` is true). **Workaround documented in run.sh:** `bombadil test-external` against a manually-launched Chrome with `--remote-debugging-port`. **Second rough edge:** headless action rate is ~0.1/s (screenshot-capture bound), which makes `eventually(...).within(10,"seconds")` properties effectively untestable — ~1 action lands in the window. Revisit when Bombadil ≥ 0.4 or if someone wires up the test-external path. **Fixture gotcha worth keeping:** don't set `JJ_RANDOMNESS_SEED` in multi-commit fixture scripts — fixed seed makes every `jj commit`'s fresh-WC change_id identical → accidental N-way divergence on commit 2.
- [ ] **fast-check for pure functions** (Small, independent of Bombadil) — `buildKeepPlan` DONE (200-run property over generated shapes, divergence.test.ts:801). Next targets by bug-density: `planTake` (separator-math round-trip), `reconstructSides` (needs a `serializeJjConflict` inverse), `diffBlocks` (classic LCS properties). No browser, no compat risk.
- [ ] **8 near-identical bookmark handlers** (Low, taste-dependent) — handlers.go. Each is decode → validate-non-empty → runMutation. Go's lack of structural typing makes table-driven dispatch awkward; current form is greppable.
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
