package api

import (
	"net/http"
	"net/http/httptest"
	"regexp"
	"sort"
	"testing"

	"github.com/chronologos/lightjj/internal/jj"
	"github.com/chronologos/lightjj/testutil"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// TestAgentDocRoutesRegistered is the structural guard against agent_api.md
// drifting from server.go's route table: every /api/... path mentioned in the
// served doc must resolve to a handler (anything but 404). The doc and the mux
// are both compiled into the binary, so this catches drift at PR time rather
// than when an agent's first call 404s.
func TestAgentDocRoutesRegistered(t *testing.T) {
	runner := testutil.NewMockRunner(t)
	defer runner.Verify()
	// The probe loop below issues a bare GET per discovered path. Most routes
	// 400/405 before touching jj (missing required params or wrong method), but
	// these have no required params, so allow the resulting jj calls.
	runner.Allow(jj.LogGraph("", 500)).SetOutput([]byte(""))
	runner.Allow(jj.GitRemoteList()).SetOutput([]byte(""))
	runner.Allow(jj.ConfigGet("fsmonitor.watchman.register-snapshot-trigger")).SetOutput([]byte(""))
	srv := newTestServer(runner)

	w := httptest.NewRecorder()
	srv.Mux.ServeHTTP(w, httptest.NewRequest("GET", "/api/agent", nil))
	require.Equal(t, http.StatusOK, w.Code)
	doc := w.Body.String()

	// Match /api/<segments> where segments are lowercase, hyphen, underscore or
	// slash, stopping at query/space/backtick. Dedup so each route is asserted
	// once with a stable failure message.
	re := regexp.MustCompile(`/api/[a-z/_-]+`)
	seen := map[string]bool{}
	for _, m := range re.FindAllString(doc, -1) {
		seen[m] = true
	}
	require.NotEmpty(t, seen, "regex found no /api/ paths in agent doc")

	var paths []string
	for p := range seen {
		paths = append(paths, p)
	}
	sort.Strings(paths)

	for _, p := range paths {
		w := httptest.NewRecorder()
		srv.Mux.ServeHTTP(w, httptest.NewRequest("GET", p, nil))
		assert.NotEqual(t, http.StatusNotFound, w.Code,
			"agent_api.md references %q but no route is registered for it", p)
	}
}

// TestAgentDocMentionsCLI guards the "Reaching the server" section against
// drifting away from the `lightjj api` CLI as the primary access path. The
// curl/jq fallback recipe is allowed to remain, but the doc must continue to
// teach the CLI form first.
func TestAgentDocMentionsCLI(t *testing.T) {
	runner := testutil.NewMockRunner(t)
	defer runner.Verify()
	srv := newTestServer(runner)

	w := httptest.NewRecorder()
	srv.Mux.ServeHTTP(w, httptest.NewRequest("GET", "/api/agent", nil))
	require.Equal(t, http.StatusOK, w.Code)
	assert.Contains(t, w.Body.String(), "lightjj api",
		"agent_api.md must teach the `lightjj api` CLI as the primary access path")
}
