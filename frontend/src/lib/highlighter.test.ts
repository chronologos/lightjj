import { describe, it, expect } from 'vitest'
import { highlightLines } from './highlighter'
import { detectLanguage, ensureLegacyParsers } from './languages'

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

  it('maps zig and zon', () => {
    expect(detectLanguage('main.zig')).toBe('zig')
    expect(detectLanguage('build.zig.zon')).toBe('zig')
  })

  it('maps proto to protobuf', () => {
    expect(detectLanguage('foo.proto')).toBe('protobuf')
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

  // The svelte→htmlParser mapping lives in the LANGUAGES registry (parser
  // field), not in the ext map — detectLanguage returns the lang NAME so
  // both highlighter and cm-shared can apply their own svelte handling.
  it('returns svelte (not html) for .svelte — parser mapping is in LANGUAGES', () => {
    expect(detectLanguage('App.svelte')).toBe('svelte')
  })
})

describe('highlightLines', () => {
  it('returns empty array for empty input', () => {
    expect(highlightLines([], 'text')).toEqual([])
    expect(highlightLines([], 'go')).toEqual([])
  })

  it('escapes HTML for unknown lang (no parser)', () => {
    expect(highlightLines(['<div>&amp;</div>'], 'text'))
      .toEqual(['&lt;div&gt;&amp;amp;&lt;/div&gt;'])
  })

  it('escapes HTML inside token spans', () => {
    // Lezer passes raw source text to the emit callback; we escape there.
    // A Go string literal containing < > & must be escaped in the output.
    const out = highlightLines(['x := "<a>&"'], 'go')
    expect(out).toHaveLength(1)
    expect(out[0]).toContain('&lt;a&gt;&amp;')
    expect(out[0]).not.toContain('<a>') // no raw HTML leaked
    expect(out[0]).toContain('tok-string')
  })

  it('emits tok-* class names (theme-independent)', () => {
    const out = highlightLines(['func main() {}'], 'go')
    expect(out[0]).toContain('class="tok-keyword"')
    expect(out[0]).not.toMatch(/style="/) // no inline styles
  })

  it('preserves line boundaries via break callback', () => {
    // highlightCode fires break on \n — joining 3 lines must yield exactly 3
    // output strings, with no tokens leaking across the boundary.
    const lines = ['func f() {', '\tx := 1', '}']
    const out = highlightLines(lines, 'go')
    expect(out).toHaveLength(3)
    expect(out[0]).toContain('tok-keyword') // func
    expect(out[1]).toContain('tok-number')  // 1
    expect(out[1]).not.toContain('func')    // no cross-line leak
    expect(out[2]).toContain('}')
  })

  it('preserves empty lines', () => {
    const out = highlightLines(['x := 1', '', 'y := 2'], 'go')
    expect(out).toHaveLength(3)
    expect(out[1]).toBe('')
  })

  it('svelte uses html parser (tags/attrs highlighted, interpolations plain)', () => {
    const out = highlightLines(['<div class="x">{foo}</div>'], 'svelte')
    expect(out[0]).toContain('tok-typeName')     // div
    expect(out[0]).toContain('tok-propertyName') // class
    expect(out[0]).toContain('tok-string')       // "x"
    // {foo} is not in HTML grammar — passes through as plain escaped text
    expect(out[0]).toContain('{foo}')
  })

  it('bash via StreamLanguage (legacy-mode wrapper emits Lezer tree)', async () => {
    await ensureLegacyParsers()
    const out = highlightLines(['echo "hello"'], 'bash')
    expect(out[0]).toContain('tok-string')
  })

  it('toml via StreamLanguage', async () => {
    await ensureLegacyParsers()
    const out = highlightLines(['name = "foo"'], 'toml')
    expect(out[0]).toContain('tok-string')
  })

  it('zig via in-tree simple-mode tokenizer', async () => {
    await ensureLegacyParsers()
    const src = [
      'const std = @import("std");',
      'pub fn main() !void {',
      '    const x: u32 = 0x2A; // hex',
      '}',
    ]
    const out = highlightLines(src, 'zig')
    expect(out).toHaveLength(4)
    expect(out[0]).toContain('tok-keyword')   // const
    expect(out[0]).toContain('tok-string')    // "std"
    expect(out[1]).toContain('tok-keyword')   // pub / fn
    expect(out[2]).toContain('tok-typeName')  // u32 → 'type' maps to tok-typeName
    expect(out[2]).toContain('tok-number')    // 0x2A
    expect(out[2]).toContain('tok-comment')   // // hex
  })

  it('zig recognizes @builtins and atoms', async () => {
    await ensureLegacyParsers()
    const out = highlightLines(['const x = @sizeOf(u8); const b = true;'], 'zig')
    // Legacy-mode token names are mapped by StreamLanguage's built-in table
    // to Lezer tags: 'builtin' → variableName, 'atom' → atom, 'type' → typeName.
    // A regression in the tokenizer (@ matched as operator, atoms as keyword)
    // would flip these classes, so pin them.
    expect(out[0]).toContain('>@sizeOf</span>')
    expect(out[0]).toMatch(/class="tok-variableName">@sizeOf/)
    expect(out[0]).toContain('tok-typeName">u8')
    expect(out[0]).toContain('tok-atom">true')
  })

  it('protobuf via StreamLanguage', async () => {
    await ensureLegacyParsers()
    const out = highlightLines(['message Foo { required string name = 1; }'], 'protobuf')
    expect(out[0]).toContain('tok-keyword') // message / required / string
    expect(out[0]).toContain('tok-number')  // 1
  })

  it('swift via StreamLanguage', async () => {
    await ensureLegacyParsers()
    const out = highlightLines(['let name: String = "foo"'], 'swift')
    expect(out[0]).toContain('tok-keyword') // let
    expect(out[0]).toContain('tok-string')  // "foo"
  })

  it('unknown language falls back to escaped plain text', () => {
    // The bash/toml-before-lazy-load case flows through the same path
    // (PARSERS[lang] undefined → escapeHtml), but testing it directly would
    // require test-order dependence (run before the awaits above).
    const out = highlightLines(['<script>'], 'unregistered')
    expect(out[0]).toBe('&lt;script&gt;')
  })

  it('typescript dialect recognizes type annotations', () => {
    const out = highlightLines(['const x: string = "hi"'], 'typescript')
    expect(out[0]).toContain('tok-typeName') // string
    expect(out[0]).toContain('tok-keyword')  // const
  })

  it('is synchronous — no await needed', () => {
    // The old Shiki-based highlightLines was async. This one has a sync body
    // (Lezer highlightCode returns void, no promises). Return type is
    // string[], not Promise<string[]> — a Promise check catches regression.
    const result = highlightLines(['x'], 'go')
    expect(result).not.toBeInstanceOf(Promise)
    expect(Array.isArray(result)).toBe(true)
  })
})
