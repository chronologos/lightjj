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
import { renderMarkdown, ensureMermaidLoaded, wirePanzoom } from './markdown-render'

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
