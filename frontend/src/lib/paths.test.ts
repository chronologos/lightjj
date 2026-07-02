import { describe, it, expect } from 'vitest'
import { basename, dirname } from './paths'

describe('paths', () => {
  it.each([
    ['a/b/c', 'c', 'a/b/'],
    ['/abs/path', 'path', '/abs/'],
    ['nofile', 'nofile', ''],
    ['C:\\Users\\x\\proj', 'proj', 'C:\\Users\\x\\'],
    ['/mixed\\win/path', 'path', '/mixed\\win/'],
  ])('%s → basename=%s dirname=%s', (p, base, dir) => {
    expect(basename(p)).toBe(base)
    expect(dirname(p)).toBe(dir)
  })
})
