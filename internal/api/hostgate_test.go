package api

import (
	"net/http"
	"net/http/httptest"
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
		origin      string
		def, listed bool
	}{
		{"http://localhost:3000", true, true},
		{"http://127.0.0.1:8080", true, true},
		{"http://[::1]:3000", true, true},
		{"https://allowed.example", false, true},
		{"https://ALLOWED.example:8443", false, true},
		{"http://allowed.example.", false, true},
		{"https://evil.example.com", false, false},
		{"https://allowed.example.evil.com", false, false},
		{"https://evilallowed.example", false, false},
		{"https://allowed.example@evil.com", false, false},
		{"null", false, false},
		{"not a url", false, false},
	} {
		t.Run(tc.origin, func(t *testing.T) {
			assert.Equal(t, tc.def, nilPolicy.AllowsOrigin(tc.origin), "nil policy")
			assert.Equal(t, tc.listed, allow.AllowsOrigin(tc.origin), "allow-listed policy")
		})
	}
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
