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
      restore: vi.fn(),
      diff: vi.fn(),
      annotations: vi.fn().mockResolvedValue([]),
      diffRange: vi.fn().mockResolvedValue({ diff: '' }),
      saveAnnotation: vi.fn(),
      deleteAnnotation: vi.fn(),
    },
  }
})

import DiffPanel from './DiffPanel.svelte'
import { api, type DiffTarget, type FileChange } from './api'
import { clearDiffCaches } from './diff-cache'

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
  return {
    diffContent: tinyDiff('a.go'),
    changedFiles: [mkFile('a.go')],
    diffTarget: target('co-A', 'ch-A'),
    diffLoading: false,
    splitView: false,
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
// These are the only externally observable signals for the edit state (DiffPanel
// doesn't export editingFiles).
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
  describe('startEdit race guard — DiffPanel.svelte:264,266', () => {
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

      // A's api.edit resolves; guard at :264 compares live diffTarget.changeId
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

      // Stale fileShow resolves — guard at :266 bails, editFileContents NOT set.
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

  describe('discardFile busy-guard — DiffPanel.svelte:217', () => {
    // The race documented at :213-216: startEdit releases the mutation lock
    // after api.edit resolves, then awaits fileShow holding only editBusy.
    // A Discard click during that window must no-op — otherwise restore
    // succeeds, then the resumed fileShow writes pre-discard content.
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

      // Click Discard while editBusy is held → guard at :217 bails.
      const discard = headerBtn(container, 'Discard')
      expect(discard).toBeDefined()
      await fireEvent.click(discard!)
      await settle()

      expect(mockRestore).not.toHaveBeenCalled()

      resolveShow({ content: 'body' })
      await settle()
    })

    // Regression: onjjmutation=withMutation holds mutating=true through
    // res.json(), so the header-driven notifyOpId microtask hits App's
    // !mutating guard and the later SSE push dedups. Explicit onfilesaved
    // is the only refresh path. Same mechanism saveFile/saveMerge use.
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

  describe('reset effect — DiffPanel.svelte:539-575', () => {
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
      // would have changed this behavior (deep-review finding).
      await rerender(props({
        diffTarget: target('co-B', 'ch-B'),
        diffContent: tinyDiff('a.go'),
      }))
      await settle()

      const inputAfter = container.querySelector('.search-input') as HTMLInputElement
      expect(inputAfter).toBeInTheDocument() // bar still open
      expect(inputAfter.value).toBe('') // query cleared
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

      // Template at DiffPanel.svelte:1187 renders conflictFetch.value.get(path).
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

  describe('auto-collapse suppression on cache restore', () => {
    // Cache-restore path (reset effect :569-573) sets lastAutoCollapseDiff
    // → auto-collapse effect bails (diffContent === lastAutoCollapseDiff).
    // Contract: if collapsedFiles.size > 0 at nav-time, your manual state
    // sticks on return. (size == 0 → nothing saved → auto-collapse reasserts,
    // which is correct: a big file is still big.)
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

      // big.go auto-collapsed on load. Expand it; collapse b.go so
      // collapsedFiles.size > 0 at nav time (→ cache saves).
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

  describe('markdown preview persistence — DiffPanel.svelte:863,874', () => {
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
})
