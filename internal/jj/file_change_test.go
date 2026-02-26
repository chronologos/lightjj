package jj

import (
	"testing"

	"github.com/stretchr/testify/assert"
)

func TestParseDiffStat_BinaryFiles(t *testing.T) {
	// Binary files show 0 with no +/- bar
	output := " icon.png | 0\n image.jpg | 0\n 1 file changed\n"
	stats := ParseDiffStat(output)
	// Binary files don't match statLineRe (no +/- bar), so they're not in the map
	assert.Len(t, stats, 0)
}

func TestParseDiffStat_Normal(t *testing.T) {
	output := " main.go    | 15 +++++++++------\n config.go  | 3 +++\n 2 files changed, 12 insertions(+), 6 deletions(-)\n"
	stats := ParseDiffStat(output)
	assert.Len(t, stats, 2)

	mainStat := stats["main.go"]
	assert.Equal(t, 9, mainStat.Additions)
	assert.Equal(t, 6, mainStat.Deletions)

	cfgStat := stats["config.go"]
	assert.Equal(t, 3, cfgStat.Additions)
	assert.Equal(t, 0, cfgStat.Deletions)
}

func TestParseDiffStat_Rename(t *testing.T) {
	output := " {old.go => new.go} | 5 ++---\n 1 file changed\n"
	stats := ParseDiffStat(output)
	assert.Len(t, stats, 1)
	_, ok := stats["new.go"]
	assert.True(t, ok, "should use destination path from rename")
}

func TestParseDiffStat_EmptyInput(t *testing.T) {
	stats := ParseDiffStat("")
	assert.Len(t, stats, 0)
}

func TestParseDiffSummary_Normal(t *testing.T) {
	output := "M src/main.go\nA new_file.go\nD old_file.go\n"
	changes := ParseDiffSummary(output)
	assert.Len(t, changes, 3)
	assert.Equal(t, "M", changes[0].Type)
	assert.Equal(t, "src/main.go", changes[0].Path)
	assert.Equal(t, "A", changes[1].Type)
	assert.Equal(t, "D", changes[2].Type)
}

func TestParseDiffSummary_EmptyInput(t *testing.T) {
	changes := ParseDiffSummary("")
	assert.Len(t, changes, 0)
}

func TestMergeStats_SuffixFallback(t *testing.T) {
	files := []FileChange{{Type: "M", Path: "very/long/path/file.go"}}
	stats := map[string]FileStat{"...path/file.go": {Additions: 10, Deletions: 5}}
	MergeStats(files, stats)
	assert.Equal(t, 10, files[0].Additions)
	assert.Equal(t, 5, files[0].Deletions)
}

func TestMergeStats_NoMatch(t *testing.T) {
	files := []FileChange{{Type: "M", Path: "src/main.go"}}
	stats := map[string]FileStat{"other.go": {Additions: 10, Deletions: 5}}
	MergeStats(files, stats)
	assert.Equal(t, 0, files[0].Additions)
	assert.Equal(t, 0, files[0].Deletions)
}

func TestMergeConflicts_AppendsMissing(t *testing.T) {
	files := []FileChange{{Type: "M", Path: "a.go"}}
	result := MergeConflicts(files, []string{"a.go", "b.go"})
	assert.Len(t, result, 2)
	assert.True(t, result[0].Conflict)
	assert.True(t, result[1].Conflict)
	assert.Equal(t, "b.go", result[1].Path)
	assert.Equal(t, "M", result[1].Type, "appended conflict files should default to M type")
}

func TestMergeConflicts_Empty(t *testing.T) {
	files := []FileChange{{Type: "M", Path: "a.go"}}
	result := MergeConflicts(files, nil)
	assert.Len(t, result, 1)
	assert.False(t, result[0].Conflict)
}

func TestParseResolveList_Normal(t *testing.T) {
	output := "src/main.go    2-sided conflict\nlib/util.go    2-sided conflict\n"
	paths := ParseResolveList(output)
	assert.Equal(t, []string{"src/main.go", "lib/util.go"}, paths)
}

func TestParseResolveList_WithConflictTypes(t *testing.T) {
	// Ensure we handle different conflict type descriptions
	output := "src/main.go    2-sided conflict\nlib/util.go    3-sided conflict including 1 deletion\n"
	paths := ParseResolveList(output)
	assert.Equal(t, []string{"src/main.go", "lib/util.go"}, paths)
}
