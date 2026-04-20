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
// no comments (acceptable — they're typically openTabs/recentActions).
//
// If the file doesn't exist, configTemplate seeds it (fresh install gets
// teaching comments on first save). If it's unparseable, the error propagates
// so the caller can surface a warning — we never silently replace the user's
// bad file. A debounced panel-drag that blew away a carefully commented
// config on every mousemove would be unrecoverable.
//
// Used by handleConfigSet; writePersistedTabs needs filter-merge so it builds
// its own patch and calls writeConfigBytesLocked directly.
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
	return writeConfigBytesLocked(path, out)
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
	if _, parseErr := hujson.Parse(data); parseErr != nil {
		return nil, fmt.Errorf("%w: %v", ErrConfigUnparseable, parseErr)
	}
	return data, nil
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

// PersistedTab is an openTabs entry. Mode + Host together tag the session
// that created it. Two concurrent `lightjj --remote` sessions on different
// hosts share one config.json — without Host, session B's write stomps A's
// persisted tabs, and A's next restart would try to open B's path on A's
// host (path-collision possible; silent wrong-repo).
type PersistedTab struct {
	Path string `json:"path"`
	Mode string `json:"mode"`           // "local" | "ssh"
	Host string `json:"host,omitempty"` // full user@host for ssh; empty for local
}

// ReadPersistedTabs returns the openTabs array from config.json, or an empty
// slice on any error (missing file, corrupt JSON, field absent). Startup
// restoration is best-effort — a bad tab shouldn't block launch.
func ReadPersistedTabs() []PersistedTab {
	path, err := configPath()
	if err != nil {
		return nil
	}
	data, err := os.ReadFile(path)
	if err != nil {
		// ErrNotExist is the normal first-run state; anything else (EACCES,
		// EIO) means the user won't know why tabs never persist — log it.
		if !errors.Is(err, fs.ErrNotExist) {
			log.Printf("warning: cannot read persisted tabs: %v", err)
		}
		return nil
	}
	var cfg struct {
		OpenTabs []PersistedTab `json:"openTabs"`
	}
	if err := unmarshalJSONC(data, &cfg); err != nil {
		log.Printf("warning: corrupt config, skipping tab restore: %v", err)
		return nil
	}
	return cfg.OpenTabs
}

// writePersistedTabs updates config.json with this session's current tab list
// WITHOUT stomping other sessions' entries. A filter-merge: entries matching
// (mode, host) are replaced with `tabs`; entries for other sessions pass
// through untouched. Two `lightjj --remote` processes on hostA/hostB share
// one config — a whole-array overwrite would lose the other's state on every
// tab open.
//
// Cross-process races (two lightjj instances writing simultaneously) are NOT
// fully serialized — configMu is per-process. The filter-merge at least
// confines lost-write damage: each process only rewrites its own (mode,host)
// entries, so a collision loses at most one process's DELTA since its last
// write, not the other process's entire state. Acceptable for user prefs.
func writePersistedTabs(mode, host string, tabs []PersistedTab) error {
	path, err := configPath()
	if err != nil {
		return err
	}
	configMu.Lock()
	defer configMu.Unlock()

	existing, err := readOrTemplate(path)
	if err != nil {
		// Unparseable config shouldn't eat this session's tab persistence —
		// but reseeding would stomp user edits. Log and bail; next launch
		// re-runs ReadPersistedTabs which is also lenient, so the net effect
		// is "tabs don't persist until the user fixes their syntax error".
		// tabs.go:persistTabs already log.Printf's the return error.
		return err
	}

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
		if errors.Is(err, fs.ErrNotExist) {
			data = []byte(configTemplate)
		} else {
			// Don't silently reseed: user's real file exists but couldn't be
			// read (EACCES, EIO). Handing them the template would prime a
			// save that clobbers their file when the fs recovers.
			log.Printf("warning: cannot read config for raw view: %v", err)
			writeJSONError(w, http.StatusInternalServerError, "cannot read config: "+err.Error())
			return
		}
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
	// Require text/plain — forces CORS preflight for cross-origin requests,
	// same defence-in-depth that decodeBody's application/json check gives
	// to the typed endpoint. Without it, a cross-origin <form enctype="text/plain">
	// post would be treated as a "simple" request and skip preflight.
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
