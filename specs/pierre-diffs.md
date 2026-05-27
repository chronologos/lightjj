# Diff-rendering performance: Pierre study + phased plan

Two things in one doc: (a) notes from a study of [`@pierre/diffs`](https://github.com/pierrecomputer/pierre) (Apache-2.0, commit `a38caded` / 2026-05-23, local clone `~/3pcode/pierre`), the diff-rendering library behind Pierre's code-review product; (b) the resulting phased plan for lightjj, revised after a multi-reader design review (2026-05-25). Design-level inspiration only — no code is ported, so no attribution notice is required; if a future change ports actual code, add the Apache-2.0 upstream notice per the project licensing policy.

**Evidence base**: [docs/design-notes/diff-perf-benchmarks.md](../docs/design-notes/diff-perf-benchmarks.md) (measured 2026-05-25, Apple-silicon MacBook, WebKit/JavaScriptCore via Bun.WebView — Chrome replication still pending; engine-sensitive conclusions are flagged below). Headline numbers: DOM construction is the dominant cost (~80–90 ms per 1k **highlighted** lines at ~21 nodes/line, ~20–25 ms per 1k plain lines); Lezer + LCS compute never produced a >15 ms frame gap on per-hunk content (does NOT generalize to single huge hunks — a 2k-line single parse is ~46 ms); scrolling an already-mounted 38k-line diff is smooth (`content-visibility: auto`); unmounting 100k nodes costs ~100–250 ms. Two caveats discovered after the first draft: the large-diff browser rows were measured on the *plain* path (the old 20k-char skip), so post-decoupling costs are ~3–4× those rows; and auto-collapse is applied by an `$effect` *after* the template renders (since removed by Phase 2's derived collapse), so an unhidden navigation transiently builds every file body and discards it — collapse avoids paint, not DOM construction.

**Latency budget** (the number every cap below derives from): ≤150 ms main-thread block on navigation (j/k, no explicit action), ≤500 ms on an explicit action (expand-all, Show anyway, split toggle), measured as longest main-thread block in Chrome on a very large real repository, not just WebKit.

---

## What Pierre does, and the verdict for lightjj

Verdict vocabulary: **adopt** (do it), **defer-until-measured** (listed with a numeric trigger), **skip** (rejected with reason).

### 1. Two-level virtualization

Pierre: offscreen *files* become single estimated-height placeholder divs (shared IntersectionObserver, rootMargin 4×1000px); within visible files only hunk-aligned 50-row windows mount, with spacer divs, a sparse measured-delta height cache, layout checkpoints, and scroll re-anchoring after every reflow (`Virtualizer.ts:387-541`). Documented tradeoff: find-in-page and cross-file selection break over unmounted content.

**lightjj verdict**: **adopt the file level** (Phase 2) — our scroll FPS is already fine via `content-visibility`; what we pay is up-front DOM creation. **Defer-until-measured** the line level (trigger: a single near-viewport file still blocks >150 ms after Phase 2). We accept the same tradeoff Pierre documents: Cmd+F/select-all will not see files that have never mounted; every programmatic jump must force-mount first (the integration points are enumerated in Phase 2 below — they do NOT come for free, scrollToMatch/scrollToHunk query the body DOM one tick after expanding and would silently no-op against an async mount).

### 2. DOM shape and batch insertion

Pierre: ~1 div per line inside per-column `<code>` grids (subgrid gutters), `+`/`-` drawn as CSS `::before`, the whole column serialized to one HTML string and injected via `innerHTML`/`insertAdjacentHTML`, hover/selection via delegated listeners toggling data-attributes, one adopted stylesheet, CSS-variable theming.

**lightjj verdict**: mostly **defer-until-measured**. The single-string `{@html}` row rendering would cut mount cost ~2–4× but rebuilds DiffFileView's hot template and moves annotations/search-highlight/conflict chrome onto delegated handlers (trigger: mounting the near-viewport batch still exceeds ~150 ms after Phase 2). The `::before` prefix idea is **skipped**: the prefix is baked into cached highlight HTML (`highlightFile`), differs per conflict-line type, and is excluded from copy by `extractLineFromDom` — a cross-cutting edit for ~5% of nodes. The one piece adopted now: per-file `contain-intrinsic-size` estimated from line count (shipped in Phase 1).

### 3. Highlighting pipeline

Pierre: whole-file Shiki in a worker pool (≤ min(cores−1, 3)), request dedup by content key, LRU of line ASTs, plain-text-first render that swaps when tokens arrive. Caps: per-line tokenization stops at 1000 chars, files >100k lines go plain, intra-line word diff off above 1000-char lines / >1000-line plain diffs.

**lightjj verdict**: **skip the worker pool** (Lezer is 1–2 orders of magnitude faster than Shiki and per-hunk parses never registered as frame gaps; revisit only if a profile shows highlight blocking after the caps change). **Adopt the caps philosophy** (shipped in Phase 1): compute-skip is now decided by line counts and per-line guards, not by the 20k-char collapse limit that was silently un-highlighting every ~300+-line file.

### 4. Large-diff guards

Pierre: plain text above 100k lines/file, context collapsed behind expanders, optional header-only collapse — but no "don't render at all" gate; virtualization makes total size mostly irrelevant.

**lightjj verdict**: destination state, **after** Phase 2. Until the collapse decision happens before first render and offscreen files defer their mount, the hide gate stays load-bearing (see Phase 1 notes on the transient-render mechanism). Per-file auto-collapse remains a reading preference even afterwards — collapsed lock/generated files double as a table of contents; any change to that default is a UX decision, not a perf necessity.

### 5. Smaller mechanisms

Global rAF render queue (we have ad-hoc equivalents — fine), numeric scroll anchors (only relevant with line windowing), `resizeDebugging`-style estimate-vs-real height check (worth imitating when tuning placeholder estimates), streaming token renderer (not our problem space).

---

## Phase 1 — compute decoupling + safe gate raise (implemented 2026-05-25)

Shipped in this change, all in `DiffPanel.svelte` / `DiffFileView.svelte`:

| change | constant | rationale |
|---|---|---|
| Highlight skip is per-file **lines**, not chars | `HIGHLIGHT_SKIP_LINE_LIMIT = 5000` (plus a `HIGHLIGHT_SKIP_CHAR_LIMIT = 500k` per-file backstop) | worst single-hunk parse ≈ 23 ms/1k → ~115 ms, inside the nav budget; minified one-liners already fall back via the >2000-char per-line guard in `highlightLines()` |
| Word-diff cap raised | `WORD_DIFF_LINE_LIMIT = 5000` (was 1000), char-based skip removed | LCS measured ~4 ms at 5k lines; per-line `MAX_TOKENS_FOR_LCS` still guards pathological lines |
| Highlight run yields past a budget | `HIGHLIGHT_IMMEDIATE_LINES = 3000` (was `Infinity`) | with more files eligible, an all-eligible huge diff must not sync-block; accepted tradeoff: a context-expand racing a yielded run leaves later files plain until the next visit (same as word-diffs today) |
| Hide gate raised 1000 → 5000 → 50,000 | `HIDE_DIFF_TOTAL_LINES = 50_000` | initially capped at 5000 because auto-collapse ran *after* first render (transient body build-and-discard); once Phase 2's derived collapse + deferred mounting removed that transient, raised to an extreme fallback — only pathological diffs see "Show anyway" now |
| Per-file `contain-intrinsic-size` estimate | inline style, lines×18 + hunks×24 + 40 | replaces the flat 200px hint; suppressed for collapsed/preview/editing/binary so a collapsed header doesn't claim 90,000px |
| Collapse thresholds unchanged | `AUTO_COLLAPSE_LINE_LIMIT = 500`, `AUTO_COLLAPSE_TOTAL_LINES = 2000`, `AUTO_COLLAPSE_CHAR_LIMIT = 20k` | collapse is a reading preference + DOM guard; raising defaults is a Phase-2+ decision made against the budget once the transient-render problem is gone |

Dropped from the original draft after review: CSS `::before` prefix (not micro — see §2), worker highlighting (wrong bottleneck), and the large threshold raises (8–10k hide / 6k collapse-all) that would have landed before the mechanism that makes them safe.

Known interim costs (accepted): expand-all on a 2–5k-line now-highlighted diff is ~3–4× the old plain cost (still inside the 500 ms explicit-action budget on the bench machine; Chrome validation pending); generated files with normal-length lines and no skip suffix now get highlight + word-diff up to 5k lines.

## Phase 2 — decide-before-render + per-file deferred mounting (implemented 2026-05-25)

What shipped (DiffPanel.svelte / DiffFileView.svelte / diff-cache.ts):

1. **Derived collapse state.** The post-render auto-collapse `$effect` is gone. Per-file decision at render time: `userExpanded > userCollapsed > auto-collapse predicate` (`isFileCollapsed`), with the predicate consulted live (a previewed/edited file never auto-collapses). `collapseStateCache` now stores the two explicit-intent sets (change_id-keyed `CollapseMemo`); the suppression flag and `lastAutoCollapseDiff` no longer exist. Contract change: an explicit expand now survives revisits even when nothing else is collapsed (intent is intent). The transient build-and-discard is gone — a 5k-line auto-collapsed file never builds its body (the regression test relies on test speed: a transient render would blow the jsdom timeout).
2. **Per-file deferred mounting.** Placeholder = real header + estimated-height body stand-in (`.diff-body-placeholder`, `contain: strict`; height from the same `bodyEstPx` estimate as the intrinsic-size hint). Files inside the eager window (`EAGER_MOUNT_LINES = 600` cumulative) mount immediately; the rest mount via a DiffPanel-owned IntersectionObserver (rootMargin ±200%, re-attached when the placeholder population can change — diff change, mount, collapse-intent flip), pumped one file per frame; mounts above the viewport go through `holdViewport()` re-anchoring.
3. **Force-mount hook.** `revealFile(path)` (expand-intent + mount) is the single hook behind every programmatic jump: `scrollToHunk`, `scrollToMatch`, `scrollToFile(expand:true)`, editor/preview open, plus a dedicated mount for the hunk-review cursor's file. `stepFile` keeps its deliberate `expand:false` header-scroll behavior. Annotation jumps and the agent navigate/focus API route through these same functions.
4. **Refresh semantics.** Same-change refresh keeps the mounted set and pins currently-expanded files as explicit expands (so a file that grew past a threshold doesn't snap shut); a different revision clears mounted + intent and restores intent from the cache.
5. **Hide gate** raised to 50k (extreme fallback) now that navigation cost no longer scales with diff size.

Still open (deliberately): **auto-unmount of far-away files** (memory/teardown is no worse than the old fully-mounted behavior, so it waits for heap measurements — re-placeholder at ~8+ viewports with measured height when justified); **collapse-all / per-file default changes** (whether files should arrive expanded by default) wait for the validation gates below.

Measured after implementation (same WebKit setup as the baseline): wide 4.7k expand-all 382 ms → **37 ms** first-frame (rest mounts as you scroll, ~10 ms/frame mean); huge 38.8k is no longer hidden — navigation renders 30 collapsed headers in one frame, expand-all first-frame 177 ms (eager files are ~1.3k lines each and now *highlighted*); navigation away from an 81k-node view ~110 ms; the 533-line file that used to render permanently plain now expands fully highlighted.

Accepted tradeoff (state in release notes): browser-native Cmd+F/select-all do not see never-mounted file bodies; in-app diff search walks parsed data and force-mounts its target, so it is unaffected.

## Phase 3 — only on measured triggers

- Single-string `{@html}` row rendering: only if mounting the near-viewport batch still exceeds ~150 ms after Phase 2.
- Line-level render ranges (Pierre level 2): only if a single file inside the viewport still exceeds the budget (e.g. a 5k-line single-hunk file someone expands).
- Worker highlighting: removed from the plan; re-propose only with a profile showing Lezer blocking frames.

**Measurement update (2026-05-26)** (production build, repo on local disk, loopback HTTP — full numbers in [diff-perf-benchmarks.md](../docs/design-notes/diff-perf-benchmarks.md)):

- On a very large real repository (1M+ commits), navigation latency is fetch-bound: `/api/revision` is ~0.2–0.28 s for a small diff and only ~0.4 s for a 4 MB / 172k-line one (the ~0.2 s per-call fixed cost dominates), while render-side at-arrival work stays well inside the ≤150 ms budget on fast hardware in both engines (Chrome arrival→painted ≤36 ms; earlier WebKit single-rAF runs ≤105 ms).
- Phase 3's own trigger ("near-viewport mounting still >150 ms after Phase 2") was measured **not met** on fast hardware: expand-all on a 34.7k-line / 62-file revision painted in ≤62 ms with worst frame gap ≤57 ms — Phase 3 stays dormant per the kill criteria above (not killed). The slower-hardware / battery-throttled / heap / Cmd+F / annotations-at-scale / SSH gates below remain open and unmeasured.
- A backend per-file lazy diff-fetch phase is **not** warranted for local repos — each extra round trip costs the same ~0.2 s fixed jj-call overhead it would try to save. SSH mode is unmeasured and could change that.

## Validation gates (run before flipping any default)

Scenarios, run in Chrome against a very large real repository (1M+ commits) and once on battery-throttled hardware, using Long Tasks / INP-style metrics rather than rAF gaps:

1. j/k across 10 consecutive large revisions (mix of generated + source diffs) — no block >150 ms.
2. Open the largest recent bundle-churn revision; expand-all — no block >500 ms; heap delta recorded.
3. Cmd+F a term that matches in the last file of a 20k+-line diff — match reachable, no block >150 ms (Phase 2: includes force-mount).
4. Annotations + word-diff active on a 3–5k-line highlighted diff — j/k away/back unaffected.
5. SSH mode spot-check (the 400 ms round-trip dominates; confirm no *additional* frontend stall).
6. Re-run `pnpm run bench` (compute) + the browser procedure in diff-perf-benchmarks.md and append a dated row to its baseline table.
