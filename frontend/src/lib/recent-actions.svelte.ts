// Generic last-used tracker, persisted server-side in the machine-state store
// (state.json via GET/POST /api/state/recent-actions).
//
// Previously this rode along inside config.json via config.svelte.ts — which
// meant every bookmark action ran the JSONC comment-preserving config write
// path on the backend. Machine-written values now live in state.json (plain
// JSON, see internal/api/state.go), so recording a timestamp can never
// disturb the user's hand-commented config. config.svelte.ts keeps a
// `config.recentActions` getter/setter that delegates here for back-compat.
//
// Values are Date.now() timestamps (recency, not frequency) — "what did I
// touch last" ages out naturally, where a frequency count lets a long-time
// favourite (main) sit on top forever. Values persisted by the old
// frequency-counter version read as ancient timestamps: they never rank as
// recent and are evicted first, so no migration is needed.
//
// Persistence is best-effort: hydration and saves swallow errors (backend
// down, partially mocked api in component tests). Worst case, recency
// sorting degrades until the next successful round trip. The whole map is
// POSTed on save (last-writer-wins across browser tabs / instances) —
// acceptable for recency data.
//
// Usage: const history = recentActions('namespace')
// history.record('key')   — stamp key with the current time
// history.snapshot()      — one-shot read of all last-used timestamps
// history.clear()         — reset the namespace

import { api, type RecentActionsState } from './api'

const MAX_ENTRIES = 200
const SAVE_DEBOUNCE_MS = 500

// Shape-validate untrusted hydration data. Drops anything that isn't
// namespace → key → number; returns null for non-objects so callers can skip
// applying entirely.
function sanitize(v: unknown): RecentActionsState | null {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null
  const out: RecentActionsState = {}
  for (const [ns, bucket] of Object.entries(v)) {
    if (!bucket || typeof bucket !== 'object' || Array.isArray(bucket)) continue
    const clean: Record<string, number> = {}
    for (const [key, ts] of Object.entries(bucket as Record<string, unknown>)) {
      if (typeof ts === 'number') clean[key] = ts
    }
    out[ns] = clean
  }
  return out
}

function createRecentActionsStore() {
  let data = $state<RecentActionsState>({})
  // Set on the first local write. Hydration resolving AFTER a write must not
  // clobber the newer local state with the (older) server snapshot.
  let dirty = false
  let saveTimer: ReturnType<typeof setTimeout> | undefined

  // Hydrate once at module load. Errors (backend unreachable, api mocked
  // without these methods in component tests) leave the store empty.
  ;(async () => {
    try {
      const remote = sanitize(await api.recentActions())
      if (remote && !dirty) data = remote
    } catch { /* best-effort */ }
  })()

  // Debounced full-map save. record() fires on every bookmark action; a save
  // per keystroke-equivalent would be needless write amplification.
  function scheduleSave() {
    clearTimeout(saveTimer)
    saveTimer = setTimeout(async () => {
      try {
        await api.saveRecentActions($state.snapshot(data))
      } catch { /* best-effort */ }
    }, SAVE_DEBOUNCE_MS)
  }

  return {
    get all(): RecentActionsState { return data },
    set all(v: RecentActionsState) {
      data = v
      dirty = true
      scheduleSave()
    },
  }
}

/** Singleton backing store. recentActions() factories and config.svelte.ts's
 *  back-compat `config.recentActions` accessor both read/write this. */
export const recentActionsStore = createRecentActionsStore()

export function recentActions(namespace: string) {
  const bucket = () => recentActionsStore.all[namespace] ?? {}

  function write(data: Record<string, number>) {
    const entries = Object.entries(data)
    if (entries.length > MAX_ENTRIES) {
      entries.sort((a, b) => b[1] - a[1])
      data = Object.fromEntries(entries.slice(0, MAX_ENTRIES))
    }
    // Whole-object replace through the setter → marks dirty + debounced save.
    recentActionsStore.all = { ...recentActionsStore.all, [namespace]: data }
  }

  return {
    record(key: string) {
      write({ ...bucket(), [key]: Date.now() })
    },

    /** One-shot read of all last-used timestamps. Prefer this over per-key
     *  reads in sort comparators — the bucket is a reactive source. */
    snapshot(): Record<string, number> {
      return bucket()
    },

    clear() {
      const { [namespace]: _, ...rest } = recentActionsStore.all
      recentActionsStore.all = rest
    },
  }
}
