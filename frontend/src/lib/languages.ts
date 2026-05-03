// Single language registry — sole place to add a language. highlighter.ts
// (diff view) reads PARSERS; cm-shared.ts (FileEditor/MergePanel) reads
// LANGUAGES + streamLanguageFor. EXTENSION_LANGUAGES is derived, so a new
// entry here flows through to detectLanguage, markdown fence highlighting,
// and the CM6 editor with no further edits.
//
// Main-bundle safe: only @lezer/* runtime imports. @codemirror/language is
// type-only here and dynamic-imported in ensureLegacyParsers; @codemirror/lang-*
// stays in cm-shared.ts (lazy chunk via FileEditor/MergePanel).

import type { Parser } from '@lezer/common'
import type { StreamParser, Language } from '@codemirror/language'
import { parser as jsParser } from '@lezer/javascript'
import { parser as goParser } from '@lezer/go'
import { parser as pyParser } from '@lezer/python'
import { parser as rustParser } from '@lezer/rust'
import { parser as cssParser } from '@lezer/css'
import { parser as htmlParser } from '@lezer/html'
import { parser as jsonParser } from '@lezer/json'
import { parser as yamlParser } from '@lezer/yaml'

export type LangSpec = {
  /** File extensions AND markdown fence-lang aliases that map to this language. */
  exts: string[]
  /** Eager LRParser from @lezer/* — present for first-party grammars. */
  parser?: Parser
  /** Lazy StreamParser thunk from @codemirror/legacy-modes — for langs without a Lezer grammar. */
  legacy?: () => Promise<StreamParser<unknown>>
}

export const LANGUAGES: Record<string, LangSpec> = {
  typescript: { exts: ['ts', 'tsx'], parser: jsParser.configure({ dialect: 'ts' }) },
  javascript: { exts: ['js', 'jsx'], parser: jsParser },
  go:         { exts: ['go', 'mod', 'sum'], parser: goParser },
  python:     { exts: ['py'], parser: pyParser },
  rust:       { exts: ['rs'], parser: rustParser },
  css:        { exts: ['css'], parser: cssParser },
  html:       { exts: ['html'], parser: htmlParser },
  // No @lezer/svelte. HTML parser handles tags/attrs/strings; {interpolations}
  // and <script> bodies stay plain. Good enough for a diff view.
  svelte:     { exts: ['svelte'], parser: htmlParser },
  json:       { exts: ['json'], parser: jsonParser },
  yaml:       { exts: ['yaml', 'yml'], parser: yamlParser },
  bash:       { exts: ['sh', 'bash', 'shell'], legacy: () => import('@codemirror/legacy-modes/mode/shell').then(m => m.shell) },
  toml:       { exts: ['toml'], legacy: () => import('@codemirror/legacy-modes/mode/toml').then(m => m.toml) },
  zig:        { exts: ['zig', 'zon'], legacy: () => import('./lang-zig').then(m => m.zigMode) },
  protobuf:   { exts: ['proto'], legacy: () => import('@codemirror/legacy-modes/mode/protobuf').then(m => m.protobuf) },
  swift:      { exts: ['swift'], legacy: () => import('@codemirror/legacy-modes/mode/swift').then(m => m.swift) },
}

// Derived ext → lang name. Also consumed by markdown-render to map fence-lang
// strings (```js, ```py); identity entries (javascript→javascript) handled
// by callers via `?? lang` fallthrough.
export const EXTENSION_LANGUAGES: Record<string, string> = Object.fromEntries(
  Object.entries(LANGUAGES).flatMap(([name, spec]) => spec.exts.map(ext => [ext, name])),
)

export function detectLanguage(filePath: string): string {
  const ext = filePath.split('.').pop()?.toLowerCase() ?? ''
  return EXTENSION_LANGUAGES[ext] ?? 'text'
}

// lang → Parser. Eager entries seeded here; legacy entries populated by
// ensureLegacyParsers(). Mutable by design — highlighter.ts reads this
// synchronously and falls back to escaped plain text when absent.
export const PARSERS: Record<string, Parser> = Object.fromEntries(
  Object.entries(LANGUAGES).flatMap(([name, spec]) => spec.parser ? [[name, spec.parser]] : []),
)

export const needsLegacyParser = (lang: string): boolean =>
  !!LANGUAGES[lang]?.legacy && !(lang in PARSERS)

// Resolved StreamLanguage instances — cm-shared wraps these in LanguageSupport
// for editor highlighting. Populated alongside PARSERS in ensureLegacyParsers.
const streamLanguages: Record<string, Language> = {}
export const streamLanguageFor = (lang: string): Language | undefined => streamLanguages[lang]

let legacyPromise: Promise<void> | undefined
export function ensureLegacyParsers(): Promise<void> {
  return legacyPromise ??= (async () => {
    const legacy = Object.entries(LANGUAGES).filter(([, s]) => s.legacy)
    const [{ StreamLanguage }, modes] = await Promise.all([
      import('@codemirror/language'),
      Promise.all(legacy.map(([, s]) => s.legacy!())),
    ])
    legacy.forEach(([name], i) => {
      const sl = StreamLanguage.define(modes[i])
      PARSERS[name] = sl.parser
      streamLanguages[name] = sl
    })
  })().catch(e => { legacyPromise = undefined; throw e })
}
