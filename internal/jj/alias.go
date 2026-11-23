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

// ConfigListAliases emits one {"key","value"} object per config entry. jj decodes
// the TOML; we never see its quoting.
func ConfigListAliases() CommandArgs {
	return []string{"config", "list", "aliases", "--color", "never", "--ignore-working-copy",
		"-T", `'{"key":' ++ json(name) ++ ',"value":' ++ json(value) ++ '}' ++ "\n"`}
}

// ParseAliases parses ConfigListAliases output. An alias is either a list
// (`aliases.l = [...]`) or a table, which arrives as one entry per sub-field
// (`aliases.s.definition`, `aliases.s.doc`). Entries that never yield a runnable
// command are dropped; so are lines that aren't ours (jj warnings).
func ParseAliases(output string) []Alias {
	order := []string{} // names in first-seen order
	byName := map[string]*Alias{}
	for line := range strings.SplitSeq(output, "\n") {
		var rec struct {
			Key   string          `json:"key"`
			Value json.RawMessage `json:"value"`
		}
		if json.Unmarshal([]byte(line), &rec) != nil {
			continue
		}
		name, field, ok := splitAliasKey(rec.Key)
		if !ok {
			continue
		}
		a := byName[name]
		if a == nil {
			a = &Alias{Name: name}
			byName[name] = a
			order = append(order, name)
		}
		// A value of the wrong type leaves the field empty: jj rejects it too.
		switch field {
		case "", "definition":
			_ = json.Unmarshal(rec.Value, &a.Command)
		case "doc":
			_ = json.Unmarshal(rec.Value, &a.Doc)
		}
	}
	aliases := make([]Alias, 0, len(order))
	for _, name := range order {
		if a := byName[name]; len(a.Command) > 0 {
			aliases = append(aliases, *a)
		}
	}
	return aliases
}

// splitAliasKey splits `aliases.<name>[.<field>]`. jj quotes a name TOML can't
// write bare (`aliases."a.b"`), so a dot inside quotes is part of the name.
func splitAliasKey(key string) (name, field string, ok bool) {
	rest, ok := strings.CutPrefix(key, "aliases.")
	if !ok || rest == "" {
		return "", "", false
	}
	switch rest[0] {
	case '"':
		dec := json.NewDecoder(strings.NewReader(rest)) // TOML basic string ≈ JSON string
		if dec.Decode(&name) != nil {
			return "", "", false
		}
		rest = rest[dec.InputOffset():]
	case '\'':
		name, rest, ok = strings.Cut(rest[1:], "'")
		if !ok {
			return "", "", false
		}
	default:
		name, field, _ = strings.Cut(rest, ".")
		return name, field, true
	}
	return name, strings.TrimPrefix(rest, "."), true
}
