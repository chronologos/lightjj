//go:build darwin || linux || freebsd || netbsd || openbsd || dragonfly

package api

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestLockFile_BusyThenReleased(t *testing.T) {
	defer func(d time.Duration) { fileLockTimeout = d }(fileLockTimeout)
	fileLockTimeout = 50 * time.Millisecond
	path := filepath.Join(t.TempDir(), "sub", ".lock")

	unlock, err := lockFile(path)
	require.NoError(t, err)
	// A second open file description conflicts even within one process.
	_, err = lockFile(path)
	require.ErrorIs(t, err, errLockBusy)

	unlock()
	unlock, err = lockFile(path)
	require.NoError(t, err)
	unlock()
	assert.FileExists(t, path, "never unlinked")
}

// A busy store answers with an error and leaves the file alone.
func TestJSONCollection_LockedByAnotherProcess(t *testing.T) {
	defer func(d time.Duration) { fileLockTimeout = d }(fileLockTimeout)
	fileLockTimeout = 50 * time.Millisecond
	c, dir := newTestCollection(t)
	_, err := c.Upsert("k", storeItem{ID: "a"})
	require.NoError(t, err)
	unlock, err := lockFile(filepath.Join(dir, storeLockName))
	require.NoError(t, err)
	defer unlock()

	_, err = c.Upsert("k", storeItem{ID: "b"})
	assert.ErrorContains(t, err, "locked by another process")
	assert.Error(t, c.Delete("k", "a"))
	assert.Error(t, c.DeleteAll("k"))
	items, err := c.List("k") // reads don't need it: writes are atomic renames
	require.NoError(t, err)
	assert.Len(t, items, 1)
}

const (
	lockTestDir  = "LIGHTJJ_LOCK_TEST_DIR"
	lockTestName = "LIGHTJJ_LOCK_TEST_NAME"
	lockTestN    = 25
)

// Real processes, each with its own mutex: without the file lock they lose each
// other's records.
func TestStores_ConcurrentProcesses(t *testing.T) {
	if dir := os.Getenv(lockTestDir); dir != "" { // child
		c := &jsonCollection[storeItem]{pathFor: func(k string) (string, error) { return filepath.Join(dir, k+".json"), nil }}
		userConfigDir = func() (string, error) { return dir, nil }
		for i := range lockTestN {
			id := fmt.Sprintf("%s-%d", os.Getenv(lockTestName), i)
			_, err := c.Upsert("k", storeItem{ID: id})
			require.NoError(t, err)
			require.NoError(t, AddOpenTab(PersistedTab{Path: "/" + id, Mode: "local"}))
		}
		return
	}

	dir := t.TempDir()
	exe, err := os.Executable()
	require.NoError(t, err)
	const procs = 4
	cmds := make([]*exec.Cmd, procs)
	for i := range cmds {
		cmds[i] = exec.Command(exe, "-test.run=^TestStores_ConcurrentProcesses$")
		cmds[i].Env = append(os.Environ(), lockTestDir+"="+dir, fmt.Sprintf("%s=p%d", lockTestName, i))
		require.NoError(t, cmds[i].Start())
	}
	for _, cmd := range cmds {
		require.NoError(t, cmd.Wait())
	}

	c := &jsonCollection[storeItem]{pathFor: func(k string) (string, error) { return filepath.Join(dir, k+".json"), nil }}
	items, err := c.List("k")
	require.NoError(t, err)
	assert.Len(t, items, procs*lockTestN)
	orig := userConfigDir
	userConfigDir = func() (string, error) { return dir, nil }
	defer func() { userConfigDir = orig }()
	assert.Len(t, ReadPersistedTabs(), procs*lockTestN)
}
