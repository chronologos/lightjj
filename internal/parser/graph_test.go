package parser

import (
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestParseGraphLog_LinearHistory(t *testing.T) {
	output := "@  _PREFIX:o_PREFIX:20_PREFIX:false\toysoxutx\t20eb6a12\tmy commit\tmain\n" +
		"○  _PREFIX:r_PREFIX:f_PREFIX:false\trrrtptvx\tf766300c\tui v1\t\n" +
		"○  _PREFIX:m_PREFIX:b_PREFIX:false\tmwoxvszn\tb6a3ed01\tport jjui golang code\t\n" +
		"◆  _PREFIX:z_PREFIX:0_PREFIX:false\tzzzzzzzz\t00000000\t\t\n"

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
	output := "@  _PREFIX:o_PREFIX:20_PREFIX:false\toysoxutx\t20eb6a12\t\t\n" +
		"│\n" +
		"│ ○  _PREFIX:q_PREFIX:5_PREFIX:false\tqlpymtvq\t50dbf764\t\t\n" +
		"├─╯\n" +
		"○  _PREFIX:r_PREFIX:f_PREFIX:false\trrrtptvx\tf766300c\tui v1\t\n" +
		"○  _PREFIX:m_PREFIX:b_PREFIX:false\tmwoxvszn\tb6a3ed01\tport jjui golang code\t\n" +
		"◆  _PREFIX:z_PREFIX:0_PREFIX:false\tzzzzzzzz\t00000000\t\t\n"

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
	output := "@    _PREFIX:x_PREFIX:2b_PREFIX:false\txsrvltkl\t2b52f01c\t\t\n" +
		"├─╮\n" +
		"│ ○  _PREFIX:q_PREFIX:5_PREFIX:false\tqlpymtvq\t50dbf764\t\t\n" +
		"│ │\n" +
		"○ │  _PREFIX:o_PREFIX:20_PREFIX:false\toysoxutx\t20eb6a12\t\t\n" +
		"├─╯\n" +
		"○  _PREFIX:r_PREFIX:f_PREFIX:false\trrrtptvx\tf766300c\tui v1\t\n"

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
	output := "○  _PREFIX:a_PREFIX:1_PREFIX:false\taaaaaaaa\t11111111\t\t\n" +
		"@  _PREFIX:b_PREFIX:2_PREFIX:false\tbbbbbbbb\t22222222\t\t\n" +
		"○  _PREFIX:c_PREFIX:3_PREFIX:false\tcccccccc\t33333333\t\t\n"

	rows := ParseGraphLog(output)
	require.Len(t, rows, 3)

	assert.False(t, rows[0].Commit.IsWorkingCopy)
	assert.True(t, rows[1].Commit.IsWorkingCopy)
	assert.False(t, rows[2].Commit.IsWorkingCopy)
}

func TestParseGraphLog_PrefixLength(t *testing.T) {
	output := "@  _PREFIX:xy_PREFIX:abc_PREFIX:false\txyzwvuts\tabcdef12\ttest\t\n"
	rows := ParseGraphLog(output)
	require.Len(t, rows, 1)

	assert.Equal(t, "xyzwvuts", rows[0].Commit.ChangeId)
	assert.Equal(t, 2, rows[0].Commit.ChangePrefix)  // "xy" = 2
	assert.Equal(t, 3, rows[0].Commit.CommitPrefix)   // "abc" = 3
}

func TestParseGraphLog_ImmutableAndConflict(t *testing.T) {
	output := "×  _PREFIX:k_PREFIX:9_PREFIX:false\tkkkkkkkk\t99999999\t\t\n" +
		"◆  _PREFIX:z_PREFIX:0_PREFIX:false\tzzzzzzzz\t00000000\t\t\n"

	rows := ParseGraphLog(output)
	require.Len(t, rows, 2)

	assert.True(t, rows[0].GraphLines[0].IsNode)
	assert.True(t, rows[1].GraphLines[0].IsNode)
}

func TestParseGraphLog_BookmarksMultiple(t *testing.T) {
	output := "@  _PREFIX:o_PREFIX:20_PREFIX:false\toysoxutx\t20eb6a12\tmy commit\tmain develop\n"
	rows := ParseGraphLog(output)
	require.Len(t, rows, 1)
	assert.Equal(t, []string{"main", "develop"}, rows[0].Bookmarks)
}

func TestParseGraphLog_EmptyDescription(t *testing.T) {
	output := "@  _PREFIX:o_PREFIX:20_PREFIX:false\toysoxutx\t20eb6a12\t\t\n"
	rows := ParseGraphLog(output)
	require.Len(t, rows, 1)
	assert.Equal(t, "", rows[0].Description)
}

func TestParseGraphLog_FallbackToShortest(t *testing.T) {
	// Old format without full IDs — should fall back to shortest prefix
	output := "@  _PREFIX:o_PREFIX:20_PREFIX:false\n"
	rows := ParseGraphLog(output)
	require.Len(t, rows, 1)
	assert.Equal(t, "o", rows[0].Commit.ChangeId)
	assert.Equal(t, "20", rows[0].Commit.CommitId)
}
