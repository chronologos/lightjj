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
    working_copies?: string[]
  }
  description: string
  bookmarks?: string[]
  graph_lines: GraphLine[]
}

export interface Bookmark {
  name: string
  local?: { remote: string; commit_id: string; tracked: boolean }
  remotes?: { remote: string; commit_id: string; tracked: boolean }[]
  conflict: boolean
  backwards: boolean
  commit_id: string
}

// Op-ID tracking: detect when jj state changes outside the UI
let lastOpId: string | null = null
const staleCallbacks = new Set<() => void>()
let refreshQueued = false

// Response cache: keyed by "${cacheId}@${opId}", cleared on op-id change
const MAX_CACHE_SIZE = 200
const responseCache = new Map<string, unknown>()

// Default timeout for read-only requests (30s). Mutations get no timeout.
const READ_TIMEOUT_MS = 30_000

export function onStale(callback: () => void): () => void {
  staleCallbacks.add(callback)
  return () => { staleCallbacks.delete(callback) }
}

function trackOpId(res: Response) {
  // Track op-id even on error responses — a failed mutation may still advance the op-id
  const opId = res.headers.get('X-JJ-Op-Id')
  if (!opId) return
  if (lastOpId !== null && opId !== lastOpId) {
    lastOpId = opId
    responseCache.clear()
    if (staleCallbacks.size > 0 && !refreshQueued) {
      refreshQueued = true
      // Deduplicates within a single tick; resets after callbacks fire
      queueMicrotask(() => {
        refreshQueued = false
        for (const cb of [...staleCallbacks]) cb()
      })
    }
  } else {
    lastOpId = opId
  }
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
    const data = await res.json()
    if (!res.ok) {
      throw new Error(data.error || `HTTP ${res.status}`)
    }
    return data as T
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
  if (lastOpId) {
    const key = `${cacheId}@${lastOpId}`
    if (responseCache.has(key)) return responseCache.get(key) as T
  }
  const opIdAtStart = lastOpId
  const result = await request<T>(url)
  // Only cache if op-id hasn't been advanced by a concurrent request.
  // If opIdAtStart was null (first request seeding the op-id), caching is safe.
  if (lastOpId && (opIdAtStart === null || lastOpId === opIdAtStart)) {
    if (responseCache.size >= MAX_CACHE_SIZE) responseCache.clear()
    responseCache.set(`${cacheId}@${lastOpId}`, result)
  }
  return result
}

// Check if a revision's diff + files are both cached (useful for debounce decisions)
export function isCached(revision: string): boolean {
  if (!lastOpId) return false
  return responseCache.has(`diff:${revision}@${lastOpId}`) &&
         responseCache.has(`files:${revision}@${lastOpId}`)
}

export interface FileChange {
  type: string
  path: string
  additions: number
  deletions: number
  conflict: boolean
}

export interface OpEntry {
  id: string
  description: string
  time: string
  is_current: boolean
}

export interface Workspace {
  name: string
  change_id: string
  commit_id: string
}

export const api = {
  log: (revset?: string, limit?: number) => {
    const params = new URLSearchParams()
    if (revset) params.set('revset', revset)
    if (limit) params.set('limit', String(limit))
    return request<LogEntry[]>(`/api/log?${params}`)
  },

  bookmarks: (revset?: string) => {
    const params = new URLSearchParams()
    if (revset) params.set('revset', revset)
    return request<Bookmark[]>(`/api/bookmarks?${params}`)
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

  remotes: () => request<string[]>('/api/remotes'),

  workspaces: () => cachedRequest<Workspace[]>('workspaces', '/api/workspaces'),

  oplog: (limit?: number) => {
    const params = new URLSearchParams()
    if (limit) params.set('limit', String(limit))
    return request<OpEntry[]>(`/api/oplog?${params}`)
  },

  evolog: (revision: string) => {
    const params = new URLSearchParams({ revision })
    return cachedRequest<{ output: string }>('evolog:' + revision, `/api/evolog?${params}`)
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

  rebase: (revisions: string[], destination: string, sourceMode?: string, targetMode?: string) =>
    post<{ output: string }>('/api/rebase', { revisions, destination, source_mode: sourceMode, target_mode: targetMode }),

  split: (revision: string, files: string[], parallel?: boolean) =>
    post<{ output: string }>('/api/split', { revision, files, parallel }),

  squash: (revisions: string[], destination: string, opts?: {
    files?: string[], keepEmptied?: boolean, useDestinationMessage?: boolean
  }) =>
    post<{ output: string }>('/api/squash', {
      revisions, destination,
      files: opts?.files, keep_emptied: opts?.keepEmptied,
      use_destination_message: opts?.useDestinationMessage,
    }),

  undo: () => post<{ output: string }>('/api/undo', {}),

  commit: () => post<{ output: string }>('/api/commit', {}),

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
}

// Test-only exports for cache inspection/reset
export const _testInternals = {
  get lastOpId() { return lastOpId },
  set lastOpId(v: string | null) { lastOpId = v },
  get cache() { return responseCache },
  get MAX_CACHE_SIZE() { return MAX_CACHE_SIZE },
  get staleCallbacks() { return staleCallbacks },
  get refreshQueued() { return refreshQueued },
  set refreshQueued(v: boolean) { refreshQueued = v },
}
