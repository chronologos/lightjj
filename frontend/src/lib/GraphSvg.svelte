<script lang="ts">
  /** SVG renderer for a single graph row's gutter string.
   *  Maps jj's ASCII graph characters to SVG elements at grid positions.
   *  Uses --graph-N CSS vars from theme.css (Tier 3: muted, decorative).
   *  Opacity encodes hover/state: lines 0.45 → 0.7, nodes 0.8 → 1.0. */

  interface Props {
    gutter: string
    isNode: boolean
    isWorkingCopy: boolean
    isImmutable: boolean
    isConflicted: boolean
    isDivergent: boolean
    isHidden: boolean
    maxLanes: number
    hoveredLane: number | null
    isDark: boolean
    onlanehover?: (lane: number | null) => void
  }

  let {
    gutter, isDivergent, maxLanes, hoveredLane, isDark, onlanehover,
    // Remaining props are passed by the parent but unused here — the gutter
    // character itself encodes node type (@, ◆, ×, ◌, ○). Kept in the
    // interface for API completeness; destructured to suppress Svelte warnings.
    isNode: _, isWorkingCopy: _wc, isImmutable: _im, isConflicted: _cf, isHidden: _hd,
  }: Props = $props()

  // --- Constants ---
  const CELL_W = 12   // width per character cell
  const ROW_H = 18    // matches fixed row height
  const NODE_R = 4    // node circle radius
  const WC_R = 5      // working copy node radius (larger)
  const LINE_W = 1.5  // lane line stroke width
  const HOVER_W = 2.5 // hovered lane stroke width
  const GRAPH_COLORS = 8  // number of --graph-N vars in theme.css

  // Opacity tiers per design language (Tier 3: muted, decorative)
  const LINE_OPACITY = 0.45
  const LINE_HOVER_OPACITY = 0.7
  const NODE_OPACITY = 0.8
  const NODE_HOVER_OPACITY = 1.0

  const NODE_CHARS = new Set(['@', '○', '◆', '×', '◌'])

  // Read --graph-N CSS vars from theme.css. Re-reads when isDark changes.
  let palette = $derived.by(() => {
    void isDark // dependency: re-read on theme toggle
    const style = getComputedStyle(document.documentElement)
    return Array.from({ length: GRAPH_COLORS }, (_, i) =>
      style.getPropertyValue(`--graph-${i}`).trim()
    )
  })

  function laneColor(lane: number): string {
    return palette[lane % GRAPH_COLORS]
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
    {@const color = laneColor(cell.lane)}
    {@const lineOp = hovered ? LINE_HOVER_OPACITY : LINE_OPACITY}
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
        stroke={color} stroke-width={sw} opacity={lineOp} pointer-events="none" />

    {:else if cell.char === '~'}
      <line x1={x} y1={0} x2={x} y2={ROW_H}
        stroke={color} stroke-width={sw}
        stroke-dasharray="2 3" opacity={hovered ? 0.5 : 0.3}
        pointer-events="none" />

    {:else if cell.char === '─'}
      <line x1={x - CELL_W / 2} y1={cy} x2={x + CELL_W / 2} y2={cy}
        stroke={color} stroke-width={sw} opacity={lineOp} pointer-events="none" />

    {:else if cell.char === '├'}
      {@const branchLane = cell.lane + 1}
      {@const branchHovered = hoveredLane === branchLane}
      {@const branchColor = laneColor(branchLane)}
      {@const branchOp = branchHovered ? LINE_HOVER_OPACITY : LINE_OPACITY}
      {@const branchSw = branchHovered ? HOVER_W : LINE_W}
      <line x1={x} y1={0} x2={x} y2={ROW_H}
        stroke={color} stroke-width={sw} opacity={lineOp} pointer-events="none" />
      <line x1={x} y1={cy} x2={x + CELL_W / 2} y2={cy}
        stroke={branchColor} stroke-width={branchSw} opacity={branchOp} pointer-events="none" />

    {:else if cell.char === '┤'}
      {@const branchLane = cell.lane - 1}
      {@const branchHovered = hoveredLane === branchLane}
      {@const branchColor = laneColor(branchLane)}
      {@const branchOp = branchHovered ? LINE_HOVER_OPACITY : LINE_OPACITY}
      {@const branchSw = branchHovered ? HOVER_W : LINE_W}
      <line x1={x} y1={0} x2={x} y2={ROW_H}
        stroke={color} stroke-width={sw} opacity={lineOp} pointer-events="none" />
      <line x1={x - CELL_W / 2} y1={cy} x2={x} y2={cy}
        stroke={branchColor} stroke-width={branchSw} opacity={branchOp} pointer-events="none" />

    {:else if cell.char === '╮'}
      <path d="M {x - CELL_W / 2} {cy} Q {x} {cy} {x} {ROW_H}"
        fill="none" stroke={color} stroke-width={sw} opacity={lineOp}
        stroke-linecap="round" pointer-events="none" />

    {:else if cell.char === '╯'}
      <path d="M {x} {0} Q {x} {cy} {x - CELL_W / 2} {cy}"
        fill="none" stroke={color} stroke-width={sw} opacity={lineOp}
        stroke-linecap="round" pointer-events="none" />

    {:else if cell.char === '╭'}
      <path d="M {x + CELL_W / 2} {cy} Q {x} {cy} {x} {ROW_H}"
        fill="none" stroke={color} stroke-width={sw} opacity={lineOp}
        stroke-linecap="round" pointer-events="none" />

    {:else if cell.char === '╰'}
      <path d="M {x} {0} Q {x} {cy} {x + CELL_W / 2} {cy}"
        fill="none" stroke={color} stroke-width={sw} opacity={lineOp}
        stroke-linecap="round" pointer-events="none" />

    {:else if NODE_CHARS.has(cell.char)}
      {@const nodeOp = hovered ? NODE_HOVER_OPACITY : NODE_OPACITY}
      <g pointer-events="none">
        <!-- Background lane line for continuity -->
        <line x1={x} y1={0} x2={x} y2={ROW_H}
          stroke={color} stroke-width={LINE_W} opacity={hovered ? 0.35 : 0.2} />

        {#if cell.char === '@'}
          <!-- Working copy: semantic green, no graph opacity -->
          <circle cx={x} cy={cy} r={WC_R} fill="var(--green)" />
          <text x={x} y={cy + 0.5}
            text-anchor="middle" dominant-baseline="central"
            fill={isDark ? '#0f0f13' : '#f8f8f6'}
            font-size="7" font-weight="800"
            class="node-glyph">@</text>

        {:else if cell.char === '◆'}
          <!-- Immutable: dimmer than normal nodes -->
          <rect x={x - 3.5} y={cy - 3.5} width={7} height={7}
            rx={1} fill={color} opacity={hovered ? 0.7 : 0.5}
            transform="rotate(45 {x} {cy})" />

        {:else if cell.char === '×'}
          <!-- Conflict: semantic red, no graph opacity -->
          <circle cx={x} cy={cy} r={NODE_R} fill="var(--red)" />
          <line x1={x - 2} y1={cy - 2} x2={x + 2} y2={cy + 2}
            stroke={isDark ? '#0f0f13' : '#f8f8f6'} stroke-width={1.5} />
          <line x1={x + 2} y1={cy - 2} x2={x - 2} y2={cy + 2}
            stroke={isDark ? '#0f0f13' : '#f8f8f6'} stroke-width={1.5} />

        {:else if cell.char === '◌'}
          <!-- Hidden: subtler than normal nodes -->
          <circle cx={x} cy={cy} r={NODE_R - 0.5}
            fill="none" stroke={color} stroke-width={1.2} opacity={hovered ? 0.55 : 0.35} />

        {:else}
          <!-- Normal node (○): graph palette with node opacity -->
          <circle cx={x} cy={cy} r={NODE_R} fill={color} opacity={nodeOp} />
        {/if}
        {#if isDivergent}
          <circle cx={x} cy={cy} r={NODE_R + 3} fill="none"
            stroke={color} stroke-width="1" stroke-dasharray="2 2" opacity="0.5" />
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
