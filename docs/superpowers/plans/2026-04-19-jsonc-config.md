# JSONC Config with Preserved Comments — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Accept JSONC (JSON with `// comments` and trailing commas) at `$XDG_CONFIG_HOME/lightjj/config.json`, preserve user comments across programmatic writes (panel drag, theme toggle, tab persistence), and seed new installs with a commented template that teaches users how to configure `editorArgs`, theme, and fonts.

**Architecture:** Backend uses `github.com/tailscale/hujson` — parses JSONC into an AST (`hujson.Value`), applies RFC 6902 `add` patches per incoming key, serializes via `Value.Pack()` preserving comments attached to unchanged members. Frontend `ConfigModal` reads/writes a new raw-text endpoint and uses `jsonc-parser` (lazy-loaded) to parse the textarea content for `applyPartial`. Existing `GET /api/config` stays typed-JSON (via `hujson.Standardize`) so `config.svelte.ts` and other consumers don't need to learn JSONC. Old plain-JSON files Just Work since JSON ⊂ JSONC; no file rename, no explicit migration step.

**Tech Stack:** Go 1.25, `github.com/tailscale/hujson` (new dep), Svelte 5, TypeScript, `jsonc-parser` (new dep, lazy), pnpm.

**Sharp edges to know before starting:**

- hujson's `Patch` can `replace` existing keys (comment on the key survives because it's attached to the `ObjectMember.Name`, not the `Value`). It **cannot** add comments to NEW keys via public API — this is why the commented template is a hand-authored string constant, not AST construction.
- Config is registered on TWO muxes: `TabManager.Mux` (`tabs.go:102`) and each `Server.Mux` (`server.go:156`). New `/api/config/raw` routes must appear on both or ConfigModal breaks in either tests or production.
- Three Go call sites read the config file: `handleConfigGet` + `mergeAndWriteConfig` (`config.go`), `ReadPersistedTabs` (`config.go:180`), `readConfigEditor` (`open.go:92`). Every `json.Unmarshal(rawBytes, ...)` must become `json.Unmarshal(hujson.Standardize(rawBytes), ...)` or comments will corrupt the parse after the first JSONC file lands on disk.
- `writePersistedTabs` does filter-merge (per-host), NOT overlay — cross-session semantics must survive the refactor (see `TestReadPersistedTabs/filter-merge preserves other sessions`).
- CodeMirror stays on `@codemirror/lang-json`. It tolerates `//` comments visually as "error" tokens; swapping to a JSONC grammar is out of scope.

---

## File Structure

**Created:**
- `internal/api/config_jsonc.go` — hujson read/patch/write helpers shared by all writers.
- `internal/api/config_template.go` — the first-run JSONC template string constant.

**Modified:**
- `go.mod`, `go.sum` — add `github.com/tailscale/hujson`.
- `internal/api/config.go` — `mergeAndWriteConfig` + `writePersistedTabs` go through hujson; `handleConfigGet` returns Standardized bytes; add `handleConfigGetRaw`, `handleConfigSetRaw`.
- `internal/api/config_test.go` — add comment-preservation tests; update existing tests where return shape changed.
- `internal/api/open.go` — `readConfigEditor` Standardizes before Unmarshal.
- `internal/api/server.go` — register `/api/config/raw` on `Server.Mux`.
- `internal/api/tabs.go` — register `/api/config/raw` on `TabManager.Mux`.
- `frontend/package.json` — add `jsonc-parser` dependency (exact pin).
- `frontend/src/lib/ConfigModal.svelte` — GET/POST `/api/config/raw`, lazy-import `jsonc-parser`.
- `frontend/src/lib/tutorial-content.ts` — "JSONC config" entry for v1.20.
- `version.txt` — bump to `1.20.0`.
- `docs/CONFIG.md` — document JSONC support.
- `CLAUDE.md` — one-line note under the `internal/api/` and Frontend sections.
- `BACKLOG.md` — delete the entry if present (or mark shipped).

---

## Task 1: Add hujson dependency and JSONC helpers

**Files:**
- Modify: `go.mod`, `go.sum`
- Create: `internal/api/config_jsonc.go`
- Create: `internal/api/config_jsonc_test.go`

- [ ] **Step 1.1: Add the dependency**

Run: `cd /Users/iantay/Documents/repos/lightjj && go get github.com/tailscale/hujson@latest && go mod tidy`
Expected: `go.mod` has a new `require github.com/tailscale/hujson v0.0.0-...` line (it uses pseudo-versions; the exact hash will be whatever is current).

- [ ] **Step 1.2: Write the failing test**

Create `internal/api/config_jsonc_test.go`:

```go
package api

import (
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestStandardizeJSONC_StripsCommentsAndTrailingCommas(t *testing.T) {
	input := []byte(`{
  // theme comment
  "theme": "gruvbox",
  "splitView": true, // trailing comma below
}`)
	out, err := standardizeJSONC(input)
	require.NoError(t, err)
	// Standardize replaces comments/commas with spaces — same byte offsets, no comments.
	assert.NotContains(t, string(out), "//")
	// Valid JSON now — json.Unmarshal must accept it.
	var m map[string]any
	require.NoError(t, unmarshalJSONC(out, &m))
	assert.Equal(t, "gruvbox", m["theme"])
	assert.Equal(t, true, m["splitView"])
}

func TestStandardizeJSONC_PlainJSONPassesThrough(t *testing.T) {
	input := []byte(`{"theme":"dark"}`)
	out, err := standardizeJSONC(input)
	require.NoError(t, err)
	var m map[string]any
	require.NoError(t, unmarshalJSONC(out, &m))
	assert.Equal(t, "dark", m["theme"])
}

func TestStandardizeJSONC_InvalidReturnsError(t *testing.T) {
	_, err := standardizeJSONC([]byte(`{not json`))
	assert.Error(t, err)
}

func TestPatchPreservesComment(t *testing.T) {
	input := []byte(`{
  // keep this comment
  "theme": "dark",
  "splitView": false
}`)
	out, err := patchConfigKeys(input, map[string][]byte{
		"theme": []byte(`"light"`),
	})
	require.NoError(t, err)
	assert.Contains(t, string(out), "// keep this comment")
	assert.Contains(t, string(out), `"theme": "light"`)
}

func TestPatchAddsMissingKey(t *testing.T) {
	input := []byte(`{"theme":"dark"}`)
	out, err := patchConfigKeys(input, map[string][]byte{
		"splitView": []byte(`true`),
	})
	require.NoError(t, err)
	// Exact formatting is hujson's call; just verify it's present + parseable.
	var m map[string]any
	require.NoError(t, unmarshalJSONC(out, &m))
	assert.Equal(t, true, m["splitView"])
	assert.Equal(t, "dark", m["theme"])
}
```

- [ ] **Step 1.3: Run the test — expect FAIL (functions don't exist)**

Run: `cd /Users/iantay/Documents/repos/lightjj && go test ./internal/api/ -run TestStandardizeJSONC -run TestPatch -v 2>&1 | head -40`
Expected: compile error — `undefined: standardizeJSONC`, `unmarshalJSONC`, `patchConfigKeys`.

- [ ] **Step 1.4: Implement the helpers**

Create `internal/api/config_jsonc.go`:

```go
package api

import (
	"encoding/json"
	"fmt"

	"github.com/tailscale/hujson"
)

// standardizeJSONC converts JSONC (with comments / trailing commas) into plain
// JSON bytes of identical length — comments and trailing commas are replaced
// with spaces, preserving byte offsets so error messages still point at the
// right column. Pure passthrough for plain JSON.
//
// Used on every read path that subsequently json.Unmarshals: handleConfigGet,
// ReadPersistedTabs, readConfigEditor. Centralising avoids drift: if someone
// adds a fourth reader and forgets to Standardize, the first user-authored
// comment in their config would panic their open-in-editor feature.
func standardizeJSONC(data []byte) ([]byte, error) {
	return hujson.Standardize(data)
}

// unmarshalJSONC is the "Standardize → json.Unmarshal" idiom one call. Callers
// that want typed decoding of a JSONC file should use this.
func unmarshalJSONC(data []byte, v any) error {
	std, err := standardizeJSONC(data)
	if err != nil {
		return err
	}
	return json.Unmarshal(std, v)
}

// patchConfigKeys applies an "add" RFC 6902 patch for each (key, rawJSONValue)
// pair, returning the Pack()'d bytes. "add" replaces on existing keys and
// inserts on missing — same behaviour as maps.Copy over a RawMessage map.
//
// Comments attached to EXISTING members survive (ObjectMember.Name carries the
// BeforeExtra; replace only swaps the Value). NEW members get no comments —
// hujson has no public API for attaching Extra to an inserted node.
//
// The patch document itself is built from RawMessage values, which the caller
// has already verified as valid JSON (or which came from json.Marshal).
func patchConfigKeys(existing []byte, keys map[string][]byte) ([]byte, error) {
	v, err := hujson.Parse(existing)
	if err != nil {
		return nil, fmt.Errorf("parse existing config: %w", err)
	}
	patch, err := buildAddPatch(keys)
	if err != nil {
		return nil, err
	}
	if err := v.Patch(patch); err != nil {
		return nil, fmt.Errorf("patch config: %w", err)
	}
	return v.Pack(), nil
}

// buildAddPatch composes a JSON Patch document. Keys go through json.Marshal
// for JSON-Pointer escaping (/ → ~1, ~ → ~0) — a config key containing "/"
// isn't a supported shape today, but doing it right costs nothing.
func buildAddPatch(keys map[string][]byte) ([]byte, error) {
	type op struct {
		Op    string          `json:"op"`
		Path  string          `json:"path"`
		Value json.RawMessage `json:"value"`
	}
	ops := make([]op, 0, len(keys))
	for k, v := range keys {
		ops = append(ops, op{Op: "add", Path: "/" + escapePointer(k), Value: v})
	}
	return json.Marshal(ops)
}

// escapePointer applies RFC 6901 escaping: ~ → ~0, / → ~1.
func escapePointer(s string) string {
	out := make([]byte, 0, len(s))
	for i := 0; i < len(s); i++ {
		switch s[i] {
		case '~':
			out = append(out, '~', '0')
		case '/':
			out = append(out, '~', '1')
		default:
			out = append(out, s[i])
		}
	}
	return string(out)
}
```

- [ ] **Step 1.5: Run the test — expect PASS**

Run: `cd /Users/iantay/Documents/repos/lightjj && go test ./internal/api/ -run 'TestStandardizeJSONC|TestPatch' -v`
Expected: all four tests PASS.

- [ ] **Step 1.6: Commit**

```bash
cd /Users/iantay/Documents/repos/lightjj && git add go.mod go.sum internal/api/config_jsonc.go internal/api/config_jsonc_test.go && git commit -m "$(cat <<'EOF'
add hujson helpers for JSONC config parsing

Wrap hujson.Standardize + json.Unmarshal + Patch-replace into three
small helpers shared by every config read and write path. Pure; no
wiring yet.

Co-Authored-By: Claude <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: First-run JSONC template with teaching comments

**Files:**
- Create: `internal/api/config_template.go`
- Create: test in `internal/api/config_jsonc_test.go`

- [ ] **Step 2.1: Write the failing test**

Append to `internal/api/config_jsonc_test.go`:

```go
func TestConfigTemplate_IsValidJSONC(t *testing.T) {
	_, err := hujson.Parse([]byte(configTemplate))
	require.NoError(t, err, "template must parse as JSONC")
}

func TestConfigTemplate_StandardizesToValidJSON(t *testing.T) {
	std, err := standardizeJSONC([]byte(configTemplate))
	require.NoError(t, err)
	var m map[string]any
	require.NoError(t, json.Unmarshal(std, &m))
	// Must carry the default values the frontend's `defaults` object expects.
	// Keep this list in sync with frontend/src/lib/config.svelte.ts#defaults.
	assert.Equal(t, "dark", m["theme"])
	assert.Equal(t, false, m["splitView"])
	assert.Equal(t, float64(13), m["fontSize"])
	assert.Equal(t, "", m["fontUI"])
	assert.Equal(t, "", m["fontMono"])
	_, hasEditorArgs := m["editorArgs"]
	assert.True(t, hasEditorArgs, "editorArgs must be in template for the teaching comment")
}

func TestConfigTemplate_ContainsTeachingComments(t *testing.T) {
	// Spot-check the comments the user will actually read. Don't over-specify
	// wording — just confirm the three "important" fields are commented.
	for _, key := range []string{"theme", "editorArgs", "fontSize"} {
		assert.Contains(t, configTemplate, `"`+key+`"`, "%s must be in template", key)
	}
	assert.Contains(t, configTemplate, "//", "template must contain at least one comment")
}
```

Add the import `"github.com/tailscale/hujson"` and `"encoding/json"` if not already present in the test file.

- [ ] **Step 2.2: Run the test — expect FAIL**

Run: `cd /Users/iantay/Documents/repos/lightjj && go test ./internal/api/ -run TestConfigTemplate -v`
Expected: `undefined: configTemplate`.

- [ ] **Step 2.3: Create the template**

Create `internal/api/config_template.go`:

```go
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
```

- [ ] **Step 2.4: Run the test — expect PASS**

Run: `cd /Users/iantay/Documents/repos/lightjj && go test ./internal/api/ -run TestConfigTemplate -v`
Expected: all three tests PASS.

- [ ] **Step 2.5: Commit**

```bash
cd /Users/iantay/Documents/repos/lightjj && git add internal/api/config_template.go internal/api/config_jsonc_test.go && git commit -m "$(cat <<'EOF'
add first-run JSONC config template with teaching comments

Hand-authored template seeds fresh installs with commented defaults for
theme, editorArgs, fontSize, and font families. Test asserts it
round-trips through hujson.Standardize + json.Unmarshal and carries
every default the frontend expects.

Co-Authored-By: Claude <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: Comment-preserving `mergeAndWriteConfig`

**Files:**
- Modify: `internal/api/config.go` (`mergeAndWriteConfig`, `writeConfigLocked`)
- Modify: `internal/api/config_test.go` (add comment-preservation tests, update existing where needed)

- [ ] **Step 3.1: Write the failing tests**

Append to `internal/api/config_test.go`:

```go
func TestHandleConfigSet_FreshInstallSeedsTemplate(t *testing.T) {
	// No file exists → first write should produce a JSONC file with the
	// teaching comments from configTemplate, then overlay user's keys.
	path := withConfigDir(t)
	runner := testutil.NewMockRunner(t)
	defer runner.Verify()
	srv := NewServer(runner, t.TempDir())

	w := httptest.NewRecorder()
	srv.Mux.ServeHTTP(w, jsonPost("/api/config", []byte(`{"theme":"gruvbox-dark"}`)))
	require.Equal(t, http.StatusOK, w.Code)

	data, err := os.ReadFile(path)
	require.NoError(t, err)
	content := string(data)
	assert.Contains(t, content, "// Theme id.",
		"fresh install should carry the template's theme comment")
	assert.Contains(t, content, "// Open-in-editor argv",
		"fresh install should carry the editorArgs comment")
	assert.Contains(t, content, `"theme": "gruvbox-dark"`,
		"user's override should be applied over template")
}

func TestHandleConfigSet_PreservesUserComments(t *testing.T) {
	// User has hand-added a comment. Next programmatic write (e.g. theme
	// toggle, panel resize) must NOT nuke it. This is the core value-prop
	// of the JSONC refactor.
	path := withConfigDir(t)
	seedConfig(t, path, `{
  // my personal note
  "theme": "dark",
  "revisionPanelWidth": 420
}`)

	runner := testutil.NewMockRunner(t)
	defer runner.Verify()
	srv := NewServer(runner, t.TempDir())

	w := httptest.NewRecorder()
	srv.Mux.ServeHTTP(w, jsonPost("/api/config", []byte(`{"theme":"light"}`)))
	require.Equal(t, http.StatusOK, w.Code)

	data, err := os.ReadFile(path)
	require.NoError(t, err)
	content := string(data)
	assert.Contains(t, content, "// my personal note")
	assert.Contains(t, content, `"theme": "light"`)
	assert.Contains(t, content, `"revisionPanelWidth": 420`)
}

func TestHandleConfigSet_AcceptsJSONCInput(t *testing.T) {
	// User has already hand-edited their file to include comments. The next
	// panel-drag POSTs a typed-JSON delta; the existing JSONC file must be
	// readable (hujson.Parse tolerates comments), not treated as corrupt.
	path := withConfigDir(t)
	seedConfig(t, path, `{
  // note
  "theme": "dark", // trailing comma ok
}`)

	runner := testutil.NewMockRunner(t)
	defer runner.Verify()
	srv := NewServer(runner, t.TempDir())

	w := httptest.NewRecorder()
	srv.Mux.ServeHTTP(w, jsonPost("/api/config", []byte(`{"splitView":true}`)))
	require.Equal(t, http.StatusOK, w.Code)

	data, err := os.ReadFile(path)
	require.NoError(t, err)
	var m map[string]any
	require.NoError(t, unmarshalJSONC(data, &m))
	assert.Equal(t, "dark", m["theme"])
	assert.Equal(t, true, m["splitView"])
}
```

Also update `TestHandleConfigSet_AtomicWrite` — the "corrupt existing file" case: hujson.Parse will reject `{not valid json` but the fresh-install path should still take over and write the template + user's theme. Change the assertion from "overwrites corrupt" to "rejects with 500 OR falls back to template" — pick fallback:

Modify `TestHandleConfigSet_AtomicWrite` (replace from line 125 onward):

```go
func TestHandleConfigSet_AtomicWrite(t *testing.T) {
	// Corrupt existing file → treat as fresh install (template + user's key).
	// Don't 500: the user has no way to recover besides deleting the file,
	// and they may not realise that. A clean seed overwrite is more forgiving.
	path := withConfigDir(t)
	seedConfig(t, path, `{not valid json`)

	runner := testutil.NewMockRunner(t)
	defer runner.Verify()
	srv := NewServer(runner, t.TempDir())

	w := httptest.NewRecorder()
	srv.Mux.ServeHTTP(w, jsonPost("/api/config", []byte(`{"theme":"light"}`)))
	require.Equal(t, http.StatusOK, w.Code)

	data, err := os.ReadFile(path)
	require.NoError(t, err)
	var got map[string]any
	require.NoError(t, unmarshalJSONC(data, &got))
	assert.Equal(t, "light", got["theme"])

	// No temp files left behind.
	entries, err := os.ReadDir(filepath.Dir(path))
	require.NoError(t, err)
	assert.Len(t, entries, 1)
}
```

- [ ] **Step 3.2: Run tests — expect FAIL**

Run: `cd /Users/iantay/Documents/repos/lightjj && go test ./internal/api/ -run TestHandleConfigSet -v 2>&1 | tail -50`
Expected: new tests FAIL (template comments missing — the current `json.MarshalIndent` destroys them); existing tests still PASS.

- [ ] **Step 3.3: Refactor `mergeAndWriteConfig`**

Replace the body of `mergeAndWriteConfig` and `writeConfigLocked` in `internal/api/config.go`. Keep the function signatures as-is so callers don't change.

Replace lines 119-164 of `internal/api/config.go` (from `// mergeAndWriteConfig` through the end of `writeConfigLocked`) with:

```go
// mergeAndWriteConfig reads the existing config (best-effort, JSONC-aware),
// applies each incoming key as an RFC 6902 `add` patch (replaces if present,
// inserts if missing), and atomic-writes back. Holds configMu for the whole
// cycle. Comments attached to EXISTING members survive; added-by-patch members
// get no comments (acceptable — they're typically openTabs/recentActions).
//
// If the file doesn't exist or is unparseable, the JSONC `configTemplate` is
// used as the starting state so fresh installs get teaching comments on their
// first save. Unparseable = corrupt; treating it as fresh is more forgiving
// than 500 (user may not realise their config is broken).
//
// Used by handleConfigSet; writePersistedTabs needs filter-merge so it builds
// its own patch and calls writeConfigBytesLocked directly.
func mergeAndWriteConfig(path string, incoming map[string]json.RawMessage) error {
	configMu.Lock()
	defer configMu.Unlock()

	existing := readOrTemplate(path)
	keys := make(map[string][]byte, len(incoming))
	for k, v := range incoming {
		keys[k] = []byte(v)
	}
	out, err := patchConfigKeys(existing, keys)
	if err != nil {
		return err
	}
	return writeConfigBytesLocked(path, out)
}

// readOrTemplate returns the on-disk bytes if the file exists and parses as
// JSONC, otherwise the template. Keeps corruption + missing-file on the same
// recovery path.
func readOrTemplate(path string) []byte {
	data, err := os.ReadFile(path)
	if err != nil {
		return []byte(configTemplate)
	}
	if _, parseErr := hujson.Parse(data); parseErr != nil {
		return []byte(configTemplate)
	}
	return data
}

// writeConfigBytesLocked atomic-writes raw bytes. Caller must hold configMu.
// The bytes are written verbatim (no re-Marshal) — callers compose them
// through patchConfigKeys, which preserves comments.
func writeConfigBytesLocked(path string, data []byte) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	tmp, err := os.CreateTemp(filepath.Dir(path), ".config-*.json")
	if err != nil {
		return err
	}
	tmpPath := tmp.Name()
	defer os.Remove(tmpPath)
	if _, err := tmp.Write(data); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	return os.Rename(tmpPath, path)
}
```

Add `"github.com/tailscale/hujson"` to the import block. Remove the now-unused `"maps"` import if nothing else uses it.

- [ ] **Step 3.4: Update `handleConfigGet` to standardize on the way out**

Replace `handleConfigGet` body so it returns comment-stripped bytes to typed-JSON consumers:

```go
func handleConfigGet(w http.ResponseWriter, r *http.Request) {
	path, err := configPath()
	if err != nil {
		writeJSONError(w, http.StatusInternalServerError, "cannot resolve config dir")
		return
	}
	data, err := os.ReadFile(path)
	if err != nil {
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("Cache-Control", "no-store")
		w.Write([]byte("{}"))
		return
	}
	// Comments/trailing-commas would break the browser's JSON.parse — strip
	// them. Standardize preserves byte offsets; the payload is the same size.
	std, err := standardizeJSONC(data)
	if err != nil {
		// Corrupt file — return {} rather than 500. Same forgiveness as the
		// write path (see mergeAndWriteConfig).
		std = []byte("{}")
	}
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.Write(std)
}
```

- [ ] **Step 3.5: Update `writePersistedTabs` to use the new byte-path**

In `writePersistedTabs` (still in `config.go`), replace the body from "Read existing config (RawMessage)" through the end with the hujson variant. The function retains its existing filter-merge semantics — don't change what it DOES, just how it writes.

Replace `writePersistedTabs`:

```go
func writePersistedTabs(mode, host string, tabs []PersistedTab) error {
	path, err := configPath()
	if err != nil {
		return err
	}
	configMu.Lock()
	defer configMu.Unlock()

	existing := readOrTemplate(path)

	// Decode existing openTabs into typed form, filter out this session's
	// entries, append fresh. Same filter-merge as before; see docstring.
	var currentOpenTabs []PersistedTab
	if err := unmarshalJSONC(existing, &struct {
		OpenTabs *[]PersistedTab `json:"openTabs"`
	}{OpenTabs: &currentOpenTabs}); err != nil {
		// Config exists but openTabs field absent or wrong-typed — treat as empty.
		currentOpenTabs = nil
	}
	kept := currentOpenTabs[:0]
	for _, pt := range currentOpenTabs {
		if pt.Mode == mode && pt.Host == host {
			continue
		}
		kept = append(kept, pt)
	}
	kept = append(kept, tabs...)

	raw, err := json.Marshal(kept)
	if err != nil {
		return err
	}
	out, err := patchConfigKeys(existing, map[string][]byte{"openTabs": raw})
	if err != nil {
		return err
	}
	return writeConfigBytesLocked(path, out)
}
```

- [ ] **Step 3.6: Run tests — expect PASS**

Run: `cd /Users/iantay/Documents/repos/lightjj && go test ./internal/api/ -run 'TestHandleConfig|TestReadPersistedTabs' -v 2>&1 | tail -80`
Expected: all tests PASS. If `TestHandleConfigSet_MergePreservesUnknownKeys` fails because the existing test expects `futureKey` to round-trip through `maps.Copy`, verify: `add /futureKey` is not sent (it's not in the incoming body), so the existing key stays untouched → test should still pass. If it doesn't, read the failure and debug.

- [ ] **Step 3.7: Commit**

```bash
cd /Users/iantay/Documents/repos/lightjj && git add internal/api/config.go internal/api/config_test.go && git commit -m "$(cat <<'EOF'
preserve user comments across programmatic config writes

Replace map[string]RawMessage + MarshalIndent with hujson Patch.
Existing-key comments survive (ObjectMember.Name keeps BeforeExtra);
missing file or corrupt JSONC falls back to the template seed so fresh
installs get teaching comments on first save.

writePersistedTabs retains its filter-merge semantics; only the I/O
layer changes.

Co-Authored-By: Claude <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: Standardize the other config reader (`readConfigEditor`)

**Files:**
- Modify: `internal/api/open.go:92-104`
- Modify: `internal/api/open_test.go` (find it and add JSONC test)

- [ ] **Step 4.1: Find and read the existing open_test.go**

Run: `cd /Users/iantay/Documents/repos/lightjj && ls internal/api/open*_test.go`

Read whichever test file exists to find an existing pattern for seeding a config file and hitting the editor path.

- [ ] **Step 4.2: Write failing test**

Add to the open test file (path-agnostic; look for `TestReadConfigEditor` or a closely-related test to pattern-match naming):

```go
func TestReadConfigEditor_AcceptsJSONCWithComments(t *testing.T) {
	path := withConfigDir(t)
	seedConfig(t, path, `{
  // teaching comment
  "editorArgs": ["zed", "{file}:{line}"],
  "theme": "dark", // trailing comma
}`)
	cfg, err := readConfigEditor()
	require.NoError(t, err)
	assert.Equal(t, []string{"zed", "{file}:{line}"}, cfg.EditorArgs)
}
```

- [ ] **Step 4.3: Run — expect FAIL**

Run: `cd /Users/iantay/Documents/repos/lightjj && go test ./internal/api/ -run TestReadConfigEditor_AcceptsJSONC -v`
Expected: FAIL — `json.Unmarshal` rejects `//` tokens.

- [ ] **Step 4.4: Swap `json.Unmarshal` for `unmarshalJSONC` in `readConfigEditor`**

In `internal/api/open.go` line 102, change:

```go
	_ = json.Unmarshal(data, &cfg) // corrupt → zero state (same as handleConfigSet)
```

to:

```go
	_ = unmarshalJSONC(data, &cfg) // corrupt → zero state (same as handleConfigSet)
```

- [ ] **Step 4.5: Run — expect PASS**

Run: `cd /Users/iantay/Documents/repos/lightjj && go test ./internal/api/ -run TestReadConfigEditor -v`
Expected: PASS. Verify nothing else broke: `go test ./... -count=1 2>&1 | tail -10`.

- [ ] **Step 4.6: Also patch `ReadPersistedTabs` (`config.go:197`)**

In `ReadPersistedTabs`, change `json.Unmarshal(data, &cfg)` to `unmarshalJSONC(data, &cfg)`. Existing `TestReadPersistedTabs` tests must still pass; add one more:

```go
	t.Run("accepts JSONC with comments", func(t *testing.T) {
		path := withConfigDir(t)
		seedConfig(t, path, `{
  // user note
  "openTabs": [{"path":"/x","mode":"local"}]
}`)
		got := ReadPersistedTabs()
		require.Len(t, got, 1)
		assert.Equal(t, "/x", got[0].Path)
	})
```

Run: `cd /Users/iantay/Documents/repos/lightjj && go test ./internal/api/ -run TestReadPersistedTabs -v`
Expected: PASS.

- [ ] **Step 4.7: Commit**

```bash
cd /Users/iantay/Documents/repos/lightjj && git add internal/api/open.go internal/api/config.go internal/api/open_test.go internal/api/config_test.go && git commit -m "$(cat <<'EOF'
standardize other config read paths for JSONC tolerance

ReadPersistedTabs and readConfigEditor both called json.Unmarshal on
raw bytes — would trip on the first // comment. Switch to
unmarshalJSONC (Standardize then Unmarshal) so open-in-editor and
tab-restore survive a hand-edited config.

Co-Authored-By: Claude <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: Raw endpoint for `ConfigModal`

**Files:**
- Modify: `internal/api/config.go` (add `handleConfigGetRaw`, `handleConfigSetRaw`)
- Modify: `internal/api/tabs.go` (register new routes)
- Modify: `internal/api/server.go` (register new routes)
- Modify: `internal/api/config_test.go`

- [ ] **Step 5.1: Write failing tests**

Append to `config_test.go`:

```go
func TestHandleConfigGetRaw_ReturnsRawJSONC(t *testing.T) {
	path := withConfigDir(t)
	seedConfig(t, path, `{
  // a comment
  "theme": "dark"
}`)
	runner := testutil.NewMockRunner(t)
	defer runner.Verify()
	srv := NewServer(runner, t.TempDir())

	w := httptest.NewRecorder()
	srv.Mux.ServeHTTP(w, httptest.NewRequest("GET", "/api/config/raw", nil))
	assert.Equal(t, http.StatusOK, w.Code)
	assert.Contains(t, w.Header().Get("Content-Type"), "text/plain")
	assert.Contains(t, w.Body.String(), "// a comment")
}

func TestHandleConfigGetRaw_MissingFileReturnsTemplate(t *testing.T) {
	withConfigDir(t)
	runner := testutil.NewMockRunner(t)
	defer runner.Verify()
	srv := NewServer(runner, t.TempDir())

	w := httptest.NewRecorder()
	srv.Mux.ServeHTTP(w, httptest.NewRequest("GET", "/api/config/raw", nil))
	assert.Equal(t, http.StatusOK, w.Code)
	assert.Contains(t, w.Body.String(), "// Theme id.",
		"missing file should serve the template so the modal shows commented defaults")
}

func TestHandleConfigSetRaw_RoundTripPreservesComments(t *testing.T) {
	path := withConfigDir(t)
	runner := testutil.NewMockRunner(t)
	defer runner.Verify()
	srv := NewServer(runner, t.TempDir())

	body := `{
  // my comment
  "theme": "light"
}`
	req := httptest.NewRequest("POST", "/api/config/raw", bytes.NewReader([]byte(body)))
	req.Header.Set("Content-Type", "text/plain")
	w := httptest.NewRecorder()
	srv.Mux.ServeHTTP(w, req)
	require.Equal(t, http.StatusOK, w.Code)

	data, err := os.ReadFile(path)
	require.NoError(t, err)
	assert.Equal(t, body, string(data), "raw POST should write bytes verbatim")
}

func TestHandleConfigSetRaw_RejectsInvalidJSONC(t *testing.T) {
	withConfigDir(t)
	runner := testutil.NewMockRunner(t)
	defer runner.Verify()
	srv := NewServer(runner, t.TempDir())

	req := httptest.NewRequest("POST", "/api/config/raw", bytes.NewReader([]byte(`{not json`)))
	req.Header.Set("Content-Type", "text/plain")
	w := httptest.NewRecorder()
	srv.Mux.ServeHTTP(w, req)
	assert.Equal(t, http.StatusBadRequest, w.Code)
}

func TestHandleConfigSetRaw_CrossOriginRejected(t *testing.T) {
	withConfigDir(t)
	runner := testutil.NewMockRunner(t)
	defer runner.Verify()
	srv := NewServer(runner, t.TempDir())

	req := httptest.NewRequest("POST", "/api/config/raw",
		bytes.NewReader([]byte(`{"theme":"dark"}`)))
	req.Header.Set("Origin", "https://evil.example.com")
	req.Header.Set("Content-Type", "text/plain")
	w := httptest.NewRecorder()
	srv.Mux.ServeHTTP(w, req)
	assert.Equal(t, http.StatusForbidden, w.Code)
}
```

You need `"bytes"` in the imports if not already there.

- [ ] **Step 5.2: Run — expect FAIL**

Run: `cd /Users/iantay/Documents/repos/lightjj && go test ./internal/api/ -run TestHandleConfigGetRaw -run TestHandleConfigSetRaw -v`
Expected: 404 — routes not registered yet.

- [ ] **Step 5.3: Implement handlers**

Append to `internal/api/config.go`:

```go
// handleConfigGetRaw returns the config file bytes verbatim as text/plain.
// Used by ConfigModal so the user sees (and can edit) their actual JSONC
// including comments. Missing file serves the template so new users get a
// commented starter in the editor rather than `{}`.
func handleConfigGetRaw(w http.ResponseWriter, r *http.Request) {
	path, err := configPath()
	if err != nil {
		writeJSONError(w, http.StatusInternalServerError, "cannot resolve config dir")
		return
	}
	data, err := os.ReadFile(path)
	if err != nil {
		data = []byte(configTemplate)
	}
	w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.Write(data)
}

// handleConfigSetRaw accepts a JSONC document as text/plain and atomic-writes
// it verbatim after validating via hujson.Parse. Unlike POST /api/config (which
// merges per-key), this one REPLACES the whole file — ConfigModal shows the
// user the whole content, so the whole content is what they're intending to
// save. Cross-origin guard is identical to handleConfigSet: a malicious page
// POSTing editorArgs through here has the same reach as through the typed
// endpoint.
func handleConfigSetRaw(w http.ResponseWriter, r *http.Request) {
	if origin := r.Header.Get("Origin"); origin != "" && !isLocalOrigin(origin) {
		writeJSONError(w, http.StatusForbidden, "cross-origin config write rejected")
		return
	}
	path, err := configPath()
	if err != nil {
		writeJSONError(w, http.StatusInternalServerError, "cannot resolve config dir")
		return
	}
	body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, 1<<20)) // 1MB cap
	if err != nil {
		writeJSONError(w, http.StatusBadRequest, err.Error())
		return
	}
	if _, err := hujson.Parse(body); err != nil {
		writeJSONError(w, http.StatusBadRequest, "invalid JSONC: "+err.Error())
		return
	}
	configMu.Lock()
	defer configMu.Unlock()
	if err := writeConfigBytesLocked(path, body); err != nil {
		writeJSONError(w, http.StatusInternalServerError, err.Error())
		return
	}
	w.WriteHeader(http.StatusOK)
}
```

Add `"io"` to the imports if missing.

- [ ] **Step 5.4: Register routes on both muxes**

In `internal/api/tabs.go` after the existing `/api/config` registrations (lines 102-103), add:

```go
	m.Mux.HandleFunc("GET /api/config/raw", handleConfigGetRaw)
	m.Mux.HandleFunc("POST /api/config/raw", handleConfigSetRaw)
```

In `internal/api/server.go` after the existing `/api/config` registrations (lines 156-157), add:

```go
	s.Mux.HandleFunc("GET /api/config/raw", handleConfigGetRaw)
	s.Mux.HandleFunc("POST /api/config/raw", handleConfigSetRaw)
```

- [ ] **Step 5.5: Run tests — expect PASS**

Run: `cd /Users/iantay/Documents/repos/lightjj && go test ./internal/api/ -v 2>&1 | tail -30`
Expected: all PASS, including new raw tests and all existing tests.

- [ ] **Step 5.6: Also verify TabManager mux handles the raw routes (mirror the existing tabs_test.go:368-372 pattern)**

Add to `internal/api/tabs_test.go` alongside the existing `/api/config` test:

```go
	// ConfigModal fetches /api/config/raw without a tab prefix — must route.
	w = httptest.NewRecorder()
	tm.Mux.ServeHTTP(w, httptest.NewRequest("GET", "/api/config/raw", nil))
	assert.Equal(t, http.StatusOK, w.Code)
	assert.Contains(t, w.Header().Get("Content-Type"), "text/plain")
```

Run: `cd /Users/iantay/Documents/repos/lightjj && go test ./internal/api/ -run TestTabManager -v 2>&1 | tail -20`
Expected: PASS.

- [ ] **Step 5.7: Commit**

```bash
cd /Users/iantay/Documents/repos/lightjj && git add internal/api/config.go internal/api/server.go internal/api/tabs.go internal/api/config_test.go internal/api/tabs_test.go && git commit -m "$(cat <<'EOF'
add /api/config/raw for JSONC editor round-trip

GET returns the file bytes verbatim (falling back to configTemplate on
missing file) so ConfigModal shows comments; POST validates via
hujson.Parse and atomic-writes the bytes as-is. Registered on both
TabManager.Mux and Server.Mux like the typed /api/config routes.

Co-Authored-By: Claude <noreply@anthropic.com>
EOF
)"
```

---

## Task 6: Frontend — ConfigModal uses raw endpoint

**Files:**
- Modify: `frontend/package.json` — add `jsonc-parser` dependency
- Modify: `frontend/src/lib/ConfigModal.svelte`

- [ ] **Step 6.1: Add jsonc-parser with pinned version**

Run: `cd /Users/iantay/Documents/repos/lightjj/frontend && pnpm add jsonc-parser@3.3.1 --save-exact`
Expected: `package.json` gains `"jsonc-parser": "3.3.1"` under `dependencies` (no caret — project rule is exact pins). Confirm: `grep jsonc-parser package.json`.

If the add triggers an install-script warning, verify `pnpm.onlyBuiltDependencies` still only allowlists `esbuild` — jsonc-parser is pure JS with no install scripts and should pass silently.

- [ ] **Step 6.2: Write failing frontend test**

Create `frontend/src/lib/ConfigModal.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { parse as parseJsonc } from 'jsonc-parser'

describe('jsonc-parser integration', () => {
  it('parses JSONC with comments and trailing commas', () => {
    const text = `{
      // my comment
      "theme": "dark",
      "splitView": true, // trailing
    }`
    const obj = parseJsonc(text)
    expect(obj.theme).toBe('dark')
    expect(obj.splitView).toBe(true)
  })

  it('returns undefined keys for malformed input rather than throwing', () => {
    // jsonc-parser's default parse swallows errors — callers check errors via parseWithOptions
    const obj = parseJsonc('{not json')
    expect(obj).toBeUndefined()
  })
})
```

- [ ] **Step 6.3: Run — expect PASS (new, module-level)**

Run: `cd /Users/iantay/Documents/repos/lightjj/frontend && pnpm run test -- ConfigModal 2>&1 | tail -20`
Expected: PASS. (This is a sanity check that the dep is installed and the API shape matches.)

- [ ] **Step 6.4: Rewrite ConfigModal to use the raw endpoint**

Replace the `<script lang="ts">` block of `frontend/src/lib/ConfigModal.svelte` (lines 1-59) with:

```svelte
<script lang="ts">
  import { config } from './config.svelte'
  import type FileEditor from './FileEditor.svelte'

  interface Props {
    open: boolean
    onclose: () => void
    onerror: (e: unknown) => void
  }

  let { open, onclose, onerror }: Props = $props()

  let content: string = $state('')
  let parseError: string = $state('')
  let loading: boolean = $state(true)
  let editorRef: ReturnType<typeof FileEditor> | undefined = $state(undefined)

  // Raw fetch — same rationale as config.svelte.ts (non-jj endpoint, no op-id).
  // /api/config/raw returns the on-disk bytes verbatim (or the template on
  // missing file), so the user sees comments they wrote and the commented
  // defaults on first open. No re-stringify.
  $effect(() => {
    if (!open) return
    loading = true
    parseError = ''
    fetch('/api/config/raw')
      .then(r => r.ok ? r.text() : Promise.reject(new Error(`HTTP ${r.status}`)))
      .then(text => { content = text })
      .catch(e => onerror(e))
      .finally(() => { loading = false })
  })

  async function save(text: string) {
    // Lazy-load jsonc-parser only when the user actually saves. Keeps main
    // bundle free of the ~30KB dep.
    const { parse: parseJsonc, printParseErrorCode } = await import('jsonc-parser')
    const errors: Array<{ error: number; offset: number }> = []
    const parsed = parseJsonc(text, errors, { allowTrailingComma: true }) as unknown
    if (errors.length > 0) {
      const e = errors[0]
      parseError = `${printParseErrorCode(e.error)} at offset ${e.offset}`
      return
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      parseError = 'config must be a JSONC object'
      return
    }
    parseError = ''
    try {
      const res = await fetch('/api/config/raw', {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain' },
        body: text,
      })
      if (!res.ok) throw new Error(await res.text() || `HTTP ${res.status}`)
      // Apply known keys to reactive state so theme/fontSize/etc take effect
      // immediately. The config save-effect then echoes to localStorage. Unknown
      // keys in `parsed` are ignored by applyPartial.
      config.applyPartial(parsed as Record<string, unknown>)
      onclose()
    } catch (e) {
      onerror(e)
    }
  }
</script>
```

Also update the modal header path label (line 65 of the original file) so the filename shown matches reality:

```svelte
      <span>Config <span class="path">~/.config/lightjj/config.json</span></span>
```

stays as-is (file is still `config.json`); no change needed. But update the `filePath` prop on the FileEditor so CodeMirror still picks JSON highlighting. The existing `filePath="config.json"` is fine — leave it.

The docs link still points to `CONFIG.md`. Leave it.

- [ ] **Step 6.5: Build frontend and check bundle**

Run: `cd /Users/iantay/Documents/repos/lightjj/frontend && pnpm run build 2>&1 | tail -20`
Expected: build succeeds. Main bundle size should be roughly unchanged (jsonc-parser is dynamically imported — look for a new `jsonc-parser-*.js` chunk in the output).

- [ ] **Step 6.6: Run frontend tests**

Run: `cd /Users/iantay/Documents/repos/lightjj/frontend && pnpm run test 2>&1 | tail -15`
Expected: all pass.

- [ ] **Step 6.7: Commit**

```bash
cd /Users/iantay/Documents/repos/lightjj && git add frontend/package.json frontend/pnpm-lock.yaml frontend/src/lib/ConfigModal.svelte frontend/src/lib/ConfigModal.test.ts && git commit -m "$(cat <<'EOF'
ConfigModal reads/writes raw JSONC via /api/config/raw

Fetching /api/config stripped comments (backend Standardizes for typed
consumers). ConfigModal now hits /api/config/raw so the user sees
their actual file content — including any // comments they've added
and the teaching comments the backend seeds on fresh installs. Save
validates via jsonc-parser (lazy-loaded) and applies known keys to
reactive state.

Co-Authored-By: Claude <noreply@anthropic.com>
EOF
)"
```

---

## Task 7: Documentation, tutorial entry, version bump

**Files:**
- Modify: `version.txt`
- Modify: `docs/CONFIG.md`
- Modify: `frontend/src/lib/tutorial-content.ts`
- Modify: `CLAUDE.md`

- [ ] **Step 7.1: Bump version**

Replace contents of `/Users/iantay/Documents/repos/lightjj/version.txt` with `1.20.0` (no trailing newline change beyond what's there).

- [ ] **Step 7.2: Update docs/CONFIG.md**

Open `docs/CONFIG.md` and make two edits:

**Edit 1** — replace line 1-6 (the header paragraph) with:

```markdown
# Configuration

lightjj stores user config at `$XDG_CONFIG_HOME/lightjj/config.json` (or the platform equivalent via Go's `os.UserConfigDir`). The file is **JSONC** — JSON with `// line comments`, `/* block comments */`, and trailing commas. Fresh installs receive a commented template on first save; any comments you add survive future programmatic writes (theme toggle, panel resize, tab persistence) because the backend uses an AST-preserving patch instead of re-serialising.

Edit it via **Cmd+K → "Edit config (JSON)"** for an in-app CodeMirror editor with live-apply on save, or edit the file directly.

The config file lives in your local config directory regardless of mode — only jj commands are proxied over SSH, not config reads.
```

**Edit 2** — add a new section above "Cross-tab sync":

```markdown
## JSONC format

```jsonc
{
  // Comments survive programmatic writes — the backend parses the AST via
  // tailscale/hujson and only replaces the VALUES of keys it's updating.
  "theme": "dark",
  "editorArgs": ["zed", "{file}:{line}"]
}
```

New installs get a commented starter template the first time lightjj writes to the config (e.g. the first panel drag or theme toggle). If you hand-authored a config before upgrading, it stays plain JSON until you add comments yourself — no migration is performed.

Comments attached to **existing** keys are preserved. The backend cannot attach comments to keys it adds for the first time (e.g. `openTabs` written on first tab-open) — add them yourself if you want them.

```

- [ ] **Step 7.3: Add tutorial entry**

Read `frontend/src/lib/tutorial-content.ts` and follow the existing pattern to add a `1.20.0` entry. The existing entries are the authoritative format — mirror them. Content:

- Title: **"JSONC config with comments"**
- Body (adjust wording to match tone of existing entries): explain that `~/.config/lightjj/config.json` is now JSONC, new installs get a commented template on first save, and any comments you add to existing fields survive programmatic writes.
- Anchor for "Edit config" — link to Cmd+K.

- [ ] **Step 7.4: Update CLAUDE.md**

In the Go section, find the line about `config.go` in the Project Structure block (search for `config.go`) and update its description to mention JSONC. Also in the "Dependencies" Go paragraph, add hujson:

In the `Dependencies` `Go` line (currently "2 direct (`fsnotify`...)"), change the count and mention hujson:

```
**Go**: 3 direct (`fsnotify` for cross-platform fs watch, `tailscale/hujson` for comment-preserving JSONC config edits, `testify` test-only).
```

In the Frontend dependencies paragraph, append `jsonc-parser` (with a `lazy-loaded` note) to the existing list.

In the `internal/api/` section of the file tree, find the `config.go` line and replace it with:

```
    config.go              — Server-side JSONC config (tailscale/hujson); mergeAndWriteConfig applies per-key RFC-6902 add patches so comments on existing keys survive; fresh installs seed from configTemplate. writePersistedTabs filter-merges openTabs through the same patch path. GET /api/config returns Standardized JSON; GET/POST /api/config/raw round-trips raw JSONC for ConfigModal.
    config_jsonc.go        — hujson helpers: standardizeJSONC, unmarshalJSONC, patchConfigKeys. The centralised "Standardize before Unmarshal" idiom — any new json.Unmarshal on config bytes must go through unmarshalJSONC or break the first time the user adds a comment.
    config_template.go     — First-run JSONC template string (in-tree constant, not a file). Teaching comments over theme, fontSize, editorArgs, font families. Kept in sync with frontend defaults and docs/CONFIG.md by convention — see the top-of-file comment.
```

- [ ] **Step 7.5: Commit docs and version**

```bash
cd /Users/iantay/Documents/repos/lightjj && git add version.txt docs/CONFIG.md frontend/src/lib/tutorial-content.ts CLAUDE.md && git commit -m "$(cat <<'EOF'
docs: JSONC config with preserved comments (v1.20.0)

Explain JSONC support in docs/CONFIG.md, add a tutorial entry so
existing users see a "what's new" modal on upgrade, and update CLAUDE.md
with the new helper files and the hujson/jsonc-parser deps.

Co-Authored-By: Claude <noreply@anthropic.com>
EOF
)"
```

---

## Task 8: Final verification

- [ ] **Step 8.1: Full Go test suite**

Run: `cd /Users/iantay/Documents/repos/lightjj && go test ./... -count=1 2>&1 | tail -20`
Expected: all tests pass.

- [ ] **Step 8.2: Static analysis**

Run: `cd /Users/iantay/Documents/repos/lightjj && go vet ./...`
Expected: no output (all clean).

- [ ] **Step 8.3: Frontend build + test + typecheck**

Run: `cd /Users/iantay/Documents/repos/lightjj/frontend && pnpm run build && pnpm run test && pnpm run check 2>&1 | tail -30`
Expected: build clean, all tests pass, svelte-check reports 0 errors.

- [ ] **Step 8.4: Confirm no bundle bloat**

Run: `cd /Users/iantay/Documents/repos/lightjj/frontend && ls -la ../cmd/lightjj/frontend-dist/assets/ | grep -E 'index-.*\.js$|jsonc'`
Expected: there's a new `jsonc-parser-<hash>.js` chunk (~30KB gzipped ≈ 80-90KB raw); the main `index-*.js` hash may have changed but shouldn't be meaningfully larger.

- [ ] **Step 8.5: Manual smoke test**

Start a dev server and verify:

Terminal 1: `cd /Users/iantay/Documents/repos/lightjj && rm -f ~/.config/lightjj/config.json && go run ./cmd/lightjj --addr localhost:3000 --no-browser`
Terminal 2: `cd /Users/iantay/Documents/repos/lightjj/frontend && pnpm run dev`

In the browser (http://localhost:5173):

1. Open Cmd+K → "Edit config" — should show the commented template.
2. Toggle a theme via Cmd+K → "Theme".
3. Re-open the config editor — comments should still be present, `theme` line should reflect the new value.
4. Hand-add `// my test comment` above `splitView`.
5. Save.
6. Drag a panel to resize.
7. Re-open the config editor — `// my test comment` should still be there.
8. `cat ~/.config/lightjj/config.json` — confirm it's valid JSONC on disk.

If any of these fail, stop and diagnose.

- [ ] **Step 8.6: Commit any follow-up fixes from smoke test, then propose shipping**

If everything passes, the plan is complete. Otherwise fix, test, commit, re-verify.

---

## Self-Review

Running through the checklist from the writing-plans skill:

**Spec coverage:**
- "JSONC read support" → Tasks 3, 4 (all readers via `unmarshalJSONC`).
- "JSONC write support" → Tasks 3, 5 (mergeAndWriteConfig + writePersistedTabs via `patchConfigKeys`; raw endpoint writes bytes verbatim).
- "Auto-migrate old JSON files without breaking them" → structural: JSON ⊂ JSONC, so old files Just Work; Task 3 tests this via `TestHandleConfigSet_AcceptsJSONCInput` and the existing plain-JSON round-trip tests continuing to pass.
- "Comments over important fields teaching configuration" → Task 2 (template with comments on theme, editorArgs, editorArgsRemote, fontSize, fonts).

**Placeholder scan:** No "TODO" / "add appropriate error handling" / unelaborated steps. One step (Task 7.3) asks the implementer to "follow the existing pattern" for tutorial content since that file's schema isn't in the plan context — that's a pointer to a concrete file, not a handwave.

**Type consistency:**
- `patchConfigKeys(existing []byte, keys map[string][]byte) ([]byte, error)` — consistent across Tasks 1, 3, 5.
- `readOrTemplate(path string) []byte` — defined Task 3.3, used Task 3.5.
- `writeConfigBytesLocked(path string, data []byte) error` — defined Task 3.3, used Tasks 3.5 and 5.3.
- `standardizeJSONC`, `unmarshalJSONC` — defined Task 1.4, used Tasks 3, 4, 5.
- `configTemplate` — defined Task 2.3, used Tasks 3.3 and 5.3.

All signatures match between tasks.

**Note on Task 7.3 (tutorial content):** The plan asks the implementer to read the existing file to match the schema rather than prescribing it blind. This is safer than guessing at the `TutorialEntry` type — it's a one-line-per-feature file and reading it first is cheaper than specifying it wrong here.
