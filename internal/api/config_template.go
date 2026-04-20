package api

// configTemplate is written on first save to a fresh install. It must be valid
// JSONC, parse-round-trip through hujson.Standardize + json.Unmarshal, and
// carry every default the frontend's `defaults` object in
// frontend/src/lib/config.svelte.ts expects. Comments are the point — they
// teach new users how to fill in editorArgs, pick a theme, customise fonts.
//
// Keys the user rarely edits (openTabs, recentActions, remoteVisibility) stay
// out. They're added later via Patch (without comments) — acceptable, since
// nobody hand-edits those anyway.
//
// Keep in sync with:
//   - frontend/src/lib/config.svelte.ts `defaults`
//   - docs/CONFIG.md `Fields` table
const configTemplate = `{
  // lightjj config — JSONC (// line comments, /* block */, trailing commas ok).
  // Full field reference: https://github.com/chronologos/lightjj/blob/main/docs/CONFIG.md
  // Fields you add later (or that newer versions introduce) are documented there.
  // Comments you add to EXISTING keys survive programmatic writes (theme toggle,
  // panel drag). New keys added by the app land without comments by design.

  // Theme id. Builtin options: "dark", "light", "nord", "gruvbox-dark",
  // "dracula", "tokyo-night", "rose-pine". Or use any Ghostty theme slug —
  // they lazy-load from ghostty-themes.json. Cmd+K → "Theme" to preview.
  "theme": "dark",

  // Diff viewer: false = unified (one column), true = side-by-side.
  "splitView": false,

  // Disable transitions and animations.
  "reduceMotion": false,

  // Base font size in px. The --fs-* scale (3xs…xl) derives from this by
  // fixed offsets. Clamped to 10–16 because graph rows are a fixed 18px and
  // virtualization arithmetic depends on that. For larger text use browser
  // zoom (⌘/Ctrl +) — it scales row heights proportionally.
  "fontSize": 13,

  // CSS font-family stack for UI text. Empty string = built-in default.
  // Include fallbacks: the font must already be installed locally (lightjj
  // does not download webfonts).
  //   "fontUI": "'SF Pro Text', system-ui, sans-serif"
  "fontUI": "",

  // CSS font-family stack for code, diffs, change IDs.
  //   "fontMono": "'Berkeley Mono', 'JetBrains Mono', monospace"
  "fontMono": "",

  // Markdown preview fonts. Keep prose readable in a book face without
  // forcing the whole UI to serif. fontMdHeading defaults to fontMdBody
  // when empty; fontMdDisplay (h1) defaults to fontMdHeading; fontMdCode
  // defaults to fontMono.
  "fontMdBody": "",
  "fontMdHeading": "",
  "fontMdDisplay": "",
  "fontMdCode": "",

  // Revision panel width in px.
  "revisionPanelWidth": 420,

  // Evolog panel height in px.
  "evologPanelHeight": 360,

  // Internal: last-seen "what's new" version. Managed by the UI.
  "tutorialVersion": "",

  // Open-in-editor argv for local mode (empty = feature disabled). Placeholders:
  //   {file}    — absolute path
  //   {relpath} — repo-relative path, / separated
  //   {line}    — 1-based line number ("1" if unspecified)
  //   {host}    — user@host from --remote (empty in local mode)
  // Examples:
  //   VS Code: ["code", "--goto", "{file}:{line}"]
  //   Zed:     ["zed", "{file}:{line}"]
  //   Neovim:  ["nvim", "--server", "/tmp/nvim.sock", "--remote-silent", "+{line}", "{file}"]
  // See docs/CONFIG.md for the full reference.
  "editorArgs": [],

  // Same as editorArgs but used when lightjj is in --remote mode. Your editor
  // must accept SSH URIs (Zed, Cursor) OR you need a remote CLI helper that
  // IPCs back (VS Code Server's "code" binary).
  //   Zed over SSH: ["zed", "zed://ssh/{host}{file}"]
  "editorArgsRemote": []
}
`
