import { describe, it, expect, vi } from 'vitest'
import { render } from '@testing-library/svelte'
import MarkdownPreview from './MarkdownPreview.svelte'
import type { Annotation } from './api'

vi.mock('beautiful-mermaid', () => ({ renderMermaidSVG: vi.fn(() => '<svg/>') }))

const ann = (lineNum: number): Annotation => ({
  id: 'a', changeId: 'c', filePath: 'f', lineNum, lineContent: 'x',
  comment: 'test', severity: 'suggestion', status: 'open',
  createdAt: 0, createdAtCommitId: 'c',
})

describe('MarkdownPreview — explicit gutter', () => {
  it('renders gutter rows with diff strip + annotation badge from reactive props', async () => {
    const content = '# Title\n\nPara one\n\nPara two'
    const annotationsForLine = (_fp: string, n: number) => n === 3 ? [ann(3)] : []
    const { container } = render(MarkdownPreview, {
      props: { content, filePath: 'f', annotationsForLine, addedLines: new Set([1, 5]) },
    })
    // gutterRows is populated in a post-render $effect — flush microtasks.
    await Promise.resolve()
    await Promise.resolve()

    const rows = container.querySelectorAll('.md-gutter-row')
    expect(rows.length).toBeGreaterThan(0)
    // Title (line 1) is added → has strip, no badge.
    // Para one (line 3) has annotation → has badge.
    // Para two (line 5) is added → has strip.
    const strips = container.querySelectorAll('.md-strip-add')
    const badges = container.querySelectorAll('.md-gutter .annotation-badge')
    expect(strips.length).toBe(2)
    expect(badges.length).toBe(1)
    expect(badges[0].getAttribute('title')).toContain('test')
  })

  it('no gutter when neither annotationsForLine nor addedLines passed', () => {
    const { container } = render(MarkdownPreview, { props: { content: '# Hi' } })
    expect(container.querySelector('.md-gutter')).toBeNull()
  })

  it('Alt+click on a block calls onannotationclick with srcLine', async () => {
    const onannotationclick = vi.fn()
    const { container } = render(MarkdownPreview, {
      props: { content: '# Title\n\nPara', filePath: 'f', annotationsForLine: () => [], onannotationclick },
    })
    await Promise.resolve()
    const para = container.querySelector('.md-content p[data-src-line]')!
    para.dispatchEvent(new MouseEvent('click', { altKey: true, bubbles: true }))
    expect(onannotationclick).toHaveBeenCalledWith(3, 'Para', expect.anything())
  })
})
