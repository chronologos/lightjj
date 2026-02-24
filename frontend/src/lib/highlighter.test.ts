import { describe, it, expect } from 'vitest'
import { detectLanguage, highlightLines } from './highlighter'

describe('detectLanguage', () => {
  it('maps common extensions', () => {
    expect(detectLanguage('file.ts')).toBe('typescript')
    expect(detectLanguage('file.tsx')).toBe('typescript')
    expect(detectLanguage('file.js')).toBe('javascript')
    expect(detectLanguage('file.jsx')).toBe('javascript')
    expect(detectLanguage('file.go')).toBe('go')
    expect(detectLanguage('file.py')).toBe('python')
    expect(detectLanguage('file.rs')).toBe('rust')
    expect(detectLanguage('file.css')).toBe('css')
    expect(detectLanguage('file.json')).toBe('json')
  })

  it('maps yaml variants', () => {
    expect(detectLanguage('file.yml')).toBe('yaml')
    expect(detectLanguage('file.yaml')).toBe('yaml')
  })

  it('maps go special extensions', () => {
    expect(detectLanguage('go.mod')).toBe('go')
    expect(detectLanguage('go.sum')).toBe('go')
  })

  it('maps bash variants', () => {
    expect(detectLanguage('script.sh')).toBe('bash')
    expect(detectLanguage('script.bash')).toBe('bash')
  })

  it('handles nested path', () => {
    expect(detectLanguage('path/to/file.go')).toBe('go')
  })

  it('handles double extension', () => {
    expect(detectLanguage('foo.test.ts')).toBe('typescript')
  })

  it('returns text for no extension', () => {
    // 'Makefile' → pop returns 'makefile' (lowercased), not in map
    expect(detectLanguage('Makefile')).toBe('text')
  })

  it('returns text for unknown extension', () => {
    expect(detectLanguage('foo.xyz')).toBe('text')
  })

  it('is case insensitive', () => {
    expect(detectLanguage('FOO.TS')).toBe('typescript')
    expect(detectLanguage('bar.GO')).toBe('go')
  })

  it('returns text for dot-only files', () => {
    // '.gitignore' → pop returns 'gitignore', not in map
    expect(detectLanguage('.gitignore')).toBe('text')
  })
})

describe('highlightLines text path', () => {
  it('returns empty array for empty input', async () => {
    expect(await highlightLines([], 'text')).toEqual([])
  })

  it('passes through plain text', async () => {
    expect(await highlightLines(['hello world'], 'text')).toEqual(['hello world'])
  })

  it('escapes HTML characters', async () => {
    expect(await highlightLines(['<div>&amp;</div>'], 'text'))
      .toEqual(['&lt;div&gt;&amp;amp;&lt;/div&gt;'])
  })

  it('short-circuits before Shiki for empty lines with non-text lang', async () => {
    // Empty array → returns [] immediately (lines.length === 0 check)
    expect(await highlightLines([], 'go')).toEqual([])
  })
})
