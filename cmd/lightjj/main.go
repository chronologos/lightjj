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
	snapshotInterval := flag.Duration("snapshot-interval", 5*time.Second, "Periodic `jj util snapshot` interval (0 to disable)")
	noWatch := flag.Bool("no-watch", false, "Disable filesystem watch + SSE auto-refresh")
	defaultRemote := flag.String("default-remote", "origin", "Remote name to prefer in bookmark/remote lists")
	autoShutdown := flag.Duration("auto-shutdown", 0, "Shut down after this `duration` with no browser tabs connected (0 to disable)")
	flag.Parse()

	if *showVersion {
		fmt.Printf("lightjj v%s\n", strings.TrimSpace(version))
		return
	}

	var cmdRunner runner.CommandRunner
	var sshRunner *runner.SSHRunner // non-nil only in --remote mode; used for the SSH watcher
	var resolvedRepoDir string      // absolute path for local mode, empty for SSH
	var displayHost, displayPath string

	if *remote != "" {
		host, path, err := parseRemoteSpec(*remote)
		if err != nil {
			log.Fatalf("invalid remote: %v", err)
		}
		sshRunner = runner.NewSSHRunner(host, path)
		cmdRunner = sshRunner
		// Strip user@ prefix for display
		displayHost = host
		if at := strings.LastIndex(host, "@"); at != -1 {
			displayHost = host[at+1:]
		}
		displayPath = path
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
		displayHost, _ = os.Hostname()
		displayPath = resolvedRepoDir
	}

	// makeServer sets all per-repo Server fields. BOTH the startup tab and
	// the dynamic-tab factory call this — adding a new Server field here
	// (and only here) keeps the two paths in sync. The local-mode Watcher
	// is also here; the SSH-mode Watcher is the one genuinely mode-specific
	// piece and stays below.
	makeServer := func(r runner.CommandRunner, repoDir, repoPath string) *api.Server {
		s := api.NewServer(r, repoDir)
		s.DefaultRemote = *defaultRemote
		s.Hostname = displayHost
		s.RepoPath = repoPath
		if !*noWatch && sshRunner == nil {
			s.Watcher = api.NewWatcher(s, *snapshotInterval)
		}
		return s
	}

	srv := makeServer(cmdRunner, resolvedRepoDir, displayPath)
	if !*noWatch && sshRunner != nil {
		srv.Watcher = api.NewSSHWatcher(srv, sshRunner.StreamRaw)
	}
	// Auto-shutdown tracks SSE subscribers on the STARTUP tab's Watcher only.
	// Switching to a second tab closes tab 0's EventSource → 0 subs → timer
	// starts. Known limitation (BACKLOG: cross-tab subscriber tracking).
	// Works correctly in single-tab use (the original design).
	if srv.Watcher != nil && *autoShutdown > 0 {
		srv.Watcher.SetIdleShutdown(*autoShutdown)
	}

	// Tab factory for dynamically opening additional local repos. Nil in SSH
	// mode — can't cheaply validate remote paths.
	var newTab api.TabFactory
	if sshRunner == nil {
		newTab = func(root string) *api.Server {
			// root is already resolved by handleCreate's ResolveWorkspaceRoot
			// — construct LocalRunner directly instead of NewLocalRunner (which
			// would resolve again, ~20ms subprocess).
			return makeServer(&runner.LocalRunner{Binary: "jj", RepoDir: root}, root, root)
		}
	}
	tm := api.NewTabManager(newTab)
	tm.AddTab(srv, displayPath)

	// Serve embedded frontend static files
	feFS, err := fs.Sub(frontendFS, "frontend-dist")
	if err != nil {
		log.Fatalf("failed to load frontend: %v", err)
	}
	// "/" (all-methods subtree), not "GET /" — Go 1.22 ServeMux rejects
	// patterns where neither is strictly more specific, and "GET /" is
	// method-narrower but path-wider than "/tab/{id}/" → register panic.
	tm.Mux.Handle("/", http.FileServer(http.FS(feFS)))

	listener, err := net.Listen("tcp", *addr)
	if err != nil {
		log.Fatalf("failed to listen: %v", err)
	}

	url := fmt.Sprintf("http://%s", listener.Addr().String())
	fmt.Printf("lightjj v%s listening on %s\n", strings.TrimSpace(version), url)

	if !*noBrowser {
		openBrowser(url)
	}

	// Clean up watchers + child workspace instances across all tabs on shutdown
	sigCh := make(chan os.Signal, 1)
	signal.Notify(sigCh, syscall.SIGINT, syscall.SIGTERM)
	go func() {
		select {
		case <-sigCh:
		case <-srv.ShutdownCh:
		}
		tm.Shutdown()
		os.Exit(0)
	}()

	httpServer := &http.Server{
		Handler:           localhostOnly(api.Gzip(tm.Mux)),
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
