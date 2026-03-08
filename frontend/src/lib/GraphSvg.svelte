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
  const LINE_W = 1.5  // lane line stroke width
  const GRAPH_COLORS = 8  // number of --graph-N vars in theme.css

  // Opacity tiers per design language (Tier 3: muted, decorative)
  const LINE_OPACITY = 0.45
  const NODE_OPACITY = 0.8
  const ELIDED_OPACITY = 0.3
  const BG_OPACITY = 0.2

  const NODE_CHARS = new Set(['@', '○', '◆', '×', '◌'])

  let palette: string[] = $state(Array(GRAPH_COLORS).fill('#888'))
  let paletteDark: boolean | undefined // sentinel: undefined = never read

  function refreshPalette(isDark: boolean) {
    if (paletteDark === isDark) return
    paletteDark = isDark
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
    isNode: boolean
    isWorkingCopy: boolean
    isImmutable: boolean
    isConflicted: boolean
    isDivergent: boolean
    isHidden: boolean
    gutterWidth: number
    isDark: boolean
  }

  let {
    gutter, isDivergent, gutterWidth, isDark,
    // Remaining props are passed by the parent but unused here — the gutter
    // character itself encodes node type (@, ◆, ×, ◌, ○). Kept in the
    // interface for API completeness; destructured to suppress Svelte warnings.
    isNode: _isNode, isWorkingCopy: _isWorkingCopy, isImmutable: _isImmutable,
    isConflicted: _isConflicted, isHidden: _isHidden,
  }: Props = $props()

  // Must use $effect (not $derived): the .light class toggle happens in an
  // $effect in App.svelte — $derived would read stale CSS vars. refreshPalette
  // no-ops if paletteDark === isDark, so only the first instance mounted
  // after a theme change does actual work.
  $effect(() => refreshPalette(isDark))

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
  let svgWidth = $derived(gutterWidth * CELL_W)

  function cx(col: number): number {
    return col * CELL_W + CELL_W / 2
  }

  const cy = ROW_H / 2

  // Contrast color for glyphs rendered on top of semantic-colored nodes
  let contrastFill = $derived(isDark ? '#0f0f13' : '#f8f8f6')
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
        <!-- Background lane line for continuity -->
        <line x1={x} y1={0} x2={x} y2={ROW_H}
          stroke={color} stroke-width={LINE_W} opacity={BG_OPACITY} />

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
          <!-- Conflict: semantic red, no graph opacity -->
          <circle cx={x} cy={cy} r={NODE_R} fill="var(--red)" />
          <line x1={x - 2} y1={cy - 2} x2={x + 2} y2={cy + 2}
            stroke={contrastFill} stroke-width={1.5} />
          <line x1={x + 2} y1={cy - 2} x2={x - 2} y2={cy + 2}
            stroke={contrastFill} stroke-width={1.5} />

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
</style>
