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
]
