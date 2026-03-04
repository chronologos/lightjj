// Package testutil provides test helpers, modeled on jjui's test/ package.
package testutil

import (
	"bytes"
	"context"
	"io"
	"slices"
	"strings"
	"sync"
	"testing"
)

// ExpectedCommand represents a command we expect the runner to execute.
type ExpectedCommand struct {
	args       []string
	output     []byte
	called     bool
	err        error
	wantStdin  string
	gotStdin   string
	checkStdin bool
}

func (e *ExpectedCommand) SetOutput(output []byte) *ExpectedCommand {
	e.output = output
	return e
}

func (e *ExpectedCommand) SetError(err error) *ExpectedCommand {
	e.err = err
	return e
}

// SetExpectedStdin sets the expected stdin value for RunWithInput calls.
// Verify() will assert that the actual stdin matches.
// Only valid on Expect'd commands — Allow'd commands do not verify stdin.
func (e *ExpectedCommand) SetExpectedStdin(s string) *ExpectedCommand {
	e.wantStdin = s
	e.checkStdin = true
	return e
}

// AllowedCommand is returned by Allow() and supports SetOutput/SetError but not SetExpectedStdin.
type AllowedCommand struct {
	cmd *ExpectedCommand
}

func (a *AllowedCommand) SetOutput(output []byte) *AllowedCommand {
	a.cmd.output = output
	return a
}

func (a *AllowedCommand) SetError(err error) *AllowedCommand {
	a.cmd.err = err
	return a
}

// MockRunner implements runner.CommandRunner with expectation-based verification.
// Pattern ported from jjui's test.CommandRunner.
// Not safe for concurrent use from multiple goroutines.
type MockRunner struct {
	t            *testing.T
	expectations map[string][]*ExpectedCommand
	allowed      map[string]*ExpectedCommand // optional commands keyed by full args string
	mu           sync.Mutex
}

func NewMockRunner(t *testing.T) *MockRunner {
	return &MockRunner{
		t:            t,
		expectations: make(map[string][]*ExpectedCommand),
		allowed:      make(map[string]*ExpectedCommand),
	}
}

// Allow registers a command that may be called zero or more times without
// being required. Matches by full args (not just subcommand).
// Returns AllowedCommand which does not expose SetExpectedStdin.
func (m *MockRunner) Allow(args []string) *AllowedCommand {
	if len(args) == 0 {
		m.t.Fatal("Allow: empty args")
	}
	e := &ExpectedCommand{args: slices.Clone(args), called: true} // pre-marked so Verify won't complain
	m.allowed[strings.Join(args, "\x00")] = e
	return &AllowedCommand{cmd: e}
}

// Expect registers an expected command. Returns the expectation for chaining.
func (m *MockRunner) Expect(args []string) *ExpectedCommand {
	subCmd := args[0]
	e := &ExpectedCommand{args: args}
	m.expectations[subCmd] = append(m.expectations[subCmd], e)
	return e
}

// Verify asserts all expected commands were called.
func (m *MockRunner) Verify() {
	m.t.Helper()
	for subCmd, expectations := range m.expectations {
		for _, e := range expectations {
			if !e.called {
				m.t.Errorf("expected command not called: %s %v", subCmd, e.args)
			}
			if e.called && e.checkStdin && e.gotStdin != e.wantStdin {
				m.t.Errorf("stdin mismatch for %v: got %q, want %q", e.args, e.gotStdin, e.wantStdin)
			}
		}
	}
}

func (m *MockRunner) findExpectation(args []string) *ExpectedCommand {
	m.mu.Lock()
	defer m.mu.Unlock()

	subCmd := args[0]
	expectations, ok := m.expectations[subCmd]
	if ok {
		for _, e := range expectations {
			if slices.Equal(e.args, args) {
				e.called = true
				return e
			}
		}
	}
	// Check allowed (optional) commands — matched by full args
	if a, ok := m.allowed[strings.Join(args, "\x00")]; ok {
		return a
	}
	m.t.Fatalf("unexpected command: %v", args)
	return nil
}

func (m *MockRunner) Run(_ context.Context, args []string) ([]byte, error) {
	e := m.findExpectation(args)
	return e.output, e.err
}

func (m *MockRunner) RunWithInput(_ context.Context, args []string, stdin string) ([]byte, error) {
	e := m.findExpectation(args)
	m.mu.Lock()
	e.gotStdin = stdin
	m.mu.Unlock()
	return e.output, e.err
}

// mockStream models real StreamCombined semantics: body drains first, error
// surfaces on Close (= cmd.Wait exit code). Tests for the error path would
// be misleading if err returned up-front — the handler has already flushed
// 200 + progress lines by the time Close reports failure.
type mockStream struct {
	*bytes.Reader
	err error
}

func (m *mockStream) Close() error { return m.err }

func (m *MockRunner) StreamCombined(_ context.Context, args []string) (io.ReadCloser, error) {
	e := m.findExpectation(args)
	return &mockStream{Reader: bytes.NewReader(e.output), err: e.err}, nil
}

// RunRaw routes through the same expectation table as Run — the mock doesn't
// distinguish "jj subcommand" from "raw binary". Tests simply Expect the full
// argv (e.g. {"gh", "pr", "list", ...}).
func (m *MockRunner) RunRaw(_ context.Context, argv []string) ([]byte, error) {
	e := m.findExpectation(argv)
	return e.output, e.err
}
