package api

import (
	"context"
	"fmt"
	"log"
	"net"
	"net/http"
	"net/url"
	"strings"
	"sync/atomic"
)

// HostPolicy is the ONE answer to "which hostnames may address this server"
// — applied to the Host header by Middleware (DNS-rebinding defense) and to
// the browser Origin by originAllowed (cross-origin write defense on config/
// state/open-file). Baseline is loopback only; --allowed-host adds exact
// hostnames for running behind a reverse proxy (issue #45). There is
// deliberately no wildcard or allow-all form: a blanket allow re-opens DNS
// rebinding (any attacker domain resolving to 127.0.0.1 would pass).
//
// A nil or empty policy is the loopback-only default; every method is
// nil-safe so handlers reached without Middleware (tests hitting srv.Mux
// directly) get the strict behavior.
type HostPolicy struct {
	extra map[string]struct{} // normalizeHost'd --allowed-host entries
}

// NewHostPolicy validates and normalizes --allowed-host entries. Entries are
// bare hostnames or IP literals (IPv6 optionally bracketed), matched exactly
// and case-insensitively; a trailing dot is ignored. Rejected: empty values,
// wildcards, ports, and anything URL-shaped — each is a likely
// misconfiguration that would otherwise silently never match (or worse,
// over-match).
func NewHostPolicy(entries []string) (*HostPolicy, error) {
	p := &HostPolicy{extra: map[string]struct{}{}}
	for _, raw := range entries {
		e := strings.TrimSpace(raw)
		if e == "" {
			return nil, fmt.Errorf("empty --allowed-host value")
		}
		if strings.Contains(e, "*") {
			return nil, fmt.Errorf("--allowed-host %q: wildcards are not supported (list each hostname)", raw)
		}
		if strings.Contains(e, "/") {
			return nil, fmt.Errorf("--allowed-host %q: expected a bare hostname, not a URL", raw)
		}
		h := normalizeHost(e)
		if net.ParseIP(h) == nil && !validHostname(h) {
			return nil, fmt.Errorf("--allowed-host %q: not a valid hostname or IP (ports are not accepted)", raw)
		}
		p.extra[h] = struct{}{}
	}
	return p, nil
}

// Hosts returns the normalized extra hostnames (for the startup warning).
func (p *HostPolicy) Hosts() []string {
	if p == nil {
		return nil
	}
	out := make([]string, 0, len(p.extra))
	for h := range p.extra {
		out = append(out, h)
	}
	return out
}

// normalizeHost lowercases, strips IPv6 brackets and one trailing dot.
// Callers strip the port first.
func normalizeHost(h string) string {
	h = strings.ToLower(h)
	h = strings.TrimPrefix(h, "[")
	h = strings.TrimSuffix(h, "]")
	return strings.TrimSuffix(h, ".")
}

// validHostname: dot-separated labels of [a-z0-9-], no leading/trailing '-',
// ≤63 bytes each, ≤253 total. Input is already lowercased.
func validHostname(h string) bool {
	if h == "" || len(h) > 253 {
		return false
	}
	for _, label := range strings.Split(h, ".") {
		if label == "" || len(label) > 63 || label[0] == '-' || label[len(label)-1] == '-' {
			return false
		}
		for i := 0; i < len(label); i++ {
			c := label[i]
			if !(c >= 'a' && c <= 'z' || c >= '0' && c <= '9' || c == '-') {
				return false
			}
		}
	}
	return true
}

func (p *HostPolicy) allowsExtra(host string) bool {
	if p == nil || len(p.extra) == 0 {
		return false
	}
	h := normalizeHost(host)
	if h == "" {
		return false
	}
	_, ok := p.extra[h]
	return ok
}

// AllowsHost reports whether a request Host header (host or host:port) is
// acceptable. The loopback comparison is the pre-#45 check, unchanged —
// exact "localhost" / "127.0.0.1" / "::1" after SplitHostPort — so the
// default policy is byte-identical to the old localhostOnly middleware.
func (p *HostPolicy) AllowsHost(hostHeader string) bool {
	host := hostHeader
	if h, _, err := net.SplitHostPort(host); err == nil {
		host = h
	}
	if host == "localhost" || host == "127.0.0.1" || host == "::1" {
		return true
	}
	return p.allowsExtra(host)
}

// AllowsOrigin reports whether a browser Origin header value is acceptable:
// loopback (isLocalOrigin) or an allow-listed hostname. Port and scheme are
// not compared — the proxy's public port is whatever it is. url.Parse's
// Hostname() defeats userinfo spoofs (`http://allowed@evil.com` → evil.com).
func (p *HostPolicy) AllowsOrigin(origin string) bool {
	if isLocalOrigin(origin) {
		return true
	}
	u, err := url.Parse(origin)
	if err != nil {
		return false
	}
	return p.allowsExtra(u.Hostname())
}

type hostPolicyKey struct{}

// rejectLogged gates the one-time "rejected Host" log line. Once per process,
// not per host — a rebinding page can retry in a loop and must not flood logs.
var rejectLogged atomic.Bool

// Middleware rejects requests whose Host isn't allowed (403 "forbidden") and
// stashes the policy in the request context so originAllowed applies the SAME
// list. Context, not a Server field: it wraps TabManager.Mux once, so tabs
// opened later (TabFactory) and the package-level config/state handlers are
// covered with no per-Server plumbing.
func (p *HostPolicy) Middleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !p.AllowsHost(r.Host) {
			if rejectLogged.CompareAndSwap(false, true) {
				log.Printf("rejected request with Host %q (behind a reverse proxy? see --allowed-host); further rejections are not logged", r.Host)
			}
			http.Error(w, "forbidden", http.StatusForbidden)
			return
		}
		next.ServeHTTP(w, r.WithContext(context.WithValue(r.Context(), hostPolicyKey{}, p)))
	})
}

// originAllowed is the cross-origin write gate for handlers reachable by a
// browser form/fetch. Missing Origin (curl, `lightjj api`, tests) → allowed;
// the Host gate already ran. Without Middleware in the chain the context has
// no policy → loopback only.
func originAllowed(r *http.Request) bool {
	origin := r.Header.Get("Origin")
	if origin == "" {
		return true
	}
	p, _ := r.Context().Value(hostPolicyKey{}).(*HostPolicy)
	return p.AllowsOrigin(origin)
}
