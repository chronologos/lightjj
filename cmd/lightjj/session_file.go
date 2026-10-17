package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"syscall"

	"github.com/chronologos/lightjj/internal/api"
)

// Runtime session metadata for agent discovery. Written after net.Listen binds
// so agents can find a running lightjj by repo path instead of port. The
// Host-allow-list middleware (api.HostPolicy, hostgate.go) is the security
// boundary; this file just makes the port discoverable to local processes.

// sessionTab is one open tab of a running instance: its route id (the N in
// /tab/{N}/api/...) and canonical workspace root. In --remote mode Path is a
// remote path — harmless, discovery drops the whole session on Mode != "local"
// before any path is matched, and `lightjj sessions` still gets to show it.
type sessionTab struct {
	ID   string `json:"id"`
	Path string `json:"path"`
}

type sessionInfo struct {
	PID       int    `json:"pid"`
	Addr      string `json:"addr"`     // listener.Addr().String() — "127.0.0.1:NNNNN"
	Port      int    `json:"port"`     // parsed for convenience
	RepoDir   string `json:"repo_dir"` // resolved local path, or remote path in --remote mode
	Mode      string `json:"mode"`     // "local" or "ssh"
	StartedAt int64  `json:"started_at"`
	// Version is the writing binary's resolvedVersion(). `lightjj api` warns
	// when it differs from its own — the stale-go:embed-binary bug class.
	// Empty when the file predates the field (no warning).
	Version string `json:"version,omitempty"`
	// Tabs lists every open tab, tab 0 (== RepoDir) included, rewritten on
	// tab open/close. Empty/absent in files from older binaries — discovery
	// then falls back to RepoDir and treats the match as tab 0.
	Tabs []sessionTab `json:"tabs"`
}

// resolveSessionPaths computes the session base+dir paths and whether ownership
// must be verified, without touching the filesystem (only os.Getenv/os.TempDir).
// $XDG_RUNTIME_DIR/lightjj/sessions where set (Linux desktop), else
// os.TempDir()/lightjj-<uid>/sessions. The TempDir fallback requires
// ownership verification: sticky /tmp lets any user pre-create
// /tmp/lightjj-<victim-uid> and plant a sessions/<pid>.json symlink, which
// os.WriteFile would follow. XDG_RUNTIME_DIR is already user-owned by spec, so
// the check is skipped there on the WRITE path (matches historical behavior;
// the read path re-verifies unconditionally — see sessionDirReadOnly).
func resolveSessionPaths() (base, dir string, verify bool) {
	if x := os.Getenv("XDG_RUNTIME_DIR"); x != "" {
		base = filepath.Join(x, "lightjj")
	} else {
		base = filepath.Join(os.TempDir(), fmt.Sprintf("lightjj-%d", os.Getuid()))
		verify = true
	}
	dir = filepath.Join(base, "sessions")
	return base, dir, verify
}

// sessionDir resolves and creates the runtime sessions directory (writer path).
// Created 0700 so other local users can't read the port (which grants API
// control). Verifies base BEFORE MkdirAll (pre-existing symlink) and base+dir
// AFTER (umask widening, pre-planted sessions/).
func sessionDir() (string, error) {
	base, dir, verify := resolveSessionPaths()
	// Verify base BEFORE MkdirAll so a pre-existing symlink isn't followed into
	// attacker-controlled space. ENOENT → fine, we create it.
	if verify {
		if err := verifyOwnedDir(base); err != nil && !errors.Is(err, os.ErrNotExist) {
			return "", err
		}
	}
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return "", err
	}
	if verify {
		// Re-verify post-create: confirms MkdirAll didn't widen perms (umask)
		// and that sessions/ itself wasn't pre-planted inside a legit base.
		if err := verifyOwnedDir(base); err != nil {
			return "", err
		}
		if err := verifyOwnedDir(dir); err != nil {
			return "", err
		}
	}
	return dir, nil
}

// sessionDirReadOnly resolves the runtime sessions directory without creating
// it. Used by `lightjj api` and `lightjj sessions` — a read-only command must
// not create directories.
//
// Verification is UNCONDITIONAL here — including on the XDG_RUNTIME_DIR path
// the writer skips. The XDG spec guarantees user-ownership but the guarantee
// is enforced by systemd-logind, not the kernel; a stray
// `export XDG_RUNTIME_DIR=...` in a Dockerfile or rc file silently disables
// it. The read path directs traffic (a successful read produces an addr the
// CLI connects to), so it must not inherit the writer's optimization. Cost is
// two Lstat syscalls. ENOENT propagates so callers can distinguish "lightjj
// not running" from a perms problem.
//
// Verify-to-readDir window: the dir is verified by path, then re-opened by
// os.ReadDir in a separate syscall. On the TempDir path the sticky bit on /tmp
// prevents cross-uid replacement of the verified base; on the XDG path the
// directory is user-owned. Same-uid replacement is in scope for the threat
// model but unchanged from the writer's behavior. The pidAlive→connect TOCTOU
// (api-cli.md Security §3) is the larger gap; both close with a per-session
// bearer token (BACKLOG.md).
func sessionDirReadOnly() (string, error) {
	base, dir, _ := resolveSessionPaths()
	if err := verifyOwnedDir(base); err != nil {
		return "", err
	}
	if err := verifyOwnedDir(dir); err != nil {
		return "", err
	}
	return dir, nil
}

// maxSessionFileSize caps how much of a session JSON file readSessions will
// parse. Legitimate files are ~200 bytes + ~100 per open tab; 64 KiB leaves
// room for hundreds of tabs while an oversized file is still rejected as
// corruption or a planted DoS.
const maxSessionFileSize = 64 << 10

// readSessions reads and parses all <pid>.json files in dir. Skips files that
// are oversized (> maxSessionFileSize), unparseable, or schema-invalid (no PID).
// Does NOT filter by pidAlive — callers decide. Does NOT sweep. Returns an
// empty slice (not nil) if dir is missing or has no entries.
func readSessions(dir string) ([]sessionInfo, error) {
	out := []sessionInfo{}
	entries, err := os.ReadDir(dir)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return out, nil
		}
		return out, err
	}
	for _, e := range entries {
		name := e.Name()
		if !strings.HasSuffix(name, ".json") {
			continue
		}
		full := filepath.Join(dir, name)
		// Open once, fstat the open fd, read with a hard cap. Lstat-then-
		// ReadFile leaves a window where the file is swapped for a FIFO (read
		// hangs) or grown past the cap (read fully) — open+fstat closes both
		// (f.Stat() on a FIFO fd reports ModeNamedPipe; LimitReader caps).
		// Symlink-swap is NOT closed here (os.Open follows symlinks, and so
		// does os.ReadFile) — that's gated by verifyOwnedDir on the parent,
		// which restricts the dir to same-uid writers who could read the
		// target directly anyway. The fd-based check is a hardening, not the
		// trust boundary.
		f, err := os.Open(full)
		if err != nil {
			continue
		}
		fi, err := f.Stat()
		if err != nil || !fi.Mode().IsRegular() || fi.Size() > maxSessionFileSize {
			f.Close()
			continue
		}
		data, err := io.ReadAll(io.LimitReader(f, maxSessionFileSize+1))
		f.Close()
		if err != nil || int64(len(data)) > maxSessionFileSize {
			continue
		}
		var s sessionInfo
		if err := json.Unmarshal(data, &s); err != nil {
			continue
		}
		if s.PID <= 0 || s.Addr == "" {
			continue // schema-invalid
		}
		if s.Tabs == nil {
			s.Tabs = []sessionTab{} // older writer — serialize as [] not null
		}
		out = append(out, s)
	}
	return out, nil
}

// verifyOwnedDir checks that path is a real directory (not a symlink) with no
// group/other permission bits, owned by the current user (uid check is in
// session_file_unix.go — Stat_t doesn't exist on Windows). Guards against a
// hostile user pre-creating the TempDir-fallback path.
func verifyOwnedDir(path string) error {
	fi, err := os.Lstat(path)
	if err != nil {
		return err
	}
	if !fi.IsDir() || fi.Mode()&os.ModeSymlink != 0 {
		return fmt.Errorf("session dir %s is not a plain directory", path)
	}
	if fi.Mode().Perm()&0o077 != 0 {
		return fmt.Errorf("session dir %s has group/other permissions", path)
	}
	return verifyOwner(path, fi)
}

// pidAlive: signal-0 probe. nil or EPERM ⇒ alive; ESRCH ⇒ dead.
// Package-level var so tests can stub it (api_cmd_test.go).
var pidAlive = func(pid int) bool {
	p, err := os.FindProcess(pid)
	if err != nil {
		return false
	}
	err = p.Signal(syscall.Signal(0))
	return err == nil || errors.Is(err, syscall.EPERM)
}

// sweepStaleSessions removes <pid>.json files whose pid is no longer running.
// Best-effort: a concurrent instance may sweep the same entry; the dir may not
// exist on first run.
func sweepStaleSessions(dir string) {
	entries, _ := os.ReadDir(dir)
	for _, e := range entries {
		name := e.Name()
		if !strings.HasSuffix(name, ".json") {
			continue
		}
		pid, err := strconv.Atoi(strings.TrimSuffix(name, ".json"))
		if err != nil || pidAlive(pid) {
			continue
		}
		_ = os.Remove(filepath.Join(dir, name))
	}
}

// writeSessionFile writes the metadata file and returns its path for cleanup.
// Sweeps stale entries first so crashes don't accumulate. Non-fatal on error —
// agent discovery is best-effort; the server still works.
//
// The write is atomic (temp file in the same dir + rename): the file is
// rewritten on every tab open/close while `lightjj api` may be reading it, and
// a torn read would parse as garbage → "no session". os.CreateTemp creates
// 0600; the temp name doesn't end in .json so readSessions/sweep ignore it.
//
// No-op on Windows: os.Getuid()==-1, fileStat.Mode() synthesizes 0777 (so the
// 0o077 check is a wall not a gate), and Signal(0) is unsupported (sweep would
// delete live siblings). release.yml ships darwin/linux only.
func writeSessionFile(info sessionInfo) string {
	if runtime.GOOS == "windows" {
		return ""
	}
	dir, err := sessionDir()
	if err != nil {
		return ""
	}
	sweepStaleSessions(dir)
	name := fmt.Sprintf("%d.json", info.PID)
	path := filepath.Join(dir, name)
	if info.Tabs == nil {
		info.Tabs = []sessionTab{}
	}
	js, _ := json.Marshal(info)
	tmp, err := os.CreateTemp(dir, name+".*.tmp")
	if err != nil {
		return ""
	}
	tmpPath := tmp.Name()
	defer os.Remove(tmpPath) // no-op after a successful rename
	if _, err := tmp.Write(js); err != nil {
		tmp.Close()
		return ""
	}
	if err := tmp.Close(); err != nil {
		return ""
	}
	if err := os.Rename(tmpPath, path); err != nil {
		return ""
	}
	return path
}

// sessionWriter owns one process's session file across its lifetime: the
// fixed identity fields (pid/addr/version/…) are captured once, Update
// rewrites the file with a fresh tab list, Remove deletes it at shutdown.
// Tab open/close arrive on concurrent HTTP handler goroutines, so mu
// serializes fetch-tabs + write as one step — the snapshot is taken INSIDE the
// lock (tabs is a func, not a value) so the last write always reflects the
// latest tab set rather than whichever goroutine happened to rename last.
type sessionWriter struct {
	mu      sync.Mutex
	base    sessionInfo
	tabs    func() []sessionTab
	path    string // last successfully written path; "" until first success
	removed bool   // Remove() ran — later Updates are no-ops (shutdown latch)
}

func newSessionWriter(base sessionInfo, tabs func() []sessionTab) *sessionWriter {
	return &sessionWriter{base: base, tabs: tabs}
}

// Update rewrites the session file with the current tab list. Best-effort:
// a failed write keeps the previous file (atomic rename) and its path. A
// no-op after Remove: a tab open/close handler that released the manager
// lock just before the shutdown signal would otherwise re-create the file
// for a pid that is about to exit (leaked session → discovery hits a dead or
// recycled pid).
func (w *sessionWriter) Update() {
	w.mu.Lock()
	defer w.mu.Unlock()
	if w.removed {
		return
	}
	info := w.base
	if w.tabs != nil {
		info.Tabs = w.tabs()
	}
	if p := writeSessionFile(info); p != "" {
		w.path = p
	}
}

// sessionTabsOf adapts TabManager's out-of-package snapshot to the wire type.
func sessionTabsOf(refs []api.TabRef) []sessionTab {
	out := make([]sessionTab, len(refs))
	for i, r := range refs {
		out[i] = sessionTab{ID: r.ID, Path: r.Path}
	}
	return out
}

// Remove deletes the session file (shutdown) and latches the writer so a
// racing Update can't resurrect it. Harmless if never written.
func (w *sessionWriter) Remove() {
	w.mu.Lock()
	defer w.mu.Unlock()
	w.removed = true
	if w.path != "" {
		_ = os.Remove(w.path)
	}
}
