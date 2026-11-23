package api

import (
	"bytes"
	"context"
	"errors"
	"log"
	"net/http"
	"net/http/httptest"
	"slices"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/chronologos/lightjj/internal/jj"
	"github.com/chronologos/lightjj/testutil"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// next waits for a state-changed mark and returns the state a client would be sent.
func next(t *testing.T, w *Watcher, sub *subscriber) watchState {
	t.Helper()
	select {
	case <-sub.dirty:
		return w.state()
	case <-time.After(time.Second):
		t.Fatal("no state change")
		return watchState{}
	}
}

func quiet(t *testing.T, sub *subscriber, d time.Duration) {
	t.Helper()
	select {
	case <-sub.dirty:
		t.Fatal("unexpected state change")
	case <-time.After(d):
	}
}

func TestWatcher_NotifyReachesEverySubscriberAndNeverBlocks(t *testing.T) {
	w := newWatcher(&Server{cachedOp: "a"})
	s1, unsub1 := w.subscribe()
	defer unsub1()
	gone, unsubGone := w.subscribe()
	unsubGone()

	for range 100 { // nobody is reading
		w.notify()
	}
	w.srv.setOpId("z")
	assert.Equal(t, "z", next(t, w, s1).OpId, "the latest state, however many changes piled up")
	quiet(t, s1, 10*time.Millisecond)
	assert.Empty(t, gone.dirty)
}

func TestWatcher_NotifiesOnlyWhenHealthChanges(t *testing.T) {
	w := newWatcher(&Server{})
	sub, unsub := w.subscribe()
	defer unsub()

	w.setStale(true)
	assert.Equal(t, watchState{Stale: true}, next(t, w, sub))
	w.setStale(true)
	w.setPollFail("")
	quiet(t, sub, 5*time.Millisecond)
	w.setStale(false)
	w.setPollFail("locked")
	assert.Equal(t, watchState{PollError: "locked"}, next(t, w, sub))
	w.setPollFail("locked again") // text refinement: carried by the next write
	quiet(t, sub, 5*time.Millisecond)
	assert.Equal(t, "locked again", w.state().PollError)
	w.setPollFail("")
	assert.Equal(t, watchState{}, next(t, w, sub))
}

// What edges could not guarantee: writers racing, readers slow — the client ends up
// with the truth regardless.
func TestWatcher_ConcurrentWritersConverge(t *testing.T) {
	w := newWatcher(&Server{cachedOp: "op"})
	sub, unsub := w.subscribe()
	defer unsub()
	stop, seen := make(chan struct{}), make(chan watchState, 1)
	go func() {
		last := w.state()
		for {
			select {
			case <-sub.dirty:
				last = w.state()
			case <-stop:
				select {
				case <-sub.dirty:
					last = w.state()
				default:
				}
				seen <- last
				return
			}
		}
	}()
	var wg sync.WaitGroup
	for i := range 8 {
		wg.Go(func() {
			for j := range 200 {
				w.setStale((i+j)%2 == 0)
				w.setPollFail(strings.Repeat("x", (i+j)%3))
			}
		})
	}
	wg.Wait()
	close(stop)
	got := <-seen
	want := w.state()
	assert.Equal(t, want.Stale, got.Stale)
	assert.Equal(t, want.PollError == "", got.PollError == "")
}

func TestWatcher_NavigateDropsWhenFull(t *testing.T) {
	w := newWatcher(&Server{})
	assert.False(t, w.Navigate([]byte("{}")), "nobody listening")
	sub, unsub := w.subscribe()
	defer unsub()
	for range 20 {
		assert.True(t, w.Navigate([]byte("{}")))
	}
	assert.Len(t, sub.nav, cap(sub.nav))
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

// Watchers constructed for servers at the same canonical repo path share one
// snapshot-pause counter (resolved at construction via pauseCounterFor) — a
// mutation in one tab must pause snapshots in every tab pointed at the same
// working copy. Different paths get independent counters; no path (tests,
// no repo) gets a private one.
func TestWatcher_SharedPauseCounterByPath(t *testing.T) {
	mk := func(repoDir string) *Server {
		s := &Server{RepoDir: repoDir}
		s.Watcher = newWatcher(s)
		return s
	}
	a := mk("/watcher-test/repo/one")
	b := mk("/watcher-test/repo/one")
	c := mk("/watcher-test/repo/two")
	d := mk("") // no path → private counter

	require.Same(t, a.Watcher.snapshotPaused, b.Watcher.snapshotPaused, "same-path watchers must share counter")
	require.NotSame(t, a.Watcher.snapshotPaused, c.Watcher.snapshotPaused)
	require.NotSame(t, a.Watcher.snapshotPaused, d.Watcher.snapshotPaused)

	resume := a.pauseSnapshot()
	assert.EqualValues(t, 1, b.Watcher.snapshotPaused.Load(), "pause via server A must pause same-path server B")
	assert.EqualValues(t, 0, c.Watcher.snapshotPaused.Load())

	ran, _ := b.trySnapshot(context.Background())
	assert.False(t, ran, "B's trySnapshot must skip while A's mutation is in flight")

	resume()
	assert.EqualValues(t, 0, b.Watcher.snapshotPaused.Load())
}

// safeRecorder is a goroutine-safe http.ResponseWriter for SSE handler tests.
// httptest.ResponseRecorder.Body is a bare bytes.Buffer — polling it while
// handleEvents writes from its goroutine is a data race (-race flags it on
// every TestHandleEvents_* below). Implements http.Flusher (handleEvents
// type-asserts it at the top of the handler).
type safeRecorder struct {
	mu   sync.Mutex
	hdr  http.Header
	body bytes.Buffer
}

func newSafeRecorder() *safeRecorder        { return &safeRecorder{hdr: make(http.Header)} }
func (r *safeRecorder) Header() http.Header { return r.hdr }
func (r *safeRecorder) WriteHeader(int)     {}
func (r *safeRecorder) Flush()              {}
func (r *safeRecorder) Write(p []byte) (int, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.body.Write(p)
}
func (r *safeRecorder) String() string {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.body.String()
}

func TestHandleEvents_StateOnConnectAndOnChange(t *testing.T) {
	w := newWatcher(&Server{cachedOp: "op-1"})
	w.setPollFail("blocked")
	ctx, cancel := context.WithCancel(context.Background())
	rec, done := newSafeRecorder(), make(chan struct{})
	go func() {
		w.handleEvents(rec, httptest.NewRequest("GET", "/api/events", nil).WithContext(ctx))
		close(done)
	}()
	sees := func(want string) {
		t.Helper()
		assert.Eventually(t, func() bool { return strings.Contains(rec.String(), want) }, time.Second, 5*time.Millisecond, want)
	}
	// Both halves matter on connect: a client that was away must learn of recovery
	// as well as of trouble, so everything is always present.
	sees("event: state\ndata: {\"op_id\":\"op-1\",\"stale\":false,\"poll_error\":\"blocked\"}\n\n")
	w.setPollFail("")
	sees(`{"op_id":"op-1","stale":false,"poll_error":""}`)
	w.setStale(true)
	sees(`{"op_id":"op-1","stale":true,"poll_error":""}`)
	w.srv.setOpId("op-2")
	w.notify()
	sees(`{"op_id":"op-2","stale":true,"poll_error":""}`)
	w.Navigate([]byte(`{"change_id":"abc"}`))
	sees("event: nav\ndata: {\"change_id\":\"abc\"}\n\n")
	cancel()
	<-done
}

func TestHandleEventsDisabled(t *testing.T) {
	req := httptest.NewRequest("GET", "/api/events", nil)
	w := httptest.NewRecorder()
	handleEventsDisabled(w, req)
	assert.Equal(t, http.StatusNoContent, w.Code)
}

// handleEvents sends the state on connect. If cachedOp is empty (read-only
// session — no mutations to advance it), handleEvents must refresh so the
// frontend's everSawEvent gets set. Without this, first SSE drop = permanent
// auto-refresh loss (api.ts:~311 gives up immediately if everSawEvent=false).
func TestHandleEvents_SendsInitialOpIdOnConnect(t *testing.T) {
	for _, tc := range []struct {
		name   string
		cached string
		runner bool // seed a MockRunner that returns "fetched-op"
		wantOp string
	}{
		// Cached value present — send directly, no refresh.
		{"cached", "cached-op", false, "cached-op"},
		// Cached empty — handleEvents refreshes via Runner (the read-only
		// session path). Previously this skipped the event entirely.
		{"empty-refreshes", "", true, "fetched-op"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			srv := &Server{cachedOp: tc.cached}
			if tc.runner {
				r := testutil.NewMockRunner(t)
				r.Expect(jj.CurrentOpId()).SetOutput([]byte(tc.wantOp))
				defer r.Verify()
				srv.Runner = r
			}
			watcher := newWatcher(srv)

			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			req := httptest.NewRequest("GET", "/api/events", nil).WithContext(ctx)
			rec := newSafeRecorder()

			done := make(chan struct{})
			go func() { watcher.handleEvents(rec, req); close(done) }()

			assert.Eventually(t, func() bool {
				return strings.Contains(rec.String(), tc.wantOp)
			}, time.Second, 10*time.Millisecond)
			cancel()
			<-done

			body := rec.String()
			assert.Contains(t, body, "event: state")
			assert.Contains(t, body, `"op_id":"`+tc.wantOp+`"`)
		})
	}
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
// sshPollLoop uses Runner.Run(PollOpId()) — MockRunner scripts the output
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
	// Optional per-call hook fired BEFORE returning output. Used by CAS tests
	// to simulate a concurrent runMutation advancing the op-id cache mid-SSH-call.
	hook func(callIdx int)

	mu      sync.Mutex
	argsLog [][]string
}

func (r *seqRunner) Run(_ context.Context, args []string) ([]byte, error) {
	r.mu.Lock()
	r.argsLog = append(r.argsLog, args)
	r.mu.Unlock()
	n := int(r.calls.Add(1)) - 1
	if n >= len(r.outputs) {
		n = len(r.outputs) - 1
	}
	if r.hook != nil {
		r.hook(n)
	}
	return []byte(r.outputs[n]), nil
}

func (r *seqRunner) lastArgs() []string {
	r.mu.Lock()
	defer r.mu.Unlock()
	if len(r.argsLog) == 0 {
		return nil
	}
	return r.argsLog[len(r.argsLog)-1]
}

func TestSSHPollLoop_BroadcastsOnChange(t *testing.T) {
	r := &seqRunner{outputs: []string{"op-aaa", "op-aaa", "op-bbb"}}
	srv := &Server{Runner: r}
	w := newWatcher(srv)
	sub, unsub := w.subscribe() // hasSubscribers gate
	defer unsub()

	done := make(chan struct{})
	go func() { w.sshPollLoop(5 * time.Millisecond); close(done) }()

	// First poll: "" → "op-aaa" = change → broadcast.
	assert.Equal(t, "op-aaa", next(t, w, sub).OpId)
	// Second poll returns same "op-aaa" → no broadcast. Third returns "op-bbb".
	assert.Equal(t, "op-bbb", next(t, w, sub).OpId)
	// Cached op-id reflects the latest poll (direct cache write, not via refreshOpId).
	assert.Equal(t, "op-bbb", srv.getOpId())

	close(w.stop)
	<-done
}

// Between-tick mutation: runMutation advances the op-id cache BETWEEN poll
// ticks (not during the SSH call). The next poll returns the same value the
// cache already has (remote state matches). Mutating tab got the X-JJ-Op-Id
// header; non-mutating tabs rely on SSE broadcast. Comparing against
// lastBroadcast (local — what WE last sent) not preCached (shared — reflects
// the mutation) is what lets the poll detect and broadcast this. The CAS fix's
// first cut collapsed these → bug_017 (between-tick mutations silently dropped).
func TestSSHPollLoop_BroadcastsBetweenTickMutation(t *testing.T) {
	// Cache starts at B (already advanced by a mutation's refreshOpId).
	// Poll returns B (remote matches). preCached=B (reads shared), opId=B →
	// opId==preCached would skip. lastBroadcast="" (we never broadcast yet)
	// → opId!=lastBroadcast → emit.
	srv := &Server{}
	srv.setOpId("op-B") // already advanced by a mutation's refreshOpId

	r := &seqRunner{outputs: []string{"op-B", "op-B"}} // poll returns what the cache already holds
	srv.Runner = r

	w := newWatcher(srv)
	sub, unsub := w.subscribe()
	defer unsub()
	done := make(chan struct{})
	go func() { w.sshPollLoop(5 * time.Millisecond); close(done) }()

	// Must broadcast B — lastBroadcast="" so opId!=lastBroadcast. The CAS
	// (cache==preCached, both B) passes, write is a no-op (B→B), broadcast B.
	assert.Equal(t, "op-B", next(t, w, sub).OpId, "between-tick mutation must broadcast to other tabs")

	close(w.stop)
	<-done
}

// sshPollLoop CAS: if a concurrent runMutation advances the op-id cache while
// the poll's SSH call is in flight (returning a value captured BEFORE the
// mutation), the poll must not regress the cache. Previously the unconditional
// write would overwrite the mutation's fresher value with the poll's stale
// snapshot (~18% probability per mutation: 880ms/5000ms). The CAS (casOpId)
// compares against pre-poll cache value; mismatch = concurrent advance → skip
// write, broadcast the advanced value so non-mutating clients still refresh.
func TestSSHPollLoop_CASGuardsConcurrentAdvance(t *testing.T) {
	srv := &Server{}
	srv.setOpId("op-A") // seeded (handleEvents refresh, or prior poll)

	// Poll 0: preCached=A, SSH call starts; DURING the call, a "mutation"
	//         (hook) advances the cache to C. SSH returns B (captured between
	//         A and C — a CLI mutation on the remote). CAS: cache==A? →
	//         no (it's C) → don't write B. Broadcast C (the fresher value).
	// Poll 1: preCached=C, SSH returns C (remote caught up). No change, skip.
	r := &seqRunner{
		outputs: []string{"op-B", "op-C"},
		hook: func(i int) {
			if i == 0 {
				srv.setOpId("op-C") // concurrent runMutation's refreshOpId
			}
		},
	}
	srv.Runner = r

	w := newWatcher(srv)
	sub, unsub := w.subscribe()
	defer unsub()
	done := make(chan struct{})
	go func() { w.sshPollLoop(5 * time.Millisecond); close(done) }()

	// First broadcast is C (the advanced value), NOT B (the stale poll result).
	assert.Equal(t, "op-C", next(t, w, sub).OpId, "must broadcast advanced value, not stale poll result")
	// Cache NOT regressed to B.
	assert.Equal(t, "op-C", srv.getOpId())

	// Poll 1 returns C == cache → no broadcast.
	quiet(t, sub, 20*time.Millisecond)

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

func TestSSHPollLoop_PausedFallsBackToCurrentOpId(t *testing.T) {
	r := &seqRunner{outputs: []string{"op-x"}}
	srv := &Server{Runner: r}
	w := newWatcher(srv)
	srv.Watcher = w
	_, unsub := w.subscribe()
	defer unsub()

	resume := srv.pauseSnapshot()
	done := make(chan struct{})
	go func() { w.sshPollLoop(5 * time.Millisecond); close(done) }()

	assert.Eventually(t, func() bool { return r.calls.Load() > 0 }, time.Second, 5*time.Millisecond)
	assert.Equal(t, jj.CurrentOpId(), r.lastArgs(), "paused: must use --ignore-working-copy variant")

	resume()
	assert.Eventually(t, func() bool {
		r.mu.Lock()
		defer r.mu.Unlock()
		for _, a := range r.argsLog {
			if slices.Equal(a, jj.PollOpId()) {
				return true
			}
		}
		return false
	}, time.Second, 5*time.Millisecond, "resumed: must switch back to PollOpId")

	close(w.stop)
	<-done
}

func TestSSHPollLoop_PausedDoesNotClearStale(t *testing.T) {
	r := &seqRunner{outputs: []string{"op-x"}}
	srv := &Server{Runner: r}
	w := newWatcher(srv)
	srv.Watcher = w
	w.stale.Store(true)
	_, unsub := w.subscribe()
	defer unsub()

	resume := srv.pauseSnapshot()
	defer resume()
	done := make(chan struct{})
	go func() { w.sshPollLoop(5 * time.Millisecond); close(done) }()

	assert.Eventually(t, func() bool { return r.calls.Load() > 2 }, time.Second, 5*time.Millisecond)
	assert.True(t, w.stale.Load(), "CurrentOpId success must not clear stale (it has --ignore-working-copy)")

	close(w.stop)
	<-done
}

func TestPauseSnapshot_NestedCounter(t *testing.T) {
	srv := &Server{}
	srv.Watcher = newWatcher(srv)
	r1 := srv.pauseSnapshot()
	r2 := srv.pauseSnapshot()
	assert.EqualValues(t, 2, srv.Watcher.snapshotPaused.Load())
	r1()
	assert.EqualValues(t, 1, srv.Watcher.snapshotPaused.Load(), "first resume must not unpause overlapping mutation")
	r1() // double-call must be safe (sync.Once)
	assert.EqualValues(t, 1, srv.Watcher.snapshotPaused.Load(), "non-idempotent resume would steal r2's count")
	r2()
	assert.EqualValues(t, 0, srv.Watcher.snapshotPaused.Load())
}

func TestPauseSnapshot_WatchdogReleases(t *testing.T) {
	old := snapshotPauseMax
	snapshotPauseMax = 20 * time.Millisecond
	defer func() { snapshotPauseMax = old }()

	srv := &Server{}
	srv.Watcher = newWatcher(srv)
	resume := srv.pauseSnapshot()
	assert.EqualValues(t, 1, srv.Watcher.snapshotPaused.Load())
	assert.Eventually(t, func() bool { return srv.Watcher.snapshotPaused.Load() == 0 },
		time.Second, 5*time.Millisecond, "watchdog must release a hung mutation's pause")
	resume() // must not double-decrement (Once)
	assert.EqualValues(t, 0, srv.Watcher.snapshotPaused.Load())
}

func TestTrySnapshot_SkipsWhenPaused(t *testing.T) {
	r := &seqRunner{outputs: []string{""}}
	srv := &Server{Runner: r}
	srv.Watcher = newWatcher(srv)

	resume := srv.pauseSnapshot()
	ran, err := srv.trySnapshot(context.Background())
	assert.False(t, ran)
	assert.NoError(t, err)
	assert.Zero(t, r.calls.Load())

	resume()
	ran, _ = srv.trySnapshot(context.Background())
	assert.True(t, ran)
	assert.Equal(t, jj.DebugSnapshot(), r.lastArgs())
}

func TestSSHPollLoop_StopsCleanly(t *testing.T) {
	r := testutil.NewMockRunner(t)
	r.Allow(jj.PollOpId()).SetOutput([]byte("op-x"))
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

func TestSSHPollLoop_ErrorsDoNotBroadcastBelowThreshold(t *testing.T) {
	// Below pollFailThreshold, failures are absorbed silently: no broadcast,
	// loop keeps running. Transient contention (repo lock, SSH blip) should
	// not surface a UI warning.
	r := testutil.NewMockRunner(t)
	r.Allow(jj.PollOpId()).SetError(errors.New("ssh timeout"))
	w := newWatcher(NewServer(r, ""))
	sub, unsub := w.subscribe()
	defer unsub()

	var logBuf bytes.Buffer
	oldOut := log.Writer()
	log.SetOutput(&logBuf)
	defer log.SetOutput(oldOut)

	done := make(chan struct{})
	go func() { w.sshPollLoop(5 * time.Millisecond); close(done) }()

	// ~3 ticks in 15ms — below pollFailThreshold (5).
	quiet(t, sub, 15*time.Millisecond)

	close(w.stop)
	<-done
}

func TestSSHPollLoop_BroadcastsPollFailAtThreshold(t *testing.T) {
	// At pollFailThreshold consecutive errors, broadcast pollfail carrying
	// the error text. Edge-triggered: subsequent errors keep updating the
	// error text but don't re-broadcast until recovery → re-failure.
	r := testutil.NewMockRunner(t)
	r.Allow(jj.PollOpId()).SetError(errors.New("index.lock could not be acquired"))
	w := newWatcher(NewServer(r, ""))
	sub, unsub := w.subscribe()
	defer unsub()

	var logBuf bytes.Buffer
	oldOut := log.Writer()
	log.SetOutput(&logBuf)
	defer log.SetOutput(oldOut)

	done := make(chan struct{})
	go func() { w.sshPollLoop(3 * time.Millisecond); close(done) }()

	// Wait for pollFailThreshold (5) ticks: ~15ms + headroom. First event
	// should be pollfail with the error payload.
	assert.Equal(t, "index.lock could not be acquired", next(t, w, sub).PollError)

	close(w.stop)
	<-done
}

func TestNewSSHWatcher_IntervalZero(t *testing.T) {
	// --snapshot-interval 0 must not start the loop. Parity with local
	// mode's snapshotLoop gate in start(). Also prevents time.NewTicker(0)
	// panic. MockRunner has no expectations — any Run() call (from a tick)
	// would t.Fatalf on unexpected command.
	r := testutil.NewMockRunner(t)
	defer r.Verify()
	w := NewSSHWatcher(NewServer(r, ""), 0)
	_, unsub := w.subscribe() // subscriber present → would poll if loop was running
	defer unsub()
	time.Sleep(20 * time.Millisecond)
	close(w.stop)
}

// scriptedRunner returns a scripted sequence of (output, error) pairs. Unlike
// seqRunner (success-only), this lets a test drive a loop through
// failure→stale→recovery state transitions in order.
type scriptedRunner struct {
	testutil.MockRunner
	steps []struct {
		out string
		err error
	}
	calls atomic.Int32
}

func (r *scriptedRunner) Run(_ context.Context, args []string) ([]byte, error) {
	n := int(r.calls.Add(1)) - 1
	if n >= len(r.steps) {
		n = len(r.steps) - 1
	}
	return []byte(r.steps[n].out), r.steps[n].err
}

func TestSSHPollLoop_StaleInterludeDoesNotLeavePollFailedStuck(t *testing.T) {
	// Regression: stale-WC after a pollfail streak was leaving pollFailed
	// stuck forever. Counter-gated success-branch clear (`consecutiveErrors
	// >= pollFailThreshold`) never fired because stale-WC branch reset the
	// counter to 0 → next success checked `0 >= 5` = false → no clear.
	// The discipline now lives in probeTracker: ok()/staleWC() clear
	// poll-fail unconditionally.
	// Sequence: 5 generic errors (→ pollfail broadcast) → 1 stale-WC
	// (counter zeroed) → successful poll (must clear pollFailed).
	r := &scriptedRunner{steps: []struct {
		out string
		err error
	}{
		{"", errors.New("ssh timeout")},
		{"", errors.New("ssh timeout")},
		{"", errors.New("ssh timeout")},
		{"", errors.New("ssh timeout")},
		{"", errors.New("ssh timeout")},
		{"", errors.New("Error: The working copy is stale (not updated since operation abc).")},
		{"op-fresh", nil},
	}}
	w := newWatcher(NewServer(r, ""))
	sub, unsub := w.subscribe()
	defer unsub()

	done := make(chan struct{})
	go func() { w.sshPollLoop(3 * time.Millisecond); close(done) }()

	// Trouble is reported, and it doesn't outlive the recovery.
	var failed bool
	for !failed || w.pollError() != "" {
		failed = next(t, w, sub).PollError != "" || failed
	}
	assert.Eventually(t, func() bool { return w.state().PollError == "" && !w.state().Stale }, time.Second, time.Millisecond, "pollFailed must not remain stuck after stale interlude")
	close(w.stop)
	<-done
}

// snapshotLoop shares probeTracker with sshPollLoop, so the same stale-
// interlude regression is locked on the local-mode loop too: a pollfail
// streak followed by a stale-WC snapshot followed by a successful snapshot
// must end with pollFailed=false.
func TestSnapshotLoop_StaleInterludeDoesNotLeavePollFailedStuck(t *testing.T) {
	r := &scriptedRunner{steps: []struct {
		out string
		err error
	}{
		{"", errors.New("repo lock held")},
		{"", errors.New("repo lock held")},
		{"", errors.New("repo lock held")},
		{"", errors.New("repo lock held")},
		{"", errors.New("repo lock held")},
		{"", errors.New("Error: The working copy is stale (not updated since operation abc).")},
		{"", nil},
	}}
	srv := &Server{Runner: r}
	w := newWatcher(srv)
	srv.Watcher = w // trySnapshot consults srv.Watcher.snapshotPaused
	sub, unsub := w.subscribe()
	defer unsub()

	var logBuf bytes.Buffer
	oldOut := log.Writer()
	log.SetOutput(&logBuf)
	defer log.SetOutput(oldOut)

	done := make(chan struct{})
	go func() { w.snapshotLoop(3 * time.Millisecond); close(done) }()

	// Trouble is reported, and it doesn't outlive the recovery.
	var failed bool
	for !failed || w.pollError() != "" {
		failed = next(t, w, sub).PollError != "" || failed
	}
	assert.Eventually(t, func() bool { return w.state().PollError == "" && !w.state().Stale }, time.Second, time.Millisecond, "pollFailed must not remain stuck after stale interlude")
	close(w.stop)
	<-done
}

func TestSSHPollLoop_StaleWCSentinel(t *testing.T) {
	// sshPollLoop snapshots (PollOpId without --ignore-working-copy), so it
	// can hit stale-WC. Same routing as snapshotLoop (shared via
	// probeTracker).
	// seqRunner can't script errors, so use MockRunner with a stale-WC-
	// matching string (isStaleWCError matches on message content).
	r := testutil.NewMockRunner(t)
	r.Allow(jj.PollOpId()).SetError(errors.New("Error: The working copy is stale (not updated since operation abc)."))
	w := newWatcher(NewServer(r, ""))
	sub, unsub := w.subscribe()
	defer unsub()

	done := make(chan struct{})
	go func() { w.sshPollLoop(5 * time.Millisecond); close(done) }()

	assert.True(t, next(t, w, sub).Stale)
	// Subsequent stale errors change nothing.
	quiet(t, sub, 20*time.Millisecond)
	assert.True(t, w.stale.Load())

	close(w.stop)
	<-done
}
