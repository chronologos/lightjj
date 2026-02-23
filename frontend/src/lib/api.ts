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

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init)
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
    return request<{ diff: string }>(`/api/diff?${params}`)
  },

  description: (revision: string) => {
    const params = new URLSearchParams({ revision })
    return request<{ description: string }>(`/api/description?${params}`)
  },

  status: (revision: string) => {
    const params = new URLSearchParams({ revision })
    return request<{ status: string }>(`/api/status?${params}`)
  },

  remotes: () => request<string[]>('/api/remotes'),

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
