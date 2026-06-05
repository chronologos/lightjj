package jj

import (
	"encoding/json"
	"strings"
)

// Alias represents a user-defined jj alias from the [aliases] config section.
type Alias struct {
	Name    string   `json:"name"`
	Command []string `json:"command"`       // e.g. ["git", "fetch", "-b", "glob:alice/*"]
	Doc     string   `json:"doc,omitempty"` // optional description from table-form aliases
}

// ParseAliases parses the output of `jj config list aliases` into a slice of Alias.
//
// jj renders two alias shapes. The simple form is a TOML array that may span
// multiple lines:
//
//	aliases.l = ["log", "-r", "@"]
//
// The table form — `{ definition = [...], doc = "..." }`, which jj ≥ 0.42
// documents as the way to attach a description (surfaced in shell completions
// via the .doc field) — flattens to one key per sub-field:
//
//	aliases.s.definition = ["show"]
//	aliases.s.doc        = "show a revision"
//
// Both shapes coalesce into a single Alias per name; the doc is optional. An
// entry that never yields a runnable command is dropped (the palette needs
// something to run), so a stray .doc without a definition is ignored.
func ParseAliases(output string) []Alias {
	if strings.TrimSpace(output) == "" {
		return []Alias{}
	}

	lines := strings.Split(output, "\n")
	order := []string{} // names in first-seen order
	byName := map[string]*Alias{}

	var currentName, currentKind string
	var currentValue strings.Builder

	flush := func() {
		if currentName == "" {
			return
		}
		raw := currentValue.String()
		a := byName[currentName]
		if a == nil {
			a = &Alias{Name: currentName}
			byName[currentName] = a
			order = append(order, currentName)
		}
		if currentKind == "doc" {
			a.Doc = parseAliasDoc(raw)
		} else {
			a.Command = parseAliasValue(raw)
		}
		currentName, currentKind = "", ""
		currentValue.Reset()
	}

	for _, line := range lines {
		if strings.HasPrefix(line, "aliases.") {
			flush()
			// Split on first " = " to separate the key from its value. A doc
			// value can itself contain " = " (e.g. doc = "a = b"); Cut splits
			// on the first occurrence, so the key is always intact.
			before, after, ok := strings.Cut(line, " = ")
			if !ok {
				continue
			}
			currentName, currentKind = splitAliasKey(strings.TrimPrefix(before, "aliases."))
			currentValue.WriteString(after)
		} else if currentName != "" {
			// Continuation line for multi-line array or triple-quoted string.
			// Preserve the newline — it's content inside triple-quoted strings.
			currentValue.WriteByte('\n')
			currentValue.WriteString(line)
		}
	}
	flush()

	aliases := make([]Alias, 0, len(order))
	for _, name := range order {
		if a := byName[name]; len(a.Command) > 0 {
			aliases = append(aliases, *a)
		}
	}
	return aliases
}

// splitAliasKey separates an alias config key (already stripped of the
// "aliases." prefix) into the alias name and which sub-field it carries. A
// trailing ".definition"/".doc" is a table-form sub-key; anything else is a
// simple-form alias whose whole key is the name and whose value is the command
// ("definition" kind). An alias literally named "doc" stays a definition —
// only a *dotted* ".doc" suffix selects the doc kind.
func splitAliasKey(key string) (name, kind string) {
	if n, ok := strings.CutSuffix(key, ".definition"); ok {
		return n, "definition"
	}
	if n, ok := strings.CutSuffix(key, ".doc"); ok {
		return n, "doc"
	}
	return key, "definition"
}

// parseAliasDoc decodes the single TOML string value of a table-form alias's
// .doc field into a plain Go string for display. Handles basic ("…"), literal
// ('…'), and triple-quoted ("""…""" / '''…''') forms; returns "" on anything
// it can't parse.
func parseAliasDoc(raw string) string {
	raw = strings.TrimSpace(raw)
	if len(raw) < 2 {
		return ""
	}
	// Triple-quoted (checked before the single-char forms, since `'''` starts
	// with `'`). jj usually emits single-line basic strings here, but a
	// multi-line doc round-trips through the array parser's continuation path.
	if len(raw) >= 6 {
		if delim := raw[:3]; delim == `"""` || delim == "'''" {
			end := strings.Index(raw[3:], delim)
			if end < 0 {
				return ""
			}
			// TOML strips the first newline after the opening delimiter.
			return strings.TrimPrefix(raw[3:3+end], "\n")
		}
	}
	switch raw[0] {
	case '"':
		// Basic string — valid JSON, so Unmarshal handles \n, \", \\, etc.
		var s string
		if json.Unmarshal([]byte(raw), &s) == nil {
			return s
		}
	case '\'':
		// Literal string — no escapes; content sits between the quotes.
		if end := strings.LastIndexByte(raw[1:], '\''); end >= 0 {
			return raw[1 : 1+end]
		}
	}
	return ""
}

// parseAliasValue converts a TOML-style array string like ['git', 'fetch']
// into a Go string slice. Handles single quotes, double quotes, and TOML
// triple-quoted strings (''' and """) which appear in multi-line aliases
// (e.g. util exec bash scripts).
func parseAliasValue(raw string) []string {
	raw = strings.TrimSpace(raw)
	if len(raw) < 2 || raw[0] != '[' || raw[len(raw)-1] != ']' {
		return nil
	}

	// Normalize to JSON array. Walk character by character, handling four
	// TOML string types: basic (""), literal (''), multi-line basic ("""),
	// and multi-line literal ('''). Triple-quote forms must be checked
	// before single-quote forms (''' starts with ').
	var buf strings.Builder
	buf.Grow(len(raw))
	i := 0
	for i < len(raw) {
		// Check for triple-quoted strings first (''' or """)
		if i+2 < len(raw) {
			triple := raw[i : i+3]
			if triple == "'''" || triple == `"""` {
				delim := triple
				// Find matching closing triple-quote
				end := strings.Index(raw[i+3:], delim)
				if end < 0 {
					// Unclosed triple-quote — bail
					return nil
				}
				content := raw[i+3 : i+3+end]
				// TOML: first newline after opening ''' is stripped
				content = strings.TrimPrefix(content, "\n")
				// Emit as a JSON double-quoted string: escape backslashes,
				// double quotes, and newlines.
				buf.WriteByte('"')
				for _, c := range content {
					switch c {
					case '\\':
						buf.WriteString(`\\`)
					case '"':
						buf.WriteString(`\"`)
					case '\n':
						buf.WriteString(`\n`)
					case '\r':
						buf.WriteString(`\r`)
					case '\t':
						buf.WriteString(`\t`)
					default:
						buf.WriteRune(c)
					}
				}
				buf.WriteByte('"')
				i += 3 + end + 3 // skip content + closing delimiter
				continue
			}
		}

		ch := raw[i]
		switch {
		case ch == '\'':
			// Single-quoted TOML string → emit as double-quoted JSON string.
			// Find closing single quote.
			end := strings.IndexByte(raw[i+1:], '\'')
			if end < 0 {
				return nil
			}
			content := raw[i+1 : i+1+end]
			buf.WriteByte('"')
			for _, c := range content {
				switch c {
				case '\\':
					buf.WriteString(`\\`)
				case '"':
					buf.WriteString(`\"`)
				default:
					buf.WriteRune(c)
				}
			}
			buf.WriteByte('"')
			i += 1 + end + 1
		case ch == '"':
			// Double-quoted TOML string — pass through (already JSON-compatible).
			buf.WriteByte('"')
			i++
			for i < len(raw) && raw[i] != '"' {
				if raw[i] == '\\' && i+1 < len(raw) {
					buf.WriteByte(raw[i])
					buf.WriteByte(raw[i+1])
					i += 2
				} else {
					buf.WriteByte(raw[i])
					i++
				}
			}
			if i < len(raw) {
				buf.WriteByte('"')
				i++
			}
		default:
			buf.WriteByte(ch)
			i++
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
