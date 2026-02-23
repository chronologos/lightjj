// Package testutil provides test helpers, modeled on jjui's test/ package.
package testutil

import (
	"bytes"
	"context"
	"io"
	"slices"
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
	mu           sync.Mutex
}

func NewMockRunner(t *testing.T) *MockRunner {
	return &MockRunner{
		t:            t,
		expectations: make(map[string][]*ExpectedCommand),
	}
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
	if !ok || len(expectations) == 0 {
		m.t.Fatalf("unexpected command: %v", args)
	}
	for _, e := range expectations {
		if slices.Equal(e.args, args) {
			e.called = true
			return e
		}
	}
	m.t.Fatalf("unexpected command args: %v", args)
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
