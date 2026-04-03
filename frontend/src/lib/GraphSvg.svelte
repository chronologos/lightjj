<script module lang="ts">
  // --- Module-level constants & shared palette ---
  // Palette is identical across all instances (depends only on theme).
  // Per-instance $effect would call getComputedStyle + 8× getPropertyValue
  // on every mount — virtualized scroll through 1500 flatLines = 12k style
  // reads. Hoisted to module scope so it computes once per theme toggle.
  const CELL_W = 10   // width per character cell
  const ROW_H = 18    // matches fixed row height
  const NODE_R = 4    // node circle radius
  const WC_R = 5      // working copy node radius (larger)
  // Integer stroke width: a 1.5px stroke centered at x=5 spans 4.25→5.75,
  // straddling pixel boundaries → anti-alias blur. 2px at x=5 spans 4→6
  // exactly → crisp. Combined with shape-rendering:crispEdges on <line>
  // (not curves/circles — those want AA) for pixel-grid snapping.
  const LINE_W = 2
  const GRAPH_COLORS = 8  // number of --graph-N vars in theme.css

  // Opacity tiers per design language (Tier 3: muted, decorative)
  const LINE_OPACITY = 0.45
  const NODE_OPACITY = 0.8
  const ELIDED_OPACITY = 0.3
  // Gap between lane-line segment and node edge. Clears the largest node
  // (@ outer ring at WC_R+1=6) so hollow nodes don't have a line through them.
  const NODE_GAP = 7

  const NODE_CHARS = new Set(['@', '○', '◆', '×', '◌'])
  const HORIZ_CHARS = new Set(['─', '├', '┤', '╮', '╯', '╭', '╰'])

  interface GutterCell {
    char: string
    col: number
    lane: number
  }

  // Measured: 263 graph lines → 6 unique gutters on linear history (43×).
  // Virtualized scroll mounts fresh instances; without this memo each runs
  // parseGutter on the same few strings repeatedly.
  const gutterCache = new Map<string, GutterCell[]>()

  function parseGutter(g: string): GutterCell[] {
    const cached = gutterCache.get(g)
    if (cached) return cached
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
        closeRun(cells, runStart, i)
        runStart = -1
      }
    }
    // Trailing run (padGutter can truncate mid-connector at MAX_GUTTER)
    if (runStart >= 0) closeRun(cells, runStart, cells.length)
    gutterCache.set(g, cells)
    return cells
  }

  function closeRun(cells: GutterCell[], runStart: number, end: number) {
    let maxLane = cells[runStart].lane
    if (runStart > 0 && HORIZ_CHARS.has(cells[runStart - 1].char)) {
      maxLane = Math.max(maxLane, cells[runStart - 1].lane)
    }
    if (end < cells.length && HORIZ_CHARS.has(cells[end].char)) {
      maxLane = Math.max(maxLane, cells[end].lane)
    }
    for (let j = runStart; j < end; j++) cells[j].lane = maxLane
  }

  let palette: string[] = $state(Array(GRAPH_COLORS).fill('#888'))
  // Cache key includes epoch — for ghostty themes the --graph-N vars don't
  // exist until the lazy <style> injection lands, so theme-id alone would
  // cache the pre-injection default-dark colors permanently.
  let paletteKey: string | undefined

  function refreshPalette(key: string) {
    if (paletteKey === key) return
    paletteKey = key
    const style = getComputedStyle(document.documentElement)
    palette = Array.from({ length: GRAPH_COLORS }, (_, i) =>
      style.getPropertyValue(`--graph-${i}`).trim()
    )
  }
</script>

<script lang="ts">
  /** SVG renderer for a single graph row's gutter string.
   *  Maps jj's ASCII graph characters to SVG elements at grid positions.
   *  Uses --graph-N CSS vars from theme.css (Tier 3: muted, decorative). */

  interface Props {
    gutter: string
    isDivergent: boolean
    gutterWidth: number
    theme: string
    themeEpoch?: number
  }

  let { gutter, isDivergent, gutterWidth, theme, themeEpoch = 0 }: Props = $props()

  // Must use $effect (not $derived): the data-theme attr write happens in an
  // $effect in App.svelte — $derived would read stale CSS vars. refreshPalette
  // no-ops on same key, so only the first instance after a change does work.
  $effect(() => refreshPalette(`${theme}:${themeEpoch}`))

  function laneColor(lane: number): string {
    return palette[lane % GRAPH_COLORS]
  }

  let cells = $derived(parseGutter(gutter))
  let svgWidth = $derived(gutterWidth * CELL_W)

  function cx(col: number): number {
    return col * CELL_W + CELL_W / 2
  }

  const cy = ROW_H / 2

</script>

<svg
  width={svgWidth}
  height={ROW_H}
  class="graph-svg"
>
  {#each cells as cell}
    {@const x = cx(cell.col)}
    {@const color = laneColor(cell.lane)}

    {#if cell.char === '│'}
      <line x1={x} y1={0} x2={x} y2={ROW_H}
        stroke={color} stroke-width={LINE_W} opacity={LINE_OPACITY} />

    {:else if cell.char === '~'}
      <line x1={x} y1={0} x2={x} y2={ROW_H}
        stroke={color} stroke-width={LINE_W}
        stroke-dasharray="2 3" opacity={ELIDED_OPACITY} />

    {:else if cell.char === '─'}
      <line x1={x - CELL_W / 2} y1={cy} x2={x + CELL_W / 2} y2={cy}
        stroke={color} stroke-width={LINE_W} opacity={LINE_OPACITY} />

    {:else if cell.char === '├'}
      <!-- Trunk line uses cell's lane; branch stub uses lane+1 -->
      <line x1={x} y1={0} x2={x} y2={ROW_H}
        stroke={color} stroke-width={LINE_W} opacity={LINE_OPACITY} />
      <line x1={x} y1={cy} x2={x + CELL_W / 2} y2={cy}
        stroke={laneColor(cell.lane + 1)} stroke-width={LINE_W} opacity={LINE_OPACITY} />

    {:else if cell.char === '┤'}
      <!-- Trunk line uses cell's lane; branch stub uses lane-1 -->
      <line x1={x} y1={0} x2={x} y2={ROW_H}
        stroke={color} stroke-width={LINE_W} opacity={LINE_OPACITY} />
      <line x1={x - CELL_W / 2} y1={cy} x2={x} y2={cy}
        stroke={laneColor(cell.lane - 1)} stroke-width={LINE_W} opacity={LINE_OPACITY} />

    {:else if cell.char === '╮'}
      <path d="M {x - CELL_W / 2} {cy} Q {x} {cy} {x} {ROW_H}"
        fill="none" stroke={color} stroke-width={LINE_W} opacity={LINE_OPACITY}
        stroke-linecap="round" />

    {:else if cell.char === '╯'}
      <path d="M {x} {0} Q {x} {cy} {x - CELL_W / 2} {cy}"
        fill="none" stroke={color} stroke-width={LINE_W} opacity={LINE_OPACITY}
        stroke-linecap="round" />

    {:else if cell.char === '╭'}
      <path d="M {x + CELL_W / 2} {cy} Q {x} {cy} {x} {ROW_H}"
        fill="none" stroke={color} stroke-width={LINE_W} opacity={LINE_OPACITY}
        stroke-linecap="round" />

    {:else if cell.char === '╰'}
      <path d="M {x} {0} Q {x} {cy} {x + CELL_W / 2} {cy}"
        fill="none" stroke={color} stroke-width={LINE_W} opacity={LINE_OPACITY}
        stroke-linecap="round" />

    {:else if NODE_CHARS.has(cell.char)}
      <g>
        <!-- Lane-line continuity: two segments at LINE_OPACITY so the joint
             with adjacent │ rows is seamless (was a single 0.2-opacity line
             that dimmed at every node + showed through hollow @/◌). -->
        <line x1={x} y1={0} x2={x} y2={cy - NODE_GAP}
          stroke={color} stroke-width={LINE_W} opacity={LINE_OPACITY} />
        <line x1={x} y1={cy + NODE_GAP} x2={x} y2={ROW_H}
          stroke={color} stroke-width={LINE_W} opacity={LINE_OPACITY} />

        {#if cell.char === '@'}
          <!-- Working copy: amber concentric circle (matches sidebar icon) -->
          <circle cx={x} cy={cy} r={WC_R + 1} fill="none"
            stroke="var(--amber)" stroke-width={1.8} />
          <circle cx={x} cy={cy} r={2.5} fill="var(--amber)" />

        {:else if cell.char === '◆'}
          <!-- Immutable: dimmer than normal nodes -->
          <rect x={x - 3.5} y={cy - 3.5} width={7} height={7}
            rx={1} fill={color} opacity={0.5}
            transform="rotate(45 {x} {cy})" />

        {:else if cell.char === '×'}
          <!-- Conflict: semantic red, no graph opacity. r=WC_R makes it stand
               out over normal ○ nodes (NODE_R) without dominating @ (WC_R+1). -->
          <circle cx={x} cy={cy} r={WC_R} fill="var(--red)" />
          <!-- Diagonals opt out of crispEdges (would stair-step) -->
          <line x1={x - 2.5} y1={cy - 2.5} x2={x + 2.5} y2={cy + 2.5}
            stroke="var(--base)" stroke-width={1.5} shape-rendering="auto" />
          <line x1={x + 2.5} y1={cy - 2.5} x2={x - 2.5} y2={cy + 2.5}
            stroke="var(--base)" stroke-width={1.5} shape-rendering="auto" />

        {:else if cell.char === '◌'}
          <!-- Hidden: subtler than normal nodes -->
          <circle cx={x} cy={cy} r={NODE_R - 0.5}
            fill="none" stroke={color} stroke-width={1.2} opacity={0.35} />

        {:else}
          <!-- Normal node (○): graph palette with node opacity -->
          <circle cx={x} cy={cy} r={NODE_R} fill={color} opacity={NODE_OPACITY} />
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
  /* Snap straight lines to the pixel grid. Scoped to <line> only —
     paths (curves) and circles stay anti-aliased or they'd look jagged. */
  .graph-svg line {
    shape-rendering: crispEdges;
  }
</style>
