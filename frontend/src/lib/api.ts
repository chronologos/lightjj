// API client for jj-web backend

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
let onStaleCallback: (() => void) | null = null
let refreshQueued = false

// Response cache: keyed by "${cacheId}@${opId}", cleared on op-id change
const MAX_CACHE_SIZE = 200
const responseCache = new Map<string, unknown>()

export function onStale(callback: () => void) {
  onStaleCallback = callback
}

function trackOpId(res: Response) {
  // Track op-id even on error responses — a failed mutation may still advance the op-id
  const opId = res.headers.get('X-JJ-Op-Id')
  if (!opId) return
  if (lastOpId !== null && opId !== lastOpId) {
    lastOpId = opId
    responseCache.clear()
    if (onStaleCallback && !refreshQueued) {
      refreshQueued = true
      queueMicrotask(() => {
        refreshQueued = false
        onStaleCallback?.()
      })
    }
  } else {
    lastOpId = opId
  }
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init)
  trackOpId(res)
  const data = await res.json()
  if (!res.ok) {
    throw new Error(data.error || `HTTP ${res.status}`)
  }
  return data as T
}

function post<T>(url: string, body: unknown): Promise<T> {
  return request<T>(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

async function cachedRequest<T>(cacheId: string, url: string): Promise<T> {
  const key = `${cacheId}@${lastOpId}`
  if (lastOpId && responseCache.has(key)) return responseCache.get(key) as T
  const result = await request<T>(url)
  if (lastOpId) {
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
}

export interface OpEntry {
  id: string
  description: string
  time: string
  is_current: boolean
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

  diff: (revision: string, file?: string) => {
    const params = new URLSearchParams({ revision })
    if (file) params.set('file', file)
    const cacheId = 'diff:' + revision + (file ? ':' + file : '')
    return cachedRequest<{ diff: string }>(cacheId, `/api/diff?${params}`)
  },

  description: (revision: string) => {
    const params = new URLSearchParams({ revision })
    return request<{ description: string }>(`/api/description?${params}`)
  },

  files: (revision: string) => {
    const params = new URLSearchParams({ revision })
    return cachedRequest<FileChange[]>('files:' + revision, `/api/files?${params}`)
  },

  remotes: () => request<string[]>('/api/remotes'),

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

  rebase: (revisions: string[], destination: string) =>
    post<{ output: string }>('/api/rebase', { revisions, destination }),

  squash: (revisions: string[], destination: string) =>
    post<{ output: string }>('/api/squash', { revisions, destination }),

  undo: () => post<{ output: string }>('/api/undo', {}),

  bookmarkSet: (revision: string, name: string) =>
    post<{ output: string }>('/api/bookmark/set', { revision, name }),

  bookmarkDelete: (name: string) =>
    post<{ output: string }>('/api/bookmark/delete', { name }),

  gitPush: (flags?: string[]) =>
    post<{ output: string }>('/api/git/push', { flags }),

  gitFetch: (flags?: string[]) =>
    post<{ output: string }>('/api/git/fetch', { flags }),
}

// Test-only exports for cache inspection/reset
export const _testInternals = {
  get lastOpId() { return lastOpId },
  set lastOpId(v: string | null) { lastOpId = v },
  get cache() { return responseCache },
  get MAX_CACHE_SIZE() { return MAX_CACHE_SIZE },
}
