package main

// Diff-editor re-entry. When the server handles POST /api/split-hunks it
// invokes `jj split --tool lightjj-hunks --config-file <tmp.toml>`. jj then
// materializes $left/$right and re-invokes THIS BINARY as:
//
//   lightjj --apply-hunks=<spec.json> $left $right
//
// main() sees the --apply-hunks flag is non-empty, calls applyHunkSpec,
// and exits — no server startup. The spec was synthesized by the frontend
// (hunk-apply.ts); this file is a dumb writer. All patching logic stays in
// TS where diff-parser lives.

import (
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
)

type hunkSpecFile struct {
	Path    string `json:"path"`
	Action  string `json:"action"`            // write | revert | delete
	Content string `json:"content,omitempty"` // write only
}

type hunkSpec struct {
	Files []hunkSpecFile `json:"files"`
}

func applyHunkSpec(specPath, leftDir, rightDir string) error {
	raw, err := os.ReadFile(specPath)
	if err != nil {
		return fmt.Errorf("read spec: %w", err)
	}
	var spec hunkSpec
	if err := json.Unmarshal(raw, &spec); err != nil {
		return fmt.Errorf("parse spec: %w", err)
	}

	// Resolve once — rightDir itself might be a symlink (macOS /tmp → /private/tmp).
	// All per-file containment checks are against this.
	resolvedRight, err := filepath.EvalSymlinks(rightDir)
	if err != nil {
		return fmt.Errorf("resolve $right: %w", err)
	}

	for _, f := range spec.Files {
		// Reject escapes. Paths come from our own frontend (trusted boundary)
		// but the spec file sat in /tmp between write and read — defense in
		// depth against a local attacker racing the tmpfile. Clean collapses
		// ../; check Abs and that we didn't climb out.
		clean := filepath.Clean(f.Path)
		if filepath.IsAbs(clean) || clean == ".." ||
			len(clean) >= 3 && clean[:3] == ".."+string(filepath.Separator) {
			return fmt.Errorf("path escape: %q", f.Path)
		}

		right := filepath.Join(rightDir, clean)

		// Symlink escape: jj materializes tracked symlinks into $right as
		// real symlinks. A tracked `link → /etc/passwd` becomes a symlink in
		// $right; WriteFile follows it. Same pattern as local.go:WriteFile.
		// Parent check covers `a/link/b.go` where `link → /`; leaf check
		// covers `a/link.go` where `link.go → /etc/passwd`.
		if err := checkContained(right, resolvedRight); err != nil {
			return fmt.Errorf("%s: %w", f.Path, err)
		}

		switch f.Action {
		case "write":
			// $right/path exists (jj materialized the current tree) —
			// os.WriteFile truncates the inode, preserving its mode bits.
			// Verified: mode arg to WriteFile is ignored when file exists.
			// MkdirAll is defensive for the A+some case where we're writing
			// a partial new file — but jj materialized the full file in
			// $right already, so the dir exists. Keeping MkdirAll anyway:
			// cheap, and makes this function correct for direct tests that
			// don't mimic jj's full materialization.
			if err := os.MkdirAll(filepath.Dir(right), 0755); err != nil {
				return fmt.Errorf("mkdir for %s: %w", f.Path, err)
			}
			if err := os.WriteFile(right, []byte(f.Content), 0644); err != nil {
				return fmt.Errorf("write %s: %w", f.Path, err)
			}

		case "revert":
			// cp $left/path → $right/path. $right may lack the file (D+none
			// case: undo a deletion — jj removed it from $right). Preserve
			// $left's mode since we might be CREATING the target.
			left := filepath.Join(leftDir, clean)
			if err := copyPreserve(left, right); err != nil {
				return fmt.Errorf("revert %s: %w", f.Path, err)
			}

		case "delete":
			// A+none: don't add this file. jj put it in $right; we remove.
			// $left lacks it so revert isn't the right operation.
			if err := os.Remove(right); err != nil && !os.IsNotExist(err) {
				return fmt.Errorf("delete %s: %w", f.Path, err)
			}

		default:
			return fmt.Errorf("unknown action %q for %s", f.Action, f.Path)
		}
	}
	return nil
}

// checkContained verifies target doesn't escape root via symlinks. root must
// already be EvalSymlinks-resolved (callers resolve once, check per-file).
func checkContained(target, root string) error {
	parent := filepath.Dir(target)
	resolved, err := filepath.EvalSymlinks(parent)
	if err != nil {
		// Parent doesn't exist — can't be a symlink escape. MkdirAll later
		// creates it under rightDir with no opportunity for the link to
		// materialize. (D+none case where the whole dir was deleted.)
		if os.IsNotExist(err) {
			return nil
		}
		return err
	}
	sep := string(filepath.Separator)
	if resolved != root && !strings.HasPrefix(resolved+sep, root+sep) {
		return fmt.Errorf("parent escapes $right")
	}
	// Leaf: the file itself might be a symlink. Lstat not Stat — we want
	// to detect the link, not follow it.
	if fi, err := os.Lstat(target); err == nil && fi.Mode()&os.ModeSymlink != 0 {
		return fmt.Errorf("target is a symlink")
	}
	return nil
}

func copyPreserve(src, dst string) error {
	sf, err := os.Open(src)
	if err != nil {
		return err
	}
	defer sf.Close()

	fi, err := sf.Stat()
	if err != nil {
		return err
	}

	if err := os.MkdirAll(filepath.Dir(dst), 0755); err != nil {
		return err
	}
	// O_TRUNC: if dst exists (M+none — file present in both trees), truncate
	// keeps its mode; if not (D+none — restoring), O_CREATE uses fi.Mode().
	df, err := os.OpenFile(dst, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, fi.Mode())
	if err != nil {
		return err
	}
	if _, err := io.Copy(df, sf); err != nil {
		df.Close()
		return err
	}
	// Close can fail on fsync (disk full, NFS). The bytes hit the page cache
	// during Copy so the common case is durable regardless — but swallowing
	// this would mean a full-disk write looks successful and jj commits a
	// truncated file.
	return df.Close()
}
