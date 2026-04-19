package api

import (
	"encoding/json"
	"fmt"

	"github.com/tailscale/hujson"
)

// standardizeJSONC converts JSONC (with comments / trailing commas) into plain
// JSON bytes of identical length — comments and trailing commas are replaced
// with spaces, preserving byte offsets so error messages still point at the
// right column. Pure passthrough for plain JSON.
//
// Used on every read path that subsequently json.Unmarshals: handleConfigGet,
// ReadPersistedTabs, readConfigEditor. Centralising avoids drift: if someone
// adds a fourth reader and forgets to Standardize, the first user-authored
// comment in their config would panic their open-in-editor feature.
func standardizeJSONC(data []byte) ([]byte, error) {
	return hujson.Standardize(data)
}

// unmarshalJSONC is the "Standardize → json.Unmarshal" idiom one call. Callers
// that want typed decoding of a JSONC file should use this.
func unmarshalJSONC(data []byte, v any) error {
	std, err := standardizeJSONC(data)
	if err != nil {
		return err
	}
	return json.Unmarshal(std, v)
}

// patchConfigKeys applies an "add" RFC 6902 patch for each (key, rawJSONValue)
// pair, returning the Pack()'d bytes. "add" replaces on existing keys and
// inserts on missing — same behaviour as maps.Copy over a RawMessage map.
//
// Comments attached to EXISTING members survive (ObjectMember.Name carries the
// BeforeExtra; replace only swaps the Value). NEW members get no comments —
// hujson has no public API for attaching Extra to an inserted node.
//
// The patch document itself is built from RawMessage values, which the caller
// has already verified as valid JSON (or which came from json.Marshal).
func patchConfigKeys(existing []byte, keys map[string][]byte) ([]byte, error) {
	v, err := hujson.Parse(existing)
	if err != nil {
		return nil, fmt.Errorf("parse existing config: %w", err)
	}
	patch, err := buildAddPatch(keys)
	if err != nil {
		return nil, err
	}
	if err := v.Patch(patch); err != nil {
		return nil, fmt.Errorf("patch config: %w", err)
	}
	return v.Pack(), nil
}

// buildAddPatch composes a JSON Patch document. Keys go through json.Marshal
// for JSON-Pointer escaping (/ → ~1, ~ → ~0) — a config key containing "/"
// isn't a supported shape today, but doing it right costs nothing.
func buildAddPatch(keys map[string][]byte) ([]byte, error) {
	type op struct {
		Op    string          `json:"op"`
		Path  string          `json:"path"`
		Value json.RawMessage `json:"value"`
	}
	ops := make([]op, 0, len(keys))
	for k, v := range keys {
		ops = append(ops, op{Op: "add", Path: "/" + escapePointer(k), Value: v})
	}
	return json.Marshal(ops)
}

// escapePointer applies RFC 6901 escaping: ~ → ~0, / → ~1.
func escapePointer(s string) string {
	out := make([]byte, 0, len(s))
	for i := 0; i < len(s); i++ {
		switch s[i] {
		case '~':
			out = append(out, '~', '0')
		case '/':
			out = append(out, '~', '1')
		default:
			out = append(out, s[i])
		}
	}
	return string(out)
}
