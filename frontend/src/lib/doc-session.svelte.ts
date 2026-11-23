// Doc-mode session: in-memory ProseMirror state for a single .md file plus
// range-anchored comments. Two-tier model (in-memory ↔ file) — no IndexedDB,
// no merge engine. Comments persist server-side with content-addressed anchors;
// {from, to} PM positions are session-local cache recomputed on every import.
//
// State ownership: this factory owns comments + metadata. DocView owns the
// EditorView and dispatches transactions, calling onTransaction here so comment
// positions track edits.
//
// Data model mirrors annotations.svelte.ts: `stored` is the wire truth
// (DocComment[], what mutations operate on and what persists), `placement` is
// session-local PM position state, and `comments` is the PlacedReview[]
// read-model projection (review.ts) that DocView/DocCommentRail render.

import type { Transaction } from 'prosemirror-state'
import type { Node } from 'prosemirror-model'
import { parseMarkdown, serializeMarkdown } from './pm-schema'
import { captureAnchor, refind } from './reanchor'
import { createLoader } from './loader.svelte'
import { createReviewMutations } from './review-mutations.svelte'
import { fromDocComment, type PlacedReview } from './review'
import { apiErrorCode } from './api-error'
import { api as sharedApi, type DocComment, type FileWriteGuard } from './api'
import { bindTab } from './tab-scope'
import { detectEol, notUtf8Message, withEol } from './eol'

/** Session-local placement for one comment id (not persisted). */
type Placement = { from?: number; to?: number; orphaned: boolean }

// PM positions count node-open/close tokens; refind/captureAnchor work on flat
// text. buildTextMap walks text nodes once and gives both directions. No block
// separator — segments are contiguous, so context spans paragraph boundaries
// as adjacent chars (slightly weaker disambiguation, but the map stays exact).
function buildTextMap(doc: Node) {
  let text = ''
  const segs: Array<{ t: number; p: number; len: number }> = []
  doc.descendants((node, pos) => {
    if (node.isText && node.text) {
      segs.push({ t: text.length, p: pos, len: node.text.length })
      text += node.text
    }
  })
  // toPM: at a segment boundary (off == prev.end == next.start) the two
  // candidate PM positions can live in different structural parents (table
  // cell, list item, heading). bias=1 ("from") wants next segment's start,
  // bias=-1 ("to") wants prev segment's end — otherwise tr.insertText spans
  // the node boundary and restructures the tree (observed: table suggestion
  // landing in the wrong column; suffix-of-paragraph eating the next heading).
  const toPM = (off: number, bias: 1 | -1): number => {
    let prevEnd = -1
    for (const s of segs) {
      if (off === s.t && bias < 0 && prevEnd >= 0) return prevEnd
      if (off >= s.t && off < s.t + s.len) return s.p + (off - s.t)
      if (off === s.t + s.len) prevEnd = s.p + s.len
    }
    if (prevEnd >= 0) return prevEnd
    return doc.content.size
  }
  const toText = (pm: number): number => {
    let nearest = 0
    for (const s of segs) {
      if (pm >= s.p && pm <= s.p + s.len) return s.t + (pm - s.p)
      if (s.p < pm) nearest = s.t + s.len
    }
    return nearest
  }
  // Single placement helper so import_ + refreshComments stay in lockstep on
  // bias semantics. Zero-width hits (refind Stage-3) use ONE bias for both
  // ends — opposite biases at a boundary would yield from > to.
  const place = (hit: { from: number; to: number }) => {
    const from = toPM(hit.from, 1)
    const to = hit.to === hit.from ? from : toPM(hit.to, -1)
    return { from, to: Math.max(from, to) }
  }
  return { text, toPM, toText, place }
}

// Wire anchor equality (note: api.ts has no named DocAnchor type — index into
// DocComment, the previous `import('./api').DocAnchor` silently resolved to any).
function anchorEq(a: DocComment['anchor'], b: DocComment['anchor']): boolean {
  return a.selection === b.selection && a.contextBefore === b.contextBefore && a.contextAfter === b.contextAfter
}

export type DocSession = ReturnType<typeof createDocSession>

export function createDocSession(
  filePath: string,
  getWorkingCopyCommitId: () => string | undefined,
) {
  const api = bindTab(sharedApi) // multi-request writes stay in the tab they started in
  // The PM Node, not EditorState — DocView owns EditorState (plugins, history)
  // and notifies us via onTransaction. Keeping state here would mean two
  // EditorState instances applying the same tr → reconfigure-on-every-keystroke
  // when DocView tries to sync (different doc instances, same content).
  let doc = $state<Node | null>(null)
  // Wire truth — what the server has plus optimistic writes. Mutations operate
  // on this; never on the projection.
  let stored = $state<DocComment[]>([])
  // PM positions per comment id. Always REASSIGNED (never .set() in place) so
  // the `comments` $derived sees the change — plain Maps aren't deeply reactive.
  let placement = $state<Map<string, Placement>>(new Map())
  // Commit the buffer was last equal to — the write precondition.
  let baseCommitId = $state('')
  let eol: '\n' | '\r\n' = '\n'
  let version = $state(0)
  let committedVersion = $state(0)
  let saving = $state(false)
  // serialize(parse(md)) when it differs from md — caller can diff against the
  // file to show what the first commitBack will rewrite. Null = byte-identical.
  let normalizationDiff = $state<string | null>(null)

  // Read-model projection (review.ts PlacedReview) — what DocView and
  // DocCommentRail render. Missing placement (shouldn't happen — import_ and
  // refreshComments place every stored id) degrades to orphaned.
  const comments = $derived<PlacedReview[]>(stored.map((c) => ({
    ...fromDocComment(c),
    ...(placement.get(c.id) ?? { orphaned: true }),
  })))

  // Shared concurrency policy (review-mutations.svelte.ts): optimistic apply +
  // gen-guarded rollback. The gen is shared with import_/refreshComments/
  // onTransaction so a rollback never restores a snapshot that a load, a
  // refresh, or a typing remap has since replaced. Mutation failures are
  // surfaced via `error` (callers are fire-and-forget), so the core's rethrow
  // is swallowed at each call site.
  const mutations = createReviewMutations()

  const importLoader = createLoader(async () => {
    const commitId = getWorkingCopyCommitId()
    if (!commitId) throw new Error('working copy unavailable')
    const { content, lossy } = await api.fileShow(commitId, filePath)
    if (lossy) throw new Error(notUtf8Message(filePath))
    const doc = parseMarkdown(content)
    const tm = buildTextMap(doc)
    const wire = await api.docComments.list(filePath)
    const placed = new Map<string, Placement>(wire.map((c) => {
      const hit = refind(c.anchor, tm.text)
      return [c.id, hit ? { ...tm.place(hit), orphaned: false } : { orphaned: true }]
    }))
    return { commitId, content, doc, wire, placed }
  }, null)

  async function import_(): Promise<void> {
    const g = mutations.bump()
    const ok = await importLoader.load()
    if (!ok || !mutations.current(g) || !importLoader.value) return
    const { commitId, content, doc: parsed, wire, placed } = importLoader.value
    doc = parsed
    stored = wire
    placement = placed
    baseCommitId = commitId
    version = 0
    committedVersion = 0
    // Mixed endings can't be kept; the normalization notice says what will change.
    const detected = detectEol(content)
    eol = detected === 'mixed' ? '\n' : detected
    const rt = serialize()
    normalizationDiff = rt === content ? null : rt
  }

  // Re-fetch comments and re-place against the CURRENT doc — does not touch
  // doc/version, so safe to call while dirty. Polled while doc-mode is active so
  // agent POSTs appear without a destructive reload(). Skips while a local
  // optimistic mutation is in flight: a refresh resolving between apply() and
  // persist() would briefly drop the local write (server hasn't seen it yet);
  // the next poll tick recovers. gen check covers the typing case
  // (onTransaction bumps gen, stale placement discarded).
  async function refreshComments(): Promise<void> {
    if (!doc || mutations.mutating) return
    const g = mutations.bump()
    let wire: DocComment[]
    try {
      wire = await api.docComments.list(filePath)
    } catch {
      return
    }
    if (!mutations.current(g) || mutations.mutating || !doc) return
    const tm = buildTextMap(doc)
    // Preserve existing local placement for known ids whose anchor is unchanged
    // — onTransaction has been remapping their from/to through every edit,
    // which is exact. Re-running refind would orphan accepted suggestions
    // (stored selection no longer exists). New ids OR same id with a changed
    // anchor (agent re-upsert to move a comment) fall through to refind.
    const prevWire = new Map(stored.map((c) => [c.id, c]))
    placement = new Map(wire.map((c) => {
      const pw = prevWire.get(c.id)
      const pp = placement.get(c.id)
      if (pw && pp && pp.from !== undefined && anchorEq(pw.anchor, c.anchor)) {
        return [c.id, pp]
      }
      const hit = refind(c.anchor, tm.text)
      return [c.id, hit ? { ...tm.place(hit), orphaned: false } : { orphaned: true }]
    }))
    stored = wire
  }

  function onTransaction(tr: Transaction, newDoc: Node): void {
    doc = newDoc
    if (tr.docChanged) {
      version++
      // Bump gen: this rewrites placement, so any in-flight optimistic rollback
      // must NOT restore its pre-edit snapshot (positions would be stale).
      mutations.bump()
      placement = new Map([...placement].map(([id, p]) =>
        p.orphaned || p.from === undefined || p.to === undefined
          ? [id, p]
          : [id, { ...p, from: tr.mapping.map(p.from), to: tr.mapping.map(p.to, -1) }],
      ))
    }
  }

  function serialize(): string {
    return doc ? withEol(serializeMarkdown(doc), eol) : ''
  }

  async function writeAndAdvance(md: string, atVersion: number, guard?: FileWriteGuard): Promise<void> {
    const { commit_id } = await api.fileWrite(filePath, md, guard)
    // atVersion was captured alongside md at serialize() time — reading live
    // `version` here would mark a keystroke that landed during the await as
    // committed, silently dropping it on close.
    committedVersion = atVersion
    if (commit_id) baseCommitId = commit_id
    normalizationDiff = null
  }

  // The server compares the file on disk with baseCommitId (after snapshotting)
  // and refuses the write if they differ. Caller wraps in withMutation; on
  // 'stale' shows [Reload | Overwrite].
  async function commitBack(): Promise<'ok' | 'stale' | 'noop'> {
    if (!doc || version === committedVersion) return 'noop'
    saving = true
    try {
      const atVersion = version
      await writeAndAdvance(serialize(), atVersion, { baseCommitId })
      return 'ok'
    } catch (e) {
      if (apiErrorCode(e) === 'content_changed') return 'stale'
      throw e
    } finally {
      saving = false
    }
  }

  async function overwrite(): Promise<void> {
    if (!doc) return
    saving = true
    try {
      const atVersion = version
      await writeAndAdvance(serialize(), atVersion) // no guard: the user chose to overwrite
    } finally {
      saving = false
    }
  }

  async function reload(): Promise<void> {
    await import_()
  }

  async function addComment(
    from: number,
    to: number,
    body: string,
    parentId?: string,
  ): Promise<void> {
    if (!doc) return
    const tm = buildTextMap(doc)
    const anchor = captureAnchor(tm.text, tm.toText(from), tm.toText(to))
    const c: DocComment = {
      id: crypto.randomUUID(),
      filePath,
      parentId,
      anchor,
      kind: 'comment',
      body,
      author: 'user',
      createdAt: Date.now(),
    }
    const snapStored = stored
    const snapPlacement = placement
    await mutations.run({
      apply: () => {
        stored = [...stored, c]
        placement = new Map(placement).set(c.id, { from, to, orphaned: false })
      },
      persist: () => api.docComments.upsert(c),
      rollback: (stillCurrent) => {
        if (stillCurrent) { stored = snapStored; placement = snapPlacement }
      },
    }).catch(() => { /* surfaced via `error` — callers are fire-and-forget */ })
  }

  async function resolveComment(id: string, resolution: 'addressed' | 'wontfix'): Promise<void> {
    const c = stored.find((x) => x.id === id)
    if (!c) return
    const updated: DocComment = { ...c, resolution, resolvedAt: Date.now() }
    const snapshot = stored
    await mutations.run({
      apply: () => { stored = stored.map((x) => (x.id === id ? updated : x)) },
      persist: () => api.docComments.upsert(updated),
      rollback: (stillCurrent) => { if (stillCurrent) stored = snapshot },
    }).catch(() => { /* surfaced via `error` */ })
  }

  async function removeComment(id: string): Promise<void> {
    const snapshot = stored
    await mutations.run({
      apply: () => { stored = stored.filter((x) => x.id !== id && x.parentId !== id) },
      persist: () => api.docComments.remove(filePath, id),
      rollback: (stillCurrent) => { if (stillCurrent) stored = snapshot },
    }).catch(() => { /* surfaced via `error` */ })
  }

  // Returns the edit spec for a suggestion; caller (DocView) builds+dispatches
  // the transaction, then calls resolveComment(id, 'addressed'). Kept pure so
  // session has no view coupling — DocView owns EditorState.
  function acceptSuggestion(id: string): { from: number; to: number; replacement: string } | null {
    const c = comments.find((x) => x.id === id)
    if (!c || c.kind !== 'suggestion' || c.orphaned || !c.suggestion) return null
    if (c.from === undefined || c.to === undefined || c.from > c.to) return null
    return { from: c.from, to: c.to, replacement: c.suggestion.replacement }
  }

  // Resolved-but-orphaned isn't actionable — the user already acted on it; the
  // anchor is by definition stale (Accept replaced its selection). Surfacing it
  // in the orphan drawer reads as a regression.
  const orphanedComments = $derived(comments.filter((c) => c.orphaned && !c.parentId && !c.resolution))
  const dirty = $derived(version > committedVersion)

  return {
    filePath,
    get doc() { return doc },
    get comments() { return comments },
    get orphanedComments() { return orphanedComments },
    get dirty() { return dirty },
    get saving() { return saving },
    get error() { return importLoader.error || mutations.error },
    get busy() { return importLoader.loading },
    get baseCommitId() { return baseCommitId },
    get normalizationDiff() { return normalizationDiff },
    import_,
    refreshComments,
    onTransaction,
    serialize,
    commitBack,
    overwrite,
    reload,
    addComment,
    resolveComment,
    removeComment,
    acceptSuggestion,
  }
}
