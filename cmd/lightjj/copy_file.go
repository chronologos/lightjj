package main

import (
	"fmt"
	"os"
)

// copyOver replaces the contents of the existing regular file dst with src's.
// Called by jj (see jj.ResolveApply), which has just created dst.
func copyOver(src, dst string) error {
	fi, err := os.Lstat(dst)
	if err != nil {
		return err
	}
	if !fi.Mode().IsRegular() {
		return fmt.Errorf("%s is not a regular file", dst)
	}
	data, err := os.ReadFile(src)
	if err != nil {
		return err
	}
	return os.WriteFile(dst, data, fi.Mode().Perm())
}
