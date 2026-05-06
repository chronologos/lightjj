import { describe, it, expect } from 'vitest'
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { DOMSerializer } from 'prosemirror-model'
import { parseMarkdown, serializeMarkdown, docSchema } from './pm-schema'

const rt = (md: string) => serializeMarkdown(parseMarkdown(md))

function renderToDOM(md: string): DocumentFragment {
  const doc = parseMarkdown(md)
  return DOMSerializer.fromSchema(docSchema).serializeFragment(doc.content)
}

describe('pm-schema XSS guards', () => {
  it.each([
    ['javascript:alert(1)', '#'],
    ['JAVASCRIPT:alert(1)', '#'],
    ['vbscript:msgbox(1)', '#'],
    ['data:text/html,<script>alert(1)</script>', '#'],
    ['https://example.com', 'https://example.com'],
    ['http://example.com', 'http://example.com'],
    ['mailto:a@b.co', 'mailto:a@b.co'],
    ['#anchor', '#anchor'],
    ['./relative.md', './relative.md'],
    ['/abs/path', '/abs/path'],
  ])('link scheme gate: %s → %s', (href, expected) => {
    const frag = renderToDOM(`[x](${href})`)
    const a = frag.querySelector('a')!
    expect(a.getAttribute('href')).toBe(expected)
    expect(a.getAttribute('rel')).toBe('noopener noreferrer nofollow')
  })

  it('unsafe href survives serialize round-trip (only DOM is neutered)', () => {
    const md = '[x](javascript:alert(1))\n'
    expect(rt(md)).toBe(md)
  })

  it('passthrough renders raw as TEXT not HTML', () => {
    const frag = renderToDOM('<script>alert(1)</script>')
    expect(frag.querySelector('script')).toBeNull()
    expect(frag.querySelector('.pm-passthrough')?.textContent).toContain('<script>')
  })
})

describe('pm-schema unit', () => {
  it('heading + paragraph + marks', () => {
    const md = '# Title\n\npara **bold** and *em* and `code` and [link](url)\n'
    expect(rt(md)).toBe(md)
  })

  it('nested bullet list', () => {
    const md = '- a\n  - nested\n- b\n'
    expect(rt(md)).toBe(md)
  })

  it('ordered list preserves start', () => {
    const md = '3. third\n4. fourth\n'
    expect(rt(md)).toBe(md)
  })

  it('fenced code block with lang', () => {
    const md = '```js\nconst s = `x`\n```\n'
    expect(rt(md)).toBe(md)
  })

  it('code fence grows when content has line-start backticks', () => {
    const md = '````\n```\nnested fence\n```\n````\n'
    expect(rt(md)).toBe(md)
  })

  it('task list', () => {
    const md = '- [ ] todo\n- [x] done\n'
    expect(rt(md)).toBe(md)
  })

  it('blockquote', () => {
    const md = '> quoted **text**\n> \n> second para\n'
    expect(rt(md)).toBe(md)
  })

  it('link with title', () => {
    const md = '[text](http://x "Title")\n'
    expect(rt(md)).toBe(md)
  })

  it('hr', () => {
    expect(rt('---\n')).toBe('---\n')
  })

  it('hard break', () => {
    expect(rt('a\\\nb\n')).toBe('a\\\nb\n')
  })

  it('table → passthrough round-trips raw', () => {
    const md = '| a | b |\n|---|---|\n| 1 | 2 |\n'
    expect(rt(md)).toBe(md)
  })

  it('idempotent: rt(rt(x)) === rt(x)', () => {
    const samples = [
      '# H\n\n- a\n- b\n',
      '```\ncode\n```\n',
      '> a\n',
      'plain *em* text\n',
    ]
    for (const s of samples) {
      const once = rt(s)
      expect(rt(once)).toBe(once)
    }
  })

  it('parses to a valid PM doc (schema check)', () => {
    const doc = parseMarkdown('# H\n\n- a\n  - b\n\n```js\nx\n```\n')
    expect(() => doc.check()).not.toThrow()
    expect(doc.type).toBe(docSchema.nodes.doc)
  })
})

describe('pm-schema round-trip on real docs', () => {
  const root = join(__dirname, '../../..')
  const docs = [
    'README.md',
    'BACKLOG.md',
    'docs/ARCHITECTURE.md',
    'docs/CONFIG.md',
    'docs/ANNOTATIONS.md',
  ].filter((p) => existsSync(join(root, p)))

  function lineDiff(a: string, b: string) {
    const al = a.split('\n')
    const bl = b.split('\n')
    let same = 0
    const max = Math.max(al.length, bl.length)
    for (let i = 0; i < max; i++) if (al[i] === bl[i]) same++
    return { total: max, same, diff: max - same }
  }

  for (const path of docs) {
    it(`${path}`, () => {
      const src = readFileSync(join(root, path), 'utf8')
      const once = rt(src)
      const twice = rt(once)
      const d = lineDiff(src, once)
      // Report-only: log stats; assert idempotence + non-empty
      // eslint-disable-next-line no-console
      console.log(
        `[round-trip] ${path}: ${d.total} lines, ${d.diff} differ ` +
          `(${((100 * d.diff) / d.total).toFixed(1)}%), idempotent=${once === twice}`
      )
      expect(once.length).toBeGreaterThan(0)
      expect(twice).toBe(once) // idempotence is the hard requirement
    })
  }
})
