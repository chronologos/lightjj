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
