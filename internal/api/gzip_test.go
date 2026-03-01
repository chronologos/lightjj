package api

import (
	"compress/gzip"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

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
	// Lazy gzip.Writer init means no body bytes written (no gzip trailer).
	// Content-Encoding IS still set — cosmetically odd on 204 but browsers
	// don't care, and setting it pre-handler is required for http.ServeContent
	// to suppress Content-Length (see Gzip() comment).
	assert.Equal(t, 0, w.Body.Len())
}

func TestGzip_ServeContent(t *testing.T) {
	// http.ServeContent sets Content-Length from the file size. The middleware
	// must set Content-Encoding BEFORE the handler runs so ServeContent knows
	// to suppress that header (browser otherwise sees ERR_CONTENT_LENGTH_MISMATCH).
	payload := strings.Repeat("x", 1000)
	h := Gzip(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.ServeContent(w, r, "test.txt", time.Time{}, strings.NewReader(payload))
	}))

	req := httptest.NewRequest("GET", "/test.txt", nil)
	req.Header.Set("Accept-Encoding", "gzip")
	w := httptest.NewRecorder()
	h.ServeHTTP(w, req)

	assert.Equal(t, http.StatusOK, w.Code)
	assert.Equal(t, "gzip", w.Header().Get("Content-Encoding"))
	// ServeContent should NOT have set Content-Length (it checks Content-Encoding first).
	assert.Empty(t, w.Header().Get("Content-Length"))

	gr, err := gzip.NewReader(w.Body)
	require.NoError(t, err)
	decompressed, err := io.ReadAll(gr)
	require.NoError(t, err)
	assert.Equal(t, payload, string(decompressed))
}

func TestGzip_Unwrap(t *testing.T) {
	// Locks in that Unwrap() exists — ResponseController relies on it to reach
	// the underlying writer for SetWriteDeadline on the SSE path.
	gw := &gzipWriter{ResponseWriter: httptest.NewRecorder()}
	var _ interface{ Unwrap() http.ResponseWriter } = gw
	assert.NotNil(t, gw.Unwrap())
}
