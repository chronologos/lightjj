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
  PATH     verbatim — most routes are tab-scoped: /tab/{N}/api/...
           Root-only: /tabs, /api/config. Tab 0 is the launch repo.
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
# Returns {change_id, commit_id, active_view, doc_file_path, updated_at}.
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

# Show the default jj-ish context used by the UI preset
lightjj api POST /tab/0/api/navigate '{"revset":"present(@) | ancestors(immutable_heads().., 2) | present(trunk())"}'

# If selecting a commit that may be outside the current view, set revset and
# change_id together. The frontend applies the revset first, then selects.
lightjj api POST /tab/0/api/navigate '{"revset":"all() ~ root()","change_id":"xyzabc"}'
```

After steering, verify what the browser accepted:

```bash
lightjj api GET /tab/0/api/focus
lightjj api GET '/tab/0/api/log?revset=trunk()..@'
```

Prefer narrow revsets for user-facing cleanup work:

- `trunk()..@` — current working-copy stack relative to trunk.
- `mutable()` — local mutable heads and workspace work.
- `all() ~ root()` — archaeology only; it will surface remote branches and
  stale artifacts that are not part of the current working view.

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

## Multiple sessions / repos

Discovery matches the agent's cwd against each session's repo dir. If you're
inside the same repo lightjj was launched in, `lightjj api ...` just works. If
not:

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
- Don't open the browser URL or screenshot the UI.
- Don't guess endpoint shapes — `lightjj api GET /tab/0/api/agent` documents
  all of them with example payloads.

## Common errors

- **`no running lightjj session matches <path>`** — lightjj isn't running in
  this repo. Ask the user to start it, or pass `--repo`/`--addr`.
- **`address ... is not loopback`** — `--addr` only accepts `127.0.0.1`,
  `::1`, or `localhost`. SSH tunnels: forward to a local port, then `--addr 127.0.0.1:N`.
- **`multiple lightjj sessions match`** — two instances on the same repo.
  `lightjj sessions`, then pick one with `--addr`.
- **HTTP 200 but the body is HTML** — you forgot the `/tab/N/` prefix; the
  unprefixed path falls through to the SPA. Use `/tab/0/api/...`.
- **HTTP 400 `Content-Type must be application/json`** — only happens with
  `curl`; `lightjj api` sets it automatically when a body is present.
- **HTTP 400 `changeId required`** — `/api/annotations` uses camelCase query
  params (`changeId`, `id`); `/api/navigate` uses snake_case body fields
  (`change_id`, `file_path`). They predate each other — check `/api/agent`.
