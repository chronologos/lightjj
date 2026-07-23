// Bombadil spec for lightjj — LTL properties + action generators.
//
// Run via ./run.sh (creates fixture repo, starts server, invokes bombadil).
//
// Property design: each `always`/`eventually` encodes a class of bug the
// unit-test suite has historically missed — trap states (noModalTraps),
// layout regressions (rowsAlwaysEighteen), stale-state glitches
// (selectedIndexValid). Bombadil finds these by random action sequences
// the hand-written tests never tried.

// Bombadil 0.6.x module layout: the LTL operators live at the package root;
// the browser-typed extract/actions/weighted (State/Action-aware) and the
// default browser properties moved under `@antithesishq/bombadil/browser`.
import { always, eventually, next, now } from "@antithesishq/bombadil";
import { extract, actions, weighted } from "@antithesishq/bombadil/browser";

// Default PROPERTIES only — noHttpErrorCodes, noUncaughtExceptions,
// noUnhandledPromiseRejections, noConsoleErrors. NOT /browser/defaults/actions:
// the default reload/back/forward generators ate ~20% of action budget in the
// first spike; our own generators below give better exploration density.
export * from "@antithesishq/bombadil/browser/defaults/properties";

// -------------------------------------------------------------------------
// Extractors — DOM state snapshots. Each returns a Cell<T> that Bombadil
// re-reads after every action + DOM mutation.
// -------------------------------------------------------------------------

// Modal/panel overlays. `.panel` alone is too broad (DiffPanel,
// RevisionGraph are permanent .panel elements); the overlays we care about
// are dialogs + the slide-in/drawer panels + full-screen takeovers that
// sit above (or replace) the log view. `.doc-view` is the ProseMirror
// doc-mode editor (Escape closes it via App's `docEscape`); `.sym-card` is
// the ⌘+hover symbol-peek card (position:fixed, z-index:80 — a stuck one
// is a trap exactly like a modal). noModalTraps covers all of these.
const modalOpen = extract((s) =>
  s.document.querySelector(
    '[role="dialog"], .divergence-panel, .evolog-panel, .oplog-panel, ' +
    '.fh-root, .ctx-menu, .doc-view, .sym-card'
  ) !== null
);

// Selected revision index via data-entry attr. `.graph-row` appears once
// per flattened graph line; the node-row variant is the one carrying the
// selection class. -1 when nothing selected (initial load, empty revset).
const selectedIdx = extract((s) => {
  const el = s.document.querySelector(".graph-row.selected");
  return el ? Number(el.getAttribute("data-entry") ?? -1) : -1;
});

const revisionCount = extract((s) =>
  new Set(
    Array.from(s.document.querySelectorAll(".graph-row[data-entry]"))
      .map((el) => el.getAttribute("data-entry"))
  ).size
);

// .graph-row is the 18px-locked row. Virtualization means only ~viewport
// rows exist in the DOM; that's fine — we only need to check the ones
// that are rendered.
const rowHeights = extract((s) =>
  Array.from(s.document.querySelectorAll(".graph-row"))
    .map((el) => (el as HTMLElement).getBoundingClientRect().height)
);

// StatusBar mode indicator — lets us gate "inline mode active" without
// parsing App.svelte's internal state. `.mode-badge` only renders when
// rebase/squash/split is active (StatusBar's {#if} gates). It's StatusBar-
// only now — RevisionGraph's per-row "<< from >>"/"<< into >>" role markers
// use `.role-marker` (renamed v1.25.0 to kill the old name collision).
const inlineModeActive = extract((s) =>
  s.document.querySelector(".mode-badge") !== null
);

// Megamerge (M): mode-badge text is 'megamerge' only while editing a commit's
// parent set in place. A distinct extractor (not just inlineModeActive) lets
// the megamerge-specific properties gate precisely on that mode.
const megamergeActive = extract((s) =>
  s.document.querySelector(".mode-badge")?.textContent?.trim() === "megamerge"
);

// Count of destination/parent badges rendered in the graph. In megamerge EVERY
// row in the chosen parent set carries a `.role-marker.badge-target` (matched
// by commit_id); rebase/squash render at most one. Virtualization can hide
// off-screen in-set rows, so this is a LOWER bound on the true parent count —
// properties may assert rendered <= claimed, never equality.
const parentBadgeCount = extract((s) =>
  s.document.querySelectorAll(".badge-target").length
);

// StatusBar's authoritative selected-parent count ("N parent(s)"). Same render
// pass as the megamerge mode-badge (both under StatusBar's activeMode gate), so
// it reads consistent with megamergeActive. Leading integer; -1 when absent.
const mmParentCount = extract((s) => {
  const t = s.document.querySelector(".mm-parent-count")?.textContent ?? "";
  const n = parseInt(t, 10);
  return Number.isNaN(n) ? -1 : n;
});

// Rows that are BOTH a source (the commit being edited) and a parent — must
// always be zero: a commit can't be its own parent, and the source/target
// roles are mutually exclusive per row in every mode. The megamerge multi-badge
// model (parent set matched by commit_id against every row) is where a
// matching-logic slip would first surface.
const sourceTargetSameRow = extract((s) =>
  Array.from(s.document.querySelectorAll(".graph-row"))
    .filter((el) => el.querySelector(".badge-source") && el.querySelector(".badge-target"))
    .length
);

// MessageBar presence. `eventually dismissable` is the guarantee — an
// error that never clears is a trap for the user too.
const messageBarShown = extract((s) =>
  s.document.querySelector(".message-bar") !== null
);

// Change_id rendered in RevisionHeader (8 chars). null when no header
// (multi-check mode, DivergencePanel replaces DiffPanel, initial load).
const headerChangeId = extract((s) =>
  s.document.querySelector(".detail-change-id")?.textContent?.trim() ?? null
);

// Change_id of the selected graph row. .change-id span renders 12 chars +
// optional /N divergence offset; slice(0,8) matches header's truncation.
const selectedChangeId = extract((s) =>
  s.document.querySelector(".graph-row.selected .change-id")
    ?.textContent?.slice(0, 8) ?? null
);

// Number of open tabs. The tab strip (`.tab`) lives OUTSIDE the {#key} remount,
// so this is stable across tab switches. Used by tabCountMonotonic below.
const tabCount = extract((s) => s.document.querySelectorAll(".tab").length);

// The tab WORKSPACE menu is open — a `.ctx-menu` whose items include the `◇`
// per-workspace rows / "Add workspace" / "Update all". This is the ONLY context
// menu Bombadil can reach: every other ctx-menu surface (revision rows, bookmark
// badges, diff lines) is right-click-only, and Bombadil cannot right-click
// (antithesishq/bombadil#251). So a rendered `.ctx-menu` here is proof the
// LEFT-click `◇N` icon opened the workspace menu — the trace evidence the run
// asserts. (It's also an arm of modalOpen → noModalTraps guarantees it closes.)
const wsMenuOpen = extract((s) => {
  const menu = s.document.querySelector(".ctx-menu");
  if (!menu) return false;
  return Array.from(menu.querySelectorAll(".ctx-label"))
    .some((el) => (el.textContent ?? "").includes("◇") ||
                  (el.textContent ?? "").includes("workspace"));
});

// document.activeElement is a text input. The v1.12.1 bug class: focus
// stuck in the revset filter / search input → j/k route to the input via
// keyboard-gate's inInput slot, graph nav dead. The gate is correct; the
// bug is when nothing BLURS the input on submit/escape.
const focusInInput = extract((s) => {
  const a = s.document.activeElement;
  return a !== null && (
    a.tagName === "INPUT" || a.tagName === "TEXTAREA" ||
    (a as HTMLElement).isContentEditable
  );
});

// -------------------------------------------------------------------------
// Properties
// -------------------------------------------------------------------------

// Liveness guard — the app must actually mount and load revisions.
// Without this, a blank page (JS doesn't execute, API fails, etc.)
// vacuously satisfies every other property: rowHeights=[] → .every()
// passes, modalOpen=false → .implies() trivially true. This property
// fails fast so we don't burn 300s pressing keys into an empty <div>.
//
// revisionCount>0 proves both Svelte-mount AND API round-trip; a bare
// `.panel` check would miss the server-side-broken case. 5s is generous
// for a 12-commit localhost fixture — provided the binary actually serves
// the SPA. The May–June 2026 "appMounts timed out" runs were NOT this
// property being too tight: e2e.yml built the stub binary (missing
// `-tags embed`), so the page was a static help stub with zero rows. The
// fix is in the workflow, not this deadline.
export const appMounts = eventually(() =>
  revisionCount.current > 0
).within(5, "seconds");

// If a modal/drawer opens, random key-mashing (including Escape, weighted
// high below) eventually closes it. Catches: DivergencePanel Escape dead
// zone (v1.4.2 fix), focus-trap bugs where Escape fires but the wrong
// element has focus, and any future panel that forgets its onclose path.
//
// 10s is generous — a real Escape round-trips in <100ms. If 10s of random
// actions can't close a modal, it's a trap regardless of whether Escape
// specifically is broken.
export const noModalTraps = always(
  now(() => modalOpen.current).implies(
    eventually(() => !modalOpen.current).within(10, "seconds")
  )
);

// Graph rows are hard-locked to 18px — the load-bearing constraint that
// keeps gutter pipes continuous. Any inline badge/button that blows row
// height breaks the graph visually; bughunter has missed this class
// repeatedly (it's a computed-style check, not a logic check).
//
// Sub-pixel tolerance for DPI scaling. Empty array (no rows rendered yet)
// passes trivially via .every.
export const rowsAlwaysEighteen = always(() =>
  rowHeights.current.every((h) => Math.abs(h - 18) < 0.5)
);

// selectedIndex is either -1 (nothing selected — initial/empty-revset) or
// within [0, count). Catches: off-by-one after revset filter shrinks the
// list, stale index after a mutation removes the selected commit.
export const selectedIndexInBounds = always(() => {
  const idx = selectedIdx.current;
  const count = revisionCount.current;
  return idx === -1 || (idx >= 0 && idx < count);
});

// State-machine form: between any two captured states, selectedIndex moves
// by 0 (stutter — reload, unrelated click), ±1 (j/k), or to a valid jump
// target (click, search). No uncontrolled drift. The `or` chain is the
// standard Bombadil state-machine idiom.
const selUnchanged = now(() => {
  const c = selectedIdx.current;
  return next(() => selectedIdx.current === c);
});
const selStep = now(() => {
  const c = selectedIdx.current;
  return next(() => Math.abs(selectedIdx.current - c) === 1);
});
// Jump covers: mouse click on a row, /-search, revset filter reset.
// The only constraint is it lands in-bounds — checked by selectedIndexInBounds.
const selJump = now(() =>
  next(() => selectedIdx.current >= -1)
);
export const selectedIndexTransitions = always(
  selUnchanged.or(selStep).or(selJump)
);

// MessageBar errors are dismissable — either auto-clear or the ✕ button
// works. A permanently-stuck error bar blocks the 24px above StatusBar.
export const messageBarDismissable = always(
  now(() => messageBarShown.current).implies(
    eventually(() => !messageBarShown.current).within(15, "seconds")
  )
);

// Inline modes (rebase/squash/split) are escapable. Same trap-detection
// shape as noModalTraps but for the mode state machine. A mode that can't
// be cancelled is a soft-lock — the user can't j/k navigate until exit.
export const inlineModeEscapable = always(
  now(() => inlineModeActive.current).implies(
    eventually(() => !inlineModeActive.current).within(10, "seconds")
  )
);

// Megamerge badge/count coherence. Every rendered parent badge corresponds to a
// commit_id in the mode's parent set, so the count of `.badge-target` markers
// can never EXCEED StatusBar's authoritative parent count. Targets the bug
// class where the badge predicate matches the wrong identity (keying by
// change_id instead of commit_id, or badging the target/non-parent rows) —
// that over-renders badges → violation. `<=` not `===`: virtualization can hide
// in-set rows that scrolled off-screen, so rendered is a lower bound.
export const megamergeBadgeCoherent = always(() =>
  !megamergeActive.current || parentBadgeCount.current <= mmParentCount.current
);

// No row is simultaneously source and parent-target — a commit is never its own
// parent (the toggle guards the target's commit_id), and source/target roles
// are per-row exclusive in every mode. Virtualization-safe (only inspects
// rendered rows). Holds across rebase/squash too, but the megamerge multi-badge
// path is where a matching slip would first break it.
export const noSelfParentRow = always(() =>
  sourceTargetSameRow.current === 0
);

// Diff/cursor coherence — the #1 historical bug class in this codebase.
// revGen await-gap, post-await identity guards, navigateCached double-rAF
// scheduling all exist to prevent "cursor is on C, diff shows A". When
// neutral (no inline mode freezing diff on source, no panel replacing
// DiffPanel) and both ids are rendered, the header eventually matches the
// cursor. eventually-within covers the intentional double-rAF paint-first
// deferral + localhost API round-trip; mismatch beyond that is stale state.
// Null on either side → antecedent false (multi-check / initial-load).
export const diffMatchesCursor = always(
  now(() =>
    !inlineModeActive.current && !modalOpen.current &&
    headerChangeId.current !== null && selectedChangeId.current !== null
  ).implies(
    eventually(() =>
      headerChangeId.current === selectedChangeId.current
    ).within(3, "seconds")
  )
);

// Input focus is escapable. Catches v1.12.1's exact regression: Enter in
// the revset filter applied-but-stayed-focused → j/k dead until click-out.
// Escape is weighted 30 in lightjjActions; if 10s of that can't blur an
// input, the input is swallowing Escape without yielding focus.
export const focusEscapable = always(
  now(() => focusInInput.current).implies(
    eventually(() => !focusInInput.current).within(10, "seconds")
  )
);

// Tab count is monotonic non-decreasing across the fuzzable action set. The only
// tab-CLOSING paths are the ✕ button (no generator targets it) and the RIGHT-
// click tab menu's "Close tab" / "Close group" (unreachable — #251). So the one
// tab surface Bombadil CAN drive is the LEFT-click `◇N` workspace menu, whose
// items only switch to / open / add workspaces — never close one. A decrease
// therefore means a workspace-menu action wrongly tore a tab down. `>=` (not
// `===`): "open in new tab" / "add workspace" legitimately grow the count, and
// the initial mount grows it 0→1. wsMenuOpen anchors this to the menu surface in
// the trace (referenced so it is snapshotted every state).
const tabCountKept = now(() => {
  const c = tabCount.current;
  void wsMenuOpen.current; // keep the menu-open snapshot in the trace
  return next(() => tabCount.current >= c);
});
export const tabCountMonotonic = always(tabCountKept);

// -------------------------------------------------------------------------
// Action generators
// -------------------------------------------------------------------------

// KeyboardEvent.keyCode values. Bombadil's PressKey uses the numeric code.
const KEY = {
  ESC: 27, ENTER: 13, SPACE: 32,
  j: 74, k: 75, m: 77, r: 82, s: 83, b: 66,
  n1: 49, n2: 50, n3: 51, n4: 52, n5: 53,
  LBRACKET: 219, RBRACKET: 221,
} as const;

const press = (code: number) => ({ PressKey: { code } } as const);

// Navigation keys — safe, read-only. High weight: this is the primary
// exploration driver.
export const navKeys = actions(() => [
  press(KEY.j), press(KEY.k),
  press(KEY.LBRACKET), press(KEY.RBRACKET),
  press(KEY.n1), press(KEY.n2), press(KEY.n3),  // log / branches / merge view
  press(KEY.n4), press(KEY.n5),  // oplog / evolog drawers
  press(KEY.SPACE),              // check/uncheck
  press(KEY.m),                  // markdown preview
]);

// Escape — the trap detector. Separate generator so it can be weighted
// independently high; if noModalTraps fails, we want to be sure Escape
// was actually in the action pool frequently. (`q` was here originally
// as a vim-ism — lightjj doesn't bind it, removed.)
export const escapeKeys = actions(() => [press(KEY.ESC)]);

// Mode-entry keys. These open inline modes / modals — needed for
// noModalTraps / inlineModeEscapable to have anything to check. Lower
// weight than nav: we want to enter modes occasionally, not constantly.
//
// Deliberately excluded: Enter (executes the mode — mutates fixture),
// `n` (new commit), `d` (describe — opens editor). Mutations would
// accumulate across the run and eventually break the fixture structure.
// If we want mutation coverage, that's a separate spec against a
// `jj op restore`-on-loop fixture.
//
// IMPORTANT — these press LOWERCASE keys. Bombadil's PressKey carries only a
// keyCode with no shift/modifier, and a letter keyCode emits the lowercase char
// (verified: 0.6.1 logs "Pressing m (code: 77)"). So keyCode 82/83 dispatch
// `r`/`s`, NOT `R`/`S`: `r` is REFRESH and `s` is SPLIT (an inline mode — this
// is what actually exercises inlineModeEscapable), while lightjj's `R` (rebase)
// and `S` (squash) are uppercase and CANNOT be driven by 0.6.1 — the same
// hard limit that blocks megamerge's `M` (see megamergeKeys below). `b` opens
// the bookmark modal (lowercase, reachable).
export const modeKeys = actions(() => [
  press(KEY.r),  // 'r' → refresh (NOT rebase; uppercase R is undriveable)
  press(KEY.s),  // 's' → split mode (an inline mode — reachable)
  press(KEY.b),  // 'b' → bookmark modal
]);

// Megamerge entry. The mode is bound to uppercase `M` (matching jjui). PressKey
// carries only a keyCode with no modifier state, and a letter keyCode emits the
// LOWERCASE char (keyCode 77 → `m`, markdown preview) — so `TypeText` is the
// only in-vocabulary action that could deliver an uppercase character to the
// `<svelte:window onkeydown>` handler. Once in the mode, Space (navKeys) toggles
// the cursor row in/out of the parent set, Enter (commitKeys) executes, Escape
// cancels.
//
// KNOWN REACHABILITY GAP — confirmed by focused probe on BOTH Bombadil 0.4.2
// AND 0.6.1: `TypeText("M")` does NOT enter megamerge (`megamergeActive` stayed
// false across every captured state, 4 attempts total), while the control
// `PressKey('s')` DID reach split — so the harness can drive lowercase-key
// inline modes, just not uppercase. 0.6.0's keyboard rework (#199, "only emit
// text for text-producing keys") did not change this: `TypeText` still injects
// text without a window `keydown` for the shortcut, and `PressKey` has no shift
// field (Action type is `{ code }` only). Megamerge's three real entry points
// (uppercase `M`, right-click "Edit parents…", Cmd+K) each need input 0.6.1
// cannot produce (Shift, contextmenu, meta). REACHABILITY IS NOW PROVIDED BY THE
// `clickEditParents` GENERATOR (below): a real RevisionHeader "Edit parents"
// button that Bombadil's Click action can drive. This keyboard generator is kept
// as a forward-compatible best effort (a future Bombadil whose TypeText
// dispatches real key events, or which grows modifier support, would drive the
// `M` shortcut with no spec change) but is currently a no-op for mode entry.
export const megamergeKeys = actions(() => [
  { TypeText: { text: "M", delayMillis: 10 } } as const,
]);

// Enter — executes the active inline mode (megamerge → rebase the parent set;
// split → split) or, in normal mode, (re)loads the diff (harmless). The base
// spec excluded Enter to keep the fixture pristine; megamerge execute coverage
// needs it. Kept low-weight, and the fixture is recreated fresh per run so
// mutation drift is bounded to one session. Megamerge Enter with an unchanged
// set is a no-op exit (no mutation); a toggled set rewrites parents, and any
// illegal target (cycle/descendant/immutable) surfaces as a dismissable
// MessageBar — messageBarDismissable already guards that path.
export const commitKeys = actions(() => [press(KEY.ENTER)]);

// Selector → array of center points for visible (width>0) elements.
// Capped at 20 — virtualized lists can be arbitrarily long and we only
// need "somewhere to click", not every row.
const centers = (selector: string) => extract((s) =>
  Array.from(s.document.querySelectorAll(selector))
    .slice(0, 20)
    .map((el) => {
      const r = (el as HTMLElement).getBoundingClientRect();
      return r.width > 0
        ? { x: r.left + r.width / 2, y: r.top + r.height / 2 }
        : null;
    })
    .filter((p): p is { x: number; y: number } => p !== null)
);
type Centers = ReturnType<typeof centers>;
const clicks = (name: string, cs: Centers) => actions(() =>
  cs.current.map((point, i) => ({ Click: { name: `${name}-${i}`, point } }))
);

// Revision rows — exercises mouse selection + onselect → selectRevision.
const rowCenters = centers(".graph-row[data-entry]");
export const clickRows = clicks("row", rowCenters);

// Dismiss buttons — welcome modal, message bar ✕. Keeps the explorer from
// getting stuck behind a first-run welcome screen. Panel close buttons
// (.close-btn, .fh-close) deliberately NOT here: trap properties should
// test *keyboard* closure. At weight 30 Escape gets ~3× the attempts of
// any click, so keyboard is the primary close path under test.
const dismissCenters = centers(".dismiss, .welcome-dismiss");
export const clickDismiss = clicks("dismiss", dismissCenters);

// Panel-entry buttons — the reachability layer for noModalTraps on
// DivergencePanel. `.alert-badge-click` is the per-row "Resolve divergence"
// button (RevisionGraph; only renders on divergent rows — the fixture has
// one). Clicking it opens DivergencePanel directly: v1.25.0 moved the
// trigger from RevisionHeader (`.divergent-btn`, now gone) into the graph
// row, so the old nav-first 2-step chain is no longer needed. The bare
// `.alert-badge` (no `-click`) is a display-only conflict label `<span>`,
// deliberately excluded — clicking it does nothing, just wastes budget.
const triggerCenters = centers(".alert-badge-click");
export const clickTriggers = clicks("trigger", triggerCenters);

// "Edit parents" button (RevisionHeader) — the mouse-driven megamerge entry.
// This is what makes megamerge REACHABLE by Bombadil: the mode's `M` shortcut
// is uppercase and undriveable (see megamergeKeys), but a left-Click is in the
// action vocabulary. The button renders only on a mutable single-revision
// target, so the generator returns [] when it's absent. Clicking it enters the
// mode; Space (navKeys) toggles a parent, Enter (commitKeys) executes, Escape
// (escapeKeys) cancels — exercising megamergeBadgeCoherent / inlineModeEscapable
// non-vacuously. Weighted a bit higher than clickTriggers so the mode is reached
// with reasonable density.
const editParentsCenters = centers(".edit-parents-btn");
export const clickEditParents = clicks("editparents", editParentsCenters);

// Not yet in the action pool: doc-mode entry (the "Doc" button in
// DiffFileView's header has no stable test selector — just `.btn.btn-sm`)
// and symbol-peek (⌘+hover an identifier — Bombadil's `PressKey: {code}`
// carries no modifier flags). So modalOpen's `.doc-view` / `.sym-card` arms
// of noModalTraps are currently only exercised if a future generator gets
// added or Bombadil grows modifier support. The properties stay correct
// (vacuously true until reached); the gap is reachability, not soundness.

// Text inputs — reachability for focusEscapable. Without this the property
// is vacuous (no action focuses an input). .revset-input is the v1.12.1
// regression site; .modal-input covers BookmarkModal/GitModal; the bare
// input[type=text] catches anything else. Low weight: we want to ENTER
// input focus occasionally, not type into it (keypresses while focused
// type chars into the field, harmless but wastes action budget).
const inputCenters = centers('.revset-input, .modal-input, input[type="text"]');
export const clickInputs = clicks("input", inputCenters);

// `◇N` workspace icon (left-click) → opens the tab workspace menu. This is the
// reachability layer for the tab-workspace surface: the fixture's second
// workspace makes the icon render on tab 0, and a left-Click is in Bombadil's
// vocabulary (unlike the right-click tab menu — #251). Opening it exercises
// noModalTraps's `.ctx-menu` arm and tabCountMonotonic non-vacuously.
const wsIconCenters = centers(".ws-tab-icon");
export const clickWsIcon = clicks("wsicon", wsIconCenters);

// Workspace-menu items. `.ctx-item` is ONLY ever the workspace menu here (all
// other ctx-menus are right-click-only → unreachable), so this drives the menu's
// actions: switch to / open a workspace (tab churn), Add (prompt — auto-accepted
// empty → no-op), Update all (idempotent update-stale). Disabled items excluded.
const wsMenuItemCenters = centers(".ctx-item:not(.ctx-item-disabled)");
export const clickWsMenuItem = clicks("wsmenu", wsMenuItemCenters);

// Weighted composition. Escape is weighted highest — it's the universal
// "get me out" key, and the trap properties depend on it being tried
// frequently. Nav second (primary exploration). Mode entry lowest
// (occasional, to create states worth escaping from).
export const lightjjActions = weighted([
  [30, escapeKeys],
  [25, navKeys],
  [15, clickRows],
  [12, clickEditParents], // reach megamerge via the RevisionHeader button (Click)
  [10, clickTriggers],
  [9,  clickWsIcon],    // open the tab workspace menu (◇N icon — left-click)
  [8,  clickDismiss],
  [7,  clickWsMenuItem],// drive the workspace menu's actions (switch/open/add)
  [6,  megamergeKeys],  // reach megamerge (TypeText 'M') — see generator note; undriveable on 0.6.1
  [5,  modeKeys],
  [4,  clickInputs],
  [3,  commitKeys],     // Enter — execute inline modes (megamerge/split)
]);
