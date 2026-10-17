import { describe, it, expect, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { javascript } from '@codemirror/lang-javascript'
import { detectIndent, getCmLanguage, cmHighlight, cmTheme } from './cm-shared'
import { THEMES } from './themes'

describe('detectIndent', () => {
  it('empty file → default (2-space)', () => {
    expect(detectIndent('')).toEqual({ usesTabs: false, width: 2 })
  })

  it('no indented lines → default', () => {
    // Lines starting with neither ' ' nor '\t' are skipped.
    expect(detectIndent('function f() {\nreturn 1\n}')).toEqual({ usesTabs: false, width: 2 })
  })

  it('detects tabs (width is the default — no space lines to infer from)', () => {
    // width:2 here is the HARD-CODED FALLBACK, not a computed value. Tab-
    // indented lines skip width inference entirely (they go into the tabLines
    // counter, not widthCounts). Only asserting usesTabs is meaningful.
    const src = 'func main() {\n\tfmt.Println()\n\treturn\n}'
    expect(detectIndent(src).usesTabs).toBe(true)
  })

  it('detects 4-space indent', () => {
    const src = 'def f():\n    return 1\n    pass\n'
    expect(detectIndent(src)).toEqual({ usesTabs: false, width: 4 })
  })

  it('detects 2-space indent', () => {
    const src = 'if (x) {\n  a()\n  b()\n}'
    expect(detectIndent(src)).toEqual({ usesTabs: false, width: 2 })
  })

  it('prefers majority style (tabs vs spaces)', () => {
    // 3 tab lines, 1 space line → tabs win.
    const src = '\ta\n\tb\n\tc\n  d\n'
    expect(detectIndent(src).usesTabs).toBe(true)
  })

  it('width tiebreak prefers smaller (2 over 4 over 8)', () => {
    // Equal counts of 2-space and 4-space → smaller wins.
    // This is the "sorted ascending + strictly-greater check" behavior:
    // 2 is visited first, sets bestCount=N; 4 at N does not beat it.
    const src = '  a\n  b\n    c\n    d\n'
    expect(detectIndent(src)).toEqual({ usesTabs: false, width: 2 })
  })

  it('ignores indent widths > 8 (likely alignment, not indentation)', () => {
    // 12-space continuation (wrapped arg lists etc.) shouldn't count as
    // a width candidate. Only the 4-space lines are considered.
    const src = '    foo(\n            aligned_arg,\n    )\n    bar()\n'
    expect(detectIndent(src)).toEqual({ usesTabs: false, width: 4 })
  })

  it('scans at most SAMPLE=200 indented lines', () => {
    // 200 lines of 4-space, then 1000 lines of 2-space.
    // If the SAMPLE cap works, 4-space wins (it saturated the sample).
    // Without the cap, 2-space would win by majority.
    const head = '    x\n'.repeat(200)
    const tail = '  y\n'.repeat(1000)
    expect(detectIndent(head + tail)).toEqual({ usesTabs: false, width: 4 })
  })
})

// getCmLanguage routes through detectLanguage() (languages.ts) to map file
// extensions to CM6 LanguageSupport. Wrong mapping → plain-text editing in
// FileEditor/MergePanel (silent degradation, no error). The detectLanguage
// mapping IS the real test surface — asserting `instanceof LanguageSupport`
// would be tautological. Instead assert the routing is non-null where a
// language is expected, null where it isn't.
describe('getCmLanguage', () => {
  it.each([
    // Rich support (full @codemirror/lang-* with indent/fold/autocomplete)
    ['foo.ts', 'typescript'],
    ['foo.tsx', 'typescript'],
    ['foo.js', 'javascript'],
    ['foo.jsx', 'javascript'],
    ['foo.py', 'python'],
    ['foo.go', 'go'],
    ['foo.rs', 'rust'],
    // Registry fallback — eager Lezer parsers wrapped in bare LRLanguage
    ['foo.css', 'css'],
    ['foo.html', 'html'],
    ['foo.svelte', 'svelte'],
    ['foo.json', 'json'],
    ['foo.yaml', 'yaml'],
    // Registry fallback — legacy modes lazy-loaded then wrapped in StreamLanguage
    ['foo.sh', 'bash'],
    ['foo.toml', 'toml'],
    ['foo.swift', 'swift'],
  ])('%s → non-null (%s)', async (path) => {
    expect(await getCmLanguage(path)).not.toBeNull()
  })

  it.each([
    ['foo.txt'],
    ['foo.md'],
    ['foo'],        // no extension
    ['Makefile'],
  ])('%s → null (plain text)', async (path) => {
    expect(await getCmLanguage(path)).toBeNull()
  })
})

// Issue #40: editors used defaultHighlightStyle (light-only inline colors), so
// syntax stayed navy/maroon on every dark theme. The contract now: CM tokens
// carry the same tok-* classes as diff HTML, and theme.css colors them via
// --syn-* vars — a theme switch is a pure CSS swap on a live editor.
describe('editor syntax highlighting is theme-driven (tok-* classes)', () => {
  let view: EditorView | undefined
  afterEach(() => { view?.destroy(); view = undefined; delete document.documentElement.dataset.theme })

  function mount(doc: string) {
    const parent = document.createElement('div')
    document.body.appendChild(parent)
    view = new EditorView({
      state: EditorState.create({ doc, extensions: [javascript({ typescript: true }), cmHighlight, cmTheme] }),
      parent,
    })
    return view
  }
  const tokenClasses = (v: EditorView) =>
    [...v.contentDOM.querySelectorAll('.cm-line span')].map(s => [s.textContent, s.className] as const)

  it('emits tok-* classes, never generated (ͼ) highlight-style classes', () => {
    const v = mount("const key = 'x' // note")
    const toks = tokenClasses(v)
    expect(toks).toContainEqual(['const', 'tok-keyword'])
    expect(toks).toContainEqual(["'x'", 'tok-string'])
    expect(toks.find(([t]) => t === '// note')?.[1]).toBe('tok-comment')
    // Every token span class is a tok-* class — a HighlightStyle (light or
    // dark) would emit StyleModule-generated ͼ classes with baked-in colors.
    for (const [, cls] of toks) expect(cls).toMatch(/^(tok-[\w]+\s?)+$/)
  })

  it('a live theme switch leaves the editor DOM untouched (pure CSS swap)', () => {
    const v = mount("const key = 'x'")
    const before = v.contentDOM.innerHTML
    for (const t of THEMES) {
      document.documentElement.dataset.theme = t.id
      expect(v.contentDOM.innerHTML).toBe(before)
    }
  })

  it('every builtin theme defines every --syn-* var the tok-* rules use', () => {
    // A theme missing a var would fall back to inherited --text (or nothing),
    // silently un-highlighting that token class in both diffs and editors.
    const css = readFileSync('src/theme.css', 'utf8')
    const used = new Set([...css.matchAll(/\.tok-[^{]+\{[^}]*var\((--syn-[\w-]+)\)/g)].map(m => m[1]))
    expect(used.size).toBeGreaterThanOrEqual(9)
    for (const t of THEMES) {
      const sel = t.id === 'dark' ? ':root, :root[data-theme="dark"]' : `:root[data-theme="${t.id}"]`
      const start = css.indexOf(sel + ' {')
      expect(start, `no block for ${t.id}`).toBeGreaterThanOrEqual(0)
      const block = css.slice(start, css.indexOf('}', start))
      for (const v of used) expect(block, `${t.id} missing ${v}`).toContain(`${v}:`)
    }
  })
})
