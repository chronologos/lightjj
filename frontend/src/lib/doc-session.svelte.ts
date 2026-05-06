// Doc-mode session: in-memory ProseMirror state for a single .md file plus
// range-anchored comments. Two-tier model (in-memory ↔ file) — no IndexedDB,
// no merge engine. Comments persist server-side with content-addressed anchors;
// {from, to} PM positions are session-local cache recomputed on every import.
//
// State ownership: this factory owns comments + metadata. DocView owns the
// EditorView and dispatches transactions, calling onTransaction here so comment
// positions track edits.

import type { Transaction } from 'prosemirror-state'
import type { Node } from 'prosemirror-model'
import { parseMarkdown, serializeMarkdown } from './pm-schema'
import { captureAnchor, refind } from './reanchor'
import { createLoader } from './loader.svelte'
import { api, type DocComment } from './api'

/** DocComment + session-local position state (not persisted). */
export type PlacedComment = DocComment & {
  from?: number
  to?: number
  orphaned: boolean
}

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
  const toPM = (off: number): number => {
    for (const s of segs) {
      if (off >= s.t && off <= s.t + s.len) return s.p + (off - s.t)
    }
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
  return { text, toPM, toText }
}

async function sha256Hex(s: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s))
  return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('')
}

export type DocSession = ReturnType<typeof createDocSession>

export function createDocSession(
  filePath: string,
  getWorkingCopyCommitId: () => string | undefined,
) {
  // The PM Node, not EditorState — DocView owns EditorState (plugins, history)
  // and notifies us via onTransaction. Keeping state here would mean two
  // EditorState instances applying the same tr → reconfigure-on-every-keystroke
  // when DocView tries to sync (different doc instances, same content).
  let doc = $state<Node | null>(null)
  let comments = $state<PlacedComment[]>([])
  let baseCommitId = $state('')
  let baseContentHash = $state('')
  let version = $state(0)
  let committedVersion = $state(0)
  let saving = $state(false)
  // serialize(parse(md)) when it differs from md — caller can diff against the
  // file to show what the first commitBack will rewrite. Null = byte-identical.
  let normalizationDiff = $state<string | null>(null)

  // Guards add/resolve/remove against a concurrent import_ overwriting comments[].
  // Symmetric: bump BEFORE await, check AFTER (CLAUDE.md gen-counter rule).
  let gen = 0
  const bumpGen = () => ++gen

  // Optimistic-write helper: snapshot, apply, await, rollback+surface on error.
  // Mutations apply locally first so the UI is instant; if the server write
  // fails (SSH drop, 500) the local state must not silently diverge.
  let mutationError = $state('')
  let inFlightMutation = 0
  async function optimistic(apply: () => void, persist: () => Promise<unknown>): Promise<void> {
    const g = bumpGen()
    const snapshot = comments
    apply()
    mutationError = ''
    inFlightMutation++
    try {
      await persist()
    } catch (e) {
      // Only roll back if nothing else (import_/onTransaction/another mutation)
      // has written comments since — restoring a stale snapshot would clobber
      // remapped positions or a fresh load.
      if (g === gen) comments = snapshot
      mutationError = e instanceof Error ? e.message : String(e)
    } finally {
      inFlightMutation--
    }
  }

  const importLoader = createLoader(async () => {
    const commitId = getWorkingCopyCommitId()
    if (!commitId) throw new Error('working copy unavailable')
    const { content } = await api.fileShow(commitId, filePath)
    const doc = parseMarkdown(content)
    const tm = buildTextMap(doc)
    const stored = await api.docComments.list(filePath)
    const placed: PlacedComment[] = stored.map((c) => {
      const hit = refind(c.anchor, tm.text)
      return hit
        ? { ...c, from: tm.toPM(hit.from), to: tm.toPM(hit.to), orphaned: false }
        : { ...c, orphaned: true }
    })
    return { commitId, content, doc, placed }
  }, null)

  async function import_(): Promise<void> {
    const g = bumpGen()
    const ok = await importLoader.load()
    if (!ok || g !== gen || !importLoader.value) return
    const { commitId, content, doc: parsed, placed } = importLoader.value
    doc = parsed
    comments = placed
    baseCommitId = commitId
    baseContentHash = await sha256Hex(content)
    version = 0
    committedVersion = 0
    const rt = serializeMarkdown(doc)
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
    if (!doc || inFlightMutation > 0) return
    const g = bumpGen()
    let stored: DocComment[]
    try {
      stored = await api.docComments.list(filePath)
    } catch {
      return
    }
    if (g !== gen || inFlightMutation > 0 || !doc) return
    const tm = buildTextMap(doc)
    comments = stored.map((c) => {
      const hit = refind(c.anchor, tm.text)
      return hit
        ? { ...c, from: tm.toPM(hit.from), to: tm.toPM(hit.to), orphaned: false }
        : { ...c, orphaned: true }
    })
  }

  function onTransaction(tr: Transaction, newDoc: Node): void {
    doc = newDoc
    if (tr.docChanged) {
      version++
      // Bump gen: this writes comments[], so any in-flight optimistic() rollback
      // must NOT restore its pre-edit snapshot (positions would be stale).
      bumpGen()
      comments = comments.map((c) =>
        c.orphaned || c.from === undefined || c.to === undefined
          ? c
          : { ...c, from: tr.mapping.map(c.from), to: tr.mapping.map(c.to, -1) },
      )
    }
  }

  function serialize(): string {
    return doc ? serializeMarkdown(doc) : ''
  }

  async function writeAndAdvance(md: string, atVersion: number, commitId: string): Promise<void> {
    await api.fileWrite(filePath, md)
    // atVersion was captured alongside md at serialize() time — reading live
    // `version` here would mark a keystroke that landed during the await as
    // committed, silently dropping it on close.
    committedVersion = atVersion
    baseContentHash = await sha256Hex(md)
    // Best-effort: the watcher will snapshot post-write and bump @'s commit_id;
    // we record the pre-write id since we can't observe the new one synchronously.
    // The hash is the real OCC token — baseCommitId is only for fileShow(base)
    // in a future merge-style display, which Phase 2 doesn't have.
    baseCommitId = commitId
    normalizationDiff = null
  }

  // Best-effort staleness check (not CAS — there's a window between read and
  // write). Caller wraps in withMutation; on 'stale' shows [Reload | Overwrite].
  async function commitBack(): Promise<'ok' | 'stale' | 'noop'> {
    if (!doc || version === committedVersion) return 'noop'
    const commitId = getWorkingCopyCommitId()
    if (!commitId) throw new Error('working copy unavailable')
    saving = true
    try {
      const { content } = await api.fileShow(commitId, filePath)
      if ((await sha256Hex(content)) !== baseContentHash) return 'stale'
      const atVersion = version
      await writeAndAdvance(serialize(), atVersion, commitId)
      return 'ok'
    } finally {
      saving = false
    }
  }

  async function overwrite(): Promise<void> {
    if (!doc) return
    const commitId = getWorkingCopyCommitId()
    if (!commitId) throw new Error('working copy unavailable')
    saving = true
    try {
      const atVersion = version
      await writeAndAdvance(serialize(), atVersion, commitId)
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
    await optimistic(
      () => { comments = [...comments, { ...c, from, to, orphaned: false }] },
      () => api.docComments.upsert(c),
    )
  }

  async function resolveComment(id: string, resolution: 'addressed' | 'wontfix'): Promise<void> {
    const c = comments.find((x) => x.id === id)
    if (!c) return
    const updated: DocComment = { ...stripLocal(c), resolution, resolvedAt: Date.now() }
    await optimistic(
      () => { comments = comments.map((x) => (x.id === id ? { ...x, resolution, resolvedAt: updated.resolvedAt } : x)) },
      () => api.docComments.upsert(updated),
    )
  }

  async function removeComment(id: string): Promise<void> {
    await optimistic(
      () => { comments = comments.filter((x) => x.id !== id && x.parentId !== id) },
      () => api.docComments.remove(filePath, id),
    )
  }

  // Returns the edit spec for a suggestion; caller (DocView) builds+dispatches
  // the transaction, then calls resolveComment(id, 'addressed'). Kept pure so
  // session has no view coupling — DocView owns EditorState.
  function acceptSuggestion(id: string): { from: number; to: number; replacement: string } | null {
    const c = comments.find((x) => x.id === id)
    if (!c || c.kind !== 'suggestion' || c.orphaned || !c.suggestion) return null
    if (c.from === undefined || c.to === undefined) return null
    return { from: c.from, to: c.to, replacement: c.suggestion.replacement }
  }

  const orphanedComments = $derived(comments.filter((c) => c.orphaned && !c.parentId))
  const dirty = $derived(version > committedVersion)

  return {
    filePath,
    get doc() { return doc },
    get comments() { return comments },
    get orphanedComments() { return orphanedComments },
    get dirty() { return dirty },
    get saving() { return saving },
    get error() { return importLoader.error || mutationError },
    get busy() { return importLoader.loading },
    get baseCommitId() { return baseCommitId },
    get baseContentHash() { return baseContentHash },
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

function stripLocal(c: PlacedComment): DocComment {
  const { from: _f, to: _t, orphaned: _o, ...rest } = c
  return rest
}
