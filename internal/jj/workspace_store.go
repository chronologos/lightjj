package jj

import (
	"fmt"
)

// ParseWorkspaceStorePaths reads the binary workspace_store/index file
// and returns a map of workspace name → absolute directory path.
//
// The file uses protobuf encoding:
//
//	message WorkspaceStore { repeated Entry entries = 1; }
//	message Entry { string name = 1; string path = 2; }
func ParseWorkspaceStorePaths(data []byte) (map[string]string, error) {
	result := make(map[string]string)
	pos := 0
	for pos < len(data) {
		tag, n := readVarint(data[pos:])
		if n == 0 {
			return nil, fmt.Errorf("invalid varint at offset %d", pos)
		}
		pos += n
		fieldNum := tag >> 3
		wireType := tag & 0x7

		if wireType != 2 {
			return nil, fmt.Errorf("unexpected wire type %d at offset %d", wireType, pos)
		}
		length, n := readVarint(data[pos:])
		if n == 0 || pos+n+int(length) > len(data) {
			return nil, fmt.Errorf("invalid length at offset %d", pos)
		}
		pos += n
		payload := data[pos : pos+int(length)]
		pos += int(length)

		if fieldNum != 1 {
			continue // skip unknown fields
		}

		// Parse the sub-message (Entry)
		name, path, err := parseWorkspaceEntry(payload)
		if err != nil {
			return nil, fmt.Errorf("parsing entry: %w", err)
		}
		result[name] = path
	}
	return result, nil
}

func parseWorkspaceEntry(data []byte) (name, path string, err error) {
	pos := 0
	for pos < len(data) {
		tag, n := readVarint(data[pos:])
		if n == 0 {
			return "", "", fmt.Errorf("invalid varint at offset %d", pos)
		}
		pos += n
		wireType := tag & 0x7
		fieldNum := tag >> 3

		if wireType != 2 {
			return "", "", fmt.Errorf("unexpected wire type %d", wireType)
		}
		length, n := readVarint(data[pos:])
		if n == 0 || pos+n+int(length) > len(data) {
			return "", "", fmt.Errorf("invalid length at offset %d", pos)
		}
		pos += n
		value := string(data[pos : pos+int(length)])
		pos += int(length)

		switch fieldNum {
		case 1:
			name = value
		case 2:
			path = value
		}
	}
	return name, path, nil
}

// readVarint reads a base-128 varint from data, returning the value and bytes consumed.
// Returns (0, 0) if data is empty or varint is malformed.
func readVarint(data []byte) (uint64, int) {
	var val uint64
	for i, b := range data {
		if i >= 10 {
			return 0, 0 // varint too long
		}
		val |= uint64(b&0x7F) << (7 * uint(i))
		if b&0x80 == 0 {
			return val, i + 1
		}
	}
	return 0, 0
}
