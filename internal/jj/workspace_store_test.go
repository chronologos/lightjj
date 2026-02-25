package jj

import (
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestParseWorkspaceStorePaths_Empty(t *testing.T) {
	result, err := ParseWorkspaceStorePaths([]byte{})
	require.NoError(t, err)
	assert.Empty(t, result)
}

func TestParseWorkspaceStorePaths_SingleWorkspace(t *testing.T) {
	// Manually constructed protobuf: field 1 (entry), containing field 1 (name="default"), field 2 (path="/repo")
	data := buildEntry("default", "/repo")
	result, err := ParseWorkspaceStorePaths(data)
	require.NoError(t, err)
	assert.Equal(t, map[string]string{"default": "/repo"}, result)
}

func TestParseWorkspaceStorePaths_MultipleWorkspaces(t *testing.T) {
	data := append(buildEntry("default", "/Users/iant/3pcode/jj-web"), buildEntry("base2", "/Users/iant/3pcode/jj-web/base2")...)
	result, err := ParseWorkspaceStorePaths(data)
	require.NoError(t, err)
	assert.Equal(t, map[string]string{
		"default": "/Users/iant/3pcode/jj-web",
		"base2":   "/Users/iant/3pcode/jj-web/base2",
	}, result)
}

func TestParseWorkspaceStorePaths_RealData(t *testing.T) {
	// Real binary data captured from a multi-workspace repo
	data := []byte{
		0x0a, 0x24, 0x0a, 0x07, 0x64, 0x65, 0x66, 0x61, 0x75, 0x6c, 0x74,
		0x12, 0x19, 0x2f, 0x55, 0x73, 0x65, 0x72, 0x73, 0x2f, 0x69, 0x61,
		0x6e, 0x74, 0x2f, 0x33, 0x70, 0x63, 0x6f, 0x64, 0x65, 0x2f, 0x6a,
		0x6a, 0x2d, 0x77, 0x65, 0x62,
		0x0a, 0x28, 0x0a, 0x05, 0x62, 0x61, 0x73, 0x65, 0x32,
		0x12, 0x1f, 0x2f, 0x55, 0x73, 0x65, 0x72, 0x73, 0x2f, 0x69, 0x61,
		0x6e, 0x74, 0x2f, 0x33, 0x70, 0x63, 0x6f, 0x64, 0x65, 0x2f, 0x6a,
		0x6a, 0x2d, 0x77, 0x65, 0x62, 0x2f, 0x62, 0x61, 0x73, 0x65, 0x32,
	}
	result, err := ParseWorkspaceStorePaths(data)
	require.NoError(t, err)
	assert.Equal(t, map[string]string{
		"default": "/Users/iant/3pcode/jj-web",
		"base2":   "/Users/iant/3pcode/jj-web/base2",
	}, result)
}

func TestParseWorkspaceStorePaths_Malformed(t *testing.T) {
	// Truncated data
	_, err := ParseWorkspaceStorePaths([]byte{0x0a, 0x24, 0x0a})
	assert.Error(t, err)
}

// buildEntry constructs a protobuf-encoded workspace entry.
func buildEntry(name, path string) []byte {
	// Inner: field 1 (name) + field 2 (path)
	inner := append(protoString(1, name), protoString(2, path)...)
	// Outer: field 1 (entry sub-message)
	return protoBytes(1, inner)
}

func protoString(field int, s string) []byte {
	tag := encodeVarint(uint64(field<<3 | 2))
	length := encodeVarint(uint64(len(s)))
	return append(append(tag, length...), []byte(s)...)
}

func protoBytes(field int, b []byte) []byte {
	tag := encodeVarint(uint64(field<<3 | 2))
	length := encodeVarint(uint64(len(b)))
	return append(append(tag, length...), b...)
}

func encodeVarint(v uint64) []byte {
	var buf []byte
	for v >= 0x80 {
		buf = append(buf, byte(v)|0x80)
		v >>= 7
	}
	return append(buf, byte(v))
}
