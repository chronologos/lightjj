package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

// Fixture builder: writes a mini $left/$right tree pair under t.TempDir().
// jj materializes only the CHANGED files into these dirs (not the whole
// repo tree), so fixtures are small.
type tree map[string]string // path → content; "" value = file absent

func mkTree(t *testing.T, root string, files tree) {
	t.Helper()
	// jj always creates $left/ and $right/ even when one side is empty
	// (D+none materializes an empty $right, A+none an empty $left). Tests
	// with only-absent files ({"f": ""}) still need the root to exist —
	// EvalSymlinks(rightDir) fails otherwise.
	if err := os.MkdirAll(root, 0755); err != nil {
		t.Fatal(err)
	}
	for path, content := range files {
		if content == "" {
			continue // "absent" sentinel — don't create
		}
		full := filepath.Join(root, path)
		if err := os.MkdirAll(filepath.Dir(full), 0755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(full, []byte(content), 0644); err != nil {
			t.Fatal(err)
		}
	}
}

func writeSpec(t *testing.T, files []hunkSpecFile) string {
	t.Helper()
	f, err := os.CreateTemp(t.TempDir(), "spec-*.json")
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	if err := json.NewEncoder(f).Encode(hunkSpec{Files: files}); err != nil {
		t.Fatal(err)
	}
	return f.Name()
}

func readFile(t *testing.T, path string) string {
	t.Helper()
	b, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read %s: %v", path, err)
	}
	return string(b)
}

func assertAbsent(t *testing.T, path string) {
	t.Helper()
	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Fatalf("expected %s absent, got err=%v", path, err)
	}
}

// ─── Action × tree-shape decision table ──────────────────────────────────────
// Mirrors the TS planHunkSpec table but from the Go tool's perspective: given
// a spec action + the $left/$right shape jj would materialize, verify $right
// ends up in the expected state. This is the table a future reader checks
// when jj's materialization behavior changes.

func TestApplyHunkSpec_Actions(t *testing.T) {
	type row struct {
		name       string
		left       tree // what jj puts in $left
		right      tree // what jj puts in $right
		action     hunkSpecFile
		wantRight  string // expected $right/f content after; "" = absent
		wantAbsent bool
	}

	table := []row{
		{
			name:   "write M+some — overwrite $right with synthesized content",
			left:   tree{"f": "a\nb\nc\n"},
			right:  tree{"f": "a\nBB\nCC\n"}, // full change
			action: hunkSpecFile{Path: "f", Action: "write", Content: "a\nBB\nc\n"}, // partial: BB yes, CC no
			// The Go tool doesn't look at $left for `write` — content is
			// pre-synthesized by applyHunks() in TS. $left is there for `revert`.
			wantRight: "a\nBB\nc\n",
		},
		{
			name:      "revert M+none — cp $left → $right (both exist, overwrite)",
			left:      tree{"f": "old\n"},
			right:     tree{"f": "new\n"},
			action:    hunkSpecFile{Path: "f", Action: "revert"},
			wantRight: "old\n",
		},
		{
			name: "revert D+none — undo deletion: $right LACKS the file, $left has it",
			// This is the case where copyPreserve CREATES $right/f. Mode comes
			// from $left/f's stat — jj preserves the committed mode there.
			left:      tree{"f": "resurrected\n"},
			right:     tree{"f": ""}, // absent — jj materialized the deletion
			action:    hunkSpecFile{Path: "f", Action: "revert"},
			wantRight: "resurrected\n",
		},
		{
			name: "delete A+none — don't add: $right has it, $left doesn't",
			left:       tree{"f": ""}, // absent — file is NEW
			right:      tree{"f": "brand-new\n"},
			action:     hunkSpecFile{Path: "f", Action: "delete"},
			wantAbsent: true,
		},
		{
			name: "delete is idempotent — already-absent doesn't error",
			// Shouldn't happen in practice (spec comes from our frontend which
			// only emits `delete` for A+none where $right HAS the file) but
			// os.IsNotExist guard makes re-runs safe.
			left:       tree{"f": ""},
			right:      tree{"f": ""},
			action:     hunkSpecFile{Path: "f", Action: "delete"},
			wantAbsent: true,
		},
	}

	for _, tc := range table {
		t.Run(tc.name, func(t *testing.T) {
			dir := t.TempDir()
			leftDir := filepath.Join(dir, "left")
			rightDir := filepath.Join(dir, "right")
			mkTree(t, leftDir, tc.left)
			mkTree(t, rightDir, tc.right)

			spec := writeSpec(t, []hunkSpecFile{tc.action})
			if err := applyHunkSpec(spec, leftDir, rightDir); err != nil {
				t.Fatalf("applyHunkSpec: %v", err)
			}

			target := filepath.Join(rightDir, "f")
			if tc.wantAbsent {
				assertAbsent(t, target)
			} else {
				if got := readFile(t, target); got != tc.wantRight {
					t.Errorf("$right/f\n got: %q\nwant: %q", got, tc.wantRight)
				}
			}
		})
	}
}

func TestApplyHunkSpec_Subdirs(t *testing.T) {
	// Paths preserve directory structure. jj materializes $left/src/x.go and
	// $right/src/x.go — not flattened. The MkdirAll in `write` and
	// copyPreserve handles the case where revert needs to CREATE src/ in
	// $right (whole-dir deletion being undone).
	dir := t.TempDir()
	leftDir := filepath.Join(dir, "left")
	rightDir := filepath.Join(dir, "right")
	mkTree(t, leftDir, tree{"src/a/b.go": "left\n"})
	// right has NO src/ dir at all — simulates "jj commit deleted src/a/b.go
	// and it was the only file in src/a/"
	os.MkdirAll(rightDir, 0755)

	spec := writeSpec(t, []hunkSpecFile{{Path: "src/a/b.go", Action: "revert"}})
	if err := applyHunkSpec(spec, leftDir, rightDir); err != nil {
		t.Fatalf("applyHunkSpec: %v", err)
	}
	if got := readFile(t, filepath.Join(rightDir, "src/a/b.go")); got != "left\n" {
		t.Errorf("got %q", got)
	}
}

func TestApplyHunkSpec_RevertPreservesMode_Create(t *testing.T) {
	// The CREATE path (D+none — file absent in $right, copyPreserve makes
	// it). O_CREATE uses fi.Mode() from $left's stat. If that arg were
	// dropped, restored executables lose +x — jj commits a script that
	// won't run. TestApplyHunkSpec_PreservesMode covers the TRUNCATE path;
	// this covers the CREATE path.
	dir := t.TempDir()
	leftDir := filepath.Join(dir, "left")
	rightDir := filepath.Join(dir, "right")
	os.MkdirAll(leftDir, 0755)
	os.MkdirAll(rightDir, 0755)
	os.WriteFile(filepath.Join(leftDir, "run.sh"), []byte("#!/bin/sh\n"), 0755)
	// $right intentionally has no run.sh — commit deleted it

	spec := writeSpec(t, []hunkSpecFile{{Path: "run.sh", Action: "revert"}})
	if err := applyHunkSpec(spec, leftDir, rightDir); err != nil {
		t.Fatal(err)
	}

	fi, err := os.Stat(filepath.Join(rightDir, "run.sh"))
	if err != nil {
		t.Fatal(err)
	}
	if fi.Mode().Perm() != 0755 {
		t.Errorf("mode = %v, want 0755 (O_CREATE should use $left's mode)", fi.Mode().Perm())
	}
}

func TestApplyHunkSpec_SymlinkEscape(t *testing.T) {
	// jj materializes tracked symlinks into $right as real symlinks. A
	// tracked `link → /tmp/escape` becomes a real link; WriteFile follows.
	// checkContained rejects before the write.
	dir := t.TempDir()
	rightDir := filepath.Join(dir, "right")
	os.MkdirAll(rightDir, 0755)

	escapeDir := t.TempDir()
	escapeTarget := filepath.Join(escapeDir, "victim")
	os.WriteFile(escapeTarget, []byte("original"), 0644)

	t.Run("leaf symlink", func(t *testing.T) {
		os.Symlink(escapeTarget, filepath.Join(rightDir, "leaf"))
		spec := writeSpec(t, []hunkSpecFile{{Path: "leaf", Action: "write", Content: "pwned"}})
		err := applyHunkSpec(spec, dir, rightDir)
		if err == nil {
			t.Fatal("expected symlink error")
		}
		if got, _ := os.ReadFile(escapeTarget); string(got) != "original" {
			t.Fatalf("escape target was modified: %q", got)
		}
	})

	t.Run("parent-dir symlink", func(t *testing.T) {
		os.Symlink(escapeDir, filepath.Join(rightDir, "linkdir"))
		spec := writeSpec(t, []hunkSpecFile{{Path: "linkdir/victim", Action: "write", Content: "pwned"}})
		err := applyHunkSpec(spec, dir, rightDir)
		if err == nil {
			t.Fatal("expected parent-escape error")
		}
		if got, _ := os.ReadFile(escapeTarget); string(got) != "original" {
			t.Fatalf("escape target was modified: %q", got)
		}
	})
}

func TestApplyHunkSpec_TSContract(t *testing.T) {
	// Cross-language JSON contract pin. The TS `SpecAction` union and Go
	// `hunkSpecFile` share JSON key names ONLY by convention (TS property
	// name == Go `json:"..."` tag). If either side renames (action→op,
	// content→body), Go tests that construct `hunkSpecFile` structs directly
	// still pass — the drift shows up at runtime as "unknown action".
	// This test feeds a TS-SHAPED literal JSON blob, the exact bytes
	// `JSON.stringify(resolvePlan(...))` produces.
	dir := t.TempDir()
	leftDir := filepath.Join(dir, "left")
	rightDir := filepath.Join(dir, "right")
	mkTree(t, leftDir, tree{"r.txt": "L\n"})
	mkTree(t, rightDir, tree{"w.txt": "OLD\n", "r.txt": "R\n", "d.txt": "X\n"})

	// Exact output shape of hunk-apply.ts resolvePlan — all three action
	// variants in one spec. If you change a key name in SpecAction, update
	// this literal AND the Go struct tag.
	tsShaped := `{"files":[` +
		`{"path":"w.txt","action":"write","content":"NEW\n"},` +
		`{"path":"r.txt","action":"revert"},` +
		`{"path":"d.txt","action":"delete"}]}`

	specPath := filepath.Join(t.TempDir(), "ts.json")
	os.WriteFile(specPath, []byte(tsShaped), 0600)

	if err := applyHunkSpec(specPath, leftDir, rightDir); err != nil {
		t.Fatalf("TS-shaped JSON failed: %v — SpecAction/hunkSpecFile key drift?", err)
	}
	if got := readFile(t, filepath.Join(rightDir, "w.txt")); got != "NEW\n" {
		t.Errorf("write: got %q", got)
	}
	if got := readFile(t, filepath.Join(rightDir, "r.txt")); got != "L\n" {
		t.Errorf("revert: got %q", got)
	}
	assertAbsent(t, filepath.Join(rightDir, "d.txt"))
}

func TestApplyHunkSpec_PreservesMode(t *testing.T) {
	// The O_TRUNC-preserves-mode behavior is the reason `write` doesn't
	// stat $right first. Verified empirically; pin it so a Go stdlib change
	// doesn't silently break executable bits on scripts.
	dir := t.TempDir()
	rightDir := filepath.Join(dir, "right")
	os.MkdirAll(rightDir, 0755)
	target := filepath.Join(rightDir, "script.sh")
	os.WriteFile(target, []byte("#!/bin/sh\necho old\n"), 0755)

	spec := writeSpec(t, []hunkSpecFile{{
		Path: "script.sh", Action: "write", Content: "#!/bin/sh\necho new\n",
	}})
	if err := applyHunkSpec(spec, dir, rightDir); err != nil {
		t.Fatal(err)
	}

	fi, _ := os.Stat(target)
	if fi.Mode().Perm() != 0755 {
		t.Errorf("mode = %v, want 0755", fi.Mode().Perm())
	}
	if got := readFile(t, target); got != "#!/bin/sh\necho new\n" {
		t.Errorf("content = %q", got)
	}
}

func TestApplyHunkSpec_PathEscape(t *testing.T) {
	// Spec file sits in /tmp between handler-write and jj-invoke. A local
	// attacker could swap it. We trust our own frontend but not the
	// filesystem gap.
	cases := []string{
		"../etc/passwd",
		"/etc/passwd",
		"a/../../etc/passwd",
	}
	for _, bad := range cases {
		t.Run(bad, func(t *testing.T) {
			dir := t.TempDir()
			spec := writeSpec(t, []hunkSpecFile{{Path: bad, Action: "delete"}})
			err := applyHunkSpec(spec, dir, dir)
			if err == nil {
				t.Fatal("expected path-escape error")
			}
		})
	}
}

func TestApplyHunkSpec_UnknownAction(t *testing.T) {
	dir := t.TempDir()
	spec := writeSpec(t, []hunkSpecFile{{Path: "f", Action: "chmod"}})
	if err := applyHunkSpec(spec, dir, dir); err == nil {
		t.Fatal("expected error for unknown action")
	}
}

func TestApplyHunkSpec_MultipleFiles(t *testing.T) {
	// Order-independent: each action is self-contained. jj commits the
	// whole $right tree atomically after tool exit, so within-tool ordering
	// doesn't matter for correctness — only for error-attribution (first
	// failure stops the loop, later actions don't run).
	dir := t.TempDir()
	leftDir := filepath.Join(dir, "left")
	rightDir := filepath.Join(dir, "right")
	mkTree(t, leftDir, tree{"keep.go": "L\n", "revert.go": "L\n"})
	mkTree(t, rightDir, tree{"keep.go": "R\n", "revert.go": "R\n", "rm.go": "R\n"})

	spec := writeSpec(t, []hunkSpecFile{
		{Path: "keep.go", Action: "write", Content: "W\n"},
		{Path: "revert.go", Action: "revert"},
		{Path: "rm.go", Action: "delete"},
	})
	if err := applyHunkSpec(spec, leftDir, rightDir); err != nil {
		t.Fatal(err)
	}

	if got := readFile(t, filepath.Join(rightDir, "keep.go")); got != "W\n" {
		t.Errorf("keep.go = %q", got)
	}
	if got := readFile(t, filepath.Join(rightDir, "revert.go")); got != "L\n" {
		t.Errorf("revert.go = %q", got)
	}
	assertAbsent(t, filepath.Join(rightDir, "rm.go"))
}
