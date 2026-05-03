# lightjj Backlog

Open items only. Done-item narratives live in [docs/CHANGELOG-ARCHIVE.md](docs/CHANGELOG-ARCHIVE.md).

Last shipped: **2026-04-20** v1.20.1 — trim configTemplate teaching comments; rely on docs/CONFIG.md.

## Active

- [ ] **OplogPanel visual diff** (Medium, needs design) — Enter → `jj op show` expansion shipped. Remaining: visual diff between op snapshots (tree-at-op-A vs tree-at-op-B). `jj op show -p` is diff-from-prev-op; comparing two ARBITRARY ops needs either `--at-op` file-show at both ops (which files?) or op-restore+snapshot (invasive). **Design question: what's the CUJ?** "Show me the working-copy diff between these two ops" wants `jj diff --from <rev> --to <rev>` where both revs resolve at their respective ops — that's not a thing jj supports directly. Closest: two-cursor compare like FileHistoryPanel, but comparing `@` at different ops instead of a file at different revisions.

## Deferred (explicit — don't do unless conditions change)

- [ ] **Bombadil rough edges** (Low) — CI wired and green on GHA (e2e.yml, 60s/PR). Remaining: headless action rate ~0.3/s means time-windowed `eventually().within(10,"seconds")` properties see only ~3 actions — rewrite as step-count windows or run headed. Fixture gotcha doc'd in `e2e/bombadil/fixture.sh`: don't set `JJ_RANDOMNESS_SEED` in multi-commit fixtures (fixed seed → identical fresh-WC change_ids → accidental N-way divergence).
- [ ] **fast-check for pure functions** (Small, independent of Bombadil) — `buildKeepPlan` DONE (200-run property over generated shapes, divergence.test.ts:801). Next targets by bug-density: `planTake` (separator-math round-trip), `reconstructSides` (needs a `serializeJjConflict` inverse), `diffBlocks` (classic LCS properties). No browser, no compat risk.
- [ ] **`createMutationGate()` factory** (Deferred — net-neutral) — Adversarial review (2026-04 architecture pass) found singleton shape is WRONG (cross-tab bleed: tabs = separate repos). Factory shape is correct but moves ~10 lines App→file, doesn't reduce coupling (still passed as prop), doesn't structurally enforce lock (components can still call api.X direct). `onfilesaved={loadLog}` survives regardless. Revisit if a 3rd consumer beyond DiffPanel+mergeController appears.
- [ ] **`createListPicker()` for BookmarkModal/GitModal shell** (Deferred — break-even) — Shared shell is ~25 lines (previousFocus/query/index/tick-focus/index-clamp/close). Factory ~35 lines + 2×10 integration ≈ break-even at 2 consumers. CommandPalette is 3rd candidate but has submenu/breadcrumb. Do when a 3rd plain list-picker modal appears.
- [ ] **Flat `api` object at ~50 methods** (Deferred) — bookmark sub-family (7 methods) is the strongest namespace case. Pure helpers don't belong in api.ts. Hold until next expansion.
- [ ] **Watcher struct does 5 things** (Deferred — testability already achieved) — Decomposition would add 3 lifecycle owners needing coordinated shutdown for zero new testability. Revisit only if a third `OpHeadsWatcher` impl appears.
- [ ] **Annotations repo-partitioning** (Trivial) — `annotations/{changeId}.json` — changeId is jj-random (~2^128 space), collision across repos is negligible but semantically wrong.
- [ ] **SSH stdin/stdout multiplexing protocol** (Complex) — one persistent SSH session, commands + responses over a framed protocol. Only worth it if port-forward isn't an option. `--remote` stays viable for quick-peek; heavy use → port-forward.

## Small features

- [ ] **Multi-line description wrap in RevisionGraph** (Small, opt-in) — Push N `isDescLine` rows instead of 1 in the `flatLines` $derived (RevisionGraph.svelte:218); `contGutter` already produces pure-`│` continuation so GraphSvg, the 18px row invariant, virtualization, and hover-by-`entryIndex` all work unchanged. Only open question is `wrapDesc()`: char-count word-boundary split (~10 LOC, width-stable, fine for ASCII) is the v1; if someone asks for CJK/bidi-correct or pixel-exact reflow-on-split-drag, that's [@chenglou/pretext](https://github.com/chenglou/pretext) — `prepare()` once per description + `layout()` per resize is its designed hot path, gives exact `lineCount` matching browser wrap without DOM measurement. Gate behind `config.maxDescLines` (default 1 = today's single-line ellipsis).

- [ ] **Workspace name in tab title** (Small) — tabs opened from a workspace show `◇ {name}` instead of `filepath.Base(path)`. Backend: `TabResolve` already runs `jj workspace root`; also run `jj workspace list -T name` and match — set `TabInfo.Name = "◇ "+wsName`. Frontend `TabBar.svelte:50` already renders `tab.name`.
- [ ] **`jj workspace forget` / `rename`** (Small) — context-menu on workspace dropdown entries. Forget needs a confirm (it abandons the workspace's `@` commit if non-empty).
- [ ] **Per-workspace stale indicator in dropdown** (Medium) — show ⚠ next to stale workspaces. Needs a per-workspace probe (`jj log -r @ --ignore-working-copy` in each workspace dir, check for stale error) or a `WorkspaceRef.is_stale()` template method if jj adds one.

## Advanced features (roadmap 2.0)

- [ ] **N-way (3+) conflict handling in merge mode** (Medium) — `reconstructSides()` returns null for >2 sides → "unsupported" message. Queue is earliest-first (option c shipped — propagation roots auto-selected, downstream copies dimmed with ↑ hint). `jj resolve --tool` errors before invoking the tool for irreducible N-way, so the only remaining option is (a) sequential 2-at-a-time frontend orchestration.
- [ ] **SSH non-`@` merge resolve** (Small) — `handleMergeResolve` 501s in SSH (matches `handleSplitHunks`). Follow-up: `RunRaw(["mktemp"])` → `Runner.WriteFile` (already pipes via stdin) → `ResolveApply` with the remote path. ~40 LOC. See [docs/design-notes/specs/2026-04-21-resolve-tool.md](docs/design-notes/specs/2026-04-21-resolve-tool.md) §Non-goals.
- [ ] **Mega-file virtualization** (Low) — manual expand of 5000-line file renders all lines. Auto-collapse at 500 + total-line collapse at 2000 mitigate; `createWindower` (virtual.svelte.ts — already used by RevisionGraph) on the per-hunk `{#each}` inside DiffFileView would be the full fix.
- [ ] **Search across revisions** (Medium) — `jj log -r 'description(glob:"*query*")'` or tree-grep. Needs design.
- [ ] **SSH remote repo browser** (Low) — discover repos on remote host, open as tabs.
- [ ] **Drag-and-drop rebase** (Low) — drag revision onto destination. Inline keyboard rebase already covers the CUJ.
- [ ] **LSP-in-FileEditor** (Complex) — hover/goto in the inline editor. Depends on the LSP running relative to the repo root.

## Known non-goals

Kept here so they don't get re-proposed.

- **Modal-union for App.svelte** — of 9 booleans only 5 are real modals, all use `bind:open` (union would need 5 getter/setter binding pairs = more code than now).
- **Keybind registry** (PaletteCommand-shaped array with `when` predicates) — adding a new mode requires auditing every `when` to add `&& !newMode.active`; current early-return-and-swallow is structurally safer.
- **`createInlineEdit()` / `createDiffSearch()` factories** — stale-guard bug + net +LOC + `set error` smell; factorizing creates "distributed monolith" with injected getters replacing closure access.
