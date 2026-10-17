# `lightjj api` — CLI mode for agent harnesses

## Problem

Agent harnesses (Claude Code, Codex, Aider, …) increasingly run with enterprise
policies that denylist `curl`/`wget` in their Bash sandbox. lightjj's agent
contract (`GET /tab/{N}/api/agent` → `agent_api.md`) currently assumes the
agent can `curl http://<addr>/tab/0/api/...`. Blocked curl breaks the entire
agent integration even though the lightjj server is reachable — the policy is a
process-name denylist, not a network namespace.

## Design: a subcommand, not a separate binary

`lightjj api METHOD PATH [BODY]` makes an HTTP request via Go's `net/http` to a
discovered local lightjj instance. Same binary — already on PATH for anyone who
has lightjj running, zero new deps, and dodges the curl denylist by virtue of a
different argv[0].

This is also strictly better than curl for the agent use case:

1. **Auto-discovery.** `agent_api.md` currently teaches a `jq` + `$XDG_RUNTIME_DIR`
   shell dance to find the port — fragile (depends on `jq`), hard to get right
   on macOS (`$TMPDIR` fallback). The CLI reads the same `sessions/<pid>.json`
   files in-process and matches by repo dir.
2. **Built-in `Content-Type`.** `decodeBody` requires `application/json`; curl
   users have to know to pass `-H`. The CLI sets it whenever a body is present.
3. **Stale-pid hygiene for free.** Discovery filters dead pids; curl users hit
   stale ports and get an unexplained connection-refused.
4. **Loopback-only enforced client-side.** The server's Host gate (`HostPolicy`, hostgate.go) defends
   against DNS rebinding (browser-originated requests with a hostile `Host`).
   It does *nothing* if a planted session file points the CLI at an attacker
   server — the request never reaches lightjj. The CLI validates the
   destination address before sending (see Security model below). curl has no
   equivalent check.

### Why not MCP?

MCP-over-stdio would be the *richest* integration for Claude Code specifically,
but it's harness-specific and adds a protocol surface. `lightjj api` is ~80% of
the value, works in every harness with bash, and an MCP server can be a thin
shim *over* the CLI later if demand shows up. Defer.

## Security model

A new path to a security-sensitive resource needs an explicit boundary
statement, not just convenience claims. Three checks, in order:

1. **Directory ownership.** Discovery resolves the session dir via
   `sessionDirReadOnly()`, which calls `verifyOwnedDir` (non-symlink, `0700`,
   owned by us) on **both** `base` and `base/sessions` — **unconditionally**,
   including on the `XDG_RUNTIME_DIR` path the writer skips. The XDG spec
   guarantees user-ownership but it's enforced by `systemd-logind`, not the
   kernel; a stray `export XDG_RUNTIME_DIR=...` in a Dockerfile or rc file
   silently disables the guarantee. Cost is two `Lstat` syscalls. This is the
   in-process equivalent of `agent_api.md`'s `[ -O "$dir/sessions" ]` shell
   check (which is also unconditional). On verification failure, **hard
   error** — do not silently treat as "no sessions found." A planted dir is
   indistinguishable from a real one once you start parsing its files. The
   write path degrades gracefully on verify failure (server still works
   without a session file); the read path must not, because a successful read
   directs traffic.
2. **Address validation.** Every discovered or user-supplied address is parsed
   with `net.SplitHostPort` and checked: host must be `127.0.0.1`, `::1`, or
   `localhost`; port must be `1..65535`. Both checks are load-bearing —
   `SplitHostPort("127.0.0.1:80@evil.com")` returns `(host="127.0.0.1",
   port="80@evil.com", err=nil)`; the *port range* check (`strconv.Atoi`)
   rejects it, not the host check. Discovered entries that fail are skipped
   (continue scanning). A failing `--addr` is a usage error. **There is no
   documented use case for a non-loopback `--addr`** — even SSH-tunnel users
   forward to a local port. An unrestricted `--addr` would turn the CLI into a
   curl-shaped exfil primitive that's *allowlisted by the harness* (the entire
   premise of this feature), so the restriction is free and load-bearing. URLs
   are constructed via `url.URL{Scheme, Host: net.JoinHostPort(...), Path}`,
   never string concatenation — `addr = "127.0.0.1:80@evil.com"` parses as
   userinfo + a different host if concatenated (verified).
3. **`pidAlive` is freshness, not trust.** It returns `true` on `EPERM`, so any
   pid owned by another user — including pid 1 — passes. It only filters
   obviously-dead entries to avoid stale connection-refused. Trust comes from
   (1) and (2). Known gap: a TOCTOU window between alive-check and connect lets
   a port reuse by another local process. The complete mitigation is a
   per-session bearer token written to the (`0600`) session file and validated
   by the server — out of scope for v1, recorded here so a later refactor
   doesn't accidentally rely on `pidAlive` as a trust gate.

No auth token (any same-uid process can call the API) — pre-existing,
unchanged by this CLI. See `agent_api.md` "Reaching the server."

## Dispatch

Pre-`flag.Parse()` switch on `os.Args[1]` in `main.go`:

```go
if len(os.Args) > 1 {
    switch os.Args[1] {
    case "api":
        os.Exit(runAPISubcommand(os.Args[2:]))
    case "sessions":
        os.Exit(runSessionsSubcommand(os.Args[2:]))
    }
}
```

Each subcommand owns a `flag.NewFlagSet` so `lightjj api --addr ...` doesn't
collide with the server's `--addr`. The existing `--apply-hunks` stays as a
flag (jj invokes us with flags, not verbs — different caller, different
contract; document the asymmetry in a comment).

No conflict risk: the server's only positional-arg path is `--apply-hunks`
re-entry, where `os.Args[1]` is always the flag (`--apply-hunks=...`), never a
bare word. The verb match is **case-sensitive** — `lightjj API` falls through
to the server (Go's `flag.Parse` stops at the first non-flag and leaves `API`
in `flag.Args()`; today the server ignores stray positionals, so a typo'd verb
silently launches the server. Add a `flag.NArg() > 0` → usage-error guard in
`main.go` so it errors instead).

`lightjj api` with no further args prints the synopsis to stderr, exits 2.

## `lightjj api` synopsis

```
lightjj api [flags] METHOD PATH [BODY]

  METHOD   GET | POST | PUT | DELETE | PATCH (case-insensitive, uppercased)
  PATH     URL path, including query string. A tab-relative `/api/...` is
           prefixed with the tab discovery matched for the cwd (see Tab
           targeting); an explicit `/tab/N/...` is sent verbatim.
  BODY     literal JSON | @file (path relative to CWD) | "-" for stdin.
           Optional. Bodies that literally start with `@` or are exactly `-`
           must use the file/stdin form — same ambiguity as curl.

flags:
  --addr   host:port — bypass discovery entirely (no session-dir reads or
           warnings; PATH sent verbatim). Loopback only — see Security model.
  --repo   path — match a different repo than cwd
  -H       "Key: Value" — extra header (repeatable)

examples:
  lightjj api GET /tab/0/api/log
  lightjj api GET /tabs
  lightjj api GET '/tab/0/api/file-show?revision=@&path=docs/DESIGN.md'
  lightjj api POST /tab/0/api/doc-comments @comment.json
  lightjj api POST /tab/0/api/doc-comments -          < comment.json
  lightjj api --addr 127.0.0.1:54321 GET /tab/0/api/capabilities
```

There is no `-X`/`--request` flag — METHOD is the first positional argument;
curl muscle memory does not transfer.

**Flags must come before METHOD.** Go's `flag.Parse` stops at the first
non-flag argument, so trailing flags are interpreted as positionals. The CLI
errors on more than 3 positionals (METHOD PATH BODY) instead of silently
mis-parsing — `lightjj api POST /foo @body -H 'X: y'` is a usage error, not a
mystery 400.

**Quote query strings.** Bare `&` backgrounds the shell command. The
agent_api.md rewrite leads every example with the quoted form.

**Tab targeting (v2).** Tab-scoped routes (`/tab/{N}/api/...`) make up nearly
all of the surface; the few root-mounted exceptions are `GET|POST /tabs`,
`DELETE /tabs/{id}`, `GET|POST /api/config[/raw]` and `GET|POST
/api/state/recent-actions` (registered inline in `tabs.go` `NewTabManager`) —
and every root `/api/*` route is *also* registered on each per-tab
`Server.Mux`, so `/tab/N/api/config` works too. That last fact is what makes
the v2 rule safe: after discovery has matched a tab (see Discovery step 5),
`resolveTabPath` prefixes a PATH of exactly `/api` or starting with `/api/`
(or `/api?`) with `/tab/{matched-id}` — there is no `/api/*` path this can
break, and it retires the v1 footgun where an unprefixed `/api/...` fell
through to the SPA `/` catch-all and returned **HTML, not a 404**. An explicit
`/tab/N/...` (or any non-`/api` path such as `/tabs`) is sent verbatim: the
caller chose. When the matched tab is not the launch tab, one stderr line
announces it —

```
lightjj api: tab 2 (/Users/alice/src/other-repo) → /tab/2/api/log
```

— and if the caller spelled a *different* tab explicitly (an agent copying
`/tab/0/` examples while its cwd is in tab 2's repo) the line says so instead
of silently reading the wrong repo:

```
lightjj api: cwd is in tab 2 (/Users/alice/src/other-repo) but PATH targets /tab/0/ explicitly — pass /api/... to target tab 2
```

The launch-tab match (the common case) is silent. `--addr` bypasses discovery,
so there is no matched tab and PATH is verbatim — spell out `/tab/N/`.
Pre-tabs session files match via `RepoDir`, which is tab 0 on every version
that writes session files, so they resolve as tab `0` with no special case.

**Version stamp.** The session file carries the writing binary's
`resolvedVersion()` (`version`). After discovery, `lightjj api` compares it to
its own and prints one stderr warning on mismatch — the stale-`go:embed`-binary
class (a long-running server from an old build, or a freshly built CLI talking
to yesterday's server). The request is still sent; a missing stamp (older
server) is silent. Only the `X.Y.Z` release core is compared (`releaseCore`):
`+dirty` metadata and pre-release suffixes are ignored, and non-release builds
(`dev` from `go run`, Go VCS pseudo-versions) never warn — otherwise the
two-terminal dev loop (go-run server + built CLI) would warn on every call.
A shutdown latch in `sessionWriter` keeps a tab handler racing the exit
signal from re-creating the file after `Remove()`.

```
lightjj api: warning: session pid 12345 runs lightjj 1.36.0 but this binary is 1.36.1 — one of them is stale
```

## Discovery

```
discoverSession(dir, repoPath string) (sessionInfo, sessionTab, error)
```

Steps. The production caller resolves `dir` via a **read-only**
`sessionDirReadOnly()` variant — same `verifyOwnedDir` check as the writer's
`sessionDir()` but no `os.MkdirAll`. A read-only `lightjj api GET ...` should
not create directories. `verifyOwnedDir` failure is a hard error (Security §1).
`ENOENT` is "no sessions, lightjj not running."

1. List `dir/*.json` via `readSessions(dir)` — the shared helper for `lightjj
   api` and `lightjj sessions`. It enforces a **per-file size cap of 64 KiB**
   before parse (legit files are ~200 bytes + ~100 per open tab; an oversized
   file is corruption or a planted DoS — the cap was 4 KiB before the `tabs`
   array, which a few dozen long-path tabs could have crossed silently). Skip
   unparseable, oversized, or schema-invalid entries.
   **Skip entries where `cleaned := filepath.Clean(RepoDir); cleaned == "" ||
   cleaned == "/" || !filepath.IsAbs(cleaned)`** — a `/`, `//`, `/.`, or
   relative `RepoDir` would universally match (or error in `filepath.Rel`).
   `Clean` first so byte-distinct aliases of `/` don't slip through. A session
   failing this is dropped wholesale (tabs and all); the same pre-filter is
   re-applied to each individual tab path in step 5 (`resolveCandidatePath`).
2. Filter `pidAlive(pid)` — freshness, not trust (Security §3).
3. **Filter `Mode == "local"`.** SSH-mode sessions hold *remote* paths in
   `RepoDir` and every `tabs[].path`; if a remote path string coincidentally exists locally (synced
   dotfiles, same `~/code/foo` layout on laptop and remote dev box — common), a
   containment match would silently route the agent's writes to the *wrong
   machine's repo*. SSH sessions
   stay reachable via `--addr` and are listed in `lightjj sessions` and in the
   no-match error message.
4. **Validate `Addr`** per Security §2. Reject and skip on failure.
5. **Containment match, per tab path.** The candidate paths of a session are
   its `tabs[].path` entries (`candidateTabs`; tab 0 == `RepoDir` is in the
   list) — or, for a pre-tabs session file, `RepoDir` alone synthesized as
   tab `0`. A tab whose `id` isn't a canonical non-negative integer is dropped
   (the id is later embedded in the request path). Within one session the
   **deepest matching tab wins** (nested repos `/a` and `/a/b` open as two
   tabs: cwd in `/a/b` targets the inner one), yielding at most one candidate
   per session for step 6. Resolve `repoPath` (default: cwd, or `--repo`) and
   each candidate path via `filepath.EvalSymlinks` — **both sides**, so
   the comparison is robust regardless of whether `jj workspace root` (the
   `RepoDir` producer) resolves symlinks. (`jj workspace root` does on macOS
   per local probe — `/tmp/x` → `/private/tmp/x` — but resolving both sides
   makes the matcher independent of jj behavior.) On `EvalSymlinks` failure
   for `repoPath` (cwd deleted, perms), fall back to `filepath.Abs`. If that
   also fails, error: "cannot determine working directory." For per-entry
   `RepoDir` resolve failures, skip the entry. **After resolving, re-check the
   resolved `RepoDir` ≠ `/`** — a symlink-to-root would slip past the step-1
   pre-filter (which sees the unresolved string).

   Predicate, component-aware (not byte-prefix — `/a/..foo` is *inside* `/a`):

   ```go
   // resolvedRepoDir, resolvedCwd: both already EvalSymlinks-resolved above.
   rel, err := filepath.Rel(resolvedRepoDir, resolvedCwd)
   match := err == nil && rel != ".." &&
            !strings.HasPrefix(rel, ".."+string(filepath.Separator))
   // rel == "." (exact match) is the common case and is a match.
   ```

6. **Most-specific (deepest) path wins.** Among matching candidates, all
   paths are ancestors of `repoPath` and therefore prefixes of one another,
   so byte length and component depth agree on the winner — a deeper tab in
   session B beats session A's shallower launch repo. Tie (two lightjj
   instances with the *same* repo open, as launch repo or tab) → error
   listing PID, Addr, tab id, StartedAt for each, suggest `--addr`. Don't
   auto-pick; a stale instance could shadow a fresh one.
7. Zero matches → error listing all alive sessions (local and SSH, with their
   `RepoDir`, extra tabs, and addr), suggest `--repo`, `--addr`, or starting
   lightjj.

`discoverSession` returns the matched `sessionTab` alongside the session so
`runAPISubcommand` can target it (Tab targeting above). It takes `dir` as a
parameter (not calling `sessionDirReadOnly()` internally) so tests pass
`t.TempDir()`.

### Multi-tab / multi-workspace (resolved in v2)

v1's session file held exactly one `RepoDir` — the launch tab's path — so an
instance with additional tabs (other repos, secondary workspaces) was not
discoverable by an agent whose cwd was inside a non-launch tab's repo:
discovery said "no session" although the instance had it open at `/tab/2/`,
and the agent couldn't `GET /tabs` to learn the tab number without the addr.

v2 writes `tabs: [{id, path}]` (tab 0 included) into the session file and
keeps it current. The hook is deliberately narrow so `internal/api` stays
ignorant of session files (a `cmd/lightjj` concern): `TabManager` exposes
`TabRefs() []TabRef` (id + canonical path, id order, RLock snapshot) and an
`OnTabsChange func()` field fired from `tabsChanged()` — the one helper both
`handleCreate` and `handleClose` call after writing their response, right
where `persistTabs` (state.json) already ran. Startup `AddTab` calls don't
fire it; `main.go` takes the initial snapshot after the restore loop, then
sets `tm.OnTabsChange = session.Update`. The callback carries **no snapshot**
on purpose: two concurrent creates would race to deliver stale snapshots in
either order, so `sessionWriter.Update` calls the `TabRefs` snapshot func
*inside* its own mutex, making fetch + atomic write one step — the last
rename always reflects the latest tab set. Writes are temp-file-in-same-dir +
`rename` (0600 via `os.CreateTemp`; the temp name doesn't end in `.json`, so
`readSessions`/`sweepStaleSessions` ignore it) because the file is now
rewritten while `lightjj api` may be mid-read. SSH-mode sessions carry their
(remote) tab paths too — harmless, step 3 drops the session before any path
is matched, and `lightjj sessions` gets to list them.

## Request

```go
func doAPIRequest(addr, method, path string, body io.Reader, extraHeaders []string) (*http.Response, error)
```

- URL constructed via `url.URL{Scheme: "http", Host: net.JoinHostPort(host, port), ...}`
  with the validated host/port — never string concatenation. Path may include
  `?query`; `url.Parse(path)` extracts `Path` + `RawQuery`.
- If `body != nil`, set `Content-Type: application/json`. Override allowed via
  `-H`.
- `req.Host` left at default. The server's Host gate (`HostPolicy`) always accepts
  `127.0.0.1`/`::1`/`localhost` after `net.SplitHostPort` — all three are what
  validation permits. IPv6 round-trips correctly (`listener.Addr()` brackets,
  Go preserves brackets in `req.Host`, `SplitHostPort` strips them). The
  legitimate writer never produces a wildcard addr — `main.go` normalizes
  unspecified binds to `localhost:N` (`tcp.IP.IsUnspecified()` check) *before*
  writing the session file. A wildcard addr in a session file is therefore
  always corruption or a plant; step 4 rejects it as defense-in-depth. Don't
  override `req.Host = "localhost"` to "fix" wildcards — there is no
  legitimate wildcard, and the override would let the CLI lie to a server
  about its destination.
- `http.Client{Timeout: 30 * time.Second}`.

## Output contract

- **stdout**: response body, always — even on 4xx/5xx (the API returns JSON
  error objects that agents pipe to `jq`).
- **stderr**: `HTTP <status> <reason>` on non-2xx. Connection errors. Discovery
  errors with the suggestion text.
- **exit code** — differentiated so agents can branch on retry vs wrong-request
  vs misuse:
  - `0` — HTTP 2xx
  - `1` — discovery or connection error (retry / start lightjj)
  - `2` — usage error (bad flags, no args, too many positionals)
  - `4` — HTTP 4xx (request was wrong, don't retry)
  - `5` — HTTP 5xx (server error, maybe retry)

  Any status not covered above → `0` if `< 400`, else `1` (catches
  non-standard codes; 3xx shouldn't happen — the server doesn't redirect).
  4/5 follow HTTPie's `--check-status` convention; curl's `-f` (exit 22) is a
  single undifferentiated bucket that can't signal retry-vs-don't. 2 follows
  Go `flag` usage-error convention.

## `lightjj sessions`

Tabular dump for humans, `--json` for machines. Lists ALL alive sessions
including SSH-mode (which `lightjj api` discovery filters out — `sessions` is
where you go to find the addr to pass with `--addr`).

```
PID    ADDR              MODE   VERSION  REPO
12345  127.0.0.1:54321   local  1.36.1   /home/alice/src/lightjj
                                           tab 2: /home/alice/src/other-repo
67890  127.0.0.1:54322   ssh    -        /home/user/repo
```

`VERSION` is the session's binary version stamp (`-` for a pre-stamp
server); extra tabs (tab 0 is the REPO column) follow as continuation rows.
`--json` emits the full `sessionInfo` records — `version` and the complete
`tabs: [{id, path}]` array (always `[]`, never `null`, for old-format files).

Session file schema (`sessions/<pid>.json`, 0600):

```json
{"pid":12345,"addr":"127.0.0.1:54321","port":54321,
 "repo_dir":"/home/alice/src/lightjj","mode":"local","started_at":1760000000000,
 "version":"1.36.1",
 "tabs":[{"id":"0","path":"/home/alice/src/lightjj"},
         {"id":"2","path":"/home/alice/src/other-repo"}]}
```

`version` is `omitempty`; `tabs` is always present from a v2 writer. Readers
must tolerate both fields being absent (v1 writers).

Same hardening as `lightjj api` discovery: resolves the dir via
`sessionDirReadOnly()` (`verifyOwnedDir` hard-error, no `MkdirAll`), reads via
`readSessions()` (which owns the per-file size cap so both subcommands inherit
it). `sweepStaleSessions` runs first — and its `os.Remove` calls make the
ownership check *more* important here, not less.

## Files

- `cmd/lightjj/api_cmd.go` — `runAPISubcommand`, `runSessionsSubcommand`,
  `discoverSession` (+ `candidateTabs`/`resolveCandidatePath`),
  `resolveTabPath`/`explicitTabID` (tab targeting), `versionMismatchWarning`,
  `doAPIRequest`, `validateAddr`. Same package as `session_file.go` so
  `sessionInfo`/`sessionTab`/`pidAlive`/`verifyOwnedDir` stay unexported.
- `cmd/lightjj/api_cmd_test.go` — discovery table tests (fake session dir;
  multi-tab: non-launch tab, nested longest-match, cross-session depth, tie,
  ssh, bad tab id, old format), containment-matcher table tests (with macOS
  `/tmp`→`/private/tmp` row), addr-validation table tests, request tests
  against `httptest.Server`, `runAPISubcommand` end-to-end tab-rewrite +
  version-warning tests (stderr captured), `sessions` output test.
- `cmd/lightjj/main.go` — pre-`flag.Parse()` dispatch (~6 lines); builds the
  `sessionWriter` (identity fields incl. `resolvedVersion()`, snapshot func =
  `sessionTabsOf(tm.TabRefs())`), initial `Update()` after tab restore,
  `tm.OnTabsChange = session.Update`, `session.Remove()` on shutdown.
- `cmd/lightjj/session_file.go` — `sessionInfo`/`sessionTab` schema;
  `readSessions(dir) ([]sessionInfo, error)` (shared by `lightjj api`
  discovery and `lightjj sessions`; owns the size cap; normalizes absent
  `tabs` to `[]`; `sweepStaleSessions` stays filename-based, doesn't parse
  JSON, won't be a caller). `resolveSessionPaths() (base, dir string, verify
  bool)` — the XDG/TempDir branch + verify-flag decision, no fs access;
  `sessionDir()` (writer: `MkdirAll` + double-verify) and
  `sessionDirReadOnly()` (reader: verify base **and** `dir`, propagate
  `ENOENT`, no create) both call it. `writeSessionFile` (atomic temp+rename,
  0600) is the primitive; `sessionWriter` (mutex, fixed identity, snapshot
  func, `Update`/`Remove`) is what `main.go` holds; `sessionTabsOf` adapts
  `[]api.TabRef`.
- `internal/api/tabs.go` — `TabRef`, `TabRefs()`, `OnTabsChange`,
  `tabsChanged()` (the v2 hook; see Multi-tab above).
- `internal/api/agent_api.md` — lead with `lightjj api`, demote curl/`jq` to a
  "no `lightjj` on PATH" fallback section. Lead every example with the quoted
  CLI form: `lightjj api GET '/tab/0/api/file-show?revision=@&path=...'`.
  Note the unprefixed-path-returns-HTML footgun.
- `internal/api/agent_docs_test.go` — add an assertion that `agent_api.md`
  mentions `lightjj api` (the structural guard against doc/route drift already
  asserts every `/api/*` path is registered).

## Testing

- **Discovery**: write fake `<pid>.json` files into `t.TempDir()`. Make
  `pidAlive` a package-level `var` so tests stub it.
- **Containment matcher**: pure-function table test (RepoDir × cwd → match?),
  including: exact match (`.`), subdir, sibling, `RepoDir = "/"` (rejected at
  filter), relative `RepoDir` (rejected), `/a/..foo` (inside, must match),
  `/a/foo` vs `/a/foobar` (not nested), macOS symlink (`/tmp/x` matched against
  session at `/private/tmp/x`).
- **Addr validation**: table test — `127.0.0.1:N`, `[::1]:N`, `localhost:N`
  pass; `evil.com:80`, `0.0.0.0:N`, `[::]:N`, `127.0.0.1:80@evil.com`,
  `127.0.0.1:0`, `127.0.0.1:99999` rejected.
- **Request building**: `httptest.NewServer` echo handler, assert
  method/path/Content-Type/body/Host.
- **Exit codes**: invoke `runAPISubcommand` directly, assert return value
  for each exit-code class.

## Out of scope

- ~~Auto-prefixing `/tab/N`~~ / ~~Multi-tab discovery~~ — both shipped in v2
  (Tab targeting + Multi-tab sections above); explicit `/tab/N/` paths remain
  valid and verbatim.
- Per-session bearer token (closes the `pidAlive` TOCTOU; requires server-side
  change).
- `lightjj api` over UDS or non-HTTP transport. We don't bind UDS.
- MCP server. Separate effort, possibly a wrapper over this CLI.
- Windows. `writeSessionFile` is already a no-op there; `lightjj api` will
  fail discovery and require `--addr`. Document, don't special-case.
