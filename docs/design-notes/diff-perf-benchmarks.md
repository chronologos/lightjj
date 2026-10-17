# Diff rendering performance benchmarks

How to measure diff-view performance before/after render-path changes, plus baseline numbers. Re-run the relevant layer(s) after a render-path change and append a dated row rather than overwriting history.

**Latency budget the numbers are judged against** (also stated in specs/pierre-diffs.md): ≤150 ms main-thread block on navigation, ≤500 ms on an explicit action (expand-all, Show anyway, split toggle).

Baselines below: measured 2026-05-25 on an Apple-silicon MacBook. Layer 1 is Node/V8; Layer 2 is WebKit/JavaScriptCore (Bun.WebView) against the production build at v1.28. **A Chrome/Blink run on a fast machine (headless) landed 2026-05-26 — see the very-large-repo section below; a slower-hardware run is still pending, and DOM-construction rates, `content-visibility` behavior, and innerHTML-vs-createElement tradeoffs remain engine-sensitive on hardware not yet covered.**

## Layer 1 — pure compute (`pnpm run bench`, Node/V8)

`src/lib/diff-compute.bench.ts` measures parse → Lezer highlight → word-diff LCS → split-view transform on synthetic but realistic TS/Go diffs (`src/lib/perf-fixtures.ts`). Runs in seconds, no setup.

| operation | size | mean (2026-05-25) |
|---|---|---|
| `parseDiffContent` | 2k / 10k / 40k lines | 0.19 / 0.9 / 3.9 ms |
| `highlightLines` (TS, single parse) | 100 / 500 / 2000 lines | 2.3 / 11 / 46 ms |
| `highlightLines` (Go) | 500 lines | 6.1 ms |
| word-diff LCS (per-hunk pairs) | 500 / 5000-line file | 0.4 / 4.2 ms |
| `toSplitView` | 5000-line file | 0.05 ms |
| full pipeline (parse+highlight+word-diff) | 2k / 10k-line diff | 49 / 251 ms |
| search scan | 10k lines | 0.3 ms |

Reading it: highlight is the only compute that matters (~22–25 ms per 1k TS lines for a *single* parse). The production path parses per hunk, so many small hunks are far cheaper than one big parse — but a single-hunk file (a new file, a large block add) pays the single-parse rate in one sync chunk; that is what `HIGHLIGHT_SKIP_LINE_LIMIT` bounds. The 251 ms pipeline figure arrives in one block only if nothing yields — `HIGHLIGHT_IMMEDIATE_LINES` exists to prevent exactly that.

(There was previously a Layer-2 jsdom component-mount bench; it was dropped after review — jsdom has no layout/paint and diverges from real engines exactly where render-path changes act, so it invited false confidence. Use the real-browser layer for anything DOM-related.)

## Layer 2 — real browser, controlled repo

`frontend/scripts/gen-bench-repo.mjs` generates file states whose diffs have known sizes. Build the repo, run a production binary against it, and measure interactions.

```bash
# 1. controlled repo (sibling revisions off one base)
R=/tmp/lightjj-bench/repo; rm -rf $R && mkdir -p $R && cd $R && jj git init .
node <lightjj>/frontend/scripts/gen-bench-repo.mjs $R base && jj describe -m base
B=$(jj log --no-graph -T 'change_id.short()' -r @)
for s in small medium large huge wide; do jj new $B -m "$s diff"; node <lightjj>/frontend/scripts/gen-bench-repo.mjs $R $s; done
jj new $B -m wc

# 2. production build, isolated config, no background snapshot churn
cd <lightjj>/frontend && pnpm run build && cd .. && go build -tags embed -o /tmp/lightjj-bench/bin ./cmd/lightjj
HOME=/tmp/lightjj-bench/home /tmp/lightjj-bench/bin --addr localhost:4399 --no-browser --no-watch --snapshot-interval 0 -R $R
```

Measured fixture sizes (total hunk lines, what `totalDiffLines` counts): small **533** (1 file), medium **3.8k** (4 files), wide **4.7k** (25 files × ~215 lines — under the per-file compute caps, so highlight + word-diff fully run), large **19k** (16 files), huge **38.8k** (30 files), base 20k (25 added files).

Measurement notes (limitations of the 2026-05-25 run — tighten these on the next pass):
- Timings used `performance.now()` + rAF polling: "first-frame block" = time to the first rAF after the action. rAF fires before style/layout/paint, so this **understates** real interaction latency (excludes layout/paint of freshly inserted nodes, later GC, queued-input delay). Prefer Long Tasks / Event Timing (INP) or a DevTools trace for headline numbers.
- Single-shot manual runs, no variance, warm app caches. Script it (≥5 runs, median + spread, recorded commit + browser version) before trusting small deltas.
- WebKit only; no memory/heap measurements; no slow-hardware run.

### Baseline (2026-05-25, WebKit/JavaScriptCore, production build, v1.28 thresholds)

| action | first-frame block | total | DOM nodes after |
|---|---|---|---|
| navigate → small 533 (collapsed header) | 2 ms | 102 ms | 349 |
| expand small 533 (plain¹) | 20 ms | 34 ms | 2.9k |
| expand-all medium 3.8k (plain¹) | 99 ms | 161 ms | 16k |
| navigate → wide 4.7k (compute incl. highlight runs while hidden) | 2 ms | 275 ms | max rAF gap ≤11 ms |
| expand-all wide 4.7k (highlighted) | 382 ms | 590 ms | 100k (≈21 nodes/line) |
| split toggle on expanded wide | 309 ms | 329 ms | 160k |
| navigate away from expanded wide (unmount 100k nodes) | 2 ms | 112 ms | — |
| expand-all large 19k (plain¹) | 399 ms | 702 ms | 80k |
| expand-all huge 38.8k (plain¹) | 728 ms | 1363 ms | 156k |
| scroll expanded huge (1500 px/frame × 90) | mean 8 ms/frame, max 13 ms | — | — |

¹ **Obsolete-path rows.** These were measured under the pre-v1.29 behavior where any file >20k chars skipped highlighting — every file in the medium/large/huge fixtures tripped it, so those rows show the cheaper plain DOM (~4 nodes/line). After the compute-skip decoupling, the same diffs take the highlighted path (~21 nodes/line, ~80–90 ms per 1k lines — the "wide" rows are the representative ones). Re-measure before citing the plain rows for any decision.

### What the numbers say (and don't)

- **DOM construction is the dominant cost** (~80–90 ms per 1k highlighted lines, ~20–25 ms plain, WebKit). Compute on per-hunk content never produced a >15 ms gap; single-hunk files follow the Layer-1 single-parse rate instead.
- **Scrolling an already-mounted 38.8k-line diff is smooth** (`content-visibility: auto`); selection/navigation stays responsive; unmounting 100k nodes ≈ 100–250 ms.
- **Auto-collapse does not avoid DOM construction.** The collapse set is written by an `$effect` after the template has already rendered the new `parsedDiff`, so navigation onto an unhidden diff transiently built every body and discarded it before paint. (Fixed by Phase 2's derived collapse — kept here because it explains the v1.28 rows above.)
- The old 20k-char compute skip silently downgraded normal ~300+-line files to unhighlighted rendering; fixed in v1.29 by per-file line caps (`HIGHLIGHT_SKIP_LINE_LIMIT`, `WORD_DIFF_LINE_LIMIT`).

### After Phase 1+2 (2026-05-25, same WebKit setup, compute-skip decoupled + derived collapse + deferred mounting)

| action | first-frame block | notes |
|---|---|---|
| navigate → wide 4.7k | 1 ms (219 ms total incl. fetch) | collapsed headers only |
| expand-all wide 4.7k (highlighted) | **37 ms** (was 382 ms) | eager ~750 lines mount; 21 placeholders mount as you scroll (~10 ms/frame mean, 31 ms max while mounting) |
| navigate → huge 38.8k | 2 ms (430 ms total) | no longer hidden; 30 collapsed headers |
| expand-all huge 38.8k (now highlighted) | 177 ms | eager files are ~1.3k lines each; 28 placeholders defer |
| navigate away from expanded (81k nodes) | 1 ms (111 ms total) | teardown unchanged |
| expand small 533 (now highlighted) | 33 ms | previously rendered permanently plain |

### Very large real repository — backend + Chrome/Blink (2026-05-26)

First run against a very large real repository (1M+ commits) instead of the controlled fixture repo. Production build, repo on local disk, loopback HTTP. Backend timings are warm `curl` against the running binary; browser timings are headless Chrome (Blink) using a paint-accurate endpoint (content-present frame + one nested rAF), repeated runs.

Backend (warm, via curl):

| endpoint | revision | time |
|---|---|---|
| `/api/revision-meta` (files+description only) | any size | 0.21–0.24 s |
| `/api/revision` (diff+files+description) | 353-line diff | 0.20–0.28 s |
| `/api/revision` | 34.7k lines / 62 files (4.0 MB) | ~0.39 s |
| `/api/revision` | 79k lines / 259 files (3.6 MB) | ~0.40 s |
| `/api/revision` | 172k lines / 25 files (4.0 MB) | ~0.43 s |

The per-call fixed cost (~0.2 s) dominates; a 4 MB diff adds only ~0.2 s. Consequence: a backend per-file lazy diff-fetch phase is **not** warranted for local repos — each extra round trip costs the same ~0.2 s fixed jj-call overhead it would try to save. SSH mode is unmeasured and could change that. (Separately: the default-revset `/api/log` took ~5 s reproducibly on this repo — unrelated to the diff path; tracked as its own open issue.)

Browser (headless Chrome/Blink, paint-accurate endpoint):

| action | diff fetch | arrival→painted | max main-thread frame gap |
|---|---|---|---|
| navigate → 3,050-line / 9-file source revision, uncached (n=5, medians) | 185 ms | 36 ms | 25 ms |
| navigate → 34.7k-line / 62-file revision (renders, under the hide gate) (n=3) | 336 ms | 21 ms | 33 ms |
| expand-all on the 34.7k revision (n=2) | — | click→painted 55–62 ms | ≤57 ms during the 3 s deferred-placeholder-mount window |

(Earlier single-shot WebKit numbers on this repo used a *pre-paint single-rAF* endpoint, so they aren't directly comparable to the rows above: at-arrival 75–105 ms with max gap ≤44 ms on 79k/172k-line gate-hidden revisions, 103 ms on the 34.7k one. Cite them only with that methodology caveat.)

What this run says: navigation latency on a very large *local* repo is fetch-bound; render-side at-arrival work stays well inside the ≤150 ms budget on fast hardware in both engines. Phase 3's own trigger ("near-viewport mounting still >150 ms after Phase 2") was measured **not met** on fast hardware (expand-all ≤62 ms to paint, ≤57 ms worst block) — Phase 3 stays dormant per its kill criteria in specs/pierre-diffs.md, not killed; the slower-hardware / battery-throttled / heap / Cmd+F / annotations-at-scale / SSH validation gates remain open and unmeasured.

### Split view → single CSS grid (2026-10-17, issue #41, headless Chrome 155, fast Apple-silicon machine)

Split markup changed from two independent column stacks to one 2-column grid with cells in pair order (rows can no longer drift when a line soft-wraps). Measured split toggle on an expanded **wide** fixture (`Expand all`, then scrolled through to mount every deferred body: 1,312 mounted `.diff-line`s in unified), production build, `--no-watch --snapshot-interval 0`, 7 toggles per run (median), runs alternated old/new binary:

| viewport | old (two columns) median of runs | new (grid) median of runs | forced layout after first rAF |
|---|---|---|---|
| 1400 px | 112 / 96 / 97 ms | 99 / 111 / 97 ms | 21–22 ms both |
| 800 px (heavy wrapping) | 97 / 94 ms | 97 / 99 ms | 21–22 ms both |

DOM nodes in split: 26,211 → 26,108 (two column wrappers + the duplicate right-side hunk header per file removed). Unified unaffected (~80 ms, 16,713 nodes both). A first cut that wrapped each cell in a snippet with nested `{#if}`s measured ~15% slower (≈113 vs ≈97 ms; CPU profile: native `before()` insertion 18 → 30 ms from the extra comment anchors per cell) — the shipped markup keeps the old per-row block count. Grid layout itself cost no more than the two block columns at either width. Methodology caveats as above (click → rAF → forced `offsetHeight` → double rAF; single machine).

### Scenarios not yet measured (needed before further default changes)

One slow / battery-throttled machine (Chrome/Blink is now partially covered — fast machine, headless, 2026-05-26 section above); heap/retained-DOM across cached revisions and tabs; rapid j/k across several consecutive large revisions; Cmd+F (browser find) over a fully expanded huge diff; annotations + word-diff active at scale; a single 1–3k-line *single-hunk* highlighted file; a ~1.5–2k-line revision that renders bodies eagerly (both 2026-05-26 sampled revisions exceeded the 2,000-line total-collapse threshold, so first paint was collapsed headers); lock-file / minified / very-long-line fixtures; SSH mode. Backend `jj diff` latency on a very large repository (1M+ commits) is now measured (2026-05-26 section above). The validation gates in specs/pierre-diffs.md reference this list.
