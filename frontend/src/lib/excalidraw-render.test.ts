import { describe, it, expect } from 'vitest'
import { renderExcalidrawSVG } from './excalidraw-render'

const base = {
  angle: 0, strokeColor: '#1e1e1e', backgroundColor: 'transparent',
  fillStyle: 'solid', strokeWidth: 2, strokeStyle: 'solid',
  roundness: null, opacity: 100,
}

const doc = (elements: object[], appState?: object) =>
  JSON.stringify({ type: 'excalidraw', version: 2, source: 'test', elements, appState })

describe('renderExcalidrawSVG', () => {
  it('rejects non-excalidraw / malformed JSON', () => {
    expect(renderExcalidrawSVG('not json')).toBeNull()
    expect(renderExcalidrawSVG('{"type":"other","elements":[]}')).toBeNull()
    expect(renderExcalidrawSVG('{"type":"excalidraw"}')).toBeNull()
  })

  it('empty / all-deleted → placeholder svg', () => {
    const svg = renderExcalidrawSVG(doc([{ ...base, type: 'rectangle', x: 0, y: 0, width: 10, height: 10, isDeleted: true }]))!
    expect(svg).toContain('(empty diagram)')
  })

  it('rectangle: bbox viewBox + roundness + solid fill', () => {
    const svg = renderExcalidrawSVG(doc([
      { ...base, type: 'rectangle', x: 10, y: 20, width: 100, height: 40, roundness: { type: 3 }, backgroundColor: '#ff0000' },
    ]))!
    // PAD=20 → viewBox starts at -10,0; size 140,80
    expect(svg).toMatch(/viewBox="-10 0 140 80"/)
    expect(svg).toContain('<rect x="10" y="20" width="100" height="40" rx="10"')
    expect(svg).toContain('fill="#ff0000"')
  })

  it('non-solid fillStyle / transparent bg → fill=none', () => {
    const hach = renderExcalidrawSVG(doc([{ ...base, type: 'ellipse', x: 0, y: 0, width: 20, height: 20, fillStyle: 'hachure', backgroundColor: '#f00' }]))!
    expect(hach).toContain('fill="none"')
    const trans = renderExcalidrawSVG(doc([{ ...base, type: 'ellipse', x: 0, y: 0, width: 20, height: 20, backgroundColor: 'transparent' }]))!
    expect(trans).toContain('fill="none"')
  })

  it('arrow: points relative to (x,y), endArrowhead → marker', () => {
    const svg = renderExcalidrawSVG(doc([
      { ...base, type: 'arrow', x: 5, y: 5, width: 50, height: 0, points: [[0, 0], [50, 0]], endArrowhead: 'arrow', startArrowhead: null },
    ]))!
    expect(svg).toContain('d="M5,5 L55,5"')
    expect(svg).toContain('marker-end="url(#ex-arrow-end)"')
    expect(svg).not.toContain('marker-start')
  })

  it('text: multi-line tspans, escaped, center-aligned', () => {
    const svg = renderExcalidrawSVG(doc([
      { ...base, type: 'text', x: 0, y: 0, width: 80, height: 50, text: 'a<b>\nline2', fontSize: 20, textAlign: 'center' },
    ]))!
    expect(svg).toContain('text-anchor="middle"')
    expect(svg).toContain('>a&lt;b&gt;</tspan>')
    // line height 1.25 → second line at y=25
    expect(svg).toContain('<tspan x="40" y="25"')
  })

  it('strokeStyle dashed/dotted → dasharray; angle radians → degrees', () => {
    const dashed = renderExcalidrawSVG(doc([{ ...base, type: 'line', x: 0, y: 0, width: 10, height: 0, points: [[0, 0], [10, 0]], strokeStyle: 'dashed', strokeWidth: 2 }]))!
    expect(dashed).toContain('stroke-dasharray="8 8"')
    const rot = renderExcalidrawSVG(doc([{ ...base, type: 'rectangle', x: 0, y: 0, width: 10, height: 10, angle: Math.PI / 2 }]))!
    expect(rot).toContain('rotate(90 5 5)')
  })

  it('opacity 0-100 scale; 100 omitted', () => {
    const half = renderExcalidrawSVG(doc([{ ...base, type: 'rectangle', x: 0, y: 0, width: 10, height: 10, opacity: 50 }]))!
    expect(half).toContain('opacity="0.5"')
    const full = renderExcalidrawSVG(doc([{ ...base, type: 'rectangle', x: 0, y: 0, width: 10, height: 10, opacity: 100 }]))!
    expect(full).not.toContain('opacity=')
  })

  it('unsupported type → labeled placeholder box', () => {
    const svg = renderExcalidrawSVG(doc([{ ...base, type: 'image', x: 0, y: 0, width: 50, height: 50 }]))!
    expect(svg).toContain('stroke-dasharray="4 4"')
    expect(svg).toContain('>image</text>')
  })

  it('appState.viewBackgroundColor → svg background; defaults white', () => {
    const def = renderExcalidrawSVG(doc([{ ...base, type: 'rectangle', x: 0, y: 0, width: 10, height: 10 }]))!
    expect(def).toContain('background:#ffffff')
    const custom = renderExcalidrawSVG(doc([{ ...base, type: 'rectangle', x: 0, y: 0, width: 10, height: 10 }], { viewBackgroundColor: '#121212' }))!
    expect(custom).toContain('background:#121212')
  })

  it('escapes attribute breakout (`"` without `<>`) in colors + viewBackgroundColor', () => {
    // The trap: escapeHtml passes `"` through. A payload with `<>` would mask
    // this since those ARE escaped — test the `"`-only case. Substring
    // matching is fragile (the escaped text still contains "onload="); parse
    // with DOMParser and assert no on* attributes landed on any node.
    const svg = renderExcalidrawSVG(doc(
      [{ ...base, type: 'rectangle', x: 0, y: 0, width: 10, height: 10, strokeColor: 'x" onmouseover="alert(1)' }],
      { viewBackgroundColor: 'red" onload="alert(1)' },
    ))!
    const dom = new DOMParser().parseFromString(svg, 'image/svg+xml')
    const handlers = [...dom.querySelectorAll('*')].flatMap(el =>
      [...el.attributes].filter(a => a.name.startsWith('on')))
    expect(handlers).toEqual([])
    expect(svg).toContain('&quot;')
  })
})
