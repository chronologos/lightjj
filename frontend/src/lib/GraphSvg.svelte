<script lang="ts">
  /** SVG renderer for a single graph row's gutter string.
   *  Maps jj's ASCII graph characters to SVG elements at grid positions.
   *  Uses "Earth & Sky" color palette with theme-aware dark/light variants. */

  interface Props {
    gutter: string
    isNode: boolean
    isWorkingCopy: boolean
    isImmutable: boolean
    isConflicted: boolean
    isHidden: boolean
    maxLanes: number
    hoveredLane: number | null
    isDark: boolean
    onlanehover?: (lane: number | null) => void
  }

  let {
    gutter, isNode, isWorkingCopy, isImmutable, isConflicted, isHidden,
    maxLanes, hoveredLane, isDark, onlanehover,
  }: Props = $props()

  // --- Constants ---
  const CELL_W = 12   // width per character cell
  const ROW_H = 18    // matches fixed row height
  const NODE_R = 4    // node circle radius
  const WC_R = 5      // working copy node radius (larger)
  const LINE_W = 1.5  // lane line stroke width
  const HOVER_W = 2.5 // hovered lane stroke width

  // Earth & Sky — 10-color palette, interleaved warm/cool for max adjacent contrast
  //   amber, blue, rose, teal, orange, purple, olive, sky, salmon, green
  const DARK_PALETTE = [
    '#F2A93B', '#6E9AE8', '#CC5C7A', '#4FC4B8', '#E07858',
    '#A480D0', '#D4B84A', '#8AB4D8', '#E89070', '#78C868',
  ]
  const LIGHT_PALETTE = [
    '#C07A10', '#4A72C5', '#A83E5E', '#2A9E92', '#B85A38',
    '#7E58B0', '#B09828', '#5888B8', '#C06848', '#4EA840',
  ]

  // Precompute highlight colors for each palette entry.
  // Dark theme: mix 40% white. Light theme: mix 30% white (lighten).
  function mixWhite(hex: string, amount: number): string {
    const r = parseInt(hex.slice(1, 3), 16)
    const g = parseInt(hex.slice(3, 5), 16)
    const b = parseInt(hex.slice(5, 7), 16)
    const mr = Math.round(r + (255 - r) * amount)
    const mg = Math.round(g + (255 - g) * amount)
    const mb = Math.round(b + (255 - b) * amount)
    return `#${mr.toString(16).padStart(2, '0')}${mg.toString(16).padStart(2, '0')}${mb.toString(16).padStart(2, '0')}`
  }

  const DARK_HOVER = DARK_PALETTE.map(c => mixWhite(c, 0.4))
  const LIGHT_HOVER = LIGHT_PALETTE.map(c => mixWhite(c, 0.35))

  const NODE_CHARS = new Set(['@', '○', '◆', '×', '◌'])

  // Pre-derive palette selection so the isDark ternary runs once, not per cell
  let palette = $derived(isDark ? DARK_PALETTE : LIGHT_PALETTE)
  let hoverPalette = $derived(isDark ? DARK_HOVER : LIGHT_HOVER)

  function laneColor(lane: number): string {
    return palette[lane % palette.length]
  }

  function laneHoverColor(lane: number): string {
    return hoverPalette[lane % hoverPalette.length]
  }

  interface GutterCell {
    char: string
    col: number
    lane: number
  }

  const HORIZ_CHARS = new Set(['─', '├', '┤', '╮', '╯', '╭', '╰'])

  function parseGutter(g: string): GutterCell[] {
    const cells: GutterCell[] = []
    let col = 0
    for (const char of g) {
      cells.push({ char, col, lane: Math.floor(col / 2) })
      col++
    }
    // Post-process: assign ─ chars the highest lane from their horizontal run.
    // Horizontal connectors always connect a lower lane to a higher lane
    // (branch), so we use the max lane found in the run for consistent coloring.
    let runStart = -1
    for (let i = 0; i < cells.length; i++) {
      if (cells[i].char === '─') {
        if (runStart < 0) runStart = i
      } else if (runStart >= 0) {
        // End of a ─ run: find the max lane among the run's neighboring endpoints
        let maxLane = cells[runStart].lane
        // Check left neighbor
        if (runStart > 0 && HORIZ_CHARS.has(cells[runStart - 1].char)) {
          maxLane = Math.max(maxLane, cells[runStart - 1].lane)
        }
        // Check right neighbor (current cell ended the run)
        if (HORIZ_CHARS.has(cells[i].char)) {
          maxLane = Math.max(maxLane, cells[i].lane)
        }
        for (let j = runStart; j < i; j++) cells[j].lane = maxLane
        runStart = -1
      }
    }
    return cells
  }

  let cells = $derived(parseGutter(gutter))
  let svgWidth = $derived(Math.max(maxLanes * CELL_W * 2, (cells.length + 1) * CELL_W))

  function cx(col: number): number {
    return col * CELL_W + CELL_W / 2
  }

  const cy = ROW_H / 2
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<svg
  width={svgWidth}
  height={ROW_H}
  class="graph-svg"
>
  {#each cells as cell}
    {@const x = cx(cell.col)}
    {@const hovered = hoveredLane === cell.lane}
    {@const color = hovered ? laneHoverColor(cell.lane) : laneColor(cell.lane)}
    {@const sw = hovered ? HOVER_W : LINE_W}

    <!-- Hit area: transparent rect filling the cell for easy hover targeting -->
    {#if cell.char !== ' '}
      <rect
        x={cell.col * CELL_W} y={0} width={CELL_W} height={ROW_H}
        fill="transparent"
        onmouseenter={() => onlanehover?.(cell.lane)}
      />
    {/if}

    {#if cell.char === '│'}
      <line x1={x} y1={0} x2={x} y2={ROW_H}
        stroke={color} stroke-width={sw} pointer-events="none" />

    {:else if cell.char === '~'}
      <line x1={x} y1={0} x2={x} y2={ROW_H}
        stroke={color} stroke-width={sw}
        stroke-dasharray="2 3" opacity={hovered ? 0.8 : 0.5}
        pointer-events="none" />

    {:else if cell.char === '─'}
      <line x1={x - CELL_W / 2} y1={cy} x2={x + CELL_W / 2} y2={cy}
        stroke={color} stroke-width={sw} pointer-events="none" />

    {:else if cell.char === '├'}
      {@const branchLane = cell.lane + 1}
      {@const branchHovered = hoveredLane === branchLane}
      {@const branchColor = branchHovered ? laneHoverColor(branchLane) : laneColor(branchLane)}
      {@const branchSw = branchHovered ? HOVER_W : LINE_W}
      <line x1={x} y1={0} x2={x} y2={ROW_H}
        stroke={color} stroke-width={sw} pointer-events="none" />
      <line x1={x} y1={cy} x2={x + CELL_W / 2} y2={cy}
        stroke={branchColor} stroke-width={branchSw} pointer-events="none" />

    {:else if cell.char === '┤'}
      {@const branchLane = cell.lane - 1}
      {@const branchHovered = hoveredLane === branchLane}
      {@const branchColor = branchHovered ? laneHoverColor(branchLane) : laneColor(branchLane)}
      {@const branchSw = branchHovered ? HOVER_W : LINE_W}
      <line x1={x} y1={0} x2={x} y2={ROW_H}
        stroke={color} stroke-width={sw} pointer-events="none" />
      <line x1={x - CELL_W / 2} y1={cy} x2={x} y2={cy}
        stroke={branchColor} stroke-width={branchSw} pointer-events="none" />

    {:else if cell.char === '╮'}
      <path d="M {x - CELL_W / 2} {cy} Q {x} {cy} {x} {ROW_H}"
        fill="none" stroke={color} stroke-width={sw}
        stroke-linecap="round" pointer-events="none" />

    {:else if cell.char === '╯'}
      <path d="M {x} {0} Q {x} {cy} {x - CELL_W / 2} {cy}"
        fill="none" stroke={color} stroke-width={sw}
        stroke-linecap="round" pointer-events="none" />

    {:else if cell.char === '╭'}
      <path d="M {x + CELL_W / 2} {cy} Q {x} {cy} {x} {ROW_H}"
        fill="none" stroke={color} stroke-width={sw}
        stroke-linecap="round" pointer-events="none" />

    {:else if cell.char === '╰'}
      <path d="M {x} {0} Q {x} {cy} {x + CELL_W / 2} {cy}"
        fill="none" stroke={color} stroke-width={sw}
        stroke-linecap="round" pointer-events="none" />

    {:else if NODE_CHARS.has(cell.char)}
      <g pointer-events="none">
        <!-- Background lane line for continuity -->
        <line x1={x} y1={0} x2={x} y2={ROW_H}
          stroke={color} stroke-width={LINE_W} opacity={hovered ? 0.5 : 0.25} />

        {#if cell.char === '@'}
          <circle cx={x} cy={cy} r={WC_R} fill="var(--green)" />
          <text x={x} y={cy + 0.5}
            text-anchor="middle" dominant-baseline="central"
            fill={isDark ? '#0f0f13' : '#f8f8f6'}
            font-size="7" font-weight="800"
            class="node-glyph">@</text>

        {:else if cell.char === '◆'}
          <rect x={x - 3.5} y={cy - 3.5} width={7} height={7}
            rx={1} fill={color} opacity={hovered ? 0.85 : 0.65}
            transform="rotate(45 {x} {cy})" />

        {:else if cell.char === '×'}
          <circle cx={x} cy={cy} r={NODE_R} fill="var(--red)" />
          <line x1={x - 2} y1={cy - 2} x2={x + 2} y2={cy + 2}
            stroke={isDark ? '#0f0f13' : '#f8f8f6'} stroke-width={1.5} />
          <line x1={x + 2} y1={cy - 2} x2={x - 2} y2={cy + 2}
            stroke={isDark ? '#0f0f13' : '#f8f8f6'} stroke-width={1.5} />

        {:else if cell.char === '◌'}
          <circle cx={x} cy={cy} r={NODE_R - 0.5}
            fill="none" stroke={color} stroke-width={1.2} opacity={hovered ? 0.7 : 0.45} />

        {:else}
          <circle cx={x} cy={cy} r={NODE_R} fill={color} />
        {/if}
      </g>
    {/if}
  {/each}
</svg>

<style>
  .graph-svg {
    flex-shrink: 0;
    display: block;
    overflow: visible;
  }

  .node-glyph {
    pointer-events: none;
    user-select: none;
  }
</style>
