package api

import (
	"bytes"
	"context"
	"errors"
	"log"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"

	"github.com/chronologos/lightjj/internal/jj"
	"github.com/chronologos/lightjj/testutil"
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

	// Fill the buffer (cap 4), then broadcast again — fifth should be dropped
	// without blocking. Buffer is 4 (not 1) so sentinel events aren't dropped
	// by a single buffered op-id.
	for i := range 4 {
		w.broadcast(string(rune('a' + i)))
	}
	done := make(chan struct{})
	go func() {
		w.broadcast("dropped")
		close(done)
	}()
	select {
	case <-done:
		// good — did not block
	case <-time.After(100 * time.Millisecond):
		t.Fatal("broadcast blocked on full buffer")
	}

	assert.Equal(t, "a", <-ch)
	assert.Equal(t, "b", <-ch)
	assert.Equal(t, "c", <-ch)
	assert.Equal(t, "d", <-ch)
	// Channel should now be empty; "dropped" was dropped.
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

func TestIsStaleWCError(t *testing.T) {
	// WorkingCopyStale (cli_util.rs:2734)
	assert.True(t, isStaleWCError(errors.New("Error: The working copy is stale (not updated since operation abc123).")))
	// ObjectNotFound (cli_util.rs:2762) — WC op was GC'd; same update-stale fix
	assert.True(t, isStaleWCError(errors.New("Error: Could not read working copy's operation.")))
	// SiblingOperation (cli_util.rs:2744) — different fix (jj op integrate), must NOT match
	assert.False(t, isStaleWCError(errors.New("The repo was loaded at operation abc, which seems to be a sibling of the working copy's operation def")))
	// Generic
	assert.False(t, isStaleWCError(errors.New("exit status 1: repo lock held")))
	assert.False(t, isStaleWCError(nil))
}

func TestHandleEvents_MetaEventSentinel(t *testing.T) {
	srv := &Server{cachedOp: "op-before"}
	watcher := &Watcher{
		srv:  srv,
		subs: make(map[chan string]struct{}),
		stop: make(chan struct{}),
	}

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	req := httptest.NewRequest("GET", "/api/events", nil).WithContext(ctx)
	rec := httptest.NewRecorder()

	done := make(chan struct{})
	go func() {
		watcher.handleEvents(rec, req)
		close(done)
	}()

	// Wait for subscriber to register, then broadcast the sentinel.
	deadline := time.Now().Add(1 * time.Second)
	for time.Now().Before(deadline) && !watcher.hasSubscribers() {
		time.Sleep(5 * time.Millisecond)
	}
	watcher.broadcast(evStaleWC)

	for time.Now().Before(deadline) {
		if bytes.Contains(rec.Body.Bytes(), []byte("event: stale-wc")) {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}

	cancel()
	<-done

	body := rec.Body.String()
	assert.Contains(t, body, "event: stale-wc\ndata: {}", "sentinel should emit as named SSE event")
	// Initial op-id still written (sentinel doesn't interfere with op path).
	assert.Contains(t, body, `"op_id":"op-before"`)
}

func TestHandleEvents_EmitsStaleStateOnConnect(t *testing.T) {
	// Both branches — true emits stale-wc, false emits fresh-wc. The false
	// branch matters: a client whose SSE dropped during staleness and
	// reconnected after CLI recovery would otherwise have workspaceStale
	// stuck true (the fresh-wc broadcast was sent while disconnected).
	for _, tc := range []struct {
		stale bool
		want  string
	}{
		{true, "event: stale-wc\ndata: {}"},
		{false, "event: fresh-wc\ndata: {}"},
	} {
		srv := &Server{cachedOp: "some-op"}
		watcher := &Watcher{
			srv:  srv,
			subs: make(map[chan string]struct{}),
			stop: make(chan struct{}),
		}
		watcher.stale.Store(tc.stale)

		ctx, cancel := context.WithCancel(context.Background())
		req := httptest.NewRequest("GET", "/api/events", nil).WithContext(ctx)
		rec := httptest.NewRecorder()

		done := make(chan struct{})
		go func() {
			watcher.handleEvents(rec, req)
			close(done)
		}()

		deadline := time.Now().Add(1 * time.Second)
		for time.Now().Before(deadline) {
			if bytes.Contains(rec.Body.Bytes(), []byte(tc.want)) {
				break
			}
			time.Sleep(10 * time.Millisecond)
		}
		cancel()
		<-done
		assert.Contains(t, rec.Body.String(), tc.want, "stale=%v", tc.stale)
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

// --- sshPollLoop tests ----------------------------------------------------
//
// sshPollLoop uses Runner.Run(CurrentOpId()) — MockRunner scripts the output
// sequence without any SSH. Short interval (~5ms) keeps tests fast.

// seqRunner returns successive outputs from a slice, then repeats the last.
// Not thread-safe — sshPollLoop calls Run() serially (one-at-a-time ticker).
// Embeds MockRunner only for interface satisfaction (RunWithInput, RunRaw,
// etc. — never called); its `t` field is nil, which would panic on
// findExpectation, but Run() is overridden so that path is unreachable.
type seqRunner struct {
	testutil.MockRunner
	outputs []string
	calls   atomic.Int32
}

func (r *seqRunner) Run(_ context.Context, _ []string) ([]byte, error) {
	n := int(r.calls.Add(1)) - 1
	if n >= len(r.outputs) {
		n = len(r.outputs) - 1
	}
	return []byte(r.outputs[n]), nil
}

func TestSSHPollLoop_BroadcastsOnChange(t *testing.T) {
	r := &seqRunner{outputs: []string{"op-aaa", "op-aaa", "op-bbb"}}
	srv := &Server{Runner: r}
	w := newWatcher(srv)
	ch, unsub := w.subscribe() // hasSubscribers gate
	defer unsub()

	done := make(chan struct{})
	go func() { w.sshPollLoop(5 * time.Millisecond); close(done) }()

	// First poll: "" → "op-aaa" = change → broadcast.
	select {
	case got := <-ch:
		assert.Equal(t, "op-aaa", got)
	case <-time.After(200 * time.Millisecond):
		t.Fatal("no first broadcast")
	}
	// Second poll returns same "op-aaa" → no broadcast. Third returns "op-bbb".
	select {
	case got := <-ch:
		assert.Equal(t, "op-bbb", got)
	case <-time.After(200 * time.Millisecond):
		t.Fatal("no second broadcast")
	}
	// cachedOp reflects the latest poll (direct write, not via refreshOpId).
	assert.Equal(t, "op-bbb", srv.getOpId())

	close(w.stop)
	<-done
}

func TestSSHPollLoop_NoSubscribers_NoPolls(t *testing.T) {
	r := &seqRunner{outputs: []string{"op-x"}}
	w := newWatcher(&Server{Runner: r})
	// No subscribe() — hasSubscribers() stays false.

	done := make(chan struct{})
	go func() { w.sshPollLoop(5 * time.Millisecond); close(done) }()

	time.Sleep(50 * time.Millisecond) // ~10 tick opportunities
	close(w.stop)
	<-done

	assert.Zero(t, r.calls.Load(), "polled with no subscribers")
}

func TestSSHPollLoop_StopsCleanly(t *testing.T) {
	r := testutil.NewMockRunner(t)
	r.Allow(jj.CurrentOpId()).SetOutput([]byte("op-x"))
	w := newWatcher(NewServer(r, ""))
	_, unsub := w.subscribe()
	defer unsub()

	done := make(chan struct{})
	go func() { w.sshPollLoop(5 * time.Millisecond); close(done) }()

	time.Sleep(20 * time.Millisecond)
	close(w.stop)

	select {
	case <-done:
	case <-time.After(100 * time.Millisecond):
		t.Fatal("sshPollLoop did not exit after Close")
	}
}

func TestSSHPollLoop_ErrorsDoNotBroadcastOrExit(t *testing.T) {
	// Poll failure → no broadcast, loop keeps running. Error-threshold
	// logging (3x, then every 12) is shared with snapshotLoop — trusted.
	r := testutil.NewMockRunner(t)
	r.Allow(jj.CurrentOpId()).SetError(errors.New("ssh timeout"))
	w := newWatcher(NewServer(r, ""))
	ch, unsub := w.subscribe()
	defer unsub()

	var logBuf bytes.Buffer
	oldOut := log.Writer()
	log.SetOutput(&logBuf)
	defer log.SetOutput(oldOut)

	done := make(chan struct{})
	go func() { w.sshPollLoop(5 * time.Millisecond); close(done) }()

	// Several failing polls — no broadcasts, loop stays alive.
	select {
	case v := <-ch:
		t.Fatalf("unexpected broadcast on error: %q", v)
	case <-time.After(30 * time.Millisecond):
	}

	close(w.stop)
	<-done
}

