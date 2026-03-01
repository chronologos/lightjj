package api

import (
	"compress/gzip"
	"net/http"
	"strings"
)

// gzipWriter wraps ResponseWriter to transparently compress the body.
// Lazy init in Write so 204/304 stay empty and don't advertise gzip encoding.
type gzipWriter struct {
	http.ResponseWriter
	gz *gzip.Writer
}

func (w *gzipWriter) Write(b []byte) (int, error) {
	if w.gz == nil {
		w.Header().Set("Content-Encoding", "gzip")
		w.Header().Del("Content-Length")
		w.gz = gzip.NewWriter(w.ResponseWriter)
	}
	return w.gz.Write(b)
}

// Unwrap lets http.ResponseController reach the underlying writer. Without
// this, the SSE handler's SetWriteDeadline(time.Time{}) fails silently and
// main.go's 120s WriteTimeout kills SSE connections every 2 minutes.
func (w *gzipWriter) Unwrap() http.ResponseWriter {
	return w.ResponseWriter
}

// Flush supports SSE streaming — handleEvents type-asserts to http.Flusher
// and calls Flush() after each event write. gzip's Flush() emits a sync block
// that browsers decompress incrementally.
func (w *gzipWriter) Flush() {
	if w.gz != nil {
		w.gz.Flush()
	}
	if f, ok := w.ResponseWriter.(http.Flusher); ok {
		f.Flush()
	}
}

func (w *gzipWriter) close() {
	if w.gz != nil {
		w.gz.Close()
	}
}

// Gzip wraps a handler with transparent response compression when the client
// advertises Accept-Encoding: gzip. Primarily benefits SSH proxy mode where
// diff/log payloads traverse the network uncompressed otherwise.
func Gzip(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !strings.Contains(r.Header.Get("Accept-Encoding"), "gzip") {
			next.ServeHTTP(w, r)
			return
		}
		gw := &gzipWriter{ResponseWriter: w}
		defer gw.close()
		next.ServeHTTP(gw, r)
	})
}
