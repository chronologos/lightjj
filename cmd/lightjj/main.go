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
	"runtime"
	"strings"

	"github.com/iant/lightjj/internal/api"
	"github.com/iant/lightjj/internal/runner"
)

//go:embed all:frontend-dist
var frontendFS embed.FS

func main() {
	repoDir := flag.String("R", "", "Path to jj repository (default: current directory)")
	remote := flag.String("remote", "", "Remote repo as user@host:/path (SSH proxy mode)")
	addr := flag.String("addr", "localhost:0", "Listen address (default: random port on localhost)")
	noBrowser := flag.Bool("no-browser", false, "Don't open browser automatically")
	flag.Parse()

	var cmdRunner runner.CommandRunner

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
		cmdRunner = runner.NewLocalRunner(dir)
	}

	srv := api.NewServer(cmdRunner)

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
	fmt.Printf("lightjj listening on %s\n", url)

	if !*noBrowser {
		openBrowser(url)
	}

	if err := http.Serve(listener, srv.Mux); err != nil {
		log.Fatalf("server error: %v", err)
	}
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
	return host, path, nil
}
