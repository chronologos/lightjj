// API client for lightjj backend

export interface GraphLine {
  gutter: string
  content?: string
  is_node?: boolean
}

export interface LogEntry {
  commit: {
    change_id: string
    commit_id: string
    change_prefix: number
    commit_prefix: number
    is_working_copy: boolean
    hidden: boolean
    immutable: boolean
    conflicted: boolean
    divergent: boolean
    empty: boolean
    working_copies?: string[]
    parent_ids?: string[]
  }
  description: string
  bookmarks?: string[]
  graph_lines: GraphLine[]
}

export type AnnotationSeverity = 'must-fix' | 'suggestion' | 'question' | 'nitpick'
export type AnnotationStatus = 'open' | 'resolved' | 'orphaned'

export interface Annotation {
  id: string
  changeId: string
  filePath: string
  lineNum: number
  lineContent: string // snapshot for re-anchor after agent iterates
  comment: string
  severity: AnnotationSeverity
  createdAt: number
  createdAtCommitId: string // for evolog attribution + diffRange re-anchor
  status: AnnotationStatus
  resolvedAtCommitId?: string
}

// One commit in the divergence dataset (mutable divergent + their descendants).
// Mirrors internal/jj/divergence.go DivergenceEntry. See docs/jj-divergence.md.
export interface DivergenceEntry {
  change_id: string
  commit_id: string
  divergent: boolean
  parent_commit_ids: string[]
  parent_change_ids: string[]
  wc_reachable: boolean     // contained_in("::working_copies()") — needs tautology guard, see divergence.ts
  bookmarks: string[]
  description: string
  empty: boolean            // for descendant-confirm: empty → silent abandon, non-empty → prompt
  is_working_copy: boolean  // @ IS this commit — tautology guard for wc_reachable
}

export interface BookmarkRemote {
  remote: string
  commit_id: string
  description: string  // first line
  ago: string          // committer timestamp relative ("3 days ago")
  tracked: boolean
  // ahead = commits on remote not in local (pull needed)
  // behind = commits in local not on remote (push needed)
  // Only meaningful when tracked; zero otherwise.
  ahead: number
  behind: number
}

export interface Bookmark {
  name: string
  local?: BookmarkRemote  // undefined = remote-only OR deleted-local
  remotes?: BookmarkRemote[]
  // added_targets: "+" sides of a conflict. For non-conflict, single
  // element equal to commit_id. Source of truth for conflict resolution.
  added_targets?: string[]
  conflict: boolean
  synced: boolean
  commit_id: string  // empty when conflict
}

// Op-ID tracking: detect when jj state changes outside the UI.
// Used ONLY to trigger log/graph refresh via staleCallbacks — NOT for cache
// invalidation. Per-revision data is keyed by commit_id (content-addressed,
// self-invalidating) so op-id changes don't touch the cache at all.
let lastOpId: string | null = null
const staleCallbacks = new Set<() => void>()
let refreshQueued = false

// Per-revision cache keyed by commit_id. A commit_id is a content hash of
// tree + parents + message — if it hasn't changed, the cached diff/files/
// description are provably valid. No op-id suffix, no clear-on-mutation.
// Operations like `jj new`, `jj abandon` (leaf), `jj undo` leave existing
// commit_ids unchanged → zero cache invalidation. Only rewrites (describe,
// rebase, squash) change commit_ids, and then only for the rewritten commit
// and its descendants — the rest stay cached.
export const MAX_CACHE_SIZE = 500
const cache = new Map<string, unknown>()

// Timeouts for non-streaming requests. Reads: 30s. Mutations: 60s — actual
// jj mutations finish in <1s even on large repos; the timeout catches hangs
// (SSH stall, jj deadlock, stuck WC lock). Streaming mutations (git push/fetch)
// go through streamPost, NOT request(), and are unbounded by design.
const READ_TIMEOUT_MS = 30_000
const MUTATION_TIMEOUT_MS = 60_000

export function onStale(callback: () => void): () => void {
  staleCallbacks.add(callback)
  return () => { staleCallbacks.delete(callback) }
}

// Per-repo session memos — cleared by both setActiveTab (different repo) and
// clearAllCaches (hard refresh). Single function so adding a memo touches one place.
function clearSessionMemos(): void {
  _remotes = undefined
  _aliases = undefined
  _info = undefined
}

/** Hard refresh: clear the cache. Use for explicit user-triggered refresh. */
export function clearAllCaches(): void {
  cache.clear()
  clearSessionMemos()
}

// --- Multi-tab routing ---
// Each tab is a full Server mounted at /tab/{id}/ on the backend. basePath
// is prepended to every api.* request. The commit_id-keyed cache above is
// GLOBAL — commit_id is a SHA-256 content hash, collision across repos is
// cryptographically negligible, so switching back to a tab serves cached
// diffs instantly. Only the per-repo session memos (remotes/aliases/info)
// need clearing on switch.
//
// Default '/tab/0': the backend always mounts the startup repo as tab 0.
// This must be set before any module-level fetch fires (config.svelte.ts
// is exempt — it uses raw fetch('/api/config') which TabManager routes
// at the top level, no prefix needed).
let basePath = '/tab/0'

export interface TabInfo {
  id: string
  kind: string
  name: string
  path: string
}

export function setActiveTab(id: string): void {
  basePath = '/tab/' + id
  // The commit_id cache is NOT cleared (globally safe, see above); only
  // per-repo memos. lastOpId reset: tab B's first response sets it cleanly
  // (changed=false when prior is null). Without this, B's op-id ≠ A's
  // lastOpId → spurious onStale. One wrinkle: an in-flight request from A
  // can arrive after this reset and seed A's op-id — B's next response then
  // fires one redundant loadLog. Bounded, guarded by App.svelte's !loading
  // check; not worth basePath-capture-at-request-entry.
  clearSessionMemos()
  lastOpId = null
}

// Per-tab routing: /api/* is the only namespace Server.Mux owns, so that
// prefix is the discriminant. Host-level calls (/tabs) pass through.
// config.svelte.ts's /api/config never reaches here — it uses raw fetch()
// (TabManager routes /api/config at the top level for it); requests that DO
// pass through here get prefixed, which also works (Server.Mux has the route
// too). The prefix check is for /tabs, not /api/config.
function tabScoped(url: string): string {
  return url.startsWith('/api/') ? basePath + url : url
}

// Tab-management calls hit /tabs (no basePath — they're host-level).
export const listTabs = () => request<TabInfo[]>('/tabs')
export const openTab = (path: string) =>
  request<TabInfo>('/tabs', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path }),
  })
export const closeTab = (id: string) =>
  request<void>('/tabs/' + id, { method: 'DELETE' })

// notifyOpId is the single op-id ingestion point. Called by both the HTTP
// header path (trackOpId) and the SSE push path (wireAutoRefresh). The lastOpId
// comparison deduplicates across sources: a UI-initiated mutation fires the
// header first, then the SSE event arrives ~150ms later with the same op-id
// and is a no-op. Fires staleCallbacks to trigger loadLog() — the cache is
// NOT touched (commit_id-keyed entries stay valid across op-id changes).
function notifyOpId(opId: string) {
  if (!opId) return
  const changed = lastOpId !== null && opId !== lastOpId
  lastOpId = opId
  if (!changed) return

  if (staleCallbacks.size > 0 && !refreshQueued) {
    refreshQueued = true
    // Deduplicates within a single tick; resets after callbacks fire
    queueMicrotask(() => {
      refreshQueued = false
      for (const cb of [...staleCallbacks]) cb()
    })
  }
}

function trackOpId(res: Response) {
  // Track op-id even on error responses — a failed mutation may still advance the op-id
  const opId = res.headers.get('X-JJ-Op-Id')
  if (opId) notifyOpId(opId)
}

// wireAutoRefresh sets up both auto-refresh sources:
//   1. SSE (/api/events) — server pushes op-id on fsnotify/inotifywait events
//   2. visibilitychange → POST /api/snapshot — fires on tab focus so users
//      don't wait up to 5s for the server loop after editing elsewhere
// Both feed notifyOpId → onStale. Works in SSH mode: SSE may close (no watcher)
// but the snapshot response's X-JJ-Op-Id header still carries refresh.
// Returns a cleanup fn that tears down both.
//
// SSE reconnects on backend restart using the same everSawEvent heuristic as
// watcher.go's sshWatchLoop: handleEvents sends the current op-id immediately
// on connect, so if we NEVER got one → watcher is absent (--no-watch or 204).
// CLOSED-after-events → transient (backend restart), reconnect with backoff.
export function wireAutoRefresh(): () => void {
  let es: EventSource | null = null
  let reconnectTimer: number | undefined
  let backoff = 1000
  let stopped = false
  let everSawEvent = false
  let closesWithoutEvent = 0

  function connect() {
    if (stopped) return
    let sawEventThisConn = false
    es = new EventSource(tabScoped('/api/events'))

    es.addEventListener('open', () => { backoff = 1000 })

    es.addEventListener('op', (ev) => {
      everSawEvent = true
      sawEventThisConn = true
      closesWithoutEvent = 0
      try {
        const { op_id } = JSON.parse(ev.data) as { op_id: string }
        notifyOpId(op_id)
      } catch { /* malformed event — ignore */ }
    })

    // Network drop → readyState CONNECTING (browser retries automatically).
    // Non-200 response (including 204 from handleEventsDisabled — spec is
    // exact-match "status is not 200") → readyState CLOSED.
    es.addEventListener('error', () => {
      if (es?.readyState !== EventSource.CLOSED) return
      es.close()
      es = null
      if (stopped) return
      if (!sawEventThisConn) closesWithoutEvent++
      // handleEvents sends op-id immediately on connect. Never seeing one means
      // the watcher isn't wired. `everSawEvent` covers first-connect; the counter
      // covers backend-restarted-with-watcher-disabled (3 consecutive 204s).
      if (!everSawEvent || closesWithoutEvent >= 3) {
        console.warn('lightjj: SSE auto-refresh unavailable (watcher disabled)')
        return
      }
      reconnectTimer = window.setTimeout(connect, backoff)
      backoff = Math.min(backoff * 2, 30_000)
    })
  }

  connect()

  // In-flight flag: rapid alt-tabbing shouldn't stack requests. In SSH mode
  // each snapshot is two round trips (util snapshot + op log ≈ 880ms) — N
  // concurrent calls is N× SSH traffic, most of it redundant.
  let snapshotInFlight = false
  const onVisible = () => {
    if (document.visibilityState !== 'visible' || snapshotInFlight) return
    snapshotInFlight = true
    api.snapshot()
      .catch(() => {}) // WC lock contention expected; next tick catches up
      .finally(() => { snapshotInFlight = false })
  }
  document.addEventListener('visibilitychange', onVisible)

  return () => {
    stopped = true
    clearTimeout(reconnectTimer)
    es?.close()
    document.removeEventListener('visibilitychange', onVisible)
  }
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const full = tabScoped(url)
  // All non-streaming requests get a timeout. Streaming (gitPush/gitFetch)
  // bypasses this function entirely so "push can take minutes" is handled
  // structurally, not by special-casing POST here. DELETE counts as a
  // mutation (60s) — closeTab/deleteAnnotation previously had NO timeout;
  // now they have the same hang-protection as POST.
  const isRead = !init?.method || init.method === 'GET'
  let signal = init?.signal
  let timeoutId: ReturnType<typeof setTimeout> | undefined
  if (!signal) {
    const controller = new AbortController()
    signal = controller.signal
    timeoutId = setTimeout(() => controller.abort(), isRead ? READ_TIMEOUT_MS : MUTATION_TIMEOUT_MS)
  }

  try {
    const res = await fetch(full, signal ? { ...init, signal } : init)
    if (timeoutId !== undefined) clearTimeout(timeoutId) // disarm after headers arrive
    trackOpId(res)
    if (!res.ok) {
      // Parse error body defensively — non-JSON bodies (Go panic, proxy error)
      // should surface the HTTP status, not a JSON parse error.
      const data = await res.json().catch(() => null) as { error?: string } | null
      throw new Error(data?.error || `HTTP ${res.status}: ${res.statusText}`)
    }
    // DELETE handlers may return 200 with empty body (e.g., /api/annotations).
    // res.json() on a 0-byte body throws SyntaxError → every request<void>()
    // silently failed. Check Content-Length first (Go's WriteHeader sets it
    // to 0 for body-less responses); fall back to graceful catch if unset.
    const len = res.headers.get('Content-Length')
    if (len === '0') return undefined as T
    return await res.json().catch(() => undefined) as T
  } catch (e) {
    if (timeoutId !== undefined) clearTimeout(timeoutId)
    if (e instanceof DOMException && e.name === 'AbortError') {
      // Mutation timeout: the jj command may have completed server-side
      // before response delivery stalled (esp. SSH). The SSE watcher will
      // still fire the op-id update → log refresh picks it up. Tell the
      // user to check rather than assume the operation failed.
      throw new Error(isRead
        ? 'Request timed out'
        : 'Request timed out — the operation may have completed (check the log)')
    }
    throw e
  }
}

function post<T>(url: string, body: unknown): Promise<T> {
  return request<T>(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

/** Consumes an NDJSON stream from streamMutation: `{"line":...}` progress
 *  lines until `{"done":true, output|error}`. onLine fires per progress line
 *  as it arrives (live status-bar update). Resolves/rejects on the terminal
 *  message — same `{output}` shape as runMutation so callers stay unchanged. */
async function streamPost(
  url: string,
  body: unknown,
  onLine: (line: string) => void,
): Promise<MutationResult> {
  const res = await fetch(tabScoped(url), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!res.ok) {
    // Pre-stream rejection (400 validation) — still JSON, not NDJSON.
    const data = await res.json().catch(() => null) as { error?: string } | null
    throw new Error(data?.error || `HTTP ${res.status}`)
  }
  if (!res.body) throw new Error('no response body')

  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader()
  let buf = ''
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buf += value
      let nl: number
      while ((nl = buf.indexOf('\n')) >= 0) {
        const raw = buf.slice(0, nl)
        buf = buf.slice(nl + 1)
        if (!raw) continue
        const msg = JSON.parse(raw)
        if (msg.done) {
          // In-band op-id (header slot was already flushed) — restores SSE
          // dedup parity with runMutation so the watcher's broadcast doesn't
          // fire a redundant loadLog().
          if (msg.op_id) notifyOpId(msg.op_id)
          if (msg.error) throw new Error(msg.error)
          return { output: msg.output ?? '', warnings: msg.warnings }
        }
        if (msg.line !== undefined) onLine(msg.line)
      }
    }
  } finally {
    // cancel() propagates through TextDecoderStream to abort the fetch body
    // source → server's r.Context() cancels → jj subprocess killed. On the
    // happy path (return/throw after msg.done) the stream is drained and
    // cancel is a no-op. releaseLock() alone would leak: WriteTimeout is
    // disabled server-side, so a throw mid-stream would strand the handler.
    reader.cancel().catch(() => {})
  }
  throw new Error('stream ended without completion marker')
}

async function cachedRequest<T>(cacheId: string, url: string): Promise<T> {
  if (cache.has(cacheId)) {
    // LRU bump: delete + re-insert moves entry to newest position.
    const v = cache.get(cacheId) as T
    cache.delete(cacheId)
    cache.set(cacheId, v)
    return v
  }
  const result = await request<T>(url)
  storeInCache(cacheId, result)
  return result
}

// storeInCache is the single cache-write path. Used by cachedRequest() and by
// api.revision() to seed individual cache keys from a batch response. No
// concurrency guard needed — commit_id is immutable by construction, so a
// value fetched for commit_id X is valid regardless of what op-id advances
// happened during the fetch.
function storeInCache(cacheId: string, result: unknown) {
  // Delete-first: Map.set on an existing key does NOT reorder. Without the
  // delete, a re-write at capacity would evict the oldest entry even though
  // this key was already present — wasting a slot and killing a fresher entry.
  cache.delete(cacheId)
  cache.set(cacheId, result)
  if (cache.size > MAX_CACHE_SIZE) {
    cache.delete(cache.keys().next().value!)
  }
}

/** Read cached diff/files/description synchronously. Returns null if any key
 *  is missing. Used by selectRevision to set loader values in the SAME tick
 *  as selectedIndex — Svelte batches both into one render, eliminating the
 *  stale-content flash that setTimeout(0) deferral would cause. */
export function getCached(commitId: string): { diff: string; files: FileChange[]; description: string } | null {
  const d = cache.get(`diff:${commitId}`) as { diff: string } | undefined
  const f = cache.get(`files:${commitId}`) as FileChange[] | undefined
  const desc = cache.get(`desc:${commitId}`) as { description: string } | undefined
  if (!d || !f || !desc) return null
  // LRU bump — actively navigating to a revision is the strongest recency
  // signal. storeInCache does delete+reinsert, matching cachedRequest.
  storeInCache(`diff:${commitId}`, d)
  storeInCache(`files:${commitId}`, f)
  storeInCache(`desc:${commitId}`, desc)
  return { diff: d.diff, files: f, description: desc.description }
}

/** Boolean check — direct Map.has() lookups. Used by prefetchRevision and
 *  api.revision to skip fetches. NOT getCached() — that does 3 LRU bumps
 *  (delete+reinsert) which is waste when the caller only wants a boolean. */
export function isCached(commitId: string): boolean {
  return cache.has(`diff:${commitId}`) && cache.has(`files:${commitId}`) && cache.has(`desc:${commitId}`)
}

interface RevisionResponse {
  diff: string
  files: FileChange[]
  description: string
}

// fetchRevision hits the batch endpoint and seeds the three individual cache
// keys (diff:X, files:X, desc:X) so subsequent api.diff()/files()/description()
// calls are microtask-fast cache hits. The shapes written to each key exactly
// match what the individual endpoints return — the cache doesn't care which
// wire protocol populated it.
async function fetchRevision(commitId: string): Promise<RevisionResponse> {
  // immutable=1: commit_id is a content hash, response is valid forever.
  // Browser disk cache survives page reload; our in-memory cache doesn't.
  const result = await request<RevisionResponse>(`/api/revision?revision=${encodeURIComponent(commitId)}&immutable=1`)
  storeInCache(`diff:${commitId}`, { diff: result.diff })
  storeInCache(`files:${commitId}`, result.files)
  // Backend returns description:"" when GetDescription fails (degraded mode,
  // no Cache-Control:immutable header). Don't poison the in-memory LRU with
  // a blank — let the next navigation retry. Empty-description revisions are
  // real (jj new), but the backend includes the header in that case, so the
  // browser HTTP cache catches the duplicate fetch.
  if (result.description !== '') {
    storeInCache(`desc:${commitId}`, { description: result.description })
  }
  return result
}

/** Warm the cache for a revision's diff/files/description without applying
 *  results to UI state. Fire-and-forget. Used during nav debounce to pre-load
 *  adjacent revisions so sequential j/k is instant. */
export function prefetchRevision(commitId: string): void {
  if (isCached(commitId)) return
  // Batch endpoint: one HTTP round-trip instead of three. Result seeds all
  // three cache keys. Errors swallowed: prefetch failures are invisible,
  // the real navigation will retry.
  fetchRevision(commitId).catch(() => {})
}

interface FilesBatchEntry {
  conflict: boolean
  files: FileChange[]
}

/** Pre-load file lists (status + path + line counts) for multiple commit_ids
 *  in one backend call (single jj subprocess for N revisions). Seeds the
 *  `files:X` cache key for each non-conflicted revision so the file-list
 *  sidebar shows instantly during j/k navigation.
 *
 *  Conflicted commits are skipped — they need conflict_side_count detail that
 *  the batch template doesn't provide. Those fall back to /api/files on actual
 *  navigation.
 *
 *  Fire-and-forget; errors swallowed. Call after loadLog() with a window of
 *  ~10 revisions around the selected index. */
export async function prefetchFilesBatch(commitIds: string[]): Promise<void> {
  const uncached = commitIds.filter(id => !cache.has(`files:${id}`))
  if (uncached.length === 0) return
  try {
    const result = await request<Record<string, FilesBatchEntry>>(
      `/api/files-batch?revisions=${encodeURIComponent(uncached.join(','))}`,
    )
    for (const [commitId, entry] of Object.entries(result)) {
      // Conflicted commits need side-count detail the batch call doesn't
      // provide. Skip seeding so actual navigation triggers /api/files.
      if (entry.conflict) continue
      storeInCache(`files:${commitId}`, entry.files)
    }
  } catch { /* prefetch failure is invisible — real nav retries via /api/files */ }
}

// Session-stable data — remotes/aliases don't change mid-session unless the
// user edits jj config externally. clearAllCaches() (hard refresh) resets.
let _remotes: Promise<string[]> | undefined
let _aliases: Promise<Alias[]> | undefined
let _info: Promise<InfoResponse> | undefined

export interface InfoResponse {
  hostname: string
  repo_path: string
  ssh_mode: boolean
  editor_configured: boolean
}

export interface FileChange {
  type: string
  path: string
  additions: number
  deletions: number
  conflict: boolean
  conflict_sides: number // 2 for 2-sided, 3+ for N-way. 0 if unknown.
}

export interface OpEntry {
  id: string
  description: string
  time: string
  is_current: boolean
}

export interface EvologEntry {
  commit_id: string
  time: string
  operation: string
  predecessor_ids: string[]
  /** Rebase-safe inter_diff (git format) — computed server-side via the
   *  CommitEvolutionEntry.inter_diff() template method. Empty string for
   *  metadata-only operations (describe, no-content rebase). */
  diff: string
}

export interface Workspace {
  name: string
  change_id: string
  commit_id: string
  path?: string
}

export interface WorkspacesResponse {
  current: string
  workspaces: Workspace[]
}

export interface Alias {
  name: string
  command: string[]
}

export interface PullRequest {
  bookmark: string
  url: string
  number: number
  is_draft: boolean
}

/** Returns the best unique identifier for a commit.
 *  Divergent and hidden commits share change_id, so we fall back to commit_id.
 *  Mirrors the Go Commit.GetChangeId() logic. */
export function effectiveId(commit: LogEntry['commit']): string {
  return (commit.divergent || commit.hidden) ? commit.commit_id : commit.change_id
}

/** What the diff panel is currently showing. Replaces the stringly-typed
 *  `activeRevisionId` (which was sometimes a commit_id and sometimes a
 *  `connected(X|Y)` revset — every consumer had to re-derive which case
 *  by checking `checkedRevisions.size`). */
/** Standard mutation response. `warnings` is jj's stderr on exit-0
 *  (conflict notices, no-op messages). Present only when non-empty. */
export type MutationResult = { output: string; warnings?: string }

export type DiffTarget =
  | { kind: 'single'; commitId: string; changeId: string; isWorkingCopy: boolean; immutable: boolean }
  | { kind: 'multi'; revset: string; commitIds: string[] }

/** Stable cache key for a DiffTarget. commit_id for single-rev
 *  (content-addressed, self-invalidating); revset string for multi-check
 *  (embeds commit_ids so still self-invalidating on rewrite). */
export function diffTargetKey(t: DiffTarget): string {
  return t.kind === 'single' ? t.commitId : t.revset
}

/** Builds a diff-safe revset from multiple revision IDs.
 *  connected() fills gaps so jj's "Cannot diff revsets with gaps" error
 *  can't fire. No-op for contiguous/branched selections.
 *  Sorted for stable cache keys (docs/CACHING.md §4). */
export function multiRevset(ids: string[]): string {
  if (ids.length === 0) return ''
  if (ids.length === 1) return ids[0]
  return `connected(${ids.toSorted().join('|')})`
}

/** Computes the connected closure of a set of checked commit IDs over the
 *  visible log. Returns the set of commit_ids that connected() would include
 *  — i.e., ancestors(checked) ∩ descendants(checked) within the log.
 *  Used to visually mark gap-fill revisions. Keys on commit_id (unique)
 *  since parent_ids refer to commit IDs. */
export function computeConnectedCommitIds(
  checkedCommitIds: Set<string>,
  revisions: LogEntry[],
): Set<string> {
  if (checkedCommitIds.size <= 1) return new Set(checkedCommitIds)

  const byCommitId = new Map<string, LogEntry>()
  const children = new Map<string, string[]>()
  for (const r of revisions) {
    const cid = r.commit.commit_id
    byCommitId.set(cid, r)
    for (const pid of r.commit.parent_ids ?? []) {
      if (!children.has(pid)) children.set(pid, [])
      children.get(pid)!.push(cid)
    }
  }

  // BFS helper — index-based queue to avoid O(n²) from Array.shift()
  const bfs = (next: (id: string) => string[]): Set<string> => {
    const seen = new Set<string>()
    const queue = [...checkedCommitIds]
    for (let i = 0; i < queue.length; i++) {
      const id = queue[i]
      if (seen.has(id)) continue
      seen.add(id)
      for (const n of next(id)) queue.push(n)
    }
    return seen
  }

  const anc = bfs(id => {
    const e = byCommitId.get(id)
    return e ? (e.commit.parent_ids ?? []).filter(p => byCommitId.has(p)) : []
  })
  const desc = bfs(id => children.get(id) ?? [])

  // connected(X) = ancestors(X) ∩ descendants(X)
  const result = new Set<string>()
  for (const id of anc) if (desc.has(id)) result.add(id)
  return result
}

export const api = {
  log: (revset?: string, limit?: number) => {
    const params = new URLSearchParams()
    if (revset) params.set('revset', revset)
    if (limit) params.set('limit', String(limit))
    return request<LogEntry[]>(`/api/log?${params}`)
  },

  bookmarks: (opts?: { revset?: string; local?: boolean }) => {
    const params = new URLSearchParams()
    if (opts?.revset) params.set('revset', opts.revset)
    if (opts?.local) params.set('local', 'true')
    return request<Bookmark[]>(`/api/bookmarks?${params}`)
  },

  /** Batch fetch diff + files + description in one round-trip, seeding
   *  individual cache keys. After this resolves, api.diff()/files()/description()
   *  for the same commit_id are cache hits. Prefer this for primary navigation;
   *  use the individual methods for one-off needs (e.g., DivergencePanel's
   *  standalone files() call, DiffPanel's context-expanded diff).
   *
   *  Pass commit_id, not change_id — commit_id is content-addressed, so the
   *  cache is self-invalidating across rewrites. */
  revision: async (commitId: string): Promise<void> => {
    if (isCached(commitId)) return
    await fetchRevision(commitId)
  },

  diff: (revision: string, file?: string, context?: number) => {
    const params = new URLSearchParams({ revision })
    if (file) params.set('file', file)
    if (context != null) params.set('context', String(context))
    const cacheId = 'diff:' + revision + (file ? ':' + file : '') + (context != null ? ':ctx' + context : '')
    return cachedRequest<{ diff: string }>(cacheId, `/api/diff?${params}`)
  },

  description: (revision: string) => {
    const params = new URLSearchParams({ revision })
    return cachedRequest<{ description: string }>('desc:' + revision, `/api/description?${params}`)
  },

  files: (revision: string) => {
    const params = new URLSearchParams({ revision })
    return cachedRequest<FileChange[]>('files:' + revision, `/api/files?${params}`)
  },

  fileShow: (revision: string, path: string) => {
    const params = new URLSearchParams({ revision, path })
    return request<{ content: string }>(`/api/file-show?${params}`)
  },

  fileWrite: (path: string, content: string) =>
    post<{ ok: boolean }>('/api/file-write', { path, content }),

  remotes: () => _remotes ??= request<string[]>('/api/remotes').catch(e => { _remotes = undefined; throw e }),

  info: () => _info ??= request<InfoResponse>('/api/info').catch(e => { _info = undefined; throw e }),

  // Workspaces is session-stable (changes only if user adds a workspace).
  // Plain request for now — promise-memoize later if load frequency warrants.
  workspaces: () => request<WorkspacesResponse>('/api/workspaces'),

  oplog: (limit?: number) => {
    const params = new URLSearchParams()
    if (limit) params.set('limit', String(limit))
    return request<OpEntry[]>(`/api/oplog?${params}`)
  },

  // Evolog content grows with each jj operation on a change — it cannot be
  // cached by commit_id (the change_id is the subject, and the history expands
  // over time). Uncached; loadEvolog is debounced in App.svelte so rapid j/k
  // won't fire N requests.
  evolog: (revision: string) => {
    const params = new URLSearchParams({ revision })
    return request<EvologEntry[]>(`/api/evolog?${params}`)
  },

  // Uncached: depends on op state (a mutation can create/resolve divergence
  // without changing any commit_id the panel already holds). Fetched on panel
  // open + after any mutation — same cadence as evolog.
  divergence: () => request<DivergenceEntry[]>('/api/divergence'),

  diffRange: (from: string, to: string, files?: string[]) => {
    const params = new URLSearchParams({ from, to })
    if (files?.length) files.forEach(f => params.append('files', f))
    return request<{ diff: string }>(`/api/diff-range?${params}`)
  },

  // Mutations
  newRevision: (revisions: string[]) =>
    post<MutationResult>('/api/new', { revisions }),

  edit: (revision: string, ignoreImmutable = false) =>
    post<MutationResult>('/api/edit', { revision, ignore_immutable: ignoreImmutable }),

  abandon: (revisions: string[], ignoreImmutable = false) =>
    post<MutationResult>('/api/abandon', { revisions, ignore_immutable: ignoreImmutable }),

  restore: (revision: string, files: string[]) =>
    post<MutationResult>('/api/restore', { revision, files }),

  describe: (revision: string, description: string) =>
    post<MutationResult>('/api/describe', { revision, description }),

  rebase: (revisions: string[], destination: string, sourceMode?: string, targetMode?: string, opts?: {
    skipEmptied?: boolean, ignoreImmutable?: boolean
  }) =>
    post<MutationResult>('/api/rebase', {
      revisions, destination, source_mode: sourceMode, target_mode: targetMode,
      skip_emptied: opts?.skipEmptied, ignore_immutable: opts?.ignoreImmutable,
    }),

  split: (revision: string, files: string[], parallel?: boolean) =>
    post<MutationResult>('/api/split', { revision, files, parallel }),

  squash: (revisions: string[], destination: string, opts?: {
    files?: string[], keepEmptied?: boolean, useDestinationMessage?: boolean, ignoreImmutable?: boolean
  }) =>
    post<MutationResult>('/api/squash', {
      revisions, destination,
      files: opts?.files, keep_emptied: opts?.keepEmptied,
      use_destination_message: opts?.useDestinationMessage,
      ignore_immutable: opts?.ignoreImmutable,
    }),

  undo: () => post<MutationResult>('/api/undo', {}),

  opUndo: (id: string) => post<MutationResult>('/api/op/undo', { id }),

  opRestore: (id: string) => post<MutationResult>('/api/op/restore', { id }),

  restoreFrom: (from: string, to: string) =>
    post<MutationResult>('/api/restore-from', { from, to }),

  openFile: (path: string, line?: number) =>
    post<{ ok: boolean }>('/api/open-file', { path, line }),

  snapshot: () => post<MutationResult>('/api/snapshot', {}),

  commit: (message: string = '') => post<MutationResult>('/api/commit', { message }),

  bookmarkSet: (revision: string, name: string) =>
    post<MutationResult>('/api/bookmark/set', { revision, name }),

  bookmarkDelete: (name: string) =>
    post<MutationResult>('/api/bookmark/delete', { name }),

  bookmarkMove: (name: string, revision: string) =>
    post<MutationResult>('/api/bookmark/move', { name, revision }),

  bookmarkAdvance: (name: string, revision: string) =>
    post<MutationResult>('/api/bookmark/advance', { name, revision }),

  bookmarkForget: (name: string) =>
    post<MutationResult>('/api/bookmark/forget', { name }),

  bookmarkTrack: (name: string, remote: string) =>
    post<MutationResult>('/api/bookmark/track', { name, remote }),

  bookmarkUntrack: (name: string, remote: string) =>
    post<MutationResult>('/api/bookmark/untrack', { name, remote }),

  gitPush: (flags: string[] | undefined, onLine: (line: string) => void) =>
    streamPost('/api/git/push', { flags }, onLine),

  gitFetch: (flags: string[] | undefined, onLine: (line: string) => void) =>
    streamPost('/api/git/fetch', { flags }, onLine),

  resolve: (revision: string, file: string, tool: ':ours' | ':theirs') =>
    post<MutationResult>('/api/resolve', { revision, file, tool }),

  pullRequests: () => request<PullRequest[]>('/api/pull-requests'),

  aliases: () => _aliases ??= request<Alias[]>('/api/aliases').catch(e => { _aliases = undefined; throw e }),

  runAlias: (name: string) =>
    post<MutationResult>('/api/alias', { name }),

  // Annotations are uncached — they're review-state, not revision content.
  // The set changes when the user adds/removes/resolves, and when the agent
  // iterates (re-anchor mutates lineNum/status). Backend is the source of
  // truth so spawned workspace tabs share one store.
  annotations: (changeId: string) =>
    request<Annotation[]>(`/api/annotations?changeId=${encodeURIComponent(changeId)}`),

  saveAnnotation: (ann: Annotation) =>
    post<Annotation>('/api/annotations', ann),

  deleteAnnotation: (changeId: string, id: string) =>
    request<void>(`/api/annotations?changeId=${encodeURIComponent(changeId)}&id=${encodeURIComponent(id)}`, { method: 'DELETE' }),

  clearAnnotations: (changeId: string) =>
    request<void>(`/api/annotations?changeId=${encodeURIComponent(changeId)}`, { method: 'DELETE' }),
}

// Test-only exports for cache inspection/reset
export const _testInternals = {
  get lastOpId() { return lastOpId },
  set lastOpId(v: string | null) { lastOpId = v },
  get cache() { return cache },
  get staleCallbacks() { return staleCallbacks },
  get refreshQueued() { return refreshQueued },
  set refreshQueued(v: boolean) { refreshQueued = v },
  resetSessionCaches: clearSessionMemos,
  get basePath() { return basePath },
  set basePath(v: string) { basePath = v },
}
