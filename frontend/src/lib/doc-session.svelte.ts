// Doc-mode session: in-memory ProseMirror state for a single .md file plus
// range-anchored comments. Two-tier model (in-memory ↔ file) — no IndexedDB,
// no merge engine. Comments persist server-side with content-addressed anchors;
// {from, to} PM positions are session-local cache recomputed on every import.
//
// State ownership: this factory owns comments + metadata. DocView owns the
// EditorView and dispatches transactions, calling onTransaction here so comment
// positions track edits.

import { EditorState, type Transaction } from 'prosemirror-state'
import type { Node } from 'prosemirror-model'
import { docSchema, parseMarkdown, serializeMarkdown } from './pm-schema'
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
  let state = $state<EditorState | null>(null)
  let comments = $state<PlacedComment[]>([])
  let baseCommitId = $state('')
  let baseContentHash = $state('')
  let version = $state(0)
  let committedVersion = $state(0)

  // Guards add/resolve/remove against a concurrent import_ overwriting comments[].
  // Symmetric: bump BEFORE await, check AFTER (CLAUDE.md gen-counter rule).
  let gen = 0
  const bumpGen = () => ++gen

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
    const { commitId, content, doc, placed } = importLoader.value
    state = EditorState.create({ schema: docSchema, doc })
    comments = placed
    baseCommitId = commitId
    baseContentHash = await sha256Hex(content)
    version = 0
    committedVersion = 0
  }

  function onTransaction(tr: Transaction): void {
    if (!state) return
    state = state.apply(tr)
    if (tr.docChanged) {
      version++
      comments = comments.map((c) =>
        c.orphaned || c.from === undefined || c.to === undefined
          ? c
          : { ...c, from: tr.mapping.map(c.from), to: tr.mapping.map(c.to, -1) },
      )
    }
  }

  // Phase 1 is read-only — nothing calls this yet. Signature is final; the
  // serialize+fileWrite happens in App's withMutation wrapper (Phase 2).
  async function commitBack(): Promise<'ok' | 'stale'> {
    if (!state) return 'ok'
    const commitId = getWorkingCopyCommitId()
    if (!commitId) throw new Error('working copy unavailable')
    const { content } = await api.fileShow(commitId, filePath)
    const currentHash = await sha256Hex(content)
    if (currentHash !== baseContentHash) return 'stale'
    // TODO Phase 2: api.fileWrite(filePath, serializeMarkdown(state.doc));
    //   committedVersion = version; baseContentHash = sha256Hex(serialized)
    void serializeMarkdown // referenced for Phase 2; keeps the import live
    return 'ok'
  }

  async function addComment(
    from: number,
    to: number,
    body: string,
    parentId?: string,
  ): Promise<void> {
    if (!state) return
    const tm = buildTextMap(state.doc)
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
    // Optimistic-write: bump gen so an in-flight import_() is invalidated, then
    // apply the local update unconditionally. A post-await gen check here would
    // make sibling mutations (add then resolve in quick succession) drop each
    // other's local update — independent writes don't conflict.
    bumpGen()
    comments = [...comments, { ...c, from, to, orphaned: false }]
    await api.docComments.upsert(c)
  }

  async function resolveComment(id: string, resolution: 'addressed' | 'wontfix'): Promise<void> {
    const c = comments.find((x) => x.id === id)
    if (!c) return
    const updated: DocComment = { ...stripLocal(c), resolution, resolvedAt: Date.now() }
    bumpGen()
    comments = comments.map((x) => (x.id === id ? { ...x, resolution, resolvedAt: updated.resolvedAt } : x))
    await api.docComments.upsert(updated)
  }

  async function removeComment(id: string): Promise<void> {
    bumpGen()
    comments = comments.filter((x) => x.id !== id && x.parentId !== id)
    await api.docComments.remove(filePath, id)
  }

  const orphanedComments = $derived(comments.filter((c) => c.orphaned && !c.parentId))
  const dirty = $derived(version > committedVersion)

  return {
    filePath,
    get state() { return state },
    get comments() { return comments },
    get orphanedComments() { return orphanedComments },
    get dirty() { return dirty },
    get error() { return importLoader.error },
    get busy() { return importLoader.loading },
    get baseCommitId() { return baseCommitId },
    import_,
    onTransaction,
    commitBack,
    addComment,
    resolveComment,
    removeComment,
  }
}

function stripLocal(c: PlacedComment): DocComment {
  const { from: _f, to: _t, orphaned: _o, ...rest } = c
  return rest
}
