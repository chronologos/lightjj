// Tiny path-display helpers shared by the jump-list dropdowns
// (SearchResults / ReviewJumpList). Kept separate from group-by.ts so the
// import surface stays obvious.

export function basename(p: string): string {
  // Separator-agnostic: repoRoot from a Windows backend arrives with '\'.
  const i = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'))
  return i === -1 ? p : p.slice(i + 1)
}

export function dirname(p: string): string {
  const i = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'))
  return i === -1 ? '' : p.slice(0, i + 1)
}
