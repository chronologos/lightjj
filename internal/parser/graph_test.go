package parser

import (
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestParseGraphLog_LinearHistory(t *testing.T) {
	output := "@  _PREFIX:o_PREFIX:20_PREFIX:false\x1foysoxutx\x1f20eb6a12\x1fmy commit\x1fmain\n" +
		"○  _PREFIX:r_PREFIX:f_PREFIX:false\x1frrrtptvx\x1ff766300c\x1fui v1\x1f\n" +
		"○  _PREFIX:m_PREFIX:b_PREFIX:false\x1fmwoxvszn\x1fb6a3ed01\x1fport jjui golang code\x1f\n" +
		"◆  _PREFIX:z_PREFIX:0_PREFIX:false\x1fzzzzzzzz\x1f00000000\x1f\x1f\n"

	rows := ParseGraphLog(output)
	require.Len(t, rows, 4)

	assert.Equal(t, "oysoxutx", rows[0].Commit.ChangeId)
	assert.Equal(t, "20eb6a12", rows[0].Commit.CommitId)
	assert.Equal(t, 1, rows[0].Commit.ChangePrefix) // "o" = 1 char
	assert.Equal(t, 2, rows[0].Commit.CommitPrefix)  // "20" = 2 chars
	assert.True(t, rows[0].Commit.IsWorkingCopy)
	assert.Equal(t, "my commit", rows[0].Description)
	assert.Equal(t, []string{"main"}, rows[0].Bookmarks)

	assert.Equal(t, "rrrtptvx", rows[1].Commit.ChangeId)
	assert.Equal(t, 1, rows[1].Commit.ChangePrefix)
	assert.False(t, rows[1].Commit.IsWorkingCopy)
	assert.Equal(t, "ui v1", rows[1].Description)

	assert.Equal(t, "zzzzzzzz", rows[3].Commit.ChangeId)
	assert.False(t, rows[3].Commit.IsWorkingCopy)
}

func TestParseGraphLog_WithBranches(t *testing.T) {
	output := "@  _PREFIX:o_PREFIX:20_PREFIX:false\x1foysoxutx\x1f20eb6a12\x1f\x1f\n" +
		"│\n" +
		"│ ○  _PREFIX:q_PREFIX:5_PREFIX:false\x1fqlpymtvq\x1f50dbf764\x1f\x1f\n" +
		"├─╯\n" +
		"○  _PREFIX:r_PREFIX:f_PREFIX:false\x1frrrtptvx\x1ff766300c\x1fui v1\x1f\n" +
		"○  _PREFIX:m_PREFIX:b_PREFIX:false\x1fmwoxvszn\x1fb6a3ed01\x1fport jjui golang code\x1f\n" +
		"◆  _PREFIX:z_PREFIX:0_PREFIX:false\x1fzzzzzzzz\x1f00000000\x1f\x1f\n"

	rows := ParseGraphLog(output)
	require.Len(t, rows, 5)

	assert.Equal(t, "oysoxutx", rows[0].Commit.ChangeId)
	assert.True(t, rows[0].Commit.IsWorkingCopy)
	assert.Len(t, rows[0].GraphLines, 2)

	assert.Equal(t, "qlpymtvq", rows[1].Commit.ChangeId)
	assert.False(t, rows[1].Commit.IsWorkingCopy)
	assert.Len(t, rows[1].GraphLines, 2)

	assert.Equal(t, "rrrtptvx", rows[2].Commit.ChangeId)
	assert.Equal(t, "ui v1", rows[2].Description)
}

func TestParseGraphLog_MergeCommit(t *testing.T) {
	output := "@    _PREFIX:x_PREFIX:2b_PREFIX:false\x1fxsrvltkl\x1f2b52f01c\x1f\x1f\n" +
		"├─╮\n" +
		"│ ○  _PREFIX:q_PREFIX:5_PREFIX:false\x1fqlpymtvq\x1f50dbf764\x1f\x1f\n" +
		"│ │\n" +
		"○ │  _PREFIX:o_PREFIX:20_PREFIX:false\x1foysoxutx\x1f20eb6a12\x1f\x1f\n" +
		"├─╯\n" +
		"○  _PREFIX:r_PREFIX:f_PREFIX:false\x1frrrtptvx\x1ff766300c\x1fui v1\x1f\n"

	rows := ParseGraphLog(output)
	require.Len(t, rows, 4)

	assert.Equal(t, "xsrvltkl", rows[0].Commit.ChangeId)
	assert.True(t, rows[0].Commit.IsWorkingCopy)
	assert.Len(t, rows[0].GraphLines, 2)

	assert.Equal(t, "qlpymtvq", rows[1].Commit.ChangeId)
	assert.Len(t, rows[1].GraphLines, 2)

	assert.Equal(t, "oysoxutx", rows[2].Commit.ChangeId)
	assert.Len(t, rows[2].GraphLines, 2)
}

func TestParseGraphLog_WorkingCopyDetection(t *testing.T) {
	output := "○  _PREFIX:a_PREFIX:1_PREFIX:false\x1faaaaaaaa\x1f11111111\x1f\x1f\n" +
		"@  _PREFIX:b_PREFIX:2_PREFIX:false\x1fbbbbbbbb\x1f22222222\x1f\x1f\n" +
		"○  _PREFIX:c_PREFIX:3_PREFIX:false\x1fcccccccc\x1f33333333\x1f\x1f\n"

	rows := ParseGraphLog(output)
	require.Len(t, rows, 3)

	assert.False(t, rows[0].Commit.IsWorkingCopy)
	assert.True(t, rows[1].Commit.IsWorkingCopy)
	assert.False(t, rows[2].Commit.IsWorkingCopy)
}

func TestParseGraphLog_PrefixLength(t *testing.T) {
	output := "@  _PREFIX:xy_PREFIX:abc_PREFIX:false\x1fxyzwvuts\x1fabcdef12\x1ftest\x1f\n"
	rows := ParseGraphLog(output)
	require.Len(t, rows, 1)

	assert.Equal(t, "xyzwvuts", rows[0].Commit.ChangeId)
	assert.Equal(t, 2, rows[0].Commit.ChangePrefix)  // "xy" = 2
	assert.Equal(t, 3, rows[0].Commit.CommitPrefix)   // "abc" = 3
}

func TestParseGraphLog_ImmutableAndConflict(t *testing.T) {
	output := "×  _PREFIX:k_PREFIX:9_PREFIX:false\x1fkkkkkkkk\x1f99999999\x1f\x1f\n" +
		"◆  _PREFIX:z_PREFIX:0_PREFIX:false\x1fzzzzzzzz\x1f00000000\x1f\x1f\n"

	rows := ParseGraphLog(output)
	require.Len(t, rows, 2)

	assert.True(t, rows[0].GraphLines[0].IsNode)
	assert.True(t, rows[1].GraphLines[0].IsNode)
}

func TestParseGraphLog_BookmarksMultiple(t *testing.T) {
	output := "@  _PREFIX:o_PREFIX:20_PREFIX:false\x1foysoxutx\x1f20eb6a12\x1fmy commit\x1fmain\x1fdevelop\n"
	rows := ParseGraphLog(output)
	require.Len(t, rows, 1)
	assert.Equal(t, []string{"main", "develop"}, rows[0].Bookmarks)
}

func TestParseGraphLog_EmptyDescription(t *testing.T) {
	output := "@  _PREFIX:o_PREFIX:20_PREFIX:false\x1foysoxutx\x1f20eb6a12\x1f\x1f\n"
	rows := ParseGraphLog(output)
	require.Len(t, rows, 1)
	assert.Equal(t, "", rows[0].Description)
}

func TestParseGraphLog_DivergentCommit(t *testing.T) {
	output := "○  _PREFIX:d_PREFIX:4_PREFIX:true\x1fdddddddd\x1f44444444\x1fdivergent change\x1f\n"
	rows := ParseGraphLog(output)
	require.Len(t, rows, 1)
	assert.Equal(t, "dddddddd??", rows[0].Commit.ChangeId)
	assert.Equal(t, "44444444", rows[0].Commit.CommitId)
	assert.Equal(t, "divergent change", rows[0].Description)
}

func TestParseGraphLog_HiddenCommit(t *testing.T) {
	output := "◌  _PREFIX:h_PREFIX:5_PREFIX:false\x1fhhhhhhhh\x1f55555555\x1fhidden change\x1f\n"
	rows := ParseGraphLog(output)
	require.Len(t, rows, 1)
	assert.True(t, rows[0].Commit.Hidden)
	assert.Equal(t, "hhhhhhhh", rows[0].Commit.ChangeId)
	assert.Equal(t, "hidden change", rows[0].Description)
}

func TestParseGraphLog_FallbackToShortest(t *testing.T) {
	// Old format without full IDs — should fall back to shortest prefix
	output := "@  _PREFIX:o_PREFIX:20_PREFIX:false\n"
	rows := ParseGraphLog(output)
	require.Len(t, rows, 1)
	assert.Equal(t, "o", rows[0].Commit.ChangeId)
	assert.Equal(t, "20", rows[0].Commit.CommitId)
}
