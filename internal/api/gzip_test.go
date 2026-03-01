package api

import (
	"compress/gzip"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestGzip_Compresses(t *testing.T) {
	payload := strings.Repeat("hello world\n", 100)
	h := Gzip(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte(payload))
	}))

	req := httptest.NewRequest("GET", "/", nil)
	req.Header.Set("Accept-Encoding", "gzip")
	w := httptest.NewRecorder()
	h.ServeHTTP(w, req)

	assert.Equal(t, "gzip", w.Header().Get("Content-Encoding"))
	assert.Less(t, w.Body.Len(), len(payload), "compressed body should be smaller")

	gr, err := gzip.NewReader(w.Body)
	require.NoError(t, err)
	decompressed, err := io.ReadAll(gr)
	require.NoError(t, err)
	assert.Equal(t, payload, string(decompressed))
}

func TestGzip_SkipsWhenNotAccepted(t *testing.T) {
	h := Gzip(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte("plain"))
	}))

	req := httptest.NewRequest("GET", "/", nil)
	// No Accept-Encoding header
	w := httptest.NewRecorder()
	h.ServeHTTP(w, req)

	assert.Empty(t, w.Header().Get("Content-Encoding"))
	assert.Equal(t, "plain", w.Body.String())
}

func TestGzip_EmptyBody(t *testing.T) {
	h := Gzip(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusNoContent)
	}))

	req := httptest.NewRequest("GET", "/", nil)
	req.Header.Set("Accept-Encoding", "gzip")
	w := httptest.NewRecorder()
	h.ServeHTTP(w, req)

	assert.Equal(t, http.StatusNoContent, w.Code)
	// Lazy init means no body AND no Content-Encoding header on 204.
	assert.Equal(t, 0, w.Body.Len())
	assert.Empty(t, w.Header().Get("Content-Encoding"))
}

func TestGzip_Unwrap(t *testing.T) {
	// Locks in that Unwrap() exists — ResponseController relies on it to reach
	// the underlying writer for SetWriteDeadline on the SSE path.
	gw := &gzipWriter{ResponseWriter: httptest.NewRecorder()}
	var _ interface{ Unwrap() http.ResponseWriter } = gw
	assert.NotNil(t, gw.Unwrap())
}
