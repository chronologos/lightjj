// ProseMirror schema + marked-based markdown parser/serializer.
//
// This is the "yoink" path from the doc-mode design: instead of taking
// prosemirror-markdown (which hard-couples to markdown-it + 6 transitives),
// we build the PM doc from marked's Lexer tokens (marked is already a dep)
// and hand-roll the serializer. ~300 LOC in-tree vs 9 extra packages.
//
// Round-trip is normalized, not byte-identical: list markers become `-`,
// emphasis becomes `*`, indented code becomes fenced, trailing whitespace
// is stripped. The doc-mode import flow shows the normalization diff up
// front so the rewrite is never a surprise.

import { Schema, type Node, type NodeSpec, type MarkSpec, type Mark } from 'prosemirror-model'
import { Lexer, type Token, type Tokens } from 'marked'

// ─── Schema ───────────────────────────────────────────────────────────────

const nodes: Record<string, NodeSpec> = {
  doc: { content: 'block+' },

  paragraph: {
    group: 'block',
    content: 'inline*',
    parseDOM: [{ tag: 'p' }],
    toDOM: () => ['p', 0],
  },

  heading: {
    group: 'block',
    content: 'inline*',
    attrs: { level: { default: 1 } },
    defining: true,
    parseDOM: [1, 2, 3, 4, 5, 6].map((level) => ({ tag: `h${level}`, attrs: { level } })),
    toDOM: (n) => [`h${n.attrs.level}`, 0],
  },

  blockquote: {
    group: 'block',
    content: 'block+',
    defining: true,
    parseDOM: [{ tag: 'blockquote' }],
    toDOM: () => ['blockquote', 0],
  },

  code_block: {
    group: 'block',
    content: 'text*',
    attrs: { lang: { default: '' } },
    marks: '',
    code: true,
    defining: true,
    parseDOM: [{ tag: 'pre', preserveWhitespace: 'full' }],
    toDOM: (n) => ['pre', { 'data-lang': n.attrs.lang }, ['code', 0]],
  },

  horizontal_rule: {
    group: 'block',
    parseDOM: [{ tag: 'hr' }],
    toDOM: () => ['hr'],
  },

  // Escape hatch for block-level constructs the schema doesn't model yet
  // (tables, raw HTML, link reference definitions). Stores the raw source
  // and serializes it back verbatim, so round-trip never loses content.
  passthrough: {
    group: 'block',
    attrs: { raw: { default: '' } },
    atom: true,
    toDOM: (n) => ['pre', { class: 'pm-passthrough' }, n.attrs.raw],
  },

  bullet_list: {
    group: 'block',
    content: 'list_item+',
    attrs: { tight: { default: true } },
    parseDOM: [{ tag: 'ul' }],
    toDOM: () => ['ul', 0],
  },

  ordered_list: {
    group: 'block',
    content: 'list_item+',
    attrs: { order: { default: 1 }, tight: { default: true } },
    parseDOM: [
      {
        tag: 'ol',
        getAttrs: (dom) => ({ order: +((dom as HTMLElement).getAttribute('start') ?? 1) }),
      },
    ],
    toDOM: (n) => ['ol', n.attrs.order === 1 ? {} : { start: n.attrs.order }, 0],
  },

  list_item: {
    content: 'paragraph block*',
    attrs: { task: { default: false }, checked: { default: false } },
    defining: true,
    parseDOM: [{ tag: 'li' }],
    toDOM: () => ['li', 0],
  },

  hard_break: {
    group: 'inline',
    inline: true,
    selectable: false,
    parseDOM: [{ tag: 'br' }],
    toDOM: () => ['br'],
  },

  text: { group: 'inline' },
}

const marks: Record<string, MarkSpec> = {
  em: {
    parseDOM: [{ tag: 'em' }, { tag: 'i' }],
    toDOM: () => ['em', 0],
  },
  strong: {
    parseDOM: [{ tag: 'strong' }, { tag: 'b' }],
    toDOM: () => ['strong', 0],
  },
  code: {
    excludes: '_',
    parseDOM: [{ tag: 'code' }],
    toDOM: () => ['code', 0],
  },
  link: {
    attrs: { href: { default: '' }, title: { default: null } },
    inclusive: false,
    parseDOM: [
      {
        tag: 'a[href]',
        getAttrs: (dom) => ({
          href: (dom as HTMLElement).getAttribute('href'),
          title: (dom as HTMLElement).getAttribute('title'),
        }),
      },
    ],
    // toDOM bypasses the DOMPurify path that markdown-render.ts uses, so we
    // gate schemes here. Reviewing an untrusted .md (cloned repo, attacker PR)
    // with [x](javascript:...) would otherwise be a click-to-XSS. The unsafe
    // href is preserved in attrs so serializeMarkdown round-trips it; only
    // the rendered DOM is neutered.
    toDOM: (m) => {
      const href = String(m.attrs.href ?? '')
      const safe = SAFE_LINK_SCHEME.test(href) ? href : '#'
      return ['a', { href: safe, title: m.attrs.title, rel: 'noopener noreferrer nofollow' }, 0]
    },
  },
}

const SAFE_LINK_SCHEME = /^(?:https?:|mailto:|#|\.{0,2}\/)/i

export const docSchema = new Schema({ nodes, marks })

// ─── Parse: marked tokens → PM doc ────────────────────────────────────────

const s = docSchema

function inlineNodes(tokens: Token[] | undefined, activeMarks: readonly Mark[] = []): Node[] {
  const out: Node[] = []
  for (const tok of tokens ?? []) {
    switch (tok.type) {
      case 'text':
      case 'escape': {
        const t = tok as Tokens.Text
        // marked sometimes nests inline tokens under a `text` wrapper (e.g. in
        // tight list items); recurse if so, otherwise emit the literal text.
        if ('tokens' in t && t.tokens && t.tokens.length) {
          out.push(...inlineNodes(t.tokens, activeMarks))
        } else if (t.text) {
          out.push(s.text(t.text, activeMarks))
        }
        break
      }
      case 'strong':
        out.push(...inlineNodes((tok as Tokens.Strong).tokens, [...activeMarks, s.mark('strong')]))
        break
      case 'em':
        out.push(...inlineNodes((tok as Tokens.Em).tokens, [...activeMarks, s.mark('em')]))
        break
      case 'codespan': {
        const t = tok as Tokens.Codespan
        if (t.text) out.push(s.text(t.text, [...activeMarks, s.mark('code')]))
        break
      }
      case 'link': {
        const t = tok as Tokens.Link
        const link = s.mark('link', { href: t.href, title: t.title ?? null })
        out.push(...inlineNodes(t.tokens, [...activeMarks, link]))
        break
      }
      case 'br':
        out.push(s.node('hard_break'))
        break
      case 'checkbox':
        // GFM task checkbox — captured as list_item attrs at the block level;
        // marked nests it inside the paragraph's inline tokens for loose lists.
        break
      default:
        // image, del, html, unknown inline: keep raw source so it round-trips
        if (tok.raw) out.push(s.text(tok.raw, activeMarks))
    }
  }
  return out
}

function blockNodes(tokens: Token[]): Node[] {
  const out: Node[] = []
  for (const tok of tokens) {
    switch (tok.type) {
      case 'space':
        break
      case 'heading': {
        const t = tok as Tokens.Heading
        out.push(s.node('heading', { level: t.depth }, inlineNodes(t.tokens)))
        break
      }
      case 'paragraph':
        out.push(s.node('paragraph', null, inlineNodes((tok as Tokens.Paragraph).tokens)))
        break
      case 'blockquote':
        out.push(s.node('blockquote', null, blockNodes((tok as Tokens.Blockquote).tokens)))
        break
      case 'code': {
        const t = tok as Tokens.Code
        const content = t.text ? [s.text(t.text)] : []
        out.push(s.node('code_block', { lang: t.lang ?? '' }, content))
        break
      }
      case 'hr':
        out.push(s.node('horizontal_rule'))
        break
      case 'list': {
        const t = tok as Tokens.List
        const items = t.items.map((it) => {
          // GFM task checkbox arrives as a leading `checkbox` token; lift it
          // into list_item attrs and drop it from the block stream.
          const body = it.tokens.filter((c) => c.type !== 'checkbox')
          const children = blockNodes(body)
          if (children.length === 0 || children[0].type.name !== 'paragraph') {
            children.unshift(s.node('paragraph'))
          }
          return s.node('list_item', { task: !!it.task, checked: !!it.checked }, children)
        })
        const listType = t.ordered ? 'ordered_list' : 'bullet_list'
        const attrs = t.ordered
          ? { order: typeof t.start === 'number' ? t.start : 1, tight: !t.loose }
          : { tight: !t.loose }
        out.push(s.node(listType, attrs, items))
        break
      }
      case 'text': {
        // Tight list items contain a block-level `text` token whose `.tokens`
        // are the inline content. Treat as a paragraph.
        const t = tok as Tokens.Text
        out.push(s.node('paragraph', null, inlineNodes(t.tokens ?? [{ ...t, tokens: undefined }])))
        break
      }
      default:
        // table, html, def, unknown: opaque round-trip
        out.push(s.node('passthrough', { raw: tok.raw }))
    }
  }
  return out
}

export function parseMarkdown(md: string): Node {
  // Use a fresh Lexer instance — markdown-render.ts configures the module-level
  // `marked` singleton with footnote/stamp extensions we don't want here.
  const tokens = new Lexer({ gfm: true }).lex(md)
  const blocks = blockNodes(tokens)
  if (blocks.length === 0) blocks.push(s.node('paragraph'))
  return s.node('doc', null, blocks)
}

// ─── Serialize: PM doc → markdown ─────────────────────────────────────────

const MARK_DELIM: Record<string, (m: Mark, open: boolean, text: string) => string> = {
  strong: () => '**',
  em: () => '*',
  code: (_m, _open, text) => {
    // Use enough backticks to not collide with content
    let n = 1
    const re = /`+/g
    let mt: RegExpExecArray | null
    while ((mt = re.exec(text))) if (mt[0].length >= n) n = mt[0].length + 1
    return '`'.repeat(n)
  },
  link: (m, open) => (open ? '[' : `](${m.attrs.href}${m.attrs.title ? ` "${m.attrs.title}"` : ''})`),
}

// Punctuation that would otherwise be parsed as markdown syntax at the start
// of a line or inline. Conservative — only escape what marked actually parses.
function escapeInline(text: string, atLineStart: boolean): string {
  let t = text.replace(/([\\`*_\[\]])/g, '\\$1')
  if (atLineStart) t = t.replace(/^([#>+-]|\d+\.)(\s)/, '\\$1$2')
  return t
}

function serializeInline(parent: Node): string {
  let out = ''
  let active: readonly Mark[] = []
  const close = (upto: number) => {
    for (let i = active.length - 1; i >= upto; i--) {
      const m = active[i]
      out += MARK_DELIM[m.type.name](m, false, '')
    }
    active = active.slice(0, upto)
  }
  parent.forEach((child, _offset, index) => {
    if (child.type.name === 'hard_break') {
      close(0)
      out += '\\\n'
      return
    }
    const marks = child.marks
    // Find common prefix with active marks
    let keep = 0
    while (keep < active.length && keep < marks.length && active[keep].eq(marks[keep])) keep++
    close(keep)
    for (let i = keep; i < marks.length; i++) {
      const m = marks[i]
      out += MARK_DELIM[m.type.name](m, true, child.text ?? '')
      active = [...active, m]
    }
    const isCode = marks.some((m) => m.type.name === 'code')
    const text = child.text ?? ''
    out += isCode ? text : escapeInline(text, index === 0 && out === '')
  })
  close(0)
  return out
}

function prefixLines(text: string, first: string, rest: string): string {
  const lines = text.split('\n')
  return lines.map((ln, i) => (i === 0 ? first : rest) + ln).join('\n')
}

function serializeBlock(node: Node): string {
  switch (node.type.name) {
    case 'paragraph':
      return serializeInline(node)
    case 'heading':
      return '#'.repeat(node.attrs.level) + ' ' + serializeInline(node)
    case 'blockquote': {
      const inner = serializeBlocks(node)
      return prefixLines(inner, '> ', '> ')
    }
    case 'code_block': {
      const text = node.textContent
      let fence = '```'
      const re = /^`{3,}/gm
      let mt: RegExpExecArray | null
      while ((mt = re.exec(text))) if (mt[0].length >= fence.length) fence = '`'.repeat(mt[0].length + 1)
      return `${fence}${node.attrs.lang ?? ''}\n${text}\n${fence}`
    }
    case 'horizontal_rule':
      return '---'
    case 'bullet_list':
    case 'ordered_list': {
      const ordered = node.type.name === 'ordered_list'
      const start = ordered ? (node.attrs.order ?? 1) : 0
      const tight = node.attrs.tight !== false
      const parts: string[] = []
      node.forEach((item, _off, i) => {
        const marker =
          (ordered ? `${start + i}. ` : '- ') +
          (item.attrs.task ? (item.attrs.checked ? '[x] ' : '[ ] ') : '')
        const indent = ' '.repeat(ordered ? `${start + i}. `.length : 2)
        const inner = serializeBlocks(item, tight ? '\n' : '\n\n')
        parts.push(prefixLines(inner, marker, indent))
      })
      return parts.join(tight ? '\n' : '\n\n')
    }
    case 'passthrough':
      return node.attrs.raw.replace(/\n+$/, '')
    default:
      return node.textContent
  }
}

function serializeBlocks(parent: Node, sep = '\n\n'): string {
  const parts: string[] = []
  parent.forEach((child) => parts.push(serializeBlock(child)))
  return parts.join(sep)
}

export function serializeMarkdown(doc: Node): string {
  return serializeBlocks(doc) + '\n'
}
