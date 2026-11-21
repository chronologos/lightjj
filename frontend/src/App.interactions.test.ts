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
  setFixtures, defaultFixtures, mkRevision, setLogHandler, setEvologHandler, setMutationError, setApiDelay, mkFileChange,
} from './testutil/mock-api'
import type { LogEntry } from './lib/api'
import { waitFor } from './testutil/wait-for'
import { ApiError } from './lib/api-error'

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
    expect(new Set(call.args[1] as string[])).toEqual(new Set(['cmid', 'ctrunk']))
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

  // Full-tree browser (issue #39): F opens the overlay for the DISPLAYED
  // revision; while open, keys go to the panel (j/k don't move the graph
  // cursor beneath — anyModalOpen) and Escape closes it.
  it('F opens the file-tree overlay; keys stay inside; Escape closes', async () => {
    await mountApp()
    await waitFor(() => qs('.detail-change-id') !== null)
    await press('F')
    await waitFor(() => qs('.ft-root') !== null)
    expect(calls.some(c => c.method === 'fileTree' && c.args[0] === 'kwc' && c.args[1] === '')).toBe(true)
    await waitFor(() => qs('.ft-row .ft-name')?.textContent === 'README.md')
    await press('j')
    expect(selectedEntry()).toBe('0') // graph cursor untouched beneath the overlay
    await press('Escape')
    await waitFor(() => qs('.ft-root') === null)
  })

  it('RevisionHeader "Files" button opens the file-tree overlay', async () => {
    await mountApp()
    await waitFor(() => qs('.browse-files-btn') !== null)
    await fireEvent.click(qs('.browse-files-btn')!)
    await waitFor(() => qs('.ft-root') !== null)
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

  // Agents send whatever `jj log` printed — a unique prefix must land the same
  // as the exact short id (same matcher as ?change= URLs). 'cm' uniquely
  // prefixes 'cmid' among cwc/cmid/ctrunk.
  it('agent navigate accepts a unique change_id prefix', async () => {
    await mountApp()
    triggerNavigate({ change_id: 'cm' })
    await waitFor(() => selectedEntry() === '1')
    expect(qs('.message-text')?.textContent ?? '').not.toContain('not in current revset')
  })

  // The load-bearing half: pendingNavScroll must be stamped with the matched
  // ROW's id, not the agent's ref — else the scroll effect's identity check
  // (effectiveId(selected) === pending.changeId) never matches and the file
  // scroll is silently dropped for every non-exact ref.
  it('agent navigate by prefix WITH file_path scrolls that file into view', async () => {
    setFixtures({ diffs: { kwc: '', ktrunk: '', kmid: [
      'diff --git a/src/main.ts b/src/main.ts',
      '--- a/src/main.ts', '+++ b/src/main.ts',
      '@@ -1,1 +1,1 @@', '-a', '+b', '',
    ].join('\n') } })
    const spy = vi.spyOn(Element.prototype, 'scrollIntoView')
    try {
      await mountApp()
      triggerNavigate({ change_id: 'cm', file_path: 'src/main.ts' })
      await waitFor(() => selectedEntry() === '1')
      await waitFor(() => spy.mock.contexts.some(
        el => (el as Element).getAttribute?.('data-file-path') === 'src/main.ts'))
    } finally { spy.mockRestore() }
  })

  // Bidirectional matcher: a ref LONGER than the row's short id (what
  // `jj log -T change_id` prints) resolves via "row id is a prefix of ref".
  it('agent navigate accepts a full-length id longer than the row\'s short id', async () => {
    await mountApp()
    triggerNavigate({ change_id: 'cmidqklmnopqrstuvwxyzklmnopqrstu' })
    await waitFor(() => selectedEntry() === '1')
  })

  it("agent navigate to a change_id not in the revset shows 'not in current revset'", async () => {
    await mountApp()
    triggerNavigate({ change_id: 'cnonexistent' })
    await waitFor(() => qs('.message-text')?.textContent?.includes('not in current revset') === true)
    expect(selectedEntry()).toBe('0')
  })

  // /api/pull-requests now returns colleagues' same-repo PRs too (mine:false)
  // so their branches badge; the "PRs" chip must still count only YOUR PRs or
  // a busy repo's recent window swamps it.
  it('PRs chip counts only mine; a colleague\'s PR still badges its local bookmark', async () => {
    const f = defaultFixtures()
    f.revisions[1].bookmarks = [{ name: 'them/b' }]
    setFixtures({ revisions: f.revisions, pullRequests: [
      { bookmark: 'me/a', url: 'https://github.com/o/r/pull/1', number: 1, is_draft: false, mine: true },
      { bookmark: 'them/b', url: 'https://github.com/o/r/pull/2', number: 2, is_draft: false, mine: false, author: 'bob' },
      { bookmark: 'them/c', url: 'https://github.com/o/r/pull/3', number: 3, is_draft: true, mine: false },
    ] })
    await mountApp()
    await waitFor(() => qs('.preset-chip .chip-count') !== null)
    expect(qs('.preset-chip .chip-count')!.textContent).toBe('1')
    // …while bob's PR #2 badges the row carrying local bookmark them/b.
    await waitFor(() => qs('.graph-row[data-entry="1"] .pr-badge') !== null)
    const badge = qs('.graph-row[data-entry="1"] .pr-badge') as HTMLAnchorElement
    expect(badge.getAttribute('href')).toBe('https://github.com/o/r/pull/2')
    expect(badge.title).toContain('PR #2 by bob')
  })

  it('agent navigate can apply a revset before selecting a change', async () => {
    await mountApp()

    await press(' ')
    expect(qs('.graph-row.checked')).not.toBeNull()

    triggerNavigate({ revset: 'trunk()..@', change_id: 'cmid' })

    await waitFor(() => selectedEntry() === '1')
    expect(calls.some(c => c.method === 'log' && c.args[0] === 'trunk()..@')).toBe(true)
    expect((qs('.revset-input') as HTMLInputElement | null)?.value).toBe('trunk()..@')
    expect(qs('.graph-row.checked')).toBeNull()
  })

  // ── Agent revset steering (POST /api/navigate {revset}) ──
  const navRevsetInput = () => (qs('.revset-input') as HTMLInputElement | null)?.value
  const logArgs = () => calls.filter(c => c.method === 'log').map(c => c.args[0])
  const lastFocus = () => [...calls].reverse().find(c => c.method === 'setFocus')?.args[0] as
    { revset?: string; change_id?: string } | undefined

  it('agent navigate revset-only replaces the filter, cursor falls back to @, focus reports it', async () => {
    await mountApp()
    await press('j')
    await waitFor(() => selectedEntry() === '1')

    triggerNavigate({ revset: 'mutable()' })

    await waitFor(() => logArgs().includes('mutable()'))
    await waitFor(() => selectedEntry() === '0') // resetSelection, like a typed revset
    expect(navRevsetInput()).toBe('mutable()')
    expect(qs('.message-bar')).toBeNull()
    // Focus reports the APPLIED revset (500ms debounced heartbeat).
    await waitFor(() => lastFocus()?.revset === 'mutable()', { timeout: 1500 })
  })

  it('agent navigate {revset:""} clears the filter back to the default log', async () => {
    await mountApp()
    triggerNavigate({ revset: 'mutable()' })
    await waitFor(() => navRevsetInput() === 'mutable()')
    await waitFor(() => logArgs().at(-1) === 'mutable()')

    triggerNavigate({ revset: '' })

    await waitFor(() => navRevsetInput() === '')
    await waitFor(() => logArgs().length >= 3 && logArgs().at(-1) === undefined)
    await waitFor(() => lastFocus()?.revset === '', { timeout: 1500 })
  })

  it('agent navigate with an invalid revset surfaces jj\'s error and does not select the change', async () => {
    setLogHandler(async (revset) => {
      if (revset === 'bad((') throw new Error('Failed to parse revset: bad((')
      return defaultFixtures().revisions
    })
    await mountApp()

    triggerNavigate({ revset: 'bad((', change_id: 'cmid' })

    await waitFor(() => qs('.message-bar.kind-error')?.textContent?.includes('Failed to parse revset') === true)
    // Same as a user-typed bad revset: the text stays in the filter bar so it
    // can be fixed, and the log loader empties the graph (no keepValueOnError).
    // No "not in current revset" follow-up — the steer stops at the error.
    expect(navRevsetInput()).toBe('bad((')
    expect(document.querySelectorAll('.graph-row.node-row')).toHaveLength(0)
    expect(qs('.message-text')?.textContent ?? '').not.toContain('not in current revset')

    // The failed steer's target must not select on a LATER load: the user
    // fixes the revset themselves → cursor stays at the @ fallback.
    const input = qs('.revset-input') as HTMLInputElement
    input.value = 'mine()'
    await fireEvent.input(input)
    await fireEvent.keyDown(input, { key: 'Enter' })
    await waitFor(() => logArgs().at(-1) === 'mine()')
    await new Promise(r => setTimeout(r, 40))
    expect(selectedEntry()).toBe('0')
    // Focus never claimed the rejected revset.
    await waitFor(() => lastFocus()?.revset === 'mine()', { timeout: 1500 })
    expect(calls.some(c => c.method === 'setFocus' && (c.args[0] as { revset?: string }).revset === 'bad((')).toBe(false)
  })

  it('agent navigate revset + change_id NOT in the new revset: filter applied, warns, cursor at @', async () => {
    const f = defaultFixtures()
    setLogHandler(async (revset) => revset === 'trunk()..@' ? [f.revisions[0]] : f.revisions)
    await mountApp()

    triggerNavigate({ revset: 'trunk()..@', change_id: 'ctrunk' })

    await waitFor(() => qs('.message-text')?.textContent?.includes('ctrunk not in current revset') === true)
    expect(navRevsetInput()).toBe('trunk()..@')
    expect(document.querySelectorAll('.graph-row.node-row')).toHaveLength(1)
    expect(selectedEntry()).toBe('0')
  })

  it('agent navigate with a revset is ignored during an inline mode (filter + log untouched)', async () => {
    await mountApp()
    await press('R')
    await waitFor(() => qs('.statusbar.rebase-active') !== null)
    const before = logArgs().length

    triggerNavigate({ revset: 'mutable()', change_id: 'cmid' })

    await waitFor(() => qs('.message-text')?.textContent?.includes('Agent navigate ignored') === true)
    expect(navRevsetInput()).toBe('')
    expect(logArgs()).toHaveLength(before)
    expect(qs('.statusbar.rebase-active')).not.toBeNull()
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

// Routable URL (issue #35): AppShell parses `?change=&revset=&path=` into the
// launch tab's initialState (revsetFilter + one-shot selectRef/selectPath).
// App's job: the FIRST log load uses the revset, the ref (full or unique
// prefix) is selected off the first APPLIED load, a miss widens the revset
// exactly once via locatorRevset, and a final miss / jj error restores the
// previous revset. The slot is consumed only by applied loads, so a superseded
// first load can't trigger a spurious widen.
describe('App routable-URL initial selection', () => {
  const logCalls = () => calls.filter(c => c.method === 'log')
  const logRevsets = () => logCalls().map(c => c.args[0])
  const state = (over: Record<string, unknown>) => ({ props: { initialState: {
    selectedId: null, revsetFilter: '', activeView: 'log' as const, diffScrollTop: 0, ...over,
  } } })
  const rows = () => document.querySelectorAll('.graph-row.node-row').length
  const revsetInput = () => (qs('.revset-input') as HTMLInputElement | null)?.value
  const settle = () => new Promise(r => setTimeout(r, 40))
  // A target that is NOT in the default 3-row log. Ids chosen to pass
  // isRevisionIdLike: change id from jj's k–z alphabet, commit id hex.
  const TARGET_CHANGE = 'xtrst'
  const LOCATOR = `present(${TARGET_CHANGE}) | present(@) | present(trunk())`
  const withTarget = (): LogEntry[] =>
    [...defaultFixtures().revisions, mkRevision({ change_id: TARGET_CHANGE, commit_id: 'ff00aa', description: 'the target' })]
  function deferred<T>() {
    let resolve!: (v: T) => void, reject!: (e: unknown) => void
    const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
    return { promise, resolve, reject }
  }

  it('selectRef (full change_id) selects that row off the first load — one log call', async () => {
    render(App, state({ selectRef: 'cmid' }))
    await waitFor(() => rows() === 3)
    await waitFor(() => selectedEntry() === '1')
    expect(logCalls()).toHaveLength(1)
    expect(qs('.message-bar.kind-warning')).toBeNull()
  })

  it('selectRef accepts a unique commit_id prefix (short ids agents print)', async () => {
    render(App, state({ selectRef: 'ktr' }))   // prefix of ktrunk
    await waitFor(() => rows() === 3)
    await waitFor(() => selectedEntry() === '2')
    expect(logCalls()).toHaveLength(1)
  })

  it('revsetFilter from the URL drives the FIRST log call (no double load)', async () => {
    render(App, state({ revsetFilter: 'mine()', selectRef: 'cwc' }))
    await waitFor(() => rows() === 3)
    await waitFor(() => selectedEntry() === '0')
    expect(logCalls()).toHaveLength(1)
    expect(logCalls()[0].args[0]).toBe('mine()')
  })

  it('(a) miss → widen ONCE via locatorRevset → FOUND: target selected, locator stays, no warning', async () => {
    setLogHandler(async (revset) => revset === LOCATOR ? withTarget() : defaultFixtures().revisions)
    render(App, state({ selectRef: TARGET_CHANGE }))
    await waitFor(() => rows() === 4)
    await waitFor(() => selectedEntry() === '3')
    await settle()
    expect(logRevsets()).toEqual([undefined, LOCATOR])
    expect(revsetInput()).toBe(LOCATOR)
    expect(qs('.message-bar.kind-warning')).toBeNull()
  })

  it('(b) first load superseded by a load that CONTAINS the target → no widen, no third call, target selected', async () => {
    const first = deferred<LogEntry[]>()
    setLogHandler((revset) => revset === undefined ? first.promise : Promise.resolve(withTarget()))
    render(App, state({ selectRef: TARGET_CHANGE }))
    await waitFor(() => logCalls().length === 1)
    // User submits a revset while load #1 is still in flight → load #2 supersedes it.
    const input = qs('.revset-input') as HTMLInputElement
    input.value = 'mine()'
    await fireEvent.input(input)
    await fireEvent.keyDown(input, { key: 'Enter' })
    await waitFor(() => rows() === 4)
    // Load #1 lands late (superseded) WITHOUT the target — must not widen.
    first.resolve(defaultFixtures().revisions)
    await waitFor(() => selectedEntry() === '3')
    await settle()
    expect(logRevsets()).toEqual([undefined, 'mine()'])
    expect(revsetInput()).toBe('mine()')
    expect(qs('.message-bar.kind-warning')).toBeNull()
  })

  it('(c) widen load ERRORS (ambiguous prefix) → previous revset restored, jj error kept, no not-found overwrite', async () => {
    const AMBIG = '00ff'
    const loc = `present(${AMBIG}) | present(@) | present(trunk())`
    setLogHandler(async (revset) => {
      if (revset === loc) throw new Error(`Commit ID prefix "${AMBIG}" is ambiguous`)
      return defaultFixtures().revisions
    })
    render(App, state({ revsetFilter: 'mine()', selectRef: AMBIG }))
    await waitFor(() => logCalls().length === 3)
    await waitFor(() => rows() === 3)
    await settle()
    expect(logRevsets()).toEqual(['mine()', loc, 'mine()'])
    expect(revsetInput()).toBe('mine()')
    expect(qs('.message-bar.kind-error')?.textContent).toContain('ambiguous')
    expect(qs('.message-bar.kind-warning')).toBeNull()
    expect(selectedEntry()).toBe('0') // fell back to @
  })

  it('(d) miss → widen → still missing: previous revset restored + warning, exactly one widen', async () => {
    setLogHandler(async () => defaultFixtures().revisions)
    render(App, state({ revsetFilter: 'mine()', selectRef: 'zzzz' }))
    await waitFor(() => logCalls().length === 3)
    await waitFor(() => qs('.message-bar.kind-warning') !== null)
    await settle()
    expect(logRevsets()).toEqual(['mine()', 'present(zzzz) | present(@) | present(trunk())', 'mine()'])
    expect(revsetInput()).toBe('mine()')
    expect(qs('.message-bar.kind-warning')?.textContent).toContain('zzzz')
    expect(selectedEntry()).toBe('0')
  })

  it('(d′) user replaces our locator mid-widen — their revset wins: no restore, no stale warning', async () => {
    const widen = deferred<LogEntry[]>()
    const loc = 'present(zzzz) | present(@) | present(trunk())'
    setLogHandler((revset) => revset === loc ? widen.promise : Promise.resolve(defaultFixtures().revisions))
    render(App, state({ selectRef: 'zzzz' }))
    await waitFor(() => logCalls().length === 2) // widen in flight
    const input = qs('.revset-input') as HTMLInputElement
    input.value = 'trunk()'
    await fireEvent.input(input)
    await fireEvent.keyDown(input, { key: 'Enter' }) // userRevsetSubmit drops the spent slot
    await waitFor(() => logCalls().length === 3)
    widen.resolve(defaultFixtures().revisions) // superseded — ignored
    await waitFor(() => rows() === 3)
    await settle()
    expect(logRevsets()).toEqual([undefined, loc, 'trunk()']) // no restore reload
    expect(revsetInput()).toBe('trunk()')
    // The locator load never landed, so "not found (also tried …)" would be a
    // lie about the user's unrelated view — nothing is shown.
    expect(qs('.message-bar.kind-warning')).toBeNull()
  })

  it('(f) an armed slot that outlives an ERRORED first load never widens over the user\'s next revset', async () => {
    setLogHandler(async (revset) => {
      if (revset === 'bad(') throw new Error('syntax error')
      return defaultFixtures().revisions // no zzzz anywhere
    })
    render(App, state({ revsetFilter: 'bad(', selectRef: 'zzzz' }))
    await waitFor(() => qs('.message-bar.kind-error') !== null)
    const input = qs('.revset-input') as HTMLInputElement
    input.value = 'mine()'
    await fireEvent.input(input)
    await fireEvent.keyDown(input, { key: 'Enter' })
    await waitFor(() => rows() === 3)
    await settle()
    // Demoted to plain: a miss ends silently — no locator load, filter kept.
    expect(logRevsets()).toEqual(['bad(', 'mine()'])
    expect(revsetInput()).toBe('mine()')
    expect(qs('.message-bar.kind-warning')).toBeNull()
  })

  it('(e) ?change=main (a bookmark, not an id) → "use ?revset=" warning, no revset built', async () => {
    render(App, state({ selectRef: 'main' }))
    await waitFor(() => rows() === 3)
    await waitFor(() => qs('.message-bar.kind-warning') !== null)
    expect(qs('.message-bar.kind-warning')?.textContent).toContain('?revset=')
    await settle()
    expect(logRevsets()).toEqual([undefined])
    expect(revsetInput()).toBe('')
  })

  it('?path= alone arms a scroll against @ without any extra load', async () => {
    render(App, state({ selectPath: 'src/main.ts' }))
    await waitFor(() => rows() === 3)
    await waitFor(() => selectedEntry() === '0')
    await settle()
    expect(logCalls()).toHaveLength(1)
    expect(qs('.message-bar.kind-warning')).toBeNull()
  })

  // End-to-end through AppShell: parse location.search → seed → strip.
  it('AppShell: ?change=<prefix>&revset= selects the row, drives the first log, strips the URL', async () => {
    history.replaceState(null, '', '/?keep=1&change=cmi&revset=mine()')
    const { default: AppShell } = await import('./AppShell.svelte')
    render(AppShell)
    // Stripped synchronously at boot, unrelated params preserved.
    expect(location.search).toBe('?keep=1')
    await waitFor(() => rows() === 3)
    await waitFor(() => selectedEntry() === '1')
    expect(logCalls()[0].args[0]).toBe('mine()')
    history.replaceState(null, '', '/')
  })

  it('a non-id ref (revset syntax) is never interpolated into a revset — warns without widening', async () => {
    render(App, state({ selectRef: 'main@origin' }))
    await waitFor(() => rows() === 3)
    await waitFor(() => qs('.message-bar.kind-warning') !== null)
    expect(qs('.message-bar.kind-warning')?.textContent).toContain('?revset=')
    expect(logCalls()).toHaveLength(1)
  })
})

// ── Write targets are bound when a surface opens ────────────────────────────
// Each of these used to resolve its target from the live cursor at SUBMIT time,
// so a click, refresh, or agent navigate in between redirected the write.
describe('App write targets', () => {
  const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
  const row = (i: number) => qs(`.graph-row.node-row[data-entry="${i}"]`)!
  const editor = () => qs('.desc-editor textarea') as HTMLTextAreaElement | null
  const label = () => qs('.desc-label')?.textContent?.trim()
  const writes = () => calls.filter(c => ['describe', 'commit', 'bookmarkSet', 'rebase', 'squash', 'split', 'restoreFrom'].includes(c.method))
  const save = () => fireEvent.keyDown(editor()!, { key: 'Enter', metaKey: true })
  async function type(text: string) {
    editor()!.value = text
    await fireEvent.input(editor()!)
  }
  /** Open the describe editor on cmid (row 1) with a dirty draft. */
  async function draftOnCmid() {
    await mountApp()
    await fireEvent.click(row(1))
    await waitFor(() => selectedEntry() === '1')
    await press('e')
    await waitFor(() => editor() !== null)
    await type('DRAFT')
  }

  it('commit editor never leaks into a later describe', async () => {
    await mountApp()
    await press('c')
    await waitFor(() => label()?.startsWith('Commit cwc') === true)
    await fireEvent.click(row(1))
    await waitFor(() => editor() === null)
    await press('e')
    await waitFor(() => label()?.startsWith('Description for cmid') === true)
    await type('new text')
    await save()
    await waitFor(() => writes().length === 1)
    expect(writes()[0]).toEqual({ method: 'describe', args: ['cmid', 'new text'] })
  })

  it("'c' off @ opens the commit editor on @, with @'s own description", async () => {
    await mountApp()
    await fireEvent.click(row(1))
    await waitFor(() => selectedEntry() === '1')
    await press('c')
    await waitFor(() => editor() !== null)
    expect(label()).toBe('Commit cwc')
    expect(editor()!.value).toBe('')
    expect(selectedEntry()).toBe('0')
    // The header remounts when the newly selected diff lands; focus must survive
    // it, or the commit message is typed into global hotkeys.
    await sleep(150)
    expect(document.activeElement).toBe(editor())
  })

  it('refuses to commit when @ moved while the editor was open', async () => {
    await mountApp()
    await press('c')
    await waitFor(() => editor() !== null)
    await type('msg')
    const [wc, mid, trunk] = defaultFixtures().revisions
    setFixtures({ revisions: [
      { ...wc, commit: { ...wc.commit, is_working_copy: false } },
      { ...mid, commit: { ...mid.commit, is_working_copy: true } }, trunk,
    ] })
    triggerStale('op-moved')
    await waitFor(() => calls.filter(c => c.method === 'log').length > 1)
    await sleep(30)
    await save()
    await waitFor(() => qs('.message-text')?.textContent?.includes('Not committed') === true)
    expect(writes()).toEqual([])
    expect(editor()!.value).toBe('msg')
  })

  it.each<[string, () => void]>([
    ['abandoned externally', () => {
      const f = defaultFixtures()
      setFixtures({ revisions: [f.revisions[0], f.revisions[2]] })
    }],
    ['became divergent', () => {
      const f = defaultFixtures()
      setFixtures({ revisions: [f.revisions[0],
        mkRevision({ change_id: 'cmid', commit_id: 'kmid2', divergent: true }),
        mkRevision({ change_id: 'cmid', commit_id: 'kmid3', divergent: true }), f.revisions[2]] })
    }],
  ])('a draft whose revision was %s is hidden, never re-bound to @', async (_, change) => {
    await draftOnCmid()
    change()
    triggerStale('op-gone')
    await waitFor(() => selectedEntry() === '0')
    await waitFor(() => qs('.message-text')?.textContent?.includes('Description draft for cmid is hidden') === true)
    expect(editor()).toBeNull()
    expect(writes()).toEqual([])
  })

  it('a dirty draft survives navigation and still saves to its own revision', async () => {
    await draftOnCmid()
    await fireEvent.click(row(0))
    await waitFor(() => editor() === null)
    await fireEvent.click(row(1))
    await waitFor(() => editor()?.value === 'DRAFT')
    expect(document.activeElement).not.toBe(editor()) // j/k onto it stays j/k
    await save()
    await waitFor(() => writes().length === 1)
    expect(writes()[0]).toEqual({ method: 'describe', args: ['cmid', 'DRAFT'] })
  })

  it('agent navigate is refused while a description is being edited', async () => {
    await draftOnCmid()
    triggerNavigate({ revset: 'all()' })
    await waitFor(() => qs('.message-text')?.textContent?.includes('Agent navigate ignored') === true)
    expect(selectedEntry()).toBe('1')
    expect(editor()!.value).toBe('DRAFT')
  })

  it('agent navigate is refused behind the bookmark input; the name lands on the original revision', async () => {
    await mountApp()
    await fireEvent.click(row(1))
    await waitFor(() => selectedEntry() === '1')
    await press('B')
    await waitFor(() => qs('.bm-set-input') !== null)
    triggerNavigate({ change_id: 'cwc' })
    await waitFor(() => qs('.message-text')?.textContent?.includes('Agent navigate ignored') === true)
    const input = qs('.bm-set-input') as HTMLInputElement
    input.value = 'bm'
    await fireEvent.input(input)
    await fireEvent.keyDown(input, { key: 'Enter' })
    await waitFor(() => writes().length === 1)
    expect(writes()[0]).toEqual({ method: 'bookmarkSet', args: ['cmid', 'bm'] })
  })

  it('Enter in the Files overlay does not execute the rebase pending behind it', async () => {
    await mountApp()
    await press('R')
    await waitFor(() => qs('.statusbar.rebase-active') !== null)
    await press('j') // a real destination: rebasing onto the source is refused anyway
    await waitFor(() => selectedEntry() === '1')
    await fireEvent.click(qs('.browse-files-btn')!)
    await waitFor(() => qs('.ft-root') !== null)
    await fireEvent.keyDown(qs('.ft-root')!, { key: 'Enter' })
    await sleep(20)
    expect(writes()).toEqual([])
    expect(qs('.statusbar.rebase-active')).not.toBeNull()
  })

  it('a divergent badge clicked in the branches view opens the panel instead of trapping the keyboard', async () => {
    const f = defaultFixtures()
    setFixtures({ revisions: [f.revisions[0],
      mkRevision({ change_id: 'cmid', commit_id: 'kmid2', divergent: true }),
      mkRevision({ change_id: 'cmid', commit_id: 'kmid3', divergent: true }), f.revisions[2]] })
    render(App)
    await waitFor(() => document.querySelectorAll('.graph-row.node-row').length === 4)
    await press('2')
    await waitFor(() => qs('.bp-root') !== null)
    await fireEvent.click(row(1).querySelector('.alert-badge-click')!)
    await waitFor(() => qs('.divergence-panel') !== null)
    expect(qs('.bp-root')).toBeNull()
  })

  it('evolog restore targets the revision whose entries are shown, not the cursor', async () => {
    const entry = (id: string) => ({ commit_id: id, time: '2026-01-01T00:00:00', operation: 'snapshot', predecessor_ids: ['p'], diff: '' })
    setEvologHandler(id => id === 'cmid'
      ? Promise.resolve([entry('kmid'), entry('kmidold')])
      : new Promise(() => {})) // any other revision never finishes loading
    await mountApp()
    await fireEvent.click(row(1))
    await waitFor(() => selectedEntry() === '1')
    await press('5')
    await waitFor(() => document.querySelectorAll('.evolog-entry').length === 2)
    await fireEvent.click(row(2))
    await waitFor(() => selectedEntry() === '2')
    await fireEvent.contextMenu(document.querySelectorAll('.evolog-entry')[1])
    const item = await vi.waitFor(() => {
      const el = [...document.querySelectorAll('.ctx-item')].find(b => b.textContent?.includes('Restore this version'))
      expect(el).toBeTruthy()
      return el!
    })
    await fireEvent.click(item)
    await waitFor(() => writes().length === 1)
    expect(writes()[0]).toEqual({ method: 'restoreFrom', args: ['kmidold', 'cmid'] })
  })

  it('squashing part of a commit with a rename moves both halves of the rename', async () => {
    const f = defaultFixtures()
    setFixtures({
      files: { ...f.files, kmid: [mkFileChange({ path: 'new.ts', type: 'R' }), mkFileChange({ path: 'c.ts' })] },
      diffs: { ...f.diffs, kmid: 'diff --git a/old.ts b/new.ts\nrename from old.ts\nrename to new.ts\ndiff --git a/c.ts b/c.ts\n--- a/c.ts\n+++ b/c.ts\n@@ -1 +1 @@\n-a\n+b\n' },
    })
    await mountApp()
    await fireEvent.click(row(1))
    await waitFor(() => selectedEntry() === '1')
    await sleep(120)
    await press('S')
    await waitFor(() => qs('.statusbar.squash-active') !== null)
    const rows = [...document.querySelectorAll('.file-select-row')]
    await fireEvent.click(rows.find(r => r.textContent?.includes('c.ts'))!)
    await press('Enter')
    await waitFor(() => writes().length === 1)
    expect(writes()[0].args[2]).toMatchObject({ files: ['old.ts', 'new.ts'] })
  })

  it('split sends the commit it was opened on; revision_changed cancels the mode and refreshes', async () => {
    const f = defaultFixtures()
    setFixtures({ files: { ...f.files, kmid: [mkFileChange({ path: 'a.ts' }), mkFileChange({ path: 'b.ts' })] } })
    setMutationError('split', new ApiError('cmid changed since you opened it', 409, 'revision_changed'))
    await mountApp()
    await fireEvent.click(row(1))
    await waitFor(() => selectedEntry() === '1')
    await sleep(120)
    await press('s')
    await waitFor(() => qs('.statusbar.split-active') !== null)
    await fireEvent.click(document.querySelectorAll('.file-select-row')[0])
    const logsBefore = calls.filter(c => c.method === 'log').length
    await press('Enter')
    await waitFor(() => qs('.message-text')?.textContent?.includes('revision changed underneath') === true)
    expect(calls.find(c => c.method === 'split')!.args[3]).toEqual({ cmid: 'kmid' })
    expect(qs('.statusbar.split-active')).toBeNull()
    await waitFor(() => calls.filter(c => c.method === 'log').length > logsBefore)
  })
})

// ── What's displayed vs what's loaded ───────────────────────────────────────
describe('App diff readiness', () => {
  const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
  const row = (i: number) => qs(`.graph-row.node-row[data-entry="${i}"]`)!
  const spinner = () => qs('.diff-panel .spinner')
  const squashes = () => calls.filter(c => c.method === 'squash')
  const twoFiles = () => {
    const f = defaultFixtures()
    setFixtures({ files: { ...f.files, kmid: [mkFileChange({ path: 'a.ts' }), mkFileChange({ path: 'b.ts' })] } })
  }

  it.each<[string, () => Promise<unknown>]>([
    ['j', () => press('j')],
    ['1', () => press('1')],
    ['R', () => press('R')],
  ])('Space then %s before the multi-diff lands does not strand the spinner', async (_, second) => {
    await mountApp()
    setApiDelay('diff', 120)
    await press(' ')
    await press('j'); await sleep(200) // settle, then check a second one
    await press(' ')
    await sleep(10)
    await second()
    await sleep(500)
    expect(spinner()).toBeNull()
  })

  it('S before the file list lands is refused, not read as "squash everything"', async () => {
    twoFiles()
    await mountApp()
    setApiDelay('files', 150)
    await press('j')
    await sleep(90) // diff landed, files pending
    await press('S')
    await waitFor(() => qs('.message-text')?.textContent?.includes('Still loading') === true)
    expect(qs('.statusbar.squash-active')).toBeNull()
    await sleep(200)
    await press('S')
    await waitFor(() => qs('.statusbar.squash-active') !== null)
    expect(document.querySelectorAll('.file-select-row')).toHaveLength(2)
  })

  it('a preset chip during squash is refused: source, files and cursor stay put', async () => {
    twoFiles()
    await mountApp()
    await press('j')
    await sleep(120)
    await press('S')
    await waitFor(() => qs('.statusbar.squash-active') !== null)
    const cursor = selectedEntry()
    const logs = calls.filter(c => c.method === 'log').length
    await fireEvent.click(qs('.preset-chip')!)
    await waitFor(() => qs('.message-text')?.textContent?.includes('Finish or Esc') === true)
    await sleep(60)
    expect(selectedEntry()).toBe(cursor)
    expect(calls.filter(c => c.method === 'log')).toHaveLength(logs)
    expect((qs('.revset-input') as HTMLInputElement).value).toBe('')
    expect(document.querySelectorAll('.file-select-row')).toHaveLength(2)
    expect(squashes()).toEqual([])
  })

  it('Esc from squash brings the diff back to the cursor', async () => {
    twoFiles()
    await mountApp()
    await press('j')
    await sleep(120)
    await press('S')
    await waitFor(() => qs('.statusbar.squash-active') !== null)
    const onDest = calls.filter(c => c.method === 'diff').length
    await press('Escape')
    await sleep(30)
    expect(selectedEntry()).toBe('2') // cursor stays where destination-picking left it
    expect(calls.filter(c => c.method === 'diff').slice(onDest).map(c => c.args[0])).toEqual(['ktrunk'])
  })

  it('changing the revset keeps the diff body mounted while the log loads', async () => {
    const f = defaultFixtures()
    setFixtures({ diffs: { ...f.diffs, kwc: 'diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b\n' } })
    await mountApp()
    await waitFor(() => document.querySelectorAll('.diff-file').length === 1)
    const body = qs('.diff-file')
    let release!: () => void
    setLogHandler(() => new Promise(r => { release = () => r(defaultFixtures().revisions) }))
    await fireEvent.click(qs('.preset-chip')!)
    await sleep(30)
    expect(qs('.diff-file')).toBe(body) // blanking it unmounts open editors
    release()
    await sleep(50)
    expect(qs('.diff-file')).toBe(body)
  })

  it('a revset that matches nothing clears the diff instead of keeping an orphan', async () => {
    const f = defaultFixtures()
    setFixtures({ diffs: { ...f.diffs, kwc: 'diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b\n' } })
    await mountApp()
    await waitFor(() => document.querySelectorAll('.diff-file').length === 1)
    setLogHandler(async () => [])
    await fireEvent.click(qs('.preset-chip')!)
    await waitFor(() => document.querySelectorAll('.graph-row.node-row').length === 0)
    await sleep(30)
    expect(qs('.diff-file')).toBeNull()
    expect(spinner()).toBeNull()
  })
})
