package jj

import (
	"fmt"
	"regexp"
	"strconv"
)

// Semver is a parsed jj version (major, minor). Patch is dropped — jj ships
// features in minor releases. Named Semver not Version because Version() is the
// `jj --version` command builder.
type Semver [2]int

// MinVersion is the oldest supported jj. Builders may use anything it has without
// a fallback; CI runs the integration tests against it. To use something newer,
// raise it.
var MinVersion = Semver{0, 40}

func (v Semver) String() string { return fmt.Sprintf("%d.%d", v[0], v[1]) }

// CommitIdRevset pins `hex` to commit-id resolution — `commit_id(hex)` — so a
// tag or bookmark that happens to be named like a hex prefix can't shadow it
// (jj resolves bare symbols tag → bookmark → id).
func CommitIdRevset(hex string) string { return "commit_id(" + hex + ")" }

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

// TooOld reports whether `jj --version` output names an unsupported version.
// Unparseable output (a dev build) is given the benefit of the doubt.
func TooOld(version string) bool {
	v, ok := ParseSemver(version)
	return ok && !v.AtLeast(MinVersion)
}
