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

  "theme": "dark",

  // Diff viewer: false = unified (one column), true = side-by-side.
  "splitView": false,

  // Disable transitions and animations.
  "reduceMotion": false,

  "fontSize": 13,

  // CSS font-family stack for UI text. Empty string = built-in default.
  "fontUI": "",

  // CSS font-family stack for code, diffs, change IDs.
  "fontMono": "",

  // Markdown preview fonts.
  "fontMdBody": "",
  "fontMdHeading": "",
  "fontMdDisplay": "",
  "fontMdCode": "",

  "revisionPanelWidth": 420,
  "evologPanelHeight": 360,

  "tutorialVersion": "",

  // Open-in-editor argv for local mode (empty = feature disabled).
  // Examples:
  //   VS Code: ["code", "--goto", "{file}:{line}"]
  //   Zed:     ["zed", "{file}:{line}"]
  //   Neovim:  ["nvim", "--server", "/tmp/nvim.sock", "--remote-silent", "+{line}", "{file}"]
  "editorArgs": [],

  // Same as editorArgs but used when lightjj is in --remote mode. Your editor
  // must accept SSH URIs (Zed, Cursor) OR you need a remote CLI helper that
  // IPCs back (VS Code Server's "code" binary).
  "editorArgsRemote": []
}
`
