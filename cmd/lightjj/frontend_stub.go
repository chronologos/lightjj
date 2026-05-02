//go:build !embed

// Default build (no -tags embed) ships without the bundled frontend so the
// binary remains `go install`-able from a bare module proxy clone (no pnpm).
// All paths return a small static page pointing the user at release binaries
// or a from-source build with -tags embed.

package main

import (
	"net/http"
	"strings"
)

const stubHTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<title>lightjj — frontend not bundled</title>
<style>
  body { font-family: system-ui, -apple-system, sans-serif; max-width: 640px; margin: 60px auto; padding: 0 20px; color: #2a2a2a; line-height: 1.55; }
  h1 { margin-top: 0; font-weight: 600; }
  code { background: #f1efe7; padding: 2px 6px; border-radius: 3px; font-size: 0.9em; }
  pre { background: #f1efe7; padding: 12px; border-radius: 6px; overflow-x: auto; font-size: 0.85em; line-height: 1.4; }
  a { color: #b06b00; }
  ol li { margin-bottom: 12px; }
</style>
</head><body>
<h1>lightjj — frontend not bundled</h1>
<p>This binary was built without the bundled web frontend, so it has nothing to serve at <code>/</code>. You probably installed it via <code>go install</code>, which fetches Go source only and skips the <code>pnpm</code> build.</p>
<p>Two ways to get a working install:</p>
<ol>
  <li><strong>Use a signed release binary</strong> (recommended) — these include the frontend and ship with SLSA build provenance attestations you can verify with <code>gh attestation verify</code>:<br>
    <a href="https://github.com/chronologos/lightjj/releases/latest">github.com/chronologos/lightjj/releases/latest</a></li>
  <li><strong>Build from source with the frontend embedded</strong>:
<pre><code>git clone https://github.com/chronologos/lightjj
cd lightjj/frontend &amp;&amp; pnpm install &amp;&amp; pnpm run build
cd .. &amp;&amp; go build -tags embed ./cmd/lightjj</code></pre>
  </li>
</ol>
</body></html>
`

func frontendHandler() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Asset/favicon requests have no useful stub; return 404 so the
		// browser doesn't render the help page as a stylesheet or image.
		if strings.HasPrefix(r.URL.Path, "/assets/") || strings.HasSuffix(r.URL.Path, ".svg") {
			http.NotFound(w, r)
			return
		}
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		w.Header().Set("Cache-Control", "no-store")
		w.Write([]byte(stubHTML))
	})
}
