# lightjj agent API — doc-mode comments & suggestions

lightjj's doc mode lets a human review markdown files with range-anchored
comments and accept/reject text suggestions. Agents interact with the same
comment store via plain HTTP — no ProseMirror, no special client.

This page is served at `GET /api/agent`. A minimal JSON index is at `GET /api`.

## Reaching the server

`<base>` below means **the URL you used to fetch this page, minus
`/api/agent`** — e.g. fetched `http://localhost:8080/tab/0/api/agent` →
`<base> = http://localhost:8080/tab/0`. The doc-mode UI's **Agent hint**
button shows this value for the open file.

lightjj only accepts requests with `Host: localhost` (DNS-rebinding
protection), so reaching it from another machine requires an SSH tunnel that
keeps the Host header local:

```sh
# On the laptop running lightjj (forward to the agent's host):
ssh -R 8080:localhost:<lightjj-port> user@agent-host
# Agent then uses <base> = http://localhost:8080/tab/0
```

All routes are tab-scoped: `<base> = <origin>/tab/{N}`. Tab 0 is the repo
lightjj was launched in; `GET <origin>/tabs` lists open tabs with their paths.

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
duplicates; if the text was deleted the comment shows as "orphaned".

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
