# jj Divergence — Taxonomy & Resolution Design

Stress-tested 2026-03-04. See "Failed heuristics" for what NOT to use.

## What divergence is

A **divergent change** = one change_id, 2+ visible commit_ids. Happens when a commit is rewritten and the old version stays visible (not hidden by the rewrite).

**Visibility is the only trigger.** `jj undo` and `jj op restore` do NOT cause divergence — they replace the view wholesale, so the rewritten commit becomes hidden. Only op-log **merges** produce divergence: `fetch` (remote rewrote independently) or `--at-op` (you rewrote from a pinned stale view).

### `/N` offset ordering — NOT timestamp

`xyz/0` = lowest offset = most recently **inserted into jj's index** (`lib/src/index.rs:217-221`, `GlobalCommitPosition` descending). This is "when jj learned about the commit", not `committer_ts`. A fetch can bring in a commit with newer committer_ts that gets `/1` because the local rewrite was indexed first. **Do not sort by committer_ts to match jj's `/N`.** Use the order `jj log -r 'change_id(X)'` emits them (that IS index order).

## Empirical findings

### Large large repo case study (2026-03-04)

- **42** divergent change_ids, **4 mutable**. The 38 immutable are old trunk rewrites. Immutable divergence **never clears** — both copies are ancestors of visible heads, `jj util gc` only prunes unreachable. Filter `& mutable()` in the UI revset and never show them.
- The 4 mutable form **one 4-change stack × 2 copies**. Inter-stack tree diff: 2 files, +3/-2 — `/0` has edits `/1` doesn't.
- `contained_in("::working_copies()")` correctly discriminates: all of `/0` = Y, all of `/1` = N.
- `/1`'s tip has a non-divergent child (an automated warm-merge) pinning the stack visible.
- One **4-way immutable**: 2 share a parent, 2 don't → concurrent edit that later rebased twice. 2×2 product.

### `--at-op` forced concurrent rewrite (scratch repo)

- Two copies, **same parent**, tree-identical (0-file diff), descriptions differ
- `committer_ts` on the `--at-op` copy is **newer** — `--at-op` stamps `now()`, not at-op-time

### `jj abandon` resolves single-level divergence

Abandoning one copy immediately makes the survivor non-divergent (`index.rs:245-247`: `is_divergent()` = count-of-visible > 1). **Stack-inherited divergence does NOT auto-resolve** — abandoning the root auto-rebases only ONE of its two children. The full losing stack must be abandoned.

## Discriminators (the ones that work)

| Signal | Template | Meaning |
|---|---|---|
| **Parents match?** | `parents.map(\|p\| p.commit_id()).join(",")` — compare client-side | Same → both rewrote from same base (concurrent edit). Different → one was rebased. |
| **Tree delta empty?** | `api.diffRange(v1, v2)` | Empty → only metadata differs. Non-empty → content at stake. |
| **WC-reachable?** | `if(self.contained_in("::working_copies()"), "1", "")` | See "jj edit inversion" below — must be guarded. |

### `::working_copies()` guard — the `jj edit` inversion

The WC-reachable signal means "ancestors of wherever `@` sits right now", NOT "the version you've been iterating on". If the user runs `jj edit xyz/1` to inspect the stale version (the single most natural reaction to seeing a divergence warning), the signal inverts: `/1` becomes WC-reachable, `/0` doesn't.

**Suppression rule:** if `working_copies() & change_id(X)` is non-empty — i.e., `@` IS one of the divergent versions — the signal is tautological. Strip it. Show neutral badges.

Without the guard, the UI would recommend keeping whichever version the user most recently clicked on.

## Failed heuristics (do not use)

| Heuristic | Why it fails |
|---|---|
| **Later `committer_ts` = intentional** | `--at-op` stamps `now()`, so it's ALWAYS the newer ts, and it's ALWAYS the rewrite from the oldest view. Structurally inverted, not clock skew. Plus clock skew across workspaces/machines is also possible. |
| **commit_id sort matches jj's `/N`** | `/N` is index-insertion order (`GlobalCommitPosition`). commit_id is a content hash — unrelated. `DivergencePanel.svelte:62` currently sorts by commit_id → will mislabel. |
| **Tree delta has files outside `fileUnion` → trunk noise → reclassify as pure rebase** | One-bit test poisons a multi-file delta. If trunk touched one unrelated file AND the stale version has a real edit, the real edit gets classified as "trunk noise" too. Correct: **subtract** outside-fileUnion files from the delta, then check if remainder is empty. |
| **"Will clear on its own" for immutable** | Never clears. Trunk ancestry is permanent. |

## Taxonomy

| Parents | Tree Δ | Kind | Safe auto-action? |
|---|---|---|---|
| Same | empty | **Metadata drift** | No — can't tell which description was the intended one. Show both, single-click per side. |
| Same | non-empty | **Edit conflict** | No — both may have wanted changes. Show diff, manual pick. |
| Different | empty | **Pure rebase** | Weak yes — trees identical, question is which trunk point. "Fresher trunk" = parent closer to `trunk()`. |
| Different | non-empty (after subtracting outside-`fileUnion` files) | **Rebase + edit** | No — WC-reachable is a hint (when not tautological), but warn on content delta. |
| Different | empty after subtraction | **Pure rebase** (misfiled above) | See row 3. |
| Mixed (N>2 copies) | — | **Compound** | No — group by parent, recurse into 2-way subcases. |

**No case is "High confidence, zero content at risk" for one-click auto-resolve.** The safest thing a UI can do is show the right information and make the right action one click — not pick the side.

## Stack detection

Change X is **stack-inherited** if `parent(X/0).change_id == parent(X/1).change_id` AND that parent is itself divergent. Walk up until parents don't share a change_id = divergence root. Resolve the whole chain as one unit (abandoning the root alone doesn't cascade — verified empirically).

```
findRoot(C):
  v0, v1 = versions of C  # index order — use jj's emission order, not ts-sort
  p0, p1 = v0.parents[0], v1.parents[0]
  if p0.change_id == p1.change_id and p0.divergent:
    return findRoot(p0.change_id)
  return C

stacks = groupBy(mutableDivergentChanges, findRoot)
```

**Gap:** assumes single-parent commits. Divergent merges need full parent-set comparison.

## Collateral — what "Keep A" must also do

### 1. Non-divergent descendants of the losing stack

Revset: `(stale_root::):: ~ ::keeper_tip ~ divergent()` — finds them correctly. But **do not silently abandon**:

- If all found descendants are `empty` → abandon without prompt (warm-merge noise)
- If ANY is non-empty → enumerate in a confirm modal: `"This will also abandon: abc12345 'fix the thing' (+340/-12)"` with [Abandon anyway] / [Rebase onto keeper tip instead]. The latter is usually what the user wants — `jj rebase -s <descendant> -d <keeper_tip>` before the abandon.

### 2. Conflicted bookmarks

`jj bookmark set <name> -r <keeper_version_of_same_change_id>` — NOT `<keeper_tip>`. A bookmark on the stack's middle commit (change_id B) should repoint to B's keeper, not jump to D. Map by change_id.

## Implementation (shipped 2026-03-05)

- Template/parser: `internal/jj/divergence.go` — 10 fields, NO `committer.timestamp` (see §"Failed heuristics")
- Endpoint: `GET /api/divergence` (`handlers.go`)
- Classifier: `frontend/src/lib/divergence.ts` — `classify()` + `alignColumns()` + `refineRebaseKind()`
- Panel: `DivergencePanel.svelte` — unified column rendering for stack AND single; `{#key changeId}` in parent enforces single-mount
- 29 frontend tests, 9 backend

### Column alignment (found during review, not in initial design)

`findRoot` checks parent **change_ids** match, but `/N` emission is per-commit index position. A 4-step rebase-then-describe sequence produces crossed columns: `A/0=A₂, A/1=A₁, B/0=B₃(parent A₁), B/1=B₂(parent A₂)`. Without alignment, `buildPlan(0)` keeps `{A₂, B₃}` but abandons B₃'s parent — jj auto-rebases B₃ onto trunk, silently wrong. `alignColumns()` permutes by parent **commit_id**; returns `null` on arity mismatch or non-bijective mapping → `alignable: false` → panel disables Keep.

## Open questions

- **Divergent merge commits** — `parents[0]` comparison is wrong. Compare full parent sets? Rare enough to punt.
- **"Fresher trunk" for pure-rebase recommendation** — `parent.contained_in("::trunk()")` one-bit check: if one parent is in trunk ancestry and the other isn't, the in-ancestry one is stale (trunk moved past it). Both in ancestry → need ancestor-distance. Not implemented; pure-rebase just shows "trees identical, either is safe" without picking.
- ~~**"Rebase onto keeper" in non-empty-descendant confirm**~~ — shipped. `jj rebase -s <roots> -d <keeper_tip>` before abandon. `g.descendants` is roots-only by classifier construction (only entries whose parent is in the divergent set), so `-s` flattening can't happen — `-s D1` pulls its chain, D2-on-D1 never enters the set.
