import { parseJJVersion, resolvedInfo } from './api'

/** Frontend jj feature gates — names + display labels ONLY.
 *
 *  The supported/unsupported booleans come from the backend: `GET /api/info`
 *  ships a `features` map resolved through internal/jj/version.go's
 *  FeatureGates (the single authority on minimum versions, pessimistic on
 *  unknown). This file holds no version numbers and does no version
 *  comparison — it only labels the backend's booleans for the startup
 *  warning and exposes the reactive jjSupports() read.
 *
 *  Keys are a wire contract with the backend's FeatureGates map. */
export const JJ_FEATURE_LABELS = {
  indexChangedPaths: 'file-history index',
  workspaceRootTmpl: 'complete workspace paths',
} as const satisfies Record<string, string>

export type JJFeature = keyof typeof JJ_FEATURE_LABELS

/** Backend-resolved feature booleans. null = the info response hasn't been
 *  loaded yet (or the backend predates the features map) → optimistic. */
let features = $state<Record<string, boolean> | null>(null)
let detected = $state<readonly [number, number] | null>(null)

/** Set by App.svelte from api.info().jj_version once at startup. Pulls the
 *  feature map from the same (already-resolved, promise-memoized) info
 *  response via resolvedInfo(); the optional second arg lets tests inject a
 *  map directly. The parsed version is display-only (detectedJJVersion()) —
 *  it no longer gates anything. */
export function setDetectedJJVersion(raw: string, featureMap?: Record<string, boolean>): void {
  const v = parseJJVersion(raw)
  detected = v ? [v[0], v[1]] : null
  features = featureMap ?? resolvedInfo()?.features ?? null
}

/** Whether the running jj supports `feature`, per the BACKEND's resolution.
 *  Reactive (reads $state). While the feature map hasn't loaded — dev builds,
 *  the pre-loadInfo window, component tests, backends predating the map —
 *  returns TRUE: optimistic so UI affordances aren't hidden by a loading
 *  race. A wrong guess surfaces as jj's own error toast — recoverable.
 *  (The backend's own gates stay pessimistic; see Server.jjSupports.) */
export function jjSupports(feature: JJFeature): boolean {
  const f = features
  if (!f) return true
  return f[feature] ?? true // gate name unknown to this backend → optimistic
}

/** Labels of features the running jj is missing — drives the startup warning.
 *  Empty until the backend feature map is loaded (optimistic). */
export function missingJJFeatures(): string[] {
  const f = features
  if (!f) return []
  return (Object.keys(JJ_FEATURE_LABELS) as JJFeature[])
    .filter(k => f[k] === false)
    .map(k => JJ_FEATURE_LABELS[k])
}

export function detectedJJVersion(): readonly [number, number] | null {
  return detected
}
