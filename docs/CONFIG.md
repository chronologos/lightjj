# Configuration

lightjj stores user config at `$XDG_CONFIG_HOME/lightjj/config.json` (or the platform equivalent via Go's `os.UserConfigDir`). The file is managed by the UI's settings panel but you can edit it directly.

The config file lives in your local config directory regardless of mode — only jj commands are proxied over SSH, not config reads.

## Fields

| Field | Type | Default | |
|---|---|---|---|
| `theme` | `"dark"` \| `"light"` | `"dark"` | Catppuccin variant |
| `splitView` | `boolean` | `false` | Diff viewer: unified vs side-by-side |
| `reduceMotion` | `boolean` | `false` | Disable transitions/animations |
| `revisionPanelWidth` | `number` | `420` | Revision panel width in px |
| `evologPanelHeight` | `number` | `360` | Evolog panel height in px |
| `tutorialVersion` | `string` | `""` | Last-seen "what's new" version; managed by the UI |
| `editorArgs` | `string[]` | `[]` | Open-in-editor command for local mode — see below |
| `editorArgsRemote` | `string[]` | `[]` | Open-in-editor command for `--remote` mode — see below |
| `remoteVisibility` | `{[repoPath]: {[remote]: {visible, hidden?}}}` | `{}` | Per-remote bookmark visibility in the revision graph, keyed by repo path so multi-repo tabs stay independent. `visible: true` adds that remote's bookmarks to the revset; `hidden: string[]` excludes specific bookmark names. |
| `recentActions` | `{[namespace]: {[key]: count}}` | `{}` | Frequency counters for recency-sorting (e.g. bookmark modal). Namespaced per feature. Server-side so port changes and browser switches don't lose history. |
| `openTabs` | `[{path, mode}]` | `[]` | Open tabs to restore on launch. Managed by the UI (written on tab create/close). Tab 0 (the `-R` flag) is excluded — persisting it would fight a different `-R` on next launch. |

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
