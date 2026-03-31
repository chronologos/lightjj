// Timestamp strings are stable (same commit_id → same timestamp), so the
// regex + Date parse result is invariant. Only the Date.now() delta changes.
const parsedMs = new Map<string, number>()

/** Format jj timestamp ("2026-03-17 22:05:32.000 -07:00") as compact relative age.
 *  Shared by RevisionGraph, FileHistoryRail, FileHistoryPanel cards. */
export function relativeTime(ts: string | undefined): string {
  if (!ts) return ''
  let t = parsedMs.get(ts)
  if (t === undefined) {
    // jj → ISO 8601: space→T, drop millis-timezone space
    const isoish = ts.replace(' ', 'T').replace(/\.(\d{3})\s+([+-])/, '.$1$2')
    t = new Date(isoish).getTime()
    if (isNaN(t)) return ''
    parsedMs.set(ts, t)
  }
  const secs = Math.floor((Date.now() - t) / 1000)
  if (secs < 60) return 'now'
  const mins = Math.floor(secs / 60)
  if (mins < 60) return `${mins}m`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs}h`
  const days = Math.floor(hrs / 24)
  if (days < 30) return `${days}d`
  const months = Math.floor(days / 30)
  if (months < 12) return `${months}mo`
  return `${Math.floor(days / 365)}y`
}

export function firstLine(s: string): string {
  const nl = s.indexOf('\n')
  return nl < 0 ? s : s.slice(0, nl)
}
