// Persistent user preferences, reactive via Svelte 5 runes.
// Values sync to localStorage automatically on change.

const STORAGE_KEY = 'lightjj-config'

interface Config {
  theme: 'dark' | 'light'
  splitView: boolean
  reduceMotion: boolean
  revisionPanelWidth: number
}

const defaults: Config = {
  theme: 'dark',
  splitView: false,
  reduceMotion: false,
  revisionPanelWidth: 420,
}

function load(): Partial<Config> {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}')
  } catch {
    return {}
  }
}

function save(c: Config) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(c))
  } catch {
    // localStorage unavailable (private mode, quota)
  }
}

// Migrate legacy single-key storage to the unified config object
function migrate(): Partial<Config> {
  const legacy: Partial<Config> = {}
  try {
    const old = localStorage.getItem('lightjj-theme')
    if (old) {
      legacy.theme = old === 'light' ? 'light' : 'dark'
      localStorage.removeItem('lightjj-theme')
    }
  } catch { /* ignore */ }
  return legacy
}

function createConfig() {
  const stored = { ...migrate(), ...load() }
  let state = $state<Config>({ ...defaults, ...stored })

  // Persist any change
  $effect.root(() => {
    $effect(() => save($state.snapshot(state)))
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
  }
}

export const config = createConfig()
