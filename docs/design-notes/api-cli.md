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
4. **Loopback-only enforced client-side.** The server's `localhostOnly` defends
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
  PATH     verbatim URL path, including query string. Not auto-prefixed —
           agent_api.md teaches `<base> = /tab/{N}`, callers spell it out.
  BODY     literal JSON | @file (path relative to CWD) | "-" for stdin.
           Optional. Bodies that literally start with `@` or are exactly `-`
           must use the file/stdin form — same ambiguity as curl.

flags:
  --addr   host:port — bypass discovery entirely (no session-dir reads or
           warnings). Loopback only — see Security model.
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

**No auto-prefix of `/tab/N`.** Tab-scoped routes (`/tab/{N}/api/...`) make up
nearly all of the surface; the few root-mounted exceptions are `GET|POST
/tabs`, `DELETE /tabs/{id}`, and `GET|POST /api/config[/raw]` (registered
inline in `tabs.go` `NewTabManager`; `/api/config` is *also* registered on
each per-tab `Server.Mux`, so both `/api/config` and `/tab/0/api/config`
work). Everything else — including `/api/agent`, `/api/capabilities`, `/api`
— lives under `/tab/{N}/`. The root list is small and stable, so
auto-prefixing is feasible, but verbatim paths match what `agent_api.md`
teaches and avoid a two-mode mental model. Note the failure mode: an
unprefixed `/api/...` path falls through to the SPA `/` catch-all and returns
**HTML, not a 404** — confusing for an agent. The agent_api.md rewrite calls
this out.

## Discovery

```
discoverSession(dir, repoPath string) (sessionInfo, error)
```

Steps. The production caller resolves `dir` via a **read-only**
`sessionDirReadOnly()` variant — same `verifyOwnedDir` check as the writer's
`sessionDir()` but no `os.MkdirAll`. A read-only `lightjj api GET ...` should
not create directories. `verifyOwnedDir` failure is a hard error (Security §1).
`ENOENT` is "no sessions, lightjj not running."

1. List `dir/*.json` via `readSessions(dir)` — the shared helper for `lightjj
   api` and `lightjj sessions`. It enforces a **per-file size cap of 4 KiB**
   before parse (legit files are ~150 bytes; an oversized file is corruption
   or a planted DoS). Skip unparseable, oversized, or schema-invalid entries.
   **Skip entries where `cleaned := filepath.Clean(RepoDir); cleaned == "" ||
   cleaned == "/" || !filepath.IsAbs(cleaned)`** — a `/`, `//`, `/.`, or
   relative `RepoDir` would universally match (or error in `filepath.Rel`).
   `Clean` first so byte-distinct aliases of `/` don't slip through.
2. Filter `pidAlive(pid)` — freshness, not trust (Security §3).
3. **Filter `Mode == "local"`.** SSH-mode sessions hold the *remote* path in
   `RepoDir`; if a remote path string coincidentally exists locally (synced
   dotfiles, same `~/code/foo` layout on laptop and remote dev box — common), a
   containment match would silently route the agent's writes to the *wrong
   machine's repo*. SSH sessions
   stay reachable via `--addr` and are listed in `lightjj sessions` and in the
   no-match error message.
4. **Validate `Addr`** per Security §2. Reject and skip on failure.
5. **Containment match.** Resolve `repoPath` (default: cwd, or `--repo`) and
   each candidate `RepoDir` via `filepath.EvalSymlinks` — **both sides**, so
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

6. **Most-specific (deepest) `RepoDir` wins.** Among matching candidates, all
   `RepoDir`s are ancestors of `repoPath` and therefore prefixes of one
   another, so byte length and component depth agree on the winner. Tie (two
   lightjj instances on the *same* `RepoDir`) → error listing PID, Addr,
   StartedAt for each, suggest `--addr`. Don't auto-pick; a stale instance
   could shadow a fresh one.
7. Zero matches → error listing all alive sessions (local and SSH, with their
   `RepoDir` and addr), suggest `--repo`, `--addr`, or starting lightjj.

`discoverSession` takes `dir` as a parameter (not calling `sessionDirReadOnly()`
internally) so tests pass `t.TempDir()`.

### Known gap: multi-tab / multi-workspace

The session file holds exactly one `RepoDir`: the launch tab's path. A lightjj
instance with additional tabs (other repos, secondary workspaces) is not
discoverable by an agent whose cwd is inside a non-launch tab's repo —
discovery says "no session" even though the running instance has it open at
`/tab/2/`. The agent can't `GET /tabs` to find the tab number because it
doesn't have the addr. **Documented v1 gap.** v2 candidate: write a
`tabs: [{path}]` array to the session file on tab create/close (the data
already flows through `writePersistedTabs`). Until then: zero-match error
output lists running sessions' addrs so the user can `--addr` and `GET /tabs`
manually.

## Request

```go
func doAPIRequest(addr, method, path string, body io.Reader, extraHeaders []string) (*http.Response, error)
```

- URL constructed via `url.URL{Scheme: "http", Host: net.JoinHostPort(host, port), ...}`
  with the validated host/port — never string concatenation. Path may include
  `?query`; `url.Parse(path)` extracts `Path` + `RawQuery`.
- If `body != nil`, set `Content-Type: application/json`. Override allowed via
  `-H`.
- `req.Host` left at default. The server's `localhostOnly` accepts
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
PID    ADDR              MODE   REPO
12345  127.0.0.1:54321   local  /home/alice/src/lightjj
67890  127.0.0.1:54322   ssh    /home/user/repo
```

Same hardening as `lightjj api` discovery: resolves the dir via
`sessionDirReadOnly()` (`verifyOwnedDir` hard-error, no `MkdirAll`), reads via
`readSessions()` (which owns the per-file size cap so both subcommands inherit
it). `sweepStaleSessions` runs first — and its `os.Remove` calls make the
ownership check *more* important here, not less.

## Files

- `cmd/lightjj/api_cmd.go` — `runAPISubcommand`, `runSessionsSubcommand`,
  `discoverSession`, `doAPIRequest`, `validateAddr`. Same package as
  `session_file.go` so `sessionInfo`/`pidAlive`/`verifyOwnedDir` stay
  unexported.
- `cmd/lightjj/api_cmd_test.go` — discovery table tests (fake session dir),
  containment-matcher table tests (with macOS `/tmp`→`/private/tmp` row),
  addr-validation table tests, request tests against `httptest.Server`.
- `cmd/lightjj/main.go` — pre-`flag.Parse()` dispatch (~6 lines).
- `cmd/lightjj/session_file.go` — extract `readSessions(dir) ([]sessionInfo, error)`
  (shared by `lightjj api` discovery and `lightjj sessions`; owns the size
  cap; `sweepStaleSessions` stays filename-based, doesn't parse JSON, won't be
  a caller). Extract `resolveSessionPaths() (base, dir string, verify bool)` —
  the XDG/TempDir branch + verify-flag decision, no fs access; `sessionDir()`
  (writer: `MkdirAll` + double-verify) and `sessionDirReadOnly()` (reader:
  verify base **and** `dir`, propagate `ENOENT`, no create) both call it.
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

## Out of scope (v1)

- Auto-prefixing `/tab/N`. Verbose paths match `agent_api.md`'s contract.
- Multi-tab discovery (see Known gap above). Requires session-file schema
  change.
- Per-session bearer token (closes the `pidAlive` TOCTOU; requires server-side
  change).
- `lightjj api` over UDS or non-HTTP transport. We don't bind UDS.
- MCP server. Separate effort, possibly a wrapper over this CLI.
- Windows. `writeSessionFile` is already a no-op there; `lightjj api` will
  fail discovery and require `--addr`. Document, don't special-case.
