package jj

import (
	"regexp"
	"strconv"
)

// Semver is a parsed jj version (major, minor). Patch is dropped — feature
// gates only care about minor releases (jj's feature cadence). Named Semver
// not Version because Version() is the `jj --version` command builder.
type Semver [2]int

// Feature gates. Each names the FIRST jj release that supports the capability.
// Backend handlers call s.jjSupports(ctx, jj.WorkspaceRootTmpl) to pick between
// a new codepath and a proven fallback. Keep this list small — only add an
// entry when the backend branches on it OR the frontend gates a UI affordance
// on it (see FeatureGates below).
var (
	// WorkspaceRootTmpl: WorkspaceRef.root() template method. Lets the
	// workspace-list template emit absolute paths directly, replacing the
	// hand-rolled protobuf parser of .jj/repo/workspace_store/index (which
	// is additive-only — pre-existing workspaces have no entry).
	WorkspaceRootTmpl = Semver{0, 40}

	// ChangedPathIndex: `jj debug index-changed-paths` (changed-path index
	// that makes files() revsets fast; the IndexChangedPaths command builder
	// in commands.go invokes it). The backend exposes it unconditionally via
	// POST /api/index-paths; the frontend gates the "load full history"
	// affordance on it.
	ChangedPathIndex = Semver{0, 30}
)

// FeatureGates is the wire-facing gate registry: GET /api/info resolves every
// entry through Server.jjSupports (PESSIMISTIC — unknown version reports
// false) and ships the booleans as the "features" map. The frontend reads
// those booleans instead of keeping its own version table, so this map is the
// single authority on minimum versions. Keys are a wire contract with
// frontend jjSupports(name) — don't rename them.
var FeatureGates = map[string]Semver{
	"workspaceRootTmpl": WorkspaceRootTmpl,
	"indexChangedPaths": ChangedPathIndex,
}

var versionRe = regexp.MustCompile(`(\d+)\.(\d+)`)

// ParseSemver extracts (major, minor) from `jj --version` output, e.g.
// "jj 0.39.0" → {0,39}. Tolerates suffixes like "-nightly+abc" (regex anchors
// on the first N.N). Second return is false on no match.
func ParseSemver(s string) (Semver, bool) {
	m := versionRe.FindStringSubmatch(s)
	if m == nil {
		return Semver{}, false
	}
	maj, _ := strconv.Atoi(m[1])
	min, _ := strconv.Atoi(m[2])
	return Semver{maj, min}, true
}

// AtLeast reports whether v >= min.
func (v Semver) AtLeast(min Semver) bool {
	return v[0] > min[0] || (v[0] == min[0] && v[1] >= min[1])
}
