package jj

import (
	"testing"

	"github.com/stretchr/testify/assert"
)

func TestParseIdentity(t *testing.T) {
	one := `{"commit_id":"aaa","change_id":"zzz","hidden":true}` + "\n"
	id, ok := ParseIdentity(one)
	assert.True(t, ok)
	assert.Equal(t, RevIdentity{CommitId: "aaa", ChangeId: "zzz", Hidden: true}, id)

	for name, out := range map[string]string{"empty": "", "two revisions": one + one, "not json": "aaa"} {
		_, ok := ParseIdentity(out)
		assert.False(t, ok, name)
	}
}
