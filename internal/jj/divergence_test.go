package jj

import (
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
)

func TestDivergence(t *testing.T) {
	got := Divergence()
	assert.Equal(t, "log", got[0])
	assert.Contains(t, got, "(divergent() & mutable())::")
	assert.Contains(t, got, "--no-graph")
	assert.Contains(t, got, "--ignore-working-copy")
	// Template is the last arg after -T
	tmpl := got[len(got)-1]
	assert.Contains(t, tmpl, `contained_in("::working_copies()")`)
	assert.Contains(t, tmpl, `local_bookmarks`)
	assert.Contains(t, tmpl, `current_working_copy`)
	assert.NotContains(t, tmpl, `committer.timestamp`) // doc §"Failed heuristics" — don't add back
	// 10 fields = 9 separators
	assert.Equal(t, 9, strings.Count(tmpl, `"\x1F"`))
}

func TestParseDivergence(t *testing.T) {
	// 2 divergent versions of one change + 1 non-divergent pinning child.
	// /0 is WC-reachable with a bookmark, /1 is stale, child is empty.
	output := strings.Join([]string{
		// /0: live, bookmarked, non-empty, not @ itself (wc_reachable via descendant)
		"xyzabcde\x1F1db4ac84\x1F1\x1F58fd0b2d\x1Fppparent\x1F1\x1Fmy-feature\x1Fauth status\x1F\x1F",
		// /1: stale, no bookmark, non-empty
		"xyzabcde\x1Ff9eb6a69\x1F1\x1Fc4cc6bfc\x1Fppparent\x1F\x1F\x1Fauth status\x1F\x1F",
		// pinning child: not divergent, empty (safe-abandon case)
		"warmmerg\x1Fe3b51f8b\x1F\x1Fe479d0f0\x1Ftipchild\x1F\x1F\x1FMerge warm\x1F1\x1F",
		"", // trailing newline
	}, "\n")

	got := ParseDivergence(output)
	assert.Len(t, got, 3)

	assert.Equal(t, "xyzabcde", got[0].ChangeId)
	assert.Equal(t, "1db4ac84", got[0].CommitId)
	assert.True(t, got[0].Divergent)
	assert.Equal(t, []string{"58fd0b2d"}, got[0].ParentCommitIds)
	assert.Equal(t, []string{"ppparent"}, got[0].ParentChangeIds)
	assert.True(t, got[0].WCReachable)
	assert.Equal(t, []string{"my-feature"}, got[0].Bookmarks)
	assert.Equal(t, "auth status", got[0].Description)
	assert.False(t, got[0].Empty)

	assert.False(t, got[1].WCReachable)
	assert.Equal(t, []string{}, got[1].Bookmarks) // empty, not [""]

	assert.False(t, got[2].Divergent)
	assert.True(t, got[2].Empty)
	assert.False(t, got[0].IsWorkingCopy) // wc_reachable but @ is elsewhere
}

func TestParseDivergence_IsWorkingCopy(t *testing.T) {
	// @ is ON this divergent commit (user jj edit'd into it) — the tautology
	// trigger. wc_reachable=1 is trivially true; is_working_copy=1 distinguishes.
	output := "X\x1Fabc\x1F1\x1Fp\x1Fpc\x1F1\x1F\x1F\x1F\x1F1\n"
	got := ParseDivergence(output)
	assert.True(t, got[0].WCReachable)
	assert.True(t, got[0].IsWorkingCopy)
}

func TestParseDivergence_PreservesOrder(t *testing.T) {
	// Order = jj's index emission = /N offsets. Must NOT sort.
	// Deliberately emit commit_ids out of lex order.
	output := "X\x1Fzzz\x1F1\x1Fp\x1Fq\x1F\x1F\x1F\x1F\x1F\n" +
		"X\x1Faaa\x1F1\x1Fp\x1Fq\x1F\x1F\x1F\x1F\x1F\n"
	got := ParseDivergence(output)
	assert.Equal(t, "zzz", got[0].CommitId) // NOT sorted to aaa first
	assert.Equal(t, "aaa", got[1].CommitId)
}

func TestParseDivergence_MergeCommit(t *testing.T) {
	// Divergent merges: parents.map().join(",") → multi-element arrays.
	output := "M\x1Fabc\x1F1\x1Fp1,p2\x1Fpc1,pc2\x1F\x1F\x1F\x1F\x1F\n"
	got := ParseDivergence(output)
	assert.Equal(t, []string{"p1", "p2"}, got[0].ParentCommitIds)
	assert.Equal(t, []string{"pc1", "pc2"}, got[0].ParentChangeIds)
}

func TestParseDivergence_Empty(t *testing.T) {
	// No divergence in repo → empty revset → empty output. Must be [] not nil
	// so JSON serialization gives [] not null.
	got := ParseDivergence("")
	assert.NotNil(t, got)
	assert.Len(t, got, 0)
}

func TestParseDivergence_MalformedLine(t *testing.T) {
	// 9 fields instead of 10 → skipped, doesn't kill the good line.
	output := "bad\x1Ftoo\x1Ffew\n" +
		"G\x1Fgood\x1F1\x1Fp\x1Fq\x1F\x1F\x1F\x1F\x1F\n"
	got := ParseDivergence(output)
	assert.Len(t, got, 1)
	assert.Equal(t, "good", got[0].CommitId)
}

func TestSplitNonEmpty(t *testing.T) {
	assert.Equal(t, []string{}, splitNonEmpty("", ","))
	assert.Equal(t, []string{"a"}, splitNonEmpty("a", ","))
	assert.Equal(t, []string{"a", "b"}, splitNonEmpty("a,b", ","))
}
