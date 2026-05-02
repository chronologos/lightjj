package main

import (
	"context"
	"flag"
	"fmt"
	"log"
	"net"
	"net/http"
	"os"
	"os/exec"
	"os/signal"
	"runtime"
	"runtime/debug"
	"strings"
	"syscall"
	"time"

	"github.com/chronologos/lightjj/internal/api"
	"github.com/chronologos/lightjj/internal/jj"
	"github.com/chronologos/lightjj/internal/runner"
)

// version is set at build time via -ldflags "-X main.version=$(cat version.txt)".
// If unset (e.g. `go install ...@latest`), resolvedVersion() falls back to the
// module version embedded by the Go toolchain.
var version string

func resolvedVersion() string {
	if version != "" {
		return strings.TrimSpace(version)
	}
	if info, ok := debug.ReadBuildInfo(); ok && info.Main.Version != "" && info.Main.Version != "(devel)" {
		return strings.TrimPrefix(info.Main.Version, "v")
	}
	return "dev"
}

func main() {
	repoDir := flag.String("R", "", "Path to jj repository (default: current directory)")
	remote := flag.String("remote", "", "Remote repo as user@host:/path (SSH proxy mode)")
	addr := flag.String("addr", "localhost:0", "Listen address (default: random port on localhost)")
	noBrowser := flag.Bool("no-browser", false, "Don't open browser automatically")
	showVersion := flag.Bool("version", false, "Print version and exit")
	snapshotInterval := flag.Duration("snapshot-interval", 5*time.Second, "Auto-refresh poll interval — jj util snapshot locally, jj op log over SSH (0 disables the loop)")
	noWatch := flag.Bool("no-watch", false, "Disable filesystem watch + SSE auto-refresh")
	defaultRemote := flag.String("default-remote", "", "Remote name to prefer (overrides jj config git.push; defaults to origin)")
	autoShutdown := flag.Duration("auto-shutdown", 0, "Shut down after this `duration` with no browser tabs connected (0 to disable)")
	applyHunks := flag.String("apply-hunks", "", "Internal: diff-editor re-entry. Args: <spec.json> $left $right")
	flag.Parse()

	if *showVersion {
		fmt.Printf("lightjj v%s\n", resolvedVersion())
		return
	}

	// Diff-editor re-entry. jj invokes us as:
	//   lightjj --apply-hunks=<spec> $left $right
	// Server flags are at their defaults — unused. flag.Args() holds the
	// two positional dirs jj passes. Errors go to stderr (jj captures and
	// surfaces them); nonzero exit aborts the split so jj rolls back.
	if *applyHunks != "" {
		args := flag.Args()
		if len(args) != 2 {
			fmt.Fprintf(os.Stderr, "apply-hunks: expected $left $right, got %d args\n", len(args))
			os.Exit(1)
		}
		if err := applyHunkSpec(*applyHunks, args[0], args[1]); err != nil {
			fmt.Fprintf(os.Stderr, "apply-hunks: %v\n", err)
			os.Exit(1)
		}
		return
	}

	var cmdRunner runner.CommandRunner
	var sshRunner *runner.SSHRunner // non-nil only in --remote mode; used for the SSH watcher
	var resolvedRepoDir string      // absolute path for local mode, empty for SSH
	var displayHost, displayPath, sshHost string

	if *remote != "" {
		host, rawPath, err := parseRemoteSpec(*remote)
		if err != nil {
			log.Fatalf("invalid remote: %v", err)
		}
		sshHost = host // full user@host spec → Server.SSHHost → {host} placeholder
		sshRunner = runner.NewSSHRunner(host, rawPath)
		// Canonicalize: jj workspace root on the remote. One startup round trip.
		// Makes tab-dedup work (findByPath compares canonical paths) and fixes
		// ~/ in RepoPath breaking readWorkspaceStore's cat. Fallback to raw
		// path if resolve fails (not a jj repo — first jj log will error).
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		canonical, err := sshRunner.ResolveWorkspaceRoot(ctx, rawPath)
		cancel()
		if err != nil {
			canonical = rawPath
		} else if canonical != rawPath {
			// Rebuild runner with canonical path so all wrapArgs/wrapRaw use it.
			sshRunner = runner.NewSSHRunner(host, canonical)
		}
		cmdRunner = sshRunner
		// Strip user@ prefix for display
		displayHost = host
		if at := strings.LastIndex(host, "@"); at != -1 {
			displayHost = host[at+1:]
		}
		displayPath = canonical
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
	// (and only here) keeps the two paths in sync. isSSH selects watcher
	// mode: local fsnotify vs SSH op-id polling.
	// Resolved once — all tabs share the same binary. Empty in SSH mode
	// (where diff-editor re-entry is unavailable anyway) and on the rare
	// Executable() failure (handleSplitHunks checks and returns 501).
	var selfBinary string
	if sshRunner == nil {
		if exe, err := os.Executable(); err == nil {
			selfBinary = exe
		}
	}

	makeServer := func(r runner.CommandRunner, repoDir, repoPath string, isSSH bool) *api.Server {
		s := api.NewServer(r, repoDir) // DefaultRemote = "origin"
		s.SelfBinary = selfBinary
		// Priority: explicit --default-remote flag > jj config git.push > "origin".
		// jj config is per-repo, so tabs on different repos get different defaults.
		// One extra round trip at tab-open (~20ms local, ~440ms SSH — acceptable).
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		if out, err := r.Run(ctx, jj.ConfigGet("git.push")); err == nil {
			if v := strings.TrimSpace(string(out)); v != "" {
				s.DefaultRemote = v
			}
		}
		// Second config read — same ctx budget (both are fast even over SSH;
		// config-get doesn't touch the working copy). Empty = jj's built-in
		// default; frontend shows generic placeholder. Non-empty = user's
		// custom revset; frontend shows it so "why is X missing" is visible.
		if out, err := r.Run(ctx, jj.ConfigGet("revsets.log")); err == nil {
			s.ConfiguredLogRevset = strings.TrimSpace(string(out))
		}
		cancel()
		if *defaultRemote != "" {
			s.DefaultRemote = *defaultRemote
		}
		s.Hostname = displayHost
		s.RepoPath = repoPath
		s.SSHHost = sshHost
		if !*noWatch {
			if isSSH {
				s.Watcher = api.NewSSHWatcher(s, *snapshotInterval)
			} else {
				s.Watcher = api.NewWatcher(s, *snapshotInterval)
			}
		}
		return s
	}

	// Tab factory + path resolver for dynamically opening additional repos.
	// The resolver is one ~20ms local / ~440ms SSH round trip that does
	// validation + canonicalization + dedup key in one call.
	var newTab api.TabFactory
	var resolve api.TabResolve
	if sshRunner == nil {
		newTab = func(root string) *api.Server {
			// root is already resolved — construct LocalRunner directly
			// instead of NewLocalRunner (would resolve again, ~20ms).
			return makeServer(&runner.LocalRunner{Binary: "jj", RepoDir: root}, root, root, false)
		}
		resolve = runner.ResolveLocalTabPath
	} else {
		newTab = func(root string) *api.Server {
			r := runner.NewSSHRunner(sshRunner.Host, root)
			return makeServer(r, "", root, true) // repoDir="" → SSH mode
		}
		resolve = func(path string) (string, error) {
			ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
			defer cancel()
			return sshRunner.ResolveWorkspaceRoot(ctx, path)
		}
	}

	// One-shot migration: pre-1.20 plain-JSON configs get reseeded through
	// the teaching-comment template (values preserved via patchConfigKeys).
	// Runs before HTTP starts so the first request sees the migrated file;
	// configMu inside serializes against any concurrent write anyway.
	// Host-scoped, so called unconditionally in both local and SSH modes.
	api.MigrateConfigIfNeeded()

	srv := makeServer(cmdRunner, resolvedRepoDir, displayPath, sshRunner != nil)
	tm := api.NewTabManager(newTab, resolve)
	if *autoShutdown > 0 {
		tm.SetIdleShutdown(*autoShutdown)
	}
	if sshRunner != nil {
		tm.Mode = "ssh"
		tm.Host = sshHost // filter: two --remote sessions on different hosts share one config
	} else {
		tm.Mode = "local"
	}
	tm.AddTab(srv, displayPath)

	// Restore tabs persisted from the last session. Best-effort: a moved or
	// deleted repo logs and is skipped. Each restore goes through resolve()
	// which re-validates and re-canonicalizes (handles symlink changes).
	// Mode+Host filter ensures a local session doesn't try to open ssh
	// paths, and an ssh session on hostA doesn't try to open hostB's paths
	// (both would either fail or, worse, silently open the wrong repo if
	// the path happens to exist).
	for _, pt := range api.ReadPersistedTabs() {
		if pt.Mode != tm.Mode || pt.Host != tm.Host {
			continue
		}
		root, err := resolve(pt.Path)
		if err != nil {
			log.Printf("skipping persisted tab %s: %v", pt.Path, err)
			continue
		}
		if tm.FindByPath(root) != nil {
			continue // already open (is the -R startup tab)
		}
		tm.AddTab(newTab(root), root)
	}

	// Serve frontend assets. The handler is build-tag-selected:
	//   `go build -tags embed` → embeds frontend-dist (release path)
	//   default                → static help page pointing at release binaries
	// "/" (all-methods subtree), not "GET /" — Go 1.22 ServeMux rejects
	// patterns where neither is strictly more specific, and "GET /" is
	// method-narrower but path-wider than "/tab/{id}/" → register panic.
	tm.Mux.Handle("/", frontendHandler())

	listener, err := net.Listen("tcp", *addr)
	if err != nil {
		log.Fatalf("failed to listen: %v", err)
	}

	url := fmt.Sprintf("http://%s", listener.Addr().String())
	fmt.Printf("lightjj v%s listening on %s\n", resolvedVersion(), url)

	if !*noBrowser {
		openBrowser(url)
	}

	// Clean up watchers + child workspace instances across all tabs on shutdown
	sigCh := make(chan os.Signal, 1)
	signal.Notify(sigCh, syscall.SIGINT, syscall.SIGTERM)
	go func() {
		select {
		case <-sigCh:
		case <-tm.ShutdownCh:
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
