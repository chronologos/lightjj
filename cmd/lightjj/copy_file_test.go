package main

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestCopyOver(t *testing.T) {
	dir := t.TempDir()
	src, dst := filepath.Join(dir, "src"), filepath.Join(dir, "dst")
	require.NoError(t, os.WriteFile(src, []byte("new\r\n\xff"), 0o600))
	require.NoError(t, os.WriteFile(dst, []byte("a much longer old content"), 0o640))
	require.NoError(t, copyOver(src, dst))
	got, err := os.ReadFile(dst)
	require.NoError(t, err)
	assert.Equal(t, "new\r\n\xff", string(got))
	fi, _ := os.Stat(dst)
	assert.Equal(t, os.FileMode(0o640), fi.Mode().Perm())

	assert.Error(t, copyOver(src, filepath.Join(dir, "missing")), "jj creates $output; anything else is a mistake")
	assert.NoFileExists(t, filepath.Join(dir, "missing"))
	assert.Error(t, copyOver(src, dir))
	link := filepath.Join(dir, "link")
	require.NoError(t, os.Symlink(dst, link))
	assert.Error(t, copyOver(src, link))
	assert.Error(t, copyOver(filepath.Join(dir, "nope"), dst))
}
