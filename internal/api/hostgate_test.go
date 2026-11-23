package api

import (
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/chronologos/lightjj/testutil"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestNewHostPolicy_Validation(t *testing.T) {
	for _, tc := range []struct {
		name    string
		entries []string
		ok      bool
	}{
		{"none", nil, true},
		{"plain", []string{"proxy.example"}, true},
		{"mixed case + trailing dot", []string{"Proxy.Example."}, true},
		{"ipv4", []string{"192.168.1.5"}, true},
		{"ipv6 bare", []string{"fd00::1"}, true},
		{"ipv6 bracketed", []string{"[fd00::1]"}, true},
		{"whitespace trimmed", []string{"  proxy.example "}, true},
		{"empty", []string{""}, false},
		{"whitespace only", []string{"   "}, false},
		{"wildcard", []string{"*"}, false},
		{"wildcard subdomain", []string{"*.example.com"}, false},
		{"url", []string{"https://proxy.example"}, false},
		{"path", []string{"proxy.example/lightjj"}, false},
		{"port", []string{"proxy.example:8443"}, false},
		{"bad char", []string{"proxy_example"}, false},
		{"leading hyphen", []string{"-proxy.example"}, false},
		{"empty label", []string{"proxy..example"}, false},
		{"lone dot", []string{"."}, false},
		{"one bad among good", []string{"proxy.example", ""}, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			_, err := NewHostPolicy(tc.entries)
			if tc.ok {
				assert.NoError(t, err)
			} else {
				assert.Error(t, err)
			}
		})
	}
}

func TestHostPolicy_AllowsHost(t *testing.T) {
	def, err := NewHostPolicy(nil)
	require.NoError(t, err)
	allow, err := NewHostPolicy([]string{"allowed.example", "fd00::1"})
	require.NoError(t, err)
	var nilPolicy *HostPolicy

	for _, tc := range []struct {
		host        string
		def, listed bool // expected for default policy / allow-listed policy
	}{
		// Loopback baseline — identical to the old localhostOnly.
		{"localhost", true, true},
		{"localhost:3000", true, true},
		{"127.0.0.1:3000", true, true},
		{"[::1]:3000", true, true},
		{"::1", true, true},
		// Foreign hosts: default-deny.
		{"evil.example", false, false},
		{"evil.example:3000", false, false},
		{"", false, false},
		// Allow-listed: with/without port, case, trailing dot.
		{"allowed.example", false, true},
		{"allowed.example:443", false, true},
		{"ALLOWED.Example:8080", false, true},
		{"allowed.example.", false, true},
		{"allowed.example.:443", false, true},
		// IPv6 allow-list entry, bracketed with and without port.
		{"[fd00::1]:3000", false, true},
		{"[fd00::1]", false, true},
		{"[fd00::2]:3000", false, false},
		// Look-alikes must not match.
		{"allowed.example.evil.com", false, false},
		{"evilallowed.example", false, false},
		{"sub.allowed.example", false, false},
		{"allowed.exampl", false, false},
		{"allowed.example..", false, false},
	} {
		t.Run(tc.host, func(t *testing.T) {
			assert.Equal(t, tc.def, def.AllowsHost(tc.host), "default policy")
			assert.Equal(t, tc.def, nilPolicy.AllowsHost(tc.host), "nil policy")
			assert.Equal(t, tc.listed, allow.AllowsHost(tc.host), "allow-listed policy")
		})
	}
}

func TestHostPolicy_AllowsOrigin(t *testing.T) {
	allow, err := NewHostPolicy([]string{"allowed.example"})
	require.NoError(t, err)
	var nilPolicy *HostPolicy

	for _, tc := range []struct {
		origin, host string
		def, listed  bool
	}{
		{"http://localhost:3000", "localhost:3000", true, true},
		{"http://LOCALHOST:3000", "localhost:3000", true, true},
		{"http://[::1]:3000", "[::1]:3000", true, true},
		// Another local port, name or scheme-less origin is another site.
		{"http://localhost:8888", "localhost:3000", false, false},
		{"http://127.0.0.1:3000", "localhost:3000", false, false},
		{"http://localhost", "localhost:3000", false, false},
		{"file://localhost:3000", "localhost:3000", false, false},
		// Same as Host, but Host itself isn't one of ours.
		{"https://evil.example.com", "evil.example.com", false, false},
		// Allow-listed name: the proxy's public port and scheme are its own business.
		{"https://allowed.example", "localhost:3000", false, true},
		{"https://ALLOWED.example:8443", "localhost:3000", false, true},
		{"http://allowed.example.", "allowed.example", false, true},
		{"https://evil.example.com", "localhost:3000", false, false},
		{"https://allowed.example.evil.com", "localhost:3000", false, false},
		{"https://evilallowed.example", "localhost:3000", false, false},
		{"https://allowed.example@evil.com", "localhost:3000", false, false},
		{"http://localhost:3000@evil.com", "localhost:3000", false, false},
		{"null", "localhost:3000", false, false},
		{"not a url", "localhost:3000", false, false},
	} {
		t.Run(tc.origin+" → "+tc.host, func(t *testing.T) {
			assert.Equal(t, tc.def, nilPolicy.AllowsOrigin(tc.origin, tc.host), "nil policy")
			assert.Equal(t, tc.listed, allow.AllowsOrigin(tc.origin, tc.host), "allow-listed policy")
		})
	}
}

// A cross-origin page can POST these content types (or none) without a preflight.
// Every write route must refuse them before doing anything: that, not an Origin
// check, is what protects the JSON routes. MockRunner fails on any command.
func TestWriteRoutes_RejectSafelistedContentTypes(t *testing.T) {
	withConfigDir(t)
	// Fully set up, so no "unavailable in this mode" answer masks a missing check.
	srv := NewServer(testutil.NewMockRunner(t), t.TempDir())
	srv.SelfBinary = "/bin/false"
	srv.Watcher = newWatcher(srv)
	unexpected := errors.New("reached the handler body")
	tm := NewTabManager(
		func(string) *Server { t.Error(unexpected); return nil },
		func(string) (string, error) { t.Error(unexpected); return "", unexpected })
	tried := 0
	for _, route := range append([]string{"POST /tabs"}, srv.apiRoutes...) {
		method, path, _ := strings.Cut(route, " ")
		if method == http.MethodGet {
			continue
		}
		if method != http.MethodPost {
			assert.Contains(t, []string{http.MethodDelete, http.MethodPut, http.MethodPatch}, method, "preflighted methods only")
			continue
		}
		mux := srv.Mux
		if path == "/tabs" {
			mux = tm.Mux
		}
		for _, ct := range []string{"text/plain", "application/x-www-form-urlencoded", "multipart/form-data; boundary=x", ""} {
			req := httptest.NewRequest(method, path, strings.NewReader("{}"))
			req.Host = "localhost:3000"
			req.Header.Set("Origin", "http://localhost:8888")
			if ct != "" {
				req.Header.Set("Content-Type", ct)
			}
			w := httptest.NewRecorder()
			mux.ServeHTTP(w, req)
			assert.Contains(t, []int{http.StatusBadRequest, http.StatusForbidden, http.StatusUnsupportedMediaType}, w.Code, "%s with %q", route, ct)
			tried++
		}
	}
	assert.Greater(t, tried, 100, "routes were actually probed")
}

// End-to-end through the middleware: Host gate + Origin gate on a real
// TabManager route, and the per-tab mount (/tab/0/api/config) — proving the
// context-carried policy reaches tabs without per-Server plumbing.
func TestHostPolicyMiddleware_HostAndOrigin(t *testing.T) {
	withConfigDir(t)
	r := testutil.NewMockRunner(t)
	defer r.Verify()
	tm := NewTabManager(nil, nil)
	tm.AddTab(newTestServer(r), "/repo")

	allow, err := NewHostPolicy([]string{"proxy.example"})
	require.NoError(t, err)
	def, err := NewHostPolicy(nil)
	require.NoError(t, err)

	do := func(p *HostPolicy, path, host, origin string) int {
		req := jsonPost(path, []byte(`{"theme":"light"}`))
		req.Host = host
		if origin != "" {
			req.Header.Set("Origin", origin)
		}
		w := httptest.NewRecorder()
		p.Middleware(tm.Mux).ServeHTTP(w, req)
		return w.Code
	}

	for _, path := range []string{"/api/config", "/tab/0/api/config"} {
		t.Run(path, func(t *testing.T) {
			// Host gate.
			assert.Equal(t, http.StatusForbidden, do(def, path, "proxy.example", ""))
			assert.Equal(t, http.StatusOK, do(allow, path, "proxy.example", ""))
			assert.Equal(t, http.StatusForbidden, do(allow, path, "evil.example", ""))

			// Origin gate shares the list.
			assert.Equal(t, http.StatusOK, do(allow, path, "proxy.example", "https://proxy.example"))
			assert.Equal(t, http.StatusForbidden, do(allow, path, "proxy.example", "https://evil.example"))
			assert.Equal(t, http.StatusForbidden, do(def, path, "localhost:3000", "https://proxy.example"))
			assert.Equal(t, http.StatusOK, do(allow, path, "localhost:3000", "http://localhost:3000"))
		})
	}
}
