package api

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"regexp"
	"testing"

	"github.com/chronologos/lightjj/testutil"
	"github.com/stretchr/testify/assert"
)

func TestParseRgJSON(t *testing.T) {
	out := []byte(`{"type":"begin","data":{"path":{"text":"a.go"}}}
{"type":"context","data":{"path":{"text":"a.go"},"lines":{"text":"// Doc line\n"},"line_number":9}}
{"type":"context","data":{"path":{"text":"a.go"},"lines":{"text":"// returns X\n"},"line_number":10}}
{"type":"match","data":{"path":{"text":"a.go"},"lines":{"text":"func Foo() int {\n"},"line_number":11}}
{"type":"end","data":{"path":{"text":"a.go"}}}
{"type":"begin","data":{"path":{"text":"b.go"}}}
{"type":"match","data":{"path":{"text":"b.go"},"lines":{"text":"type Foo struct{}\n"},"line_number":3}}
{"type":"end","data":{"path":{"text":"b.go"}}}
`)
	hits := parseRgJSON(out)
	assert.Len(t, hits, 2)
	assert.Equal(t, SymbolHit{
		File: "a.go", Line: 11, Text: "func Foo() int {",
		Context: []string{"// Doc line", "// returns X"},
	}, hits[0])
	assert.Equal(t, SymbolHit{File: "b.go", Line: 3, Text: "type Foo struct{}", Context: []string{}}, hits[1])
}

func TestParseRgJSON_ContextResetsBetweenFiles(t *testing.T) {
	// Dangling context (no following match in that file) must NOT bleed into
	// the next file's hit.
	out := []byte(`{"type":"context","data":{"path":{"text":"a.go"},"lines":{"text":"stale\n"},"line_number":1}}
{"type":"end","data":{"path":{"text":"a.go"}}}
{"type":"match","data":{"path":{"text":"b.go"},"lines":{"text":"func Foo()\n"},"line_number":1}}
`)
	hits := parseRgJSON(out)
	assert.Len(t, hits, 1)
	assert.Empty(t, hits[0].Context)
}

func TestHandleSymbol_RejectsNonIdentifier(t *testing.T) {
	srv := newTestServer(testutil.NewMockRunner(t))
	for _, bad := range []string{"", "foo.bar", "a b", "x;rm -rf"} {
		w := httptest.NewRecorder()
		srv.Mux.ServeHTTP(w, httptest.NewRequest("GET", "/api/symbol?name="+url.QueryEscape(bad)+"&lang=go", nil))
		assert.Equal(t, http.StatusBadRequest, w.Code, bad)
	}
}

func TestHandleSymbol_UnsupportedLangReturnsEmpty(t *testing.T) {
	srv := newTestServer(testutil.NewMockRunner(t))
	w := httptest.NewRecorder()
	srv.Mux.ServeHTTP(w, httptest.NewRequest("GET", "/api/symbol?name=Foo&lang=cobol", nil))
	assert.Equal(t, http.StatusOK, w.Code)
	var resp struct{ Hits []SymbolHit }
	assert.NoError(t, json.Unmarshal(w.Body.Bytes(), &resp))
	assert.Empty(t, resp.Hits)
}

func TestHandleSymbol_BuildsRgArgv(t *testing.T) {
	r := testutil.NewMockRunner(t)
	defer r.Verify()
	// QuoteMeta is a no-op on plain identifiers, so the pattern is predictable.
	r.Expect([]string{
		"rg", "--json", "-m", "20", "-B", "6", "--type", "go",
		"-e", `^(func(\s+\([^)]+\))?|type|var|const)\s+Foo\b`,
		"./",
	}).SetOutput([]byte(`{"type":"match","data":{"path":{"text":"x.go"},"lines":{"text":"func Foo()\n"},"line_number":1}}`))
	srv := newTestServer(r)
	w := httptest.NewRecorder()
	srv.Mux.ServeHTTP(w, httptest.NewRequest("GET", "/api/symbol?name=Foo&lang=go", nil))
	assert.Equal(t, http.StatusOK, w.Code)
	var resp struct{ Hits []SymbolHit }
	assert.NoError(t, json.Unmarshal(w.Body.Bytes(), &resp))
	assert.Equal(t, []SymbolHit{{File: "x.go", Line: 1, Text: "func Foo()", Context: []string{}}}, resp.Hits)
}

func TestSymbolDefPattern_CompilesForAllLangs(t *testing.T) {
	// rg uses Rust regex; Go's engine is close enough to catch unbalanced
	// groups/brackets at template-authoring time.
	for lang, tmpl := range symbolDefPattern {
		_, ok := langToRgType[lang]
		assert.True(t, ok, "missing rg --type mapping for %s", lang)
		_, err := regexp.Compile(fmt.Sprintf(tmpl, "sampleName"))
		assert.NoError(t, err, lang)
	}
}
