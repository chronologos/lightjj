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
