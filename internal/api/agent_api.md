# lightjj agent API

lightjj's doc mode lets a human review markdown files with range-anchored
comments and accept/reject text suggestions. Agents interact with the same
comment store via plain HTTP — no ProseMirror, no special client.

This page is served at `GET /api/agent`. A minimal JSON index is at `GET /api`.

## Reaching the server

Automation harnesses often denylist `curl` / `wget` in their shell sandbox.
`lightjj api METHOD PATH [BODY]` makes the same HTTP request via the lightjj
binary itself — already on PATH wherever lightjj is running, and it discovers
the right local instance for your cwd automatically:

```sh
lightjj api GET /tab/0/api/log
```

- **METHOD** — `GET | POST | PUT | DELETE | PATCH` (case-insensitive).
- **PATH** — verbatim URL path including any query string and the `/tab/{N}`
  prefix. Nothing is auto-prefixed.
- **BODY** — optional. A literal JSON string, `@file` to read from a file, or
  `-` to read from stdin. Sets `Content-Type: application/json` automatically.
- **`--addr host:port`** — bypass discovery. Use for SSH-tunnel endpoints or
  to disambiguate when several lightjj instances are running. Loopback only.
- **`--repo path`** — match a different repo than the cwd (discovery normally
  matches your cwd against each session's repo dir).
- **`-H "Key: Value"`** — extra request header (repeatable).
- **`lightjj sessions`** — lists running instances (PID, addr, mode, repo) so
  you can pick an `--addr`.

The response body always goes to **stdout** — even on 4xx/5xx, so it can be
piped to `jq`. Status and discovery errors go to **stderr**. Exit codes:
`0` HTTP 2xx, `1` discovery/connection error, `2` usage error,
`4` HTTP 4xx (request was wrong, don't retry), `5` HTTP 5xx (server error,
maybe retry).

**Quote query strings.** A bare `&` backgrounds the shell command:

```sh
lightjj api GET '/tab/0/api/file-show?revision=@&path=docs/DESIGN.md'
```

**Always include the `/tab/{N}/` prefix.** Nearly every route is tab-scoped:
`<base> = /tab/{N}`. Tab 0 is the repo lightjj was launched in;
`GET /tabs` lists open tabs with their paths if you need a different one.
`GET <base>/api/capabilities` returns `{api_version, jj_version, actions:
[...]}` so you can probe for endpoint availability instead of 404-handling.
The only root-mounted routes are `GET|POST /tabs`, `DELETE /tabs/{id}`, and
`GET|POST /api/config` (and `/api/config/raw`). An unprefixed `/api/...` path
falls through to the SPA catch-all and returns **HTML, not a 404** — if you
get HTML back, you forgot the `/tab/{N}/` prefix.

lightjj only accepts requests with `Host: localhost` (DNS-rebinding
protection). If running on a different machine, use an SSH tunnel that keeps
the Host header local, then pass the tunnel port via `--addr`:

```sh
# On the machine running lightjj (forward to the remote host):
ssh -R 8080:localhost:<lightjj-port> user@remote-host
# On the remote host:
lightjj api --addr localhost:8080 GET /tab/0/api/log
```

### Fallback: raw HTTP (no `lightjj` on PATH)

If the `lightjj` binary isn't available in your sandbox, discover the server
address from the session file directly. A running lightjj writes
`{pid, addr, port, repo_dir, mode, started_at}` to
`$XDG_RUNTIME_DIR/lightjj/sessions/<pid>.json` (or
`$TMPDIR/lightjj-<uid>/sessions/<pid>.json` where `$XDG_RUNTIME_DIR` is unset
— macOS, most servers). To find the instance for the repo you're working in:

```sh
dir="${XDG_RUNTIME_DIR:-${TMPDIR:-/tmp}/lightjj-$(id -u)}"
[ -n "$XDG_RUNTIME_DIR" ] && dir="$dir/lightjj"
[ -O "$dir/sessions" ] || exit 1   # refuse a dir you don't own
jq -r --arg repo "$PWD" 'select(.repo_dir == $repo) | .addr' "$dir"/sessions/*.json
# → 127.0.0.1:54321
```

On a shared `/tmp`, verify you own the directory before trusting `addr` —
lightjj refuses to *write* into a dir it doesn't own, but a planted file would
otherwise redirect your traffic. Unix only; on Windows fall back to the
`Agent hint` button in the doc-mode UI which shows the URL directly.

When `curl`-ing, set `Content-Type: application/json` explicitly on POSTs;
the server rejects bodies without it. The doc-mode UI's **Agent hint** button
still shows the `<base>` URL for the open file if you prefer the manual route.

## Read the document

```
GET <base>/api/file-show?revision=@&path=docs/DESIGN.md
→ 200 {"content": "# Design\n\n..."}
```

`path` is repo-relative, forward slashes, no leading `./` or `/`. Use the same
form everywhere — it must byte-match across `file-show` and `doc-comments`.

## Anchor model

Comments and suggestions are anchored by **content**, not line numbers or
byte offsets:

```jsonc
{
  "selection":     "the exact phrase you're commenting on",   // required
  "contextBefore": "up to ~40 chars immediately before it",   // optional, "" at file start
  "contextAfter":  "up to ~40 chars immediately after it"     // optional, "" at file end
}
```

Matching is **lenient on markdown syntax and whitespace**: the characters
`` * _ ` ~ [ ] ( ) ! # > | `` and all whitespace runs are normalized away
before comparison, so anchor against rendered prose and
don't worry about whether `**bold**` or a paragraph break falls inside the
window. If `selection` is unique it lands exactly; context disambiguates
duplicates; if the text was deleted the comment shows as "orphaned". A tied
context score also orphans (rather than guess).

**Anchor against what renders, not what's in the source.** Link/image URLs,
HTML comments, and table pipes are not in the matched text — only link *text*
is. For `[race.png](205-race-a.png)` in a table row, this works:

```jsonc
{ "selection": "Reference",
  "contextBefore": "solves it · race.png" }   // link text ✓
```

and this orphans:

```jsonc
{ "selection": "Reference",
  "contextBefore": "205-race-a.png) | " }     // URL + table pipe ✗
```

## Post a comment

```
POST <base>/api/doc-comments
Content-Type: application/json
```
```jsonc
{
  "id": "c-1",                       // optional — server assigns if omitted
  "filePath": "docs/DESIGN.md",      // required — repo-relative, see above
  "anchor": { "selection": "...", "contextBefore": "...", "contextAfter": "..." },
  "kind": "comment",                 // "comment" | "suggestion"
  "body": "markdown body",           // optional — rendered in the rail
  "author": "agent-name",            // optional — shown next to timestamp
  "createdAt": 1746543600000         // optional Unix epoch ms — server stamps if omitted
}
```

→ `200` with the stored record echoed (including any server-assigned `id` /
`createdAt`). `400` on missing `filePath` or path-escape.

**Upsert semantics**: POSTing an existing `id` replaces the record. The server
preserves an existing `resolution`/`resolvedAt` if your body omits them, so
re-posting to amend `body` won't clear the human's accept/reject.

## Post a suggestion

Same endpoint, `kind: "suggestion"` plus `suggestion.replacement`:

```jsonc
{
  "filePath": "docs/DESIGN.md",
  "anchor": { "selection": "single-binary", "contextBefore": "powerful, ", "contextAfter": " Jujutsu" },
  "kind": "suggestion",
  "suggestion": { "replacement": "single binary" },
  "body": "prefer hyphenless per style guide",
  "author": "agent-name"
}
```

The user sees the selection struck through with the replacement below it and
**Accept** / **Reject** buttons. Accept replaces the text in the live editor
(the file on disk updates when the user clicks Save).

## Batch post

For multiple comments at once, `POST <base>/api/doc-comments/batch` validates
the entire array before writing any (all-or-nothing):

```jsonc
{
  "filePath": "docs/DESIGN.md",
  "comments": [
    { "anchor": {"selection": "..."}, "kind": "comment", "body": "..." },
    { "anchor": {"selection": "..."}, "kind": "suggestion",
      "suggestion": {"replacement": "..."}, "body": "..." }
  ]
}
```

→ `200` with the stamped array (server-assigned `id`/`createdAt` filled in).
`400` with `comments[N].anchor.selection required` if any entry is invalid; in
that case nothing is written.

## Wire format conventions

Two field-naming styles coexist **by design** — they signal which domain an
endpoint belongs to:

- **jj-domain endpoints** (log, diff, mutations, `navigate`, `focus`) use
  **snake_case** fields: `change_id`, `file_path`, `source_mode`.
- **review-domain endpoints** (`doc-comments`, `annotations`) use
  **camelCase** fields: `filePath`, `changeId`, `lineNum`. They predate the
  snake_case convention, and renaming them would break stored review data.

Don't normalize one style to the other when constructing requests; check the
per-endpoint examples in this document.

Success-response shapes by endpoint family:

- **jj mutation POSTs** (`new`, `edit`, `abandon`, `describe`, `rebase`,
  `squash`, `split`, `resolve`, `restore`, `restore-from`, `commit`, `undo`,
  `snapshot`, `bookmark/*`, `workspace/*`, `op/*`, `git/*`) and the four
  non-jj actions `navigate`, `file-write`, `open-file`, `unlock-repo` return
  one envelope: `{"output": "...", "warnings": "..."}` — `warnings` present
  only when jj warned, `output` empty for the non-jj actions.
- **Review-store POSTs return the stored record**, not the envelope:
  `POST /api/annotations` and `POST /api/doc-comments` echo the upserted
  object (with server-stamped fields like `createdAt`/`id`);
  `POST /api/doc-comments/batch` returns the stamped array.
- `POST /api/config` and `POST /api/state/recent-actions` return an empty
  200 body. `POST /api/focus` echoes the stored focus state.

Errors are `{"error": "..."}` with a 4xx/5xx status everywhere.
`GET <base>/api/capabilities` reports `api_version`, which bumps when an
existing shape changes incompatibly.

## Diff annotations

Doc-comments anchor on rendered prose; **annotations** anchor on a diff line.
Use them when reviewing a code change rather than a markdown document. They
live in a separate per-`changeId` store and use **camelCase** params (this
endpoint predates the snake_case convention used by `navigate`/`focus`).

```
GET  <base>/api/annotations?changeId=<change_id>
POST <base>/api/annotations
DELETE <base>/api/annotations?changeId=<change_id>&id=<id>
```

POST body — upserted by `id` (re-POST same `id` to edit; new `id` to add):

```jsonc
{
  "id": "a1b2c3",                    // your UUID — pick once, reuse to update
  "changeId": "wqnwkozp",
  "filePath": "src/handlers.go",
  "lineNum": 42,                     // 1-based; 0 = whole-file
  "side": "new",                     // "new" (default) | "old" — comment on a deleted line
  "lineContent": "func main() {",    // snapshot — used for re-anchor after rewrite
  "comment": "missing error check",
  "severity": "suggestion",          // must-fix | suggestion | question | nitpick | reviewed
  "author": "agent-name",            // optional but RECOMMENDED — see below
  "createdAtCommitId": "abc123",     // commit_id when posted — re-anchor baseline
  "createdAt": 1746543600000         // ms epoch; server-stamped if omitted
}
```

`severity` is a closed vocabulary — values outside the list above store fine
but render with no color and are filtered out of the per-severity chip bar.
A re-POST with an existing `id` preserves the stored `resolution`, `status`,
`resolvedAtCommitId`, and `createdAt` when you omit them — amending the body
won't wipe the user's accept/reject.

`author` distinguishes agent-posted from user-posted. The UI renders agent
comments with a `⟐` prefix and offers "Hide author"; without it your comments
are indistinguishable from the user's own and you can't filter on re-read.
Same contract as `DocComment.author`.

Responses on read-back have `resolution` (`"addressed"` | `"wontfix"` | absent)
and `status` set when the user resolves them — same poll loop as doc-comments.

## Steer the user's view

```
POST <base>/api/navigate
Content-Type: application/json
{"change_id": "wqnwkozp", "file_path": "src/handlers.go"}
```

→ `200`. The connected browser switches to that revision and scrolls the diff
to that file. Use this to walk the user through a review: post a batch of
comments, then `navigate` to the first one. At least one of `change_id`,
`file_path`, or `comment_id` is required; `line` is accepted but currently
ignored. `503` if the server was started with `--no-watch` (no SSE channel to
push through). Ignored if the user is mid-rebase/squash/merge/doc-mode —
they'll see an info toast instead.

To jump straight to a specific comment, send `comment_id` (the `id` you got
back from `POST /api/doc-comments` or from a `GET` poll):

```jsonc
{"comment_id": "c-1"}
```

The server passes `comment_id` through unchanged — the frontend resolves it
against its loaded comment stores and scrolls to that thread. If the id isn't
loaded in the user's current view, nothing happens. Combine with `change_id`
or `file_path` if you want a fallback scroll target.

To change the visible graph filter first, include `revset`. A revset-only
payload updates the filter without selecting a revision; combining `revset`
with `change_id` reloads the graph and then selects that change:

```jsonc
{"revset": "trunk()..@", "change_id": "wqnwkozp"}
```

## Read the user's current view

```
GET <base>/api/focus
→ 200 {"change_id":"wqnwkozp","commit_id":"abc123","active_view":"doc",
       "doc_file_path":"docs/DESIGN.md","updated_at":1746543600000}
```

The complement to `navigate`: instead of pushing the user somewhere, ask where
they are. Use it to scope a review pass to what the user is already looking at,
or to skip a `navigate` if they're already there.

- `active_view` — one of `log | branches | merge | doc | oplog | evolog`.
  `oplog`/`evolog` are reported when those drawers are open over the log view.
  When `doc`, `doc_file_path` is the open file (repo-relative, same form as
  `file-show` / `doc-comments` paths). `doc_file_path` is reported as the
  frontend sent it — don't trust it as a pre-validated path; the consumer
  endpoints (`doc-comments`, `file-show`) do their own validation.
- `change_id` / `commit_id` — the revision the diff/doc panel is showing.
  Empty when nothing is selected.
- `updated_at` — Unix epoch **milliseconds**, **server-stamped** on every
  frontend report (the client's clock is not trusted). `0` means the frontend
  has never reported.

**Staleness**: the frontend reports on view changes AND on a ~20 s heartbeat
while the tab is visible. If `updated_at` is more than ~60 s old, assume the
report is stale (browser tab closed, machine asleep, or an older lightjj that
doesn't report focus) and fall back to `navigate` rather than acting on it.
Don't poll this aggressively — it's a snapshot, not a stream.

`POST /api/focus` is the **frontend's write path**. Agents shouldn't write to
it — a forged report just lies to the next agent that reads it (and to
yourself). It's documented here only so the contract is complete.

## Read back / poll

```
GET <base>/api/doc-comments?path=docs/DESIGN.md
→ 200 [{"id": "...", "resolution": "addressed", ...}, ...]
```

`resolution` is `"addressed"` (accepted/resolved), `"wontfix"` (rejected), or
absent (open). Note: `addressed` means the user accepted in-editor; the change
reaches disk only after they Save, so `file-show` may lag. There is no
"review finished" signal — poll until all your ids have a `resolution`, or
agree a convention with the user (e.g. they post a final comment with
`body: "done"`).

## Threading

Replies set `parentId` to the root comment's `id` and reuse the root's anchor:

```jsonc
{ "filePath": "docs/DESIGN.md", "parentId": "c-1",
  "anchor": { "selection": "...", "contextBefore": "...", "contextAfter": "..." },
  "kind": "comment", "body": "follow-up", "author": "agent-name" }
```

## Delete

```
DELETE <base>/api/doc-comments?path=docs/DESIGN.md&id=<id>
→ 200
```

`id` is **required** (400 if omitted). Deleting a root cascades to its direct
replies.
