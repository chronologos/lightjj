// Persistent user preferences, reactive via Svelte 5 runes.
import type { RemoteVisibilityByRepo } from './api'
//
// Primary storage: $XDG_CONFIG_HOME/lightjj/config.json via the backend.
// Survives port changes — spawned workspace instances on different ports
// share one config (localStorage is origin-keyed and would give each port
// a blank slate).
//
// localStorage stays as a write-through cache: instant initial paint (no
// flash of default theme while the GET is in flight) + fallback when the
// backend is unreachable.

const STORAGE_KEY = 'lightjj-config'

interface Config {
  theme: 'dark' | 'light'
  splitView: boolean
  reduceMotion: boolean
  revisionPanelWidth: number
  evologPanelHeight: number
  tutorialVersion: string
  /** Pre-split argv for "open in editor". See docs/CONFIG.md for placeholders.
   *  Empty → open-in-editor disabled. */
  editorArgs: string[]
  /** Same, but used when lightjj is in --remote mode. */
  editorArgsRemote: string[]
  /** Keyed by repo_path (from /api/info). Different tabs = different repos
   *  = independent visibility. Pre-1.0 stored this flat (keyed by remote name);
   *  old entries become orphaned keys that no repo_path will match — harmless. */
  remoteVisibility: RemoteVisibilityByRepo
}

const defaults: Config = {
  theme: 'dark',
  splitView: false,
  reduceMotion: false,
  revisionPanelWidth: 420,
  evologPanelHeight: 360,
  tutorialVersion: '',
  editorArgs: [],
  editorArgsRemote: [],
  remoteVisibility: {},
}

function loadLocal(): Partial<Config> {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}')
  } catch {
    return {}
  }
}

function saveLocal(c: Config) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(c))
  } catch { /* private mode, quota */ }
}

// Raw fetch (not api.ts) — config.svelte.ts is imported at module load time
// before api.ts's auto-refresh setup should run, and we don't want op-id
// tracking on a non-jj endpoint.
async function loadRemote(): Promise<Partial<Config> | null> {
  try {
    const res = await fetch('/api/config')
    if (res.status === 204) return null // backend can't resolve config dir
    if (!res.ok) return null
    return await res.json()
  } catch {
    return null
  }
}

async function saveRemote(c: Config): Promise<void> {
  try {
    await fetch('/api/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(c),
    })
  } catch { /* backend down — localStorage already has it */ }
}

function createConfig() {
  // Start with localStorage for instant paint; remote merges over it async.
  let state = $state<Config>({ ...defaults, ...loadLocal() })

  // Suppress the save-effect until the remote load completes. Without this,
  // the effect's initial fire writes localStorage-derived values back to
  // disk before the real disk values arrive — disk config becomes
  // unreachable. Reactive so the effect re-runs when it flips to true,
  // guaranteeing one post-hydration save even if remote values were
  // identical to localStorage (no-op on disk, confirms sync).
  let hydrated = $state(false)
  let resolveReady: () => void
  const ready = new Promise<void>(r => { resolveReady = r })

  loadRemote().then(remote => {
    if (remote) {
      // Narrow unknown-shape remote to known keys. Backend preserves unknown
      // fields for forward-compat, but we only apply fields we understand.
      for (const k of Object.keys(defaults) as (keyof Config)[]) {
        if (k in remote && remote[k] !== undefined) {
          (state as any)[k] = remote[k]
        }
      }
    }
    // Set AFTER the property writes so Svelte's microtask-batched effect
    // sees hydrated=true alongside the new values.
    hydrated = true
    resolveReady()
  })

  let saveTimer: ReturnType<typeof setTimeout> | undefined
  let pendingSnap: Config | undefined
  const flush = () => {
    if (!pendingSnap) return
    saveLocal(pendingSnap)
    saveRemote(pendingSnap)
    pendingSnap = undefined
  }
  // Flush on unload so a mid-drag close doesn't lose the last 500ms of writes.
  // saveLocal (sync localStorage) is the one that matters here — saveRemote
  // fire-and-forgets into a dying page but localStorage is durable.
  addEventListener('beforeunload', flush)
  $effect.root(() => {
    $effect(() => {
      const snap = $state.snapshot(state)
      if (!hydrated) return
      // Debounce BOTH saves. Panel-resize drags set revisionPanelWidth on
      // every mousemove (~60×/s) — 60 sync localStorage.setItem/sec is jank,
      // 60 POST/sec each doing read-merge-write-rename on disk is worse.
      pendingSnap = snap
      clearTimeout(saveTimer)
      saveTimer = setTimeout(flush, 500)
    })
  })

  return {
    get theme() { return state.theme },
    set theme(v: Config['theme']) { state.theme = v },

    get splitView() { return state.splitView },
    set splitView(v: boolean) { state.splitView = v },

    get reduceMotion() { return state.reduceMotion },
    set reduceMotion(v: boolean) { state.reduceMotion = v },

    get revisionPanelWidth() { return state.revisionPanelWidth },
    set revisionPanelWidth(v: number) { state.revisionPanelWidth = v },

    get evologPanelHeight() { return state.evologPanelHeight },
    set evologPanelHeight(v: number) { state.evologPanelHeight = v },

    get tutorialVersion() { return state.tutorialVersion },
    set tutorialVersion(v: string) { state.tutorialVersion = v },

    get editorArgs() { return state.editorArgs },
    set editorArgs(v: string[]) { state.editorArgs = v },

    get editorArgsRemote() { return state.editorArgsRemote },
    set editorArgsRemote(v: string[]) { state.editorArgsRemote = v },

    get remoteVisibility() { return state.remoteVisibility },
    set remoteVisibility(v: RemoteVisibilityByRepo) { state.remoteVisibility = v },

    /** Resolves when the remote config has been loaded and merged. Callers that
     *  need the "real" config (not just localStorage defaults) should await this
     *  before reading — e.g., the tutorial/what's-new check. */
    ready,
  }
}

export const config = createConfig()
