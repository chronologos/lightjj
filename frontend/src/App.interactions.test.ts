// In-process keyboard-interaction tests for App.svelte — the frontend
// equivalent of Go's MockRunner-backed handler tests. Mounts App with the
// real Svelte runtime + a mocked api.ts module, dispatches keydown on
// `window` (App uses `<svelte:window onkeydown>`), asserts via DOM markers.
//
// Covers the keyboard-gate.ts ORDER invariants from the App side, not just
// the routeKeydown unit. Bombadil stays for SSE/tab-remount/real-jj e2e.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, fireEvent, cleanup } from '@testing-library/svelte'

// Partial mock: pure helpers (effectiveId, diffTargetKey, multiRevset, etc.)
// come from the real module; network-touching exports are overridden via
// netStubs. The dynamic import inside the factory reads the mock-api module
// AFTER vitest's module graph is up — sidesteps vi.mock hoisting.
vi.mock('./lib/api', async (orig) => {
  const real = await orig<typeof import('./lib/api')>()
  const m = await import('./testutil/mock-api')
  return { ...real, ...m.netStubs }
})

// config.svelte.ts uses raw fetch('/api/config') (not the api object) at
// module init AND in a 500ms-debounced save-effect. The api mock doesn't
// cover it. 204 = "backend can't resolve config dir" → config falls through
// to defaults; the save-effect's POST sees ok=false and stays silent.
vi.stubGlobal('fetch', async () => new Response(null, { status: 204 }))

import App from './App.svelte'
import {
  resetMockApi, calls, triggerNavigate, triggerStale,
  setFixtures, defaultFixtures, mkRevision,
} from './testutil/mock-api'
import { waitFor } from './testutil/wait-for'

// Dispatch on body, not window: event.target must be an HTMLElement for
// App's isInInput(t) (calls t.closest). The event bubbles to window so
// `<svelte:window onkeydown>` still receives it. Mirrors a real keypress
// with nothing focused (browser sets target = document.body).
const press = (key: string) => fireEvent.keyDown(document.body, { key })

const qs = (sel: string) => document.querySelector(sel)
const selectedEntry = () => qs('.graph-row.node-row.selected')?.getAttribute('data-entry')

async function mountApp() {
  const r = render(App)
  // loadLog() is fired at module-body level; wait for the graph to render.
  // The working copy (entry 0 in defaultFixtures) becomes the cursor fallback.
  await waitFor(() => document.querySelectorAll('.graph-row.node-row').length === 3)
  return r
}

beforeEach(() => {
  resetMockApi()
  cleanup()
})

describe('App.svelte interactions', () => {
  it('mounts with the fixture log and selects the working copy', async () => {
    await mountApp()
    expect(document.querySelectorAll('.graph-row.node-row')).toHaveLength(3)
    expect(selectedEntry()).toBe('0')
    expect(calls.some(c => c.method === 'log')).toBe(true)
    expect(calls.some(c => c.method === 'info')).toBe(true)
  })

  it('j/k move the selection cursor', async () => {
    await mountApp()
    expect(selectedEntry()).toBe('0')
    await press('j')
    await waitFor(() => selectedEntry() === '1')
    await press('j')
    await waitFor(() => selectedEntry() === '2')
    await press('k')
    await waitFor(() => selectedEntry() === '1')
  })

  it('Space toggles the checked state on the selected revision', async () => {
    await mountApp()
    expect(qs('.graph-row[data-entry="0"].checked')).toBeNull()
    await press(' ')
    await waitFor(() => qs('.graph-row[data-entry="0"].checked') !== null)
    await press(' ')
    await waitFor(() => qs('.graph-row[data-entry="0"].checked') === null)
  })

  // Locks keyboard-gate.ts: `if (c.inlineMode) return h.inlineNav()` is
  // TERMINAL — globalKeys (e.g. '2' switch-view) and logKeys (e.g. Space
  // toggle-check) do NOT fire while a mode is active. j/k can't distinguish
  // (inlineNav.rebase ALSO calls navKey→selectRevision for the dest cursor).
  it('R enters rebase mode; inlineNav swallows globalKeys+logKeys; Escape cancels', async () => {
    await mountApp()
    expect(qs('.statusbar.rebase-active')).toBeNull()

    await press('R')
    await waitFor(() => qs('.statusbar.rebase-active') !== null)
    expect(qs('.statusbar .mode-badge')?.textContent).toBe('rebase')

    // inlineNav.rebase routes j/k → selectRevision (destination cursor): j
    // DOES move .selected. Asserting this guards against j becoming dead.
    await press('j')
    await waitFor(() => selectedEntry() === '1')

    // globalKeys: '2' would switch to branches view in normal mode.
    await press('2')
    expect(qs('.bp-list')).toBeNull()
    expect(qs('.statusbar.rebase-active')).not.toBeNull()
    // logKeys: Space would toggle .checked in normal mode.
    await press(' ')
    expect(qs('.graph-row.checked')).toBeNull()

    await press('Escape')
    await waitFor(() => qs('.statusbar.rebase-active') === null)
    // Out of rebase mode, '2' works again.
    await press('2')
    await waitFor(() => qs('.bp-list') !== null)
  })

  // Megamerge (M): edit the cursor revision's parent set in place. Seeded from
  // parent_ids (commit_ids matched against rows' commit_id). Space toggles the
  // cursor row's commit_id in/out; Enter runs ONE plural api.rebase; Escape
  // cancels with no mutation.
  const rebaseCalls = () => calls.filter(c => c.method === 'rebase')

  it('M on the working copy enters megamerge seeded with its current parent', async () => {
    await mountApp()
    // @ (entry 0, cwc) has parent_ids [kmid]. Its parent row is entry 1 (cmid/kmid).
    await press('M')
    await waitFor(() => qs('.statusbar.megamerge-active') !== null)
    expect(qs('.statusbar .mode-badge')?.textContent).toBe('megamerge')
    // Seeded parent (kmid) renders exactly one parent badge.
    await waitFor(() => document.querySelectorAll('.badge-target').length === 1)
    expect(qs('.mm-parent-count')?.textContent).toContain('1 parent')
  })

  it('Space toggles a parent; Enter runs one plural rebase with the new set', async () => {
    await mountApp()
    await press('M')
    await waitFor(() => qs('.statusbar.megamerge-active') !== null)
    // Cursor is on @ (entry 0). Move to trunk (entry 2, ktrunk) and add it.
    await press('j'); await press('j')
    await waitFor(() => selectedEntry() === '2')
    await press(' ')
    // Now two parents: seeded kmid + newly-added ktrunk.
    await waitFor(() => document.querySelectorAll('.badge-target').length === 2)

    const before = rebaseCalls().length
    await press('Enter')
    await waitFor(() => rebaseCalls().length > before)
    const call = rebaseCalls().at(-1)!
    // api.rebase(revisions, destinations, '-r', '-d') — destinations is an array
    // containing the full new parent set (kmid + ktrunk).
    expect(call.args[0]).toEqual(['cwc'])
    expect(new Set(call.args[1] as string[])).toEqual(new Set(['kmid', 'ktrunk']))
    // Mode exits after execute.
    await waitFor(() => qs('.statusbar.megamerge-active') === null)
  })

  it('Escape cancels megamerge without a mutation', async () => {
    await mountApp()
    const before = rebaseCalls().length
    await press('M')
    await waitFor(() => qs('.statusbar.megamerge-active') !== null)
    await press('j'); await press('j'); await press(' ') // toggle a change
    await press('Escape')
    await waitFor(() => qs('.statusbar.megamerge-active') === null)
    expect(rebaseCalls().length).toBe(before)
  })

  it('Enter with an unchanged parent set is a no-op exit (no rebase)', async () => {
    await mountApp()
    const before = rebaseCalls().length
    await press('M')
    await waitFor(() => qs('.statusbar.megamerge-active') !== null)
    // Do not toggle anything — parent set equals the seed.
    await press('Enter')
    await waitFor(() => qs('.statusbar.megamerge-active') === null)
    expect(rebaseCalls().length).toBe(before)
  })

  // The RevisionHeader "Edit parents" button — the mouse-discoverable entry
  // point (and the one Bombadil's Click action can drive). Gated on mutability.
  it('RevisionHeader "Edit parents" button enters megamerge (mutable @)', async () => {
    await mountApp()
    // @ (cwc) is mutable and the single-revision target → button shows.
    await waitFor(() => qs('.edit-parents-btn') !== null)
    await fireEvent.click(qs('.edit-parents-btn')!)
    await waitFor(() => qs('.statusbar.megamerge-active') !== null)
    expect(qs('.statusbar .mode-badge')?.textContent).toBe('megamerge')
  })

  it('"Edit parents" button is hidden for an immutable revision', async () => {
    await mountApp()
    await waitFor(() => qs('.edit-parents-btn') !== null)
    // Navigate to the immutable trunk (entry 2, ctrunk).
    await press('j'); await press('j')
    await waitFor(() => qs('.detail-change-id')?.textContent === 'ctrunk')
    expect(qs('.edit-parents-btn')).toBeNull()
  })

  // App-level Escape fallback closes the oplog/evolog drawers (they're opened
  // via 4/5 without focus, so the panel's own Escape handler can't fire). Guards
  // the soft-trap the e2e noModalTraps property caught.
  it('Escape closes the oplog drawer opened via keyboard', async () => {
    await mountApp()
    expect(qs('.oplog-panel')).toBeNull()
    await press('4')
    await waitFor(() => qs('.oplog-panel') !== null)
    await press('Escape')
    await waitFor(() => qs('.oplog-panel') === null)
  })

  it("'2' switches to branches view, '1' returns to log", async () => {
    await mountApp()
    expect(qs('.bp-list')).toBeNull()
    await press('2')
    await waitFor(() => qs('.bp-list') !== null)
    // '2' → switchToBranchesView → explicit bookmarksSync.refresh(): the fetch
    // starts synchronously (bypasses the op-sync gate), so it has been recorded
    // by the time the view renders.
    expect(calls.some(c => c.method === 'bookmarks')).toBe(true)
    await press('1')
    await waitFor(() => qs('.bp-list') === null)
  })

  // Locks keyboard-gate.ts:64-71 — branches view falls through delegateBranches
  // → globalKeys → logKeys, so Space/@/n still act on the still-visible
  // RevisionGraph. delegateBranches doesn't claim Space (no preventDefault).
  it('Space in branches view falls through to logKeys (toggles check)', async () => {
    await mountApp()
    await press('2')
    await waitFor(() => qs('.bp-list') !== null)
    expect(qs('.graph-row.checked')).toBeNull()
    await press(' ')
    await waitFor(() => qs('.graph-row[data-entry="0"].checked') !== null)
  })

  // Merge-boundary lock: B added stepAnnotation/{/ } in handleLogKeys; this
  // verifies the empty-state message path (defaultFixtures has no annotations).
  it("'}' with no annotations shows the warning message", async () => {
    await mountApp()
    await press('}')
    await waitFor(() => qs('.message-text')?.textContent === 'No annotations on this revision')
  })

  // Merge-boundary lock: A's onNavigate gate must refuse during inline modes
  // (and doc/merge views) so an agent can't yank the user out of half-done
  // work. The HIGH bug was that doc-mode wasn't gated; rebase is the cheap
  // proxy here (doc-mode mount needs a docSession fixture).
  it('agent navigate is ignored during rebase mode and applied after', async () => {
    await mountApp()
    await press('R')
    await waitFor(() => qs('.statusbar.rebase-active') !== null)

    triggerNavigate({ change_id: 'cmid' })
    await waitFor(() => qs('.message-text')?.textContent?.includes('Agent navigate ignored') === true)
    expect(selectedEntry()).toBe('0')

    await press('Escape')
    await waitFor(() => qs('.statusbar.rebase-active') === null)

    triggerNavigate({ change_id: 'cmid' })
    await waitFor(() => selectedEntry() === '1')
  })

  it("agent navigate to a change_id not in the revset shows 'not in current revset'", async () => {
    await mountApp()
    triggerNavigate({ change_id: 'cnonexistent' })
    await waitFor(() => qs('.message-text')?.textContent?.includes('not in current revset') === true)
    expect(selectedEntry()).toBe('0')
  })
})

// ── Staleness model + identity-keyed cursor ─────────────────────────────────
// Locks the App-side behavior of the derived staleness design: each server
// resource's op-sync compares the op-id its value reflects against the latest
// reported op-id (lib/op-sync.svelte.ts), so a refresh suppressed by an inline
// mode/modal/mutation fires when the gate clears instead of being dropped. And
// the cursor is identity-keyed (selectedId → derived selectedIndex), so a
// refresh that shifts row positions cannot silently re-bind the cursor (and the
// diff panel) to a different revision.
describe('staleness + identity cursor', () => {
  const logCalls = () => calls.filter(c => c.method === 'log').length

  it('an external op-id change refreshes the log', async () => {
    await mountApp()
    const before = logCalls()
    triggerStale('op-ext-1')
    await waitFor(() => logCalls() > before)
  })

  it('staleness during rebase mode is deferred — refresh fires on Escape, not dropped', async () => {
    await mountApp()
    await press('R')
    await waitFor(() => qs('.statusbar.rebase-active') !== null)

    const before = logCalls()
    triggerStale('op-ext-2')
    // Must NOT refresh while the mode is active. Real-time wait covers the
    // effect's macrotask deferral window (it re-checks gates and bails).
    await new Promise(r => setTimeout(r, 50))
    expect(logCalls()).toBe(before)

    // Exiting the mode flips a gate the (still-stale) effect depends on →
    // the refresh fires now. This is the fact the old event-callback model
    // dropped permanently.
    await press('Escape')
    await waitFor(() => qs('.statusbar.rebase-active') === null)
    await waitFor(() => logCalls() > before)
  })

  it('cursor follows revision identity when a refresh shifts row positions', async () => {
    await mountApp()
    await press('j')
    await waitFor(() => selectedEntry() === '1') // on cmid

    // External op inserts a new revision between @ and cmid → rows shift.
    const f = defaultFixtures()
    setFixtures({
      revisions: [
        f.revisions[0],
        mkRevision({ change_id: 'cnew', commit_id: 'knew', description: 'external work', parent_ids: ['kmid'] }),
        f.revisions[1],
        f.revisions[2],
      ],
    })
    triggerStale('op-ext-3')

    await waitFor(() => document.querySelectorAll('.graph-row.node-row').length === 4)
    // cmid now sits at entry 2. An index-keyed cursor would have stayed at
    // entry 1 — the unrelated external revision — and loaded its diff.
    await waitFor(() => selectedEntry() === '2')
  })

  it('cursor falls back to the working copy when its revision disappears', async () => {
    await mountApp()
    await press('j')
    await waitFor(() => selectedEntry() === '1') // on cmid

    // External op abandons cmid.
    const f = defaultFixtures()
    setFixtures({ revisions: [f.revisions[0], f.revisions[2]] })
    triggerStale('op-ext-4')

    await waitFor(() => document.querySelectorAll('.graph-row.node-row').length === 2)
    await waitFor(() => selectedEntry() === '0') // back on @
  })

  // Tab-switch snapshot contract (AppShell getState → initialState round-trip).
  it('getState() snapshots the cursor as identity, not index', async () => {
    const { component } = await mountApp()
    await press('j')
    await waitFor(() => selectedEntry() === '1')
    expect(component.getState().selectedId).toBe('cmid')
  })

  it('initialState.selectedId restores the cursor onto the same revision', async () => {
    render(App, { props: { initialState: {
      selectedId: 'cmid', revsetFilter: '', activeView: 'log', diffScrollTop: 0,
    } } })
    await waitFor(() => document.querySelectorAll('.graph-row.node-row').length === 3)
    await waitFor(() => selectedEntry() === '1')
  })
})

// Tab/workspace surface: the `w`-key retarget + Cmd+K "Switch to repo" entries.
// The menu itself is hosted by AppShell (not App), so App's job is to (a) route
// `w` to the onOpenWorkspaceMenu callback and (b) surface one palette entry per
// distinct open repo group from the `tabs` prop.
describe('App tab/workspace integration', () => {
  const mkTab = (id: string, name: string) => ({
    id, kind: 'repo', name, path: '/x/' + name, repoRoot: '/x/' + name, wsName: 'default',
  })

  async function mountWith(props: Record<string, unknown>) {
    const r = render(App, { props })
    await waitFor(() => document.querySelectorAll('.graph-row.node-row').length === 3)
    return r
  }

  it("'w' calls onOpenWorkspaceMenu and the old toolbar dropdown is gone", async () => {
    const onOpenWorkspaceMenu = vi.fn()
    await mountWith({ onOpenWorkspaceMenu })
    // The toolbar workspace dropdown was removed entirely.
    expect(qs('.toolbar-ws-dropdown')).toBeNull()
    expect(qs('.toolbar-workspace')).toBeNull()
    await press('w')
    expect(onOpenWorkspaceMenu).toHaveBeenCalledTimes(1)
  })

  it('Cmd+K surfaces "Switch to repo: <name>" per group; clicking fires onSwitchTab', async () => {
    const onSwitchTab = vi.fn()
    await mountWith({
      tabs: [mkTab('0', 'alpha'), mkTab('1', 'beta')],
      onSwitchTab,
    })
    // Open the command palette (Cmd+K).
    await fireEvent.keyDown(document.body, { key: 'k', metaKey: true })
    await waitFor(() => qs('.palette') !== null)

    const input = qs('.palette-input') as HTMLInputElement
    input.value = 'Switch to repo: beta'
    await fireEvent.input(input)

    await waitFor(() => Array.from(document.querySelectorAll('.palette-label'))
      .some(el => el.textContent?.includes('Switch to repo: beta')))
    const item = Array.from(document.querySelectorAll('.palette-item'))
      .find(el => el.querySelector('.palette-label')?.textContent?.includes('Switch to repo: beta'))!
    await fireEvent.click(item)
    expect(onSwitchTab).toHaveBeenCalledWith('1')
  })
})
