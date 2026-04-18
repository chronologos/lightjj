// Zig tokenizer via @codemirror/legacy-modes simple-mode. No first-party
// Lezer grammar exists; community codemirror-lang-zig is 122K / stale /
// single-maintainer. A regex-rule tokenizer is ~50 lines and reuses the
// StreamLanguage path bash/toml already take — same tok-* class output via
// classHighlighter, no new theming.
//
// Lazy-imported from highlighter.ts so @codemirror/language stays out of the
// main bundle. simpleMode rules are first-match-wins; order matters.

import type { StreamParser } from '@codemirror/language'
import { simpleMode } from '@codemirror/legacy-modes/mode/simple-mode'

const KEYWORDS = [
  'fn', 'return', 'const', 'var', 'pub', 'if', 'else', 'while', 'for',
  'switch', 'break', 'continue', 'defer', 'errdefer', 'try', 'catch',
  'orelse', 'unreachable', 'comptime', 'test', 'struct', 'union', 'enum',
  'error', 'packed', 'extern', 'inline', 'noinline', 'export', 'asm',
  'volatile', 'align', 'allowzero', 'usingnamespace', 'threadlocal',
  'linksection', 'addrspace', 'opaque', 'noalias', 'and', 'or',
  'suspend', 'resume', 'nosuspend', 'await', 'async', 'callconv',
].join('|')

const ATOMS = ['true', 'false', 'null', 'undefined'].join('|')

// Common primitive types. Arbitrary-width ints (u7, i1024) covered by a
// separate rule below — listing every 0..65535 width in a regex is silly.
const TYPES = [
  'bool', 'void', 'noreturn', 'type', 'anyerror', 'anyopaque',
  'anytype', 'anyframe',
  'i8', 'i16', 'i32', 'i64', 'i128', 'isize',
  'u8', 'u16', 'u32', 'u64', 'u128', 'usize',
  'f16', 'f32', 'f64', 'f80', 'f128',
  'c_char', 'c_short', 'c_ushort', 'c_int', 'c_uint',
  'c_long', 'c_ulong', 'c_longlong', 'c_ulonglong', 'c_longdouble',
  'comptime_int', 'comptime_float',
].join('|')

export const zigMode: StreamParser<unknown> = simpleMode({
  start: [
    // Line comments including /// doc and //! top-level doc. No block
    // comments in Zig.
    { regex: /\/\/.*/, token: 'comment' },
    // Multiline string lines — each starts with `\\` and runs to EOL.
    { regex: /\\\\.*/, token: 'string' },
    // Regular double-quoted strings (single-line in Zig).
    { regex: /"(?:\\.|[^"\\])*"/, token: 'string' },
    // Char literals with common escapes. Kept permissive — lexer not
    // validator.
    { regex: /'(?:\\(?:x[0-9a-fA-F]{2}|u\{[0-9a-fA-F]+\}|.)|[^'\\])'/, token: 'string' },
    // @"escaped identifier" — a distinct Zig syntax for reserved-word
    // identifiers. Matches before @builtin so the leading @" wins.
    { regex: /@"(?:\\.|[^"\\])*"/, token: 'variableName' },
    // @builtinFn — all compiler builtins start with @.
    { regex: /@[a-zA-Z_][a-zA-Z0-9_]*/, token: 'builtin' },
    // Numbers: hex (with optional fraction + binary exponent), octal,
    // binary, decimal (with optional fraction + decimal exponent).
    // Underscore digit separators allowed.
    { regex: /0x[0-9a-fA-F][0-9a-fA-F_]*(?:\.[0-9a-fA-F_]+)?(?:[pP][+-]?\d+)?/, token: 'number' },
    { regex: /0o[0-7][0-7_]*/, token: 'number' },
    { regex: /0b[01][01_]*/, token: 'number' },
    { regex: /\d[\d_]*(?:\.[\d_]+)?(?:[eE][+-]?\d+)?/, token: 'number' },
    // Primitive types.
    { regex: new RegExp(`\\b(?:${TYPES})\\b`), token: 'type' },
    // Arbitrary-width integer types (u7, i1024, ...). After the curated
    // list so common ones still hit the same token.
    { regex: /\b[iu][0-9]+\b/, token: 'type' },
    // Atoms.
    { regex: new RegExp(`\\b(?:${ATOMS})\\b`), token: 'atom' },
    // Keywords.
    { regex: new RegExp(`\\b(?:${KEYWORDS})\\b`), token: 'keyword' },
    // Identifiers — explicit rule so simple-mode doesn't char-step through
    // them one token at a time.
    { regex: /[a-zA-Z_][a-zA-Z0-9_]*/, token: null },
  ],
  languageData: {
    commentTokens: { line: '//' },
  },
})
