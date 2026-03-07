//go:build !windows

package api

import (
	"os/exec"
	"syscall"
)

// detachProcess gives the spawned editor its own session so Ctrl+C on
// lightjj (SIGINT to the process group) doesn't kill it.
func detachProcess(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
}
