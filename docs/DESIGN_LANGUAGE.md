# lightjj Design Language

## Principle: Color = Meaning, Shape = Type

Every color in the UI carries **semantic meaning**. Entity types (bookmarks, workspaces, PRs) are distinguished by **icons and typography**, not by unique hues.

---

## Tier 1: Semantic Core (4 colors only)

### Amber — Active / Changed / Brand
- Dark: `#ffa726` · Light: `#e68a00`
- Uses: brand accent, active/selected states, modified files, change IDs, working copy indicator, primary buttons, interactive elements

### Green — Added / Positive
- Dark: `#66bb6a` · Light: `#2e7d32`
- Uses: added files/lines, diff additions, synced/up-to-date status, success states, resolved conflicts

### Red — Removed / Negative
- Dark: `#ef5350` · Light: `#c62828`
- Uses: deleted files/lines, diff deletions, conflicts (both sides), errors, destructive actions

### Blue — Informational
- Dark: `#6880b8` · Light: `#4860a0`
- Uses: behind-sync status dot, question-severity annotations, informational (non-actionable) state

---

## Tier 2: Entity Badges — Neutral, distinguished by shape

Bookmarks, workspaces, and PRs are entity **types**, not semantic states. Icons and typography distinguish them — not color.

### Default badge (inactive)
- Background: `var(--surface0)`
- Border: `var(--surface1)`
- Text: `var(--subtext0)`
- Examples: `⑂ main`, `◇ default`, `↗ #142`

### Active badge (current)
- Background: `var(--bg-selected)` (amber soft tint)
- Border: amber at 20% opacity
- Text: `var(--amber)`

| Entity | Icon | Inactive | Active |
|--------|------|----------|--------|
| Bookmark | `⑂` | Neutral bg + neutral text | Amber tint bg + amber text |
| Workspace | `◇` | Neutral bg + neutral text | Amber tint bg + amber text |
| PR | `↗` | Neutral bg + neutral text | Amber tint bg + amber text |

---

## Tier 3: Graph Palette — Isolated and Muted

The revision graph uses multiple colors to distinguish parallel branches:

- **Muted** (~60% saturation) so they don't compete with semantic tier
- **Reduced opacity**: lines at `0.45`, nodes at `0.8`
- **Never amber, green, or red** — avoids confusion with semantic meaning
- **Never used outside the graph** — purely decorative

8 graph colors (dark/light):
- Ochre, Terra, Mauve, Plum, Slate, Teal, Moss, Olive

---

## Component Primitives

Shared UI primitives live in `theme.css` (global scope, not Svelte-scoped). Component CSS adds only layout/positioning overrides. Don't redefine these per-component.

## Theme system

`theme.css` is two layers:
- **~50 derived vars** in plain `:root` via `color-mix()` from primaries — theme-agnostic. `--bg-selected: color-mix(in srgb, var(--amber) 8%, transparent)` etc.
- **~32 primaries** per `:root[data-theme="X"]` block: base/mantle/crust/surface2/overlay0-1/subtext0-1/text + amber/green/red/blue/mauve/lavender + graph-0..7 + syn-* + backdrop/shadow-heavy.

Adding a builtin theme = one `:root[data-theme="X"]` block (~14 lines packed) + a `THEMES` entry in `themes.ts`. The 486 Ghostty themes are NOT CSS-baked — they ship as raw `{bg, fg, p[16]}` and `deriveTheme()` computes primaries at selection time, injected via `<style id="ghostty-theme-vars">`. Builtins exist for zero-FOUC first paint (the `:root` default is dark; ghostty themes need a chunk fetch before they can apply).

When adding a derived var, put it in the `:root` block as `color-mix(in srgb, var(--<primary>) N%, ...)` — NOT a per-theme hex. Per-theme hex means every new theme must define it; color-mix means zero work per theme.

### Buttons

| Class | Look | Use |
|---|---|---|
| `.btn` | Ghost (border-only, fills on hover) | Default action |
| `.btn.btn-sm` | Compact padding | Toolbars, inline actions |
| `.btn.btn-primary` | Filled amber | Primary/confirm action |
| `.btn.btn-danger` | Red outline → fill on hover | Destructive action |
| `.btn.btn-success` | Green tinted → fill on hover | Completes a workflow (Save in merge, Keep in divergence) |

### Segmented toggle

`.seg` container + `.seg-btn` children + `.active` modifier. Amber active state.

### Panel & modal chrome

| Class | |
|---|---|
| `.panel-header` | Top bar of a panel (flex, border-bottom) |
| `.panel-title` | Panel header text |
| `.modal-backdrop` | Full-screen dimmer |
| `.modal` | Centered dialog box |
| `.modal-header` | Modal title bar |
| `.modal-input` | Text input inside a modal |

### Misc

| Class | |
|---|---|
| `.close-btn` | Borderless × dismiss button |
| `.placeholder-text` | Dimmed italic "(no description)" |
| `.nav-hint` | `<kbd>` badge for keyboard shortcuts |

### Known collisions (deferred)

`StatusBar .mode-badge` and `RevisionGraph .mode-badge` share a class name with different semantics (amber-filled vs base+modifiers). Rename one before any global extraction.

---

## Conflicts: Both sides red

Both conflict sides use **red** — because conflict = needs attention = red.
- Side A (current): full red intensity
- Side B (incoming): muted red (50% opacity border, reduced background)
- Distinguish by **label text** and **border weight**

---

## Quick Reference

```
SEMANTIC (use everywhere):
  Amber  = active, changed, modified, brand, selected
  Green  = added, positive, synced, success
  Red    = deleted, negative, conflict, error

BADGES (entity types — neutral by default):
  ⑂ Bookmark  → neutral bg, amber if active
  ◇ Workspace → neutral bg, amber if active
  ↗ PR        → neutral bg, amber if active

GRAPH (isolated, decorative only):
  8 muted colors, 0.45 opacity lines, 0.8 opacity nodes
  Never amber/green/red. Never used outside the graph.
  Exception: semantic nodes (@=amber, ×=red) use Tier 1 colors at full opacity.

DIFF:
  Added lines   → green bg + green text
  Removed lines → red bg + red text
  Word-level    → stronger green/red tint

CONFLICTS:
  Both sides    → red (side A stronger, side B muted)
  Boundary      → red (subtle) + label text
```
