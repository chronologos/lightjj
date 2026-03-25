declare const __APP_VERSION__: string

export const APP_VERSION: string = typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : '0.0.0'

const REPO = 'chronologos/lightjj'
export const RELEASES_URL = `https://github.com/${REPO}/releases`
export const CURRENT_RELEASE_URL = `${RELEASES_URL}/tag/v${APP_VERSION}`

export interface Semver { major: number; minor: number; patch: number }

export function parseSemver(s: string): Semver | null {
  const m = s.trim().match(/^(\d+)\.(\d+)\.(\d+)/)
  return m ? { major: +m[1], minor: +m[2], patch: +m[3] } : null
}

// Returns true if a > b at major or minor level (ignores patch)
export function semverMinorGt(a: Semver, b: Semver): boolean {
  return a.major > b.major || (a.major === b.major && a.minor > b.minor)
}

export function semverGt(a: Semver, b: Semver): boolean {
  if (a.major !== b.major) return a.major > b.major
  if (a.minor !== b.minor) return a.minor > b.minor
  return a.patch > b.patch
}

export interface UpdateInfo { latest: string; url: string }

let updatePromise: Promise<UpdateInfo | null> | null = null

export function checkForUpdate(): Promise<UpdateInfo | null> {
  if (updatePromise) return updatePromise
  updatePromise = (async () => {
    try {
      const res = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
        headers: { 'Accept': 'application/vnd.github.v3+json' },
      })
      if (!res.ok) return null
      const data = await res.json()
      const tag: string = data.tag_name ?? ''
      const latest = parseSemver(tag.replace(/^v/, ''))
      const current = parseSemver(APP_VERSION)
      if (!latest || !current) return null
      if (semverGt(latest, current)) {
        return { latest: tag.replace(/^v/, ''), url: `${RELEASES_URL}/tag/${tag}` }
      }
      return null
    } catch {
      return null
    }
  })()
  return updatePromise
}
