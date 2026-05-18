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

// 18px graph-row height is the hard ceiling — see theme.css and CLAUDE.md.
export const FONT_SIZE_MIN = 10
export const FONT_SIZE_MAX = 16
export const FONT_SIZE_DEFAULT = 13

interface Config {
  theme: string  // matches THEMES[].id in themes.ts; legacy 'dark'|'light' values are valid ids
  splitView: boolean
  /** Base font size in px. The --fs-* scale derives from this. Clamped to
   *  [10,16] at apply time — beyond that --fs-md overflows the fixed 18px
   *  graph row height (virtualization arithmetic assumes it). */
  fontSize: number
  /** CSS font-family stack for UI text. Empty → theme.css default. */
  fontUI: string
  /** CSS font-family stack for code/diffs. Empty → theme.css default. */
  fontMono: string
  /** Markdown prose body font (preview AND doc mode — both use .prose).
   *  Empty → system-ui. */
  fontMdBody: string
  /** Markdown prose heading font (h2..h6). Empty → falls back to fontMdBody so
   *  one-face configs (the common case) need only set the body. */
  fontMdHeading: string
  /** Markdown prose display/title font (h1 only — the big editorial title
   *  voice, e.g. a high-contrast serif over a sans body). Empty → falls back
   *  to fontMdHeading, which falls back to fontMdBody. */
  fontMdDisplay: string
  /** Markdown prose code font (inline code and ``` blocks). Empty → falls
   *  back to fontMono so the diff view and prose code blocks match unless you
   *  want them to differ (e.g. a lighter mono in long-form text). */
  fontMdCode: string
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
  /** Authors whose review comments render as hidden/stub. Cross-repo by
   *  design (hiding a bot in one repo hides it everywhere). */
  hiddenCommentAuthors: string[]
  /** Frequency counters keyed by namespace. Replaces the old localStorage-only
   *  recent-actions — `localhost:0` randomizes port so localStorage was cold
   *  every launch. Server-side survives port changes (same config file). */
  recentActions: Record<string, Record<string, number>>
}

const defaults: Config = {
  theme: 'dark',
  splitView: false,
  fontSize: 13,
  fontUI: '',
  fontMono: '',
  fontMdBody: '',
  fontMdHeading: '',
  fontMdDisplay: '',
  fontMdCode: '',
  revisionPanelWidth: 420,
  evologPanelHeight: 360,
  tutorialVersion: '',
  editorArgs: [],
  editorArgsRemote: [],
  remoteVisibility: {},
  hiddenCommentAuthors: [],
  recentActions: {},
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
//
// loadRemote returns { config, error }. 422 = file exists but has a syntax
// error — config is null (don't clobber in-memory state with defaults), error
// is the parser message so the UI can surface a warning with "Edit config".
// Other non-ok statuses + network failures return { null, null } (leave state
// alone without user-visible noise).
interface LoadResult { config: Partial<Config> | null; error: string | null }

// writeJSONError emits {"error":"..."} — unwrap for MessageBar.details so the
// user sees the bare hujson line:column message instead of JSON noise.
async function readError(res: Response): Promise<string> {
  try { return (await res.json()).error ?? `HTTP ${res.status}` }
  catch { return `HTTP ${res.status}` }
}

async function loadRemote(): Promise<LoadResult> {
  try {
    const res = await fetch('/api/config')
    if (res.status === 204) return { config: null, error: null } // backend can't resolve config dir
    if (res.status === 422) return { config: null, error: await readError(res) }
    if (!res.ok) return { config: null, error: null }
    return { config: await res.json(), error: null }
  } catch {
    return { config: null, error: null }
  }
}

// saveRemote captures 422 → lastError via the closure. Other failures are
// silent (network blip != syntax error; localStorage is the durable cache).
async function saveRemote(
  c: Config,
  onError: (msg: string | null) => void,
): Promise<void> {
  try {
    const res = await fetch('/api/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(c),
    })
    if (res.status === 422) {
      onError(await readError(res))
    } else if (res.ok) {
      onError(null)
    }
    // Other non-ok statuses: don't clobber lastError. A 500 (disk full) isn't
    // actionable in the UI the same way a syntax error is.
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

  // Set when the backend reports the on-disk config has a JSONC syntax error
  // (422). App wires this into MessageBar as a non-dismissable warning with
  // an "Edit config" action. Cleared on successful load/save.
  let lastError = $state<string | null>(null)

  // Per-key typed assignment — the `keyof Config` cast on Object.keys() is
  // correct (iterating defaults, not the untrusted remote), but TS can't track
  // that state[k] and remote[k] are compatibly typed for THIS k. The generic
  // binds the type per key.
  const applyKey = <K extends keyof Config>(k: K, v: Config[K]) => { state[k] = v }

  // Narrow unknown-shape partial to known keys. Backend preserves unknown
  // fields for forward-compat, but we only apply fields we understand.
  // Clears lastError — ConfigModal calls this after a successful raw POST,
  // which means the on-disk file just parsed; the syntax-error warning would
  // otherwise persist until the next debounced typed-endpoint save.
  // Mutating state here also triggers the debounced save-effect → a redundant
  // POST /api/config 500ms after the raw POST. Intentional: that flush is
  // what writes localStorage (cross-tab sync), and the per-key patch is
  // comment-safe so the disk write is a no-op overlay.
  function applyPartial(partial: Partial<Config>) {
    for (const k of Object.keys(defaults) as (keyof Config)[]) {
      if (k in partial && partial[k] !== undefined) {
        applyKey(k, partial[k] as Config[typeof k])
      }
    }
    lastError = null
  }

  loadRemote().then(({ config: remote, error }) => {
    if (remote) applyPartial(remote)
    lastError = error
    // Set AFTER the property writes so Svelte's microtask-batched effect
    // sees hydrated=true alongside the new values. On 422 `remote` is null
    // so in-memory state stays on localStorage — we do NOT overwrite with
    // defaults (the whole point of this correction).
    hydrated = true
    resolveReady()
  })

  let saveTimer: ReturnType<typeof setTimeout> | undefined
  let pendingSnap: Config | undefined
  let saveGen = 0
  const flush = () => {
    if (!pendingSnap) return
    saveLocal(pendingSnap)
    // Gen-guard: overlapping flushes (panel-drag burst) resolving out-of-order
    // would let a stale 422 stomp a fresh ok's null-clear, leaving the warning
    // up after the user fixed their file.
    const gen = ++saveGen
    saveRemote(pendingSnap, msg => { if (gen === saveGen) lastError = msg })
    pendingSnap = undefined
  }
  // Flush on unload so a mid-drag close doesn't lose the last 500ms of writes.
  // saveLocal (sync localStorage) is the one that matters here — saveRemote
  // fire-and-forgets into a dying page but localStorage is durable.
  addEventListener('beforeunload', flush)

  // Cross-tab sync. The `storage` event fires in OTHER tabs when localStorage
  // changes (never in the writing tab). Without this, two tabs diverge until
  // reload. `suppressSave` stops the effect from echoing the incoming write
  // back out — the other tab already persisted it, and an unconditional echo
  // would ping-pong between tabs at 500ms intervals.
  let suppressSave = false
  addEventListener('storage', (e) => {
    if (e.key !== STORAGE_KEY || !e.newValue) return
    try {
      const incoming = JSON.parse(e.newValue) as Partial<Config>
      suppressSave = true
      for (const k of Object.keys(defaults) as (keyof Config)[]) {
        if (k in incoming && incoming[k] !== undefined) {
          applyKey(k, incoming[k] as Config[typeof k])
        }
      }
    } catch { /* malformed — leave state as-is */ }
  })
  $effect.root(() => {
    $effect(() => {
      const snap = $state.snapshot(state)
      if (!hydrated) return
      if (suppressSave) {
        suppressSave = false
        // Drop any pending write too — it holds a PRE-sync snapshot. Letting
        // it flush would regress the other tab's change and trigger the echo
        // we're here to prevent. Easy to hit during panel-resize drags
        // (60 writes/s into a 500ms window).
        clearTimeout(saveTimer)
        pendingSnap = undefined
        return
      }
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

    // Getter clamps so every read site (CSS var, palette label, ±1 arithmetic)
    // sees a sane value regardless of how it was loaded — applyKey/loadLocal
    // write state directly, bypassing the setter. Number() coerces "14" and
    // rejects "14px"/{} → NaN → default.
    get fontSize() {
      const n = Number(state.fontSize)
      return Number.isFinite(n)
        ? Math.min(FONT_SIZE_MAX, Math.max(FONT_SIZE_MIN, n))
        : FONT_SIZE_DEFAULT
    },
    set fontSize(v: number) { state.fontSize = v },

    get fontUI() { return state.fontUI },
    set fontUI(v: string) { state.fontUI = v },

    get fontMono() { return state.fontMono },
    set fontMono(v: string) { state.fontMono = v },

    get fontMdBody() { return state.fontMdBody },
    set fontMdBody(v: string) { state.fontMdBody = v },

    get fontMdHeading() { return state.fontMdHeading },
    set fontMdHeading(v: string) { state.fontMdHeading = v },

    get fontMdDisplay() { return state.fontMdDisplay },
    set fontMdDisplay(v: string) { state.fontMdDisplay = v },

    get fontMdCode() { return state.fontMdCode },
    set fontMdCode(v: string) { state.fontMdCode = v },

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

    get hiddenCommentAuthors() { return state.hiddenCommentAuthors },
    set hiddenCommentAuthors(v: string[]) { state.hiddenCommentAuthors = v },

    get recentActions() { return state.recentActions },
    set recentActions(v: Record<string, Record<string, number>>) { state.recentActions = v },

    /** Resolves when the remote config has been loaded and merged. Callers that
     *  need the "real" config (not just localStorage defaults) should await this
     *  before reading — e.g., the tutorial/what's-new check. */
    ready,

    /** Push a parsed config object into reactive state (known keys only).
     *  Used by ConfigModal after a manual JSON edit so theme/font changes
     *  apply without reload. The save-effect then persists to disk + localStorage. */
    applyPartial,

    /** Non-null when the on-disk config has a JSONC syntax error (422 from
     *  /api/config). App wires this into MessageBar so the user gets a warning
     *  with "Edit config" action instead of silently reseeding. */
    get lastError() { return lastError },
  }
}

export const config = createConfig()
