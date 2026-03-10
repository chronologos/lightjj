package parser

import (
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestParseGraphLog_LinearHistory(t *testing.T) {
	output := "@  _PREFIX:o_PREFIX:20_PREFIX:false_PREFIX:false\x1foysoxutx\x1f20eb6a12\x1fmy commit\x1f\x1ff766300c\x1fmain\x1fmain@origin\n" +
		"○  _PREFIX:r_PREFIX:f_PREFIX:false_PREFIX:false\x1frrrtptvx\x1ff766300c\x1fui v1\x1f\x1fb6a3ed01\x1f\n" +
		"○  _PREFIX:m_PREFIX:b_PREFIX:false_PREFIX:false\x1fmwoxvszn\x1fb6a3ed01\x1fport jjui golang code\x1f\x1f00000000\x1f\n" +
		"◆  _PREFIX:z_PREFIX:0_PREFIX:false_PREFIX:false\x1fzzzzzzzz\x1f00000000\x1f\x1f\x1f\x1f\n"

	rows := ParseGraphLog(output)
	require.Len(t, rows, 4)

	assert.Equal(t, "oysoxutx", rows[0].Commit.ChangeId)
	assert.Equal(t, "20eb6a12", rows[0].Commit.CommitId)
	assert.Equal(t, 1, rows[0].Commit.ChangePrefix) // "o" = 1 char
	assert.Equal(t, 2, rows[0].Commit.CommitPrefix)  // "20" = 2 chars
	assert.True(t, rows[0].Commit.IsWorkingCopy)
	assert.Equal(t, "my commit", rows[0].Description)
	assert.Equal(t, []string{"main", "main@origin"}, rows[0].Bookmarks)
	assert.Equal(t, []string{"f766300c"}, rows[0].Commit.ParentIds)
	assert.Nil(t, rows[3].Commit.ParentIds) // root has no parents

	assert.Equal(t, "rrrtptvx", rows[1].Commit.ChangeId)
	assert.Equal(t, 1, rows[1].Commit.ChangePrefix)
	assert.False(t, rows[1].Commit.IsWorkingCopy)
	assert.Equal(t, "ui v1", rows[1].Description)

	assert.Equal(t, "zzzzzzzz", rows[3].Commit.ChangeId)
	assert.False(t, rows[3].Commit.IsWorkingCopy)
}

func TestParseGraphLog_WithBranches(t *testing.T) {
	output := "@  _PREFIX:o_PREFIX:20_PREFIX:false_PREFIX:false\x1foysoxutx\x1f20eb6a12\x1f\x1f\x1f\x1f\n" +
		"│\n" +
		"│ ○  _PREFIX:q_PREFIX:5_PREFIX:false_PREFIX:false\x1fqlpymtvq\x1f50dbf764\x1f\x1f\x1f\x1f\n" +
		"├─╯\n" +
		"○  _PREFIX:r_PREFIX:f_PREFIX:false_PREFIX:false\x1frrrtptvx\x1ff766300c\x1fui v1\x1f\x1f\x1f\n" +
		"○  _PREFIX:m_PREFIX:b_PREFIX:false_PREFIX:false\x1fmwoxvszn\x1fb6a3ed01\x1fport jjui golang code\x1f\x1f\x1f\n" +
		"◆  _PREFIX:z_PREFIX:0_PREFIX:false_PREFIX:false\x1fzzzzzzzz\x1f00000000\x1f\x1f\x1f\x1f\n"

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
	output := "@    _PREFIX:x_PREFIX:2b_PREFIX:false_PREFIX:false\x1fxsrvltkl\x1f2b52f01c\x1f\x1f\x1f\x1f\n" +
		"├─╮\n" +
		"│ ○  _PREFIX:q_PREFIX:5_PREFIX:false_PREFIX:false\x1fqlpymtvq\x1f50dbf764\x1f\x1f\x1f\x1f\n" +
		"│ │\n" +
		"○ │  _PREFIX:o_PREFIX:20_PREFIX:false_PREFIX:false\x1foysoxutx\x1f20eb6a12\x1f\x1f\x1f\x1f\n" +
		"├─╯\n" +
		"○  _PREFIX:r_PREFIX:f_PREFIX:false_PREFIX:false\x1frrrtptvx\x1ff766300c\x1fui v1\x1f\x1f\x1f\n"

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
	output := "○  _PREFIX:a_PREFIX:1_PREFIX:false_PREFIX:false\x1faaaaaaaa\x1f11111111\x1f\x1f\x1f\x1f\n" +
		"@  _PREFIX:b_PREFIX:2_PREFIX:false_PREFIX:false\x1fbbbbbbbb\x1f22222222\x1f\x1f\x1f\x1f\n" +
		"○  _PREFIX:c_PREFIX:3_PREFIX:false_PREFIX:false\x1fcccccccc\x1f33333333\x1f\x1f\x1f\x1f\n"

	rows := ParseGraphLog(output)
	require.Len(t, rows, 3)

	assert.False(t, rows[0].Commit.IsWorkingCopy)
	assert.True(t, rows[1].Commit.IsWorkingCopy)
	assert.False(t, rows[2].Commit.IsWorkingCopy)
}

func TestParseGraphLog_PrefixLength(t *testing.T) {
	output := "@  _PREFIX:xy_PREFIX:abc_PREFIX:false_PREFIX:false\x1fxyzwvuts\x1fabcdef12\x1ftest\x1f\x1f\x1f\n"
	rows := ParseGraphLog(output)
	require.Len(t, rows, 1)

	assert.Equal(t, "xyzwvuts", rows[0].Commit.ChangeId)
	assert.Equal(t, 2, rows[0].Commit.ChangePrefix)  // "xy" = 2
	assert.Equal(t, 3, rows[0].Commit.CommitPrefix)   // "abc" = 3
}

func TestParseGraphLog_ImmutableAndConflict(t *testing.T) {
	output := "×  _PREFIX:k_PREFIX:9_PREFIX:false_PREFIX:false\x1fkkkkkkkk\x1f99999999\x1f\x1f\x1f\x1f\n" +
		"◆  _PREFIX:z_PREFIX:0_PREFIX:false_PREFIX:false\x1fzzzzzzzz\x1f00000000\x1f\x1f\x1f\x1f\n"

	rows := ParseGraphLog(output)
	require.Len(t, rows, 2)

	assert.True(t, rows[0].GraphLines[0].IsNode)
	assert.True(t, rows[1].GraphLines[0].IsNode)
}

func TestParseGraphLog_BookmarksMultiple(t *testing.T) {
	output := "@  _PREFIX:o_PREFIX:20_PREFIX:false_PREFIX:false\x1foysoxutx\x1f20eb6a12\x1fmy commit\x1f\x1f\x1fmain\x1fdevelop\n"
	rows := ParseGraphLog(output)
	require.Len(t, rows, 1)
	assert.Equal(t, []string{"main", "develop"}, rows[0].Bookmarks)
}

func TestParseGraphLog_EmptyDescription(t *testing.T) {
	output := "@  _PREFIX:o_PREFIX:20_PREFIX:false_PREFIX:false\x1foysoxutx\x1f20eb6a12\x1f\x1f\x1f\x1f\n"
	rows := ParseGraphLog(output)
	require.Len(t, rows, 1)
	assert.Equal(t, "", rows[0].Description)
}

func TestParseGraphLog_DivergentCommit(t *testing.T) {
	output := "○  _PREFIX:d_PREFIX:4_PREFIX:true_PREFIX:false\x1fdddddddd\x1f44444444\x1fdivergent change\x1f\x1f\x1f\n"
	rows := ParseGraphLog(output)
	require.Len(t, rows, 1)
	assert.Equal(t, "dddddddd", rows[0].Commit.ChangeId)
	assert.True(t, rows[0].Commit.Divergent)
	assert.False(t, rows[0].Commit.Empty)
	assert.Equal(t, "44444444", rows[0].Commit.CommitId)
	assert.Equal(t, "divergent change", rows[0].Description)
}

func TestParseGraphLog_EmptyCommit(t *testing.T) {
	output := "@  _PREFIX:e_PREFIX:6_PREFIX:false_PREFIX:true\x1feeeeeeee\x1f66666666\x1f\x1f\x1f\x1f\n"
	rows := ParseGraphLog(output)
	require.Len(t, rows, 1)
	assert.True(t, rows[0].Commit.Empty)
	assert.False(t, rows[0].Commit.Divergent)
	assert.Equal(t, "eeeeeeee", rows[0].Commit.ChangeId)
}

func TestParseGraphLog_HiddenCommit(t *testing.T) {
	output := "◌  _PREFIX:h_PREFIX:5_PREFIX:false_PREFIX:false\x1fhhhhhhhh\x1f55555555\x1fhidden change\x1f\x1f\x1f\n"
	rows := ParseGraphLog(output)
	require.Len(t, rows, 1)
	assert.True(t, rows[0].Commit.Hidden)
	assert.Equal(t, "hhhhhhhh", rows[0].Commit.ChangeId)
	assert.Equal(t, "hidden change", rows[0].Description)
}

func TestParseGraphLog_ImmutableCommit(t *testing.T) {
	output := "◆  _PREFIX:i_PREFIX:5_PREFIX:false_PREFIX:false\x1fiiiiiiii\x1f55555555\x1fimmutable change\x1f\x1f\x1f\n"
	rows := ParseGraphLog(output)
	require.Len(t, rows, 1)
	assert.True(t, rows[0].Commit.Immutable)
	assert.False(t, rows[0].Commit.IsWorkingCopy)
	assert.Equal(t, "iiiiiiii", rows[0].Commit.ChangeId)
	assert.Equal(t, "immutable change", rows[0].Description)
}

func TestParseGraphLog_MutableCommit(t *testing.T) {
	output := "○  _PREFIX:m_PREFIX:3_PREFIX:false_PREFIX:false\x1fmmmmmmmm\x1f33333333\x1fmutable change\x1f\x1f\x1f\n"
	rows := ParseGraphLog(output)
	require.Len(t, rows, 1)
	assert.False(t, rows[0].Commit.Immutable)
	assert.False(t, rows[0].Commit.IsWorkingCopy)
	assert.Equal(t, "mmmmmmmm", rows[0].Commit.ChangeId)
}

func TestParseGraphLog_MixedImmutableAndMutable(t *testing.T) {
	output := "○  _PREFIX:a_PREFIX:1_PREFIX:false_PREFIX:false\x1faaaaaaaa\x1f11111111\x1fmutable\x1f\x1f\x1f\n" +
		"◆  _PREFIX:b_PREFIX:2_PREFIX:false_PREFIX:false\x1fbbbbbbbb\x1f22222222\x1fimmutable\x1f\x1f\x1f\n" +
		"○  _PREFIX:c_PREFIX:3_PREFIX:false_PREFIX:false\x1fcccccccc\x1f33333333\x1falso mutable\x1f\x1f\x1f\n" +
		"◆  _PREFIX:z_PREFIX:0_PREFIX:false_PREFIX:false\x1fzzzzzzzz\x1f00000000\x1f\x1f\x1f\x1f\n"

	rows := ParseGraphLog(output)
	require.Len(t, rows, 4)

	assert.False(t, rows[0].Commit.Immutable)
	assert.Equal(t, "aaaaaaaa", rows[0].Commit.ChangeId)

	assert.True(t, rows[1].Commit.Immutable)
	assert.Equal(t, "bbbbbbbb", rows[1].Commit.ChangeId)

	assert.False(t, rows[2].Commit.Immutable)
	assert.Equal(t, "cccccccc", rows[2].Commit.ChangeId)

	assert.True(t, rows[3].Commit.Immutable)
	assert.Equal(t, "zzzzzzzz", rows[3].Commit.ChangeId)
}

func TestParseGraphLog_WorkingCopyIsNotImmutable(t *testing.T) {
	output := "@  _PREFIX:w_PREFIX:7_PREFIX:false_PREFIX:false\x1fwwwwwwww\x1f77777777\x1fworking copy\x1f\x1f\x1f\n"
	rows := ParseGraphLog(output)
	require.Len(t, rows, 1)
	assert.True(t, rows[0].Commit.IsWorkingCopy)
	assert.False(t, rows[0].Commit.Immutable)
	assert.Equal(t, "wwwwwwww", rows[0].Commit.ChangeId)
}

func TestParseGraphLog_FallbackToShortest(t *testing.T) {
	// Old format without full IDs — should fall back to shortest prefix
	output := "@  _PREFIX:o_PREFIX:20_PREFIX:false\n"
	rows := ParseGraphLog(output)
	require.Len(t, rows, 1)
	assert.Equal(t, "o", rows[0].Commit.ChangeId)
	assert.Equal(t, "20", rows[0].Commit.CommitId)
}

func TestParseGraphLog_WorkingCopies(t *testing.T) {
	// Revision is working copy for two workspaces
	output := "@  _PREFIX:s_PREFIX:a1_PREFIX:false_PREFIX:false\x1fskpssuxl\x1fa14ce848\x1fmy change\x1fbase2@ default@\x1f\x1fmain\n"
	rows := ParseGraphLog(output)
	require.Len(t, rows, 1)
	assert.Equal(t, []string{"base2", "default"}, rows[0].Commit.WorkingCopies)
	assert.Equal(t, []string{"main"}, rows[0].Bookmarks)
	assert.Equal(t, "my change", rows[0].Description)
}

func TestParseGraphLog_WorkingCopiesSingle(t *testing.T) {
	// Revision is working copy for one workspace (not the current one — ○ gutter)
	output := "○  _PREFIX:s_PREFIX:a1_PREFIX:false_PREFIX:false\x1fskpssuxl\x1fa14ce848\x1fother workspace\x1fbase2@\x1f\x1f\n"
	rows := ParseGraphLog(output)
	require.Len(t, rows, 1)
	assert.Equal(t, []string{"base2"}, rows[0].Commit.WorkingCopies)
	assert.False(t, rows[0].Commit.IsWorkingCopy) // ○ gutter = not current workspace
	assert.Nil(t, rows[0].Bookmarks)
}

func TestParseGraphLog_WorkingCopiesEmpty(t *testing.T) {
	// Normal revision with no workspace associations
	output := "○  _PREFIX:r_PREFIX:f_PREFIX:false_PREFIX:false\x1frrrtptvx\x1ff766300c\x1fui v1\x1f\x1f\x1f\n"
	rows := ParseGraphLog(output)
	require.Len(t, rows, 1)
	assert.Nil(t, rows[0].Commit.WorkingCopies)
}

func TestParseGraphLog_ElidedRevisions(t *testing.T) {
	// jj outputs "~  (elided revisions)" as a connector line between commits.
	// The text should be split into Gutter ("~ ") and Content ("(elided revisions)").
	output := "◆  _PREFIX:k_PREFIX:9a_PREFIX:false_PREFIX:false\x1fkrwsotqn\x1f9a0cb1d7\x1fimprove ui\x1f\x1f\x1f\n" +
		"~  (elided revisions)\n" +
		"○  _PREFIX:o_PREFIX:f6_PREFIX:false_PREFIX:false\x1fozyvxqpo\x1ff69abe99\x1fchild B\x1f\x1f\x1f\n"

	rows := ParseGraphLog(output)
	require.Len(t, rows, 2)

	// The elided line should be a connector on the first row
	require.Len(t, rows[0].GraphLines, 2) // node line + elided connector
	assert.Equal(t, "~  ", rows[0].GraphLines[1].Gutter)
	assert.Equal(t, "(elided revisions)", rows[0].GraphLines[1].Content)
	assert.False(t, rows[0].GraphLines[1].IsNode)
}

func TestParseGraphLog_EmptyInput(t *testing.T) {
	rows := ParseGraphLog("")
	assert.NotNil(t, rows, "should return empty slice, not nil")
	assert.Len(t, rows, 0)
}

func TestParseGraphLog_OnlyBlankLines(t *testing.T) {
	rows := ParseGraphLog("\n\n\n")
	assert.Len(t, rows, 0)
}

func TestParseGraphLog_ParentIds(t *testing.T) {
	output := "○  _PREFIX:a_PREFIX:1_PREFIX:false_PREFIX:false\x1faaaaaaaa\x1f11111111\x1fchild\x1f\x1f22222222,33333333\x1f\n"
	rows := ParseGraphLog(output)
	require.Len(t, rows, 1)
	assert.Equal(t, []string{"22222222", "33333333"}, rows[0].Commit.ParentIds)
}

func TestParseGraphLog_ConnectorWithoutPrecedingNode(t *testing.T) {
	// Connector lines before any node line should be dropped gracefully
	output := "│\n" +
		"@  _PREFIX:a_PREFIX:1_PREFIX:false_PREFIX:false\x1faaaaaaaa\x1f11111111\x1ftest\x1f\x1f\x1f\n"
	rows := ParseGraphLog(output)
	require.Len(t, rows, 1)
	assert.Equal(t, "aaaaaaaa", rows[0].Commit.ChangeId)
	// Orphaned connector line was dropped (current != nil only after first node)
	assert.Len(t, rows[0].GraphLines, 1)
}

func TestParseGraphLog_RemoteOnlyBookmarks(t *testing.T) {
	output := "◆  _PREFIX:a_PREFIX:1_PREFIX:false_PREFIX:false\x1fabcdefgh\x1f12345678\x1ffix something\x1f\x1f00000000\x1ffeat/foo@upstream\n"
	rows := ParseGraphLog(output)
	require.Len(t, rows, 1)
	assert.Equal(t, []string{"feat/foo@upstream"}, rows[0].Bookmarks)
}
