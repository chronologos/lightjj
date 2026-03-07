//go:build windows

package api

import "os/exec"

// detachProcess is a no-op on Windows — Setsid doesn't exist. The spawned
// editor will still outlive lightjj on normal exit; Ctrl+C delivery on
// Windows is process-scoped by default so the editor survives anyway.
func detachProcess(_ *exec.Cmd) {}
