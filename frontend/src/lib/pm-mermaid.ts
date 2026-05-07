// NodeView for code_block[lang=mermaid] in DocView. Renders the diagram via
// the same beautiful-mermaid pipeline as MarkdownPreview, with a per-block
// source/diagram toggle so the underlying fence stays editable.
//
// PM NodeView contract: `dom` is what PM mounts; `contentDOM` is where PM
// manages the node's editable text content. We keep contentDOM (a <pre><code>)
// in the DOM at all times so PM's selection/typing path is undisturbed, and
// just CSS-hide it while the diagram is shown.

import type { Node } from 'prosemirror-model'
import type { EditorView, NodeView } from 'prosemirror-view'
import { ensureMermaidLoaded, tryRenderDiagram, wirePanzoom } from './mermaid'

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag)
  if (cls) e.className = cls
  return e
}

class MermaidNodeView implements NodeView {
  dom: HTMLElement
  contentDOM: HTMLElement
  private svgHost: HTMLElement
  private toggle: HTMLButtonElement
  private showingSource = false
  private forcedByFailure = false
  private lastSrc = ''
  private panzoomCleanup?: () => void

  constructor(private node: Node) {
    this.dom = el('div', 'pm-mermaid')
    this.svgHost = el('div', 'mermaid-block')
    const pre = el('pre', 'pm-mermaid-src')
    this.contentDOM = el('code')
    pre.append(this.contentDOM)
    this.toggle = el('button', 'btn btn-sm pm-mermaid-toggle')
    this.toggle.type = 'button'
    this.toggle.contentEditable = 'false'
    this.toggle.addEventListener('mousedown', (e) => {
      e.preventDefault()
      this.showingSource = !this.showingSource
      this.forcedByFailure = false
      this.applyMode()
    })
    this.dom.append(this.toggle, this.svgHost, pre)
    this.applyMode()
    void ensureMermaidLoaded().then(() => this.render())
  }

  private applyMode() {
    this.dom.classList.toggle('show-source', this.showingSource)
    this.toggle.textContent = this.showingSource ? '◇ diagram' : '⟨⟩ source'
  }

  private render() {
    const src = this.node.textContent
    if (src === this.lastSrc) return
    this.lastSrc = src
    const svg = tryRenderDiagram(src)
    if (svg) {
      this.panzoomCleanup?.()
      // Same trust boundary as markdown-render.ts:345 — beautiful-mermaid emits
      // structured SVG (label text goes through escapeHtml in its renderer),
      // not pass-through HTML. CSP script-src covers the remaining surface.
      this.svgHost.innerHTML = svg
      this.panzoomCleanup = wirePanzoom(this.dom)
      // A prior failure forced source view; flip back so the now-valid render
      // is visible without a manual toggle. NOT for user-initiated ⟨⟩ — that
      // would auto-exit source mode on the first valid keystroke mid-edit.
      if (this.forcedByFailure) {
        this.showingSource = false
        this.forcedByFailure = false
        this.applyMode()
      }
    } else {
      this.svgHost.textContent = '(mermaid render failed — edit source)'
      this.showingSource = true
      this.forcedByFailure = true
      this.applyMode()
    }
  }

  destroy() {
    this.panzoomCleanup?.()
  }

  update(node: Node): boolean {
    if (node.type !== this.node.type || node.attrs.lang !== 'mermaid') return false
    this.node = node
    this.render()
    return true
  }

  // Toggle button clicks are ours; everything else PM handles (selection,
  // typing in contentDOM).
  stopEvent(e: Event): boolean {
    return e.target === this.toggle
  }

  ignoreMutation(m: MutationRecord): boolean {
    // PM should ignore our SVG injection; only contentDOM mutations matter.
    return !this.contentDOM.contains(m.target as globalThis.Node)
  }
}

export const mermaidNodeViews = {
  code_block(node: Node, _view: EditorView, _getPos: () => number | undefined): NodeView {
    if (node.attrs.lang === 'mermaid') return new MermaidNodeView(node)
    const pre = el('pre')
    const code = el('code')
    if (node.attrs.lang) pre.dataset.lang = String(node.attrs.lang)
    pre.append(code)
    return { dom: pre, contentDOM: code }
  },
}
