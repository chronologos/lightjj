package api

import (
	"bytes"
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
)

func TestWatcher_SubscribeBroadcast(t *testing.T) {
	w := &Watcher{
		subs: make(map[chan string]struct{}),
	}

	ch1, unsub1 := w.subscribe()
	ch2, unsub2 := w.subscribe()
	defer unsub1()
	defer unsub2()

	w.broadcast("abc123")

	select {
	case got := <-ch1:
		assert.Equal(t, "abc123", got)
	case <-time.After(100 * time.Millisecond):
		t.Fatal("ch1 did not receive broadcast")
	}
	select {
	case got := <-ch2:
		assert.Equal(t, "abc123", got)
	case <-time.After(100 * time.Millisecond):
		t.Fatal("ch2 did not receive broadcast")
	}
}

func TestWatcher_BroadcastDropsOnFullBuffer(t *testing.T) {
	w := &Watcher{subs: make(map[chan string]struct{})}
	ch, unsub := w.subscribe()
	defer unsub()

	// Fill the buffer (cap 1), then broadcast again — second should be dropped
	// without blocking.
	w.broadcast("first")
	done := make(chan struct{})
	go func() {
		w.broadcast("second")
		close(done)
	}()
	select {
	case <-done:
		// good — did not block
	case <-time.After(100 * time.Millisecond):
		t.Fatal("broadcast blocked on full buffer")
	}

	assert.Equal(t, "first", <-ch)
	// Channel should now be empty; second was dropped.
	select {
	case v := <-ch:
		t.Fatalf("expected empty channel, got %q", v)
	default:
	}
}

func TestWatcher_UnsubscribeStopsDelivery(t *testing.T) {
	w := &Watcher{subs: make(map[chan string]struct{})}
	ch, unsub := w.subscribe()
	unsub()

	w.broadcast("abc")
	select {
	case v := <-ch:
		t.Fatalf("received after unsubscribe: %q", v)
	default:
	}
}

func TestWatcher_BroadcastEmptyIsNoop(t *testing.T) {
	w := &Watcher{subs: make(map[chan string]struct{})}
	ch, unsub := w.subscribe()
	defer unsub()

	w.broadcast("")
	select {
	case v := <-ch:
		t.Fatalf("empty broadcast delivered: %q", v)
	default:
	}
}

func TestHandleEventsDisabled(t *testing.T) {
	req := httptest.NewRequest("GET", "/api/events", nil)
	w := httptest.NewRecorder()
	handleEventsDisabled(w, req)
	assert.Equal(t, http.StatusNoContent, w.Code)
}

func TestHandleEvents_SendsInitialOpIdOnConnect(t *testing.T) {
	srv := &Server{cachedOp: "initial-op-id"}
	watcher := &Watcher{
		srv:  srv,
		subs: make(map[chan string]struct{}),
	}

	// Use a cancellable context so the handler returns after we've checked
	// the initial write.
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	req := httptest.NewRequest("GET", "/api/events", nil).WithContext(ctx)
	rec := httptest.NewRecorder()

	done := make(chan struct{})
	go func() {
		watcher.handleEvents(rec, req)
		close(done)
	}()

	// Give the handler time to write the initial event. httptest.Recorder is
	// not a real streaming writer, so we poll the buffer.
	deadline := time.Now().Add(1 * time.Second)
	for time.Now().Before(deadline) {
		if bytes.Contains(rec.Body.Bytes(), []byte("initial-op-id")) {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}

	cancel()
	<-done

	body := rec.Body.String()
	assert.Contains(t, body, "event: op")
	assert.Contains(t, body, `"op_id":"initial-op-id"`)
}

func TestServerEventsRoute_NilWatcher(t *testing.T) {
	// Server with no watcher (SSH mode) should return 204.
	srv := NewServer(nil, "")
	req := httptest.NewRequest("GET", "/api/events", nil)
	w := httptest.NewRecorder()
	srv.Mux.ServeHTTP(w, req)
	assert.Equal(t, http.StatusNoContent, w.Code)
}
