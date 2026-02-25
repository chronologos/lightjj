export type SourceMode = '-r' | '-s' | '-b'
export type TargetMode = '-d' | '--insert-after' | '--insert-before'

export const targetModeLabel: Record<TargetMode, string> = {
  '-d': 'onto',
  '--insert-after': 'after',
  '--insert-before': 'before',
}

export function createRebaseMode() {
  let active = $state(false)
  let sources: string[] = $state([])
  let sourceMode: SourceMode = $state('-r')
  let targetMode: TargetMode = $state('-d')

  return {
    get active() { return active },
    get sources() { return sources },
    get sourceMode() { return sourceMode },
    get targetMode() { return targetMode },

    enter(revisions: string[]) {
      sources = revisions
      sourceMode = '-r'
      targetMode = '-d'
      active = true
    },

    cancel() { active = false },

    handleKey(key: string): boolean {
      switch (key) {
        case 'r': sourceMode = '-r'; return true
        case 's': sourceMode = '-s'; return true
        case 'b': sourceMode = '-b'; return true
        case 'a': targetMode = '--insert-after'; return true
        case 'i': targetMode = '--insert-before'; return true
        case 'o': case 'd': targetMode = '-d'; return true
        default: return false
      }
    },
  }
}

export function createSquashMode() {
  let active = $state(false)
  let sources: string[] = $state([])
  let keepEmptied = $state(false)
  let useDestMsg = $state(false)

  return {
    get active() { return active },
    get sources() { return sources },
    get keepEmptied() { return keepEmptied },
    get useDestMsg() { return useDestMsg },

    enter(revisions: string[]) {
      sources = revisions
      keepEmptied = false
      useDestMsg = false
      active = true
    },

    cancel() { active = false },

    handleKey(key: string): boolean {
      switch (key) {
        case 'e': keepEmptied = !keepEmptied; return true
        case 'd': useDestMsg = !useDestMsg; return true
        default: return false
      }
    },
  }
}

export function createSplitMode() {
  let active = $state(false)
  let revision = $state('')
  let parallel = $state(false)

  return {
    get active() { return active },
    get revision() { return revision },
    get parallel() { return parallel },

    enter(changeId: string) {
      revision = changeId
      parallel = false
      active = true
    },

    cancel() {
      active = false
      revision = ''
      parallel = false
    },

    handleKey(key: string): boolean {
      if (key === 'p') { parallel = !parallel; return true }
      return false
    },
  }
}
