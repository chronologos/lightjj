// Generic frequency tracker backed by localStorage.
// Usage: const history = recentActions('namespace')
// history.record('key')   — increment count
// history.count('key')    — get frequency (0 if never used)
// history.clear()         — reset all counts

const STORAGE_PREFIX = 'lightjj-recent:'
const MAX_ENTRIES = 200

export function recentActions(namespace: string) {
  const storageKey = STORAGE_PREFIX + namespace

  function load(): Record<string, number> {
    try {
      return JSON.parse(localStorage.getItem(storageKey) || '{}')
    } catch {
      return {}
    }
  }

  function save(data: Record<string, number>) {
    // Evict least-used entries if over limit
    const entries = Object.entries(data)
    if (entries.length > MAX_ENTRIES) {
      entries.sort((a, b) => b[1] - a[1])
      data = Object.fromEntries(entries.slice(0, MAX_ENTRIES))
    }
    try {
      localStorage.setItem(storageKey, JSON.stringify(data))
    } catch {
      // localStorage may be unavailable (private mode, quota, test env)
    }
  }

  return {
    record(key: string) {
      const data = load()
      data[key] = (data[key] ?? 0) + 1
      save(data)
    },

    count(key: string): number {
      return load()[key] ?? 0
    },

    clear() {
      try { localStorage.removeItem(storageKey) } catch {}
    },
  }
}
