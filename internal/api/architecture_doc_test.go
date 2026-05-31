package api

import (
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"

	"github.com/chronologos/lightjj/testutil"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// TestArchitectureEndpointTableInSync is the structural guard against the
// docs/ARCHITECTURE.md endpoint table drifting from server.go's routes().
// Mirrors agent_docs_test.go (the agent_api.md guard), but checks BOTH
// directions: every registered route must have a table row, and every /api
// row in the table must be a registered route.
//
// Tab routes (/tabs, /tab/{id}/*) are host-level — registered by TabManager,
// not routes() — and are exempt via the /api prefix filter.
func TestArchitectureEndpointTableInSync(t *testing.T) {
	doc, err := os.ReadFile(filepath.Join("..", "..", "docs", "ARCHITECTURE.md"))
	require.NoError(t, err, "docs/ARCHITECTURE.md must be readable from internal/api/")

	// Table rows look like: | GET | `/api/log` | Graph log for a revset |
	// Header and separator rows don't backtick-quote the second cell, so the
	// regex skips them.
	rowRe := regexp.MustCompile("(?m)^\\|\\s*([A-Za-z]+)\\s*\\|\\s*`([^`]+)`\\s*\\|")
	documented := map[string]bool{}
	for _, m := range rowRe.FindAllStringSubmatch(string(doc), -1) {
		method, path := strings.ToUpper(m[1]), m[2]
		if path != "/api" && !strings.HasPrefix(path, "/api/") {
			continue // host-level tab routes — TabManager's, not routes()'
		}
		documented[method+" "+path] = true
	}
	require.NotEmpty(t, documented,
		"no /api endpoint rows found in docs/ARCHITECTURE.md — table format changed?")

	srv := newTestServer(testutil.NewMockRunner(t))
	registered := map[string]bool{}
	for _, pattern := range srv.apiRoutes {
		registered[pattern] = true
	}
	require.NotEmpty(t, registered)

	for route := range registered {
		assert.True(t, documented[route],
			"route %q is registered in routes() but missing from the docs/ARCHITECTURE.md endpoint table", route)
	}
	for row := range documented {
		assert.True(t, registered[row],
			"docs/ARCHITECTURE.md endpoint table documents %q but routes() registers no such route", row)
	}
}
