// In-process mock for `frontend/src/lib/api.ts` — the frontend equivalent of
// Go's testutil.MockRunner. Used by App.interactions.test.ts to mount App
// without a backend.
//
// Strategy: the test file does `vi.mock('./lib/api', async (orig) => ({
// ...await orig(), api: mockApi, ...netStubs }))`. Pure helpers (effectiveId,
// diffTargetKey, multiRevset, …) come from the real module via importActual;
// only network-touching exports are overridden. `mockApi` is a Proxy so new
// `api.<method>` callers in App don't need a fixture entry to avoid crashing
// — they get a recorded no-op resolve.

import type {
  LogEntry, FileChange, InfoResponse, WorkspacesResponse, Alias, PullRequest,
  Bookmark, GraphLine, MutationResult, NavigatePayload,
} from '../lib/api'

export interface Fixtures {
  revisions: LogEntry[]
  info: InfoResponse
  workspaces: WorkspacesResponse
  aliases: Alias[]
  pullRequests: PullRequest[]
  bookmarks: Bookmark[]
  remotes: string[]
  /** Unified diff text keyed by commit_id (single) or `connected(...)` revset (multi). */
  diffs: Record<string, string>
  /** FileChange[] keyed by commit_id. */
  files: Record<string, FileChange[]>
  /** Full description text keyed by commit_id. */
  descriptions: Record<string, string>
}

export interface Call { method: string; args: unknown[] }

// ── Builders ───────────────────────────────────────────────────────────────

let _seq = 0
const nextId = () => (++_seq).toString(16).padStart(12, '0')

/** Minimal-but-valid LogEntry. Defaults: mutable, mine, non-WC, single-line graph. */
export function mkRevision(over: {
  change_id?: string; commit_id?: string; description?: string
  is_working_copy?: boolean; immutable?: boolean; divergent?: boolean
  parent_ids?: string[]
} = {}): LogEntry {
  const change_id = over.change_id ?? `c${nextId()}`
  const commit_id = over.commit_id ?? `k${nextId()}`
  const gutter = over.is_working_copy ? '@' : over.immutable ? '◆' : '○'
  return {
    commit: {
      change_id, commit_id,
      change_prefix: 1, commit_prefix: 1,
      is_working_copy: over.is_working_copy ?? false,
      hidden: false,
      immutable: over.immutable ?? false,
      conflicted: false,
      divergent: over.divergent ?? false,
      empty: false,
      mine: true,
      parent_ids: over.parent_ids,
    },
    description: over.description ?? `commit ${change_id}`,
    graph_lines: [
      { gutter, is_node: true, content: change_id } satisfies GraphLine,
      { gutter: '│', content: over.description ?? `commit ${change_id}` } satisfies GraphLine,
    ],
  }
}

export function mkInfo(over: Partial<InfoResponse> = {}): InfoResponse {
  return {
    hostname: 'test-host',
    repo_path: '/test/repo',
    ssh_mode: false,
    default_remote: 'origin',
    log_revset: '',
    jj_version: 'jj 0.39.0',
    watchman_snapshot_trigger: false,
    ...over,
  }
}

export function mkFileChange(over: Partial<FileChange> = {}): FileChange {
  return { type: 'M', path: 'src/main.ts', additions: 1, deletions: 0, conflict: false, conflict_sides: 0, ...over }
}

/** 3-revision linear history: @ at index 0, mutable middle, immutable trunk.
 *  Mirrors loadLog's default cursor fallback (selectedId → working copy). */
export function defaultFixtures(): Fixtures {
  const trunk = mkRevision({ change_id: 'ctrunk', commit_id: 'ktrunk', description: 'main', immutable: true })
  const mid = mkRevision({ change_id: 'cmid', commit_id: 'kmid', description: 'feature work', parent_ids: ['ktrunk'] })
  const wc = mkRevision({ change_id: 'cwc', commit_id: 'kwc', description: '(no description)', is_working_copy: true, parent_ids: ['kmid'] })
  return {
    revisions: [wc, mid, trunk],
    info: mkInfo(),
    workspaces: { current: 'default', workspaces: [{ name: 'default', change_id: 'cwc', commit_id: 'kwc' }] },
    aliases: [],
    pullRequests: [],
    bookmarks: [],
    remotes: ['origin'],
    diffs: { kwc: '', kmid: '', ktrunk: '' },
    files: { kwc: [], kmid: [mkFileChange()], ktrunk: [] },
    descriptions: { kwc: '', kmid: 'feature work', ktrunk: 'main' },
  }
}

// ── Mock state ─────────────────────────────────────────────────────────────

let _fixtures: Fixtures = defaultFixtures()
export const calls: Call[] = []

export function setFixtures(f: Partial<Fixtures>): void {
  _fixtures = { ...defaultFixtures(), ...f }
}

/** Revset-aware / controllable `api.log` override. Receives the revset arg
 *  (undefined = default log); return a promise you control (defer, reject) to
 *  script supersede/error sequences. null → the static `fixtures.revisions`. */
export type LogHandler = (revset: string | undefined) => Promise<LogEntry[]>
let _logHandler: LogHandler | null = null
export function setLogHandler(h: LogHandler | null): void { _logHandler = h }

export function resetMockApi(): void {
  _fixtures = defaultFixtures()
  calls.length = 0
  _seq = 0
  _navCb = null
  _staleCb = null
  _logHandler = null
}

const okMutation: MutationResult = { output: '' }

// Recorded namespaced sub-clients. The real api.annotations / api.docComments
// are OBJECTS ({list, save/upsert, remove, clear}), not flat methods — the
// Proxy below returns a recorder FUNCTION per property, so `.list` on that
// function would be undefined and namespaced callers (annotation store load,
// DiffPanel doc-comment badges, App navigate-by-comment) would crash. Each
// sub-method records as 'annotations.list' etc.
function namespacedClient(ns: string, methods: Record<string, unknown>) {
  return Object.fromEntries(Object.entries(methods).map(([name, result]) => [
    name,
    (...args: unknown[]) => { calls.push({ method: `${ns}.${name}`, args }); return Promise.resolve(result) },
  ]))
}
const namespacedClients: Record<string, Record<string, (...args: unknown[]) => Promise<unknown>>> = {
  annotations: namespacedClient('annotations', { list: [], save: okMutation, remove: undefined, clear: undefined }),
  docComments: namespacedClient('docComments', { list: [], upsert: okMutation, remove: undefined }),
}

// Proxy: any `api.<method>(...)` call records to `calls[]` and routes reads
// to fixtures. Unknown methods (mutations, future additions) resolve with a
// generic MutationResult so App's `withMutation` paths don't crash.
export const mockApi = new Proxy({} as Record<string, (...args: unknown[]) => Promise<unknown>>, {
  get(_, method: string | symbol) {
    // Symbols + `then` must return undefined: a thenable Proxy hangs `await`,
    // and console/matcher introspection would otherwise pollute `calls[]`.
    if (typeof method === 'symbol' || method === 'then') return undefined
    // Namespaced clients are objects, not callables.
    if (method in namespacedClients) return namespacedClients[method]
    return (...args: unknown[]) => {
      calls.push({ method, args })
      const a0 = args[0] as string | undefined
      switch (method) {
        case 'log': return _logHandler ? _logHandler(a0) : Promise.resolve(_fixtures.revisions)
        case 'info': return Promise.resolve(_fixtures.info)
        case 'workspaces': return Promise.resolve(_fixtures.workspaces)
        case 'aliases': return Promise.resolve(_fixtures.aliases)
        case 'pullRequests': return Promise.resolve(_fixtures.pullRequests)
        case 'bookmarks': return Promise.resolve(_fixtures.bookmarks)
        case 'remotes': return Promise.resolve(_fixtures.remotes)
        case 'revision': return Promise.resolve()
        case 'diff': return Promise.resolve({ diff: _fixtures.diffs[a0!] ?? '' })
        case 'files': return Promise.resolve(_fixtures.files[a0!] ?? [])
        case 'description': return Promise.resolve({ description: _fixtures.descriptions[a0!] ?? '' })
        case 'fileShow': return Promise.resolve({ content: '' })
        // Full-tree browser: every revision has one top-level README.md.
        case 'fileTree': return Promise.resolve({
          commit_id: a0, dir: args[1] ?? '', total_files: 1, truncated: false,
          entries: args[1] ? [] : [{ name: 'README.md', path: 'README.md', type: 'file' }],
        })
        case 'conflicts': return Promise.resolve([])
        case 'divergence': return Promise.resolve([])
        case 'staleImmutable': return Promise.resolve([])
        case 'evolog': return Promise.resolve([])
        case 'oplog': return Promise.resolve([])
        default: return Promise.resolve(okMutation)
      }
    }
  },
})

// ── Standalone-export stubs (network-touching exports outside the `api` object) ──

export const noopSub: (cb: (..._: unknown[]) => void) => () => void = () => () => {}
export const noopAsync: (..._: unknown[]) => Promise<void> = async () => {}

let _navCb: ((p: NavigatePayload) => void) | null = null
/** Fire the agent-navigate handler App registered via `onNavigate(cb)`. */
export function triggerNavigate(p: NavigatePayload): void {
  _navCb?.(p)
}

let _staleCb: ((opId: string) => void) | null = null
/** Fire the op-id staleness handler App registered via `onStale(cb)` —
 *  simulates an external operation observed via SSE/header. */
export function triggerStale(opId: string): void {
  _staleCb?.(opId)
}

/** Override map for `vi.mock('./lib/api')` — spread on top of importActual.
 *  Contains every network-touching named export App.svelte and its transitive
 *  imports (revision-navigator, DiffPanel) read. Pure helpers stay real. */
export const netStubs = {
  api: mockApi,
  wireAutoRefresh: () => () => {},
  onStale: (cb: (opId: string) => void) => { _staleCb = cb; return () => { _staleCb = null } },
  onStaleWC: noopSub,
  onPollFail: noopSub,
  onSSEState: noopSub,
  onNavigate: (cb: (p: NavigatePayload) => void) => { _navCb = cb; return () => { _navCb = null } },
  clearAllCaches: () => {},
  getCached: () => undefined,
  prefetchRevision: noopAsync,
  prefetchFilesBatch: noopAsync,
  fetchRevisionMeta: noopAsync,
  agentBaseURL: () => 'http://test/tab/0',
  // Tab-level helpers (AppShell uses these; App doesn't, but importActual
  // would expose the real fetch-backed ones to anyone who does):
  listTabs: async () => [],
  setActiveTab: () => {},
}
