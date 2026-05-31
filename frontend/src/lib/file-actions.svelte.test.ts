import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createFileActions, type FileActionsDeps, type JJMutationLock } from './file-actions.svelte'
import { api, type DiffTarget } from './api'

// Mock api before importing — the factory captures api.* at module eval time.
vi.mock('./api', async (orig) => {
  const actual = await orig<typeof import('./api')>()
  return {
    ...actual,
    api: {
      ...actual.api,
      edit: vi.fn(),
      fileShow: vi.fn(),
      fileWrite: vi.fn(),
      mergeResolve: vi.fn(),
      restore: vi.fn(),
    },
  }
})

const mockApi = vi.mocked(api)

// Manual resolver capture — the merge-controller test pattern for
// deterministic race reproduction.
function deferred<T>() {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const p = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { p, resolve, reject }
}

const flush = () => new Promise(r => setTimeout(r, 0))

function target(commitId: string, changeId: string, over: Partial<Extract<DiffTarget, { kind: 'single' }>> = {}): DiffTarget {
  return { kind: 'single', commitId, changeId, isWorkingCopy: false, immutable: false, ...over }
}

// jj "diff"-style 2-sided conflict — reconstructSides → ours='OURS', theirs='THEIRS'.
const conflictContent = [
  '<<<<<<<', '+++++++ s1', 'OURS', '------- base', 'BASE', '+++++++ s2', 'THEIRS', '>>>>>>>',
].join('\n')

// Mutable test-controlled deps. Each test mutates these and the factory's
// getter-closures read the live values — same liveness as DiffPanel's props.
let liveTarget: DiffTarget | undefined
let lock: JJMutationLock | undefined
let onFileSaved: (() => Promise<void> | void) | undefined
const revealFile = vi.fn()
const ensureSplitView = vi.fn()
const setScrollTop = vi.fn()

const deps: FileActionsDeps = {
  getDiffTarget: () => liveTarget,
  getMutationLock: () => lock,
  getOnFileSaved: () => onFileSaved,
  revealFile,
  ensureSplitView,
  setScrollTop,
}

beforeEach(() => {
  liveTarget = target('co-A', 'ch-A')
  lock = undefined
  onFileSaved = undefined
  revealFile.mockClear()
  ensureSplitView.mockClear()
  setScrollTop.mockClear()
  mockApi.edit.mockReset().mockResolvedValue({ output: '' })
  mockApi.fileShow.mockReset().mockResolvedValue({ content: 'body' })
  mockApi.fileWrite.mockReset().mockResolvedValue({ output: '' })
  mockApi.mergeResolve.mockReset().mockResolvedValue({ output: '' })
  mockApi.restore.mockReset().mockResolvedValue({ output: '' })
})

describe('startEdit — post-await identity guards', () => {
  it('navigation during api.edit await → bails BEFORE fileShow, editor never opens', async () => {
    const d = deferred<{ output: string }>()
    mockApi.edit.mockReturnValueOnce(d.p)
    const fa = createFileActions(deps)

    const p = fa.startEdit('a.go')
    expect(mockApi.edit).toHaveBeenCalledWith('ch-A')

    liveTarget = target('co-B', 'ch-B') // j/k nav while edit pending
    d.resolve({ output: '' })
    await p

    expect(mockApi.fileShow).not.toHaveBeenCalled()
    expect(fa.editingFiles.has('a.go')).toBe(false)
  })

  it('navigation during fileShow await → stale content NOT written', async () => {
    const d = deferred<{ content: string }>()
    mockApi.fileShow.mockReturnValueOnce(d.p)
    const fa = createFileActions(deps)

    const p = fa.startEdit('a.go')
    await flush() // edit resolved, suspended in fileShow
    expect(mockApi.fileShow).toHaveBeenCalledWith('co-A', 'a.go')

    liveTarget = target('co-B', 'ch-B')
    d.resolve({ content: 'stale' })
    await p

    expect(fa.editingFiles.has('a.go')).toBe(false)
    expect(fa.editFileContents.has('a.go')).toBe(false)
  })

  it('happy path: opens editor (split view, reveal, contents)', async () => {
    const fa = createFileActions(deps)
    await fa.startEdit('a.go')

    expect(fa.editingFiles.has('a.go')).toBe(true)
    expect(fa.editFileContents.get('a.go')).toBe('body')
    expect(ensureSplitView).toHaveBeenCalled()
    expect(revealFile).toHaveBeenCalledWith('a.go')
  })

  it('@ target skips api.edit (already the working copy)', async () => {
    liveTarget = target('co-A', 'ch-A', { isWorkingCopy: true })
    const fa = createFileActions(deps)
    await fa.startEdit('a.go')
    expect(mockApi.edit).not.toHaveBeenCalled()
    expect(fa.editingFiles.has('a.go')).toBe(true)
  })

  it('blocked mutation lock (resolves undefined) → bail, no fileShow', async () => {
    lock = async () => undefined // withMutation: blocked
    const fa = createFileActions(deps)
    await fa.startEdit('a.go')
    expect(mockApi.fileShow).not.toHaveBeenCalled()
    expect(fa.editingFiles.has('a.go')).toBe(false)
  })

  it('NO lock + api.edit resolving undefined does NOT read as blocked (the && lock semantic)', async () => {
    // The exact case DiffPanel.test.ts exercises with mockResolvedValue(undefined):
    // without a lock, an undefined resolve must not be mistaken for "blocked".
    mockApi.edit.mockResolvedValueOnce(undefined as never)
    const fa = createFileActions(deps)
    await fa.startEdit('a.go')
    expect(mockApi.fileShow).toHaveBeenCalled()
    expect(fa.editingFiles.has('a.go')).toBe(true)
  })

  it('opening the editor closes an open preview for the same file (edit wins)', async () => {
    liveTarget = target('co-A', 'ch-A', { isWorkingCopy: true })
    const fa = createFileActions(deps)
    await fa.togglePreview('README.md')
    expect(fa.previewContents.has('README.md')).toBe(true)

    await fa.startEdit('README.md')
    expect(fa.previewContents.has('README.md')).toBe(false)
    expect(fa.editingFiles.has('README.md')).toBe(true)
  })

  it('fileShow rejection → editError set, editBusy released', async () => {
    mockApi.fileShow.mockRejectedValueOnce(new Error('boom'))
    liveTarget = target('co-A', 'ch-A', { isWorkingCopy: true })
    const fa = createFileActions(deps)
    await fa.startEdit('a.go')
    expect(fa.editError).toContain('Edit failed')
    expect(fa.editBusy.has('a.go')).toBe(false)
  })
})

describe('discardFile', () => {
  it('editBusy held (startEdit in flight) → no-op, restore NOT called', async () => {
    const d = deferred<{ content: string }>()
    mockApi.fileShow.mockReturnValueOnce(d.p)
    liveTarget = target('co-A', 'ch-A', { isWorkingCopy: true })
    const fa = createFileActions(deps)

    const editP = fa.startEdit('a.go') // suspended in fileShow, holds editBusy
    await flush()
    expect(fa.editBusy.has('a.go')).toBe(true)

    await fa.discardFile('a.go')
    expect(mockApi.restore).not.toHaveBeenCalled()

    d.resolve({ content: 'body' })
    await editP
  })

  it('success → restore called with changeId + onfilesaved fires', async () => {
    onFileSaved = vi.fn()
    const fa = createFileActions(deps)
    await fa.discardFile('a.go')
    expect(mockApi.restore).toHaveBeenCalledWith('ch-A', ['a.go'])
    expect(onFileSaved).toHaveBeenCalledOnce()
  })

  it('rename → both source and dest paths passed to restore', async () => {
    const fa = createFileActions(deps)
    await fa.discardFile('new.go', 'old.go')
    expect(mockApi.restore).toHaveBeenCalledWith('ch-A', ['old.go', 'new.go'])
  })

  it('navigation during restore await → onfilesaved NOT called', async () => {
    const d = deferred<{ output: string }>()
    mockApi.restore.mockReturnValueOnce(d.p)
    onFileSaved = vi.fn()
    const fa = createFileActions(deps)

    const p = fa.discardFile('a.go')
    liveTarget = target('co-B', 'ch-B')
    d.resolve({ output: '' })
    await p

    expect(onFileSaved).not.toHaveBeenCalled()
  })

  it('blocked lock → bail without surfacing a duplicate error', async () => {
    lock = async () => undefined
    onFileSaved = vi.fn()
    const fa = createFileActions(deps)
    await fa.discardFile('a.go')
    expect(onFileSaved).not.toHaveBeenCalled()
    expect(fa.editError).toBe('')
  })

  it('jj mutation routes through the lock when present', async () => {
    const lockSpy = vi.fn((fn: () => Promise<unknown>) => fn())
    lock = lockSpy as unknown as JJMutationLock
    const fa = createFileActions(deps)
    await fa.discardFile('a.go')
    expect(lockSpy).toHaveBeenCalledOnce()
    expect(mockApi.restore).toHaveBeenCalled()
  })
})

describe('togglePreview — previewGen barrier', () => {
  it('open fetches at previewCommitId; second toggle closes without fetch', async () => {
    const fa = createFileActions(deps)
    await fa.togglePreview('README.md')
    expect(mockApi.fileShow).toHaveBeenCalledWith('co-A', 'README.md')
    expect(fa.previewContents.get('README.md')).toBe('body')

    mockApi.fileShow.mockClear()
    await fa.togglePreview('README.md')
    expect(fa.previewContents.has('README.md')).toBe(false)
    expect(mockApi.fileShow).not.toHaveBeenCalled()
  })

  it('image path → empty-string entry, no fetch', async () => {
    const fa = createFileActions(deps)
    await fa.togglePreview('logo.png')
    expect(fa.previewContents.get('logo.png')).toBe('')
    expect(mockApi.fileShow).not.toHaveBeenCalled()
  })

  it('multi target previews the newest checked commit', async () => {
    liveTarget = { kind: 'multi', revset: 'a|b', commitIds: ['co-newest', 'co-older'] }
    const fa = createFileActions(deps)
    await fa.togglePreview('README.md')
    expect(mockApi.fileShow).toHaveBeenCalledWith('co-newest', 'README.md')
  })

  it('clearPreviews (gen bump) during fetch → stale resolve bounces', async () => {
    const d = deferred<{ content: string }>()
    mockApi.fileShow.mockReturnValueOnce(d.p)
    const fa = createFileActions(deps)

    const p = fa.togglePreview('README.md')
    fa.clearPreviews() // hunk-review entry while fetch in flight
    d.resolve({ content: '# doc' })
    await p

    expect(fa.previewContents.has('README.md')).toBe(false)
  })

  it('commitId churn during fetch (no gen bump) → live previewCommitId comparison bounces it', async () => {
    const d = deferred<{ content: string }>()
    mockApi.fileShow.mockReturnValueOnce(d.p)
    const fa = createFileActions(deps)

    const p = fa.togglePreview('README.md')
    liveTarget = target('co-A2', 'ch-A') // snapshot rewrote @: same change, new commit
    d.resolve({ content: '# stale' })
    await p

    expect(fa.previewContents.has('README.md')).toBe(false)
  })

  it('fetch error → editError, but only when gen still current', async () => {
    mockApi.fileShow.mockRejectedValueOnce(new Error('nope'))
    const fa = createFileActions(deps)
    await fa.togglePreview('README.md')
    expect(fa.editError).toContain('Preview failed')

    fa.editError = ''
    const d = deferred<never>()
    mockApi.fileShow.mockReturnValueOnce(d.p)
    const p = fa.togglePreview('OTHER.md')
    fa.clearPreviews() // bump gen mid-flight
    d.reject(new Error('stale error'))
    await p
    expect(fa.editError).toBe('') // stale failure stays silent
  })
})

describe('refreshPreviews — sameChange snapshot path', () => {
  it('refreshes open previews at the new commit; restores scroll when content changed', async () => {
    const fa = createFileActions(deps)
    await fa.togglePreview('README.md')

    mockApi.fileShow.mockResolvedValueOnce({ content: '# v2' })
    await fa.refreshPreviews('co-A2', ['README.md'], 120)

    expect(mockApi.fileShow).toHaveBeenLastCalledWith('co-A2', 'README.md')
    expect(fa.previewContents.get('README.md')).toBe('# v2')
    expect(setScrollTop).toHaveBeenCalledWith(120)
  })

  it('unchanged content → no scroll restore (no {@html} swap happened)', async () => {
    const fa = createFileActions(deps)
    await fa.togglePreview('README.md') // content 'body'

    mockApi.fileShow.mockResolvedValueOnce({ content: 'body' })
    await fa.refreshPreviews('co-A2', ['README.md'], 120)
    expect(setScrollTop).not.toHaveBeenCalled()
  })

  it('user closes preview mid-refresh → has() guard prevents resurrect', async () => {
    const fa = createFileActions(deps)
    await fa.togglePreview('README.md')

    const d = deferred<{ content: string }>()
    mockApi.fileShow.mockReturnValueOnce(d.p)
    const p = fa.refreshPreviews('co-A2', ['README.md'])
    fa.closePreview('README.md') // no gen bump (per-path close)
    d.resolve({ content: '# v2' })
    await p

    expect(fa.previewContents.has('README.md')).toBe(false)
  })

  it('gen bump (nav) mid-refresh → whole refresh bounces', async () => {
    const fa = createFileActions(deps)
    await fa.togglePreview('README.md')

    const d = deferred<{ content: string }>()
    mockApi.fileShow.mockReturnValueOnce(d.p)
    const p = fa.refreshPreviews('co-A2', ['README.md'])
    fa.bumpPreviewGen()
    d.resolve({ content: '# v2' })
    await p

    expect(fa.previewContents.get('README.md')).toBe('body') // untouched
  })

  it('transient fetch error → stale content kept (preview does not vanish)', async () => {
    const fa = createFileActions(deps)
    await fa.togglePreview('README.md')

    mockApi.fileShow.mockRejectedValueOnce(new Error('WC lock'))
    await fa.refreshPreviews('co-A2', ['README.md'])
    expect(fa.previewContents.get('README.md')).toBe('body')
  })
})

describe('quickResolve — conflict resolution strategy', () => {
  beforeEach(() => {
    mockApi.fileShow.mockResolvedValue({ content: conflictContent })
  })

  it('@ target → fileWrite, no jj edit', async () => {
    liveTarget = target('co-A', 'ch-A', { isWorkingCopy: true })
    onFileSaved = vi.fn()
    const fa = createFileActions(deps)
    await fa.quickResolve('a.go', 'theirs')

    expect(mockApi.edit).not.toHaveBeenCalled()
    expect(mockApi.fileWrite).toHaveBeenCalledWith('a.go', 'THEIRS')
    expect(onFileSaved).toHaveBeenCalled()
  })

  it('non-@ target → mergeResolve with commit_id, @ does NOT move', async () => {
    onFileSaved = vi.fn()
    const fa = createFileActions(deps)
    await fa.quickResolve('a.go', 'ours')

    expect(mockApi.edit).not.toHaveBeenCalled()
    expect(mockApi.fileWrite).not.toHaveBeenCalled()
    expect(mockApi.mergeResolve).toHaveBeenCalledWith('co-A', 'a.go', 'OURS')
    expect(onFileSaved).toHaveBeenCalled()
  })

  it('non-@ SSH (mergeResolve 501) → jj-edit fallback + "working copy moved" banner', async () => {
    mockApi.mergeResolve.mockRejectedValue(new Error('merge-resolve requires local mode'))
    onFileSaved = vi.fn()
    const fa = createFileActions(deps)
    await fa.quickResolve('a.go', 'ours')

    expect(mockApi.edit).toHaveBeenCalledWith('co-A')
    expect(mockApi.fileWrite).toHaveBeenCalledWith('a.go', 'OURS')
    expect(fa.editError).toContain('working copy moved')
    expect(onFileSaved).toHaveBeenCalled()
  })

  it('SSH fallback + nav during the failed mergeResolve → isStale blocks the jj edit', async () => {
    const d = deferred<never>()
    mockApi.mergeResolve.mockReturnValueOnce(d.p)
    const fa = createFileActions(deps)

    const p = fa.quickResolve('a.go', 'ours')
    await flush()
    liveTarget = target('co-B', 'ch-B') // nav away mid-resolve
    d.reject(new Error('merge-resolve requires local mode'))
    await p

    expect(mockApi.edit).not.toHaveBeenCalled() // point of no return never crossed
  })

  it('empty chosen side (modify/delete conflict) → refused with explanation, no write', async () => {
    const deleteConflict = [
      '<<<<<<< Conflict 1 of 1',
      '+++++++ Contents of side #1',
      'OURS',
      '%%%%%%% Changes from base to side #2',
      '-BASE',
      '>>>>>>> Conflict 1 of 1 ends',
    ].join('\n')
    mockApi.fileShow.mockResolvedValue({ content: deleteConflict })
    liveTarget = target('co-A', 'ch-A', { isWorkingCopy: true })
    const fa = createFileActions(deps)
    await fa.quickResolve('a.go', 'theirs')

    expect(mockApi.fileWrite).not.toHaveBeenCalled()
    expect(fa.editError).toContain('empty')
  })

  it('unparseable conflict (git-style) → editor fallback, no blind write', async () => {
    mockApi.fileShow.mockResolvedValue({ content: '<<<<<<< ours\nA\n=======\nB\n>>>>>>> theirs\n' })
    liveTarget = target('co-A', 'ch-A', { isWorkingCopy: true })
    const fa = createFileActions(deps)
    await fa.quickResolve('a.go', 'ours')

    expect(mockApi.fileWrite).not.toHaveBeenCalled()
    expect(fa.editingFiles.has('a.go')).toBe(true) // raw editor opened instead
  })
})

describe('startMerge / saveMerge', () => {
  beforeEach(() => {
    mockApi.fileShow.mockResolvedValue({ content: conflictContent })
  })

  it('parses sides → mergeSides/mergingPath set, no @ move (pure read)', async () => {
    const fa = createFileActions(deps)
    await fa.startMerge('a.go')

    expect(mockApi.edit).not.toHaveBeenCalled()
    expect(fa.mergingPath).toBe('a.go')
    expect(fa.mergeSides?.ours).toBe('OURS')
    expect(fa.mergeSides?.theirs).toBe('THEIRS')
  })

  it('other files being edited → confirm; declined = no-op', async () => {
    liveTarget = target('co-A', 'ch-A', { isWorkingCopy: true })
    const fa = createFileActions(deps)
    mockApi.fileShow.mockResolvedValueOnce({ content: 'plain' })
    await fa.startEdit('other.go')

    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false)
    await fa.startMerge('a.go')
    expect(confirmSpy).toHaveBeenCalled()
    expect(fa.mergingPath).toBeNull()
    expect(fa.editingFiles.has('other.go')).toBe(true) // edits survive
    confirmSpy.mockRestore()
  })

  it('confirm accepted → all editors cleared, merge opens', async () => {
    liveTarget = target('co-A', 'ch-A', { isWorkingCopy: true })
    const fa = createFileActions(deps)
    mockApi.fileShow.mockResolvedValueOnce({ content: 'plain' })
    await fa.startEdit('other.go')

    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true)
    await fa.startMerge('a.go')
    expect(fa.editingFiles.size).toBe(0)
    expect(fa.mergingPath).toBe('a.go')
    confirmSpy.mockRestore()
  })

  it('saveMerge resolves via the shared strategy, closes the panel, refreshes', async () => {
    liveTarget = target('co-A', 'ch-A', { isWorkingCopy: true })
    onFileSaved = vi.fn()
    const fa = createFileActions(deps)
    await fa.startMerge('a.go')

    await fa.saveMerge('resolved content')
    expect(mockApi.fileWrite).toHaveBeenCalledWith('a.go', 'resolved content')
    expect(fa.mergingPath).toBeNull()
    expect(fa.mergeSides).toBeNull()
    expect(onFileSaved).toHaveBeenCalled()
  })

  it('saveMerge write failure → panel stays open, error surfaced', async () => {
    liveTarget = target('co-A', 'ch-A', { isWorkingCopy: true })
    const fa = createFileActions(deps)
    await fa.startMerge('a.go')

    mockApi.fileWrite.mockRejectedValueOnce(new Error('disk full'))
    await fa.saveMerge('resolved content')
    expect(fa.mergingPath).toBe('a.go') // still open for retry
    expect(fa.editError).toContain('Save failed')
  })
})

describe('saveFile', () => {
  it('writes, clears edit state, refreshes', async () => {
    liveTarget = target('co-A', 'ch-A', { isWorkingCopy: true })
    onFileSaved = vi.fn()
    const fa = createFileActions(deps)
    await fa.startEdit('a.go')

    await fa.saveFile('a.go', 'new content')
    expect(mockApi.fileWrite).toHaveBeenCalledWith('a.go', 'new content')
    expect(fa.editingFiles.has('a.go')).toBe(false)
    expect(onFileSaved).toHaveBeenCalled()
  })

  it('navigation during fileWrite await → edit state NOT cleared, no refresh', async () => {
    liveTarget = target('co-A', 'ch-A', { isWorkingCopy: true })
    onFileSaved = vi.fn()
    const fa = createFileActions(deps)
    await fa.startEdit('a.go')

    const d = deferred<{ output: string }>()
    mockApi.fileWrite.mockReturnValueOnce(d.p)
    const p = fa.saveFile('a.go', 'new content')
    liveTarget = target('co-B', 'ch-B')
    d.resolve({ output: '' })
    await p

    expect(fa.editingFiles.has('a.go')).toBe(true) // reset effect handles the clear on nav
    expect(onFileSaved).not.toHaveBeenCalled()
  })

  it('cancelEdit clears the editor without writing', async () => {
    liveTarget = target('co-A', 'ch-A', { isWorkingCopy: true })
    const fa = createFileActions(deps)
    await fa.startEdit('a.go')

    fa.cancelEdit('a.go')
    expect(fa.editingFiles.has('a.go')).toBe(false)
    expect(fa.editFileContents.has('a.go')).toBe(false)
    expect(mockApi.fileWrite).not.toHaveBeenCalled()
  })

  it('edit → save → edit again fetches at the NEW commit_id (issue #16)', async () => {
    // Save snapshots @ → new commit_id, SAME change_id. The second Edit must
    // read by the new commit_id: api.fileShow caches by the id it's given, so
    // a change_id-keyed read would cache-hit the first edit's pre-save content.
    liveTarget = target('co-A', 'ch-A', { isWorkingCopy: true })
    // onFileSaved = App's logSync.refresh(): the log reload mints the new
    // commit_id into the live diffTarget before saveFile returns.
    onFileSaved = () => { liveTarget = target('co-A2', 'ch-A', { isWorkingCopy: true }) }
    const fa = createFileActions(deps)

    await fa.startEdit('a.go')
    expect(mockApi.fileShow).toHaveBeenLastCalledWith('co-A', 'a.go')

    await fa.saveFile('a.go', 'edited content')

    await fa.startEdit('a.go')
    expect(mockApi.fileShow).toHaveBeenLastCalledWith('co-A2', 'a.go')
  })
})

describe('reset / clearPreviews lifecycle', () => {
  it('reset() clears editing + preview + merge + error state', async () => {
    liveTarget = target('co-A', 'ch-A', { isWorkingCopy: true })
    const fa = createFileActions(deps)
    mockApi.fileShow.mockResolvedValueOnce({ content: 'plain' })
    await fa.startEdit('a.go')
    await fa.togglePreview('README.md')
    fa.editError = 'leftover'

    fa.reset()
    expect(fa.editingFiles.size).toBe(0)
    expect(fa.editFileContents.size).toBe(0)
    expect(fa.editBusy.size).toBe(0)
    expect(fa.previewContents.size).toBe(0)
    expect(fa.editError).toBe('')
    expect(fa.mergeSides).toBeNull()
    expect(fa.mergingPath).toBeNull()
  })

  it('reset() bumps the preview gen — in-flight preview fetch bounces', async () => {
    const d = deferred<{ content: string }>()
    mockApi.fileShow.mockReturnValueOnce(d.p)
    const fa = createFileActions(deps)

    const p = fa.togglePreview('README.md')
    fa.reset()
    d.resolve({ content: '# late' })
    await p

    expect(fa.previewContents.has('README.md')).toBe(false)
  })

  it('clearPreviews drops open previews and invalidates in-flight fetches', async () => {
    const fa = createFileActions(deps)
    await fa.togglePreview('README.md')
    expect(fa.previewContents.size).toBe(1)

    fa.clearPreviews()
    expect(fa.previewContents.size).toBe(0)
  })

  it('closePreview is per-path: does NOT cancel another file\'s in-flight fetch', async () => {
    const fa = createFileActions(deps)
    await fa.togglePreview('A.md') // open A

    const d = deferred<{ content: string }>()
    mockApi.fileShow.mockReturnValueOnce(d.p)
    const p = fa.togglePreview('B.md') // B in flight
    fa.closePreview('A.md') // closing A must not bump the gen
    d.resolve({ content: '# B' })
    await p

    expect(fa.previewContents.has('A.md')).toBe(false)
    expect(fa.previewContents.get('B.md')).toBe('# B') // B still landed
  })
})
