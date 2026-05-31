# Configuration

lightjj stores user config at `$XDG_CONFIG_HOME/lightjj/config.json` (or the platform equivalent via Go's `os.UserConfigDir`). The file is **JSONC** — JSON with `// line comments`, `/* block comments */`, and trailing commas. Fresh installs receive a commented template on first save; any comments you add survive future programmatic writes (theme toggle, panel resize) because the backend uses an AST-preserving patch instead of re-serialising. State that lightjj manages on its own (open tabs, recency timestamps) lives in a separate `state.json` — see [Machine state](#machine-state-statejson).

Edit it via **Cmd+K → "Edit config (JSON)"** for an in-app CodeMirror editor with live-apply on save, or edit the file directly. If the file has a syntax error, a warning appears in the message bar and your in-memory settings stay as they are — the file is not silently overwritten.

The config file lives in your local config directory regardless of mode — only jj commands are proxied over SSH, not config reads.

## Fields

| Field | Type | Default | |
|---|---|---|---|
| `theme` | `string` | `"dark"` | Theme id — one of 7 builtins (`dark`, `light`, `nord`, `gruvbox-dark`, `dracula`, `tokyo-night`, `rose-pine`) or any Ghostty theme slug |
| `splitView` | `boolean` | `false` | Diff viewer: unified vs side-by-side |
| `fontSize` | `number` | `14` | Base font size in px (clamped 10–16). All UI text scales relative to this — see [Typography](#typography) |
| `fontUI` | `string` | `""` | CSS `font-family` stack for UI text. Empty = built-in default |
| `fontMono` | `string` | `""` | CSS `font-family` stack for code, diffs, change IDs. Empty = built-in default |
| `fontMdBody` | `string` | `""` | Markdown prose body text (preview *and* doc mode — both render through `.prose`). Empty = `system-ui` |
| `fontMdHeading` | `string` | `""` | Markdown prose headings (h2–h6). Empty = falls back to `fontMdBody` |
| `fontMdDisplay` | `string` | `""` | Markdown prose title (h1) — the editorial display voice. Empty = falls back to `fontMdHeading` → `fontMdBody` |
| `fontMdCode` | `string` | `""` | Markdown inline code and fenced code blocks. Empty = falls back to `fontMono` |
| `revisionPanelWidth` | `number` | `420` | Revision panel width in px |
| `evologPanelHeight` | `number` | `360` | Evolog panel height in px |
| `tutorialVersion` | `string` | `""` | Last-seen "what's new" version; managed by the UI |
| `editorArgs` | `string[]` | `[]` | Open-in-editor command for local mode — see below |
| `editorArgsRemote` | `string[]` | `[]` | Open-in-editor command for `--remote` mode — see below |
| `remoteVisibility` | `{[repoPath]: {[remote]: {visible, hidden?}}}` | `{}` | Per-remote bookmark visibility in the revision graph, keyed by repo path so multi-repo tabs stay independent. `visible: true` adds that remote's bookmarks to the revset; `hidden: string[]` excludes specific bookmark names. |
| `hiddenCommentAuthors` | `string[]` | `[]` | Authors whose review comments render as collapsed stubs — cross-repo by design, so hiding a bot in one repo hides it everywhere. |

### Machine state (state.json)

Values lightjj writes on its own — open tabs and recency timestamps — live in a **separate file**, `state.json`, next to config.json. It is plain JSON (no comments) and is entirely managed by lightjj; you should never need to edit it.

| Field | Type | |
|---|---|---|
| `openTabs` | `[{path, mode, host?}]` | Open tabs to restore on launch. Written on tab create/close. Tab 0 (the `-R` flag) is excluded — persisting it would fight a different `-R` on next launch. |
| `recentActions` | `{[namespace]: {[key]: lastUsedMs}}` | Last-used timestamps for recency-sorting (e.g. bookmark modal). Namespaced per feature. Server-side so port changes and browser switches don't lose history. |

The split exists so that frequent machine writes (every tab open, every bookmark action) never run through the comment-preserving JSONC machinery that guards config.json — your comments cannot be collateral damage of a tab close. Older versions stored these two keys inside config.json; on first launch a one-time migration moves them to state.json and removes them from config.json (your comments and other keys are untouched).

## Typography

`fontSize` sets the CSS var `--font-size`, from which a 7-step scale (`--fs-3xs` … `--fs-xl`) is derived by fixed pixel offsets (the offsets live in `frontend/src/theme.css` — that file is the source of truth for the exact derived values). At the default `14`, the scale yields `9/10/11/12/13/15/17`. Bumping `fontSize` shifts the entire scale.

The upper clamp (`16`) exists because graph rows and diff lines have a fixed `18px` height (required for graph-pipe continuity and virtualization arithmetic). Layout heights do **not** scale with `fontSize` — only text does.

`fontUI` / `fontMono` are passed verbatim to CSS `font-family`, so include fallbacks:

```json
{
  "fontSize": 14,
  "fontUI": "'SF Pro Text', system-ui, sans-serif",
  "fontMono": "'Berkeley Mono', 'JetBrains Mono', monospace",

  "fontMdBody": "'Avenir Next', 'Helvetica Neue', sans-serif",
  "fontMdHeading": "'Avenir Next', 'Helvetica Neue', sans-serif",
  "fontMdDisplay": "'New York', 'Georgia', serif",
  "fontMdCode": "'IBM Plex Mono', 'JetBrains Mono', monospace"
}
```

Markdown prose is intentionally separate from `fontUI` — it reads better in a humanist/book face than a UI font. `.prose` is the shared typography contract between markdown preview and doc-mode (the ProseMirror WYSIWYG editor), so both honor every `fontMd*` key.

The four `fontMd*` keys form a fallback chain so a one-face config sets only `fontMdBody`:

```
fontMdDisplay  (h1, the title voice)
  ↓ falls back to
fontMdHeading  (h2–h6)
  ↓ falls back to
fontMdBody     (paragraphs, lists, tables)

fontMdCode     (inline code + fenced blocks)
  ↓ falls back to
fontMono       (the global mono — diffs, terminal-ish UI)
```

A common editorial setup is a high-contrast display serif for `fontMdDisplay` over a humanist sans for `fontMdBody`/`fontMdHeading` (the example above). For a one-face document-style preview, set only `fontMdBody`.

The font must be installed locally — lightjj does not download webfonts. From the UI: **Cmd+K → "Font size"** for increase/decrease/reset; font families are config-file only.

For larger text than 16px, use browser zoom (⌘/Ctrl +) — it scales the fixed row heights proportionally, which the in-app setting cannot.

## JSONC format

```jsonc
{
  // Comments survive programmatic writes — the backend parses the AST via
  // tailscale/hujson and only replaces the VALUES of keys it's updating.
  "theme": "dark",
  "editorArgs": ["zed", "{file}:{line}"]
}
```

Fresh installs receive a commented starter template on their first save — panel drag, theme toggle, or any programmatic write triggers the seed. If you hand-authored a plain-JSON config before upgrading, lightjj auto-migrates it to the commented template on the first 1.20 startup: your values are preserved; the template's teaching comments are added.

Comments attached to **existing** keys are preserved across writes. The backend cannot attach comments to keys it adds for the first time (e.g. `remoteVisibility` written on the first eye-toggle) — add them yourself if you want them.

**This document is the canonical field reference.** The template itself only carries short hints to get new users started; newer lightjj versions may introduce fields that aren't in the template — look them up in the table above.

**Syntax errors are not overwritten.** If your hand-edited file has a typo, the frontend shows a warning ("Config has a syntax error — open the editor to fix") with an "Edit config" action button, and the on-disk file is left alone. Fix it in the editor or directly; the warning clears on the next successful save.

**Downgrading to a pre-1.20 binary.** Older versions don't understand JSONC and treat a commented file as corrupt-then-empty: the first programmatic write (panel resize, theme toggle, tab open) silently drops every value except the one being written. The 1.20 migration writes a one-time `config.json.pre-jsonc.bak` sibling — copy it back over `config.json` before launching the older binary if you need to revert.

## Cross-tab sync

Config writes propagate to other browser tabs via the `storage` event on the localStorage write-through cache. Theme toggles, panel resizes, etc. apply everywhere without a reload.

## Open-in-editor

Right-click a diff line → **Open in editor** spawns a process via `exec.Command` on the **machine where lightjj runs**. This is a fixed invariant:

| How you run lightjj | Where the editor spawns | What config field applies | What you need |
|---|---|---|---|
| `lightjj` (local) | Your machine | `editorArgs` | Nothing extra |
| `lightjj --remote user@host:/path` | Your machine (lightjj is local) | `editorArgsRemote` | An editor that accepts SSH URIs (Zed, Cursor) |
| `ssh -L ... lightjj` (port-forward) | Remote machine | `editorArgs` | A CLI helper on the remote that IPCs back to your local editor (e.g. VS Code Server's `code` binary) |

The relevant config field being empty disables the feature — the menu item is greyed out.

### Placeholders

| Placeholder | Expands to | Example |
|---|---|---|
| `{file}` | Absolute path where the repo lives. Local mode: local filesystem path. `--remote` mode: remote filesystem path (POSIX). | `/home/user/repo/src/foo.go` |
| `{relpath}` | Repo-relative path (always `/`-separated) | `src/foo.go` |
| `{host}` | The `user@host` spec from `--remote`. Empty in local mode. | `user@devbox` |
| `{line}` | 1-based line number. `"1"` if unspecified. | `42` |

If no template element contains `{file}` or `{relpath}`, `{file}` is appended as the final argument.

### Examples

**VS Code (local or port-forward with VS Code Server):**
```json
{ "editorArgs": ["code", "--goto", "{file}:{line}"] }
```

**Zed (local):**
```json
{ "editorArgs": ["zed", "{file}:{line}"] }
```

**Zed (`--remote` mode — SSH URI opens the remote file in your local Zed):**
```json
{ "editorArgsRemote": ["zed", "zed://ssh/{host}{file}"] }
```
Line navigation via `:line` suffix is not documented for Zed's SSH URI scheme; you'll land at the top of the file.

**Neovim in a terminal (`--remote-silent` requires a running nvim server):**
```json
{ "editorArgs": ["nvim", "--server", "/tmp/nvim.sock", "--remote-silent", "+{line}", "{file}"] }
```

**Emacs server:**
```json
{ "editorArgs": ["emacsclient", "-n", "+{line}", "{file}"] }
```

### Security

The first element (`argv[0]`) must be either an absolute path or a bare command name resolvable via `$PATH`. Relative paths are rejected. Placeholders in `argv[0]` are rejected — a malicious repo cannot trick lightjj into executing a repo-controlled file.

Cross-origin POSTs to `/api/config` and `/api/open-file` are rejected, so a malicious page cannot poison your `editorArgs` and then trigger an open.
