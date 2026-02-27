package main

import (
	"embed"
	"flag"
	"fmt"
	"io/fs"
	"log"
	"net"
	"net/http"
	"os"
	"os/exec"
	"os/signal"
	"runtime"
	"strings"
	"syscall"
	"time"

	"github.com/chronologos/lightjj/internal/api"
	"github.com/chronologos/lightjj/internal/runner"
)

// version is set at build time via -ldflags "-X main.version=$(cat version.txt)"
var version = "dev"

//go:embed all:frontend-dist
var frontendFS embed.FS

func main() {
	repoDir := flag.String("R", "", "Path to jj repository (default: current directory)")
	remote := flag.String("remote", "", "Remote repo as user@host:/path (SSH proxy mode)")
	addr := flag.String("addr", "localhost:0", "Listen address (default: random port on localhost)")
	noBrowser := flag.Bool("no-browser", false, "Don't open browser automatically")
	showVersion := flag.Bool("version", false, "Print version and exit")
	flag.Parse()

	if *showVersion {
		fmt.Printf("lightjj v%s\n", strings.TrimSpace(version))
		return
	}

	var cmdRunner runner.CommandRunner
	var resolvedRepoDir string // absolute path for local mode, empty for SSH

	if *remote != "" {
		host, path, err := parseRemoteSpec(*remote)
		if err != nil {
			log.Fatalf("invalid remote: %v", err)
		}
		cmdRunner = runner.NewSSHRunner(host, path)
	} else {
		dir := *repoDir
		if dir == "" {
			var err error
			dir, err = os.Getwd()
			if err != nil {
				log.Fatalf("failed to get working directory: %v", err)
			}
		}
		lr := runner.NewLocalRunner(dir)
		resolvedRepoDir = lr.RepoDir
		cmdRunner = lr
	}

	srv := api.NewServer(cmdRunner, resolvedRepoDir)

	// Serve embedded frontend static files
	feFS, err := fs.Sub(frontendFS, "frontend-dist")
	if err != nil {
		log.Fatalf("failed to load frontend: %v", err)
	}
	srv.Mux.Handle("GET /", http.FileServer(http.FS(feFS)))

	listener, err := net.Listen("tcp", *addr)
	if err != nil {
		log.Fatalf("failed to listen: %v", err)
	}

	url := fmt.Sprintf("http://%s", listener.Addr().String())
	fmt.Printf("lightjj v%s listening on %s\n", strings.TrimSpace(version), url)

	if !*noBrowser {
		openBrowser(url)
	}

	// Clean up child workspace instances on shutdown
	sigCh := make(chan os.Signal, 1)
	signal.Notify(sigCh, syscall.SIGINT, syscall.SIGTERM)
	go func() {
		<-sigCh
		srv.Shutdown()
		os.Exit(0)
	}()

	httpServer := &http.Server{
		Handler:           localhostOnly(srv.Mux),
		ReadHeaderTimeout: 10 * time.Second,
		WriteTimeout:      120 * time.Second,
		IdleTimeout:       60 * time.Second,
	}
	if err := httpServer.Serve(listener); err != nil {
		log.Fatalf("server error: %v", err)
	}
}

// localhostOnly rejects requests where the Host header is not localhost.
// This prevents DNS rebinding attacks against the local server.
func localhostOnly(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		host := r.Host
		if h, _, err := net.SplitHostPort(host); err == nil {
			host = h
		}
		if host != "localhost" && host != "127.0.0.1" && host != "::1" {
			http.Error(w, "forbidden", http.StatusForbidden)
			return
		}
		next.ServeHTTP(w, r)
	})
}

func openBrowser(url string) {
	switch runtime.GOOS {
	case "darwin":
		_ = exec.Command("open", url).Start()
	case "linux":
		_ = exec.Command("xdg-open", url).Start()
	case "windows":
		_ = exec.Command("rundll32", "url.dll,FileProtocolHandler", url).Start()
	}
}

// parseRemoteSpec parses "user@host:/path" into host and path parts.
func parseRemoteSpec(spec string) (host string, path string, err error) {
	idx := strings.LastIndex(spec, ":")
	if idx == -1 {
		return "", "", fmt.Errorf("expected format user@host:/path, got %q", spec)
	}
	host = spec[:idx]
	path = spec[idx+1:]
	if host == "" || path == "" {
		return "", "", fmt.Errorf("expected format user@host:/path, got %q", spec)
	}
	if strings.HasPrefix(host, "-") {
		return "", "", fmt.Errorf("host must not start with '-': %q", host)
	}
	return host, path, nil
}
