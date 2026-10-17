import { describe, expect, it, vi, beforeEach, type Mock } from 'vitest'
import { fireEvent, render } from '@testing-library/svelte'
import { tick } from 'svelte'

vi.mock('./api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./api')>()
  return {
    ...actual,
    api: { ...actual.api, fileTree: vi.fn(), fileTreeSearch: vi.fn(), files: vi.fn(), fileShow: vi.fn() },
  }
})

import FileTreePanel from './FileTreePanel.svelte'
import { api, type FileTreeResponse, type TreeEntry, type FileChange } from './api'
import { waitFor } from '../testutil/wait-for'

const mockTree = api.fileTree as Mock
const mockSearch = api.fileTreeSearch as Mock
const mockFiles = api.files as Mock
const mockShow = api.fileShow as Mock

const COMMIT = 'abc123def456'
const d = (path: string, files: number): TreeEntry => ({ name: path.split('/').pop()!, path, type: 'dir', files })
const f = (path: string, extra: Partial<TreeEntry> = {}): TreeEntry => ({ name: path.split('/').pop()!, path, type: 'file', ...extra })

const TREE: Record<string, TreeEntry[]> = {
  '': [d('src', 2), d('docs', 1), f('README.md'), f('run.sh', { executable: true }), f('logo.png')],
  src: [d('src/lib', 1), f('src/main.go')],
  'src/lib': [f('src/lib/util.go')],
  docs: [f('docs/guide.md')],
}
const CONTENT: Record<string, string> = {
  'README.md': '# Hello\n',
  'run.sh': '#!/bin/sh\necho hi\n',
  'src/main.go': 'package main\n\nfunc main() {}\n',
  'src/lib/util.go': 'package lib\n',
  'docs/guide.md': 'guide\n',
  'logo.png': '\u0089PNG\u0000',
}

beforeEach(() => {
  for (const m of [mockTree, mockSearch, mockFiles, mockShow]) m.mockReset()
  mockTree.mockImplementation(async (_rev: string, dir = ''): Promise<FileTreeResponse> => {
    const entries = TREE[dir]
    if (!entries) throw new Error(`no directory "${dir}"`)
    return { commit_id: COMMIT, dir, entries, total_files: 7, truncated: false }
  })
  mockFiles.mockResolvedValue([
    { path: 'src/main.go', type: 'M', additions: 1, deletions: 0, conflict: false, conflict_sides: 0 },
  ] satisfies FileChange[])
  mockShow.mockImplementation(async (_rev: string, path: string) => ({ content: CONTENT[path] ?? '' }))
  mockSearch.mockImplementation(async (_rev: string, q: string) => ({
    commit_id: COMMIT,
    matches: q === 'util' ? [{ path: 'src/lib/util.go', type: 'file' }] : [],
    total: q === 'util' ? 1 : 0,
    truncated: false,
  }))
})

async function mount(extra: Record<string, unknown> = {}) {
  const onclose = vi.fn()
  const onfilehistory = vi.fn()
  const r = render(FileTreePanel, {
    props: { commitId: COMMIT, changeId: 'zzyyxxwwvv', isWorkingCopy: false, onclose, onfilehistory, ...extra },
  })
  await waitFor(() => r.container.querySelectorAll('.ft-row').length > 1)
  return { ...r, onclose, onfilehistory }
}

const kd = (c: unknown, key: string) =>
  (c as { handleKeydown: (e: KeyboardEvent) => boolean }).handleKeydown(new KeyboardEvent('keydown', { key }))

const rowTexts = (c: HTMLElement) =>
  [...c.querySelectorAll('.ft-row')].map(r => r.querySelector('.ft-name, .ft-status')?.textContent?.trim())
const cursorText = (c: HTMLElement) =>
  c.querySelector('.ft-cursor .ft-name, .ft-cursor .ft-status')?.textContent?.trim()

describe('FileTreePanel', () => {
  it('loads the root for the commit and renders dirs first with the server order', async () => {
    const { container } = await mount()
    expect(mockTree).toHaveBeenCalledWith(COMMIT, '')
    expect(rowTexts(container)).toEqual(['src/', 'docs/', 'README.md', 'run.sh', 'logo.png'])
    expect(container.querySelector('.ft-count')?.textContent).toContain('7 files')
  })

  it('marks changed files and their ancestor dirs', async () => {
    const { component, container } = await mount()
    // src/ contains the changed src/main.go → dot on the dir row
    const srcRow = container.querySelector('.ft-row[data-idx="0"]')!
    expect(srcRow.querySelector('.ft-dot')).not.toBeNull()
    expect(container.querySelector('.ft-row[data-idx="1"] .ft-dot')).toBeNull()
    kd(component, 'l')
    await waitFor(() => rowTexts(container).includes('main.go'))
    const main = [...container.querySelectorAll('.ft-row')].find(r => r.textContent?.includes('main.go'))!
    expect(main.querySelector('.ft-badge')?.textContent).toBe('M')
  })

  it('l expands (lazy fetch), l again steps into the first child, h collapses / goes to parent', async () => {
    const { component, container } = await mount()
    expect(cursorText(container)).toBe('src/')
    kd(component, 'l')
    await waitFor(() => rowTexts(container).includes('lib/'))
    expect(mockTree).toHaveBeenCalledWith(COMMIT, 'src')
    expect(rowTexts(container)).toEqual(['src/', 'lib/', 'main.go', 'docs/', 'README.md', 'run.sh', 'logo.png'])
    expect(cursorText(container)).toBe('src/') // cursor stays on the dir (identity), rows grew below it

    kd(component, 'l'); await tick()
    expect(cursorText(container)).toBe('lib/')
    kd(component, 'h'); await tick() // lib is collapsed → jump to parent
    expect(cursorText(container)).toBe('src/')
    kd(component, 'h'); await tick() // src is expanded → collapse
    expect(rowTexts(container)).toEqual(['src/', 'docs/', 'README.md', 'run.sh', 'logo.png'])
    // Re-expanding is served from the panel's map (no second fetch).
    const calls = mockTree.mock.calls.length
    kd(component, 'ArrowRight'); await tick()
    expect(rowTexts(container)).toContain('main.go')
    expect(mockTree.mock.calls.length).toBe(calls)
  })

  it('Enter toggles a dir; clicking a row moves the cursor and activates it', async () => {
    const { component, container } = await mount()
    kd(component, 'j') // docs/
    kd(component, 'Enter')
    await waitFor(() => rowTexts(container).includes('guide.md'))
    kd(component, 'Enter'); await tick()
    expect(rowTexts(container)).not.toContain('guide.md')

    const readme = [...container.querySelectorAll('.ft-row')].find(r => r.textContent?.includes('README.md'))!
    await fireEvent.click(readme)
    expect(cursorText(container)).toBe('README.md')
    await waitFor(() => container.querySelector('.ft-code') !== null)
    expect(mockShow).toHaveBeenCalledWith(COMMIT, 'README.md')
  })

  it('preview follows the cursor onto files (by commit_id) with line numbers', async () => {
    const { component, container } = await mount()
    kd(component, 'j'); kd(component, 'j'); kd(component, 'j') // run.sh
    await tick()
    expect(cursorText(container)).toBe('run.sh')
    await waitFor(() => container.querySelector('.ft-viewer-path')?.textContent === 'run.sh')
    await waitFor(() => container.querySelectorAll('.ft-line').length === 2)
    expect(mockShow).toHaveBeenCalledWith(COMMIT, 'run.sh')
    expect(container.querySelector('.ft-line .ft-ln')?.textContent).toBe('1')
    expect(container.querySelector('.ft-chip')?.textContent).toBe('executable')
  })

  it('images render from file-raw instead of as text', async () => {
    const { component, container } = await mount()
    for (let i = 0; i < 4; i++) kd(component, 'j')
    await tick()
    expect(cursorText(container)).toBe('logo.png')
    await waitFor(() => container.querySelector('.ft-image img') !== null)
    expect(container.querySelector('.ft-image img')?.getAttribute('src')).toContain('/api/file-raw?')
  })

  it('binary content is not rendered as text', async () => {
    CONTENT['README.md'] = 'ab\u0000cd'
    try {
      const { component, container } = await mount()
      kd(component, 'j'); kd(component, 'j')
      await waitFor(() => container.querySelector('.ft-viewer-body')?.textContent?.includes('Binary file') ?? false)
      expect(container.querySelector('.ft-code')).toBeNull()
    } finally { CONTENT['README.md'] = '# Hello\n' }
  })

  it('/ focuses the filter; results come from the server search; Enter opens; Escape clears and reveals in the tree', async () => {
    const { component, container } = await mount()
    expect(kd(component, '/')).toBe(true)
    const input = container.querySelector('.ft-filter-input') as HTMLInputElement
    expect(document.activeElement).toBe(input)

    await fireEvent.input(input, { target: { value: 'util' } })
    await waitFor(() => rowTexts(container).some(t => t?.endsWith('util.go')))
    expect(mockSearch).toHaveBeenCalledWith(COMMIT, 'util', 200)
    expect(container.querySelector('.ft-match-dir')?.textContent).toBe('src/lib/')

    await fireEvent.keyDown(input, { key: 'Enter' })
    await waitFor(() => container.querySelector('.ft-viewer-path')?.textContent === 'src/lib/util.go')

    await fireEvent.keyDown(input, { key: 'Escape' })
    // Back to the tree with the file's ancestors expanded and the cursor on it.
    await waitFor(() => cursorText(container) === 'util.go')
    expect(rowTexts(container)).toEqual(['src/', 'lib/', 'util.go', 'main.go', 'docs/', 'README.md', 'run.sh', 'logo.png'])
    expect(input.value).toBe('')
  })

  it('no matches shows a status row', async () => {
    const { container } = await mount()
    const input = container.querySelector('.ft-filter-input') as HTMLInputElement
    await fireEvent.input(input, { target: { value: 'nothing-here' } })
    await waitFor(() => rowTexts(container).includes('No matching files'))
  })

  it('Escape closes when not filtering; H opens history for the previewed file', async () => {
    const { component, container, onclose, onfilehistory } = await mount()
    kd(component, 'j'); kd(component, 'j') // README.md
    await waitFor(() => container.querySelector('.ft-viewer-path')?.textContent === 'README.md')
    kd(component, 'H')
    expect(onfilehistory).toHaveBeenCalledWith('README.md')
    kd(component, 'Escape')
    expect(onclose).toHaveBeenCalledOnce()
  })

  it('Open in editor is offered only for the working copy', async () => {
    const onopenfile = vi.fn()
    let r = await mount({ onopenfile })
    kd(r.component, 'j'); kd(r.component, 'j')
    await waitFor(() => r.container.querySelector('.ft-viewer-header') !== null)
    expect(r.container.textContent).not.toContain('Open in editor')
    r.unmount()

    r = await mount({ onopenfile, isWorkingCopy: true })
    kd(r.component, 'j'); kd(r.component, 'j')
    await waitFor(() => r.container.querySelector('.ft-viewer-header') !== null)
    const btn = [...r.container.querySelectorAll('.ft-viewer-header .btn')].find(b => b.textContent?.includes('Open in editor'))!
    await fireEvent.click(btn)
    expect(onopenfile).toHaveBeenCalledWith('README.md')
  })

  it('a failed directory load shows the error under the dir and retries on re-expand', async () => {
    mockTree.mockImplementationOnce(async () => ({ commit_id: COMMIT, dir: '', entries: TREE[''], total_files: 7, truncated: false }))
    mockTree.mockImplementationOnce(async () => { throw new Error('jj exploded') })
    const { component, container } = await mount()
    kd(component, 'l')
    await waitFor(() => rowTexts(container).includes('jj exploded'))
    kd(component, 'h'); await tick()
    kd(component, 'l')
    await waitFor(() => rowTexts(container).includes('main.go'))
  })
})
