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
	args   []string
	output []byte
	called bool
	err    error
}

func (e *ExpectedCommand) SetOutput(output []byte) *ExpectedCommand {
	e.output = output
	return e
}

func (e *ExpectedCommand) SetError(err error) *ExpectedCommand {
	e.err = err
	return e
}

// MockRunner implements runner.CommandRunner with expectation-based verification.
// Pattern ported from jjui's test.CommandRunner.
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
func (m *MockRunner) Allow(args []string) *ExpectedCommand {
	if len(args) == 0 {
		m.t.Fatal("Allow: empty args")
	}
	e := &ExpectedCommand{args: slices.Clone(args), called: true} // pre-marked so Verify won't complain
	m.allowed[strings.Join(args, "\x00")] = e
	return e
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

func (m *MockRunner) RunWithInput(_ context.Context, args []string, _ string) ([]byte, error) {
	e := m.findExpectation(args)
	return e.output, e.err
}

func (m *MockRunner) Stream(_ context.Context, args []string) (io.ReadCloser, error) {
	e := m.findExpectation(args)
	return io.NopCloser(bytes.NewReader(e.output)), e.err
}
