import { SvelteSet } from 'svelte/reactivity'

export type SourceMode = '-r' | '-s' | '-b'
export type TargetMode = '-d' | '--insert-after' | '--insert-before'

export const targetModeLabel: Record<TargetMode, string> = {
  '-d': 'onto',
  '--insert-after': 'after',
  '--insert-before': 'before',
}

/** Discriminant for kind-keyed dispatch tables (execute lookups, badge/verb
 *  labels, StatusBar key tables). Prefer the shared ModeBase fields over
 *  branching on kind — branch only where behavior is genuinely per-mode. */
export type ModeKind = 'rebase' | 'squash' | 'split'

export interface ModeBase {
  readonly kind: ModeKind
  readonly active: boolean
  /** Does j/k navigation in this mode reload the diff panel?
   *  `true` = diff follows cursor (rebase: destination preview).
   *  `false` = diff frozen on source (squash/split: that's what you're editing).
   *
   *  This is the per-mode question `inlineMode` CAN'T answer — `inlineMode`
   *  is correct for binary gates (disable toolbar, hide palette entries),
   *  wrong for "which selectRevision variant?". App derives `diffFrozen` from
   *  this so both keyboard (handleInlineNav) and mouse (onselect) read the
   *  same source instead of each spelling out `squash.active || split.active`. */
  readonly diffFollows: boolean
  /** Revisions the operation acts on — the "<< source >>" badge rows in
   *  RevisionGraph. Split always has exactly one (its `revision`). Empty
   *  when the mode is inactive. */
  readonly sources: readonly string[]
  /** Whether the j/k cursor picks a destination revision. Rebase/squash
   *  preview + execute against the cursor (target badge, `/` typed-destination
   *  input); split operates in place — no destination cursor, no target badge,
   *  no j/k. */
  readonly hasDestination: boolean
  cancel(): void
  handleKey(key: string): boolean
}

export interface RebaseMode extends ModeBase {
  readonly kind: 'rebase'
  readonly sources: string[]
  readonly sourceMode: SourceMode
  readonly targetMode: TargetMode
  readonly skipEmptied: boolean
  readonly ignoreImmutable: boolean
  readonly simplifyParents: boolean
  enter(revisions: string[]): void
}

/** Which description the squashed commit keeps (issue #22). 'destination' is
 *  the default (jj's --use-destination-message). 'source' / 'combine' send a
 *  description_mode the backend composes into -m. */
export type SquashDescMode = 'destination' | 'source' | 'combine'

export interface SquashMode extends ModeBase {
  readonly kind: 'squash'
  readonly sources: string[]
  readonly keepEmptied: boolean
  readonly ignoreImmutable: boolean
  readonly descMode: SquashDescMode
  enter(revisions: string[]): void
}

export interface SplitMode extends ModeBase {
  readonly kind: 'split'
  /** Alias of sources[0] — split semantically has exactly one source and
   *  call sites read better as `split.revision`. */
  readonly revision: string
  readonly parallel: boolean
  /** When true, UI shows "accept/reject" labels instead of "split/stay".
   *  Same underlying jj split — checked files stay (accepted), rest move to child (rejected). */
  readonly review: boolean
  enter(changeId: string, asReview?: boolean): void
}

export function createRebaseMode(): RebaseMode {
  let active = $state(false)
  let sources: string[] = $state([])
  let sourceMode: SourceMode = $state('-r')
  let targetMode: TargetMode = $state('-d')
  let skipEmptied = $state(false)
  let ignoreImmutable = $state(false)
  let simplifyParents = $state(false)

  return {
    kind: 'rebase' as const,
    get active() { return active },
    diffFollows: true,  // destination preview — diff shows what you'd land on
    hasDestination: true,
    get sources() { return sources },
    get sourceMode() { return sourceMode },
    get targetMode() { return targetMode },
    get skipEmptied() { return skipEmptied },
    get ignoreImmutable() { return ignoreImmutable },
    get simplifyParents() { return simplifyParents },

    enter(revisions: string[]) {
      sources = revisions
      sourceMode = '-r'
      targetMode = '-d'
      skipEmptied = false
      ignoreImmutable = false
      simplifyParents = false
      active = true
    },

    cancel() {
      active = false
      sources = []
    },

    handleKey(key: string): boolean {
      switch (key) {
        case 'r': sourceMode = '-r'; return true
        case 's': sourceMode = '-s'; return true
        case 'b': sourceMode = '-b'; return true
        case 'a': targetMode = '--insert-after'; return true
        case 'i': targetMode = '--insert-before'; return true
        case 'o': case 'd': targetMode = '-d'; return true
        case 'e': skipEmptied = !skipEmptied; return true
        case 'x': ignoreImmutable = !ignoreImmutable; return true
        case 'p': simplifyParents = !simplifyParents; return true
        default: return false
      }
    },
  }
}

export function createSquashMode(): SquashMode {
  let active = $state(false)
  let sources: string[] = $state([])
  let keepEmptied = $state(false)
  let ignoreImmutable = $state(false)
  let descMode: SquashDescMode = $state('destination')

  // m cycles destination → source → combine → destination.
  const NEXT_DESC: Record<SquashDescMode, SquashDescMode> = {
    destination: 'source',
    source: 'combine',
    combine: 'destination',
  }

  return {
    kind: 'squash' as const,
    get active() { return active },
    diffFollows: false,  // frozen on source — that's what you're squashing
    hasDestination: true,
    get sources() { return sources },
    get keepEmptied() { return keepEmptied },
    get ignoreImmutable() { return ignoreImmutable },
    get descMode() { return descMode },

    enter(revisions: string[]) {
      sources = revisions
      keepEmptied = false
      ignoreImmutable = false
      descMode = 'destination'
      active = true
    },

    cancel() {
      active = false
      sources = []
    },

    handleKey(key: string): boolean {
      switch (key) {
        case 'e': keepEmptied = !keepEmptied; return true
        case 'x': ignoreImmutable = !ignoreImmutable; return true
        case 'm': descMode = NEXT_DESC[descMode]; return true
        default: return false
      }
    },
  }
}

// Not ModeBase — divergence lives in anyModalOpen (DivergencePanel replaces
// DiffPanel), not inlineMode. Never reaches handleInlineNav's mode.handleKey().
export interface DivergenceMode {
  readonly active: boolean
  readonly changeId: string
  enter(id: string): void
  cancel(): void
}

export function createDivergenceMode(): DivergenceMode {
  let active = $state(false)
  let changeId = $state('')

  return {
    get active() { return active },
    get changeId() { return changeId },

    enter(id: string) {
      changeId = id
      active = true
    },

    cancel() {
      active = false
      changeId = ''
    },
  }
}

/** File-selection scratchpad shared by squash + split(file-level). Previously
 *  two loose declarations in App.svelte whose correctness depended on every
 *  caller remembering to zero both — a new entry point that seeds `set` but
 *  not `total` leaks the prior mode's count into the next one's guard checks.
 *  init()/clear() are atomic pairs. */
export interface FileSelection {
  /** Exposed raw — DiffPanel expects SvelteSet<string> for FileSelectionPanel.has() */
  readonly set: SvelteSet<string>
  /** File-count snapshot at init() time — compared against set.size to decide
   *  "partial selection → pass file list" vs "all selected → pass nothing". */
  readonly total: number
  init(files: readonly { path: string }[]): void
  toggle(path: string): void
  clear(): void
}

export function createFileSelection(): FileSelection {
  const set = new SvelteSet<string>()
  let total = $state(0)

  return {
    set,
    get total() { return total },

    init(files) {
      set.clear()
      for (const f of files) set.add(f.path)
      total = files.length
    },

    toggle(path) {
      set.has(path) ? set.delete(path) : set.add(path)
    },

    clear() {
      set.clear()
      total = 0
    },
  }
}

export function createSplitMode(): SplitMode {
  let active = $state(false)
  let revision = $state('')
  let parallel = $state(false)
  let review = $state(false)

  return {
    kind: 'split' as const,
    get active() { return active },
    diffFollows: false,  // frozen on source — that's what you're splitting
    hasDestination: false,  // in-place operation — no destination cursor
    get sources() { return revision ? [revision] : [] },
    get revision() { return revision },
    get parallel() { return parallel },
    get review() { return review },

    enter(changeId: string, asReview = false) {
      revision = changeId
      parallel = false
      review = asReview
      active = true
    },

    cancel() {
      active = false
      revision = ''
      parallel = false
      review = false
    },

    handleKey(key: string): boolean {
      if (key === 'p') { parallel = !parallel; return true }
      return false
    },
  }
}
