export interface TutorialFeature {
  version: string
  shortcut: string | null
  title: string
  description: string
}

export const FEATURES: TutorialFeature[] = [
  { version: '0.1.0', shortcut: 'j / k', title: 'Navigate revisions', description: 'Move through the revision graph. Enter to view diff.' },
  { version: '0.1.0', shortcut: '\u2318K', title: 'Command palette', description: 'Search all available actions. Also shows keyboard shortcuts.' },
  { version: '0.1.0', shortcut: '/', title: 'Revset filter', description: 'Filter revisions with any jj revset expression.' },
  { version: '0.1.0', shortcut: 'R', title: 'Inline rebase', description: 'Start rebase, j/k to pick destination, Enter to execute. Toggle source (r/s/b) and target (o/a/i) modes.' },
  { version: '0.1.0', shortcut: 'S / s', title: 'Squash & split', description: 'Squash into another revision or split a revision by selecting files.' },
  { version: '0.1.0', shortcut: 'Space', title: 'Multi-select', description: 'Check multiple revisions for batch new/abandon.' },
  { version: '0.1.0', shortcut: 'e', title: 'Edit description', description: 'Edit commit message inline. Cmd+Enter to save.' },
  { version: '0.1.0', shortcut: null, title: 'Inline file editing', description: 'Click Edit in diff file headers to edit with CodeMirror in split view.' },
  { version: '0.1.0', shortcut: null, title: 'Right-click menus', description: 'Context menus on revisions and diff lines for quick actions.' },
  { version: '0.1.0', shortcut: 't', title: 'Toggle theme', description: 'Switch between dark and light mode.' },
  { version: '0.4.0', shortcut: null, title: 'Multi-repo tabs', description: 'Open additional repos with the + button in the tab bar. Diffs stay cached across tabs.' },
  { version: '0.5.0', shortcut: '2', title: 'Bookmarks panel', description: 'Full sync-state view: ahead/behind/diverged/conflict at a glance with commit descriptions + staleness. Enter to jump. d/f/t for delete/forget/track.' },
  { version: '0.5.0', shortcut: '[ / ]', title: 'Diff file navigation', description: 'Jump to next/prev file in the diff. Picks up from wherever you scrolled.' },
  { version: '0.5.0', shortcut: '@', title: 'Jump to working copy', description: 'Return to @ from anywhere in the log.' },
  { version: '0.6.0', shortcut: 'w', title: 'Workspaces as tabs', description: 'Workspace dropdown opens as an in-process tab \u2014 same origin, shared diff cache. No more child-process spawning.' },
  { version: '0.6.0', shortcut: null, title: 'SSH multi-repo tabs', description: 'Open additional remote repos on the same host. One SSH round trip validates + canonicalizes the path.' },
  { version: '0.7.0', shortcut: null, title: 'Unified message bar', description: 'Mutation results, warnings, and errors in one place \u2014 expandable to see full jj output. Success auto-clears; warnings persist.' },
  { version: '0.7.0', shortcut: null, title: 'Open in editor (everywhere)', description: 'Right-click \u2192 Open in editor now works in --remote mode (via editorArgsRemote + {host}/{relpath} placeholders for SSH-URI editors like Zed). See docs/CONFIG.md.' },
  { version: '0.7.0', shortcut: null, title: 'Op undo / restore', description: 'Right-click any op-log entry to undo or restore repo state to that point.' },
  { version: '0.8.0', shortcut: null, title: 'Tabs survive restart', description: 'Open tabs persist to config.json \u2014 they come back on next launch. Multi-host aware: two --remote sessions don\u2019t stomp each other.' },
  { version: '0.8.0', shortcut: null, title: 'Mutation hang protection', description: 'Non-streaming mutations now time out at 60s instead of hanging forever. If the server stalls mid-response, you\u2019ll see "may have completed \u2014 check the log".' },
  { version: '0.9.0', shortcut: 'g', title: 'Multi-remote support', description: 'Git modal now has a remote selector (\u2190/\u2192 to cycle). Track/untrack (t) opens a per-remote submenu when you have multiple remotes. Default remote reads from jj config git.push per-repo.' },
  { version: '0.9.0', shortcut: null, title: 'Fork-aware PR badges', description: 'PR badges now query upstream first (fork convention), then your default remote. Bookmarks panel correctly flags "other remote out of sync" instead of showing green.' },
  { version: '1.0.0', shortcut: null, title: '3-pane merge editor', description: 'Conflicted files open in a real merge tool: ours \u2190 result \u2192 theirs. Per-hunk arrow-click to take a side, undo restores source tag. Click Resolve on any conflict file header.' },
  { version: '1.0.0', shortcut: null, title: 'Divergence resolution', description: 'Divergent change_ids (??/N) get a guided resolver with per-stack strategy recommendations. Keep/abandon/squash with confidence labels. Bookmark repoints follow the keeper column.' },
  { version: '1.0.0', shortcut: null, title: 'Conflicted bookmark badges', description: 'Bookmarks pointing at multiple commits (jj\'s ?? decorator) now render with a red ?? marker on every occurrence in the graph.' },
  { version: '1.0.0', shortcut: null, title: 'Stale working-copy auto-detect', description: 'If a concurrent CLI op leaves the working copy stale, a warning bar appears with a one-click "Update stale" action. Also catches force-push invalidation of immutable ancestors.' },
  { version: '1.0.0', shortcut: '2', title: 'Branches side-by-side', description: 'Branches view now renders next to the revision graph \u2014 rows matching the graph cursor get an amber tint. j/k navigation across both. Per-remote visibility toggles (e) persist per-repo.' },
  { version: '1.0.0', shortcut: '?', title: 'Revset help popover', description: 'In the revset filter bar, press ? for a clickable cheatsheet of common expressions \u2014 trunk()..@, mine(), files(glob), bookmarks().' },
  { version: '1.0.0', shortcut: '3 / 4', title: 'Oplog & evolog keyboard nav', description: 'j/k and Escape now work in both panels. Enter in oplog opens the undo/restore menu at the selected entry.' },
  { version: '1.1.0', shortcut: null, title: 'SSH mode catches remote edits', description: 'Auto-refresh in --remote mode now snapshots the remote working copy \u2014 editor saves on the remote host appear in the diff within --snapshot-interval (default 5s) without running jj there.' },
  { version: '1.1.0', shortcut: null, title: 'PR badges survive git refspec quirks', description: 'Repos with refspecs jj can\'t parse (like negative globs excluding CI branches) now fall back to plain git for remote URL lookup. PR badges and the Git modal\'s remote selector both work.' },
]
