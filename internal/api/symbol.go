package api

import (
	"bufio"
	"bytes"
	"encoding/json"
	"fmt"
	"net/http"
	"regexp"
	"strings"
)

// rg-backed go-to-definition (Tier 1 — heuristic, no language server). Runs a
// per-language definition regex against the WORKING COPY via rg. Doesn't resolve
// imports/shadowing/overloads; for code review ("what does this call do?") the
// signature line + leading doc comment covers the common case. Resolves against
// @ regardless of which revision the diff view is showing — acceptable for v1;
// archaeology on old commits will see today's definition.
//
// rg goes through RunRaw so it executes in RepoDir (local) or on the remote
// host (SSH) — same sidecar pattern as gh.

// symbolDefPattern: per-language regex with one %s placeholder for the
// regex-escaped identifier. Anchored at line start (optionally after leading
// whitespace) so call sites don't match.
var symbolDefPattern = map[string]string{
	"go":         `^(func(\s+\([^)]+\))?|type|var|const)\s+%s\b`,
	"typescript": `^(export\s+)?(declare\s+)?(async\s+)?(function|class|interface|type|enum|const|let|var)\s+%s\b`,
	"javascript": `^(export\s+)?(async\s+)?(function|class|const|let|var)\s+%s\b`,
	"python":     `^\s*(async\s+)?(def|class)\s+%s\b`,
	"rust":       `^\s*(pub(\([^)]+\))?\s+)?(async\s+)?(fn|struct|enum|trait|type|const|static|mod)\s+%s\b`,
}

// rg's --type names; keys match LANGUAGES in frontend/src/lib/languages.ts.
var langToRgType = map[string]string{
	"go": "go", "typescript": "ts", "javascript": "js", "python": "py", "rust": "rust",
}

// identRe gates the `name` query param. Symbol must be a plausible identifier
// — keeps regex injection out of the rg pattern (we also QuoteMeta, but
// belt-and-suspenders) and rejects nonsense like hovering whitespace.
var identRe = regexp.MustCompile(`^[A-Za-z_$][A-Za-z0-9_$]*$`)

type SymbolHit struct {
	File    string   `json:"file"`
	Line    int      `json:"line"`
	Text    string   `json:"text"`    // the matching line (signature)
	Context []string `json:"context"` // leading lines (doc comment), source order
}

const (
	symbolMaxHits    = 20
	symbolContextPre = 6
)

func (s *Server) handleSymbol(w http.ResponseWriter, r *http.Request) {
	name := r.URL.Query().Get("name")
	lang := r.URL.Query().Get("lang")
	if !identRe.MatchString(name) {
		s.writeError(w, http.StatusBadRequest, "name must be an identifier")
		return
	}
	tmpl, ok := symbolDefPattern[lang]
	if !ok {
		s.writeJSON(w, r, http.StatusOK, map[string]any{"hits": []SymbolHit{}})
		return
	}
	pattern := fmt.Sprintf(tmpl, regexp.QuoteMeta(name))
	argv := []string{
		"rg", "--json", "-m", fmt.Sprint(symbolMaxHits),
		"-B", fmt.Sprint(symbolContextPre),
		"--type", langToRgType[lang],
		"-e", pattern,
		// Explicit path: RunRaw → runSeparate always sets cmd.Stdin (even
		// empty), and rg with non-tty stdin + no path reads STDIN instead of
		// cwd. Without this rg searches the empty pipe and finds nothing.
		"./",
	}
	out, err := s.Runner.RunRaw(r.Context(), argv)
	// rg exits 1 on no-match. LocalRunner.runSeparate discards stdout on
	// non-zero exit and folds it into the error string, so the no-match path
	// (exit 1, JSON summary on stdout, nothing on stderr) arrives here as
	// err="exit code 1: {summary json...}". Recover by parsing the error
	// text — it's still the same line-delimited JSON. rg-not-installed and
	// real errors yield non-JSON text → parseRgJSON returns []. Degrade
	// silently; hover-docs are best-effort like PR badges.
	if err != nil && len(out) == 0 {
		out = []byte(err.Error())
	}
	s.writeJSON(w, r, http.StatusOK, map[string]any{"hits": parseRgJSON(out)})
}

// parseRgJSON walks rg --json line-delimited output. We only care about
// context-before + match; rg interleaves them per file in order, so a small
// rolling buffer of context lines flushed at each match is enough.
func parseRgJSON(out []byte) []SymbolHit {
	type rgLine struct {
		Type string `json:"type"`
		Data struct {
			Path       struct{ Text string } `json:"path"`
			LineNumber int                   `json:"line_number"`
			Lines      struct{ Text string } `json:"lines"`
		} `json:"data"`
	}
	hits := []SymbolHit{}
	ctx := []string{}
	sc := bufio.NewScanner(bytes.NewReader(out))
	sc.Buffer(make([]byte, 0, 64*1024), 1<<20)
	for sc.Scan() {
		var l rgLine
		if json.Unmarshal(sc.Bytes(), &l) != nil {
			continue
		}
		switch l.Type {
		case "context":
			ctx = append(ctx, strings.TrimRight(l.Data.Lines.Text, "\n"))
		case "match":
			hits = append(hits, SymbolHit{
				File:    strings.TrimPrefix(l.Data.Path.Text, "./"),
				Line:    l.Data.LineNumber,
				Text:    strings.TrimRight(l.Data.Lines.Text, "\n"),
				Context: ctx,
			})
			ctx = []string{}
		case "end":
			ctx = []string{}
		}
		if len(hits) >= symbolMaxHits {
			break
		}
	}
	return hits
}
