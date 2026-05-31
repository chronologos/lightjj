import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest'
import { render, fireEvent } from '@testing-library/svelte'
import { SvelteSet } from 'svelte/reactivity'

// Mock api before importing DiffPanel — createAnnotationStore captures api.*
// at module eval time. importOriginal preserves pure helpers (diffTargetKey).
vi.mock('./api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./api')>()
  return {
    ...actual,
    api: {
      ...actual.api,
      edit: vi.fn(),
      fileShow: vi.fn(),
      fileWrite: vi.fn(),
      mergeResolve: vi.fn(),
      restore: vi.fn(),
      diff: vi.fn(),
      // Namespaced annotation client — mirrors the real api.annotations shape.
      annotations: {
        list: vi.fn().mockResolvedValue([]),
        save: vi.fn(),
        remove: vi.fn(),
        clear: vi.fn(),
      },
      diffRange: vi.fn().mockResolvedValue({ diff: '' }),
    },
  }
})

import DiffPanel from './DiffPanel.svelte'
import { api, diffTargetKey, type DiffTarget, type FileChange } from './api'
import { clearDiffCaches, derivedCache } from './diff-cache'
import { createCommentVisibility } from './comment-visibility.svelte'

const mockEdit = api.edit as Mock
const mockFileShow = api.fileShow as Mock

// settle: two macrotasks — covers loader.svelte.ts's setTimeout(0) deferred
// loading-flag write AND the subsequent microtask flush.
const settle = async () => { await new Promise(r => setTimeout(r, 0)); await new Promise(r => setTimeout(r, 0)) }

function target(commitId: string, changeId: string, overrides: Partial<Extract<DiffTarget, { kind: 'single' }>> = {}): DiffTarget {
  return { kind: 'single', commitId, changeId, isWorkingCopy: false, immutable: false, ...overrides }
}

function mkFile(path: string, overrides: Partial<FileChange> = {}): FileChange {
  return { type: 'M', path, additions: 1, deletions: 0, conflict: false, conflict_sides: 0, ...overrides }
}

// Minimal unified diff — one file, one line added. parseDiffContent produces
// a DiffFile with one hunk → DiffFileView renders → Edit button appears.
const tinyDiff = (path: string) =>
  `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -0,0 +1 @@\n+x\n`

function props(overrides: Record<string, unknown> = {}) {
  // diffContentKey is a required prop. Default it to match diffTarget
  // ("content has caught up") so fixtures that don't exercise the
  // content/target mismatch keep working; tests that do exercise it pass
  // diffContentKey explicitly and the override below wins.
  const diffTarget = ('diffTarget' in overrides
    ? overrides.diffTarget
    : target('co-A', 'ch-A')) as DiffTarget | undefined
  return {
    diffContent: tinyDiff('a.go'),
    changedFiles: [mkFile('a.go')],
    diffTarget,
    diffContentKey: diffTarget ? diffTargetKey(diffTarget) : '',
    diffLoading: false,
    splitView: false,
    vis: createCommentVisibility(),
    fileSelectionMode: false as const,
    selectedFiles: new SvelteSet<string>(),
    ontogglefile: vi.fn(),
    ...overrides,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  // Module-scoped caches survive test unmounts (that's the point of them).
  // Without this, tests leak collapse/derived state into each other.
  clearDiffCaches()
})

// --- Helper queries via DiffFileView DOM ---
// editing=true → Save/Cancel buttons render; editing=false + onedit → Edit button.
// These are the only externally observable signals for the edit state (it lives
// inside DiffPanel's file-actions factory, not on the component).
function headerBtn(c: HTMLElement, ...labels: string[]) {
  return [...c.querySelectorAll('.diff-file-header .btn')]
    .find(b => labels.includes(b.textContent ?? '')) as HTMLButtonElement | undefined
}
const editBtn = (c: HTMLElement) => headerBtn(c, 'Edit')
const previewBtn = (c: HTMLElement) => headerBtn(c, 'Preview', 'Source')
function saveBtn(c: HTMLElement) {
  return c.querySelector('.diff-file-header .btn-primary') as HTMLButtonElement | null
}

describe('DiffPanel', () => {
  describe('startEdit race guard — file-actions.svelte.ts post-await identity guards', () => {
    it('navigation during api.edit await → editor does NOT appear', async () => {
      let resolveEdit!: () => void
      mockEdit.mockReturnValue(new Promise<void>(r => { resolveEdit = r }))
      mockFileShow.mockResolvedValue({ content: 'stale file body' })

      const { container, rerender } = render(DiffPanel, { props: props() })
      await settle()

      // Click Edit → startEdit captures revId='ch-A', suspends at api.edit.
      const btn = editBtn(container)
      expect(btn).toBeDefined()
      await fireEvent.click(btn!)
      expect(mockEdit).toHaveBeenCalledWith('ch-A')

      // User navigates to B while edit is pending.
      await rerender(props({
        diffTarget: target('co-B', 'ch-B'),
        diffContent: tinyDiff('a.go'),
      }))
      await settle()

      // A's api.edit resolves; the post-await guard compares live diffTarget.changeId
      // ('ch-B') against captured revId ('ch-A') → bails BEFORE fileShow.
      resolveEdit()
      await settle()

      expect(mockFileShow).not.toHaveBeenCalled()
      expect(saveBtn(container)).toBeNull() // editor never opened
    })

    it('navigation during api.fileShow await → stale content NOT written', async () => {
      mockEdit.mockResolvedValue(undefined)
      let resolveShow!: (v: { content: string }) => void
      mockFileShow.mockReturnValue(new Promise(r => { resolveShow = r }))

      const { container, rerender } = render(DiffPanel, { props: props() })
      await settle()

      await fireEvent.click(editBtn(container)!)
      await settle() // api.edit resolves, fileShow fires, suspends

      expect(mockFileShow).toHaveBeenCalledWith('ch-A', 'a.go')

      // Navigate away BEFORE fileShow resolves.
      await rerender(props({
        diffTarget: target('co-B', 'ch-B'),
        diffContent: tinyDiff('a.go'),
      }))
      await settle()

      // Stale fileShow resolves — the post-await guard bails, editFileContents NOT set.
      resolveShow({ content: 'stale' })
      await settle()

      expect(saveBtn(container)).toBeNull()
    })

    it('no navigation → editor opens normally (happy path)', async () => {
      mockEdit.mockResolvedValue(undefined)
      mockFileShow.mockResolvedValue({ content: 'file body' })

      const { container } = render(DiffPanel, { props: props() })
      await settle()

      await fireEvent.click(editBtn(container)!)
      await settle()

      expect(saveBtn(container)).not.toBeNull() // editing=true → Save renders
    })
  })

  describe('discardFile busy-guard — file-actions.svelte.ts editBusy hold', () => {
    // The race documented at discardFile in file-actions.svelte.ts: startEdit
    // releases the mutation lock after api.edit resolves, then awaits fileShow
    // holding only editBusy. A Discard click during that window must no-op —
    // otherwise restore succeeds, then the resumed fileShow writes pre-discard
    // content.
    it('Discard while startEdit has editBusy → no-op (restore NOT called)', async () => {
      mockEdit.mockResolvedValue(undefined)
      let resolveShow!: (v: { content: string }) => void
      mockFileShow.mockReturnValue(new Promise(r => { resolveShow = r }))
      const mockRestore = api.restore as Mock

      const { container } = render(DiffPanel, { props: props() })
      await settle()

      // Start edit → api.edit resolves immediately, now suspended in fileShow.
      // editBusy.has('a.go') is true for the rest of this test until resolve.
      await fireEvent.click(editBtn(container)!)
      await settle()

      expect(mockFileShow).toHaveBeenCalled()

      // Click Discard while editBusy is held → the editBusy guard bails.
      const discard = headerBtn(container, 'Discard')
      expect(discard).toBeDefined()
      await fireEvent.click(discard!)
      await settle()

      expect(mockRestore).not.toHaveBeenCalled()

      resolveShow({ content: 'body' })
      await settle()
    })

    // Regression: onjjmutation=withMutation holds mutating=true through
    // res.json(), so App's derived-staleness effect defers its refresh until
    // the gate clears. Explicit onfilesaved is the IMMEDIATE refresh path
    // (App's attemptedOpId dedups the deferred pass). Same mechanism
    // saveFile/saveMerge use.
    it('successful discard → onfilesaved called (explicit refresh)', async () => {
      const mockRestore = api.restore as Mock
      mockRestore.mockResolvedValue({ warnings: '' })
      const onfilesaved = vi.fn().mockResolvedValue(undefined)

      const { container } = render(DiffPanel, { props: props({ onfilesaved }) })
      await settle()

      await fireEvent.click(headerBtn(container, 'Discard')!)
      await settle()

      expect(mockRestore).toHaveBeenCalledWith('ch-A', ['a.go'])
      expect(onfilesaved).toHaveBeenCalledOnce()
    })

    it('navigation during discard await → onfilesaved NOT called', async () => {
      const mockRestore = api.restore as Mock
      let resolveRestore!: (v: unknown) => void
      mockRestore.mockReturnValue(new Promise(r => { resolveRestore = r }))
      const onfilesaved = vi.fn().mockResolvedValue(undefined)

      const { container, rerender } = render(DiffPanel, { props: props({ onfilesaved }) })
      await settle()

      await fireEvent.click(headerBtn(container, 'Discard')!)

      // Navigate away while restore is pending
      await rerender(props({ diffTarget: target('co-B', 'ch-B'), onfilesaved }))
      await settle()

      resolveRestore({ warnings: '' })
      await settle()

      // Identity guard: diffTarget.changeId (ch-B) !== captured revId (ch-A)
      expect(onfilesaved).not.toHaveBeenCalled()
    })
  })

  describe('reset effect — DiffPanel nav-identity reset', () => {
    it('navigation clears editing state', async () => {
      mockEdit.mockResolvedValue(undefined)
      mockFileShow.mockResolvedValue({ content: 'body' })

      const { container, rerender } = render(DiffPanel, { props: props() })
      await settle()

      await fireEvent.click(editBtn(container)!)
      await settle()
      expect(saveBtn(container)).not.toBeNull() // editing=true

      // Navigate → reset effect clears editingFiles.
      await rerender(props({
        diffTarget: target('co-B', 'ch-B'),
        diffContent: tinyDiff('a.go'),
      }))
      await settle()

      expect(saveBtn(container)).toBeNull()
      expect(editBtn(container)).toBeDefined() // back to Edit button
    })

    it('search survives navigation (searchOpen stays, query clears)', async () => {
      const { container, component, rerender } = render(DiffPanel, { props: props() })
      await settle()

      // openSearch is exported for bind:this; testing-library's `component`
      // is the instance. Calling directly matches App.svelte:1076.
      component.openSearch()
      await settle()

      const input = container.querySelector('.search-input') as HTMLInputElement
      expect(input).toBeInTheDocument()
      await fireEvent.input(input, { target: { value: 'foo' } })
      expect(input.value).toBe('foo')

      // Navigate. Reset effect at :562 does:
      //   if (searchOpen) { searchQuery = ''; currentMatchIdx = 0 }
      // — does NOT set searchOpen = false. Bar stays visible so user can
      // re-type for the new revision without re-opening. A factory `close()`
      // would have changed this behavior.
      await rerender(props({
        diffTarget: target('co-B', 'ch-B'),
        diffContent: tinyDiff('a.go'),
      }))
      await settle()

      const inputAfter = container.querySelector('.search-input') as HTMLInputElement
      expect(inputAfter).toBeInTheDocument() // bar still open
      expect(inputAfter.value).toBe('') // query cleared
    })

    it('highlights apply on post-lag parsedDiff update when cacheKey already advanced', async () => {
      // Root cause: activeRevisionId updates sync at nav; diff.value (→
      // diffContent → parsedDiff) lags the async fetch. Pre-fix the $effect
      // would fire with STALE parsedDiff under the NEW cacheKey, writeMemo
      // poisoning derivedCache[newCacheKey] with stale-file entries. When
      // fresh parsedDiff later arrived, tryRestore hit the poisoned memo
      // (non-empty → looks like a hit), skipped the real run, and the new
      // file rendered without tok-* spans until a manual update() call
      // (context-expand) seeded them. Go/zig symptom in the wild, nothing
      // language-specific.
      //
      // Scenario needs TWO files in the outgoing rev → ONE file in the new
      // rev so single-file-delta (:835) doesn't mask the bug via update().
      const twoFile = tinyDiff('a.go') + tinyDiff('b.go')
      // Real Go keywords → tok-keyword spans if highlighting runs.
      const newGo = (path: string) =>
        `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n` +
        `@@ -0,0 +1,2 @@\n+package foo\n+var x int\n`

      const { container, rerender } = render(DiffPanel, {
        props: props({
          diffContent: twoFile,
          changedFiles: [mkFile('a.go'), mkFile('b.go')],
          diffTarget: target('co-A', 'ch-A'),
          diffContentKey: 'co-A',
        }),
      })
      await settle()

      // Nav to B: cacheKey flips sync, diffContent still lags. diffPending=true
      // AND diffContentKey='co-A' both signal the mismatch — either would
      // suffice here. (The isRefresh sibling test below exercises the gap
      // where only diffContentKey is load-bearing.)
      await rerender(props({
        diffContent: twoFile, // stale
        changedFiles: [mkFile('a.go'), mkFile('b.go')],
        diffTarget: target('co-B', 'ch-B'),
        diffContentKey: 'co-A',
        diffPending: true,
      }))
      await settle()

      // Diff arrives: parsedDiff now has c.go (not in stale files → single-
      // file-delta misses, full-run path).
      await rerender(props({
        diffContent: newGo('c.go'),
        changedFiles: [mkFile('c.go')],
        diffTarget: target('co-B', 'ch-B'),
        diffContentKey: 'co-B',
        diffPending: false,
      }))
      await settle()

      // Post-fix: run executed for c.go → tok-keyword on "package" / "var".
      // Pre-fix: tryRestore hit poisoned memo → c.go absent from byFile →
      // DiffFileView falls through to plain render (no .highlighted class).
      const cFile = container.querySelector('[data-file-path="c.go"]')
      expect(cFile).not.toBeNull()
      expect(cFile!.querySelector('.diff-line.highlighted')).not.toBeNull()
    })

    it('highlights apply on same-change snapshot refresh (isRefresh path, diffPending stays false)', async () => {
      // The isRefresh branch in revision-navigator.svelte.ts:111-117 deliberately
      // skips `diffPending=true` to keep stale-while-revalidate content visible.
      // But commit_id (= activeRevisionId in single-rev mode) still advances,
      // opening the same memo-poisoning gap. Covered by contentMatchesTarget
      // (diffContentKey === activeRevisionId), not by diffPending alone.
      //
      // 2-file outgoing → 1-file incoming so single-file-delta doesn't mask it.
      const twoFile = tinyDiff('a.go') + tinyDiff('b.go')
      const newGo = (path: string) =>
        `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n` +
        `@@ -0,0 +1,2 @@\n+package foo\n+var x int\n`

      const { container, rerender } = render(DiffPanel, {
        props: props({
          diffContent: twoFile,
          changedFiles: [mkFile('a.go'), mkFile('b.go')],
          diffTarget: target('co-A1', 'ch-A'),
          diffContentKey: 'co-A1',
        }),
      })
      await settle()

      // Snapshot → new commit_id, SAME change_id → isRefresh=true in the nav,
      // diffPending stays false. activeRevisionId advances, diffContentKey
      // trails until diff.load resolves.
      await rerender(props({
        diffContent: twoFile, // stale
        changedFiles: [mkFile('a.go'), mkFile('b.go')],
        diffTarget: target('co-A2', 'ch-A'),
        diffContentKey: 'co-A1', // still the old key
        diffPending: false,
      }))
      await settle()

      // Fresh diff arrives at new commit_id. contentMatchesTarget goes true.
      await rerender(props({
        diffContent: newGo('c.go'),
        changedFiles: [mkFile('c.go')],
        diffTarget: target('co-A2', 'ch-A'),
        diffContentKey: 'co-A2',
        diffPending: false,
      }))
      await settle()

      const cFile = container.querySelector('[data-file-path="c.go"]')
      expect(cFile).not.toBeNull()
      expect(cFile!.querySelector('.diff-line.highlighted')).not.toBeNull()
    })

    it('collapse state saved for outgoing revision, restored on return (change_id-keyed)', async () => {
      // Two files so we have something to collapse.
      const twoDiff = tinyDiff('a.go') + tinyDiff('b.go')
      const propsA = () => props({
        diffContent: twoDiff,
        changedFiles: [mkFile('a.go'), mkFile('b.go')],
        diffTarget: target('co-A', 'ch-A'),
      })
      const propsB = () => props({
        diffContent: tinyDiff('c.go'),
        changedFiles: [mkFile('c.go')],
        diffTarget: target('co-B', 'ch-B'),
      })

      const { container, rerender } = render(DiffPanel, { props: propsA() })
      await settle()

      // Collapse a.go.
      const fileHeader = container.querySelector('[data-file-path="a.go"] .diff-file-header')!
      await fireEvent.click(fileHeader)
      await settle()

      // DiffFileView's collapsed state: hunks are {#if !isCollapsed}-gated.
      // Presence of .diff-line proves expanded; absence proves collapsed.
      const aFile = container.querySelector('[data-file-path="a.go"]')!
      expect(aFile.querySelector('.diff-line')).toBeNull() // collapsed

      // Navigate to B. Reset effect saves {'a.go'} under 'ch-A'.
      await rerender(propsB())
      await settle()

      // Navigate back to A — SAME change_id, DIFFERENT commit_id (rewrite).
      // collapseStateCache is change_id-keyed so the collapse restores.
      await rerender(props({
        diffContent: twoDiff,
        changedFiles: [mkFile('a.go'), mkFile('b.go')],
        diffTarget: target('co-A2', 'ch-A'), // new commit_id, same change_id
      }))
      await settle()

      const aRestored = container.querySelector('[data-file-path="a.go"]')!
      const bRestored = container.querySelector('[data-file-path="b.go"]')!
      expect(aRestored.querySelector('.diff-line')).toBeNull() // still collapsed
      expect(bRestored.querySelector('.diff-line')).not.toBeNull() // still expanded
    })
  })

  describe('conflictFetch — createLoader replaces hand-rolled effect', () => {
    // conflict-only file: in changedFiles with conflict=true but NOT in
    // parsedDiff (empty diffContent → parsedDiff=[]). This is what triggers
    // the fetch. The old 44-line effect had conflictMapRevId + untrack +
    // post-await guard; the loader's gen counter subsumes all of it.
    const conflictProps = (commitId: string) => props({
      diffTarget: target(commitId, 'ch-X'),
      diffContent: '',  // empty → no files in parsedDiff → conflict.go is conflict-only
      changedFiles: [mkFile('conflict.go', { conflict: true, conflict_sides: 2 })],
    })

    it('fetches once per commitId — dedup across fresh diffTarget objects', async () => {
      // The regression this locks in: loadLog → nav.loadDiffAndFiles writes a
      // FRESH diffTarget object (singleTarget() creates new) with the SAME
      // commitId. The $effect fires (prop identity changed), but
      // conflictLoadedFor gates the refetch. Without the gate, every loadLog
      // = one wasted api.fileShow per conflict file.
      mockFileShow.mockResolvedValue({ content: 'conflict body' })

      const { rerender } = render(DiffPanel, { props: conflictProps('co-A') })
      await settle()
      expect(mockFileShow).toHaveBeenCalledTimes(1)
      expect(mockFileShow).toHaveBeenCalledWith('co-A', 'conflict.go')

      // Fresh diffTarget object, SAME commitId — no refetch.
      await rerender(conflictProps('co-A'))
      await settle()
      expect(mockFileShow).toHaveBeenCalledTimes(1)

      // Different commitId — refetch.
      await rerender(conflictProps('co-B'))
      await settle()
      expect(mockFileShow).toHaveBeenCalledTimes(2)
      expect(mockFileShow).toHaveBeenLastCalledWith('co-B', 'conflict.go')
    })

    it('stale resolve after nav does NOT land — loader gen guard', async () => {
      // The M3/M7 bug: hand-rolled version relied on commitId post-await check
      // AND effect-ordering (declared before reset effect → read pre-reset
      // map → same-path skip). Loader gen counter doesn't care about any of
      // that — the SECOND load() call bumped gen, so the first's resolve sees
      // gen mismatch and discards. Effect ordering is irrelevant.
      let resolveA!: (v: { content: string }) => void
      mockFileShow
        .mockReturnValueOnce(new Promise(r => { resolveA = r }))
        .mockResolvedValueOnce({ content: 'B content' })

      const { container, rerender } = render(DiffPanel, { props: conflictProps('co-A') })
      await settle()

      // Navigate A→B while A's fetch is pending.
      await rerender(conflictProps('co-B'))
      await settle()

      // A resolves late. Loader gen discards it — only B's content lands.
      resolveA({ content: 'A content (stale)' })
      await settle()

      // The conflict-only template branch renders conflictFetch.value.get(path).
      // If A's stale resolve landed, we'd see A's content. We should see B's.
      const bodyText = container.textContent ?? ''
      expect(bodyText).toContain('B content')
      expect(bodyText).not.toContain('A content')
    })

    it('partial failure — allSettled keeps successful entries', async () => {
      mockFileShow
        .mockResolvedValueOnce({ content: 'good file' })
        .mockRejectedValueOnce(new Error('file missing'))

      const { container } = render(DiffPanel, {
        props: props({
          diffTarget: target('co-A', 'ch-X'),
          diffContent: '',
          changedFiles: [
            mkFile('good.go', { conflict: true, conflict_sides: 2 }),
            mkFile('bad.go', { conflict: true, conflict_sides: 2 }),
          ],
        }),
      })
      await settle()

      // good.go renders (fulfilled), bad.go stays at Loading (rejected, no entry in map).
      expect(container.textContent).toContain('good file')
    })
  })

  describe('auto-collapse by char count', () => {
    // Giant one-liner (minified JS, lockfile): 1 line but 20k+ chars.
    // Line-count triggers miss these; char-count catches them.
    it('single-line >20k chars triggers collapse (line-count would miss)', async () => {
      const hugeLine = '+' + 'x'.repeat(21_000)
      const hugeDiff = `diff --git a/bundle.min.js b/bundle.min.js\n--- a/bundle.min.js\n+++ b/bundle.min.js\n@@ -0,0 +1,1 @@\n${hugeLine}\n`
      const { container } = render(DiffPanel, {
        props: props({
          diffContent: hugeDiff,
          changedFiles: [mkFile('bundle.min.js', { additions: 1 })],
        }),
      })
      await settle()
      const file = container.querySelector('[data-file-path="bundle.min.js"]')!
      expect(file.querySelector('.diff-line')).toBeNull() // collapsed (not rendered)
    })
  })

  describe('compute caps decoupled from collapse limits', () => {
    // COLLAPSE thresholds (chars/lines) and COMPUTE caps (highlight/word-diff)
    // are independent: a normal multi-hundred-line code file trips the 20k-char
    // collapse limit but must still get syntax highlighting when expanded.
    // Regression guard for the old conflation where isOversize() also fed
    // highlights.skip — those files rendered plain forever after expand.
    const manyLineFile = (path: string, lines: number, pad = '') =>
      `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -0,0 +1,${lines} @@\n` +
      Array.from({ length: lines }, (_, i) => `+var v${i} = ${i} // ${pad}`).join('\n') + '\n'

    it('>20k-char normal-line file: auto-collapses but expands HIGHLIGHTED', async () => {
      // 700 lines × ~50 chars ≈ 35k chars: over the collapse char limit,
      // well under the 5000-line highlight cap.
      const diff = manyLineFile('big.go', 700, 'padding padding padding padding')
      const { container } = render(DiffPanel, {
        props: props({ diffContent: diff, changedFiles: [mkFile('big.go', { additions: 700 })] }),
      })
      await settle()
      const file = container.querySelector('[data-file-path="big.go"]')!
      expect(file.querySelector('.diff-line')).toBeNull() // auto-collapsed (char limit)

      await fireEvent.click(file.querySelector('.diff-file-header')!)
      await settle()
      expect(file.querySelector('.diff-line')).not.toBeNull() // expanded
      expect(file.querySelector('.diff-line.highlighted')).not.toBeNull() // compute NOT skipped
    })

    it('>5000-line file skips highlighting (memo contract) and renders header-only, no transient body', async () => {
      // 5103 total lines: under the (now extreme) hide gate, so the file list
      // renders — but huge.go is auto-collapsed by the DERIVED decision, so
      // its body is never built (the old post-render auto-collapse effect
      // would have transiently created ~5k .diff-line divs here, which in
      // jsdom blows straight past the test timeout — speed IS the regression
      // signal). Highlight skip asserted via the derivedCache memo (the
      // observable contract for what got highlighted).
      const diff = manyLineFile('small.go', 3) + manyLineFile('huge.go', 5100)
      const { container } = render(DiffPanel, {
        props: props({
          diffContent: diff,
          changedFiles: [mkFile('small.go', { additions: 3 }), mkFile('huge.go', { additions: 5100 })],
        }),
      })
      await settle()
      const huge = container.querySelector('[data-file-path="huge.go"]')
      expect(huge).not.toBeNull()                            // file list rendered (not hidden)
      expect(huge!.querySelector('.diff-line')).toBeNull()   // collapsed from the first render
      const entry = derivedCache.get('co-A')
      expect(entry?.highlights.has('small.go')).toBe(true)   // under the line cap → highlighted
      expect(entry?.highlights.has('huge.go')).toBe(false)   // over the line cap → skipped
    })

    it('>500k-char file skips highlighting via the char cap even when far under the line cap', async () => {
      // 30 lines × 17k chars ≈ 510k chars: minified-bundle shape. The line cap
      // (5000) never fires; only HIGHLIGHT_SKIP_CHAR_LIMIT protects the main
      // thread here. .go extension so a detected language is what gets skipped
      // (a no-language file would "pass" without exercising the cap).
      const fatLine = 'x'.repeat(17_000)
      const fatDiff = `diff --git a/fat.go b/fat.go\n--- a/fat.go\n+++ b/fat.go\n@@ -0,0 +1,30 @@\n` +
        Array.from({ length: 30 }, () => `+${fatLine}`).join('\n') + '\n'
      const { container } = render(DiffPanel, {
        props: props({
          diffContent: tinyDiff('small.go') + fatDiff,
          changedFiles: [mkFile('small.go'), mkFile('fat.go', { additions: 30 })],
        }),
      })
      await settle()
      expect(container.querySelector('[data-file-path="fat.go"]')).not.toBeNull()
      const entry = derivedCache.get('co-A')
      expect(entry?.highlights.has('small.go')).toBe(true)   // sibling proves the run happened
      expect(entry?.highlights.has('fat.go')).toBe(false)    // char cap → skipped
    })
  })

  describe('deferred body mounting', () => {
    // Files past the eager window (~600 cumulative lines) render an
    // estimated-height placeholder instead of line DOM until revealed.
    const tenFiles = () => {
      let diff = ''
      const changed: FileChange[] = []
      for (let i = 0; i < 10; i++) {
        const path = `src/f${i}.go`
        diff += `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -0,0 +1,100 @@\n` +
          Array.from({ length: 100 }, (_, n) => `+var v${n} = ${n}`).join('\n') + '\n'
        changed.push(mkFile(path, { additions: 100 }))
      }
      return { diff, changed }
    }

    it('files beyond the eager window render a placeholder; near files render bodies', async () => {
      const { diff, changed } = tenFiles()
      const { container } = render(DiffPanel, {
        props: props({ diffContent: diff, changedFiles: changed }),
      })
      await settle()
      const first = container.querySelector('[data-file-path="src/f0.go"]')!
      const far = container.querySelector('[data-file-path="src/f9.go"]')!
      expect(first.querySelector('.diff-line')).not.toBeNull()          // eager: real body
      expect(far.querySelector('.diff-line')).toBeNull()                // deferred: no line DOM
      expect(far.querySelector('.diff-body-placeholder')).not.toBeNull()
      // Placeholder claims the estimated height (100 lines × 18 + 1 hunk × 24).
      expect((far.querySelector('.diff-body-placeholder') as HTMLElement).style.height).toBe('1824px')
    })

    it('scrollToFile force-mounts a deferred file (the programmatic-jump contract)', async () => {
      const { diff, changed } = tenFiles()
      const { container, component } = render(DiffPanel, {
        props: props({ diffContent: diff, changedFiles: changed }),
      })
      await settle()
      expect(container.querySelector('[data-file-path="src/f9.go"] .diff-line')).toBeNull()
      component.scrollToFile('src/f9.go', { smooth: false })
      await settle()
      const far = container.querySelector('[data-file-path="src/f9.go"]')!
      expect(far.querySelector('.diff-body-placeholder')).toBeNull()
      expect(far.querySelector('.diff-line')).not.toBeNull()
    })

    it('search Enter on a match in a deferred far file reveals AND mounts it (scrollToMatch path)', async () => {
      // The needle exists only in the last file, which sits past the eager
      // window and renders as a placeholder. searchMatches walks the parsed
      // model (mount-independent); jumping to the match must go through
      // revealFile so the body actually exists to scroll to.
      let diff = ''
      const changed: FileChange[] = []
      for (let i = 0; i < 10; i++) {
        const path = `src/f${i}.go`
        diff += `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -0,0 +1,100 @@\n` +
          Array.from({ length: 100 }, (_, n) =>
            i === 9 && n === 50 ? '+var needle_zz = 50' : `+var v${n} = ${n}`).join('\n') + '\n'
        changed.push(mkFile(path, { additions: 100 }))
      }
      const { container, component } = render(DiffPanel, {
        props: props({ diffContent: diff, changedFiles: changed }),
      })
      await settle()
      const far = () => container.querySelector('[data-file-path="src/f9.go"]')!
      expect(far().querySelector('.diff-body-placeholder')).not.toBeNull() // deferred

      component.openSearch()
      await settle()
      const input = container.querySelector('.search-input') as HTMLInputElement
      await fireEvent.input(input, { target: { value: 'needle_zz' } })
      await settle()
      await fireEvent.keyDown(input, { key: 'Enter' })
      await settle()

      expect(far().querySelector('.diff-body-placeholder')).toBeNull()
      expect(far().querySelector('.diff-line')).not.toBeNull()
      expect(far().querySelector('[data-search-match-current="true"]')).not.toBeNull()
    })
  })

  describe('hide gate — file-count limit', () => {
    it('>300 files hides the diff with an opt-in; "Show anyway" renders it', async () => {
      // 301 one-line files: total lines (~301) is nowhere near the 50k line
      // gate, so this isolates the HIDE_DIFF_FILE_LIMIT branch (per-file
      // header/tab cost is what that guard bounds).
      let diff = ''
      const changed: FileChange[] = []
      for (let i = 0; i < 301; i++) {
        const p = `f${i}.go`
        diff += tinyDiff(p)
        changed.push(mkFile(p))
      }
      const { container } = render(DiffPanel, {
        props: props({ diffContent: diff, changedFiles: changed }),
      })
      await settle()
      expect(container.querySelector('[data-file-path="f0.go"]')).toBeNull() // nothing rendered
      const show = [...container.querySelectorAll('button')]
        .find(b => b.textContent === 'Show anyway') as HTMLButtonElement
      expect(show).toBeDefined()

      await fireEvent.click(show)
      await settle()
      expect(container.querySelector('[data-file-path="f0.go"]')).not.toBeNull()
      expect(container.querySelector('[data-file-path="f300.go"]')).not.toBeNull()
    })
  })

  describe('auto-collapse suppression on cache restore', () => {
    // Cache-restore path (reset effect :569-573) sets lastAutoCollapseDiff
    // Contract: explicit collapse/expand choices are change_id-keyed and
    // stick on return; files the user never touched follow the live
    // auto-collapse predicate (a big file is still big).
    it('restoring saved collapse state suppresses auto-collapse on big files', async () => {
      // >500 lines triggers AUTO_COLLAPSE_LINE_LIMIT.
      const bigHunk = Array.from({ length: 510 }, (_, i) => `+line${i}`).join('\n')
      const bigDiff = `diff --git a/big.go b/big.go\n--- a/big.go\n+++ b/big.go\n@@ -0,0 +1,510 @@\n${bigHunk}\n`
      const twoDiff = bigDiff + tinyDiff('b.go')
      const propsA = (commitId: string) => props({
        diffContent: twoDiff,
        changedFiles: [mkFile('big.go', { additions: 510 }), mkFile('b.go')],
        diffTarget: target(commitId, 'ch-A'),
      })

      const { container, rerender } = render(DiffPanel, { props: propsA('co-A') })
      await settle()

      // big.go auto-collapsed on load. Expand it; collapse b.go so both
      // intent sets are non-empty at nav time (→ cache saves).
      const big = () => container.querySelector('[data-file-path="big.go"]')!
      const b = () => container.querySelector('[data-file-path="b.go"]')!
      expect(big().querySelector('.diff-line')).toBeNull() // auto-collapsed
      await fireEvent.click(big().querySelector('.diff-file-header')!)
      await fireEvent.click(b().querySelector('.diff-file-header')!)
      await settle()

      // Navigate away → saves {'b.go'} under 'ch-A'.
      await rerender(props({
        diffTarget: target('co-B', 'ch-B'),
        diffContent: tinyDiff('c.go'),
        changedFiles: [mkFile('c.go')],
      }))
      await settle()

      // Return (same change_id, new commit_id — a rewrite). Cache hit →
      // restores {'b.go'} + sets lastAutoCollapseDiff → auto-collapse bails.
      await rerender(propsA('co-A2'))
      await settle()

      expect(big().querySelector('.diff-line')).not.toBeNull() // NOT re-auto-collapsed
      expect(b().querySelector('.diff-line')).toBeNull() // manual collapse restored
    })
  })

  describe('collapse intent — pinned reveals vs persisted choices', () => {
    const bigDiff = (path: string) =>
      `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -0,0 +1,510 @@\n` +
      Array.from({ length: 510 }, (_, i) => `+line${i}`).join('\n') + '\n'
    const bigPlusSmall = (commitId: string, changeId = 'ch-A') => props({
      diffContent: bigDiff('big.go') + tinyDiff('b.go'),
      changedFiles: [mkFile('big.go', { additions: 510 }), mkFile('b.go')],
      diffTarget: target(commitId, changeId),
    })
    const elsewhere = () => props({
      diffTarget: target('co-Z', 'ch-Z'),
      diffContent: tinyDiff('z.go'),
      changedFiles: [mkFile('z.go')],
    })

    it('programmatic reveal is session-only — revealed big file re-collapses on revisit', async () => {
      // scrollToFile/scrollToMatch/scrollToHunk all route through revealFile,
      // which pins via pinnedExpanded — NOT userExpanded — so a search jump
      // into a 5k-line file doesn't permanently disable its auto-collapse.
      const { container, component, rerender } = render(DiffPanel, { props: bigPlusSmall('co-A') })
      await settle()
      const big = () => container.querySelector('[data-file-path="big.go"]')!
      expect(big().querySelector('.diff-line')).toBeNull() // auto-collapsed

      component.scrollToFile('big.go', { smooth: false })
      await settle()
      expect(big().querySelector('.diff-line')).not.toBeNull() // revealed for this visit

      // Navigate away (no explicit choices → nothing persisted) and back.
      await rerender(elsewhere())
      await settle()
      await rerender(bigPlusSmall('co-A2'))
      await settle()
      expect(big().querySelector('.diff-line')).toBeNull() // auto-collapse applies again
    })

    it('Expand all is explicit intent — persists across revisits even with nothing collapsed', async () => {
      // Regression for the old "save only when something is collapsed" rule:
      // here userCollapsed stays empty and only CollapseMemo.expanded carries
      // the choice across the round trip.
      const { container, rerender } = render(DiffPanel, { props: bigPlusSmall('co-A') })
      await settle()
      const big = () => container.querySelector('[data-file-path="big.go"]')!
      expect(big().querySelector('.diff-line')).toBeNull() // auto-collapsed

      await fireEvent.click(container.querySelector('[aria-label="Expand all files"]')!)
      await settle()
      expect(big().querySelector('.diff-line')).not.toBeNull()

      await rerender(elsewhere())
      await settle()
      await rerender(bigPlusSmall('co-A2')) // same change_id, new commit_id (rewrite)
      await settle()
      expect(big().querySelector('.diff-line')).not.toBeNull() // expanded intent restored
    })

    it('same-change snapshot pins currently-expanded files — growth past a threshold does not snap them shut', async () => {
      // a.go starts small (expanded, NO explicit intent). A snapshot rewrites @
      // (new commit_id, same change_id) and the edit pushes a.go over
      // AUTO_COLLAPSE_LINE_LIMIT. Production order: commit_id flips first,
      // diffContent lags — the sameChange branch pins what was on screen.
      const { container, rerender } = render(DiffPanel, {
        props: props({ diffTarget: target('co-1', 'ch-X'), diffContentKey: 'co-1' }),
      })
      await settle()
      const a = () => container.querySelector('[data-file-path="a.go"]')!
      expect(a().querySelector('.diff-line')).not.toBeNull()

      // Snapshot: commit_id advances, content still the outgoing small a.go.
      await rerender(props({ diffTarget: target('co-2', 'ch-X'), diffContentKey: 'co-1' }))
      await settle()
      // Fresh diff lands: a.go is now 510 lines (over the collapse limit).
      await rerender(props({
        diffContent: bigDiff('a.go'),
        changedFiles: [mkFile('a.go', { additions: 510 })],
        diffTarget: target('co-2', 'ch-X'),
        diffContentKey: 'co-2',
      }))
      await settle()
      expect(a().querySelector('.diff-line')).not.toBeNull() // still open — pinned, not snapped shut
    })
  })

  describe('reviewed checkbox — collapse on check, no expand on uncheck', () => {
    it('checking collapses the file; unchecking leaves it collapsed', async () => {
      const { container } = render(DiffPanel, { props: props() })
      await settle()
      const file = () => container.querySelector('[data-file-path="a.go"]')!
      expect(file().querySelector('.diff-line')).not.toBeNull()

      const check = () => file().querySelector('.reviewed-check') as HTMLButtonElement
      expect(check()).toBeTruthy()
      await fireEvent.click(check())
      await settle()
      // Confirmed check (setReviewed resolved true) → file collapses.
      expect(file().querySelector('.diff-line')).toBeNull()

      // Uncheck removes the marker but does NOT surprise-expand.
      await fireEvent.click(check())
      await settle()
      expect(file().querySelector('.diff-line')).toBeNull()
    })
  })

  describe('stepFile — keyboard [/] navigation', () => {
    // activeFilePath is IntersectionObserver-driven; mock observer in
    // vitest-setup is a no-op → stays null → tests exercise the null-start
    // branch (forward→first, back→last). Clamp-at-end needs private state
    // write, skipped.
    const files3 = [mkFile('a.go'), mkFile('b.go'), mkFile('c.go')]
    const diff3 = files3.map(f => tinyDiff(f.path)).join('')

    // scrollToFile wraps the DOM query in requestAnimationFrame — must flush
    // rAF explicitly since settle() only drains macrotasks.
    const raf = () => new Promise(r => requestAnimationFrame(() => r(undefined)))

    let scrolledPaths: string[]
    beforeEach(() => {
      scrolledPaths = []
      Element.prototype.scrollIntoView = vi.fn(function (this: Element) {
        const p = this.closest('[data-file-path]')?.getAttribute('data-file-path')
        if (p) scrolledPaths.push(p)
      })
    })

    it('forward from null start → first file', async () => {
      const { component } = render(DiffPanel, { props: props({ changedFiles: files3, diffContent: diff3 }) })
      await settle()
      component.stepFile(1)
      await raf()
      expect(scrolledPaths).toEqual(['a.go'])
    })

    it('backward from null start → last file', async () => {
      const { component } = render(DiffPanel, { props: props({ changedFiles: files3, diffContent: diff3 }) })
      await settle()
      component.stepFile(-1)
      await raf()
      expect(scrolledPaths).toEqual(['c.go'])
    })

    it('empty changedFiles → no-op', async () => {
      const { component } = render(DiffPanel, { props: props({ changedFiles: [], diffContent: '' }) })
      await settle()
      component.stepFile(1)
      await raf()
      expect(scrolledPaths).toEqual([])
    })
  })

  describe('markdown preview persistence — file-actions.svelte.ts previewGen barrier', () => {
    const mdProps = (commitId: string, changeId: string) => props({
      diffTarget: target(commitId, changeId),
      diffContent: tinyDiff('README.md'),
      changedFiles: [mkFile('README.md')],
    })

    it('same changeId (snapshot/amend) → preview stays open, content refreshed at new commitId', async () => {
      mockFileShow.mockResolvedValue({ content: '# doc' })
      const { container, rerender } = render(DiffPanel, { props: mdProps('co-1', 'ch-X') })
      await settle()

      await fireEvent.click(previewBtn(container)!)
      await settle()
      expect(mockFileShow).toHaveBeenCalledWith('co-1', 'README.md')
      expect(previewBtn(container)?.textContent).toBe('Source')

      // SSE snapshot: new commit_id, SAME change_id.
      await rerender(mdProps('co-2', 'ch-X'))
      await settle()

      expect(previewBtn(container)?.textContent).toBe('Source')
      expect(mockFileShow).toHaveBeenCalledWith('co-2', 'README.md')
    })

    it('different changeId (j/k nav) → preview cleared', async () => {
      mockFileShow.mockResolvedValue({ content: '# doc' })
      const { container, rerender } = render(DiffPanel, { props: mdProps('co-1', 'ch-X') })
      await settle()

      await fireEvent.click(previewBtn(container)!)
      await settle()
      expect(previewBtn(container)?.textContent).toBe('Source')

      mockFileShow.mockClear()
      await rerender(mdProps('co-9', 'ch-Y'))
      await settle()

      expect(previewBtn(container)?.textContent).toBe('Preview')
      expect(mockFileShow).not.toHaveBeenCalled()
    })

    it('refresh in flight, j/k nav → stale refresh bounces (previewGen guard)', async () => {
      mockFileShow.mockResolvedValueOnce({ content: '# v1' })
      const { container, rerender } = render(DiffPanel, { props: mdProps('co-1', 'ch-X') })
      await settle()
      await fireEvent.click(previewBtn(container)!)
      await settle()

      let resolveRefresh!: (v: { content: string }) => void
      mockFileShow.mockReturnValueOnce(new Promise(r => { resolveRefresh = r }))
      await rerender(mdProps('co-2', 'ch-X'))
      await settle()
      expect(previewBtn(container)?.textContent).toBe('Source')

      // User navigates away mid-refresh.
      await rerender(mdProps('co-9', 'ch-Y'))
      await settle()
      expect(previewBtn(container)?.textContent).toBe('Preview')

      resolveRefresh({ content: '# v2' })
      await settle()
      // Gen guard: refresh result discarded, preview stays closed.
      expect(previewBtn(container)?.textContent).toBe('Preview')
    })

    it('user closes preview mid-refresh → does NOT resurrect (has-path guard)', async () => {
      mockFileShow.mockResolvedValueOnce({ content: '# v1' })
      const { container, rerender } = render(DiffPanel, { props: mdProps('co-1', 'ch-X') })
      await settle()
      await fireEvent.click(previewBtn(container)!)
      await settle()

      let resolveRefresh!: (v: { content: string }) => void
      mockFileShow.mockReturnValueOnce(new Promise(r => { resolveRefresh = r }))
      await rerender(mdProps('co-2', 'ch-X'))
      await settle()
      expect(previewBtn(container)?.textContent).toBe('Source')

      // User clicks Source → closePreview (no gen bump) while refresh in flight.
      await fireEvent.click(previewBtn(container)!)
      await settle()
      expect(previewBtn(container)?.textContent).toBe('Preview')

      resolveRefresh({ content: '# v2' })
      await settle()
      // has(path) guard: refresh result discarded, preview stays closed.
      expect(previewBtn(container)?.textContent).toBe('Preview')
    })

    it('refresh fileShow rejects (transient error) → preview stays open with stale content', async () => {
      mockFileShow.mockResolvedValueOnce({ content: '# doc' })
      const { container, rerender } = render(DiffPanel, { props: mdProps('co-1', 'ch-X') })
      await settle()
      await fireEvent.click(previewBtn(container)!)
      await settle()
      expect(previewBtn(container)?.textContent).toBe('Source')

      mockFileShow.mockRejectedValueOnce(new Error('WC lock'))
      await rerender(mdProps('co-2', 'ch-X'))
      await settle()

      // Briefly-stale beats vanished — keep showing old content.
      expect(previewBtn(container)?.textContent).toBe('Source')
    })
  })

  describe('quickResolve — one-click whole-file conflict resolution', () => {
    const mockFileWrite = api.fileWrite as Mock
    const mockMergeResolve = api.mergeResolve as Mock
    // jj Snapshot-style conflict: reconstructSides → ours="OURS", theirs="THEIRS".
    const conflictContent = [
      '<<<<<<<', '+++++++ s1', 'OURS', '------- base', 'BASE', '+++++++ s2', 'THEIRS', '>>>>>>>',
    ].join('\n')
    const quickBtn = (c: HTMLElement, label: string) =>
      [...c.querySelectorAll('.resolve-quick')].find(b => b.textContent?.trim() === label) as HTMLButtonElement | undefined
    const conflictProps = (o = {}) => props({ changedFiles: [mkFile('a.go', { conflict: true, conflict_sides: 2 })], ...o })

    it('renders Ours/Theirs only for single mutable targets (not multi/immutable)', async () => {
      const { container, rerender } = render(DiffPanel, { props: conflictProps() })
      await settle()
      expect(quickBtn(container, '◀ Ours')).toBeTruthy()
      expect(quickBtn(container, 'Theirs ▶')).toBeTruthy()

      // immutable → canMutateFiles false → buttons gone (only ⧉ Merge logic gated the same).
      await rerender(conflictProps({ diffTarget: target('co-A', 'ch-A', { immutable: true }) }))
      await settle()
      expect(quickBtn(container, '◀ Ours')).toBeFalsy()

      // multi-revision target → kind !== 'single' → canMutateFiles false → buttons gone.
      const multi: DiffTarget = { kind: 'multi', revset: 'co-A|co-B', commitIds: ['co-A', 'co-B'] }
      await rerender(conflictProps({ diffTarget: multi }))
      await settle()
      expect(quickBtn(container, '◀ Ours')).toBeFalsy()
    })

    it('"◀ Ours" on a non-@ target resolves via mergeResolve — @ does NOT move', async () => {
      // Strategy unification (conflict-resolve.ts): resolution no longer
      // auto-runs `jj edit` on non-@ targets. The write goes through
      // `jj resolve -r <commit_id>` (api.mergeResolve), leaving @ alone.
      mockFileShow.mockResolvedValue({ content: conflictContent })
      mockMergeResolve.mockResolvedValue({ output: '' })
      const onfilesaved = vi.fn()
      const { container } = render(DiffPanel, { props: conflictProps({ onfilesaved }) })
      await settle()

      await fireEvent.click(quickBtn(container, '◀ Ours')!)
      await settle()

      expect(mockEdit).not.toHaveBeenCalled()                 // @ untouched
      expect(mockFileWrite).not.toHaveBeenCalled()
      expect(mockMergeResolve).toHaveBeenCalledWith('co-A', 'a.go', 'OURS')  // commit_id
      expect(onfilesaved).toHaveBeenCalled()
    })

    it('non-@ target in SSH mode (mergeResolve 501) → explicit jj-edit fallback + banner', async () => {
      // The only resolution path that still moves @ — and it says so.
      mockFileShow.mockResolvedValue({ content: conflictContent })
      mockMergeResolve.mockRejectedValue(new Error('merge-resolve requires local mode'))
      mockEdit.mockResolvedValue({ output: '' })
      mockFileWrite.mockResolvedValue({ ok: true })
      const onfilesaved = vi.fn()
      const { container } = render(DiffPanel, { props: conflictProps({ onfilesaved }) })
      await settle()

      await fireEvent.click(quickBtn(container, '◀ Ours')!)
      await settle()

      expect(mockEdit).toHaveBeenCalledWith('co-A')            // fallback moves @ ...
      expect(mockFileWrite).toHaveBeenCalledWith('a.go', 'OURS')
      expect(onfilesaved).toHaveBeenCalled()
      // ... and surfaces it — never silent.
      expect(container.querySelector('.edit-error-banner')?.textContent).toContain('working copy moved')
    })

    it('"Theirs ▶" writes sides.theirs; no jj edit when target is @', async () => {
      mockFileShow.mockResolvedValue({ content: conflictContent })
      mockFileWrite.mockResolvedValue({ ok: true })
      const { container } = render(DiffPanel, {
        props: conflictProps({ diffTarget: target('co-A', 'ch-A', { isWorkingCopy: true }) }),
      })
      await settle()

      await fireEvent.click(quickBtn(container, 'Theirs ▶')!)
      await settle()

      expect(mockEdit).not.toHaveBeenCalled()                // already @
      expect(mockFileWrite).toHaveBeenCalledWith('a.go', 'THEIRS')
    })

    it('hides resolve buttons while the file is open in the editor (bug_001 — no stale-buffer Save)', async () => {
      // Data-loss guard: resolving writes fresh content + reloads, but the reset
      // $effect is change_id-keyed and a resolve only bumps commit_id — so an
      // open editor's stale conflict-marker buffer would survive and a later
      // Save would re-introduce the resolved-away conflict. Gating on !editing
      // makes that click impossible.
      mockEdit.mockResolvedValue(undefined)
      mockFileShow.mockResolvedValue({ content: conflictContent })
      const { container } = render(DiffPanel, { props: conflictProps() })
      await settle()
      expect(quickBtn(container, '◀ Ours')).toBeTruthy()   // visible when not editing

      await fireEvent.click(editBtn(container)!)            // open in inline editor
      await settle()

      expect(quickBtn(container, '◀ Ours')).toBeFalsy()
      expect(quickBtn(container, 'Theirs ▶')).toBeFalsy()
    })

    it('unparseable conflict (N-way / git-style) → falls back to editor, no fileWrite', async () => {
      mockEdit.mockResolvedValue(undefined)
      // Git-style markers — reconstructSides returns null.
      mockFileShow.mockResolvedValue({ content: '<<<<<<< ours\nA\n=======\nB\n>>>>>>> theirs\n' })
      mockFileWrite.mockResolvedValue({ ok: true })
      const { container } = render(DiffPanel, { props: conflictProps() })
      await settle()

      await fireEvent.click(quickBtn(container, '◀ Ours')!)
      await settle()

      expect(mockFileWrite).not.toHaveBeenCalled()           // no blind write of bad content
    })

    it('conflict-ONLY file: N-way fallback opens the inline editor, not a dead-end (bug_003)', async () => {
      // conflicted.go is conflicted but absent from the diff (a.go is the diff) →
      // renders in the thinner conflictOnlyFiles branch. Pre-fix, that branch
      // omitted editing/editContent, so openFileEditor (the N-way fallback) set
      // editingFiles but NO editor rendered — split flips, nothing appears.
      mockEdit.mockResolvedValue(undefined)
      // Git-style markers → reconstructSides null → fallback. Serves both the
      // conflictFetch display-load and quickResolve's re-fetch.
      mockFileShow.mockResolvedValue({ content: '<<<<<<< ours\nA\n=======\nB\n>>>>>>> theirs\n' })
      mockFileWrite.mockResolvedValue({ ok: true })
      const onfilesaved = vi.fn()
      const { container } = render(DiffPanel, {
        props: props({
          diffTarget: target('co-A', 'ch-A', { isWorkingCopy: true }),
          changedFiles: [mkFile('a.go'), mkFile('conflicted.go', { conflict: true, conflict_sides: 2 })],
          onfilesaved,
        }),
      })
      await settle()

      const fileEl = container.querySelector('[data-file-path="conflicted.go"]') as HTMLElement
      expect(fileEl).toBeTruthy()                              // conflict-only file rendered
      const ours = [...fileEl.querySelectorAll('.resolve-quick')].find(b => b.textContent?.trim() === '◀ Ours') as HTMLButtonElement
      expect(ours).toBeTruthy()

      await fireEvent.click(ours)
      await settle()

      // Fallback: no blind write, and the actual EDITING SURFACE renders — not
      // just the Save button. Asserting `.split-editor` (the editor column) is
      // the real check: conflicted files force unified view (effectiveSplit =
      // splitView && !isConflict), so before the effectiveSplit-includes-editing
      // fix the editor column never mounted → editorRef undefined → Save
      // permanently disabled. (The Save button alone gates on `editing`, so it
      // appeared even when the surface was a dead-end — the false-confidence trap.)
      expect(mockFileWrite).not.toHaveBeenCalled()
      expect(fileEl.querySelector('.split-editor')).toBeTruthy()
    })

    it('modify/delete conflict: taking the deleted (empty) side refuses — no zero-byte fileWrite', async () => {
      // jj's default "diff" marker style materializes the deleted side as a
      // %%%%%%% section whose lines are all '-'-prefixed → reconstructSides
      // yields '' for that side. Writing '' would "resolve" to an empty file
      // (M with the empty blob, not D) — wrong tree content. quickResolve must
      // refuse with an explanation instead.
      const deleteConflictContent = [
        '<<<<<<< Conflict 1 of 1',
        '+++++++ Contents of side #1',
        'OURS',
        '%%%%%%% Changes from base to side #2',
        '-BASE',
        '>>>>>>> Conflict 1 of 1 ends',
      ].join('\n')
      mockFileShow.mockResolvedValue({ content: deleteConflictContent })
      mockFileWrite.mockResolvedValue({ ok: true })
      const { container } = render(DiffPanel, {
        props: conflictProps({ diffTarget: target('co-A', 'ch-A', { isWorkingCopy: true }) }),
      })
      await settle()

      await fireEvent.click(quickBtn(container, 'Theirs ▶')!)
      await settle()

      expect(mockFileWrite).not.toHaveBeenCalled()
      expect(container.querySelector('.edit-error-banner')?.textContent).toContain('empty')

      // The surviving (non-deleted) side still resolves one-click on the same conflict.
      await fireEvent.click(quickBtn(container, '◀ Ours')!)
      await settle()
      expect(mockFileWrite).toHaveBeenCalledWith('a.go', 'OURS')
    })

    it('toggleSplitView is exported and confirms — the Cmd+K palette path, not just the toolbar', async () => {
      // App's "Toggle split/unified diff" palette command calls this export;
      // writing config.splitView directly would reach the $bindable, unmount the
      // FileEditor, and silently discard its buffer with no confirm.
      mockFileShow.mockResolvedValue({ content: 'line1\nline2\n' })
      const { container, component } = render(DiffPanel, {
        props: props({ diffTarget: target('co-A', 'ch-A', { isWorkingCopy: true }) }),
      })
      await settle()
      await fireEvent.click(editBtn(container)!)            // open editor (splitView → true)
      await settle()
      expect(container.querySelector('.split-editor')).toBeTruthy()

      const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false)
      component.toggleSplitView()
      await settle()
      expect(confirmSpy).toHaveBeenCalled()
      expect(container.querySelector('.split-editor')).toBeTruthy()  // declined → editor survives
      confirmSpy.mockRestore()
    })

    it('split/unified toggle confirms before discarding in-progress edits (round-3 data-loss)', async () => {
      // The editor mounts only in the split branch; toggling to unified unmounts
      // it and destroys CodeMirror's live buffer (editFileContents holds only the
      // pre-edit original). Guard mirrors startMerge's confirm-before-discard.
      mockFileShow.mockResolvedValue({ content: 'line1\nline2\n' })
      const { container } = render(DiffPanel, {
        props: props({ diffTarget: target('co-A', 'ch-A', { isWorkingCopy: true }) }),
      })
      await settle()
      await fireEvent.click(editBtn(container)!)            // open editor (splitView → true)
      await settle()
      expect(container.querySelector('.split-editor')).toBeTruthy()

      // Decline the confirm → no toggle, editor (and its buffer) survive.
      const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false)
      const toggle = container.querySelector('[aria-label="Switch to unified view"]') as HTMLButtonElement
      await fireEvent.click(toggle)
      await settle()
      expect(confirmSpy).toHaveBeenCalled()
      expect(container.querySelector('.split-editor')).toBeTruthy()  // NOT unmounted

      // Accept → toggle proceeds, editor unmounts (edits intentionally discarded).
      confirmSpy.mockReturnValue(true)
      await fireEvent.click(toggle)
      await settle()
      expect(container.querySelector('.split-editor')).toBeFalsy()
      confirmSpy.mockRestore()
    })
  })
})
