package api

import (
	"encoding/json"
	"errors"
	"io/fs"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"slices"
	"sync"
)

// state.go — machine-written app state, stored as plain JSON in state.json
// next to config.json ($XDG_CONFIG_HOME/lightjj/state.json or platform
// equivalent via os.UserConfigDir).
//
// Why a separate file from config.json: config.json is human-edited JSONC
// with comments, so every write to it must run through hujson's
// comment-preserving patch machinery (config_jsonc.go) — a subtle surface
// that has already produced a comment-stripping bug (see the bytes.Clone note
// on standardizeJSONC). Machine state (open tabs, recency timestamps) has no
// comments to preserve and changes far more often than the user's settings,
// so it gets a plain-JSON file with a plain read-modify-write path. The
// split: humans edit config.json, lightjj edits state.json.
//
// Like config.json, state.json is host-scoped (shared by all tabs and by
// concurrent lightjj processes), and works identically in SSH mode — it lives
// in the LOCAL user's config dir; only jj commands are proxied over SSH.

// stateMu serializes read-modify-write cycles on state.json within this
// process. atomicWriteFile prevents torn writes but NOT lost updates (two
// concurrent writers both read v1, each merges its delta, last rename wins) —
// the mutex prevents those, same rule as configMu/annMu. updateState also takes a
// file lock, so concurrent lightjj processes don't lose each other's updates.
var stateMu sync.Mutex

func statePath() (string, error) {
	dir, err := userConfigDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(dir, "lightjj", "state.json"), nil
}

// PersistedTab is an openTabs entry. Mode + Host together tag the session
// that created it. Two concurrent `lightjj --remote` sessions on different
// hosts share one state.json — without Host, session B's write stomps A's
// persisted tabs, and A's next restart would try to open B's path on A's
// host (path-collision possible; silent wrong-repo).
type PersistedTab struct {
	Path string `json:"path"`
	Mode string `json:"mode"`           // "local" | "ssh"
	Host string `json:"host,omitempty"` // full user@host for ssh; empty for local
	// Failures counts launches in a row that couldn't restore it (RecordRestore).
	Failures int `json:"failures,omitempty"`
}

// recentActionsState maps namespace → key → last-used Unix-millis timestamp.
// Mirrors the frontend's RecentActionsState shape; the backend stores it
// opaquely (no interpretation beyond shape validation at decode time).
type recentActionsState map[string]map[string]int64

// appState is the schema of state.json. New machine-written values get a new
// field here, NOT a new config.json key.
type appState struct {
	OpenTabs      []PersistedTab     `json:"openTabs,omitempty"`
	RecentActions recentActionsState `json:"recentActions,omitempty"`
}

// readStateLocked loads state.json. Missing, zero-byte, and unparseable files
// all read as fresh (zero-value) state: machine state is fully recoverable
// (tabs re-persist on the next open/close, timestamps re-accumulate), so
// unlike config.json there is no hand-edited data worth protecting behind a
// 422. Caller must hold stateMu.
func readStateLocked() appState {
	var st appState
	path, err := statePath()
	if err != nil {
		return st
	}
	data, err := os.ReadFile(path)
	if err != nil {
		if !errors.Is(err, fs.ErrNotExist) {
			log.Printf("warning: cannot read state file: %v", err)
		}
		return st
	}
	// Zero-byte = fresh, same rule as config's readOrTemplate: a truncated or
	// mid-rename-crashed file has nothing to recover.
	if len(data) == 0 {
		return st
	}
	if err := json.Unmarshal(data, &st); err != nil {
		log.Printf("warning: corrupt state file, treating as fresh: %v", err)
		return appState{}
	}
	return st
}

// writeStateLocked atomic-writes the full state. Caller must hold stateMu.
func writeStateLocked(st appState) error {
	path, err := statePath()
	if err != nil {
		return err
	}
	data, err := json.MarshalIndent(st, "", "  ")
	if err != nil {
		return err
	}
	return atomicWriteFile(path, data)
}

// updateState is the read-modify-write of state.json.
func updateState(fn func(st *appState)) error {
	stateMu.Lock()
	defer stateMu.Unlock()
	path, err := statePath()
	if err != nil {
		return err
	}
	unlock, err := lockFile(path + ".lock")
	if err != nil {
		return err
	}
	defer unlock()
	st := readStateLocked()
	fn(&st)
	return writeStateLocked(st)
}

// same reports whether two entries name the same tab. Mode and Host are part of the
// identity: sessions on different hosts share this file.
func (pt PersistedTab) same(o PersistedTab) bool {
	return pt.Path == o.Path && pt.Mode == o.Mode && pt.Host == o.Host
}

// AddOpenTab / RemoveOpenTab record one tab being opened or closed. Deltas, not the
// session's whole list: an entry that failed to restore, or that another local
// instance has open, is not ours to drop.
func AddOpenTab(pt PersistedTab) error {
	return updateState(func(st *appState) {
		if !slices.ContainsFunc(st.OpenTabs, pt.same) {
			st.OpenTabs = append(st.OpenTabs, pt)
		}
	})
}

func RemoveOpenTab(pt PersistedTab) error {
	return updateState(func(st *appState) { st.OpenTabs = slices.DeleteFunc(st.OpenTabs, pt.same) })
}

// maxRestoreFailures: launches in a row a tab may fail to restore before it is
// forgotten. A failed tab has no close button, so something must end it; an unmounted
// drive or an unreachable host must not.
const maxRestoreFailures = 10

// RecordRestore stores the outcome of a launch's restore attempts. resolved maps each
// attempted entry to its canonical path, "" = failed.
func RecordRestore(resolved map[PersistedTab]string) error {
	if len(resolved) == 0 {
		return nil
	}
	return updateState(func(st *appState) {
		kept := make([]PersistedTab, 0, len(st.OpenTabs))
		for _, pt := range st.OpenTabs {
			root, tried := resolved[pt]
			switch {
			case !tried:
			case root != "":
				pt.Path, pt.Failures = root, 0
			default:
				if pt.Failures++; pt.Failures >= maxRestoreFailures {
					log.Printf("forgetting tab %s: not restorable for %d launches", pt.Path, pt.Failures)
					continue
				}
			}
			if !slices.ContainsFunc(kept, pt.same) {
				kept = append(kept, pt)
			}
		}
		st.OpenTabs = kept
	})
}

// ReadPersistedTabs returns the openTabs array from state.json, or an empty
// slice on any error (missing file, corrupt JSON, field absent). Startup
// restoration is best-effort — a bad entry shouldn't block launch.
func ReadPersistedTabs() []PersistedTab {
	stateMu.Lock()
	defer stateMu.Unlock()
	return readStateLocked().OpenTabs
}

// SetRecentActions replaces the recentActions section of state.json. The
// frontend posts its full map (per-namespace recency timestamps); whole-
// section replace is the intended semantic — last writer wins, acceptable for
// recency data.
func SetRecentActions(ra map[string]map[string]int64) error {
	return updateState(func(st *appState) { st.RecentActions = ra })
}

// readRecentActions returns the recentActions section, never nil (JSON
// serialization must produce {} not null — same rule as parsers returning
// empty slices).
func readRecentActions() recentActionsState {
	stateMu.Lock()
	defer stateMu.Unlock()
	ra := readStateLocked().RecentActions
	if ra == nil {
		ra = recentActionsState{}
	}
	return ra
}

// MigrateStateIfNeeded moves legacy openTabs/recentActions keys out of
// config.json into state.json. One-shot at startup (main.go), before any tab
// restore or HTTP traffic. Idempotent: after a successful migration the keys
// no longer exist in config.json, so subsequent calls no-op.
//
// Sections that already exist in state.json win over config.json values —
// state.json is the newer store, and a downgrade-then-upgrade cycle must not
// resurrect stale config values over fresher state.
//
// Best-effort with a strict ordering guarantee: config keys are removed ONLY
// after the import into state.json has been written. Any failure logs and
// leaves both files alone; leftover legacy keys in config.json are harmless
// (nothing reads them anymore) and are retried on next startup.
//
// Lock order: configMu, then stateMu. Nothing else holds both.
func MigrateStateIfNeeded() {
	cfgPath, err := configPath()
	if err != nil {
		return
	}
	configMu.Lock()
	defer configMu.Unlock()

	data, err := os.ReadFile(cfgPath)
	if err != nil || len(data) == 0 {
		return // no config (or fresh zero-byte) → nothing to migrate
	}
	var rawKeys map[string]json.RawMessage
	if err := unmarshalJSONC(data, &rawKeys); err != nil {
		return // corrupt config — leave it for the write path's 422 surface
	}

	// Decode each legacy key independently so one malformed section doesn't
	// block migrating the other. A key that fails to decode is left in
	// config.json untouched (removing it would discard data we couldn't read).
	var migrated []string
	var tabs []PersistedTab
	if raw, ok := rawKeys["openTabs"]; ok {
		if err := json.Unmarshal(raw, &tabs); err == nil {
			migrated = append(migrated, "openTabs")
		} else {
			log.Printf("warning: cannot decode legacy openTabs from config: %v", err)
		}
	}
	var ra recentActionsState
	if raw, ok := rawKeys["recentActions"]; ok {
		if err := json.Unmarshal(raw, &ra); err == nil {
			migrated = append(migrated, "recentActions")
		} else {
			log.Printf("warning: cannot decode legacy recentActions from config: %v", err)
		}
	}
	if len(migrated) == 0 {
		return // nothing to migrate (already done, or both keys undecodable)
	}

	// Import into state.json. Existing state sections win (see docstring).
	writeErr := updateState(func(st *appState) {
		if len(st.OpenTabs) == 0 {
			st.OpenTabs = tabs
		}
		if len(st.RecentActions) == 0 {
			st.RecentActions = ra
		}
	})
	if writeErr != nil {
		log.Printf("warning: cannot write state file during migration: %v", writeErr)
		return // keep the keys in config.json so the data isn't lost
	}

	// Remove the migrated keys from config.json (comment-preserving remove
	// patch). Failure here is benign: the values are already safe in
	// state.json and the stale config keys are never read again.
	out, err := removeConfigKeys(data, migrated)
	if err != nil {
		log.Printf("warning: migrated state but could not remove legacy keys from config: %v", err)
		return
	}
	if err := atomicWriteFile(cfgPath, out); err != nil {
		log.Printf("warning: migrated state but could not rewrite config: %v", err)
		return
	}
	log.Printf("migrated %v from config.json to state.json", migrated)
}

// --- HTTP handlers ---
//
// State handlers are package-level (not Server methods) for the same reason
// as the config handlers: state is host-scoped, not repo-scoped. TabManager
// registers them at /api/state/... so raw fetch / CLI access works without a
// tab prefix; Server.routes() also registers them so the frontend's
// tab-scoped api.ts client (/tab/{id}/api/state/...) resolves to the same
// backing file.

// handleStateRecentActionsGet serves the recentActions section of state.json.
func handleStateRecentActionsGet(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	if err := json.NewEncoder(w).Encode(readRecentActions()); err != nil {
		log.Printf("state encode error: %v", err)
	}
}

// handleStateRecentActionsSet replaces the recentActions section of
// state.json. Whole-section replace by design (the frontend owns the merged
// map); a null/empty body clears it. Same cross-origin guard as
// handleConfigSet — defense-in-depth on top of decodeBody's
// application/json requirement (which already forces CORS preflight).
func handleStateRecentActionsSet(w http.ResponseWriter, r *http.Request) {
	if !originAllowed(r) {
		writeJSONError(w, http.StatusForbidden, "cross-origin state write rejected")
		return
	}
	var incoming map[string]map[string]int64
	if err := decodeBody(w, r, &incoming); err != nil {
		writeJSONError(w, http.StatusBadRequest, err.Error())
		return
	}
	if err := SetRecentActions(incoming); err != nil {
		writeJSONError(w, http.StatusInternalServerError, err.Error())
		return
	}
	w.WriteHeader(http.StatusOK)
}
