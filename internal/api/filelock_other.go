//go:build !(darwin || linux || freebsd || netbsd || openbsd || dragonfly)

package api

import "os"

func tryLock(*os.File) error { return errLockUnsupported }
