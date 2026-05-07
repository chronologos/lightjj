# Hunk: ideas worth porting to lightjj

Notes from a study of [`hunk`](https://github.com/modem-dev/hunk) (`~/Documents/repos/hunk` locally), a TUI diff reviewer built on Bun + OpenTUI + Pierre. Hunk solves the same product problem we do (interactive diff review) under tighter constraints, so several of its architectural commitments map cleanly onto lightjj.

This is a study + proposal doc, not a plan-of-record. Each section ends with a concrete "for lightjj" takeaway.

---

## 1. Unified render plan + measured geometry

Hunk produces, per file:

1. `PlannedReviewRow[]` — the immutable presentation order: diff rows, inline notes, guide caps. Each row carries a `key` (rendering identity) AND a `stableKey` + `stableAliasKeys[]` (lookup identity that survives split↔stack). Built by `buildReviewRenderPlan` in `src/ui/diff/reviewRenderPlan.ts:325`.
2. `DiffSectionGeometry` — `{bodyHeight, hunkAnchorRows, hunkBounds, rowBounds, rowBoundsByKey, rowBoundsByStableKey}`. Built by `measureDiffSectionGeometry` in `src/ui/lib/diffSectionGeometry.ts:94`.

Everything reads from these: rendering, scroll-anchoring, hunk navigation, mouse hit-testing. `src/ui/lib/viewportAnchor.ts:14` does a binary search over `rowBounds` to translate `scrollTop ↔ stableKey` and accepts a `preferredStableKey` so split rows that map to two stack rows keep the same logical side under the cursor across a layout toggle.

Hunk's `AGENTS.md` calls this out explicitly:

> Prefer one source of truth for each user-visible behavior. When rendering, navigation, scrolling, or note placement share the same model, derive them from the same planning layer rather than maintaining parallel implementations.

### For lightjj

We sidestep this with a fixed 18px row height — works today, but pays interest already:

- **Split↔unified toggle** in `DiffPanel` resets scroll-to-top because there's no stable line ID.
- **Context expansion** (`expandGaps` in `context-expand.ts`) shifts every line below the reveal point; `gapMap` tracks indices but the diff scroll position isn't anchored to a stable line ID.
- **Tab restore** (`AppShell.svelte`) preserves `diffScrollTop` as a raw pixel offset — fine when nothing else changed, breaks if the layout differs between snapshot and restore.
- Any future word-wrap on `.diff-line` invalidates the 18px assumption and we'd be forced to build geometry anyway.

**Minimum viable port:** every rendered diff line carries `data-stable-key="line:<file>:<side>:<lineNum>"`. Before any layout transition (split↔unified, context expand, tab switch), capture the topmost visible row's `data-stable-key` and the per-row scroll offset; afterwards, look it up via `querySelector` and restore. ~30 lines, no measured-geometry table needed.

**Larger port (if/when we add wrap or variable-height rows):** build an explicit `DiffSectionGeometry`-style table per file once after layout, binary-search for anchor lookups. Cache by content key + layout flags exactly like Hunk does.

---

## 2. Hunk-level navigation as first-class

`src/ui/lib/hunks.ts:10` flattens visible files into a single `HunkCursor[] = {fileId, hunkIndex}[]`. `[` / `]` traverse it across files; `{` / `}` traverse only annotated hunks (`useAppKeyboardShortcuts.ts:364`).

The reveal-scroll math is a small pure function (`hunkScroll.ts:7`):

```ts
computeHunkRevealScrollTop({hunkTop, hunkHeight, viewportHeight, padding}) {
  // if the hunk fits, show all of it; otherwise bias to top-with-padding
}
```

Tested in isolation. No dependency on the rendering layer.

### For lightjj

`[` / `]` are unbound in normal mode (we use them inside MergePanel for block nav, but that's mode-scoped). Hunk-step navigation across the visible diff is genuinely missing — to skim a 50-file diff you currently scroll line-by-line or jump file-to-file.

Compose from existing `parsedDiffs`:

```ts
// frontend/src/lib/diff-cursor.ts (new, ~40 lines)
export type HunkCursor = { file: string; hunkIdx: number };
export function buildHunkCursors(parsed: ParsedDiff[]): HunkCursor[];
export function findNextHunkCursor(cursors, current, delta): HunkCursor | null;
export function computeHunkRevealScrollTop(input): number;
```

Wire `[`/`]` in App.svelte's `routeKeydown` after the existing `inlineNav` priority. `{`/`}` for "next hunk with annotation" naturally piggybacks on `annotations.svelte.ts`.

---

## 3. Keyboard alias normalization

`src/ui/lib/keyboard.ts` is tiny but well-engineered:

```ts
export function isPageDownKey(key) {
  return key.name === "pagedown" || (!key.shift && isSpaceKey(key))
       || key.name === "f" || key.sequence === "f";
}
```

Pager users get `Space`/`f`/`b`/`d`/`u`/`Shift+Space`; arrow users get `ArrowDown`/`ArrowUp`; vim users get `j`/`k`. **All three populations share the same routing layer.** `useAppKeyboardShortcuts.ts:115` then has a `handlePagerShortcut` mode for when Hunk is wired up as `git core.pager` and exposes a less-compatible subset.

### For lightjj

Our `keyboard-gate.ts` does priority routing well, but the canonical-key alias layer is missing — we hard-code `key === "j"` etc. in App.svelte. If a less-style user wants `f`/`b` for page nav, we'd reach into keyboard-gate and add per-handler aliases.

**Port:** add `frontend/src/lib/key-aliases.ts` exporting pure predicates `isStepDownKey`, `isPageDownKey`, `isHalfPageDownKey` etc. `keyboard-gate.ts` callers swap `e.key === "j"` for `isStepDownKey(e)`. Free pager-style for vim refugees.

---

## 4. Mouse-wheel acceleration

`src/ui/lib/scrollAcceleration.ts:9` opts into `MacOSScrollAccel({A: 0.4, tau: 4, maxMultiplier: 3})` — first tick precise, sustained gestures ramp up to 3× with exponential decay. Comment explicitly rejects "scale by total diff size" because it makes short diffs feel unstable.

### For lightjj

Browsers + OS already implement scroll-wheel acceleration, so this is mostly free for us. The transferable idea: held-key acceleration for `j`/`k` repeat. Detect a sustained burst, bump revision delta from 1 to 2 or 3 once a threshold is exceeded. Probably not worth shipping on its own; flagging because it's the kind of detail Hunk's reviewers notice.

---

## 5. Cache key from content fingerprint, not just identity

`src/ui/diff/useHighlightedDiff.ts:63`:

```ts
function patchFingerprint(file) {
  const mid = Math.floor(patch.length / 2);
  return `${patch.length}:${patch.slice(0, 64)}:${patch.slice(mid, mid+64)}:${patch.slice(-64)}`;
}
```

LRU-by-insertion-order, MAX 150 entries, and `commitHighlightResult` checks "is the in-flight promise still the active one for this key?" — same race-safety as our generation counters, localized to the cache mutator instead of the consumer.

`SHARED_HIGHLIGHT_PROMISES` also dedupes concurrent requests for the same key.

### For lightjj

We're already better here — `commit_id` is a real content hash and we cache by it. Worth noting: if we ever add prefetch from two places (RevisionGraph + DiffPanel both racing for the next revision), `api.diff` doesn't currently dedupe in-flight requests for the same key. `createLoader` is the only fetcher today so this is moot, but a `pendingByKey` Map in `api.ts` would prevent the duplicate when it arises.

---

## 6. Agent review architecture

This is the most transferable architectural idea, and the one most worth implementing in lightjj.

### Hunk's shape

```
agent terminal ──▶ `hunk session navigate --repo . --file foo.ts --hunk 2`
                              │
                              ▼
              loopback daemon (hunk daemon serve)
                              │
                              ▼
                     live TUI window  ◀── user is reviewing
```

### Architectural commitments (`src/session/protocol.ts:35`)

- **Out-of-process agent.** The agent runs in a separate terminal, doesn't share memory with the TUI, talks to the daemon over loopback HTTP.
- **Tiny verb set:** `list`, `get`, `context`, `review`, `navigate`, `reload`, `comment-add`, `comment-apply`, `comment-list`, `comment-rm`, `comment-clear`. That's it.
- **Strict input shapes.** `navigate` requires `--file` plus exactly one of `{--hunk, --new-line, --old-line}`. The CLI rejects ambiguous combinations before they hit the daemon. `SessionDaemonRequest` is a discriminated union with exact field requirements per action.
- **Batch path with stdin JSON.** `comment apply --stdin` validates the *whole* batch before mutating anything. Critical for agents — a partial failure halfway through would leave inconsistent state.
- **`--focus` flag** to optionally steer the user's viewport to the comment that was just added. Sometimes the agent wants to draw attention; sometimes it just wants to leave a trail. Default is "don't steal focus".
- **Skill-as-contract.** `skills/hunk-review/SKILL.md` is the only documented agent interface. It explicitly tells the agent "don't run interactive `hunk diff`; use `hunk session ...`".
- **Default-low-bandwidth.** `review --json` returns file/hunk *structure* only. `--include-patch` is opt-in for when the agent actually needs raw diff text. Critical for agent context economy.

### Why this shape is right

The agent doesn't need to render anything. It needs to:

1. Find out what's currently loaded.
2. Move the user's eyeballs.
3. Leave annotations.
4. Optionally swap the diff being reviewed.

That's exactly Hunk's verb set, and the user keeps total visual control.

### Mapping to lightjj

We already have most of the infrastructure:

| Hunk concept                              | lightjj equivalent                                                                       |
|-------------------------------------------|------------------------------------------------------------------------------------------|
| `hunk daemon serve` (loopback HTTP)       | `cmd/lightjj/main.go` HTTP server (always loopback by default)                           |
| Live TUI registers with daemon            | Single SPA per backend — no broker needed                                                |
| `hunk session navigate`                   | Doesn't exist; SPA has `selectByChangeId` but nothing CLI-callable                       |
| `hunk session comment add/apply`          | `POST /api/annotations/...` exists; CLI doesn't                                          |
| `hunk session reload -- diff main..feat`  | Closest: switching tabs / setting revset filter. No "show this revset" mutation.         |
| `--agent-context notes.json` sidecar      | Annotations are server-stored per-changeId; persistent agent notes Just Work             |
| Skill markdown                            | We don't ship one                                                                        |
| SSE-driven UI updates                     | `watcher.go` already broadcasts; frontend already reconnects                             |

### Minimum viable design for lightjj

1. **`lightjj session` CLI subcommand** in `cmd/lightjj/main.go` that POSTs to a running instance. Discover via a session registry at `~/.config/lightjj/sessions.json` (each launch writes `{pid, port, repoRoot}`; `lightjj session ...` reads it; stale entries swept on startup) or a `--addr` flag for explicit targeting.

2. **Verbs to start with:**
   - `lightjj session list` — read registry, return live sessions.
   - `lightjj session get [--repo .] [--json]` — current state: changeId, revset filter, file the user is on.
   - `lightjj session diff [--include-patch] [--json]` — structure-only by default (file list + add/del counts from `FilesTemplate`); patch text opt-in.
   - `lightjj session navigate --change <changeId> [--file F] [--line N]` — equivalent to clicking a row in RevisionGraph; backend pushes via SSE.
   - `lightjj session annotate add --change C --file F --line N --severity X --body ...` — wraps `POST /api/annotations/{changeId}`.
   - `lightjj session annotate apply --stdin` — JSON batch, validate-all-then-write. Mirror Hunk's "no partial application" guarantee.
   - `lightjj session annotate clear [--file F] --yes` — bulk cleanup.

3. **SSE event for navigation.** `watcher.go` currently pushes op-id changes; add an `evNavigate` event so when the CLI says "navigate to changeId X", the frontend's SSE listener moves the cursor.

4. **`/api/session/*` HTTP family.** Strict request decoding (discriminated union, reject ambiguous fields at decode time, not handler time). All routes go through `runMutation`-style centralization.

5. **A skill file.** `skills/lightjj-review/SKILL.md` — same shape as Hunk's: workflow steps, command reference, common errors. The skill is the interface contract; anything not in the skill is implementation detail. Ship in the binary via `lightjj skill path` (or just install into `~/.claude/skills/`).

### Non-obvious choices to copy from Hunk

- **Locked-down request schema.** `SessionDaemonRequest` is a discriminated union with exact field requirements per action. Reject ambiguity at decode time, not handler time. lightjj already does this for some endpoints (`validateFlags` whitelist); the new `/api/session/*` family should be strict from day one.
- **`--focus` is opt-in.** Default is "leave a comment, don't move the user". The agent only steals focus when the comment itself is what the user needs to see.
- **One mutating verb per intent.** `comment add` is for one note, `comment apply` is for batches. Don't overload one endpoint to do both — easier for the agent to reason about, and the failure modes differ.
- **The skill is the spec.** When tempted to add a feature to make agents' lives easier, write the skill markdown first. If the workflow doesn't read cleanly in english, the API design is wrong.
- **Default to structural-only.** `review --json` without `--include-patch` is the difference between an agent integration that fits in 200K context and one that blows out after three calls.

### Where lightjj is structurally simpler than Hunk

Hunk has to invent a daemon because each TUI is a separate process — the broker brokers between many sessions. lightjj is already a daemon: the Go HTTP server backs every browser tab. **Skip the broker entirely.** The CLI POSTs directly to `127.0.0.1:<port>` from a session registry. Don't replicate complexity we don't need.

---

## Appendix: file references

For future-me looking up details:

- Render plan: `~/Documents/repos/hunk/src/ui/diff/reviewRenderPlan.ts:325`
- Geometry: `~/Documents/repos/hunk/src/ui/lib/diffSectionGeometry.ts:94`
- Viewport anchor (binary search + preferredStableKey): `~/Documents/repos/hunk/src/ui/lib/viewportAnchor.ts:14`
- Hunk cursors: `~/Documents/repos/hunk/src/ui/lib/hunks.ts:10`
- Reveal scroll math: `~/Documents/repos/hunk/src/ui/lib/hunkScroll.ts:7`
- Keyboard alias predicates: `~/Documents/repos/hunk/src/ui/lib/keyboard.ts`
- Highlight cache w/ content fingerprint: `~/Documents/repos/hunk/src/ui/diff/useHighlightedDiff.ts:63`
- Agent CLI verb surface (skill): `~/Documents/repos/hunk/skills/hunk-review/SKILL.md`
- Daemon HTTP protocol: `~/Documents/repos/hunk/src/session/protocol.ts:35`
- Live comments resolution: `~/Documents/repos/hunk/src/core/liveComments.ts`
- Architectural rules (good read in full): `~/Documents/repos/hunk/AGENTS.md`
