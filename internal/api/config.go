package api

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"log"
	"net"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"

	"github.com/tailscale/hujson"
)

// ErrConfigUnparseable wraps a hujson.Parse failure on a file that exists
// with content. Distinguished from other errors so handlers can return 422
// (the user's file, not the server, is the problem). A silent reseed from
// the template would destroy the user's hand-edits on the next panel-drag
// write; we surface a warning in the frontend and leave the file alone.
var ErrConfigUnparseable = errors.New("config file has a syntax error")

// Serializes read-merge-write. Two tabs writing simultaneously (panel resize +
// theme toggle) each read disk state, merge their delta, rename — last writer
// wins, other's key dropped. The RFC 6902 patch preserves unknown keys across
// versions but not across concurrent same-version writes.
var configMu sync.Mutex

// User config is stored at $XDG_CONFIG_HOME/lightjj/config.json (or platform
// equivalent via os.UserConfigDir). Unlike localStorage this survives port
// changes — spawned workspace instances on different ports share one config.
//
// Works in both local and SSH mode: the config file lives in the local user's
// config dir, not the repo. Only jj commands are proxied over SSH.

// userConfigDir is a test seam — os.UserConfigDir ignores XDG_CONFIG_HOME on
// macOS/Windows, so tests override this rather than scribble on the real path.
var userConfigDir = os.UserConfigDir

func configPath() (string, error) {
	dir, err := userConfigDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(dir, "lightjj", "config.json"), nil
}

// MigrateConfigIfNeeded reseeds the config file with the teaching-comment
// template if it exists in pre-1.20 plain-JSON form. Triggered once at
// startup. Idempotent: after migration, hasJSONCComments returns true on the
// migrated file and subsequent calls no-op.
//
// The user's existing values are preserved via patchConfigKeys — template
// keys get the user's values, extra keys (remoteVisibility, legacy
// openTabs/recentActions, etc.) land as compact JSON after the template
// block. Legacy machine-state keys are then moved out to state.json by
// MigrateStateIfNeeded, which main.go runs right after this.
//
// Failure modes are best-effort and logged: missing file is normal (fresh
// install → template seeds on first write); parse error is left alone (the
// write path will surface it via 422 and the user fixes the typo manually);
// other IO errors are logged and skipped.
func MigrateConfigIfNeeded() {
	path, err := configPath()
	if err != nil {
		return
	}
	configMu.Lock()
	defer configMu.Unlock()

	data, err := os.ReadFile(path)
	if err != nil {
		return // ENOENT is normal; other errors will surface via the write path
	}
	if hasJSONCComments(data) {
		return // already migrated or user-annotated
	}

	// Decode ALL top-level keys so they get patched over the template.
	// unmarshalJSONC tolerates trailing commas (which hasJSONCComments doesn't
	// detect); a corrupt file fails here and is left alone for the 422 path.
	var existingKeys map[string]json.RawMessage
	if err := unmarshalJSONC(data, &existingKeys); err != nil {
		return // corrupt or non-object — let the normal error path surface it
	}
	keys := make(map[string][]byte, len(existingKeys))
	for k, v := range existingKeys {
		keys[k] = []byte(v)
	}

	migrated, err := patchConfigKeys([]byte(configTemplate), keys)
	if err != nil {
		log.Printf("warning: failed to migrate config to JSONC template: %v", err)
		return
	}
	// One-time backup so a downgrade-then-panel-drag doesn't silently wipe
	// values (pre-1.20 mergeAndWriteConfig treats a JSONC file as corrupt-→empty).
	// Best-effort; we don't block migration if the .bak write fails.
	if err := os.WriteFile(path+".pre-jsonc.bak", data, 0o644); err != nil {
		log.Printf("warning: failed to write pre-migration backup: %v", err)
	}
	if err := atomicWriteFile(path, migrated); err != nil {
		log.Printf("warning: failed to write migrated config: %v", err)
		return
	}
	log.Printf("migrated config file at %s to JSONC template (comments + preserved values)", path)
}

// Config handlers are package-level (not Server methods) because config is
// host-scoped, not repo-scoped. TabManager registers these at /api/config so
// config.svelte.ts's raw fetch() works without a tab prefix. Server.routes()
// also registers them so /tab/{id}/api/config works (harmlessly redundant —
// both read the same file).
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
		// Don't return {} — the frontend would overwrite in-memory state with
		// defaults. Tell it the file is broken so it can show a warning and
		// keep whatever it already has. The raw endpoint still serves the
		// unparseable bytes so the user can open the modal and fix the typo.
		writeJSONError(w, http.StatusUnprocessableEntity, "config file has a syntax error: "+err.Error())
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.Write(std)
}

// isLocalOrigin checks whether an Origin header value points at a loopback
// host. Defense-in-depth against a malicious page POSTing editorArgs (then
// social-engineering the user into right-click → Open). localhostOnly already
// validates Host, but browsers set Host=localhost on cross-origin fetch() so
// that gate doesn't block CORS writes. Non-browser clients (curl) typically
// omit Origin → permitted.
func isLocalOrigin(origin string) bool {
	u, err := url.Parse(origin)
	if err != nil {
		return false
	}
	h := u.Hostname()
	if h == "localhost" {
		return true
	}
	// net.ParseIP handles both 127.0.0.1 and ::1 (and the full 127/8 block).
	if ip := net.ParseIP(h); ip != nil {
		return ip.IsLoopback()
	}
	return false
}

func handleConfigSet(w http.ResponseWriter, r *http.Request) {
	if origin := r.Header.Get("Origin"); origin != "" && !isLocalOrigin(origin) {
		writeJSONError(w, http.StatusForbidden, "cross-origin config write rejected")
		return
	}

	path, err := configPath()
	if err != nil {
		writeJSONError(w, http.StatusInternalServerError, "cannot resolve config dir")
		return
	}

	// Decode into json.RawMessage to preserve unknown fields. Future lightjj
	// versions may add config keys; an older instance writing its subset must
	// not silently drop the newer instance's keys. Merge: read disk state,
	// overlay request body, write back.
	var incoming map[string]json.RawMessage
	if err := decodeBody(w, r, &incoming); err != nil {
		writeJSONError(w, http.StatusBadRequest, err.Error())
		return
	}

	if err := mergeAndWriteConfig(path, incoming); err != nil {
		// 422: the user's file is the problem, not the server. Distinct from
		// 500 so the frontend can surface a dedicated warning and stop retrying
		// — debounced panel-drag writes would otherwise hammer the endpoint.
		if errors.Is(err, ErrConfigUnparseable) {
			writeJSONError(w, http.StatusUnprocessableEntity, err.Error())
			return
		}
		writeJSONError(w, http.StatusInternalServerError, err.Error())
		return
	}
	w.WriteHeader(http.StatusOK)
}

// mergeAndWriteConfig reads the existing config (JSONC-aware), applies each
// incoming key as an RFC 6902 `add` patch (replaces if present, inserts if
// missing), and atomic-writes back. Holds configMu for the whole cycle.
// Comments attached to EXISTING members survive; added-by-patch members get
// no comments (acceptable — nobody hand-comments programmatic values).
//
// If the file doesn't exist, configTemplate seeds it (fresh install gets
// teaching comments on first save). If it's unparseable, the error propagates
// so the caller can surface a warning — we never silently replace the user's
// bad file. A debounced panel-drag that blew away a carefully commented
// config on every mousemove would be unrecoverable.
//
// This is the single write path for USER config keys (handleConfigSet).
// Machine-written state (openTabs, recentActions) does NOT go through here —
// it lives in state.json (state.go), precisely so machine writes never touch
// the comment-preservation machinery.
func mergeAndWriteConfig(path string, incoming map[string]json.RawMessage) error {
	configMu.Lock()
	defer configMu.Unlock()

	existing, err := readOrTemplate(path)
	if err != nil {
		return err
	}
	keys := make(map[string][]byte, len(incoming))
	for k, v := range incoming {
		keys[k] = []byte(v)
	}
	out, err := patchConfigKeys(existing, keys)
	if err != nil {
		return err
	}
	return atomicWriteFile(path, out)
}

// readOrTemplate returns the on-disk JSONC bytes if the file exists and parses.
// ENOENT → template bytes (fresh install, normal first run). Any other
// ReadFile error OR a hujson parse error returns an error — callers must
// propagate so the user's bad file is NEVER silently replaced by the template.
// A user-visible warning in the frontend is the right failure mode here.
func readOrTemplate(path string) ([]byte, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return []byte(configTemplate), nil
		}
		return nil, err
	}
	// Zero-byte file (truncated by `> config.json` or a non-journaled crash)
	// has no user data to preserve — treat as fresh, not unparseable. Otherwise
	// the user is stuck: 422 on every write, and the raw modal serves an empty
	// editor that itself fails the object-root check on save.
	if len(data) == 0 {
		return []byte(configTemplate), nil
	}
	if _, parseErr := hujson.Parse(data); parseErr != nil {
		return nil, fmt.Errorf("%w: %v", ErrConfigUnparseable, parseErr)
	}
	return data, nil
}

// Tab persistence (openTabs) and recency timestamps (recentActions) used to
// live in config.json; they are machine-written state and now live in
// state.json — see state.go (PersistedTab, SetOpenTabs, ReadPersistedTabs,
// SetRecentActions). MigrateStateIfNeeded moves legacy keys over on startup.

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
	switch {
	case errors.Is(err, fs.ErrNotExist), err == nil && len(data) == 0:
		// Missing or zero-byte → serve the template so the modal opens with
		// something the user can edit-and-save (mirrors readOrTemplate).
		data = []byte(configTemplate)
	case err != nil:
		// Don't silently reseed: user's real file exists but couldn't be
		// read (EACCES, EIO). Handing them the template would prime a
		// save that clobbers their file when the fs recovers.
		log.Printf("warning: cannot read config for raw view: %v", err)
		writeJSONError(w, http.StatusInternalServerError, "cannot read config: "+err.Error())
		return
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
	// NOTE: text/plain is a CORS-safelisted Content-Type — it does NOT force
	// preflight (unlike application/json on the typed endpoint). isLocalOrigin
	// above is the SOLE cross-origin gate for this handler; do not relax it.
	// The CT check below only normalises the request shape (rejects accidental
	// application/json POSTs expecting per-key merge semantics).
	ct := r.Header.Get("Content-Type")
	if !strings.HasPrefix(ct, "text/plain") {
		writeJSONError(w, http.StatusUnsupportedMediaType, "Content-Type must be text/plain")
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
	v, err := hujson.Parse(body)
	if err != nil {
		writeJSONError(w, http.StatusBadRequest, "invalid JSONC: "+err.Error())
		return
	}
	// Object root only — a non-object (`[]`, `42`, `null`) would land on disk
	// fine but every subsequent patchConfigKeys call fails with "cannot add
	// to non-object", and the 422 surface tells the user "syntax error" when
	// the syntax is valid. Mirrors ConfigModal's client-side check.
	if _, ok := v.Value.(*hujson.Object); !ok {
		writeJSONError(w, http.StatusBadRequest, "config must be a JSON object")
		return
	}
	configMu.Lock()
	defer configMu.Unlock()
	if err := atomicWriteFile(path, body); err != nil {
		writeJSONError(w, http.StatusInternalServerError, err.Error())
		return
	}
	w.WriteHeader(http.StatusOK)
}
