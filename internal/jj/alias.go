package jj

import (
	"encoding/json"
	"strings"
)

// Alias represents a user-defined jj alias from the [aliases] config section.
type Alias struct {
	Name    string   `json:"name"`
	Command []string `json:"command"` // e.g. ["git", "fetch", "-b", "glob:alice/*"]
}

// ParseAliases parses the output of `jj config list aliases` into a slice of Alias.
// Each entry starts with "aliases.<name> = " followed by a TOML-style array value
// that may span multiple lines.
func ParseAliases(output string) []Alias {
	if strings.TrimSpace(output) == "" {
		return []Alias{}
	}

	lines := strings.Split(output, "\n")
	aliases := []Alias{}
	var currentName string
	var currentValue strings.Builder

	flush := func() {
		if currentName == "" {
			return
		}
		raw := currentValue.String()
		cmd := parseAliasValue(raw)
		if len(cmd) > 0 {
			aliases = append(aliases, Alias{Name: currentName, Command: cmd})
		}
		currentName = ""
		currentValue.Reset()
	}

	for _, line := range lines {
		if strings.HasPrefix(line, "aliases.") {
			flush()
			// Split on first " = " to separate name from value
			before, after, ok := strings.Cut(line, " = ")
			if !ok {
				continue
			}
			currentName = strings.TrimPrefix(before, "aliases.")
			currentValue.WriteString(after)
		} else if currentName != "" {
			// Continuation line for multi-line array
			currentValue.WriteString(line)
		}
	}
	flush()

	return aliases
}

// parseAliasValue converts a TOML-style array string like ['git', 'fetch']
// into a Go string slice. Handles both single and double quotes.
func parseAliasValue(raw string) []string {
	raw = strings.TrimSpace(raw)
	if raw == "" || raw[0] != '[' {
		return nil
	}

	// Normalize single-quoted strings to double-quoted for JSON unmarshaling.
	// Walk character by character: replace quote delimiters, and escape any
	// double quotes that appear inside single-quoted strings.
	var buf strings.Builder
	buf.Grow(len(raw))
	inSingle := false
	inDouble := false
	for i := 0; i < len(raw); i++ {
		ch := raw[i]
		switch {
		case ch == '\'' && !inDouble:
			inSingle = !inSingle
			buf.WriteByte('"')
		case ch == '"' && inSingle:
			// Escape literal double quotes inside single-quoted TOML strings
			buf.WriteString(`\"`)
		case ch == '"' && !inSingle:
			inDouble = !inDouble
			buf.WriteByte('"')
		default:
			buf.WriteByte(ch)
		}
	}

	normalized := buf.String()
	// Strip trailing commas before ] (TOML allows them, JSON doesn't)
	inner := strings.TrimRight(normalized[1:len(normalized)-1], ", \t\n\r")
	normalized = "[" + inner + "]"

	var result []string
	if err := json.Unmarshal([]byte(normalized), &result); err != nil {
		return nil
	}
	return result
}
