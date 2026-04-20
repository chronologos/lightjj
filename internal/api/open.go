package api

import (
	"fmt"
	"net/http"
	"os"
	"os/exec"
	"path"
	"path/filepath"
	"strconv"
	"strings"
)

// editorSubst groups placeholder values for buildEditorArgv. See docs/CONFIG.md
// for placeholder semantics.
type editorSubst struct {
	File    string // absolute path where the repo lives (local fs OR remote fs)
	RelPath string // repo-relative path (always POSIX-separated, from jj)
	Host    string // full user@host spec in --remote mode; empty in local
	Line    *int   // 1-based; nil → "1"
}

// buildEditorArgv substitutes {file}/{relpath}/{host}/{line} placeholders in
// the user's editorArgs config. Per-element substitution (no splitting — the
// user has pre-split the array). If no element contains {file} or {relpath},
// sub.File is appended as the final arg.
//
// argv[0] is validated BEFORE substitution: either absolute or resolvable
// via exec.LookPath, never a relative path, and never a placeholder —
// config-poisoning should not turn a repo file into the executed binary.
func buildEditorArgv(argsTemplate []string, sub editorSubst) ([]string, error) {
	if len(argsTemplate) == 0 {
		return nil, fmt.Errorf("no editor configured — see docs/CONFIG.md")
	}

	// Validate the TEMPLATE's binary, not the substituted result — otherwise
	// argsTemplate=["{file}"] → absPath (absolute, stat-able) passes below
	// and we exec a repo-controlled file.
	bin := argsTemplate[0]
	if strings.ContainsRune(bin, '{') {
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
	if sub.Line != nil {
		lineStr = strconv.Itoa(*sub.Line)
	}

	// Single Replacer: single-pass left-to-right, never rescans output.
	// A file literally named "{line}.go" can't double-sub because that
	// string was never in the scanned INPUT — it's a substitution OUTPUT.
	replacer := strings.NewReplacer(
		"{line}", lineStr,
		"{host}", sub.Host,
		"{file}", sub.File,
		"{relpath}", sub.RelPath,
	)

	argv := make([]string, len(argsTemplate))
	sawPath := false
	for i, a := range argsTemplate {
		if strings.Contains(a, "{file}") || strings.Contains(a, "{relpath}") {
			sawPath = true
		}
		argv[i] = replacer.Replace(a)
	}
	if !sawPath {
		argv = append(argv, sub.File)
	}

	return argv, nil
}

type editorConfig struct {
	EditorArgs       []string `json:"editorArgs"`
	EditorArgsRemote []string `json:"editorArgsRemote"`
}

// readConfigEditor reads both editor fields from the on-disk config file.
// DRY with handleConfigGet's read path but returns the typed struct.
func readConfigEditor() (editorConfig, error) {
	p, err := configPath()
	if err != nil {
		return editorConfig{}, err
	}
	data, err := os.ReadFile(p)
	if err != nil {
		return editorConfig{}, nil // missing file → zero state
	}
	var cfg editorConfig
	_ = unmarshalJSONC(data, &cfg) // corrupt → zero state (same as handleConfigSet)
	return cfg, nil
}

// editorTemplate picks the config field for this server's mode and computes
// the substitution values for a given request path. Used by handleOpenFile
// (to spawn) and handleInfo (to report editor_configured).
func (s *Server) editorTemplate(relPath string, line *int) ([]string, editorSubst, error) {
	cfg, err := readConfigEditor()
	if err != nil {
		return nil, editorSubst{}, err
	}
	if s.hasLocalFS() {
		// Local mode (also port-forward: lightjj runs where the repo lives).
		return cfg.EditorArgs, editorSubst{
			File:    filepath.Join(s.RepoDir, relPath),
			RelPath: relPath,
			Host:    s.SSHHost,
			Line:    line,
		}, nil
	}
	// --remote mode: no local fs. {file} = remote absolute (POSIX — RepoPath
	// is a canonical remote path). relPath comes from validateRepoRelativePath
	// which uses filepath.Clean (OS-native separators); convert to POSIX for
	// the remote join AND the {relpath} substitution.
	posixRel := filepath.ToSlash(relPath)
	return cfg.EditorArgsRemote, editorSubst{
		File:    path.Join(s.RepoPath, posixRel),
		RelPath: posixRel,
		Host:    s.SSHHost,
		Line:    line,
	}, nil
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

	var req openFileRequest
	if err := decodeBody(w, r, &req); err != nil {
		s.writeError(w, http.StatusBadRequest, err.Error())
		return
	}

	// Lexical path checks only — unlike file-write, opening a symlink target
	// in the user's own editor is harmless (read-only disclosure of a file
	// the user already has OS-level access to). cleaned feeds {relpath} so
	// the substituted value is canonical; mode-aware editorTemplate computes
	// {file} itself.
	cleaned, err := validateRepoRelativePath(req.Path)
	if err != nil {
		s.writeError(w, http.StatusBadRequest, err.Error())
		return
	}

	tmpl, sub, err := s.editorTemplate(cleaned, req.Line)
	if err != nil {
		s.writeError(w, http.StatusInternalServerError, "cannot read config")
		return
	}
	argv, err := buildEditorArgv(tmpl, sub)
	if err != nil {
		s.writeError(w, http.StatusBadRequest, err.Error())
		return
	}

	// exec.Command — the editor spawns on the machine where lightjj runs.
	// This is the documented invariant (docs/CONFIG.md): local mode → local
	// editor; port-forward → remote CLI helper (e.g. VS Code Server's `code`
	// which IPCs back to the laptop); --remote → local editor with SSH URI
	// (via editorArgsRemote + {host}/{file}). No fd inheritance, own session
	// (Setsid) so Ctrl+C on lightjj doesn't kill the editor.
	cmd := exec.Command(argv[0], argv[1:]...)
	cmd.Dir = s.RepoDir // empty in --remote mode → inherit cwd; editor doesn't care
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
