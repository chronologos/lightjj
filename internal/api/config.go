package api

import (
	"encoding/json"
	"errors"
	"io/fs"
	"log"
	"maps"
	"net"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"sync"
)

// Serializes read-merge-write. Two tabs writing simultaneously (panel resize +
// theme toggle) each read disk state, merge their delta, rename — last writer
// wins, other's key dropped. maps.Copy preserves unknown keys across versions
// but not across concurrent same-version writes.
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
		// Missing file is the zero state — return {} so the frontend merges
		// over defaults. Don't 404: that would log as an error in the browser
		// console on first run.
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("Cache-Control", "no-store")
		w.Write([]byte("{}"))
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.Write(data)
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
		writeJSONError(w, http.StatusInternalServerError, err.Error())
		return
	}
	w.WriteHeader(http.StatusOK)
}

// mergeAndWriteConfig reads the existing config (best-effort), overlays
// incoming keys, atomic-writes back. Holds configMu for the whole cycle.
// Used by handleConfigSet; writePersistedTabs needs INTRA-key filtering
// (not whole-key overlay) so it builds its own merged map and calls
// writeConfigLocked directly.
func mergeAndWriteConfig(path string, incoming map[string]json.RawMessage) error {
	configMu.Lock()
	defer configMu.Unlock()

	merged := map[string]json.RawMessage{}
	if existing, err := os.ReadFile(path); err == nil {
		json.Unmarshal(existing, &merged) // best-effort; corrupt file → treat as empty
	}
	maps.Copy(merged, incoming)
	return writeConfigLocked(path, merged)
}

// writeConfigLocked atomic-writes the given config map. Caller must hold
// configMu. Separate from mergeAndWriteConfig so writePersistedTabs can do
// its own intra-key filter-merge under the same lock.
func writeConfigLocked(path string, merged map[string]json.RawMessage) error {
	out, err := json.MarshalIndent(merged, "", "  ")
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	// Atomic write: temp file in same dir + rename. Prevents a half-written
	// config if lightjj is killed mid-write (e.g., user Ctrl+C during a
	// panel-resize drag that triggered a debounced save).
	tmp, err := os.CreateTemp(filepath.Dir(path), ".config-*.json")
	if err != nil {
		return err
	}
	tmpPath := tmp.Name()
	defer os.Remove(tmpPath) // no-op if rename succeeded
	if _, err := tmp.Write(out); err != nil {
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
	if err := json.Unmarshal(data, &cfg); err != nil {
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

	// Read existing config (RawMessage → preserves theme/editorArgs/etc).
	merged := map[string]json.RawMessage{}
	if data, err := os.ReadFile(path); err == nil {
		json.Unmarshal(data, &merged)
	}

	// Decode existing openTabs, filter out this session's entries, append fresh.
	var existing []PersistedTab
	if raw, ok := merged["openTabs"]; ok {
		json.Unmarshal(raw, &existing)
	}
	kept := existing[:0]
	for _, pt := range existing {
		if pt.Mode == mode && pt.Host == host {
			continue // this session's old entry; replaced below
		}
		kept = append(kept, pt)
	}
	kept = append(kept, tabs...)

	raw, err := json.Marshal(kept)
	if err != nil {
		return err
	}
	merged["openTabs"] = raw
	return writeConfigLocked(path, merged)
}
