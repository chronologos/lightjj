import { describe, it, expect } from 'vitest'
// @ts-ignore — @types/node not installed; vitest runs in Node so these resolve at runtime
import { statSync, readFileSync, readdirSync, existsSync } from 'node:fs'

// Bundle-size regression guard. Skipped if frontend-dist doesn't exist
// (dev mode / fresh clone); CI runs `pnpm build` before `pnpm vitest run`.
const DIST = '../cmd/lightjj/frontend-dist/assets'
const mainChunks: string[] = existsSync(DIST)
  ? readdirSync(DIST)
      .filter((f: string) => /^index-.*\.js$/.test(f))
      .map((f: string) => `${DIST}/${f}`)
  : []
const runIf = mainChunks.length > 0 ? describe : describe.skip

runIf('bundle size', () => {
  it('main chunk under 750K (regresses to ~985K if CM leaks back)', () => {
    const size = statSync(mainChunks[0]).size
    expect(size).toBeLessThan(750_000)
  })

  it('main chunk has no CodeMirror editor code', () => {
    const src = readFileSync(mainChunks[0], 'utf-8')
    // EditorView is a class name that survives minification as property access
    expect(src).not.toMatch(/\bEditorView\b/)
  })
})
