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

export interface Bookmark {
  name: string
  local?: { remote: string; commit_id: string; tracked: boolean }
  remotes?: { remote: string; commit_id: string; tracked: boolean }[]
  conflict: boolean
  backwards: boolean
  commit_id: string
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
const MAX_CACHE_SIZE = 500
const cache = new Map<string, unknown>()

// Default timeout for read-only requests (30s). Mutations get no timeout.
const READ_TIMEOUT_MS = 30_000

export function onStale(callback: () => void): () => void {
  staleCallbacks.add(callback)
  return () => { staleCallbacks.delete(callback) }
}

/** Hard refresh: clear the cache. Use for explicit user-triggered refresh. */
export function clearAllCaches(): void {
  cache.clear()
  _remotes = undefined
  _aliases = undefined
}

// notifyOpId is the single op-id ingestion point. Called by both the HTTP
// header path (trackOpId) and the SSE push path (watchEvents). The lastOpId
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

// watchEvents opens an SSE connection to /api/events and routes incoming
// op-id pushes through the same dedup path as the HTTP header. Auto-reconnects
// via the browser's native EventSource retry. If the server returns non-200
// (204 for SSH mode, 404 if route missing), readyState goes to CLOSED and we
// stop — no polling fallback; the header path already covers UI mutations.
export function watchEvents(): () => void {
  const es = new EventSource('/api/events')

  es.addEventListener('op', (ev) => {
    try {
      const { op_id } = JSON.parse(ev.data) as { op_id: string }
      notifyOpId(op_id)
    } catch { /* malformed event — ignore */ }
  })

  // Network drop → readyState CONNECTING (browser retries automatically).
  // Non-200 response → readyState CLOSED. close() on an already-CLOSED
  // source is a spec no-op, so no guard needed for the cleanup-fn path.
  es.addEventListener('error', () => {
    if (es.readyState === EventSource.CLOSED) {
      console.warn('lightjj: SSE auto-refresh disabled (server returned non-200 or watch unavailable)')
      es.close()
    }
  })

  return () => es.close()
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  // Add timeout for GET requests (reads). Mutations (POST) have no timeout
  // since git push/fetch can take minutes.
  const isRead = !init?.method || init.method === 'GET'
  let signal = init?.signal
  let timeoutId: ReturnType<typeof setTimeout> | undefined
  if (isRead && !signal) {
    const controller = new AbortController()
    signal = controller.signal
    timeoutId = setTimeout(() => controller.abort(), READ_TIMEOUT_MS)
  }

  try {
    const res = await fetch(url, signal ? { ...init, signal } : init)
    if (timeoutId !== undefined) clearTimeout(timeoutId) // disarm after headers arrive
    trackOpId(res)
    if (!res.ok) {
      // Parse error body defensively — non-JSON bodies (Go panic, proxy error)
      // should surface the HTTP status, not a JSON parse error.
      const data = await res.json().catch(() => null) as { error?: string } | null
      throw new Error(data?.error || `HTTP ${res.status}: ${res.statusText}`)
    }
    return await res.json() as T
  } catch (e) {
    if (timeoutId !== undefined) clearTimeout(timeoutId)
    if (e instanceof DOMException && e.name === 'AbortError') {
      throw new Error('Request timed out')
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

/** Boolean check — delegates to getCached. Used by prefetchRevision and
 *  api.revision to skip fetches when all three keys are already cached. */
export function isCached(commitId: string): boolean {
  return getCached(commitId) !== null
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
  storeInCache(`desc:${commitId}`, { description: result.description })
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
export type DiffTarget =
  | { kind: 'single'; commitId: string; changeId: string; isWorkingCopy: boolean }
  | { kind: 'multi'; revset: string; commitIds: string[] }

/** Stable cache key for a DiffTarget. commit_id for single-rev
 *  (content-addressed, self-invalidating); revset string for multi-check
 *  (embeds commit_ids so still self-invalidating on rewrite). */
export function diffTargetKey(t: DiffTarget): string {
  return t.kind === 'single' ? t.commitId : t.revset
}

/** Builds a diff-safe revset from multiple revision IDs.
 *  connected() fills gaps so jj's "Cannot diff revsets with gaps" error
 *  can't fire. No-op for contiguous/branched selections. */
export function multiRevset(ids: string[]): string {
  if (ids.length === 0) return ''
  if (ids.length === 1) return ids[0]
  return `connected(${ids.join('|')})`
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
    if (context) params.set('context', String(context))
    const cacheId = 'diff:' + revision + (file ? ':' + file : '') + (context ? ':ctx' + context : '')
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

  // Workspaces is session-stable (changes only if user adds a workspace).
  // Plain request for now — promise-memoize later if load frequency warrants.
  workspaces: () => request<WorkspacesResponse>('/api/workspaces'),

  workspaceOpen: (name: string) =>
    post<{ url: string }>('/api/workspace/open', { name }),

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

  diffRange: (from: string, to: string, files?: string[]) => {
    const params = new URLSearchParams({ from, to })
    if (files?.length) files.forEach(f => params.append('files', f))
    return request<{ diff: string }>(`/api/diff-range?${params}`)
  },

  // Mutations
  newRevision: (revisions: string[]) =>
    post<{ output: string }>('/api/new', { revisions }),

  edit: (revision: string, ignoreImmutable = false) =>
    post<{ output: string }>('/api/edit', { revision, ignore_immutable: ignoreImmutable }),

  abandon: (revisions: string[], ignoreImmutable = false) =>
    post<{ output: string }>('/api/abandon', { revisions, ignore_immutable: ignoreImmutable }),

  describe: (revision: string, description: string) =>
    post<{ output: string }>('/api/describe', { revision, description }),

  rebase: (revisions: string[], destination: string, sourceMode?: string, targetMode?: string, opts?: {
    skipEmptied?: boolean, ignoreImmutable?: boolean
  }) =>
    post<{ output: string }>('/api/rebase', {
      revisions, destination, source_mode: sourceMode, target_mode: targetMode,
      skip_emptied: opts?.skipEmptied, ignore_immutable: opts?.ignoreImmutable,
    }),

  split: (revision: string, files: string[], parallel?: boolean) =>
    post<{ output: string }>('/api/split', { revision, files, parallel }),

  squash: (revisions: string[], destination: string, opts?: {
    files?: string[], keepEmptied?: boolean, useDestinationMessage?: boolean, ignoreImmutable?: boolean
  }) =>
    post<{ output: string }>('/api/squash', {
      revisions, destination,
      files: opts?.files, keep_emptied: opts?.keepEmptied,
      use_destination_message: opts?.useDestinationMessage,
      ignore_immutable: opts?.ignoreImmutable,
    }),

  undo: () => post<{ output: string }>('/api/undo', {}),

  commit: (message: string = '') => post<{ output: string }>('/api/commit', { message }),

  bookmarkSet: (revision: string, name: string) =>
    post<{ output: string }>('/api/bookmark/set', { revision, name }),

  bookmarkDelete: (name: string) =>
    post<{ output: string }>('/api/bookmark/delete', { name }),

  bookmarkMove: (name: string, revision: string) =>
    post<{ output: string }>('/api/bookmark/move', { name, revision }),

  bookmarkForget: (name: string) =>
    post<{ output: string }>('/api/bookmark/forget', { name }),

  bookmarkTrack: (name: string, remote: string) =>
    post<{ output: string }>('/api/bookmark/track', { name, remote }),

  bookmarkUntrack: (name: string, remote: string) =>
    post<{ output: string }>('/api/bookmark/untrack', { name, remote }),

  gitPush: (flags?: string[]) =>
    post<{ output: string }>('/api/git/push', { flags }),

  gitFetch: (flags?: string[]) =>
    post<{ output: string }>('/api/git/fetch', { flags }),

  resolve: (revision: string, file: string, tool: ':ours' | ':theirs') =>
    post<{ output: string }>('/api/resolve', { revision, file, tool }),

  pullRequests: () => request<PullRequest[]>('/api/pull-requests'),

  aliases: () => _aliases ??= request<Alias[]>('/api/aliases').catch(e => { _aliases = undefined; throw e }),

  runAlias: (name: string) =>
    post<{ output: string }>('/api/alias', { name }),

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
  get MAX_CACHE_SIZE() { return MAX_CACHE_SIZE },
  get staleCallbacks() { return staleCallbacks },
  get refreshQueued() { return refreshQueued },
  set refreshQueued(v: boolean) { refreshQueued = v },
  resetSessionCaches() { _remotes = undefined; _aliases = undefined },
}
