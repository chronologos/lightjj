package api

import (
	"bytes"
	"context"
	"errors"
	"io"
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

// --- sshWatchLoop tests ---------------------------------------------------
//
// sshWatchLoop's open() is injectable, so we can script the stream's behavior
// without any SSH or real inotify. fastClose/baseBackoff params let tests use
// ~ms timings without clock injection.

// openStep describes one open() call's behavior.
type openStep struct {
	err        error         // non-nil → open() returns this error
	lines      string        // written to pipe (newline-joined); "" = no events
	closeAfter time.Duration // hold pipe open this long before closing writer
}

// scriptedOpen returns an open() func that consumes steps in order. When
// steps are exhausted, open() blocks on ctx (simulates "stream stays open
// forever" — tests cancel ctx to exit). calls records total invocations.
func scriptedOpen(steps []openStep) (open func(context.Context) (io.ReadCloser, error), calls *atomic.Int32) {
	calls = &atomic.Int32{}
	var i atomic.Int32
	open = func(ctx context.Context) (io.ReadCloser, error) {
		calls.Add(1)
		idx := int(i.Add(1)) - 1
		if idx >= len(steps) {
			<-ctx.Done()
			return nil, ctx.Err()
		}
		step := steps[idx]
		if step.err != nil {
			return nil, step.err
		}
		r, w := io.Pipe()
		go func() {
			if step.lines != "" {
				_, _ = w.Write([]byte(step.lines))
			}
			time.Sleep(step.closeAfter)
			_ = w.Close()
		}()
		return r, nil
	}
	return open, calls
}

// newTestWatcher returns a Watcher wired to a Server whose refreshOpId() is
// a harmless no-op (MockRunner.Allow makes the CurrentOpId call always succeed).
// debounce=0 so fire() runs synchronously via AfterFunc(0, ...).
func newTestWatcher(t *testing.T) *Watcher {
	r := testutil.NewMockRunner(t)
	r.Allow(jj.CurrentOpId()).SetOutput([]byte("test-op"))
	srv := NewServer(r, "")
	w := newWatcher(srv)
	w.debounce = 0
	return w
}

// runLoop runs sshWatchLoop and waits for it to return, failing if it doesn't
// within the timeout. Returns captured log output.
func runLoop(t *testing.T, w *Watcher, open func(context.Context) (io.ReadCloser, error), timeout time.Duration) string {
	t.Helper()
	var logBuf bytes.Buffer
	oldOut := log.Writer()
	log.SetOutput(&logBuf)
	defer log.SetOutput(oldOut)

	done := make(chan struct{})
	go func() {
		w.sshWatchLoop(open, 20*time.Millisecond, 5*time.Millisecond)
		close(done)
	}()
	select {
	case <-done:
	case <-time.After(timeout):
		close(w.stop) // force the loop's ctx to cancel
		<-done
		t.Fatalf("sshWatchLoop did not exit within %v. log:\n%s", timeout, logBuf.String())
	}
	return logBuf.String()
}

func TestSSHWatchLoop_ToolMissing_BailsImmediately(t *testing.T) {
	w := newTestWatcher(t)
	// Stream closes immediately with no lines: inotify-tools not installed.
	open, calls := scriptedOpen([]openStep{{closeAfter: 0}})
	out := runLoop(t, w, open, 200*time.Millisecond)

	assert.EqualValues(t, 1, calls.Load())
	assert.Contains(t, out, "inotify-tools not installed")
}

func TestSSHWatchLoop_OpenErrorBeforeFirstLine_Bails(t *testing.T) {
	w := newTestWatcher(t)
	open, calls := scriptedOpen([]openStep{{err: errors.New("connection refused")}})
	out := runLoop(t, w, open, 200*time.Millisecond)

	assert.EqualValues(t, 1, calls.Load())
	assert.Contains(t, out, "auto-refresh disabled")
}

func TestSSHWatchLoop_FastCloseAfterEvents_BailsAtFive(t *testing.T) {
	w := newTestWatcher(t)
	// First step: healthy (yields line, holds open past fastClose → resets fastFails).
	// Then 5 fast-closes-no-line → bail on the 5th.
	steps := []openStep{{lines: "event\n", closeAfter: 30 * time.Millisecond}}
	for range 5 {
		steps = append(steps, openStep{closeAfter: 0})
	}
	open, calls := scriptedOpen(steps)
	out := runLoop(t, w, open, 500*time.Millisecond)

	assert.EqualValues(t, 6, calls.Load())
	assert.Contains(t, out, "died fast 5 times consecutively")
}

func TestSSHWatchLoop_OpenErrorAfterEvents_BailsAtFive(t *testing.T) {
	// This is the fix that just shipped: open-error after everSawLine now
	// counts toward fastFails (previously retried forever).
	w := newTestWatcher(t)
	errConn := errors.New("connection refused")
	steps := []openStep{{lines: "event\n", closeAfter: 30 * time.Millisecond}}
	for range 5 {
		steps = append(steps, openStep{err: errConn})
	}
	open, calls := scriptedOpen(steps)
	out := runLoop(t, w, open, 500*time.Millisecond)

	assert.EqualValues(t, 6, calls.Load())
	assert.Contains(t, out, "ssh open failed 5 times consecutively")
}

func TestSSHWatchLoop_LineResetsFastFails(t *testing.T) {
	// 4 fast-closes accumulate fastFails=4, then a healthy stream (yields
	// a line) resets to 0. Then 4 more fast-closes → still under limit.
	// The loop should NOT bail; we verify by checking all steps were consumed.
	// The reset stream yields a line (not just lives long) because backoff
	// also resets only on a line — otherwise exponential backoff runs past
	// the test budget.
	w := newTestWatcher(t)
	healthy := openStep{lines: "event\n", closeAfter: 30 * time.Millisecond}
	steps := []openStep{healthy} // everSawLine=true, backoff reset
	for range 4 {
		steps = append(steps, openStep{closeAfter: 0})
	}
	steps = append(steps, healthy) // resets both fastFails AND backoff
	for range 4 {
		steps = append(steps, openStep{closeAfter: 0})
	}
	// Final: scripted steps exhausted → open() blocks on ctx.
	open, calls := scriptedOpen(steps)

	var logBuf bytes.Buffer
	oldOut := log.Writer()
	log.SetOutput(&logBuf)
	defer log.SetOutput(oldOut)

	done := make(chan struct{})
	go func() {
		w.sshWatchLoop(open, 20*time.Millisecond, 5*time.Millisecond)
		close(done)
	}()
	// Poll until all scripted steps consumed (plus one blocking call).
	assert.Eventually(t, func() bool { return calls.Load() == 11 }, time.Second, 5*time.Millisecond)

	// Assert BEFORE teardown: close(w.stop) → ctx cancel → scriptedOpen
	// returns ctx.Err() → open-error branch → fastFails was 4 → bails.
	// That's expected teardown noise, not a failure of the reset logic.
	assert.NotContains(t, logBuf.String(), "times consecutively",
		"loop bailed during scripted steps; fastFails reset didn't work")

	close(w.stop)
	<-done
}

func TestSSHWatchLoop_LineResetsBackoffAndBroadcasts(t *testing.T) {
	w := newTestWatcher(t)
	// Subscribe so fire() actually broadcasts (hasSubscribers gate).
	ch, unsub := w.subscribe()
	defer unsub()

	// One healthy stream: yields two lines, holds open briefly, closes.
	open, _ := scriptedOpen([]openStep{
		{lines: "create\ncreate\n", closeAfter: 10 * time.Millisecond},
	})

	done := make(chan struct{})
	go func() {
		w.sshWatchLoop(open, 20*time.Millisecond, 5*time.Millisecond)
		close(done)
	}()

	// Should receive at least one broadcast (fire() → refreshOpId → "test-op").
	// With debounce=0, time.AfterFunc(0, fire) runs on the next scheduler tick.
	select {
	case got := <-ch:
		assert.Equal(t, "test-op", got)
	case <-time.After(200 * time.Millisecond):
		t.Fatal("no broadcast received")
	}

	close(w.stop)
	<-done
}

func TestSSHWatchLoop_CloseDuringBackoffSleep(t *testing.T) {
	// Exercise the ctx-cancel path in sleepCtx: healthy stream → stream
	// closes → enters backoff sleep → w.Close() cancels ctx → clean exit.
	w := newTestWatcher(t)
	open, calls := scriptedOpen([]openStep{
		{lines: "event\n", closeAfter: 10 * time.Millisecond},
	})

	done := make(chan struct{})
	go func() {
		// Longer baseBackoff so we have time to close during the sleep.
		w.sshWatchLoop(open, 20*time.Millisecond, 100*time.Millisecond)
		close(done)
	}()

	// Wait for stream to close and loop to enter backoff, then Close.
	assert.Eventually(t, func() bool { return calls.Load() == 1 }, 200*time.Millisecond, 5*time.Millisecond)
	time.Sleep(30 * time.Millisecond) // stream finished, now in backoff sleep
	close(w.stop)

	select {
	case <-done:
	case <-time.After(200 * time.Millisecond):
		t.Fatal("loop did not exit after Close during backoff")
	}
	// No second open() call — we cancelled during the sleep.
	assert.EqualValues(t, 1, calls.Load())
}

func TestSSHWatchLoop_TimerStoppedOnBail(t *testing.T) {
	// The defer at the top of sshWatchLoop stops any pending debounce timer.
	// Without it, AfterFunc would fire a broadcast post-bail. We verify no
	// broadcast arrives after the loop returns from a tool-missing bail.
	w := newTestWatcher(t)
	w.debounce = 100 * time.Millisecond // long enough that bail happens first
	ch, unsub := w.subscribe()
	defer unsub()

	// Stream yields a line (arms timer) then closes fast → bail path.
	// Wait — tool-missing bail requires !sawLine. Use the other bail path:
	// line seen (everSawLine=true), then 5 fast-closes.
	steps := []openStep{{lines: "event\n", closeAfter: 0}}
	for range 5 {
		steps = append(steps, openStep{closeAfter: 0})
	}
	open, _ := scriptedOpen(steps)

	done := make(chan struct{})
	go func() {
		w.sshWatchLoop(open, 20*time.Millisecond, 1*time.Millisecond)
		close(done)
	}()
	<-done // loop bailed

	// Timer was armed by the line but debounce=100ms. After bail, the defer
	// stops it. Wait past debounce; no broadcast should arrive.
	select {
	case v := <-ch:
		t.Fatalf("received broadcast after loop exit (timer leak): %q", v)
	case <-time.After(150 * time.Millisecond):
	}
}

