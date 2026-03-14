# Plan: extract divergence actions from App.svelte

## Goal

First bite of the 2882-line App.svelte that doesn't touch the mode-state hairball. Drops ~65 lines. Also gets the rebase→abandon→bookmark **ORDER** (which the comment at `:1172-1179` says is load-bearing) under test — it currently isn't.

## The key observation

`runDivergenceResolution` (`:1152`) is the part with App-shell deps — `withMutation`, `divergence.cancel`, `setMessage`, `loadLog`, `showError`. It stays.

The **inner callbacks** it wraps are domain logic with zero App-state reads:

| Handler | Inner body deps | LOC |
|---|---|---|
| `handleKeepDivergent` | `api.rebase`, `api.abandon`, `api.bookmarkSet`, `plan` | 26 (13 of it is the ORDER comment) |
| `handleSplitDivergent` | `api.metaeditChangeId` | 7 |
| `handleSquashDivergent` | `api.squash` | 7 |
| `handleAbandonDivergent` | `api.abandon` | 7 |

These four already have the shape of a standalone module — they return `{text: string, results: MutationResult[]}`, `runDivergenceResolution` accepts exactly that. The wrapper was already the right abstraction; it's just sitting in the wrong file.

## Module family

`divergence.ts` → `classify()` + `buildKeepPlan()` — **plan** (pure)
`divergence-refined.ts` → `computeRefinedKind()` — **analyze** (pure)
`divergence-strategy.ts` → `recommend()` — **recommend** (pure)
**`divergence-actions.ts`** → `executeKeepPlan()` etc — **execute** (api.*, not pure)

## Shape

```ts
// frontend/src/lib/divergence-actions.ts
import { api, type MutationResult } from './api'
import type { KeepPlan } from './divergence'

export interface DivergenceActionResult {
  text: string
  results: MutationResult[]
}

export async function executeKeepPlan(plan: KeepPlan): Promise<DivergenceActionResult>
export async function splitIdentity(commitId: string): Promise<DivergenceActionResult>
export async function squashDivergent(from: string, into: string): Promise<DivergenceActionResult>
export async function abandonMutable(commitId: string): Promise<DivergenceActionResult>
```

Naming: `executeKeepPlan` mirrors `buildKeepPlan` — they're the two halves. `splitIdentity` / `abandonMutable` match the strategy names in `docs/jj-divergence.md` (Strategy 2 / immutable-sibling case) rather than the handler names.

## App.svelte after

```ts
// lines 1148-1167 — runDivergenceResolution stays, type tightened
async function runDivergenceResolution(run: () => Promise<DivergenceActionResult>) { ... }

// lines 1169-1234 → GONE. Replace with 4 one-liners OR inline at prop site:
```
```svelte
onkeep={plan => runDivergenceResolution(() => executeKeepPlan(plan))}
onsplit={id => runDivergenceResolution(() => splitIdentity(id))}
onsquash={(f, i) => runDivergenceResolution(() => squashDivergent(f, i))}
onabandon={id => runDivergenceResolution(() => abandonMutable(id))}
```

DivergencePanel props are `(x) => Promise<void>` (`DivergencePanel.svelte:11-21`); `runDivergenceResolution` returns `withMutation`'s `Promise<T | undefined>` which the panel `await`s at `:205-252` for `strategyBusy` sequencing — shape preserved.

## LOC

- **App.svelte**: −87 (block gone) + ~22 (wrapper stays + 4 prop-site inlines) = **−65**
- **divergence-actions.ts**: +~55 (includes the ORDER comment — it's load-bearing documentation)
- **divergence-actions.test.ts**: +~60

Net project: ~+50, but App.svelte drops 2882 → ~2817 and the call ORDER gets coverage.

## What moves verbatim

The `handleKeepDivergent` comment block (`:1171-1179`) is the spec:

> 1. Rebase — moves non-empty descendants to the keeper tip first. If abandon ran first, jj would auto-rebase D onto the loser-stack's parent (trunk); our explicit rebase would then hit a twice-rebased tree. -s (not -r) so D's descendants follow.
> 2. Abandon — losing columns + empty descendants.
> 3. Bookmarks — per-change_id repoint, not stack tip.
> Serial throughout: concurrent jj mutations → divergent op history.

Moves with the function. This is the kind of comment that decays if it's not next to the code it describes.

## Tests (`divergence-actions.test.ts`)

`vi.mock('./api')` for the `api` object. Same pattern as `OplogPanel.test.ts` (via `importOriginal` to preserve types).

- **`executeKeepPlan` call order**: rebase → abandon → bookmarkSet (the load-bearing invariant). Tracked via a shared `order: string[]` each mock pushes into.
- **`executeKeepPlan` with `rebaseSources: []`**: skip rebase, go straight to abandon (the `:1183` guard).
- **`executeKeepPlan` result accumulation**: `results[]` has one entry per api call (rebase's warnings shouldn't get lost — `:1180-1181` says divergence rebase is MORE likely than average to conflict).
- **`squashDivergent` / `splitIdentity` / `abandonMutable`**: single-call verification, `text` format.

## Imports to adjust

- `App.svelte:54`: `import type { KeepPlan }` — can drop if nothing else in App uses it (verify)
- `App.svelte`: add `import { executeKeepPlan, splitIdentity, squashDivergent, abandonMutable, type DivergenceActionResult } from './lib/divergence-actions'`
- `App.svelte:36`: `MutationResult` stays (used by `mutationMessage` + `runMutation`)

## Not in scope

- `mutationMessage` (`:907-917`) is pure and used 10× across App — separate extraction, orthogonal.
- `runDivergenceResolution` itself stays in App: wraps 5 App-state closures, would need a deps bag.
- `DivergencePanel` prop types unchanged — they already describe the composed shape.

## Risks

- **None structural.** The inner bodies already have zero App-state reads — this is a mechanical lift. The `{text, results}` return type is already the existing contract between the inner callback and `runDivergenceResolution`.
- **Test mock shape**: `api` is a flat object, not a class. `vi.mock('./api', async (orig) => ({...await orig(), api: {...mockedMethods}}))` — same as `OplogPanel.test.ts` did for `api.opShow`.
