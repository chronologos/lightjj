import { describe, expect, it } from 'vitest'
import {
  flattenTree, ancestorDirs, parentDir, changeMarks, contentKind, contentLines, visiblePath,
  type DirState, type TreeEntry,
} from './file-tree'
import type { FileChange } from './api'

const dir = (path: string, files = 1): TreeEntry => ({ name: path.split('/').pop()!, path, type: 'dir', files })
const file = (path: string): TreeEntry => ({ name: path.split('/').pop()!, path, type: 'file' })
const ok = (entries: TreeEntry[], omitted = 0): DirState => ({ status: 'ok', entries, omitted })

describe('flattenTree', () => {
  it('root not loaded yet → a single loading row', () => {
    const rows = flattenTree(new Map(), new Set())
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ kind: 'status', text: 'Loading…', depth: 0 })
  })

  it('empty root → an explicit empty-state row', () => {
    const rows = flattenTree(new Map([['', ok([])]]), new Set())
    expect(rows.map(r => r.kind === 'status' && r.text)).toEqual(['(no files at this revision)'])
  })

  it('collapsed dirs hide children; expanded dirs nest at depth+1 in server order', () => {
    const dirs = new Map<string, DirState>([
      ['', ok([dir('a', 2), dir('b'), file('z.txt')])],
      ['a', ok([dir('a/inner'), file('a/x.go')])],
      ['a/inner', ok([file('a/inner/deep.go')])],
      ['b', ok([file('b/y.go')])],
    ])
    expect(flattenTree(dirs, new Set()).map(r => r.key)).toEqual(['a', 'b', 'z.txt'])
    const rows = flattenTree(dirs, new Set(['a', 'a/inner']))
    expect(rows.map(r => [r.key, r.depth])).toEqual([
      ['a', 0], ['a/inner', 1], ['a/inner/deep.go', 2], ['a/x.go', 1], ['b', 0], ['z.txt', 0],
    ])
  })

  it('expanded-but-not-loaded / errored dirs show a status row under the dir', () => {
    const dirs = new Map<string, DirState>([
      ['', ok([dir('a'), dir('b')])],
      ['b', { status: 'error', error: 'boom' }],
    ])
    const rows = flattenTree(dirs, new Set(['a', 'b']))
    expect(rows.map(r => r.kind === 'status' ? `${r.depth}:${r.text}` : r.key)).toEqual(['a', '1:Loading…', 'b', '1:boom'])
    // Status keys can't collide with a real path (NUL prefix).
    expect(rows.filter(r => r.kind === 'status').every(r => r.key.startsWith('\0'))).toBe(true)
  })

  it('omitted children (server per-dir cap) get a "more" row', () => {
    const rows = flattenTree(new Map([['', ok([file('a')], 1234)]]), new Set())
    expect(rows[1]).toMatchObject({ kind: 'status' })
    expect(rows[1].kind === 'status' && rows[1].text).toContain('1,234 more')
  })

  it('a file and a sibling status row never share a key even for odd names', () => {
    const dirs = new Map<string, DirState>([['', ok([file('~loading:a'), dir('a')])]])
    const keys = flattenTree(dirs, new Set(['a'])).map(r => r.key)
    expect(new Set(keys).size).toBe(keys.length)
  })
})

describe('path helpers', () => {
  it('ancestorDirs', () => {
    expect(ancestorDirs('a/b/c.go')).toEqual(['a', 'a/b'])
    expect(ancestorDirs('top.go')).toEqual([])
  })
  it('parentDir', () => {
    expect(parentDir('a/b/c.go')).toBe('a/b')
    expect(parentDir('top.go')).toBe('')
  })
})

describe('visiblePath', () => {
  it('escapes control characters for display, leaves everything else alone', () => {
    expect(visiblePath('new\nline.txt')).toBe('new\\nline.txt')
    expect(visiblePath('a\tb\rc\u0001')).toBe('a\\tb\\rc\\x01')
    expect(visiblePath('naïve 文件 "q" -x')).toBe('naïve 文件 "q" -x')
  })
})

describe('changeMarks', () => {
  const fc = (path: string, type: string, conflict = false): FileChange =>
    ({ path, type, conflict, additions: 0, deletions: 0, conflict_sides: 0 })
  it('indexes files and every ancestor dir (deleted files mark their dirs too)', () => {
    const m = changeMarks([fc('src/lib/a.ts', 'M'), fc('docs/old.md', 'D'), fc('x.go', 'A', true)])
    expect(m.files.get('src/lib/a.ts')).toEqual({ type: 'M', conflict: false })
    expect(m.files.get('x.go')).toEqual({ type: 'A', conflict: true })
    expect([...m.dirs].sort()).toEqual(['docs', 'src', 'src/lib'])
  })
})

describe('content helpers', () => {
  it('contentKind: images by extension, binary by NUL, else text', () => {
    expect(contentKind('logo.PNG', '\u0000whatever')).toBe('image')
    expect(contentKind('a.bin', 'ab\u0000cd')).toBe('binary')
    expect(contentKind('a.go', 'package main\n')).toBe('text')
    // NUL beyond the 8 KB sniff window doesn't flip a text file.
    expect(contentKind('big.txt', 'x'.repeat(9000) + '\u0000')).toBe('text')
  })
  it('contentLines: no phantom last line, CRLF trimmed, empty → []', () => {
    expect(contentLines('')).toEqual([])
    expect(contentLines('a\nb\n')).toEqual(['a', 'b'])
    expect(contentLines('a\nb')).toEqual(['a', 'b'])
    expect(contentLines('a\r\nb\r\n')).toEqual(['a', 'b'])
    expect(contentLines('\n')).toEqual([''])
  })
})
