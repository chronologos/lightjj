package api

import (
	"errors"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"sync"
	"time"
)

// Cross-process half of the store locks. The in-process mutex of each store is
// taken first; this serializes its read-modify-write cycle against other lightjj
// processes sharing the same files.

// fileLockTimeout bounds the wait: a holder needs milliseconds, so anything longer is
// a stopped process, and a store must not hang with it. Var for tests.
var fileLockTimeout = 5 * time.Second

var (
	errLockBusy        = errors.New("locked by another process")
	errLockUnsupported = errors.New("file locks not supported here")

	lockUnsupportedOnce sync.Once
)

// lockFile takes an exclusive advisory lock on path (created if missing, never
// removed — unlinking a lock file lets two processes hold "the" lock). Where the
// platform or filesystem has no such locks it succeeds without one.
func lockFile(path string) (unlock func(), err error) {
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return nil, err
	}
	f, err := os.OpenFile(path, os.O_CREATE|os.O_RDWR, 0o600)
	if err != nil {
		return nil, err
	}
	deadline := time.Now().Add(fileLockTimeout)
	for {
		err = tryLock(f)
		if !errors.Is(err, errLockBusy) {
			break
		}
		if time.Now().After(deadline) {
			f.Close()
			return nil, fmt.Errorf("%s: %w", filepath.Base(path), err)
		}
		time.Sleep(10 * time.Millisecond)
	}
	if errors.Is(err, errLockUnsupported) {
		lockUnsupportedOnce.Do(func() { log.Printf("warning: %v (%s); other lightjj processes are not locked out", err, path) })
		err = nil
	}
	if err != nil {
		f.Close()
		return nil, err
	}
	return func() { f.Close() }, nil // closing releases the lock
}
