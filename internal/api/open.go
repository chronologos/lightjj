package api

import (
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
)

// buildEditorArgv substitutes {file} and {line} placeholders in the user's
// editorArgs config. Per-element substitution (no splitting — the user has
// pre-split the array). If no element contains {file}, absPath is appended
// as the final arg. line=nil substitutes "1" so combined tokens like
// "{file}:{line}" stay parseable by editors like code --goto.
//
// argv[0] is validated BEFORE substitution: either absolute or resolvable
// via exec.LookPath, never a relative path, and never a placeholder —
// config-poisoning should not turn a repo file into the executed binary.
func buildEditorArgv(argsTemplate []string, absPath string, line *int) ([]string, error) {
	if len(argsTemplate) == 0 {
		return nil, fmt.Errorf("no editor configured — set editorArgs in config")
	}

	// Validate the TEMPLATE's binary, not the substituted result — otherwise
	// argsTemplate=["{file}"] → absPath (absolute, stat-able) passes below
	// and we exec a repo-controlled file.
	bin := argsTemplate[0]
	if strings.Contains(bin, "{file}") || strings.Contains(bin, "{line}") {
		return nil, fmt.Errorf("editor binary cannot contain placeholders")
	}
	if filepath.IsAbs(bin) {
		if _, err := os.Stat(bin); err != nil {
			return nil, fmt.Errorf("editor binary not found: %s", bin)
		}
	} else if strings.ContainsAny(bin, `/\`) {
		// Both separators — on Windows filepath.Separator alone misses '/'.
		return nil, fmt.Errorf("editor binary must be an absolute path or bare command name")
	} else if _, err := exec.LookPath(bin); err != nil {
		return nil, fmt.Errorf("editor binary not found on PATH: %s", bin)
	}

	lineStr := "1"
	if line != nil {
		lineStr = strconv.Itoa(*line)
	}

	argv := make([]string, len(argsTemplate))
	sawFile := false
	for i, a := range argsTemplate {
		if strings.Contains(a, "{file}") {
			sawFile = true
		}
		// {line} first — it's always a digit string, can't contain "{file}".
		// {file} first would double-substitute on paths containing "{line}".
		a = strings.ReplaceAll(a, "{line}", lineStr)
		a = strings.ReplaceAll(a, "{file}", absPath)
		argv[i] = a
	}
	if !sawFile {
		argv = append(argv, absPath)
	}

	return argv, nil
}

// readConfigField reads a single top-level key from the on-disk config file.
// DRY with handleConfigGet's read path but returns a typed slice for the
// editorArgs use case.
func readConfigEditorArgs() ([]string, error) {
	path, err := configPath()
	if err != nil {
		return nil, err
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, nil // missing file → zero state
	}
	var cfg struct {
		EditorArgs []string `json:"editorArgs"`
	}
	if err := json.Unmarshal(data, &cfg); err != nil {
		return nil, nil // corrupt → zero state (same as handleConfigSet)
	}
	return cfg.EditorArgs, nil
}

type openFileRequest struct {
	Path string `json:"path"`
	Line *int   `json:"line,omitempty"`
}

func (s *Server) handleOpenFile(w http.ResponseWriter, r *http.Request) {
	// Same defense-in-depth as handleConfigSet — the threat model (cross-
	// origin page → config-poison editorArgs → social-engineer right-click)
	// terminates here; if this endpoint rejects cross-origin, poisoned
	// config can't fire.
	if origin := r.Header.Get("Origin"); origin != "" && !isLocalOrigin(origin) {
		s.writeError(w, http.StatusForbidden, "cross-origin open-file rejected")
		return
	}
	if s.RepoDir == "" {
		s.writeError(w, http.StatusNotImplemented, "open-in-editor requires local filesystem access")
		return
	}

	var req openFileRequest
	if err := decodeBody(w, r, &req); err != nil {
		s.writeError(w, http.StatusBadRequest, err.Error())
		return
	}

	// Lexical path checks only — unlike file-write, opening a symlink target
	// in the user's own editor is harmless (read-only disclosure of a file
	// the user already has OS-level access to).
	_, absPath, err := validateRepoRelativePath(s.RepoDir, req.Path)
	if err != nil {
		s.writeError(w, http.StatusBadRequest, err.Error())
		return
	}

	editorArgs, err := readConfigEditorArgs()
	if err != nil {
		s.writeError(w, http.StatusInternalServerError, "cannot read config")
		return
	}
	argv, err := buildEditorArgv(editorArgs, absPath, req.Line)
	if err != nil {
		s.writeError(w, http.StatusBadRequest, err.Error())
		return
	}

	// exec.Command, NOT Runner.RunRaw — the editor opens on the LOCAL
	// machine for the user sitting at the browser. SSH mode is gated above.
	// No fd inheritance, own session (Setsid) so Ctrl+C on lightjj doesn't
	// kill the editor. Fire-and-forget: we don't wait for editor exit.
	cmd := exec.Command(argv[0], argv[1:]...)
	cmd.Dir = s.RepoDir
	cmd.Stdin, cmd.Stdout, cmd.Stderr = nil, nil, nil
	detachProcess(cmd)
	if err := cmd.Start(); err != nil {
		s.writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	// Reap in the background — we don't care about exit status, but an
	// un-Waited child leaks a zombie until lightjj exits.
	go func() { _ = cmd.Wait() }()

	s.writeJSON(w, r, http.StatusOK, map[string]bool{"ok": true})
}
