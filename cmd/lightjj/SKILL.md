---
name: lightjj
description: Interacts with a running lightjj instance (browser-based Jujutsu/jj viewer) via the `lightjj api` CLI. Reads diffs, posts inline review comments, posts doc-mode suggestions, and steers the user's view. Use when the user has lightjj running and wants the agent to review changes, annotate diffs, or comment on markdown docs.
---

# lightjj

lightjj is a browser-based UI for [Jujutsu](https://github.com/jj-vcs/jj) (jj)
version control. The browser is for the user — do NOT open URLs or screenshot
it. Use `lightjj api` to read and write through the same HTTP API the browser
uses. It auto-discovers the running instance, sets headers correctly, and works
in harnesses that denylist `curl`.

If no lightjj is running, ask the user to start it (`lightjj` in a jj repo) —
do not start it yourself.

## Bootstrap

```text
1. lightjj sessions                          # confirm a session exists, find its repo
2. lightjj api GET /tab/0/api/agent          # full API contract (markdown) — read once
3. lightjj api GET /tab/0/api/capabilities   # probe feature availability
```

`GET /api/agent` is the source of truth for endpoints, request/response schemas,
and the comment/suggestion model. Read it before guessing routes — it describes
the doc-comment store, the navigate endpoint, and the review-comment store.

## Synopsis

```text
lightjj api [flags] METHOD PATH [BODY]

  METHOD   GET | POST | PUT | DELETE | PATCH
  PATH     /tab/{N}/api/... (sent as written) or /api/... (aimed at the
           tab whose repo contains your cwd). Root-only: /tabs, /api/config.
           Tab 0 is the launch repo.
  BODY     literal JSON | @file | "-" for stdin
```

Full reference (flags, exit codes): `lightjj api --help` / `GET /api/agent`.

Quote query strings — bare `&` backgrounds the shell:

```bash
lightjj api GET '/tab/0/api/file-show?revision=@&path=docs/DESIGN.md'
```

## Common operations

```bash
# What is the user looking at right now? Read this FIRST — it's the difference
# between narrating a review and spraying comments past the user's cursor.
# Returns {change_id, commit_id, active_view, doc_file_path, revset, updated_at}.
# Stale if updated_at is >60s old (browser closed or not focused) — the
# frontend heartbeats every 20s while the tab is visible.
lightjj api GET /tab/0/api/focus

# Read the current revision graph (commit metadata, descriptions, bookmarks)
lightjj api GET /tab/0/api/log

# Read a file at a revision
lightjj api GET '/tab/0/api/file-show?revision=@&path=src/main.go'

# Read existing doc-mode comments on a markdown file
lightjj api GET '/tab/0/api/doc-comments?path=docs/DESIGN.md'

# Post a doc-mode comment (range-anchored on rendered text — see /api/agent
# for the anchor schema). Set "author" so the UI marks it as agent-posted.
lightjj api POST /tab/0/api/doc-comments @comment.json

# Steer the user's view to a file/line, or to a comment by id
lightjj api POST /tab/0/api/navigate '{"file_path":"src/main.go","line":42}'
lightjj api POST /tab/0/api/navigate '{"change_id":"xyzabc","comment_id":"a1b2c3"}'

# Set the visible revset filter. A revset-only payload changes the graph
# without selecting a revision; combine revset + change_id when the target
# may not be visible under the user's current filter.
lightjj api POST /tab/0/api/navigate '{"revset":"trunk()..@"}'
lightjj api POST /tab/0/api/navigate '{"revset":"mutable()","change_id":"xyzabc"}'

# Read inline review comments (annotations) on a change. Note: camelCase param.
lightjj api GET '/tab/0/api/annotations?changeId=xyzabc'

# Post a diff-line review comment. Same store the user's Alt+click writes to.
# severity: must-fix | suggestion | question | nitpick | reviewed
lightjj api POST /tab/0/api/annotations '{"id":"a1","changeId":"xyzabc",
  "filePath":"src/main.go","lineNum":42,"lineContent":"func main() {",
  "comment":"missing error check","severity":"suggestion","author":"agent-name"}'
```

## Driving the revset view

Use `/api/navigate` when the user asks you to change what LightJJ is showing.
Do not run `jj` just to answer "can you set the revset?" — steer the running
viewer through the API so the browser and agent stay in sync.

```bash
# Show the current working stack relative to trunk
lightjj api POST /tab/0/api/navigate '{"revset":"trunk()..@"}'

# Show all mutable work, including alternate heads
lightjj api POST /tab/0/api/navigate '{"revset":"mutable()"}'

# Clear the filter back to the user's default view (their revsets.log)
lightjj api POST /tab/0/api/navigate '{"revset":""}'

# If selecting a commit that may be outside the current view, set revset and
# change_id together. The frontend applies the revset first, then selects.
lightjj api POST /tab/0/api/navigate '{"revset":"xyzabc | present(@) | trunk()","change_id":"xyzabc"}'
```

The revset is applied exactly as if the user typed it: their multi-check
selection is cleared, and a revset-only steer moves the cursor to `@`. `200`
means the hint was *delivered*, not that it worked — the server doesn't
validate revsets. An invalid revset (or an id that doesn't exist) shows jj's
error in the user's message bar and nothing is selected; a valid revset that
doesn't contain `change_id` keeps the new filter and shows a "not in current
revset" toast. `409` = no browser is viewing that tab (ask the user to switch
to it, then retry); while they're mid-rebase/squash/merge/doc-edit the steer
is ignored with a toast.

Confirm with focus — `revset` is the filter of the last graph that loaded
successfully (`""` = default view), so it only matches yours once the steer
landed. Reports are debounced ~0.5 s; check `updated_at` is newer than your
POST:

```bash
lightjj api GET /tab/0/api/focus   # → {"revset":"trunk()..@","change_id":…,"updated_at":…}
```

Prefer narrow revsets for user-facing cleanup work:

- `trunk()..@` — current working-copy stack relative to trunk.
- `mutable()` — local mutable heads and workspace work.
- `<change_id> | present(@) | trunk()` — a target change with enough working
  context for focused review.

## Review loop

A review is multi-turn — the user reads your comments, accepts some, marks
others won't-fix, and may post their own. Be a good participant:

1. **Set `author` on everything you post.** Both `/api/annotations` and
   `/api/doc-comments` take an `author` field. Use a stable name (your harness
   or model name). The UI renders agent comments with a ⟐ prefix and lets the
   user hide-by-author. Without it, your comments look like the user's own and
   you can't tell yours apart on re-read.

2. **Read before writing.** GET the existing comments for the file/change
   before posting. The store upserts by `id` — a re-POST with a fresh UUID is
   a duplicate, not an update. To update, re-POST with the *same* `id`.

3. **Re-read after the user reviews.** Poll `/api/annotations?changeId=...` or
   `/api/doc-comments?path=...` and check `resolution` on the comments you
   posted. `"addressed"` = accepted, `"wontfix"` = rejected, absent = still
   open. There is no "review finished" signal — poll until your ids resolve,
   or agree a convention with the user.

4. **Respect won't-fix.** Don't re-post a finding the user marked
   `resolution: "wontfix"`. They saw it and decided.

5. **Don't write `/api/focus`.** It's the frontend's report of what the user
   is looking at — POSTing to it forges that report and lies to yourself on
   the next read. Use `/api/navigate` to *steer* the user; `/api/focus` to
   *read* where they are.

## Linking to a change

When you've made or found a change the user should look at, hand them a URL
instead of (or as well as) steering with `navigate` — it works even if their
browser tab is closed, and it's the fallback when `navigate` returns `409`
(no browser is viewing the tab you targeted). Take the address from
`lightjj sessions`:

```text
http://127.0.0.1:54321/?change=wqnwkozp
http://127.0.0.1:54321/?change=wqnwkozp&path=src/main.go
http://127.0.0.1:54321/?revset=trunk()..wqnwkozp             # a range / several changes
http://127.0.0.1:54321/?change=wqnwkozp&revset=mine()         # filter, then select within it
```

- `change` — a change id or commit id; the short unique prefixes jj prints are
  fine. If it isn't in the user's current view, lightjj widens the revset once
  to `<id> | @ | trunk()` and selects it; if it still can't be found (or the
  prefix is ambiguous) the previous view is restored and the user sees a
  warning. Ids only — bookmarks, `@`, or expressions go in `revset`.
- `revset` — replaces the revset filter, exactly as if typed. Keep it scoped
  (`trunk()..x`, `mine()`, `ancestors(x, 20) | @`) — never `all()` on a large repo.
- `path` — scroll that change's diff to a file.

The params apply once to the launch repo (tab 0) and are then stripped from the
address bar, so a refresh returns to the plain URL. URL-encode revsets that
contain `&`, `+`, `#`, or spaces.

## Multiple sessions / repos

Discovery matches the agent's cwd against every open tab of each session (not
just the launch repo). Inside any repo lightjj has open, `lightjj api ...`
just works — and a tab-relative `/api/...` path is aimed at the matched tab
for you (`/tab/2/api/log` if your cwd is tab 2's repo; stderr names the tab
when it isn't tab 0). An explicit `/tab/N/...` is sent as written. A stderr
`warning: ... one of them is stale` means the running server and this binary
are different lightjj versions. If nothing matches:

```bash
lightjj sessions                              # see what's running
lightjj api --repo /path/to/other GET /tab/0/api/log
lightjj api --addr 127.0.0.1:54321 GET /tab/0/api/log
```

A session run with `lightjj --remote user@host:/repo` is listed by `sessions`
but won't auto-match — its repo dir is a remote path. Use `--addr`.

## Don't

- Don't `curl` — the entire reason `lightjj api` exists is that harnesses
  deny `curl`. It also won't auto-discover the port or set `Content-Type`.
- Don't run `jj` commands directly when the user is reviewing in lightjj —
  the snapshot loop will pick up your changes and the user's view will jump.
  If you need to mutate, tell the user what you'd do and let them decide.
- Don't open the browser URL or screenshot the UI yourself (handing the user a
  `?change=` link is fine — see "Linking to a change").
- Don't guess endpoint shapes — `lightjj api GET /tab/0/api/agent` documents
  all of them with example payloads.

## Common errors

- **`no running lightjj session matches <path>`** — lightjj isn't running in
  this repo. Ask the user to start it, or pass `--repo`/`--addr`.
- **`address ... is not loopback`** — `--addr` only accepts `127.0.0.1`,
  `::1`, or `localhost`. SSH tunnels: forward to a local port, then `--addr 127.0.0.1:N`.
- **`multiple lightjj sessions match`** — two instances on the same repo.
  `lightjj sessions`, then pick one with `--addr`.
- **HTTP 200 but the body is HTML** — the path fell through to the SPA:
  with `--addr` or raw `curl` nothing is auto-prefixed, so an unprefixed
  `/api/...` needs an explicit `/tab/0/api/...`; otherwise check for a typo.
- **HTTP 400 `Content-Type must be application/json`** — only happens with
  `curl`; `lightjj api` sets it automatically when a body is present.
- **HTTP 400 `changeId required`** — `/api/annotations` uses camelCase query
  params (`changeId`, `id`); `/api/navigate` uses snake_case body fields
  (`change_id`, `file_path`). They predate each other — check `/api/agent`.
