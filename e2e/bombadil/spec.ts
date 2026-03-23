// Bombadil spec for lightjj — LTL properties + action generators.
//
// Run via ./run.sh (creates fixture repo, starts server, invokes bombadil).
//
// Property design: each `always`/`eventually` encodes a class of bug the
// unit-test suite has historically missed — trap states (noModalTraps),
// layout regressions (rowsAlwaysEighteen), stale-state glitches
// (selectedIndexValid). Bombadil finds these by random action sequences
// the hand-written tests never tried.

import {
  extract, actions, weighted,
  always, eventually, next, now,
} from "@antithesishq/bombadil";

// Default PROPERTIES only — noUncaughtExceptions, noUnhandledRejections,
// no4xx5xx, error-log detection. NOT /defaults/actions: the default
// reload/back/forward generators ate ~20% of action budget in the first
// spike; our own generators below give better exploration density.
export * from "@antithesishq/bombadil/defaults/properties";

// -------------------------------------------------------------------------
// Extractors — DOM state snapshots. Each returns a Cell<T> that Bombadil
// re-reads after every action + DOM mutation.
// -------------------------------------------------------------------------

// Modal/panel overlays. `.panel` alone is too broad (DiffPanel,
// RevisionGraph are permanent .panel elements); the overlays we care about
// are dialogs + the slide-in/drawer panels that sit above the log view.
const modalOpen = extract((s) =>
  s.document.querySelector(
    '[role="dialog"], .divergence-panel, .evolog-panel, .oplog-panel, ' +
    '.fh-root, .ctx-menu'
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
// rebase/squash/split is active (StatusBar's {#if} gates).
const inlineModeActive = extract((s) =>
  s.document.querySelector(".mode-badge") !== null
);

// MessageBar presence. `eventually dismissable` is the guarantee — an
// error that never clears is a trap for the user too.
const messageBarShown = extract((s) =>
  s.document.querySelector(".message-bar") !== null
);

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
// for a 12-commit localhost fixture.
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
  press(KEY.n1), press(KEY.n2),  // log / branches view
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
export const modeKeys = actions(() => [
  press(KEY.r),  // rebase mode
  press(KEY.s),  // squash mode
  press(KEY.b),  // bookmark modal
]);

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

// Panel-entry buttons — the reachability layer. `.divergent-btn` opens
// DivergencePanel (RevisionHeader, only renders when selected rev is
// divergent), `.alert-badge` marks divergent/conflict rows so clicking it
// selects that row first. Together they make the 2-step nav→open chain
// reachable in a random walk.
const triggerCenters = centers(".divergent-btn, .alert-badge");
export const clickTriggers = clicks("trigger", triggerCenters);

// Weighted composition. Escape is weighted highest — it's the universal
// "get me out" key, and the trap properties depend on it being tried
// frequently. Nav second (primary exploration). Mode entry lowest
// (occasional, to create states worth escaping from).
export const lightjjActions = weighted([
  [30, escapeKeys],
  [25, navKeys],
  [15, clickRows],
  [10, clickTriggers],
  [8,  clickDismiss],
  [5,  modeKeys],
]);
