package api

import (
	"encoding/json"
	"maps"
	"net"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
)

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
		w.Write([]byte("{}"))
		return
	}
	w.Header().Set("Content-Type", "application/json")
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

	merged := map[string]json.RawMessage{}
	if existing, err := os.ReadFile(path); err == nil {
		json.Unmarshal(existing, &merged) // best-effort; corrupt file → treat as empty
	}
	maps.Copy(merged, incoming)

	out, err := json.MarshalIndent(merged, "", "  ")
	if err != nil {
		writeJSONError(w, http.StatusInternalServerError, "encode failed")
		return
	}

	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		writeJSONError(w, http.StatusInternalServerError, "cannot create config dir")
		return
	}

	// Atomic write: temp file in same dir + rename. Prevents a half-written
	// config if lightjj is killed mid-write (e.g., user Ctrl+C during a
	// panel-resize drag that triggered a debounced save).
	tmp, err := os.CreateTemp(filepath.Dir(path), ".config-*.json")
	if err != nil {
		writeJSONError(w, http.StatusInternalServerError, "cannot create temp file")
		return
	}
	tmpPath := tmp.Name()
	defer os.Remove(tmpPath) // no-op if rename succeeded
	if _, err := tmp.Write(out); err != nil {
		tmp.Close()
		writeJSONError(w, http.StatusInternalServerError, "write failed")
		return
	}
	if err := tmp.Close(); err != nil {
		writeJSONError(w, http.StatusInternalServerError, "close failed")
		return
	}
	if err := os.Rename(tmpPath, path); err != nil {
		writeJSONError(w, http.StatusInternalServerError, "rename failed")
		return
	}

	w.WriteHeader(http.StatusOK)
}
