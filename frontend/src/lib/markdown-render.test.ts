import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock the heavy deps — beautiful-mermaid pulls elkjs (~300KB), and we're
// testing our integration glue not their renderers.
vi.mock('beautiful-mermaid', () => ({
  renderMermaidSVG: vi.fn((src: string) => {
    if (src.includes('INVALID')) throw new Error('parse fail')
    // Mirror the real parser's first-line-must-be-header constraint so the
    // %%{init} strip test has teeth.
    if (!/^(graph|flowchart|stateDiagram|sequenceDiagram|classDiagram|erDiagram)/.test(src.trimStart())) {
      throw new Error('Invalid mermaid header')
    }
    return `<svg data-src="${src.slice(0, 20)}"></svg>`
  }),
}))
import { renderMarkdown, renderMarkdownAnnotated, ensureMermaidLoaded, wirePanzoom, wireAnnotations, wireDiffGutter, stampedBlocks } from './markdown-render'

// Test wrappers — wire fns now take precomputed ranges (stampedBlocks runs
// once in MarkdownPreview's merged $effect).
const wireAnn = (div: HTMLElement, lines: string[], forLine: (n: number) => readonly Annotation[], onClick?: (n: number, c: string, e: MouseEvent) => void) =>
  wireAnnotations(div, stampedBlocks(div, lines.length), lines, forLine, onClick)
const wireGutter = (div: HTMLElement, total: number, added: Set<number>) =>
  wireDiffGutter(stampedBlocks(div, total), added)
import type { Annotation } from './api'

describe('renderMarkdown', () => {
  it('renders GFM basics', () => {
    const html = renderMarkdown('# Hi\n\n- [x] done\n- [ ] todo\n\n| a | b |\n|---|---|\n| 1 | 2 |')
    expect(html).toContain('<h1')
    expect(html).toContain('<table')
    expect(html).toContain('checked')
  })

  it('sanitizes script tags', () => {
    const html = renderMarkdown('hello <script>alert(1)</script> world')
    expect(html).not.toContain('<script')
    expect(html).toContain('hello')
  })

  it('sanitizes on* handlers', () => {
    const html = renderMarkdown('<img src=x onerror="alert(1)">')
    expect(html).not.toContain('onerror')
  })

  it.each([
    ['<style>', 'text <style>.edit-file-btn{display:none}</style> more', 'display:none'],
    ['<link>', '<link rel="stylesheet" href="https://evil.example/x.css"> text', 'evil.example'],
    ['<form>', '<form action="https://evil.example"><button>go</button></form>', 'action='],
  ])('strips %s (CSS/nav injection vector)', (_tag, src, forbidden) => {
    const html = renderMarkdown(src)
    expect(html).not.toContain(forbidden)
  })

  // Inline style attr NOT stripped — mermaid SVG may use it. The
  // position:fixed overlay attack is neutralized by `contain: layout` on
  // the .md-preview container (CSS, not sanitizer-level).

  describe('mermaid blocks', () => {
    beforeEach(() => ensureMermaidLoaded())

    it('renders mermaid fence as SVG after load', () => {
      const html = renderMarkdown('```mermaid\ngraph TD; A-->B\n```')
      expect(html).toContain('mermaid-block')
      expect(html).toContain('<svg')
    })

    it('falls back to <pre> on parse error', () => {
      const html = renderMarkdown('```mermaid\nINVALID SYNTAX\n```')
      expect(html).toContain('mermaid-fallback')
      expect(html).not.toContain('<svg')
    })

    it('strips %%{init} directive so diagram-type header reaches line 1', () => {
      const src = '```mermaid\n'
        + '%%{init: {"theme": "base", "themeVariables": {\n'
        + '  "primaryColor":"#F2F0E5"\n'
        + '}}}%%\n'
        + 'flowchart TD\n'
        + '  A --> B\n'
        + '```'
      const html = renderMarkdown(src)
      expect(html).toContain('<svg')
      expect(html).not.toContain('mermaid-fallback')
    })

    it('falls back to <pre> when over line limit', () => {
      const big = 'graph TD\n' + Array.from({ length: 201 }, (_, i) => `A${i}-->B${i}`).join('\n')
      const html = renderMarkdown('```mermaid\n' + big + '\n```')
      expect(html).toContain('mermaid-fallback')
    })

    it('SVG bypasses sanitize via placeholder (preserves internal <style>)', () => {
      const html = renderMarkdown('```mermaid\ngraph TD; A-->B\n```')
      expect(html).toContain('<svg')
      expect(html).toContain('mermaid-block')
      // The mock returns <svg data-src=...> — verify placeholder-replace worked
      expect(html).not.toContain('data-mermaid=')
    })

    it('markdown <style> still stripped even though mermaid bypasses sanitize', () => {
      const html = renderMarkdown('<style>body{display:none}</style>\n```mermaid\ngraph TD; A\n```')
      expect(html).not.toContain('<style>body')
      expect(html).toContain('<svg')  // mermaid survived, user <style> didn't
    })

    it('non-mermaid fences use default code block', () => {
      const html = renderMarkdown('```js\nconst x = 1\n```')
      expect(html).toContain('<pre><code')
      expect(html).not.toContain('mermaid')
    })
  })

  describe('image src rewriting', () => {
    const ctx = { revision: 'abc123', baseDir: 'docs' }

    it('rewrites relative src through /api/file-raw', () => {
      const html = renderMarkdown('![logo](img/logo.png)', ctx)
      expect(html).toContain('/api/file-raw?')
      expect(html).toContain('path=docs%2Fimg%2Flogo.png')
    })

    it('leaves http(s) and data:image/ unchanged', () => {
      for (const src of ['https://example.com/x.png', 'data:image/png;base64,AAA']) {
        const html = renderMarkdown(`![x](${src})`, ctx)
        expect(html).not.toContain('/api/file-raw')
      }
    })

    it('escapes quotes in alt — attribute breakout defense', () => {
      const html = renderMarkdown('![x" onerror="alert(1)](foo.png)', ctx)
      // Breakout = unescaped " closes alt then opens new attr. Escaped quote
      // means `onerror=...` stays as literal TEXT inside alt="...".
      expect(html).not.toMatch(/"\s*onerror\s*=/)
      expect(html).toContain('&quot;')
    })

    it('caps at MAX_PROXIED_IMAGES', () => {
      const md = Array.from({ length: 60 }, (_, i) => `![${i}](img${i}.png)`).join('\n')
      const html = renderMarkdown(md, ctx)
      const matches = html.match(/\/api\/file-raw/g) ?? []
      expect(matches.length).toBe(50)
    })

    it('no rewriting without ctx', () => {
      const html = renderMarkdown('![x](foo.png)')
      expect(html).not.toContain('/api/file-raw')
      expect(html).toContain('src="foo.png"')
    })

    it('root-relative paths skip baseDir', () => {
      const html = renderMarkdown('![x](/images/logo.png)', ctx)
      expect(html).toContain('path=images%2Flogo.png')
      expect(html).not.toContain('docs')  // baseDir not prepended
    })

    it('strips fragment and query from path', () => {
      const html = renderMarkdown('![x](flow.svg#layer1) ![y](logo.png?v=2)', ctx)
      expect(html).toContain('path=docs%2Fflow.svg')
      expect(html).toContain('path=docs%2Flogo.png')
      expect(html).not.toContain('%23')  // no encoded #
      expect(html).not.toContain('v%3D2')  // no encoded ?v=2
    })

    it('decodes percent-encoded paths (avoids double-encoding)', () => {
      const html = renderMarkdown('![x](my%20image.png)', ctx)
      // %20 decoded → space → URLSearchParams encodes as + → server gets space
      expect(html).toContain('path=docs%2Fmy+image.png')
      expect(html).not.toContain('%2520')  // NOT double-encoded
    })
  })
})

describe('heading anchors', () => {
  it('slugifies and emits id', () => {
    const html = renderMarkdown('## Foo Bar Baz')
    expect(html).toContain('<h2 id="foo-bar-baz">')
  })

  it('deduplicates with -N suffix', () => {
    const html = renderMarkdown('## Same\n\n## Same\n\n## Same')
    expect(html).toContain('id="same"')
    expect(html).toContain('id="same-1"')
    expect(html).toContain('id="same-2"')
  })

  it('strips punctuation but keeps word chars + hyphens', () => {
    const html = renderMarkdown('## P3 — Advanced!')
    expect(html).toContain('id="p3--advanced"')  // em-dash → '', spaces → -
  })

  it('makes [text](#slug) fragment links work', () => {
    const html = renderMarkdown('See [§](#target).\n\n## Target')
    expect(html).toContain('id="target"')
    expect(html).toContain('href="#target"')
  })

  it('skips id when slug would be empty', () => {
    expect(renderMarkdown('## !!!!')).toMatch(/<h2>/)  // no id attr
  })

  it('survives DOMPurify SANITIZE_DOM for common-word slugs', () => {
    // Default SANITIZE_DOM strips id="content"/"title"/"body" (DOM clobbering
    // guard). Disabled — see SANITIZE_CFG comment. Locks the trade-off.
    for (const word of ['Content', 'Title', 'Body', 'Target', 'Data']) {
      expect(renderMarkdown(`## ${word}`)).toContain(`id="${word.toLowerCase()}"`)
    }
  })

  it('per-render dedup reset', () => {
    expect(renderMarkdown('## X')).toContain('id="x"')
    expect(renderMarkdown('## X')).toContain('id="x"')  // not x-1
  })

  it('annotated mode keeps both id and data-src-line', () => {
    expect(renderMarkdownAnnotated('## Hi')).toMatch(/<h2 id="hi" data-src-line="1">/)
  })
})

describe('code fence highlighting', () => {
  it('emits tok-* spans for known langs', () => {
    const html = renderMarkdown('```js\nconst x = 1\n```')
    expect(html).toContain('tok-')  // some class — exact tokens are lezer's concern
    expect(html).toContain('const')
  })

  it('falls through to escaped plain for unknown lang', () => {
    const html = renderMarkdown('```unknownlang\n<div>hi</div>\n```')
    expect(html).not.toContain('tok-')
    expect(html).toContain('&lt;div&gt;')  // escaped
  })

  it('no-lang fence escapes', () => {
    const html = renderMarkdown('```\n<script>x</script>\n```')
    expect(html).toContain('&lt;script&gt;')
  })

  it('extracts lang from ```ts:filename and ```js {1-3}', () => {
    for (const fence of ['ts:file.ts', 'js {1-3}']) {
      expect(renderMarkdown(`\`\`\`${fence}\nconst x=1\n\`\`\``)).toContain('tok-')
    }
  })

  it('maps fence aliases (py → python)', () => {
    expect(renderMarkdown('```py\ndef f(): pass\n```')).toContain('tok-')
  })
})

describe('alerts', () => {
  it.each(['NOTE', 'TIP', 'IMPORTANT', 'WARNING', 'CAUTION'])('renders > [!%s]', (kind) => {
    const html = renderMarkdown(`> [!${kind}]\n> Body text.`)
    expect(html).toContain(`md-alert-${kind.toLowerCase()}`)
    expect(html).toContain('md-alert-title')
    expect(html).toContain('Body text.')
    expect(html).not.toContain(`[!${kind}]`)  // marker stripped
  })

  it('marker on own paragraph (blank line before body)', () => {
    const html = renderMarkdown('> [!WARNING]\n>\n> Separate paragraph.')
    expect(html).toContain('md-alert-warning')
    expect(html).toContain('Separate paragraph.')
    expect(html).not.toMatch(/<p[^>]*>\s*<\/p>/)  // no empty <p> left behind
  })

  it('case-insensitive kind', () => {
    expect(renderMarkdown('> [!note]\n> hi')).toContain('md-alert-note')
  })

  it('unknown kind falls through to plain blockquote', () => {
    const html = renderMarkdown('> [!CUSTOM]\n> hi')
    expect(html).not.toContain('md-alert')
    expect(html).toContain('[!CUSTOM]')  // not stripped
  })

  it('marker not on first line → plain blockquote', () => {
    const html = renderMarkdown('> first line\n> [!NOTE]\n> rest')
    expect(html).not.toContain('md-alert')
  })

  it('detects with up to 3 leading spaces (CommonMark indent allowance)', () => {
    for (const indent of ['', ' ', '  ', '   ']) {
      const html = renderMarkdown(`${indent}> [!NOTE]\n${indent}> body`)
      expect(html, `${indent.length} spaces`).toContain('md-alert-note')
    }
    // 4 spaces = code block, not blockquote
    expect(renderMarkdown('    > [!NOTE]\n    > body')).not.toContain('md-alert')
  })

  it('detects nested blockquote alert (outer > stripped before inner tokenizes)', () => {
    const html = renderMarkdown('> > [!WARNING]\n> > nested body')
    expect(html).toContain('md-alert-warning')
    expect(html).toContain('nested body')
  })

  it('plain blockquote unchanged', () => {
    const html = renderMarkdown('> just a quote')
    expect(html).toContain('<blockquote')
    expect(html).not.toContain('md-alert')
  })

  it('annotated mode stamps the alert div', () => {
    const html = renderMarkdownAnnotated('# h\n\n> [!TIP]\n> tip body')
    expect(html).toMatch(/md-alert-tip[^>]*data-src-line="3"/)
  })
})

describe('footnotes', () => {
  it('renders ref + def with anchor links', () => {
    const html = renderMarkdown('Text[^1].\n\n[^1]: The note.')
    expect(html).toContain('<sup class="fn-ref">')
    expect(html).toContain('>1</a></sup>')
    expect(html).toContain('<section class="footnotes">')
    expect(html).toContain('The note.')
    // Ref → def anchor + def → ref back-link cross-reference
    const refId = html.match(/id="(fnref\d+-0)"/)?.[1]
    const fnId = html.match(/id="(fn\d+-0)"/)?.[1]
    expect(html).toContain(`href="#${fnId}"`)
    expect(html).toContain(`href="#${refId}"`)
  })

  it('numbers by first-ref encounter, not def order', () => {
    const html = renderMarkdown('A[^b] then[^a].\n\n[^a]: alpha\n\n[^b]: beta')
    const ol = html.match(/<ol>.*<\/ol>/s)?.[0]
    // [^b] seen first → footnote 1 = beta
    expect(ol).toMatch(/<li[^>]*>beta.*<li[^>]*>alpha/s)
  })

  it('multiple refs to same label share number, only first gets back-link id', () => {
    const html = renderMarkdown('First[^x] and again[^x].\n\n[^x]: shared')
    expect((html.match(/>1<\/a><\/sup>/g) ?? []).length).toBe(2)
    expect((html.match(/id="fnref\d+-0"/g) ?? []).length).toBe(1)
  })

  it('def appearing before its ref renders (not dropped)', () => {
    // Def at top renders FIRST — def renderer must create the entry too,
    // not just the ref renderer. (bughunt-lite 3-2 finding.)
    const html = renderMarkdown('[^1]: defined first\n\nText with[^1] ref.')
    expect(html).toContain('defined first')
    expect(html).not.toContain('(missing)')
    expect(html).toContain('>1</a></sup>')
  })

  it('ref with no def shows (missing)', () => {
    expect(renderMarkdown('Text[^undefined].')).toContain('<em>(missing)</em>')
  })

  it('unreferenced def renders (numbered by document encounter)', () => {
    // Trade-off vs GitHub (which drops unreferenced defs): rendering surfaces
    // dead defs to the reviewer. Side effect of def-before-ref fix.
    const html = renderMarkdown('[^orphan]: dead def\n\nNo refs here.')
    expect(html).toContain('dead def')
  })

  it('indented continuation lines join into body', () => {
    const html = renderMarkdown('Ref[^1].\n\n[^1]: Line one\n    line two\n    line three.')
    expect(html).toContain('Line one line two line three.')
  })

  it('does not steal [^text](url) from link tokenizer', () => {
    const html = renderMarkdown('See [^this](https://example.com).')
    expect(html).toContain('<a href="https://example.com"')
    expect(html).not.toContain('fn-ref')
  })

  it('inline markdown in def body works', () => {
    const html = renderMarkdown('Ref[^1].\n\n[^1]: With **bold** and `code`.')
    expect(html).toContain('<strong>bold</strong>')
    expect(html).toContain('<code>code</code>')
  })

  it('per-render scope isolates anchor ids across calls', () => {
    const a = renderMarkdown('A[^1].\n\n[^1]: a')
    const b = renderMarkdown('B[^1].\n\n[^1]: b')
    const aId = a.match(/id="(fn\d+-0)"/)?.[1]
    const bId = b.match(/id="(fn\d+-0)"/)?.[1]
    expect(aId).not.toBe(bId)
  })

  it('def body sanitized', () => {
    const html = renderMarkdown('Ref[^1].\n\n[^1]: <script>alert(1)</script>hi')
    expect(html).not.toContain('<script')
    expect(html).toContain('hi')
  })

  it('no section when no footnotes', () => {
    expect(renderMarkdown('# plain doc')).not.toContain('footnotes')
  })

  it('annotated mode stamps def with source line', () => {
    const html = renderMarkdownAnnotated('Text[^1].\n\n[^1]: defined here')
    // Def is on line 3
    expect(html).toMatch(/<li id="fn\d+-0" data-src-line="3">/)
  })
})

describe('renderMarkdownAnnotated', () => {
  // Multi-block fixture — heading, paragraph spanning 2 lines, nested list,
  // code fence, blockquote. Line numbers are the contract with reanchor().
  const DOC = [
    /* 1 */ '# Title',
    /* 2 */ '',
    /* 3 */ 'First para',
    /* 4 */ 'continues here.',
    /* 5 */ '',
    /* 6 */ '- apple',
    /* 7 */ '- apple',   // duplicate — tests monotone-cursor disambiguation
    /* 8 */ '',
    /* 9 */ '```js',
    /* 10 */ 'const x = 1',
    /* 11 */ '```',
    /* 12 */ '',
    /* 13 */ '> quoted',
  ].join('\n')

  const srcLines = (html: string) => {
    const doc = new DOMParser().parseFromString(html, 'text/html')
    return [...doc.querySelectorAll('[data-src-line]')].map(el => ({
      tag: el.tagName.toLowerCase(),
      line: +el.getAttribute('data-src-line')!,
    }))
  }

  it('stamps block elements with 1-indexed source lines', () => {
    const stamped = srcLines(renderMarkdownAnnotated(DOC))
    expect(stamped).toContainEqual({ tag: 'h1', line: 1 })
    expect(stamped).toContainEqual({ tag: 'p', line: 3 })
    expect(stamped).toContainEqual({ tag: 'pre', line: 9 })
    expect(stamped).toContainEqual({ tag: 'blockquote', line: 13 })
  })


  it('code fence containing markdown does not steal later block stamps', () => {
    // Before the CONTAINER-aware skip, indexOf('# Real', cursor=1) found the
    // copy inside the fence (line 2) instead of the real heading (line 5).
    const src = ['\`\`\`', '# Real', '\`\`\`', '', '# Real'].join('\n')
    const div = document.createElement('div')
    div.innerHTML = renderMarkdownAnnotated(src)
    const h1 = div.querySelector('h1')!
    expect(h1.dataset.srcLine).toBe('5')
  })

  it('duplicate source slices resolve to distinct lines (monotone cursor)', () => {
    const lis = srcLines(renderMarkdownAnnotated(DOC)).filter(s => s.tag === 'li')
    expect(lis.map(l => l.line)).toEqual([6, 7])
  })

  it('plain renderMarkdown leaves zero stamps (no-cost fallthrough)', () => {
    expect(srcLines(renderMarkdown(DOC))).toEqual([])
  })

  it('DOMPurify preserves data-src-line', () => {
    // data-* is in the default allowlist; this test locks that assumption.
    const html = renderMarkdownAnnotated('# hi')
    expect(html).toContain('data-src-line="1"')
  })

  it('mermaid block carries data-src-line to .mermaid-block (no double-wrap)', async () => {
    await ensureMermaidLoaded()
    const html = renderMarkdownAnnotated('# Title\n\n```mermaid\ngraph TD; A-->B\n```')
    // Stamped on the mermaid-block div itself — no extra wrapper.
    expect(html).toMatch(/<div class="mermaid-block" data-src-line="3">/)
    expect(html).not.toMatch(/<div data-src-line="\d+"><div class="mermaid-block">/)
  })

  it('tables get data-src-line (per-table — TableCell has no raw)', () => {
    const html = renderMarkdownAnnotated('# Title\n\n| a | b |\n|---|---|\n| 1 | 2 |')
    expect(html).toMatch(/<table data-src-line="3">/)
    // Default renderer's align/header structure preserved
    expect(html).toContain('<thead>')
    expect(html).toContain('<tbody>')
  })

  it('task-list items keep checkbox', () => {
    const html = renderMarkdownAnnotated('- [x] done\n- [ ] todo')
    expect(html).toContain('checked')
    expect(html).toMatch(/<li data-src-line="1">.*checkbox/)
    expect(html).toMatch(/<li data-src-line="2">.*checkbox/)
  })
})

// Shared by wireAnnotations + wireDiffGutter — both walk the same stamped DOM.
const renderAnnotated = (src: string) => {
  const div = document.createElement('div')
  div.innerHTML = renderMarkdownAnnotated(src)
  return div
}


describe('stampedBlocks — footnote order', () => {
  it('handles footnotes (srcLine out of doc-order — appended at HTML end)', () => {
    // [^a] referenced line 1; def at line 3; trailing para line 5.
    // Footnote <li data-src-line="3"> is appended AFTER the line-5 <p> in
    // the HTML — distinct[] must be sorted or nextOf={5→3} (range collapses).
    const src = ['Ref[^a]', '', '[^a]: note', '', 'Tail'].join('\n')
    const div = document.createElement('div')
    div.innerHTML = renderMarkdownAnnotated(src)
    const ranges = stampedBlocks(div, 5)
    const tail = ranges.find(r => r.el.textContent === 'Tail')!
    expect(tail.start).toBe(5)
    expect(tail.end).toBe(6) // totalLines+1, NOT 3
    const fn = ranges.find(r => r.start === 3)!
    expect(fn.end).toBe(5) // next distinct line, NOT totalLines+1
  })
})

describe('wireAnnotations', () => {
  const mkAnn = (lineNum: number, comment = 'note'): Annotation => ({
    id: 'a', changeId: 'c', filePath: 'doc.md',
    lineNum, lineContent: `line ${lineNum}`, comment,
    severity: 'suggestion', createdAt: 0, createdAtCommitId: 'x', status: 'open',
  })

  it('injects badge on block covering annotation line', () => {
    // heading@1, para@3 → ann at line 4 falls in para's [3, ∞) range
    const div = renderAnnotated('# Title\n\nPara text\ncontinues')
    const ann = mkAnn(4)
    wireAnn(div, ['# Title', '', 'Para text', 'continues'], n => n === 4 ? [ann] : [], undefined)

    expect(div.querySelector('h1 .annotation-badge')).toBeNull()
    const badge = div.querySelector('p .annotation-badge') as HTMLElement
    expect(badge).toBeTruthy()
    expect(badge.title).toBe('1 annotation: note')
  })

  it('nested block claims sub-range (li > inner p does not double-badge)', () => {
    // Loose list: li@1 contains p@1. Both claim line 1 initially, but
    // sorted-next-line gives li range [1,1) = empty, p range [1,end).
    // Only the innermost p gets the badge.
    const div = renderAnnotated('- item one\n\n- item two')
    wireAnn(div, ['- item one', '', '- item two'], n => n === 1 ? [mkAnn(1)] : [], undefined)
    const badges = div.querySelectorAll('.annotation-badge')
    expect(badges.length).toBe(1)
  })

  it('Alt+click emits innermost block start line + source content', () => {
    const div = renderAnnotated('# Title\n\nPara')
    const srcLines = ['# Title', '', 'Para']
    const calls: [number, string][] = []
    wireAnn(div, srcLines, () => [], (n, c) => { calls.push([n, c]) })

    const p = div.querySelector('p')!
    p.dispatchEvent(new MouseEvent('click', { altKey: true, bubbles: true }))
    expect(calls).toEqual([[3, 'Para']])
  })

  it('non-Alt click is ignored', () => {
    const div = renderAnnotated('# Title')
    let fired = false
    wireAnn(div, ['# Title'], () => [], () => { fired = true })
    div.querySelector('h1')!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    expect(fired).toBe(false)
  })

  it('cleanup removes badges + listener', () => {
    const div = renderAnnotated('# Title')
    const ann = mkAnn(1)
    const cleanup = wireAnn(div, ['# Title'], () => [ann], () => {})
    expect(div.querySelector('.annotation-badge')).toBeTruthy()
    expect(div.querySelector('.md-ann-host')).toBeTruthy()
    cleanup()
    expect(div.querySelector('.annotation-badge')).toBeNull()
    expect(div.querySelector('.md-ann-host')).toBeNull()
  })
})

describe('wireDiffGutter', () => {
  it('marks block whose [start,end) range contains an added line', () => {
    // h1@1, p@3 → p claims [3,∞). Line 4 added → p marked, h1 not.
    const div = renderAnnotated('# Title\n\nPara text\ncontinues')
    wireGutter(div, 4, new Set([4]))
    expect(div.querySelector('h1.md-diff-added')).toBeNull()
    expect(div.querySelector('p.md-diff-added')).toBeTruthy()
  })

  it('marks the start line itself (range is [start,end) inclusive of start)', () => {
    const div = renderAnnotated('# Title\n\nPara')
    wireGutter(div, 3, new Set([3]))
    expect(div.querySelector('p.md-diff-added')).toBeTruthy()
  })

  it('skips blocks with no added lines in range', () => {
    const div = renderAnnotated('# Title\n\nPara')
    wireGutter(div, 3, new Set([99]))
    expect(div.querySelectorAll('.md-diff-added').length).toBe(0)
  })

  it('marks multiple blocks independently', () => {
    const div = renderAnnotated('# Edited heading\n\nUnchanged para\n\nEdited para')
    wireGutter(div, 5, new Set([1, 5]))
    expect(div.querySelector('h1.md-diff-added')).toBeTruthy()
    expect(div.querySelectorAll('p.md-diff-added').length).toBe(1)
    expect(div.querySelector('p.md-diff-added')!.textContent).toBe('Edited para')
  })

  it('nested loose-list: inner block claims range (same dedup as wireAnnotations)', () => {
    // li@1 contains p@1 — outer skipped via the same querySelector check.
    const div = renderAnnotated('- item one\n\n- item two')
    wireGutter(div, 3, new Set([1]))
    const marks = div.querySelectorAll('.md-diff-added')
    expect(marks.length).toBe(1)
    expect(marks[0].tagName).toBe('P')
  })

  it('cleanup removes marks', () => {
    const div = renderAnnotated('# Title')
    const cleanup = wireGutter(div, 1, new Set([1]))
    expect(div.querySelectorAll('.md-diff-added').length).toBe(1)
    cleanup()
    expect(div.querySelectorAll('.md-diff-added').length).toBe(0)
  })

  it('coexists with wireAnnotations on the same block', () => {
    const div = renderAnnotated('# Title')
    const ann = { id: 'a', changeId: 'c', filePath: 'f.md', lineNum: 1, lineContent: '# Title', comment: 'hi', severity: 'suggestion' as const, createdAt: 0, createdAtCommitId: 'x', status: 'open' as const }
    wireAnn(div, ['# Title'], () => [ann], undefined)
    wireGutter(div, 1, new Set([1]))
    const h1 = div.querySelector('h1')!
    expect(h1.classList.contains('md-ann-host')).toBe(true)
    expect(h1.classList.contains('md-diff-added')).toBe(true)
    expect(h1.querySelector('.annotation-badge')).toBeTruthy()
  })
})

describe('wirePanzoom', () => {
  const mkContainer = (n = 1) => {
    const div = document.createElement('div')
    div.innerHTML = '<div class="mermaid-block"><svg></svg></div>'.repeat(n)
    // jsdom lacks setPointerCapture; stub on the canvas elements
    for (const block of div.querySelectorAll('.mermaid-block')) {
      ;(block as any).setPointerCapture = vi.fn()
      ;(block as any).releasePointerCapture = vi.fn()
    }
    return div
  }

  it('no-ops on container without mermaid blocks', () => {
    const div = document.createElement('div')
    div.innerHTML = '<p>no diagrams</p>'
    const cleanup = wirePanzoom(div)
    expect(() => cleanup()).not.toThrow()
  })

  it('drag translates the svg', () => {
    const div = mkContainer()
    wirePanzoom(div)
    const block = div.querySelector('.mermaid-block')!
    const svg = div.querySelector('svg')!
    block.dispatchEvent(new PointerEvent('pointerdown', { button: 0, clientX: 10, clientY: 10, pointerId: 1 }))
    block.dispatchEvent(new PointerEvent('pointermove', { clientX: 30, clientY: 25, pointerId: 1 }))
    expect(svg.style.transform).toBe('translate(20px,15px) scale(1)')
    block.dispatchEvent(new PointerEvent('pointerup', { pointerId: 1 }))
    block.dispatchEvent(new PointerEvent('pointermove', { clientX: 100, clientY: 100, pointerId: 1 }))
    expect(svg.style.transform).toBe('translate(20px,15px) scale(1)')  // released → ignored
  })

  it('dblclick resets transform', () => {
    const div = mkContainer()
    wirePanzoom(div)
    const block = div.querySelector('.mermaid-block')!
    const svg = div.querySelector('svg')!
    block.dispatchEvent(new PointerEvent('pointerdown', { button: 0, clientX: 0, clientY: 0, pointerId: 1 }))
    block.dispatchEvent(new PointerEvent('pointermove', { clientX: 50, clientY: 50, pointerId: 1 }))
    block.dispatchEvent(new MouseEvent('dblclick'))
    expect(svg.style.transform).toBe('translate(0px,0px) scale(1)')
  })

  it('cleanup removes listeners', () => {
    const div = mkContainer()
    const cleanup = wirePanzoom(div)
    const block = div.querySelector('.mermaid-block')!
    const svg = div.querySelector('svg')!
    cleanup()
    block.dispatchEvent(new PointerEvent('pointerdown', { button: 0, clientX: 0, clientY: 0, pointerId: 1 }))
    block.dispatchEvent(new PointerEvent('pointermove', { clientX: 50, clientY: 50, pointerId: 1 }))
    expect(svg.style.transform).toBe('')  // untouched after cleanup
  })
})
