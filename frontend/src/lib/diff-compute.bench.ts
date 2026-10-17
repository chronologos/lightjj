// Pure-compute benchmarks for the diff pipeline: parse → highlight (Lezer) →
// word-diff (LCS) → split-view transform. Run with `pnpm run bench`.
//
// These measure the NON-DOM share of a navigation to an uncached revision.
// DOM/component cost is measured by the real-browser procedure in
// docs/design-notes/diff-perf-benchmarks.md.
//
// Size anchors map to DiffPanel's thresholds:
//   500  = AUTO_COLLAPSE_LINE_LIMIT  (per-file collapse)
//   2000 = AUTO_COLLAPSE_TOTAL_LINES (collapse all files)
//   5000 = HIGHLIGHT_SKIP_LINE_LIMIT / WORD_DIFF_LINE_LIMIT (compute caps)

import { test } from 'vitest'
import { parseDiffContent, type DiffFile } from './diff-parser'
import { highlightLines } from './highlighter'
import { computeWordDiffs } from './word-diff'
import { toSplitView } from './split-view'
import { detectLanguage } from './languages'
import { genDiff, genSourceLines, tsFiles } from './perf-fixtures'

// ── Fixtures (built once; parse benches re-parse the raw text) ─────────────

const RAW_2K = genDiff(tsFiles(4, 500))      // 4 files × 500 lines ≈ 2k
const RAW_10K = genDiff(tsFiles(20, 500))    // 20 files × 500 lines ≈ 10k
const RAW_40K = genDiff(tsFiles(40, 1000))   // 40 files × 1000 lines ≈ 40k
const RAW_SINGLE_5K = genDiff([{ path: 'src/gen/big.ts', lines: 5000 }])

const PARSED_2K = parseDiffContent(RAW_2K)
const PARSED_10K = parseDiffContent(RAW_10K)
const PARSED_SINGLE_5K = parseDiffContent(RAW_SINGLE_5K)

const TS_100 = genSourceLines('a.ts', 100)
const TS_500 = genSourceLines('a.ts', 500)
const TS_2000 = genSourceLines('a.ts', 2000)
const GO_500 = genSourceLines('a.go', 500)

// Mirrors DiffPanel.highlightFile (sync path): per-hunk highlight, keyed map.
function highlightFileSync(file: DiffFile): Map<string, string> {
  const lang = detectLanguage(file.filePath)
  const fileMap = new Map<string, string>()
  for (let hunkIdx = 0; hunkIdx < file.hunks.length; hunkIdx++) {
    const hunk = file.hunks[hunkIdx]
    const highlighted = highlightLines(hunk.lines.map(l => l.content.slice(1)), lang)
    hunk.lines.forEach((line, i) => {
      fileMap.set(`${file.filePath}:${hunkIdx}:${i}`, `<span class="diff-prefix">${line.content[0]}</span>${highlighted[i]}`)
    })
  }
  return fileMap
}

function wordDiffFile(file: DiffFile) {
  const fileMap = new Map<string, Map<number, unknown>>()
  for (let hunkIdx = 0; hunkIdx < file.hunks.length; hunkIdx++) {
    fileMap.set(String(hunkIdx), computeWordDiffs(file.hunks[hunkIdx]))
  }
  return fileMap
}

// ── Benchmarks ──────────────────────────────────────────────────────────────
//
// Vitest 5 API: `bench` is a test-context fixture, not a top-level import.
// Each former describe-group is one test whose benches run together via
// bench.compare() (one comparison table per group). Benches can run well past
// the default 5s testTimeout, so each test opts out with timeout: 0.

const NO_TIMEOUT = { timeout: 0 }

test('parseDiffContent', NO_TIMEOUT, async ({ bench }) => {
  await bench.compare(
    bench('2k lines (4 files)', () => { parseDiffContent(RAW_2K) }),
    bench('10k lines (20 files)', () => { parseDiffContent(RAW_10K) }),
    bench('40k lines (40 files)', () => { parseDiffContent(RAW_40K) }),
  )
})

test('highlightLines (Lezer)', NO_TIMEOUT, async ({ bench }) => {
  await bench.compare(
    bench('ts 100 lines', () => { highlightLines(TS_100, 'typescript') }),
    bench('ts 500 lines', () => { highlightLines(TS_500, 'typescript') }),
    bench('ts 2000 lines', () => { highlightLines(TS_2000, 'typescript') }),
    bench('go 500 lines', () => { highlightLines(GO_500, 'go') }),
  )
})

test('word-diff (LCS)', NO_TIMEOUT, async ({ bench }) => {
  await bench.compare(
    bench('500-line file (per-hunk pairs)', () => { wordDiffFile(PARSED_2K[0]) }),
    bench('5000-line file', () => { wordDiffFile(PARSED_SINGLE_5K[0]) }),
  )
})

test('toSplitView', NO_TIMEOUT, async ({ bench }) => {
  await bench.compare(
    bench('500-line file', () => { toSplitView(PARSED_2K[0].hunks) }),
    bench('5000-line file', () => { toSplitView(PARSED_SINGLE_5K[0].hunks) }),
  )
})

test('full compute pipeline (parse + highlight + word-diff, all files)', NO_TIMEOUT, async ({ bench }) => {
  // Run options are per-compare in v5 (v4 set time: 1000 on the 10k bench
  // only); the slow 10k pipeline needs the longer window for stable samples.
  await bench.compare(
    bench('2k-line diff', () => {
      const files = parseDiffContent(RAW_2K)
      for (const f of files) { highlightFileSync(f); wordDiffFile(f) }
    }),
    bench('10k-line diff', () => {
      const files = parseDiffContent(RAW_10K)
      for (const f of files) { highlightFileSync(f); wordDiffFile(f) }
    }),
    { time: 1000 },
  )
})

test('search scan (findMatches-equivalent over parsed diff)', NO_TIMEOUT, async ({ bench }) => {
  // Approximates DiffPanel.findMatchesInFile: lowercase + indexOf per line.
  function scan(files: DiffFile[], query: string): number {
    let n = 0
    for (const file of files) {
      for (const hunk of file.hunks) {
        for (const line of hunk.lines) {
          if (line.content.toLowerCase().includes(query)) n++
        }
      }
    }
    return n
  }
  await bench('10k-line diff, query "total"', () => { scan(PARSED_10K, 'total') }).run()
})
