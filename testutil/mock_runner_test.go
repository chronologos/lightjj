package testutil

import (
	"context"
	"errors"
	"testing"

	"github.com/stretchr/testify/assert"
)

func TestMockRunner_ExpectAndVerify(t *testing.T) {
	runner := NewMockRunner(t)
	runner.Expect([]string{"log", "-r", "@"}).SetOutput([]byte("some output"))
	defer runner.Verify()

	output, err := runner.Run(context.Background(), []string{"log", "-r", "@"})
	assert.NoError(t, err)
	assert.Equal(t, []byte("some output"), output)
}

func TestMockRunner_ExpectError(t *testing.T) {
	runner := NewMockRunner(t)
	runner.Expect([]string{"abandon", "-r", "abc"}).SetError(errors.New("immutable"))
	defer runner.Verify()

	_, err := runner.Run(context.Background(), []string{"abandon", "-r", "abc"})
	assert.EqualError(t, err, "immutable")
}

func TestMockRunner_StreamCombined(t *testing.T) {
	runner := NewMockRunner(t)
	runner.Expect([]string{"git", "push"}).
		SetOutput([]byte("progress\n")).
		SetError(errors.New("exit status 1"))
	defer runner.Verify()

	reader, err := runner.StreamCombined(context.Background(), []string{"git", "push"})
	assert.NoError(t, err) // error surfaces on Close, not open — models cmd.Wait()

	buf := make([]byte, 1024)
	n, _ := reader.Read(buf)
	assert.Equal(t, "progress\n", string(buf[:n]))
	assert.EqualError(t, reader.Close(), "exit status 1")
}

func TestMockRunner_RunWithInput(t *testing.T) {
	runner := NewMockRunner(t)
	runner.Expect([]string{"describe", "-r", "abc", "--stdin"}).SetOutput([]byte("ok"))
	defer runner.Verify()

	output, err := runner.RunWithInput(context.Background(), []string{"describe", "-r", "abc", "--stdin"}, "my message")
	assert.NoError(t, err)
	assert.Equal(t, []byte("ok"), output)
}
